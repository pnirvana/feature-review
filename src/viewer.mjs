// The viewer: a full-screen terminal view of a feature's change (src/rows.mjs), with
// reviewed marks per hunk and per file, comments anchored to lines, folding, search, and
// opening a line in $EDITOR. Keys follow ATF's review viewer where they overlap.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadWorkspace } from './workspace.mjs';
import { readState, update, setMarks, addComment, editComment, deleteComment } from './state.mjs';
import { buildRows, highlightFiles, fid, unitsOf, readingOrder, groupFoldId, UNGROUPED, LAYERS } from './rows.mjs';

const LAYER_NAMES = { agent: 'agent', fr: 'fr', coverage: 'coverage', comments: 'comments' };
import { annotationsPath, readAnnotations, checkAnnotations } from './annotations.mjs';
import { queryColors, applyTheme } from './ui/theme.mjs';
import { overviewRows, tabBar, TABS } from './overview.mjs';
import { ESC, fit, plain, charWidth, strWidth, segsWidth, hasBg } from './md/term.mjs';
import { feedbackPath, recordFeedback, aboutRow } from './feedback.mjs';
import { textField, keyField, fieldText, fieldRows, fieldMode } from './ui/textfield.mjs';


const HELP = [
  'fr: feature review',
  '',
  'j k ↑↓          move                    ctrl-d/u half a page   ctrl-f/b a page   gg G top / end',
  'tab             lens: the agent\'s groups (reading order, riskiest first) or the services',
  'm               the overview: design, names, contracts, rollout (h l or 1-4: tab, ⏎: to the code, m: back)',
  ']] [[           next / previous file    ]g [g  group (services lens: service)',
  ']h [h           next / previous hunk    ]u [u  next / previous hunk not reviewed yet',
  ']c [c           next / previous comment',
  'gt              from code to its test in the change, or back (⏎ on a TESTS line: that file)',
  '⏎               on a finding about an unchanged caller: show its code, or hide it',
  'v               reviewed: the hunk under the cursor (on a file, part or group line: all of it), then on',
  'V               reviewed: the whole file under the cursor (again: not reviewed)',
  'space           fold the hunk (on a file or group line: that)   z  the file or group   Z  all of them',
  'c               comment on the line under the cursor (on a file or hunk line: the file)',
  'e x             on a comment: edit it / delete it (x twice)',
  'o               open the line in $EDITOR',
  '!               feedback on what is under the cursor: h helped  m missing here  w wrong, then a note (fr feedback reads it back)',
  's               side by side ↔ inline',
  'f               show or hide kinds of markers, notes and marks: 1 agent  2 fr  3 coverage  4 comments  0 all',
  'a               hide the annotations in and around the code (findings, fr\'s notes, test intents; their',
  '                gutter marks stay); the intent and the groups\' reasons stay. Again: show them',
  'r               reload (the worktrees and the review state; annotations reload by themselves)',
  '/  n N  esc     search as you type (⏎ keeps the match, esc goes back), next / previous match, end it',
  'q               quit',
  '',
  'Reviewed hunks and files fold away; a mark resets when the hunk changes.',
  'Marks and comments are kept in <dir>/.feature-review/state.json; the agent\'s annotations',
  'in annotations.json there (fr check validates them).',
  'Settings (vi mode in the comment field, layout, theme, editor): fr config.',
];

/**
 * Open the viewer. input and output are the terminal (tests pass a fake one); exit ends
 * the process on q. → {close, ui} once the change is loaded and highlighted.
 */
export async function runViewer({ feedbackFile = feedbackPath(), dir, layout = 'auto', highlight = 'auto', lens = null, input = process.stdin, output = process.stdout, exit = (code) => process.exit(code), queryTheme = true, viMode = false, editor = '' }) {
  const out = output;
  const ui = {
    ws: null,
    st: null,
    hl: new Map(),
    rows: [],
    cur: 0,
    top: 0,
    fold: new Map(),
    layout,
    lens, // null: groups when there are annotations
    ann: null, // checkAnnotations() plus {ann}
    annError: null,
    search: null,
    input: null,
    flash: null,
    pending: '',
    confirm: null,
    help: false,
    error: null,
    loading: false,
    highlighting: false,
    ov: null, // the overview when open: {tab, rows, cur, top, expanded}
    quiet: false, // annotations hidden (a): the code alone
    show: { agent: true, fr: true, coverage: true, comments: true }, // the kinds of markers shown (f)
    layers: null, // the f menu, when open: {cur, top} kept
    fb: null, // the feedback key, when asked: {target} (what the entry is about)
  };

  const W = () => out.columns || 100;
  const H = () => out.rows || 30;
  const flash = (msg, style = 'green') => {
    ui.flash = { msg, style, until: Date.now() + 4000 };
    draw();
  };

  // ---------- data ----------
  const rowKey = (r) => (r ? [r.kind, r.group ?? '', r.fid ?? r.repo ?? '', r.hunk ?? '', JSON.stringify(r.line ?? null), r.comment ?? '', r.callout ?? ''].join('|') : null);
  const lensNow = () => (ui.ann?.groups.length ? (ui.lens ?? 'groups') : 'services');
  /** The layout on screen: auto is split when the code is 110 columns wide (codeView), else unified. */
  const shownLayout = () => (ui.layout !== 'auto' ? ui.layout : opts().width - (lensNow() === 'groups' ? 2 : 0) >= 110 ? 'split' : 'unified');
  const opts = () => ({ width: Math.max(30, W() - 2), layout: ui.layout, fold: ui.fold, hl: ui.hl, lens: lensNow(), ann: ui.ann, quiet: ui.quiet, show: ui.show });
  function relayout(keep = rowKey(ui.rows[ui.cur])) {
    if (!ui.ws) return;
    ui.rows = buildRows(ui.ws, ui.st, opts());
    if (ui.search) ui.search.hits = searchHits(ui.search.q);
    restore(keep);
  }
  function restore(key) {
    if (key) {
      let i = ui.rows.findIndex((r) => rowKey(r) === key);
      if (i < 0) {
        // the row is gone (folded, reloaded): the nearest row of the same hunk or file
        const [, g, f, h] = key.split('|');
        const inGroup = (r) => !g || r.group === g;
        i = ui.rows.findIndex((r) => h && r.hunk === h && inGroup(r));
        if (i < 0) i = ui.rows.findIndex((r) => f && r.fid === f && inGroup(r));
        if (i < 0) i = ui.rows.findIndex((r) => g && r.group === g);
      }
      if (i >= 0) ui.cur = i;
    }
    ui.cur = Math.max(0, Math.min(ui.cur, ui.rows.length - 1));
  }
  async function loadAnnotations(ws) {
    const { ann, error } = readAnnotations(ws.root);
    ui.annError = error ?? null;
    try {
      ui.ann = ann ? { ann, ...(await checkAnnotations(ann, ws)) } : null;
    } catch (e) {
      ui.ann = null;
      ui.annError = e.message;
    }
  }
  let watching = null;
  function watchAnnotations(root) {
    if (watching === root) return;
    if (watching) fs.unwatchFile(annotationsPath(watching));
    watching = root;
    // the agent rewrites the file while the viewer is open: show the new one
    fs.watchFile(annotationsPath(root), { interval: 1000 }, async (now, before) => {
      // also called when nothing changed for a file that is not there (e.g. its directory appeared)
      if (!ui.ws || now.mtimeMs === before.mtimeMs) return;
      await loadAnnotations(ui.ws);
      relayout();
      if (ui.ov) ui.ann ? ovLayout() : (ui.ov = null);
      flash(ui.annError ? `annotations: ${ui.annError}` : ui.ann ? 'annotations reloaded' : 'annotations removed', ui.annError ? 'red' : 'green');
    });
  }
  async function reload(note = null) {
    if (ui.loading) return;
    ui.loading = true;
    draw();
    let ws = null;
    try {
      ws = await loadWorkspace(dir);
      ui.st = readState(ws.root);
      await loadAnnotations(ws);
      watchAnnotations(ws.root);
      ui.hl = new Map(); // plain until highlighted: old highlighting may not match the new text
      ui.ws = ws;
      ui.error = null;
    } catch (e) {
      ui.error = e.message;
    }
    ui.loading = false;
    relayout();
    if (note) flash(note);
    else draw();
    if (!ws) return;
    ui.highlighting = true;
    const hl = await highlightFiles(ws, highlight).catch(() => null);
    ui.highlighting = false;
    if (hl && ui.ws === ws) {
      ui.hl = hl;
      relayout();
    }
    draw();
  }
  const save = (fn) => {
    try {
      ui.st = update(ui.ws.root, fn);
      return true;
    } catch (e) {
      flash(`not saved: ${e.message}`, 'red');
      return false;
    }
  };

  // ---------- lookups ----------
  const fileById = (id) => {
    for (const r of ui.ws?.repos ?? []) for (const f of r.files) if (fid(f) === id) return { repo: r, f };
    return null;
  };
  /** The reviewable units in reading order (the lens's): [{unit, fid, hunk (key or null), group}]. */
  const order = () => readingOrder(ui.ws, ui.ann, lensNow());
  const HEADS = ['file', 'part', 'group'];
  /** The units under the cursor: the hunk, or all of a file, part or group on its line. */
  function unitsAt(r = ui.rows[ui.cur]) {
    if (!r) return [];
    if (r.hunk && !HEADS.includes(r.kind)) return [r.hunk];
    if (r.units) return r.units;
    const x = r.fid && fileById(r.fid);
    return x ? unitsOf(x.f) : [];
  }
  const marked = (k) => Boolean(ui.st.marks[k]);

  // ---------- drawing ----------
  function header() {
    if (!ui.ws) return [[' fr ', 'bold inverse'], [ui.loading ? ' reading…' : '', 'dim']];
    if (ui.ov) return [[' fr ', 'bold inverse'], [` ${ui.ws.name}   `, 'bold'], ...tabBar(ui.ann, ui.ov.tab)];
    const all = order();
    const done = all.filter((u) => marked(u.unit)).length;
    return [
      [' fr ', 'bold inverse'],
      [` ${ui.ws.name} `, 'bold'],
      [` reviewed ${done}/${all.length}`, all.length && done === all.length ? 'green bold' : ''],
      ...(ui.st.comments.length ? [[`  ${ui.st.comments.length} comment${ui.st.comments.length === 1 ? '' : 's'}`, 'magenta']] : []),
      ...(ui.quiet ? [['  annotations hidden', 'yellow']] : []),
      ...(LAYERS.some((k) => !ui.show[k]) ? [[`  only ${LAYERS.filter((k) => ui.show[k]).map((k) => LAYER_NAMES[k]).join(', ') || 'the code'}`, 'yellow']] : []),
      [`  ${lensNow()} · ${shownLayout() === 'split' ? 'side by side' : 'inline'}${ui.layout === 'auto' ? ' (auto)' : ''}`, 'dim'],
      ...(ui.annError ? [['  annotations unreadable', 'red']] : ui.ann?.errors.length ? [[`  annotations: ${ui.ann.errors.length} error${ui.ann.errors.length === 1 ? '' : 's'}`, 'red']] : []),
      ...(ui.loading ? [['  reading…', 'dim']] : ui.highlighting ? [['  highlighting…', 'dim']] : []),
    ];
  }
  function where(r) {
    if (!r?.fid) return r?.repo ?? '';
    const x = fileById(r.fid);
    if (!x) return '';
    const l = r.line && typeof r.line === 'object' ? `:${r.line.side === 'old' ? '-' : '+'}${r.line.n}` : '';
    return `${x.repo.name}/${x.f.file}${l}`;
  }
  const KEYS = 'tab lens  m overview  a annotations  f markers  j/k move  ]] file  ]u not reviewed  v reviewed  space fold  c comment  ! feedback  o editor  s layout  / search  ? help  q quit';
  const OV_KEYS = 'h/l or 1-4 tab  j/k move  ⏎ to the code  m/esc back to the review  q quit';
  function footer() {
    const w = W();
    if (ui.input) {
      const f = ui.input.field;
      const mode = fieldMode(f);
      const viMode = mode ? [[` -- ${mode} --`, 'bold cyan']] : [];
      if (!ui.input.multiline) return [[[' ' + ui.input.label, 'bold yellow'], ...fieldRows(f, Math.max(10, w - strWidth(ui.input.label) - 20), 1, charWidth).rows[0], ...viMode, ['   ⏎ ok · esc cancel', 'dim']]];
      const max = Math.max(1, Math.min(8, H() - 10));
      const { rows, above, below } = fieldRows(f, Math.max(10, w - 3), max, charWidth);
      return [
        [[' ' + ui.input.label, 'bold yellow'], ...viMode, [mode ? '   esc normal mode · ⏎ there sends' : '   ⏎ save · alt+⏎ new line · esc cancel', 'dim']],
        ...rows.map((segs, i) => [[(i === 0 && above) || (i === rows.length - 1 && below) ? ' ⋮ ' : ' │ ', 'gray'], ...segs]),
      ];
    }
    if (ui.fb) {
      const t = ui.fb.target;
      return [
        [[' feedback on ', 'bold yellow'], [t.about, 'bold'], ['   h helped   m missing here   w wrong', ''], ['   esc cancel', 'dim']],
        [[' ', ''], [t.text ? `│ ${t.text.replace(/\s+/g, ' ').trim()}` : '', 'gray']],
      ];
    }
    if (ui.layers) {
      const item = (k, i) => [[`  ${i + 1} `, 'bold'], [LAYER_NAMES[k], ui.show[k] ? '' : 'dim'], [ui.show[k] ? ' ✓' : ' ·', ui.show[k] ? 'green' : 'dim']];
      return [[[' show:', 'bold yellow'], ...LAYERS.flatMap(item), ['     0 all · f / esc done', 'dim']], [[' ', ''], ['each number shows or hides that kind of marker: its notes and its marks', 'gray']]];
    }
    if (ui.ov) {
      const msg = ui.flash && ui.flash.until > Date.now() ? [[' ' + ui.flash.msg, ui.flash.style]] : [[' ' + OV_KEYS, 'dim']];
      const r = ui.ov.rows[ui.ov.cur];
      const hint = r?.kind === 'ref' && r.res?.ok ? (r.res.units.length ? '⏎ go to this code in the review' : '⏎ show / hide this code') : '';
      return [msg, [[' ', ''], [hint, 'gray']]];
    }
    // a message or the search replaces the key hints; where the cursor is stays shown
    const loc = where(ui.rows[ui.cur]);
    const locRow = loc ? [[[' ', ''], [loc, 'gray']]] : [];
    if (ui.flash && ui.flash.until > Date.now()) return [[[' ' + ui.flash.msg, ui.flash.style]], ...locRow];
    if (ui.search) {
      const n = ui.search.hits.length;
      const at = ui.search.hits.indexOf(ui.cur);
      return [[[` /${ui.search.q}`, 'bold'], [n ? `  ${at >= 0 ? at + 1 : '-'}/${n}` : '  no match', n ? '' : 'red'], ['   n / N next / previous   esc end search', 'dim']], ...locRow];
    }
    return [[[' ' + KEYS, 'dim']], ...locRow];
  }
  function draw() {
    const w = W();
    const h = H();
    const head = [header()];
    const foot = footer();
    const bodyH = Math.max(1, h - head.length - foot.length);
    let body;
    if (ui.help) body = HELP.map((l, i) => [[' ' + l, i === 0 ? 'bold' : '']]);
    else if (ui.error) body = [[[` ${ui.error}`, 'red']], [['  r: try again · q: quit', 'dim']]];
    else if (!ui.ws) body = [[[' reading the worktrees…', 'dim']]];
    else if (ui.ov) {
      const o = ui.ov;
      if (o.cur < o.top) o.top = o.cur;
      if (o.cur >= o.top + bodyH) o.top = o.cur - bodyH + 1;
      o.top = Math.max(0, Math.min(o.top, Math.max(0, o.rows.length - bodyH)));
      body = [[], ...o.rows.slice(o.top, o.top + bodyH - 1).map((r, i) => [...(o.top + i === o.cur ? [['▌', 'cyan bold']] : [[' ', '']]), [' ', ''], ...r.segs])];
    } else {
      if (ui.cur < ui.top) ui.top = ui.cur;
      if (ui.cur >= ui.top + bodyH) ui.top = ui.cur - bodyH + 1;
      ui.top = Math.max(0, Math.min(ui.top, Math.max(0, ui.rows.length - bodyH)));
      const hits = new Set(ui.search?.hits ?? []);
      body = ui.rows.slice(ui.top, ui.top + bodyH).map((r, i) => {
        const idx = ui.top + i;
        const g = idx === ui.cur ? [['▌', 'cyan bold']] : hits.has(idx) ? [['›', 'yellow']] : [[' ', '']];
        const segs = hits.has(idx) && ui.search ? markMatches(r.segs, ui.search.q, idx === ui.cur) : r.segs;
        return idx === ui.cur ? cursorLine([...g, [' ', ''], ...segs], w) : [...g, [' ', ''], ...segs];
      });
    }
    const lines = [...head, ...body.slice(0, bodyH)];
    while (lines.length < head.length + bodyH) lines.push([]);
    lines.push(...foot);
    out.write(`${ESC}H` + lines.map((l) => fit(l, w) + `${ESC}K`).join('\r\n') + `${ESC}J`);
  }

  /**
   * The cursor's line, highlighted across the width: a soft tint where it has no background
   * of its own; an added or removed line keeps its colour, a little stronger.
   */
  function cursorLine(segs, w) {
    const out = segs.map(([t, st, ...more]) => {
      const s = String(st ?? '');
      if (/\baddbg\b/.test(s)) return [t, s.replace(/\baddbg\b/, 'addbgcur'), ...more];
      if (/\bdelbg\b/.test(s)) return [t, s.replace(/\bdelbg\b/, 'delbgcur'), ...more];
      return hasBg(s) ? [t, s, ...more] : [t, `${s} cursorbg`.trim(), ...more];
    });
    const used = segsWidth(out);
    return used < w ? [...out, [' '.repeat(w - used), 'cursorbg']] : out;
  }

  // ---------- search ----------
  const caseless = (q) => q === q.toLowerCase();
  function searchHits(q) {
    if (!q) return [];
    const ci = caseless(q);
    return ui.rows.map((r, i) => [plain(r.segs), i]).filter(([t]) => (ci ? t.toLowerCase() : t).includes(q)).map(([, i]) => i);
  }
  function markMatches(segs, q, cur) {
    const hay = caseless(q) ? plain(segs).toLowerCase() : plain(segs);
    const marks = [];
    for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) marks.push([i, i + q.length]);
    if (!marks.length) return segs;
    const res = [];
    let pos = 0;
    for (const [t, s] of segs) {
      let k = 0;
      while (k < t.length) {
        const m = marks.find(([a, b]) => pos + k >= a && pos + k < b);
        const next = m ? Math.min(t.length, m[1] - pos) : Math.min(t.length, ...marks.filter(([a]) => a > pos + k).map(([a]) => a - pos));
        res.push([t.slice(k, next), m ? (cur ? 'matchcur' : 'match') : s]);
        k = next;
      }
      pos += t.length;
    }
    return res;
  }

  // ---------- moving ----------
  const nonEmpty = (r) => r && !r.spacer && r.segs.length && segsWidth(r.segs) > 0;
  function move(d) {
    let i = ui.cur;
    const step = Math.sign(d) || 1;
    for (let n = Math.abs(d); n > 0; n--) {
      let j = i + step;
      while (j >= 0 && j < ui.rows.length && !nonEmpty(ui.rows[j])) j += step;
      if (j < 0 || j >= ui.rows.length) break;
      i = j;
    }
    ui.cur = i;
  }
  function jump(pred, dir, none = dir > 0 ? 'no more below' : 'none above') {
    for (let i = ui.cur + dir; i >= 0 && i < ui.rows.length; i += dir) if (pred(ui.rows[i], i)) return void (ui.cur = i);
    flash(none, 'dim');
  }
  const isUnitStart = (r) => r.kind === 'hunk' || (r.kind === 'blank' && r.units?.length);

  /** The next (or previous) unit not reviewed, in reading order: unfold it and go there. */
  function nextUnreviewed(dir = 1, fromRow = ui.cur, keep = null) {
    const all = order();
    const groupOf = (r) => (r.group === UNGROUPED ? null : (r.group ?? null));
    const sameGroup = (u, r) => lensNow() !== 'groups' || u.group === groupOf(r);
    // where the cursor is in reading order: its hunk, else the first unit of its file, part
    // or group (just before it, going down), else the nearest such row above
    let at = -1;
    for (let i = fromRow; i >= 0 && at < 0; i--) {
      const r = ui.rows[i];
      if (r.hunk && !HEADS.includes(r.kind)) {
        at = all.findIndex((u) => u.unit === r.hunk && sameGroup(u, r));
        if (at < 0) at = all.findIndex((u) => u.unit === r.hunk);
      } else if (r.units?.length) {
        const first = all.findIndex((u) => r.units.includes(u.unit) && sameGroup(u, r));
        if (first >= 0) at = first - (dir > 0 ? 1 : 0);
      }
    }
    const seq = dir > 0 ? all.slice(at + 1) : all.slice(0, Math.max(0, at)).reverse();
    const u = seq.find((x) => !marked(x.unit));
    if (!u) return flash(all.every((x) => marked(x.unit)) ? 'everything is reviewed' : dir > 0 ? 'nothing below left to review' : 'nothing above left to review', all.every((x) => marked(x.unit)) ? 'green' : 'dim');
    ui.fold.set(u.fid, false);
    if (u.hunk) ui.fold.set(u.hunk, false);
    const groups = lensNow() === 'groups';
    if (groups) ui.fold.set(groupFoldId(u.group ?? UNGROUPED), false);
    relayout();
    const from = groups ? Math.max(0, ui.rows.findIndex((x) => x.kind === 'group' && x.group === (u.group ?? UNGROUPED))) : 0;
    let i = ui.rows.findIndex((x, k) => k >= from && (u.hunk ? x.kind === 'hunk' && x.hunk === u.hunk : x.units?.includes(u.unit) && ['file', 'blank'].includes(x.kind)));
    if (i < 0) i = ui.rows.findIndex((x) => (u.hunk ? x.kind === 'hunk' && x.hunk === u.hunk : x.fid === u.fid));
    if (i >= 0) ui.cur = i;
    if (i >= 0) bringIntoView(i, u.hunk, keep);
  }

  /**
   * Show row i (a hunk's title): if the hunk already shows whole, nothing moves; else the
   * screen scrolls so its heading (the part, file or group line just above) is at the top,
   * the same place every time.
   */
  function bringIntoView(i, hunk, keep = null) {
    const bodyH = Math.max(1, H() - 3);
    let end = i;
    while (hunk && end + 1 < ui.rows.length && ui.rows[end + 1].hunk === hunk) end++;
    if (i >= ui.top && end < ui.top + bodyH) return;
    // the row to keep in view (the hunk just reviewed), at the top, when the next hunk then fits
    if (keep !== null && keep < i && end - keep < bodyH) return void (ui.top = keep);
    let head = i;
    for (let j = i - 1; j >= Math.max(0, i - 6); j--)
      if (['part', 'file', 'group'].includes(ui.rows[j].kind)) {
        head = j;
        break;
      }
    ui.top = Math.max(0, head - 1);
  }

  // ---------- the overview ----------
  function ovLayout() {
    const o = ui.ov;
    o.rows = overviewRows(ui.ann, o.tab, { width: Math.max(30, W() - 3), expanded: o.expanded });
    o.cur = Math.max(0, Math.min(o.cur, o.rows.length - 1));
  }
  function openOverview() {
    if (!ui.ann) return flash(ui.annError ? `annotations: ${ui.annError}` : `no annotations: the agent writes them to ${annotationsPath(ui.ws.root)}`, 'yellow');
    // the first tab with something in it
    const tab = ui.lastTab ?? TABS.find((t) => t.count(ui.ann.ann))?.id ?? 'design';
    ui.ov = { tab, rows: [], cur: 0, top: 0, expanded: new Set() };
    ovLayout();
    ovMove(0);
  }
  function ovTab(id) {
    if (!TABS.some((t) => t.id === id)) return;
    ui.ov = { ...ui.ov, tab: id, cur: 0, top: 0 };
    ui.lastTab = id;
    ovLayout();
    ovMove(0);
  }
  /** Move in the overview, skipping spacing rows. */
  function ovMove(d) {
    const o = ui.ov;
    const ok = (r) => r && !r.spacer && r.segs.length;
    let i = o.cur;
    if (d === 0) {
      while (i < o.rows.length - 1 && !ok(o.rows[i])) i++;
      o.cur = i;
      return;
    }
    const step = Math.sign(d);
    for (let n = Math.abs(d); n > 0; n--) {
      let j = i + step;
      while (j >= 0 && j < o.rows.length && !ok(o.rows[j])) j += step;
      if (j < 0 || j >= o.rows.length) break;
      i = j;
    }
    o.cur = i;
  }
  /** ⏎ in the overview: a citation of the change goes to its code in the review; another shows its code here. */
  function ovEnter() {
    const r = ui.ov.rows[ui.ov.cur];
    if (r?.kind !== 'ref' && r?.kind !== 'code') return flash('⏎ works on a citation (a path:lines line)', 'dim');
    const res = r.res ?? ui.ann.refs.get(r.ref);
    if (!res?.ok) return flash(res ? `does not resolve: ${res.error}` : 'not a citation', 'red');
    if (!res.units.length) {
      const e = ui.ov.expanded;
      e.has(r.ref) ? e.delete(r.ref) : e.add(r.ref);
      const at = ui.ov.cur;
      ovLayout();
      ui.ov.cur = Math.min(at, ui.ov.rows.length - 1);
      return;
    }
    ui.lastTab = ui.ov.tab;
    ui.ov = null;
    jumpTo(res);
  }
  /** Go to cited lines of the change in the review: unfold their group, file and hunk. */
  function jumpTo(res) {
    const unit = res.units[0];
    const u = order().find((x) => x.unit === unit);
    if (!u) return relayout();
    ui.fold.set(u.fid, false);
    if (u.hunk) ui.fold.set(u.hunk, false);
    if (lensNow() === 'groups') ui.fold.set(groupFoldId(u.group ?? UNGROUPED), false);
    relayout();
    const inLines = (x) => x.kind === 'code' && x.hunk === unit && x.line?.side === res.side && x.line.n >= res.from && x.line.n <= res.to;
    let i = ui.rows.findIndex(inLines);
    if (i < 0) i = ui.rows.findIndex((x) => (u.hunk ? x.kind === 'hunk' && x.hunk === unit : x.units?.includes(unit)));
    if (i >= 0) {
      ui.cur = i;
      ui.top = Math.max(0, i - 3);
    }
    flash(`${res.repo}/${res.file}:${res.from === res.to ? res.from : `${res.from}-${res.to}`}`, 'cyan');
  }
  function ovKey(k) {
    const half = Math.max(1, Math.floor((H() - 3) / 2));
    const p = ui.pending;
    ui.pending = '';
    const i = TABS.findIndex((t) => t.id === ui.ov.tab);
    if (p === 'g' && k === 'g') (ui.ov.cur = 0), ovMove(0);
    else if (k === 'g') return void (ui.pending = 'g');
    else if (k === 'j' || k === '\x1b[B') ovMove(1);
    else if (k === 'k' || k === '\x1b[A') ovMove(-1);
    else if (k === '\x04' || k === '\x1b[6~') ovMove(half);
    else if (k === '\x15' || k === '\x1b[5~') ovMove(-half);
    else if (k === 'G') (ui.ov.cur = ui.ov.rows.length - 1), ovMove(-1), ovMove(1);
    else if (k === 'l' || k === '\t' || k === '\x1b[C') ovTab(TABS[(i + 1) % TABS.length].id);
    else if (k === 'h' || k === '\x1b[Z' || k === '\x1b[D') ovTab(TABS[(i + TABS.length - 1) % TABS.length].id);
    else if (/^[1-9]$/.test(k) && TABS[Number(k) - 1]) ovTab(TABS[Number(k) - 1].id);
    else if (k === '\r') return void (ovEnter(), draw());
    else if (k === 'm' || k === '\x1b') (ui.lastTab = ui.ov.tab), (ui.ov = null);
    else if (k === 'q') return quit();
    else if (k === '?') ui.help = true;
    draw();
  }

  /** Scroll so the rows matching pred show, as far as they fit, keeping the cursor on screen. */
  function showRows(pred) {
    const first = ui.rows.findIndex(pred);
    if (first < 0) return;
    let last = first;
    while (last + 1 < ui.rows.length && pred(ui.rows[last + 1])) last++;
    const bodyH = Math.max(1, H() - 3);
    if (last >= ui.top + bodyH) ui.top = Math.min(last - bodyH + 1, ui.cur);
  }

  /** The next (or previous) comment, folded away or not: unfold its file and hunk and go there. */
  function nextComment(dir) {
    // the rows with everything unfolded give the comments' reading order
    const open = new Map();
    for (const r of ui.ws.repos) for (const f of r.files) [fid(f), ...f.hunks.map((h) => h.key)].forEach((k) => open.set(k, false));
    for (const g of ui.ann?.groups ?? []) open.set(groupFoldId(g.g.id), false);
    open.set(groupFoldId(UNGROUPED), false);
    const full = buildRows(ui.ws, ui.st, { ...opts(), fold: open, hl: new Map() });
    const cur = ui.rows[ui.cur];
    let at = full.findIndex((r) => rowKey(r) === rowKey(cur));
    if (at < 0) at = full.findIndex((r) => (cur?.hunk ? r.hunk === cur.hunk : cur?.fid ? r.fid === cur.fid : false));
    const heads = full.map((r, i) => [r, i]).filter(([r, i]) => r.comment && full[i - 1]?.comment !== r.comment);
    const hit = dir > 0 ? heads.find(([, i]) => i > at) : [...heads].reverse().find(([, i]) => i < at);
    if (!hit) return flash(dir > 0 ? 'no comment below' : 'no comment above', 'dim');
    const [r] = hit;
    if (r.fid) ui.fold.set(r.fid, false);
    if (r.hunk) ui.fold.set(r.hunk, false);
    if (r.group) ui.fold.set(groupFoldId(r.group), false);
    relayout();
    const i = ui.rows.findIndex((x) => x.comment === r.comment);
    if (i >= 0) ui.cur = i;
  }

  // ---------- actions ----------
  function mark(wholeFile) {
    const r = ui.rows[ui.cur];
    const keys = wholeFile ? (r?.fid ? unitsOf(fileById(r.fid).f) : []) : unitsAt(r);
    if (!keys.length) return flash('no change here: v marks the hunk under the cursor', 'yellow');
    const on = !keys.every(marked);
    if (!save((st) => setMarks(st, keys, on))) return;
    // the default fold follows the mark again: a hunk, file or group folds once all of it is reviewed
    for (const k of keys) ui.fold.delete(k);
    if (r.fid && (!on || unitsOf(fileById(r.fid).f).every(marked))) ui.fold.delete(r.fid);
    const g = r.group && ui.rows.find((x) => x.kind === 'group' && x.group === r.group);
    if (g && (!on || g.units.every(marked))) ui.fold.delete(groupFoldId(r.group));
    const n = `${keys.length} ${keys.length === 1 ? 'hunk' : 'hunks'}`;
    // the line that stays put: the hunk's title where it is on screen (else the cursor's line)
    const title = r.hunk && !HEADS.includes(r.kind) ? ui.rows.findIndex((x) => x.kind === 'hunk' && x.hunk === r.hunk && x.group === r.group) : ui.cur;
    const screenRow = (title >= ui.top ? title : ui.cur) - ui.top;
    relayout(r.hunk && !HEADS.includes(r.kind) ? rowKey({ kind: 'hunk', group: r.group, fid: r.fid, hunk: r.hunk }) : rowKey(r));
    ui.top = Math.max(0, ui.cur - screenRow);
    if (on) {
      nextUnreviewed(1, ui.cur, ui.cur);
      flash(`${n} reviewed`);
    } else flash(`${n} no longer reviewed`, 'yellow');
  }
  /** The header row a fold toggles: the group, file or hunk the cursor is in (level: 'outer' skips the hunk). */
  function foldHead(level) {
    const r = ui.rows[ui.cur];
    if (!r) return null;
    const find = (pred) => {
      for (let i = ui.cur; i >= 0; i--) if (pred(ui.rows[i])) return ui.rows[i];
      return null;
    };
    if (['group', 'file', 'hunk'].includes(r.kind) && !(level === 'outer' && r.kind === 'hunk')) return r;
    if (level !== 'outer' && r.hunk && r.kind !== 'part') return find((x) => x.kind === 'hunk' && x.hunk === r.hunk);
    if (lensNow() === 'groups' && r.group) {
      // in "not grouped", files fold; in a group, the group
      if (r.group === UNGROUPED && r.fid) return find((x) => x.kind === 'file' && x.fid === r.fid);
      return find((x) => x.kind === 'group' && x.group === r.group);
    }
    return r.fid ? find((x) => x.kind === 'file' && x.fid === r.fid) : null;
  }
  const foldId = (h) => (h.kind === 'group' ? groupFoldId(h.group) : h.kind === 'file' ? h.fid : h.hunk);
  function toggleFold(level) {
    const h = foldHead(level);
    if (!h) return;
    ui.fold.set(foldId(h), !h.folded);
    relayout(rowKey(h));
  }
  function foldAll() {
    const heads = ui.rows.filter((x) => x.kind === (lensNow() === 'groups' ? 'group' : 'file'));
    const anyOpen = heads.some((x) => !x.folded);
    for (const h of heads) ui.fold.set(foldId(h), anyOpen);
    const h = foldHead('outer');
    relayout(h ? rowKey(h) : null);
  }

  /**
   * The other lens, on the same code: the same line, else the same hunk, else the same
   * file (a group's line: its first hunk), on the same screen row as before.
   */
  function switchLens() {
    const r = ui.rows[ui.cur];
    const screenRow = ui.cur - ui.top;
    const unit = r?.hunk ?? (r?.units?.length ? r.units[0] : null);
    const file = r?.fid ?? (unit ? fid(fileById(unitFile(unit))?.f ?? {}) : null);
    const line = r?.kind === 'code' && r.line ? JSON.stringify(r.line) : null;
    ui.lens = lensNow() === 'groups' ? 'services' : 'groups';
    relayout(null);
    const tries = [
      (x) => line && x.kind === 'code' && x.hunk === unit && JSON.stringify(x.line) === line,
      (x) => unit && x.kind === 'hunk' && x.hunk === unit,
      (x) => unit && x.units?.includes(unit) && ['file', 'blank'].includes(x.kind),
      (x) => file && x.kind === 'file' && x.fid === file,
      (x) => file && x.fid === file,
    ];
    for (const t of tries) {
      const i = ui.rows.findIndex(t);
      if (i >= 0) {
        ui.cur = i;
        break;
      }
    }
    ui.top = Math.max(0, ui.cur - screenRow);
    draw();
  }
  /**
   * gt: from code to its test in the change, or from a test to its code (on a signal row
   * that names one: that one). Again: back. Several: each in turn.
   */
  function jumpToPair(targets = null) {
    const here = ui.rows[ui.cur]?.fid;
    const sig = ui.ws?.signals;
    const to = targets ?? (here ? (sig?.codeOfTest.get(here) ?? sig?.testsOfCode.get(here)) : null) ?? [];
    if (!to.length) return flash(here ? 'no test or code paired with this file in the change' : 'not on a file', 'dim');
    // several: the one after the last jumped to from here
    const last = ui.pairFrom === here ? to.indexOf(ui.pairTo) : -1;
    const target = to[(last + 1) % to.length];
    const f = fileById(target)?.f;
    if (!f) return;
    ui.fold.set(target, false);
    const us = unitsOf(f);
    if (lensNow() === 'groups') {
      for (const { g, units } of ui.ann.groups) if (units.some((u) => us.includes(u))) ui.fold.set(groupFoldId(g.id), false);
      ui.fold.set(groupFoldId(UNGROUPED), false);
    }
    relayout();
    const heads = ['file', 'part'];
    let i = ui.rows.findIndex((r) => r.fid === target && heads.includes(r.kind));
    if (i < 0) i = ui.rows.findIndex((r) => r.fid === target);
    if (i < 0) return flash(`${f.file} is not shown here`, 'yellow');
    ui.cur = i;
    ui.top = Math.max(0, i - 2);
    ui.pairFrom = target;
    ui.pairTo = here;
    flash(`${to.length > 1 ? `${to.indexOf(target) + 1}/${to.length} ` : ''}${f.file}   gt: back`, 'dim');
  }

  /** In the f menu: 1-4 show or hide a kind of marker, 0 all, f / esc / ⏎ done. */
  function layersKey(k) {
    const i = Number(k);
    if (k === '0') for (const x of LAYERS) ui.show[x] = true;
    else if (i >= 1 && i <= LAYERS.length) ui.show[LAYERS[i - 1]] = !ui.show[LAYERS[i - 1]];
    else if (k === 'f' || k === '\x1b' || k === '\r' || k === 'q') ui.layers = null;
    else return;
    // like a: the top line stays, the cursor stays on its line
    relayoutKeeping();
  }

  /**
   * a: hide the annotations, or show them again. The line at the top of the screen stays,
   * what is below closes up or opens out, as a fold does; the cursor stays on its line (on
   * a line that goes away, the next one that stays). Shown again without moving: back
   * exactly where it was.
   */
  function toggleQuiet() {
    const old = ui.rows;
    const from = { cur: ui.cur, top: ui.top };
    const back = ui.quietBack;
    ui.quiet = !ui.quiet;
    relayoutKeeping();
    if (!ui.quiet && back && rowKey(old[from.cur]) === back.landed && ui.rows.length === back.n) {
      ui.cur = back.cur;
      ui.top = back.top;
    }
    ui.quietBack = ui.quiet ? { cur: from.cur, top: from.top, n: old.length, landed: rowKey(ui.rows[ui.cur]) } : null;
    flash(ui.quiet ? 'annotations hidden: a shows them' : 'annotations shown');
  }

  /** Lay out again with rows gone or back: the top line and the cursor's line stay (as for a). */
  function relayoutKeeping() {
    const old = ui.rows;
    const from = { cur: ui.cur, top: ui.top };
    relayout(null);
    const occ = (rows) => {
      const n = new Map();
      return rows.map((r) => {
        const k = rowKey(r);
        n.set(k, (n.get(k) ?? 0) + 1);
        return `${k}#${n.get(k)}`;
      });
    };
    const at = new Map(occ(ui.rows).map((k, i) => [k, i]));
    const oldKeys = occ(old);
    const same = (j) => (nonEmpty(old[j]) ? (at.get(oldKeys[j]) ?? -1) : -1);
    const stays = (j0) => {
      for (let j = j0; j < old.length; j++) if (same(j) >= 0) return same(j);
      for (let j = j0 - 1; j >= 0; j--) if (same(j) >= 0) return same(j);
      return 0;
    };
    ui.cur = stays(from.cur);
    ui.top = from.top === 0 ? 0 : stays(from.top);
    const bodyH = Math.max(1, H() - 3);
    if (ui.cur < ui.top) ui.top = ui.cur;
    if (ui.cur >= ui.top + bodyH) ui.top = ui.cur - bodyH + 1;
    draw();
  }

  /** The fid of the file a unit (hunk key, or a hunkless file's key) belongs to. */
  function unitFile(unit) {
    for (const r of ui.ws?.repos ?? []) for (const f of r.files) if (f.key === unit || f.hunks.some((h) => h.key === unit)) return fid(f);
    return null;
  }

  /**
   * /: a live search. Each key shows the matches and goes to the first one from where the
   * search started (the screen scrolls only when it is out of view); ⏎ keeps it, esc goes
   * back to where it started.
   */
  function startSearch() {
    const from = { cur: ui.cur, top: ui.top, search: ui.search };
    const show = (q) => {
      ui.search = q ? { q, hits: searchHits(q) } : null;
      const hits = ui.search?.hits ?? [];
      if (!hits.length) return void ((ui.cur = from.cur), (ui.top = from.top));
      ui.cur = hits.find((i) => i > from.cur) ?? hits[0];
      const bodyH = Math.max(1, H() - 3);
      ui.top = from.top;
      if (ui.cur < ui.top || ui.cur >= ui.top + bodyH) ui.top = Math.max(0, ui.cur - Math.floor(bodyH / 3));
    };
    ask({
      label: '/',
      multiline: false,
      onChange: show,
      onSubmit: (q) => {
        show(q);
        if (q && !ui.search.hits.length) flash(`no match: ${q}`, 'yellow');
      },
      onCancel: () => Object.assign(ui, from),
    });
  }

  /** A text field in the footer. onChange(text) on every key (a live search), onCancel on esc. */
  function ask({ label, multiline = true, value = '', onSubmit, onChange = null, onCancel = null }) {
    ui.input = { label, multiline, onSubmit, onChange, onCancel, field: textField(value, { multiline, vi: viMode }) };
    draw();
  }
  function comment() {
    const r = ui.rows[ui.cur];
    if (r?.comment) return editAt();
    if (!r?.fid) return flash('comments go on a file or a line of it', 'yellow');
    const x = fileById(r.fid);
    let at = { repo: x.repo.name, file: x.f.file, side: null, line: null, quote: null, hunk: null };
    if (r.kind === 'code' && r.line && typeof r.line === 'object') {
      const h = x.f.hunks.find((y) => y.key === r.hunk);
      const l = h?.lines.find(([, , o, n]) => (r.line.side === 'old' ? o : n) === r.line.n);
      at = { ...at, side: r.line.side, line: r.line.n, quote: l ? l[1] : null, hunk: r.hunk };
    }
    const label = `comment on ${x.repo.name}/${x.f.file}${at.line != null ? `:${at.side === 'old' ? '-' : '+'}${at.line}` : ''}: `;
    ask({
      label,
      onSubmit: (text) => {
        if (!text.trim()) return;
        let c = null;
        if (save((st) => (c = addComment(st, at, text.trim())))) {
          relayout();
          showRows((x) => x.comment === c.id);
          flash('comment saved');
        }
      },
    });
  }
  function editAt() {
    const r = ui.rows[ui.cur];
    const c = r?.comment && ui.st.comments.find((x) => x.id === r.comment);
    if (!c) return flash('no comment here (]c: the next one)', 'yellow');
    ask({
      label: 'edit the comment: ',
      value: c.text,
      onSubmit: (text) => {
        if (!text.trim()) return flash('empty: not changed (x deletes)', 'yellow');
        if (save((st) => editComment(st, c.id, text.trim()))) relayout(), flash('comment changed');
      },
    });
  }
  function deleteAt() {
    const r = ui.rows[ui.cur];
    if (!r?.comment) return flash('no comment here', 'yellow');
    if (!(ui.confirm?.what === r.comment && ui.confirm.until > Date.now())) {
      ui.confirm = { what: r.comment, until: Date.now() + 3000 };
      return flash('delete this comment? x again', 'yellow');
    }
    ui.confirm = null;
    if (save((st) => deleteComment(st, r.comment))) relayout(), flash('comment deleted');
  }

  // ---------- the feedback key (discovery §11) ----------
  /**
   * What an entry made at the cursor is about: the kind of thing (aboutRow), where it is,
   * and its text as shown (the rows of the same finding, note or comment), so the entry
   * reads without the worktrees.
   */
  function feedbackTarget() {
    let i = ui.cur;
    // on a spacer: the thing below it
    while (ui.rows[i]?.spacer && i + 1 < ui.rows.length) i++;
    const r = ui.rows[i];
    if (!r) return null;
    const same = (x) => x && !x.spacer && (r.comment ? x.comment === r.comment : r.callout && r.callout !== 'fr' ? x.callout === r.callout && x.about === r.about : false);
    let a = i;
    let b = i;
    while (same(ui.rows[a - 1])) a--;
    while (same(ui.rows[b + 1])) b++;
    const text = ui.rows.slice(a, b + 1).map((x) => plain(x.segs).replace(/^[\s▌▎┃]+/, '').trimEnd()).filter(Boolean).join('\n').slice(0, 2000);
    const t = { about: aboutRow(r), feature: ui.ws.root, text };
    const x = r.fid && fileById(r.fid);
    if (x) Object.assign(t, { repo: x.repo.name, file: x.f.file });
    else if (r.repo) t.repo = r.repo;
    if (r.hunk) t.hunk = r.hunk;
    if (r.group) t.group = r.group;
    if (r.line && typeof r.line === 'object' && x) {
      t.line = { side: r.line.side, n: r.line.n };
      const l = x.f.hunks.find((y) => y.key === r.hunk)?.lines.find(([, , o, n]) => (r.line.side === 'old' ? o : n) === r.line.n);
      if (l) t.quote = l[1];
      const cov = r.line.side === 'new' && ui.ws.signals?.coverage?.get(r.fid);
      if (cov && !cov.stale && cov.lines.get(r.line.n)) t.coverage = cov.lines.get(r.line.n);
    }
    return t;
  }
  function startFeedback() {
    const target = feedbackTarget();
    if (!target) return flash('nothing here', 'yellow');
    ui.fb = { target };
    draw();
  }
  const VERDICT_KEYS = { h: 'helped', 1: 'helped', m: 'missing', 2: 'missing', w: 'wrong', 3: 'wrong' };
  function feedbackKey(k) {
    const verdict = VERDICT_KEYS[k];
    if (k === '\x1b' || k === 'q' || k === '!') return void ((ui.fb = null), draw());
    if (!verdict) return;
    const { target } = ui.fb;
    ui.fb = null;
    const hint = { helped: 'what it saved you (optional)', missing: 'what should have been said here (optional)', wrong: 'what is wrong about it (optional)' }[verdict];
    ask({
      label: `${verdict} · ${target.about}: ${hint}: `,
      multiline: false,
      onSubmit: (note) => {
        try {
          recordFeedback(feedbackFile, { verdict, ...(note.trim() ? { note: note.trim() } : {}), ...target });
          flash(`feedback recorded: ${verdict} · ${target.about}   (fr feedback reads it back)`);
        } catch (e) {
          flash(`feedback not recorded: ${e.message}`, 'red');
        }
      },
      onCancel: () => flash('feedback not recorded', 'dim'),
    });
  }

  function openEditor() {
    const r = ui.rows[ui.cur];
    const x = r?.fid && fileById(r.fid);
    if (!x) return flash('no file here', 'yellow');
    if (x.f.status === 'D') return flash('the file is deleted in the change', 'yellow');
    let line = 1;
    if (r.line && typeof r.line === 'object') line = r.line.side === 'new' ? r.line.n : (x.f.hunks.find((h) => h.key === r.hunk)?.newStart ?? 1);
    else if (r.hunk) line = x.f.hunks.find((h) => h.key === r.hunk)?.newStart ?? 1;
    const cmd = editor || 'vi';
    out.write(`${ESC}?2004l${ESC}?25h${ESC}?1049l`);
    if (input.isTTY) input.setRawMode(false);
    spawnSync('sh', ['-c', `${cmd} "$@"`, 'sh', `+${line}`, path.join(x.repo.dir, x.f.file)], { stdio: 'inherit' });
    if (input.isTTY) input.setRawMode(true);
    out.write(`${ESC}?1049h${ESC}?25l${ESC}?2004h${ESC}2J`);
    draw();
  }

  // ---------- keys ----------
  function quit() {
    close();
    out.write(`${ESC}?2004l${ESC}?25h${ESC}?1049l`);
    exit(0);
  }
  let pasting = false;
  function onKey(k) {
    if (k === '\x03') return quit();
    if (k === '\x1b[200~') return void (pasting = true);
    if (k === '\x1b[201~') return void ((pasting = false), draw());
    if (ui.input) {
      const res = keyField(ui.input.field, k, { pasting });
      if (res === 'submit') {
        const inp = ui.input;
        ui.input = null;
        inp.onSubmit(fieldText(inp.field));
      } else if (res === 'cancel') {
        const inp = ui.input;
        ui.input = null;
        inp.onCancel?.();
      } else ui.input.onChange?.(fieldText(ui.input.field));
      return draw();
    }
    if (pasting) return;
    if (ui.help) return void ((ui.help = false), draw());
    if (!ui.ws) {
      if (k === 'q') return quit();
      if (k === 'r') return void reload();
      return;
    }
    if (ui.ov) return ovKey(k);
    if (ui.layers) return layersKey(k);
    if (ui.fb) return feedbackKey(k);
    const half = Math.max(1, Math.floor((H() - 3) / 2));
    const p = ui.pending;
    ui.pending = '';
    if (p === 'g' && k === 'g') (ui.cur = 0), move(0);
    else if (p === 'g' && k === 't') return jumpToPair();
    else if (p === ']' || p === '[') {
      const dir = p === ']' ? 1 : -1;
      if (k === p) jump((r) => r.kind === 'file' || r.kind === 'part', dir);
      else if (k === 'h') jump(isUnitStart, dir);
      else if (k === 'u') nextUnreviewed(dir);
      else if (k === 'c') nextComment(dir);
      else if (k === 'g' || k === 'r') jump((r) => r.kind === 'group' || r.kind === 'repo', dir);
    } else if (k === 'g' || k === ']' || k === '[') return void (ui.pending = k);
    else if (k === 'j' || k === '\x1b[B' || k === '\x0e') move(1);
    else if (k === 'k' || k === '\x1b[A' || k === '\x10') move(-1);
    else if (k === '\x04' || k === '\x1b[6~' || k === '\x06') move(k === '\x04' ? half : H() - 3);
    else if (k === '\x15' || k === '\x1b[5~' || k === '\x02') move(k === '\x15' ? -half : -(H() - 3));
    else if (k === 'G' || k === '\x1b[F' || k === '\x1b[4~') (ui.cur = ui.rows.length - 1), move(-1), move(1);
    else if (k === '\x1b[H' || k === '\x1b[1~') ui.cur = 0;
    else if (k === 'n' || k === 'N') {
      const hs = ui.search?.hits ?? [];
      if (!hs.length) return flash(ui.search ? 'no match' : '/ to search', 'dim');
      ui.cur = k === 'n' ? (hs.find((i) => i > ui.cur) ?? hs[0]) : ([...hs].reverse().find((i) => i < ui.cur) ?? hs[hs.length - 1]);
    } else if (k === 'v' || k === 'V') return mark(k === 'V');
    else if (k === ' ') toggleFold();
    else if (k === 'z') toggleFold('outer');
    else if (k === 'm') openOverview();
    else if (k === 'a') return toggleQuiet();
    else if (k === 'f') return void ((ui.layers = {}), draw());
    else if (k === '\r' && ui.rows[ui.cur]?.pair) return jumpToPair(ui.rows[ui.cur].pair);
    else if (k === '\r' && ui.rows[ui.cur]?.expand) {
      // a finding naming code outside the change: show it in place, or hide it again
      const id = ui.rows[ui.cur].expand;
      ui.fold.set(id, ui.fold.get(id) === false);
      relayout(); // the cursor stays on the finding (its first row)
      // what opened shows: scroll it into view, the finding still on screen
      const last = ui.rows.findLastIndex((r) => r.expand === id);
      const bodyH = Math.max(1, H() - 3);
      if (last >= ui.top + bodyH) ui.top = Math.min(ui.cur, last - bodyH + 1);
    }
    else if (k === '\t') {
      if (!ui.ann?.groups.length) return flash(ui.annError ? `annotations: ${ui.annError}` : `no groups: the agent writes them to ${annotationsPath(ui.ws.root)}`, 'yellow');
      return switchLens();
    }
    else if (k === 'Z') foldAll();
    else if (k === 'c') return comment();
    else if (k === 'e') return editAt();
    else if (k === 'x') return deleteAt();
    else if (k === 'o') return openEditor();
    else if (k === '!') return startFeedback();
    else if (k === 's') {
      // switch what is on screen; auto (the setting) only picks the start
      ui.layout = shownLayout() === 'split' ? 'unified' : 'split';
      relayout();
    } else if (k === 'r') return void reload('reloaded');
    else if (k === '/') return startSearch();
    else if (k === '\x1b') ui.search = null;
    else if (k === '?') ui.help = true;
    else if (k === 'q') return quit();
    draw();
  }

  // ---------- start ----------
  // the terminal's colours, before anything else reads stdin (unless the background is set)
  if (queryTheme) {
    const colors = await queryColors({ input, output }).catch(() => null);
    if (colors) applyTheme(colors);
  }
  out.write(`${ESC}?1049h${ESC}?25l${ESC}?2004h${ESC}2J`);
  if (out === process.stdout) {
    process.on('SIGTERM', quit);
    process.on('SIGHUP', quit);
    process.on('uncaughtException', (e) => {
      out.write(`${ESC}?2004l${ESC}?25h${ESC}?1049l`);
      console.error(e);
      process.exit(1);
    });
  }
  const onResize = () => {
    relayout();
    if (ui.ov) ovLayout();
    draw();
  };
  out.on('resize', onResize);
  if (input.isTTY) input.setRawMode(true);
  input.setEncoding('utf8');
  const onData = (d) => {
    const keys = d.replace(/\r\n/g, '\r').match(/\x1b\[[0-9;]*[~A-Za-z]|\x1bO[A-Za-z]|\x1b[\r\n\x7f\bbfdz<>]|\x1b|[\s\S]/g) || [];
    for (const k of keys) onKey(k);
  };
  input.on('data', onData);
  // the colour query paused stdin; a paused stream stays paused when a reader attaches
  input.resume();
  const ticker = setInterval(() => ui.flash && ui.flash.until < Date.now() && ((ui.flash = null), draw()), 1000);
  ticker.unref();
  function close() {
    input.off('data', onData);
    out.off('resize', onResize);
    clearInterval(ticker);
    if (watching) fs.unwatchFile(annotationsPath(watching));
  }
  draw();
  await reload();
  return { close, ui };
}
