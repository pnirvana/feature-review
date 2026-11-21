// The viewer: a full-screen terminal view of a feature's change (src/rows.mjs), with
// reviewed marks per hunk and per file, comments anchored to lines, folding, search, and
// opening a line in $EDITOR. Keys follow ATF's review viewer where they overlap.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadWorkspace } from './workspace.mjs';
import { readState, update, setMarks, addComment, editComment, deleteComment } from './state.mjs';
import { buildRows, highlightFiles, fid, unitsOf, isFolded } from './rows.mjs';
import { ESC, fit, plain, charWidth, strWidth, segsWidth } from './md/term.mjs';
import { textField, keyField, fieldText, fieldRows, fieldMode } from './ui/textfield.mjs';

const LAYOUTS = ['auto', 'split', 'unified'];

const HELP = [
  'fr: feature review',
  '',
  'j k ↑↓          move                    ctrl-d/u half a page   ctrl-f/b a page   gg G top / end',
  ']] [[           next / previous file    ]r [r  service',
  ']h [h           next / previous hunk    ]u [u  next / previous hunk not reviewed yet',
  ']c [c           next / previous comment',
  'v               reviewed: the hunk under the cursor (on a file line: the file), then on to the next',
  'V               reviewed: the whole file under the cursor (again: not reviewed)',
  'space           fold the hunk (on a file line: the file)   z  the file   Z  every file',
  'c               comment on the line under the cursor (on a file or hunk line: the file)',
  'e x             on a comment: edit it / delete it (x twice)',
  'o               open the line in $EDITOR',
  's               layout: auto, split, unified',
  'r               reload (the worktrees and the review state)',
  '/  n N  esc     search, next / previous match, end the search',
  'q               quit',
  '',
  'Reviewed hunks and files fold away; a mark resets when the hunk changes.',
  'Marks and comments are kept in <dir>/.feature-review/state.json.',
];

export async function runViewer({ dir, layout = 'auto', highlight = 'auto' }) {
  const out = process.stdout;
  const ui = {
    ws: null,
    st: null,
    hl: new Map(),
    rows: [],
    cur: 0,
    top: 0,
    fold: new Map(),
    layout,
    search: null,
    input: null,
    flash: null,
    pending: '',
    confirm: null,
    help: false,
    error: null,
    loading: false,
    highlighting: false,
  };

  const W = () => out.columns || 100;
  const H = () => out.rows || 30;
  const flash = (msg, style = 'green') => {
    ui.flash = { msg, style, until: Date.now() + 4000 };
    draw();
  };

  // ---------- data ----------
  const rowKey = (r) => (r ? [r.kind, r.fid ?? r.repo ?? '', r.hunk ?? '', JSON.stringify(r.line ?? null), r.comment ?? ''].join('|') : null);
  function relayout(keep = rowKey(ui.rows[ui.cur])) {
    if (!ui.ws) return;
    ui.rows = buildRows(ui.ws, ui.st, { width: Math.max(30, W() - 2), layout: ui.layout, fold: ui.fold, hl: ui.hl });
    if (ui.search) ui.search.hits = searchHits(ui.search.q);
    restore(keep);
  }
  function restore(key) {
    if (key) {
      let i = ui.rows.findIndex((r) => rowKey(r) === key);
      if (i < 0) {
        // the row is gone (folded, reloaded): the nearest row of the same hunk or file
        const [, f, h] = key.split('|');
        i = ui.rows.findIndex((r) => h && r.hunk === h);
        if (i < 0) i = ui.rows.findIndex((r) => f && r.fid === f);
      }
      if (i >= 0) ui.cur = i;
    }
    ui.cur = Math.max(0, Math.min(ui.cur, ui.rows.length - 1));
  }
  async function reload(note = null) {
    if (ui.loading) return;
    ui.loading = true;
    draw();
    let ws = null;
    try {
      ws = await loadWorkspace(dir);
      ui.st = readState(ws.root);
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
  /** The reviewable units in reading order: [{unit, fid, hunk (key or null)}]. */
  const order = () => ui.ws.repos.flatMap((r) => r.files.flatMap((f) => (f.hunks.length ? f.hunks.map((h) => ({ unit: h.key, fid: fid(f), hunk: h.key })) : [{ unit: f.key, fid: fid(f), hunk: null }])));
  /** The units under the cursor: the hunk, or the file on a file line (or a file without hunks). */
  function unitsAt(r = ui.rows[ui.cur]) {
    if (!r?.fid) return [];
    if (r.hunk && r.kind !== 'file') return [r.hunk];
    const x = fileById(r.fid);
    return x ? unitsOf(x.f) : [];
  }
  const marked = (k) => Boolean(ui.st.marks[k]);

  // ---------- drawing ----------
  function header() {
    if (!ui.ws) return [[' fr ', 'bold inverse'], [ui.loading ? ' reading…' : '', 'dim']];
    const all = order();
    const done = all.filter((u) => marked(u.unit)).length;
    return [
      [' fr ', 'bold inverse'],
      [` ${ui.ws.name} `, 'bold'],
      [` reviewed ${done}/${all.length}`, all.length && done === all.length ? 'green bold' : ''],
      ...(ui.st.comments.length ? [[`  ${ui.st.comments.length} comment${ui.st.comments.length === 1 ? '' : 's'}`, 'magenta']] : []),
      [`  ${ui.layout}`, 'dim'],
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
  const KEYS = 'j/k move  ]] file  ]u not reviewed  v reviewed  space fold  c comment  o editor  s layout  / search  ? help  q quit';
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
    if (ui.flash && ui.flash.until > Date.now()) return [[[' ' + ui.flash.msg, ui.flash.style]]];
    if (ui.search) {
      const n = ui.search.hits.length;
      const at = ui.search.hits.indexOf(ui.cur);
      return [[[` /${ui.search.q}`, 'bold'], [n ? `  ${at >= 0 ? at + 1 : '-'}/${n}` : '  no match', n ? '' : 'red'], ['   n / N next / previous   esc end search', 'dim']]];
    }
    const loc = where(ui.rows[ui.cur]);
    return [[[' ' + KEYS, 'dim']], ...(loc ? [[[' ', ''], [loc, 'gray']]] : [])];
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
    else {
      if (ui.cur < ui.top) ui.top = ui.cur;
      if (ui.cur >= ui.top + bodyH) ui.top = ui.cur - bodyH + 1;
      ui.top = Math.max(0, Math.min(ui.top, Math.max(0, ui.rows.length - bodyH)));
      const hits = new Set(ui.search?.hits ?? []);
      body = ui.rows.slice(ui.top, ui.top + bodyH).map((r, i) => {
        const idx = ui.top + i;
        const g = idx === ui.cur ? [['▌', 'cyan bold']] : hits.has(idx) ? [['›', 'yellow']] : [[' ', '']];
        const segs = hits.has(idx) && ui.search ? markMatches(r.segs, ui.search.q, idx === ui.cur) : r.segs;
        return [...g, [' ', ''], ...segs];
      });
    }
    const lines = [...head, ...body.slice(0, bodyH)];
    while (lines.length < head.length + bodyH) lines.push([]);
    lines.push(...foot);
    out.write(`${ESC}H` + lines.map((l) => fit(l, w) + `${ESC}K`).join('\r\n') + `${ESC}J`);
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
  const nonEmpty = (r) => r && r.segs.length && segsWidth(r.segs) > 0;
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
  const isUnitStart = (r) => r.kind === 'hunk' || (r.kind === 'file' && fileById(r.fid)?.f.hunks.length === 0);

  /** The next (or previous) unit not reviewed, in reading order: unfold it and go there. */
  function nextUnreviewed(dir = 1, fromRow = ui.cur) {
    const all = order();
    let r = ui.rows[fromRow];
    // where the cursor is in reading order: its hunk, its file, or the nearest unit row above
    let at = -1;
    for (let i = fromRow; i >= 0 && at < 0; i--) {
      r = ui.rows[i];
      if (r.hunk && r.kind !== 'file') at = all.findIndex((u) => u.unit === r.hunk);
      else if (r.fid) at = all.findIndex((u) => u.fid === r.fid) - (dir > 0 ? 1 : 0);
    }
    const seq = dir > 0 ? all.slice(at + 1) : all.slice(0, Math.max(0, at)).reverse();
    const u = seq.find((x) => !marked(x.unit));
    if (!u) return flash(all.every((x) => marked(x.unit)) ? 'everything is reviewed' : dir > 0 ? 'nothing below left to review' : 'nothing above left to review', all.every((x) => marked(x.unit)) ? 'green' : 'dim');
    ui.fold.set(u.fid, false);
    if (u.hunk) ui.fold.set(u.hunk, false);
    relayout();
    const i = ui.rows.findIndex((x) => (u.hunk ? x.kind === 'hunk' && x.hunk === u.hunk : x.kind === 'file' && x.fid === u.fid));
    if (i >= 0) ui.cur = i;
    // scroll so the whole hunk shows, when it fits
    if (i < 0 || !u.hunk) return;
    let end = i;
    while (end + 1 < ui.rows.length && ui.rows[end + 1].hunk === u.hunk) end++;
    const bodyH = H() - 3;
    if (end - i < bodyH && end >= ui.top + bodyH) ui.top = end - bodyH + 1;
  }

  /** The next (or previous) comment, folded away or not: unfold its file and hunk and go there. */
  function nextComment(dir) {
    // the rows with everything unfolded give the comments' reading order
    const open = new Map();
    for (const r of ui.ws.repos) for (const f of r.files) [fid(f), ...f.hunks.map((h) => h.key)].forEach((k) => open.set(k, false));
    const full = buildRows(ui.ws, ui.st, { width: Math.max(30, W() - 2), layout: ui.layout, fold: open, hl: new Map() });
    const cur = ui.rows[ui.cur];
    let at = full.findIndex((r) => rowKey(r) === rowKey(cur));
    if (at < 0) at = full.findIndex((r) => (cur?.hunk ? r.hunk === cur.hunk : cur?.fid ? r.fid === cur.fid : false));
    const heads = full.map((r, i) => [r, i]).filter(([r, i]) => r.comment && full[i - 1]?.comment !== r.comment);
    const hit = dir > 0 ? heads.find(([, i]) => i > at) : [...heads].reverse().find(([, i]) => i < at);
    if (!hit) return flash(dir > 0 ? 'no comment below' : 'no comment above', 'dim');
    const [r] = hit;
    if (r.fid) ui.fold.set(r.fid, false);
    if (r.hunk) ui.fold.set(r.hunk, false);
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
    // the default fold follows the mark again
    for (const k of keys) ui.fold.delete(k);
    // a file folds away once all of it is reviewed
    if (r.fid && (wholeFile || r.kind === 'file' || (on && unitsOf(fileById(r.fid).f).every((k) => keys.includes(k) || marked(k))))) ui.fold.delete(r.fid);
    const n = `${keys.length} ${keys.length === 1 ? 'hunk' : 'hunks'}`;
    if (on) {
      relayout(rowKey(r));
      nextUnreviewed(1, ui.cur);
      flash(`${n} reviewed`);
    } else {
      relayout(rowKey(r));
      flash(`${n} no longer reviewed`, 'yellow');
    }
  }
  function toggleFold(level) {
    const r = ui.rows[ui.cur];
    if (!r?.fid) return;
    const x = fileById(r.fid);
    if (!x) return;
    const fileLevel = level === 'file' || r.kind === 'file' || !r.hunk;
    const id = fileLevel ? r.fid : r.hunk;
    const reviewed = fileLevel ? unitsOf(x.f).every(marked) : marked(r.hunk);
    ui.fold.set(id, !isFolded(id, reviewed, ui.fold));
    relayout(fileLevel ? `file|${r.fid}||null|` : `hunk|${r.fid}|${r.hunk}|null|`);
  }
  function foldAll() {
    const files = ui.ws.repos.flatMap((r) => r.files);
    const anyOpen = files.some((f) => !isFolded(fid(f), unitsOf(f).every(marked), ui.fold));
    for (const f of files) ui.fold.set(fid(f), anyOpen);
    const r = ui.rows[ui.cur];
    relayout(r?.fid ? `file|${r.fid}||null|` : null);
  }

  function ask({ label, multiline = true, value = '', onSubmit }) {
    const vi = ['1', 'true', 'yes', 'on'].includes(String(process.env.FR_VI_MODE || '').toLowerCase());
    ui.input = { label, multiline, onSubmit, field: textField(value, { multiline, vi }) };
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
        if (save((st) => addComment(st, at, text.trim()))) {
          relayout();
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

  function openEditor() {
    const r = ui.rows[ui.cur];
    const x = r?.fid && fileById(r.fid);
    if (!x) return flash('no file here', 'yellow');
    if (x.f.status === 'D') return flash('the file is deleted in the change', 'yellow');
    let line = 1;
    if (r.line && typeof r.line === 'object') line = r.line.side === 'new' ? r.line.n : (x.f.hunks.find((h) => h.key === r.hunk)?.newStart ?? 1);
    else if (r.hunk) line = x.f.hunks.find((h) => h.key === r.hunk)?.newStart ?? 1;
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    out.write(`${ESC}?2004l${ESC}?25h${ESC}?1049l`);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    spawnSync('sh', ['-c', `${editor} "$@"`, 'sh', `+${line}`, path.join(x.repo.dir, x.f.file)], { stdio: 'inherit' });
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    out.write(`${ESC}?1049h${ESC}?25l${ESC}?2004h${ESC}2J`);
    draw();
  }

  // ---------- keys ----------
  function quit() {
    out.write(`${ESC}?2004l${ESC}?25h${ESC}?1049l`);
    process.exit(0);
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
      } else if (res === 'cancel') ui.input = null;
      return draw();
    }
    if (pasting) return;
    if (ui.help) return void ((ui.help = false), draw());
    if (!ui.ws) {
      if (k === 'q') return quit();
      if (k === 'r') return void reload();
      return;
    }
    const half = Math.max(1, Math.floor((H() - 3) / 2));
    const p = ui.pending;
    ui.pending = '';
    if (p === 'g' && k === 'g') (ui.cur = 0), move(0);
    else if (p === ']' || p === '[') {
      const dir = p === ']' ? 1 : -1;
      if (k === p) jump((r) => r.kind === 'file', dir);
      else if (k === 'h') jump(isUnitStart, dir);
      else if (k === 'u') nextUnreviewed(dir);
      else if (k === 'c') nextComment(dir);
      else if (k === 'r') jump((r) => r.kind === 'repo', dir);
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
    else if (k === 'z') toggleFold('file');
    else if (k === 'Z') foldAll();
    else if (k === 'c') return comment();
    else if (k === 'e') return editAt();
    else if (k === 'x') return deleteAt();
    else if (k === 'o') return openEditor();
    else if (k === 's') {
      ui.layout = LAYOUTS[(LAYOUTS.indexOf(ui.layout) + 1) % LAYOUTS.length];
      relayout();
    } else if (k === 'r') return void reload('reloaded');
    else if (k === '/')
      return ask({
        label: '/',
        multiline: false,
        onSubmit: (q) => {
          ui.search = q ? { q, hits: searchHits(q) } : null;
          if (ui.search?.hits.length) ui.cur = ui.search.hits.find((i) => i >= ui.cur) ?? ui.search.hits[0];
          draw();
        },
      });
    else if (k === '\x1b') ui.search = null;
    else if (k === '?') ui.help = true;
    else if (k === 'q') return quit();
    draw();
  }

  // ---------- start ----------
  out.write(`${ESC}?1049h${ESC}?25l${ESC}?2004h${ESC}2J`);
  process.on('SIGTERM', quit);
  process.on('SIGHUP', quit);
  process.on('uncaughtException', (e) => {
    out.write(`${ESC}?2004l${ESC}?25h${ESC}?1049l`);
    console.error(e);
    process.exit(1);
  });
  out.on('resize', () => {
    relayout();
    draw();
  });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    const keys = d.replace(/\r\n/g, '\r').match(/\x1b\[[0-9;]*[~A-Za-z]|\x1bO[A-Za-z]|\x1b[\r\n\x7f\bbfdz<>]|\x1b|[\s\S]/g) || [];
    for (const k of keys) onKey(k);
  });
  setInterval(() => ui.flash && ui.flash.until < Date.now() && ((ui.flash = null), draw()), 1000).unref();
  draw();
  await reload();
}
