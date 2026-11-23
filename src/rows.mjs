// The review as rows for a terminal: a summary, one heading per repository (the
// per-service map), each file with its hunks as diffview-style code views, and comments
// below the lines they point at. Shared by the viewer and `fr --print`.
//
// A row is {segs, kind, ...}: kind 'summary' | 'repo' | 'group' | 'part' | 'file' |
// 'hunk' (a hunk's title) | 'code' | 'cited' | 'comment' | 'note' | 'blank' | 'error'.
// Rows inside a file carry fid (repo\0file); code rows carry hunk (its key) and line
// ({side, n}); comment rows carry comment (id); rows of a group carry group (its id).
// spacer rows are only spacing.
import os from 'node:os';
import path from 'node:path';
import { codeView, renderBlock } from './md/render.mjs';
import { parseDoc } from './md/parse.mjs';
import { highlightAsync } from './md/highlight.mjs';
import { pad, plain, restyle, segsWidth, untab, wrapSegs } from './md/term.mjs';
import { fileTexts } from './workspace.mjs';
import { locate, pendingQuestions } from './state.mjs';
import { collectCallouts } from './inline.mjs';
import { signalLayer } from './signals.mjs';
import './ui/theme.mjs'; // the theme's named styles, the fallback until the viewer asks the terminal

export const fid = (f) => `${f.repo}\0${f.file}`;
export const unitsOf = (f) => (f.hunks.length ? f.hunks.map((h) => h.key) : [f.key]);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const short = (sha) => (sha ? sha.slice(0, 7) : '?');
const CONTEXT = 20; // lines highlighted above a hunk
const BATCH_LINES = 2000; // lines per bat call

/** The name bat picks a language by: the extension, else the file name (Dockerfile, Jenkinsfile). */
const hlName = (file) => {
  const b = path.basename(file);
  const ext = path.extname(b);
  return ext ? `x${ext.toLowerCase()}` : b;
};

/** The line ranges of a file's side to highlight: each hunk and CONTEXT lines before it, merged. */
function windows(f, side) {
  const rs = f.hunks
    .map((h) => (side === 'old' ? [h.oldStart, h.oldStart + h.oldCount - 1] : [h.newStart, h.newStart + h.newCount - 1]))
    .filter(([a, b]) => b >= a && b > 0)
    .map(([a, b]) => [Math.max(1, a - CONTEXT), b])
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

/**
 * Highlight the lines the hunks show, with CONTEXT lines before each (so a comment or a
 * string opened just above a hunk comes out right): bat is slow on whole files. Batched per
 * language and side, the batches run in parallel. → Map fid → {old: [segs] by line - 1,
 * new: [...]} (sparse: lines outside the windows are missing and shown plain).
 */
export async function highlightFiles(ws, mode = 'auto') {
  const out = new Map();
  const jobs = [];
  for (const r of ws.repos) {
    if (r.error) continue;
    for (const f of r.files) if (f.hunks.length) jobs.push(fileTexts(r, f).then((t) => ({ f, t })));
  }
  const texts = await Promise.all(jobs);
  const batches = new Map(); // name → [[{f, side, from, lines}]] (each inner list one bat call)
  for (const { f, t } of texts) {
    out.set(fid(f), { old: [], new: [] });
    for (const side of ['old', 'new']) {
      if (t[side] == null) continue;
      const all = t[side].split('\n');
      const name = hlName(side === 'old' ? (f.old ?? f.file) : f.file);
      if (!batches.has(name)) batches.set(name, [[]]);
      const list = batches.get(name);
      for (const [a, b] of windows(f, side)) {
        const piece = { f, side, from: a, lines: all.slice(a - 1, b) };
        let cur = list[list.length - 1];
        if (cur.reduce((n, x) => n + x.lines.length, 0) + piece.lines.length > BATCH_LINES && cur.length) list.push((cur = []));
        cur.push(piece);
      }
    }
  }
  const calls = [...batches].flatMap(([name, list]) => list.filter((b) => b.length).map((b) => ({ name, b })));
  let next = 0;
  const worker = async () => {
    while (next < calls.length) {
      const { name, b } = calls[next++];
      const hl = await highlightAsync(b.flatMap((x) => x.lines), name, mode);
      let at = 0;
      for (const x of b) {
        const arr = out.get(fid(x.f))[x.side];
        x.lines.forEach((_, k) => (arr[x.from - 1 + k] = hl[at + k]));
        at += x.lines.length;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(calls.length, Math.max(1, os.availableParallelism() - 1)) }, worker));
  return out;
}

const ago = (ts) => {
  const s = Math.round((Date.now() - Date.parse(ts)) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

function commentRows(c, loc, width, base) {
  const ind = '    ';
  const head = [[ind + '┌ ', 'magenta'], ['comment', 'magenta bold'], [` · ${ago(c.edited ?? c.at)}${c.edited ? ' (edited)' : ''}`, 'dim']];
  if (loc?.outdated) head.push([`  outdated: was at ${c.side === 'old' ? '-' : '+'}${c.line}${c.quote ? ` “${c.quote.trim().slice(0, 50)}”` : ''}`, 'yellow']);
  if (loc?.moved) head.push(['  (moved with its line)', 'dim']);
  if (loc?.gone) head.push([`  ${c.repo}/${c.file}${c.line != null ? `:${c.line}` : ''} is no longer in the change`, 'yellow']);
  const rows = [{ segs: head, ...base }];
  for (const para of String(c.text).split('\n'))
    for (const r of wrapSegs([[para, '']], Math.max(10, width - ind.length - 2))) rows.push({ segs: [[ind + '│ ', 'magenta'], ...r], ...base });
  rows.push({ segs: [[ind + '└', 'magenta']], ...base });
  return rows;
}

/** Is this unit folded? An explicit choice, else folded once reviewed. */
export const isFolded = (id, reviewed, fold) => (fold.has(id) ? fold.get(id) : reviewed);
export const groupFoldId = (gid) => `g:${gid}`;
export const UNGROUPED = '(not grouped)';

// ---------- the look ----------
// A terminal has one text size, so structure comes from space, background bands, a guide
// bar down the left of a group, and weight: bold for what to read, dim for metadata.
const STATUS = { A: ['A', 'addfg bold'], D: ['D', 'delfg bold'], R: ['R', 'yellow bold'], M: ['M', 'blue bold'] };
// named styles from the terminal's theme (src/ui/theme.mjs): nothing assumes light or dark
const BAND = { group: 'band', ungrouped: 'bandalt', repo: 'band' };
const ACCENT = { group: 'guide', ungrouped: 'guidealt' };
const BADGE = { high: 'riskhigh', medium: 'riskmedium', low: 'risklow' };
const ROLE = 'role';
const GUTTER = 2; // the guide bar and a space

/** An empty row: spacing only (the cursor skips it). */
const spacer = (base = {}, guide = null) => ({ kind: 'blank', spacer: true, ...base, segs: guide ? [['▎', guide]] : [] });
/** A row on a background band, filled to the width (a segment with a background of its own keeps it). */
const band = (segs, width, bg) =>
  pad(
    segs.map(([t, st, o]) => (/(^|[ ;])48;|\b(risk\w+|role)\b/.test(st ?? '') ? [t, st, o] : restyle([[t, st, o]], bg)[0])),
    width,
    bg,
  );
/** Prefix a group's rows with its guide bar. */
const guided = (rows, guide) => rows.map((r) => ({ ...r, segs: [['▎ ', guide], ...r.segs] }));

/**
 * An annotation's prose, Markdown, as rows: paragraphs, lists, quotes, tables, inline code
 * and emphasis, as ATF's review documents rendered it. `extra` adds a style to every
 * segment (dim for notes); code blocks use the built-in highlighter (never a blocking bat).
 */
function mdRows(text, width, base, { extra = '' } = {}) {
  const rows = [];
  parseDoc(String(text ?? '')).forEach((b, i) => {
    if (i) rows.push(spacer(base));
    for (const r of renderBlock(b, { width: Math.max(10, width), highlight: 'builtin' })) rows.push({ kind: 'note', ...base, segs: extra ? restyle(r.segs, extra) : r.segs });
  });
  return rows;
}

/** The kinds of markers the reader can show or hide (f): their notes and their marks. */
export const LAYERS = ['agent', 'fr', 'coverage', 'comments', 'questions'];

/** What every lens needs: the options, marks, located comments, highlighting. */
function context(ws, st, opts) {
  const show = { agent: true, fr: true, coverage: true, comments: true, questions: true, ...opts.show };
  const marked = (k) => Boolean(st.marks[k]);
  const comments = show.comments ? st.comments.map((c) => ({ c, loc: locate(c, ws) })) : [];
  const all = ws.signals ?? { units: new Map(), files: new Map(), mechanical: new Set() };
  // the layers hidden (f) are left out here, so nothing below draws them, notes or marks
  const keep = (m) => new Map([...m].map(([k, list]) => [k, list.filter((s) => show[signalLayer(s)])]));
  const sig = { ...all, units: keep(all.units), files: keep(all.files), coverage: show.coverage ? all.coverage : null };
  // verified mechanical units fold like reviewed ones: a glance, until marked
  const settled = (k) => marked(k) || all.mechanical.has(k);
  // what fr and the agent say about particular changed lines: shown under them, in the diff
  const { byUnit, inlined } = collectCallouts(ws, opts.ann);
  // where a question was asked: its line now, and the hunk that has it
  const askedAt = (q) => {
    const loc = q?.line != null ? locate(q, ws) : null;
    if (loc?.line == null) return null;
    const h = loc.file.hunks.find((x) => x.lines.some(([, , o, n]) => (loc.side === 'old' ? o : n) === loc.line));
    return h ? { h, side: loc.side, line: loc.line } : null;
  };
  // an answer goes where its question was asked (where the reviewer looks for it), whatever
  // range it cites: the range stays marked in the gutter
  const byId = new Map((st.questions ?? []).map((q) => [q.id, q]));
  for (const [u, list] of [...byUnit]) {
    for (const c of list.filter((x) => x.asked && byId.has(x.asked))) {
      const at = askedAt(byId.get(c.asked));
      if (!at) continue;
      c.place = { side: at.side, line: at.line };
      if (at.h.key !== u) {
        byUnit.set(u, byUnit.get(u).filter((x) => x !== c));
        byUnit.set(at.h.key, [...(byUnit.get(at.h.key) ?? []), c]);
      }
    }
  }
  // questions sent to the agent and not answered in the file yet: at their line, waiting
  for (const q of pendingQuestions(st, opts.ann?.ann)) {
    const at = askedAt(q);
    if (!at) continue;
    const { h } = at;
    const loc = { side: at.side, line: at.line };
    const c = { key: `asked:${q.id}`, asked: q.id, source: 'agent', layer: 'questions', pending: true, about: 'asked', level: 'info', label: 'ASKED', question: q.question, text: "waiting for the agent's answer (in its pane until then)", md: false, side: loc.side, from: loc.line, to: loc.line };
    byUnit.set(h.key, [...(byUnit.get(h.key) ?? []), c]);
  }
  // a question just asked, and its answer, show whatever is hidden (h, a, f): the reader is waiting for them
  const reveal = opts.reveal ?? new Set();
  const revealed = (c) => Boolean(c.asked && reveal.has(c.asked));
  const callouts = new Map([...byUnit].map(([u, list]) => [u, list.filter((c) => show[c.source === 'agent' ? (c.layer ?? 'agent') : c.layer] || revealed(c))]));
  const notes = show.agent ? notesByUnit(opts.ann, inlined) : new Map();
  return { ws, st, ...opts, show, revealed, marked, settled, sig, comments, callouts, inlined, shown: new Set(), notes, placed: new Set() };
}

/**
 * The annotations shown in place, by the unit (hunk) they belong under: a ghost under the
 * first hunk it depends on (`because`), a test note under the test's hunk. Notes on no
 * hunk go under the key null. Ghosts and findings shown in the diff (`inlined`) are not
 * notes. → Map unit|null → [{kind: 'ghost'|'test'|'finding', x, res}]
 */
function notesByUnit(ann, inlined = new Set()) {
  const out = new Map();
  if (!ann?.ann) return out;
  const res = (ref) => ann.refs?.get(ref) ?? null;
  const add = (unit, note) => out.set(unit, [...(out.get(unit) ?? []), note]);
  for (const g of Array.isArray(ann.ann.ghosts) ? ann.ann.ghosts : []) {
    if (inlined.has(g)) continue;
    const unit = (Array.isArray(g?.because) ? g.because : []).map((r) => res(r)).find((r) => r?.ok && r.units.length)?.units[0] ?? null;
    add(unit, { kind: 'ghost', x: g, res: res(g?.ref) });
  }
  for (const t of Array.isArray(ann.ann.tests) ? ann.ann.tests : []) {
    const r = res(t?.ref);
    add(r?.ok && r.units.length ? r.units[0] : null, { kind: 'test', x: t, res: r });
  }
  for (const f of Array.isArray(ann.ann.findings) ? ann.ann.findings : []) {
    if (inlined.has(f)) continue;
    const r = res(f?.ref);
    add(r?.ok && r.units.length ? r.units[0] : null, { kind: 'finding', x: f, res: r });
  }
  return out;
}

const STATUS_BADGE = { broken: 'riskhigh', unclear: 'riskmedium', ok: 'risklow' };
const STATUS_BAR = { broken: 'delfg', unclear: 'yellow', ok: 'addfg' };
const human = (kind) => String(kind ?? '').replace(/-/g, ' ').toUpperCase();

/** A ghost or a test note, as a block with a bar down its left. */
function noteRows(ctx, { kind, x, res }, base) {
  const bar = kind === 'ghost' ? (STATUS_BAR[x?.status] ?? 'yellow') : 'agentbar';
  const w = ctx.width - 4;
  const body = [];
  if (kind === 'ghost') {
    body.push({
      kind: 'note',
      ...base,
      segs: [
        [' UNCHANGED ', 'role'],
        ['  ', ''],
        ...(x?.status ? [[` ${String(x.status).toUpperCase()} `, STATUS_BADGE[x.status] ?? 'inverse'], ['  ', '']] : []),
        [refText(res, x?.ref), res?.ok ? 'bold' : 'red bold'],
        ...(res && !res.ok ? [[`  does not resolve: ${res.error}`, 'red']] : []),
      ],
    });
    if (x?.why) body.push(...mdRows(x.why, w, base));
    if (x?.found_by) body.push({ kind: 'note', ...base, segs: [['found by ', 'dim'], [String(x.found_by), 'dim italic']] });
    if (res?.ok && res.code) body.push(spacer(base), ...citedRows({ ...ctx, width: w }, res, base));
  } else if (kind === 'finding') {
    body.push({ kind: 'note', ...base, segs: [[` ${human(x?.kind || 'finding')} `, x?.severity === 'low' ? 'agentsoft' : 'agent'], ['  ', ''], [refText(res, x?.ref), res?.ok ? 'bold' : 'red bold'], ...(res && !res.ok ? [[`  does not resolve: ${res.error}`, 'red']] : [])] });
    if (x?.note) body.push(...mdRows(x.note, w, base));
    if (res?.ok && res.code) body.push(spacer(base), ...citedRows({ ...ctx, width: w }, res, base));
  } else {
    body.push({ kind: 'note', ...base, segs: [[' TEST INTENT ', 'role'], ['  ', ''], [String(x?.name ?? refText(res, x?.ref)), 'bold']] });
    if (x?.behaviour) body.push(...mdRows(x.behaviour, w, base));
    if (x?.asserts) {
      body.push({ kind: 'note', ...base, segs: [['asserts', 'dim bold']] });
      body.push(...mdRows(x.asserts, w, base, { extra: 'dim' }));
    }
    for (const f of Array.isArray(x?.flags) ? x.flags : []) {
      if (ctx.inlined?.has(f)) continue; // shown in the diff, under its line
      body.push(spacer(base), { kind: 'note', ...base, segs: [[` ${human(f?.kind)} `, 'riskmedium']] });
      if (f?.note) body.push(...mdRows(f.note, w, base));
      for (const r of Array.isArray(f?.refs) ? f.refs : []) {
        const fr = ctx.ann?.refs?.get(r);
        body.push({ kind: 'note', ...base, segs: [[refText(fr, r), fr?.ok ? 'dim' : 'red']] });
        if (fr?.ok && fr.code) body.push(...citedRows({ ...ctx, width: w }, fr, base));
      }
    }
  }
  const about = `agent:${kind}${kind === 'ghost' && x?.status ? `:${x.status}` : kind === 'finding' && x?.kind ? `:${x.kind}` : ''}`;
  return [spacer(base), ...body.map((r) => ({ ...r, callout: `note:${kind}`, about, segs: [['  ', ''], ['┃ ', bar], ...r.segs] }))];
}

/** The notes placed under a unit, once per view (a hunk shown in two groups gets them the first time). */
function notesFor(ctx, unit, base) {
  if (ctx.placed.has(unit)) return [];
  const list = ctx.notes.get(unit) ?? [];
  if (list.length) ctx.placed.add(unit);
  return list.flatMap((n) => noteRows(ctx, n, base));
}
/** Notes folded away with their units: counted as placed (they are not lost), → their count text. */
function hideNotes(ctx, units) {
  for (const u of units) if (ctx.notes.has(u)) ctx.placed.add(u);
  return noteCount(ctx, units);
}
/** The findings in the diff of these units, for a folded title: → [segment] or []. */
const findingCount = (ctx, units) => {
  const list = [].concat(units).flatMap((u) => ctx.callouts.get(u) ?? []);
  return list.length ? [[`  ${plural(list.length, 'finding')}`, list.some((c) => c.level === 'warn') ? 'yellow' : 'dim']] : [];
};
const noteCount = (ctx, units) => {
  const list = [].concat(units).flatMap((u) => ctx.notes.get(u) ?? []);
  const g = list.filter((n) => n.kind === 'ghost').length;
  const t = list.length - g;
  return [g && plural(g, 'unchanged caller'), t && plural(t, 'test note')].filter(Boolean).join(', ');
};

function segsForFile(ctx, f) {
  const h2 = ctx.hl.get(fid(f));
  // highlighted text is used only where it is the diff's text (the file may have changed since);
  // not highlighted (yet): plain, never codeView's own (synchronous) highlighting
  if (!h2) return () => null;
  return (l) => {
    const segs = l.t === '-' ? h2.old[l.old - 1] : h2.new[l.new - 1];
    return segs && plain(segs) === untab(l.s) ? segs : null;
  };
}

function commentRowsOf(ctx, x, base) {
  ctx.shown.add(x.c.id);
  return commentRows(x.c, x.loc, ctx.width, { ...base, kind: 'comment', comment: x.c.id });
}

/** Does a callout or comment (side, from..to) cover this diff row? */
const covers = (row, side, from, to) => {
  const n = row.at?.[side];
  return n != null && n >= from && n <= to;
};
const MARK = { agent: 'markagent', fr: 'markfr', comment: 'markcomment', questions: 'markexplain' };
const speaker = (c) => (c.layer === 'questions' ? 'questions' : c.source);
// the coverage of an added line (JaCoCo): a test runs it, some branches not, none
// dots, right after the line's number: a shape of their own, apart from the bars of findings
const COVER = { covered: ['●', 'addfg'], partly: ['◐', 'yellow'], missed: ['○', 'delfg bold'] };
const GUTTER_MARK = 2; // the column for the marks of findings, and a space

/**
 * A callout: a finding of fr or the agent, under the line it is about. One row with the
 * badge and the text when it fits, else the text below; a bar down the left in the
 * speaker's colour. An unchanged caller shows its code on ⏎.
 */
function calloutRows(ctx, c, base, indent) {
  const rows = calloutBody(ctx, c, base, indent);
  if (c.layer !== 'questions') return rows;
  // an answer to the reviewer: tinted across the width, apart from the prepared review
  const own = /\b(explain|asked|code)\b|48;/;
  const tinted = rows.map((r) => {
    const [first, ...rest] = r.segs;
    return { ...r, segs: pad([first, ...rest.map((x) => (own.test(x[1] ?? '') ? x : restyle([x], 'explainband')[0]))], ctx.width, 'explainband') };
  });
  // a line of space above and below: it reads as an aside, not as part of the note before it
  const gap = { ...rows[0], gap: true, segs: [[' '.repeat(indent), '']] };
  return rows[0].folded ? tinted : [gap, ...tinted, gap];
}

function calloutBody(ctx, c, base, indent) {
  const fr = c.source === 'fr';
  const q = c.layer === 'questions';
  const bar = q ? 'explainbar' : fr ? 'factbar' : 'agentbar';
  const badge = q ? (c.pending ? 'asked' : 'explain') : fr ? (c.level === 'info' ? 'factsoft' : 'fact') : c.level === 'info' ? 'agentsoft' : 'agent';
  const w = Math.max(20, ctx.width - indent - 2);
  const open = c.expand && ctx.fold.get(`x:${c.key}`) === false;
  const meta = { kind: 'note', ...base, callout: c.key, about: c.about, ...(c.expand ? { expand: `x:${c.key}` } : {}) };
  const pre = [[' '.repeat(indent), ''], ['┃ ', bar]];
  const head = [[` ${c.label} `, badge]];
  // folded (space): one line that says there is more
  if (ctx.fold.get(`c:${c.key}`) === true) {
    const first = String(c.question || plain(mdRows(String(c.text ?? ''), 1000, base)[0]?.segs ?? []) || '').split('\n')[0].trim();
    const tail = '  ▸ folded · space shows it';
    const room = Math.max(0, w - segsWidth(head) - tail.length - 2);
    return [{ ...meta, folded: true, segs: [...pre, ...head, ['  ', ''], [first.length > room ? `${first.slice(0, Math.max(0, room - 1))}…` : first, q ? 'bold' : ''], [tail, 'yellow']] }];
  }
  // the question it answers, above the answer
  const asked = q && c.question ? [{ ...meta, segs: [...pre, ['you asked', 'dim italic']] }, ...wrapSegs([[c.question, 'bold']], w).map((r) => ({ ...meta, segs: [...pre, ...r] }))] : [];
  if (asked.length && c.pending) return [{ ...meta, segs: [...pre, ...head, ['  ', ''], [c.text, 'dim italic']] }, ...asked.slice(1)];
  if (c.expand) head.push([open ? '   ⏎ hide the code' : '   ⏎ show the code', 'dim']);
  // the code it names: beside the badge when it fits, else on a row of its own (shortened)
  const refRow = [];
  if (c.ref) {
    const t = refText(c.ref, c.refRaw);
    const seg = [t, c.ref.ok ? 'bold' : 'red bold'];
    const headW0 = head.reduce((n, [x]) => n + x.length, 0);
    if (headW0 + 2 + t.length <= w) head.splice(1, 0, ['  ', ''], seg);
    else refRow.push([t.length > w ? `…${t.slice(t.length - w + 1)}` : t, seg[1]]);
  }
  const tone = c.level === 'warn' ? 'yellow' : 'dim';
  let body = [];
  const headW = head.reduce((n, [t]) => n + t.length, 0);
  if (c.text && !c.md) {
    if (headW + 2 + c.text.length <= w) return [{ ...meta, segs: [...pre, ...head, ['  ', ''], [c.text, tone]] }];
    return [{ ...meta, segs: [...pre, ...head] }, ...wrapSegs([[c.text, tone]], w).map((r) => ({ ...meta, segs: [...pre, ...r] }))];
  }
  if (c.text) body = mdRows(c.text, w, base);
  const rows = [{ ...meta, segs: [...pre, ...head] }];
  if (refRow.length) rows.push({ ...meta, segs: [...pre, ...refRow] });
  if (asked.length) rows.push(...asked, { ...meta, segs: [...pre] });
  // a one-line text fits beside the badge
  if (body.length === 1 && !c.ref && !asked.length && headW + 2 + plain(body[0].segs).length <= w) rows[0].segs.push(['  ', ''], ...body[0].segs);
  else for (const r of body) rows.push({ ...meta, segs: [...pre, ...r.segs] });
  if (c.found_by) rows.push({ ...meta, segs: [...pre, ['found by ', 'dim'], [c.found_by, 'dim italic']] });
  if (open) for (const r of citedRows({ ...ctx, width: w }, c.expand, base)) rows.push({ ...r, ...meta, segs: [...pre, ...r.segs] });
  return rows;
}

/**
 * A hunk: its title row and, unless folded, what fr found about it as a whole, the test it
 * is (the agent's intent), then its code with the findings and comments below their lines
 * and a mark in the gutter of each line something is said about; unchanged callers that
 * point at no line of it after the code.
 */
function hunkRows(ctx, f, h, base, { note = null } = {}) {
  const { width, layout, tint, fold, marked } = ctx;
  const rows = [];
  const fileComments = ctx.comments.filter((x) => x.loc?.file === f && x.loc.line != null);
  const here = fileComments.filter((x) => h.lines.some(([t, , o, n]) => (x.loc.side === 'old' ? o : n) === x.loc.line));
  const callouts = ctx.callouts.get(h.key) ?? [];
  const hr = marked(h.key);
  const hf = isFolded(h.key, ctx.settled(h.key), fold);
  // the notes of this hunk hidden (h), or of all (a): the code alone, the gutter marks stay
  const quiet = ctx.quiet || fold.get(`q:${h.key}`) === true;
  const whole0 = (ctx.sig.units.get(h.key) ?? []).filter((x) => !x.at);
  const hiddenHere = !ctx.quiet && quiet && !hf ? callouts.filter((c) => !ctx.revealed(c)).length + whole0.length + (ctx.placed.has(h.key) ? 0 : (ctx.notes.get(h.key) ?? []).length) : 0;
  rows.push({
    kind: 'hunk',
    ...base,
    hunk: h.key,
    folded: hf,
    segs: [
      [hf ? '▸ ' : '▾ ', 'dim'],
      [`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`, 'cyan dim'],
      ...(h.header ? [[' ' + h.header, 'dim']] : []),
      ...(hr ? [['  ✓ reviewed', 'green']] : []),
      ...(note ? [[`  ${note}`, 'yellow']] : []),
      ...(hf ? findingCount(ctx, h.key) : []),
      ...(hf && here.length ? [[`  ${plural(here.length, 'comment')}`, 'magenta']] : []),
      ...(hf && noteCount(ctx, h.key) ? [[`  ${hideNotes(ctx, [h.key])}`, 'cyan']] : []),
      ...(hiddenHere ? [[`  ${plural(hiddenHere, 'note')} hidden · h shows them`, 'yellow']] : []),
    ],
  });
  // what fr found about the hunk as a whole (a line's own finding goes under the line)
  const whole = (ctx.sig.units.get(h.key) ?? []).filter((x) => !x.at);
  if (!(hr && hf) && !quiet) rows.push(...signalRows(whole, { ...base, hunk: h.key }, { after: !hf }));
  if (hf) return rows;
  const notes = ctx.placed.has(h.key) ? [] : (ctx.notes.get(h.key) ?? []);
  if (notes.length) ctx.placed.add(h.key);
  const nb = { ...base, hunk: h.key };
  // the test's intent before its code: what it should specify, then how it does
  const intents = quiet ? [] : notes.filter((n) => n.kind === 'test').flatMap((n) => noteRows(ctx, n, nb));
  if (intents.length) rows.push(...intents.slice(whole.length ? 1 : 0), spacer(nb));

  const lines = h.lines.map(([t, s, o, n]) => ({ t, s, old: o, new: n, hunk: h.key }));
  // coverage (JaCoCo) of an added line: right after its number, apart from the marks of findings
  const cov = ctx.sig.coverage?.get(fid(f));
  const cover = cov && !cov.stale ? (l) => (l.t === '+' && COVER[cov.lines.get(l.new)]) || null : null;
  const code = codeView({ groups: [{ lines }], name: f.file, width: width - GUTTER_MARK, layout: f.status === 'A' || f.status === 'D' ? 'unified' : layout, tint, signs: !tint, segsFor: segsForFile(ctx, f), mark: cover }).map((x) => ({ ...x, ...base, kind: 'code' }));
  const nw = Math.max(3, String(Math.max(0, ...h.lines.flatMap(([, , o, n]) => [o ?? 0, n ?? 0]))).length);
  const indent = GUTTER_MARK + nw + 1;
  // side by side, a finding about a new line goes under the new side, beside its line
  const split = code.some((row) => row.segs.some(([t, st]) => t === '│' && st === 'gray'));
  const half = Math.floor((width - GUTTER_MARK - 1) / 2);
  // (an answer to the reviewer takes the whole width: it can hold a figure)
  const indentOf = (c) => (split && c.side === 'new' && c.layer !== 'questions' ? GUTTER_MARK + half + 1 + nw + 1 : indent);
  // findings and comments go below the last row of their line
  const after = new Map();
  const put = (at, item) => after.set(at, [...(after.get(at) ?? []), item]);
  for (const c of callouts) put(code.findLastIndex((row) => (c.place ? row.at?.[c.place.side] === c.place.line : row.at?.[c.side] === c.to)), { c });
  for (const x of here) {
    let at = -1;
    code.forEach((row, i) => {
      const l = row.line;
      if ((l?.side === x.loc.side && l?.n === x.loc.line) || (x.loc.side === 'old' && row.old === x.loc.line)) at = i;
    });
    put(at, { x });
  }
  // the bar at the far left: on a line something is said about, and on down through what is
  // said (its rows), so a line and its notes read as one; with the notes hidden (a) it stays
  // on the line
  const bar = (list, style) =>
    list.map((r) => {
      const [t, st, ...more] = r.segs[0] ?? ['', ''];
      return t.startsWith(' ') ? { ...r, segs: [['▌', style], [t.slice(1), st, ...more], ...r.segs.slice(1)] } : r;
    });
  const itemRows = ({ c, x }) => (c ? (quiet && !ctx.revealed(c) ? [] : bar(calloutRows(ctx, c, nb, indentOf(c)), MARK[speaker(c)])) : bar(commentRowsOf(ctx, x, nb), MARK.comment));
  const mark = (row) => {
    const who = callouts.filter((c) => covers(row, c.side, c.from, c.to)).map(speaker);
    if (here.some((x) => covers(row, x.loc.side, x.loc.line, x.loc.line))) who.push('comment');
    const top = ['agent', 'fr', 'questions', 'comment'].find((k) => who.includes(k));
    return [top ? ['▌', MARK[top]] : [' ', ''], [' ', '']];
  };
  for (const it of after.get(-1) ?? []) rows.push(...itemRows(it));
  code.forEach((row, i) => {
    rows.push({ ...row, segs: [...mark(row), ...row.segs] });
    for (const it of after.get(i) ?? []) rows.push(...itemRows(it));
  });
  if (!quiet) for (const n of notes.filter((y) => y.kind !== 'test')) rows.push(...noteRows(ctx, n, nb));
  return rows;
}

/** Hunks one after the other, an empty row between them. */
function hunksRows(ctx, items, guide = null) {
  const rows = [];
  items.forEach(({ f, h, base, note }, i) => {
    if (i) rows.push(spacer(base, guide));
    rows.push(...(h ? hunkRows(ctx, f, h, base, { note }) : [wholeFileRow(ctx, f, base), ...notesFor(ctx, f.key, base)]));
  });
  return rows;
}

/** The row of a file without hunks (a rename, a binary file), which is reviewed as a whole. */
const wholeFileRow = (ctx, f, base) => {
  const sigs = ctx.sig.units.get(f.key);
  return { kind: 'blank', ...base, units: [f.key], segs: sigs?.length ? signalSegs(sigs) : [[`  ${f.binary ? 'binary file' : f.status === 'R' ? 'renamed, content unchanged' : 'no content changes'}`, 'dim']] };
};

/** Signals (src/signals.mjs) as segments: the tool's badge, then its text. */
function signalSegs(list = [], labelWidth = 0) {
  const out = [];
  for (const s of list) {
    out.push(['  ', '']);
    out.push([` ${s.label} `, s.level === 'info' ? 'factsoft' : 'fact']);
    if (s.text) out.push([`${' '.repeat(Math.max(0, labelWidth - s.label.length))}  ${s.text}`, s.level === 'warn' ? 'yellow' : 'dim']);
  }
  return out;
}
/**
 * Signals as a block under the title they belong to: one per row, a bar down the left, an
 * empty row above, and below when more follows (`after`).
 */
const signalRows = (list = [], base = {}, { after = true } = {}) =>
  list.length ? [spacer(base), ...list.map((s) => ({ kind: 'note', ...base, callout: 'fr', about: `fr:${s.kind}`, ...(s.pair ? { pair: s.pair } : {}), segs: [['  ', ''], ['┃', 'factbar'], ...signalSegs([s], Math.max(...list.map((x) => x.label.length)))] })), ...(after ? [spacer(base)] : [])] : [];
/** A file's signals under its title: done with once the file is reviewed and folded. */
function fileSignalRows(ctx, f, { folded, units = unitsOf(f), base = {} }) {
  if (ctx.quiet || (folded && units.every(ctx.marked))) return [];
  return signalRows(ctx.sig.files.get(fid(f)), { repo: f.repo, fid: fid(f), ...base }, { after: !folded });
}

/** A file's title row: status, path, size, uncommitted, reviewed. */
function fileTitle(ctx, f, { folded, units = unitsOf(f), base = {} }) {
  const fd = units.filter(ctx.marked).length;
  const reviewed = fd === units.length;
  const mech = !reviewed && units.length > 0 && units.every((u) => ctx.sig.mechanical.has(u));
  const st2 = STATUS[f.status];
  const n = ctx.comments.filter((x) => x.loc?.file === f).length;
  return {
    kind: 'file',
    repo: f.repo,
    fid: fid(f),
    ...base,
    units,
    folded,
    segs: [
      [folded ? '▸ ' : '▾ ', 'dim'],
      [st2[0], st2[1]],
      ['  ', ''],
      ...(ctx.lens === 'groups' ? [[`${f.repo}/`, 'dim']] : []),
      ...(f.status === 'R' ? [[f.old, 'dim'], [' → ', 'dim']] : []),
      [f.file, reviewed ? 'dim' : 'bold'],
      ['   ', ''],
      ...(f.binary ? [['binary  ', 'dim']] : []),
      ...(f.add ? [[`+${f.add} `, 'addfg']] : []),
      ...(f.del ? [[`−${f.del} `, 'delfg']] : []),
      ...(f.dirty ? [['  ● uncommitted', 'yellow']] : []),
      [reviewed ? '  ✓ reviewed' : units.length > 1 ? `  ${fd}/${units.length}` : '', reviewed ? 'green' : 'dim'],
      ...(mech && folded ? [['  ', ''], [' MECHANICAL ', 'fact'], [` verified: ${[...new Set(units.flatMap((u) => ctx.sig.units.get(u) ?? []).filter((s) => s.level === 'fact').map((s) => [s.label.toLowerCase(), s.kind === 'moved' ? s.text : ''].join(' ').trim()))].join(', ')}`, 'dim']] : []),
      ...(folded ? findingCount(ctx, units) : []),
      ...(folded && n ? [[`  ${plural(n, 'comment')}`, 'magenta']] : []),
      ...(folded && noteCount(ctx, units) ? [[`  ${hideNotes(ctx, units)}`, 'cyan']] : []),
    ],
  };
}

/** A file's comments on no line (the file, or outdated ones), once per view. */
function fileComments(ctx, f, base) {
  return ctx.comments.filter((x) => x.loc?.file === f && x.loc.line == null && !ctx.shown.has(x.c.id)).flatMap((x) => commentRowsOf(ctx, x, base));
}

function summary(ctx, extra = []) {
  const { ws, st, marked } = ctx;
  const all = ws.repos.flatMap((r) => r.files.flatMap(unitsOf));
  const done = all.filter(marked).length;
  const files = ws.repos.reduce((n, r) => n + r.files.length, 0);
  const add = ws.repos.reduce((n, r) => n + r.files.reduce((m, f) => m + f.add, 0), 0);
  const del = ws.repos.reduce((n, r) => n + r.files.reduce((m, f) => m + f.del, 0), 0);
  return {
    kind: 'summary',
    segs: [
      [ws.name, 'bold'],
      [`   ${plural(ws.repos.length, 'service')} · ${plural(files, 'file')} · `, 'dim'],
      [`+${add}`, 'addfg'],
      [' ', ''],
      [`−${del}`, 'delfg'],
      ['   reviewed ', 'dim'],
      [`${done}/${all.length}`, all.length && done === all.length ? 'green bold' : 'bold'],
      ...(st.comments.length ? [[`   ${plural(st.comments.length, 'comment')}`, 'magenta']] : []),
      ...extra,
    ],
  };
}

const progress = (done, n) => [`${done}/${n} reviewed`, n && done === n ? 'green bold' : ''];

/**
 * A repository's files in reading order: file order, except that a changed test comes
 * right after the code it tests (after the last of it, when it tests several).
 */
export function filesInReadingOrder(r, sig) {
  const at = new Map(r.files.map((f, i) => [fid(f), i]));
  const after = new Map(); // code file → the tests to show after it
  const moved = new Set();
  for (const f of r.files) {
    const code = (sig?.codeOfTest?.get(fid(f)) ?? []).filter((c) => at.has(c));
    if (!code.length) continue;
    const last = code.reduce((a, b) => (at.get(a) > at.get(b) ? a : b));
    after.set(last, [...(after.get(last) ?? []), f]);
    moved.add(fid(f));
  }
  const out = [];
  for (const f of r.files) {
    if (moved.has(fid(f))) continue;
    out.push(f, ...(after.get(fid(f)) ?? []));
  }
  return out;
}
const allFiles = (ws) => ws.repos.flatMap((r) => filesInReadingOrder(r, ws.signals));

/** A service's coverage reports, for its heading (only where JVM code changed). */
function coverageNote(ws, r) {
  if (!r.files.some((f) => /\.(java|kt|groovy|scala)$/.test(f.file))) return [];
  const reps = ws.signals?.reports?.get(r.name) ?? [];
  if (!reps.length) return [['no JaCoCo report: build with it for coverage', 'dim'], ['   ', '']];
  const newest = Math.max(...reps.map((x) => x.mtime));
  const h = Math.max(0, Date.now() - newest) / 3600000;
  return [[`coverage: ${plural(reps.length, 'report')}, ${h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`} old`, 'dim'], ['   ', '']];
}

function servicesLens(ctx) {
  const { ws, width, fold, marked } = ctx;
  const rows = [];
  ws.repos.forEach((r, ri) => {
    const units = r.files.flatMap(unitsOf);
    const rd = units.filter(marked).length;
    if (ri) rows.push(spacer(), spacer());
    const add = r.files.reduce((n, f) => n + f.add, 0);
    const del = r.files.reduce((n, f) => n + f.del, 0);
    rows.push({ kind: 'repo', repo: r.name, segs: band([[' ', ''], [r.name, 'bold'], ...(r.branch ? [['   ', ''], [r.branch, '']] : [])], width, BAND.repo) });
    rows.push({
      kind: 'note',
      repo: r.name,
      segs: band(
        [
          [' ', ''],
          ...(r.base ? [[`base ${r.baseRef} ${short(r.base)}${r.baseFrom === 'guess' ? ' (guessed)' : ''}`, 'dim'], ['   ', '']] : []),
          ...(r.error ? [] : [[`${plural(r.files.length, 'file')}  `, ''], [`+${add}`, 'addfg'], [' ', ''], [`−${del}`, 'delfg'], ['   ', '']]),
          ...(r.dirty ? [[`● ${r.dirty} uncommitted`, 'yellow'], ['   ', '']] : []),
          ...coverageNote(ws, r),
          ...(units.length ? [progress(rd, units.length)] : []),
        ],
        width,
        BAND.repo,
      ),
    });
    if (r.error) return void rows.push(spacer(), { kind: 'error', repo: r.name, segs: [[' ' + r.error, 'red']] });
    if (!r.files.length) return void rows.push(spacer(), { kind: 'blank', repo: r.name, segs: [[' no changes', 'dim']] });
    for (const f of filesInReadingOrder(r, ws.signals)) {
      const base = { repo: r.name, fid: fid(f) };
      const folded = isFolded(fid(f), unitsOf(f).every(ctx.settled), fold);
      rows.push(spacer());
      rows.push(fileTitle(ctx, f, { folded }), ...fileSignalRows(ctx, f, { folded }));
      if (folded) continue;
      rows.push(...fileComments(ctx, f, base));
      rows.push(...hunksRows(ctx, f.hunks.length ? f.hunks.map((h) => ({ f, h, base })) : [{ f, h: null, base }]));
    }
  });
  return rows;
}

const refText = (res, ref) => {
  if (!res?.ok) return ref?.hunk ?? `${ref?.repo ?? ref?.path ?? '?'}/${ref?.file ?? '?'}:${ref?.lines ?? '?'}`;
  return `${res.repo}/${res.file}:${res.side === 'old' ? '-' : ''}${res.from === res.to ? res.from : `${res.from}-${res.to}`}`;
};

/** Cited code that is not part of the change (unchanged lines): plain code with line numbers. */
function citedRows(ctx, res, base) {
  const lines = res.code.map((l) => ({ t: ' ', s: l.s, n: l.n }));
  return codeView({ groups: [{ lines }], name: res.file, width: ctx.width, highlight: 'builtin', tint: ctx.tint }).map((x) => ({ ...x, ...base, kind: 'cited' }));
}

/** The units in reading order for a lens: [{unit, fid, hunk (key or null), group (id or null)}]. */
export function readingOrder(ws, ann, lens) {
  const files = new Map(allFiles(ws).map((f) => [fid(f), f]));
  const byUnit = new Map();
  for (const f of files.values()) for (const u of unitsOf(f)) byUnit.set(u, f);
  const entry = (u, group) => ({ unit: u, fid: fid(byUnit.get(u)), hunk: byUnit.get(u).hunks.length ? u : null, group });
  if (lens !== 'groups' || !ann?.groups?.length) return [...byUnit.keys()].map((u) => entry(u, null));
  const out = [];
  const seen = new Set();
  for (const { g, units } of ann.groups)
    for (const u of units)
      if (!seen.has(u) && byUnit.has(u)) {
        seen.add(u);
        out.push(entry(u, g.id));
      }
  for (const u of byUnit.keys()) if (!seen.has(u)) out.push(entry(u, null));
  return out;
}

/** A group's two-row heading band: the title, then risk, signals, requested and progress. */
function groupHead(ctx, { gid, n, title, folded, units, meta, bg }) {
  const { width, marked } = ctx;
  const done = units.filter(marked).length;
  return [
    { kind: 'group', group: gid, units, folded, segs: band([[folded ? ' ▸ ' : ' ▾ ', 'dim'], ...(n ? [[`${n}  `, 'bold']] : []), [title, 'bold']], width, bg) },
    {
      kind: 'note',
      group: gid,
      units,
      segs: band([['   ', ''], ...meta, ...(meta.length ? [['     ', '']] : []), progress(done, units.length), ...(folded ? findingCount(ctx, units) : []), ...(folded && noteCount(ctx, units) ? [[`     ${hideNotes(ctx, units)}`, 'cyan']] : [])], width, bg),
    },
  ];
}

function groupsLens(ctx) {
  const { ws, width, fold, marked, ann } = ctx;
  // inside a group: the guide bar takes the first columns
  const inner = { ...ctx, width: width - GUTTER };
  const rows = [];
  const files = new Map(allFiles(ws).map((f) => [fid(f), f]));
  const fileOfUnit = new Map();
  for (const f of files.values()) for (const u of unitsOf(f)) fileOfUnit.set(u, f);
  const unitGroups = new Map();
  for (const { g, units } of ann.groups) for (const u of units) unitGroups.set(u, [...(unitGroups.get(u) ?? []), g]);

  ann.groups.forEach(({ g, parts, units }, gi) => {
    const gid = g.id ?? `#${gi + 1}`;
    const base = { group: gid };
    const guide = ACCENT.group;
    const reviewed = units.length > 0 && units.every(marked);
    // mechanical: what the tool verified (every hunk), else only what the agent claims
    const verified = units.length > 0 && units.every((u) => ctx.sig.mechanical.has(u));
    const unverified = units.filter((u) => !ctx.sig.mechanical.has(u)).length;
    const folded = isFolded(groupFoldId(gid), reviewed || Boolean(g.mechanical) || verified, fold);
    if (gi) rows.push(spacer(), spacer());
    const meta = [
      ...(g.risk ? [[` ${g.risk.toUpperCase()} `, BADGE[g.risk] ?? 'inverse']] : []),
      ...(g.risk_signals?.length ? [['  ' + g.risk_signals.join(' · '), '']] : []),
      ...(g.requested === 'no' ? [['     not requested', 'yellow bold']] : g.requested === 'unclear' ? [['     requested?', 'yellow']] : []),
      ...(verified ? [['     ', ''], [' MECHANICAL ', 'fact'], [' verified by fr', 'dim']] : g.mechanical ? [[`     claimed mechanical: ${unverified} of ${plural(units.length, 'hunk')} not verified`, 'yellow']] : []),
    ];
    rows.push(...groupHead(ctx, { gid, n: gi + 1, title: g.title ?? gid, folded, units, meta, bg: BAND.group }));
    if (folded) return;
    const body = [];
    if (g.why || g.mechanical) body.push(spacer(base));
    if (g.why) body.push(...mdRows(g.why, inner.width, base));
    if (g.mechanical) {
      if (g.why) body.push(spacer(base));
      body.push({ kind: 'note', ...base, segs: [['mechanical, the agent says:', 'yellow bold']] });
      body.push(...mdRows(g.mechanical, inner.width, base, { extra: 'yellow' }));
    }
    const shownHere = new Set();
    for (const { p, res } of parts) {
      const f = res?.ok && !res.external ? [...files.values()].find((x) => x.repo === res.repo && (res.side === 'old' ? (x.old ?? x.file) : x.file) === res.file) : null;
      const pbase = { ...base, ...(f ? { repo: f.repo, fid: fid(f) } : {}) };
      body.push(spacer(pbase));
      body.push({
        kind: 'part',
        ...pbase,
        units: res?.ok ? res.units : [],
        segs: [
          ...(p?.role ? [[` ${p.role.toUpperCase()} `, ROLE], ['  ', '']] : []),
          [refText(res, p?.ref), res?.ok ? 'bold' : 'red bold'],
          ...(res?.hunkId ? [[`  ${res.hunkId}`, 'dim']] : []),
          ...(f?.dirty ? [['  ● uncommitted', 'yellow']] : []),
        ],
      });
      if (p?.note) body.push(...mdRows(p.note, inner.width, pbase, { extra: 'dim' }));
      if (f) body.push(...fileSignalRows(ctx, f, { folded: false, base: pbase }));
      if (res && !res.ok) body.push({ kind: 'note', ...pbase, segs: [[`does not resolve: ${res.error}`, 'red']] });
      if (!res?.ok) continue;
      if (f) body.push(...fileComments(inner, f, pbase));
      if (!res.units.length) {
        body.push(...citedRows(inner, res, pbase));
        continue;
      }
      const items = [];
      for (const u of res.units) {
        const uf = fileOfUnit.get(u);
        const ubase = { ...pbase, repo: uf.repo, fid: fid(uf) };
        if (shownHere.has(u)) {
          items.push({ f: uf, h: null, base: ubase, again: true });
          continue;
        }
        shownHere.add(u);
        const others = (unitGroups.get(u) ?? []).filter((x) => x !== g).map((x) => x.id);
        items.push({ f: uf, h: uf.hunks.find((x) => x.key === u) ?? null, base: ubase, note: others.length ? `also in ${others.join(', ')}` : null });
      }
      for (const it of items.filter((x) => x.again)) body.push({ kind: 'note', ...it.base, segs: [['(shown above in this group)', 'dim']] });
      body.push(...hunksRows(inner, items.filter((x) => !x.again), null));
    }
    rows.push(...guided(body, guide));
  });

  // what no group covers, by file: never hidden
  const left = [...files.values()].map((f) => [f, unitsOf(f).filter((u) => !unitGroups.has(u))]).filter(([, us]) => us.length);
  if (left.length) {
    const units = left.flatMap(([, us]) => us);
    const folded = isFolded(groupFoldId(UNGROUPED), units.length > 0 && units.every(marked), fold);
    rows.push(spacer(), spacer());
    rows.push(...groupHead(ctx, { gid: UNGROUPED, title: 'Not grouped', folded, units, meta: [[`${plural(units.length, 'hunk')} no group explains`, '']], bg: BAND.ungrouped }));
    if (!folded) {
      const body = [];
      for (const [f, us] of left) {
        const base = { group: UNGROUPED, repo: f.repo, fid: fid(f) };
        const ff = isFolded(fid(f), us.every(ctx.settled), fold);
        body.push(spacer(base));
        body.push(fileTitle(inner, f, { folded: ff, units: us, base: { group: UNGROUPED } }), ...fileSignalRows(ctx, f, { folded: ff, units: us, base }));
        if (ff) continue;
        body.push(...fileComments(inner, f, base));
        body.push(...hunksRows(inner, us.map((u) => ({ f, h: f.hunks.find((x) => x.key === u) ?? null, base }))));
      }
      rows.push(...guided(body, ACCENT.ungrouped));
    }
  }
  return rows;
}

/**
 * All rows. opts: width, layout ('auto'|'split'|'unified'), fold (Map id → bool: an
 * explicit fold or unfold; ids are fid, hunk keys, groupFoldId()), hl (highlightFiles()),
 * lens ('services'|'groups'), ann (checkAnnotations() plus {ann}: for the groups lens),
 * show ({agent, fr, coverage, comments}: false hides that kind of marker, notes and marks),
 * quiet (what sits in and around the code hidden: findings in the diff, fr's blocks, test
 * intents, notes under hunks; their gutter marks stay. The intent, a group's why and a
 * part's note stay: they are above the code, not in it).
 */
export function buildRows(ws, st, { width = 120, layout = 'auto', fold = new Map(), hl = new Map(), tint = true, lens = 'services', ann = null, quiet = false, show = {}, reveal = new Set() } = {}) {
  if (lens === 'groups' && !ann?.groups?.length) lens = 'services';
  const ctx = context(ws, st, { width, layout, fold, hl, tint, lens, ann, quiet, show, reveal });
  const body = lens === 'groups' ? groupsLens(ctx) : servicesLens(ctx);
  // notes on no hunk, or under a hunk this view does not show: never lost
  const rest = [...ctx.notes].filter(([u]) => !ctx.placed.has(u)).flatMap(([, list]) => list);
  if (rest.length) {
    body.push(spacer(), spacer(), ...groupHead(ctx, { gid: '(other notes)', title: 'Other notes', folded: false, units: [], meta: [[`${plural(rest.length, 'note')} not shown under a hunk above`, '']], bg: BAND.ungrouped }));
    for (const n of rest) body.push(...noteRows(ctx, n, { group: '(other notes)' }));
  }
  const top = [summary(ctx, lens === 'groups' ? [[`   ${plural(ann.groups.length, 'group')}`, 'cyan']] : [])];
  if (ann?.errors?.length) top.push({ kind: 'note', segs: [[`the annotations have ${plural(ann.errors.length, 'error')}: fr check lists them`, 'red']] });
  for (const s of ann?.stale ?? []) top.push({ kind: 'note', segs: [[`annotations may be stale: ${s}`, 'yellow']] });
  // comments shown nowhere below: their file is gone from the change
  for (const x of ctx.comments.filter((y) => !ctx.shown.has(y.c.id) && !y.loc)) top.push(...commentRows(x.c, { gone: true }, width, { kind: 'comment', comment: x.c.id }));
  // what the feature is for (Markdown), in either lens
  if (ann?.ann?.intent) {
    top.push(spacer(), spacer(), { kind: 'note', segs: [['Intent', 'bold']] });
    top.push(...mdRows(ann.ann.intent, width - 2, {}).map((r) => ({ ...r, segs: [['  ', ''], ...r.segs] })));
  }
  // how the change works as a whole (Markdown, figures welcome): before any code
  if (ann?.ann?.overview && ctx.show.agent) {
    top.push(spacer(), spacer(), { kind: 'note', about: 'agent:overview', segs: [['How it works', 'bold']] });
    top.push(...mdRows(ann.ann.overview, width - 2, {}).map((r) => ({ ...r, about: 'agent:overview', segs: [['  ', ''], ...r.segs] })));
  }
  top.push(spacer(), spacer());
  return [...top, ...body];
}
