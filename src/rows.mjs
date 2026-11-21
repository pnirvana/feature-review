// The review as rows for a terminal: a summary, one heading per repository (the
// per-service map), each file with its hunks as diffview-style code views, and comments
// below the lines they point at. Shared by the viewer and `fr --print`.
//
// A row is {segs, kind, ...}: kind 'summary' | 'repo' | 'file' | 'hunk' (a hunk's title)
// | 'code' | 'comment' | 'blank' | 'error'. Rows inside a file carry fid (repo\0file);
// code rows carry hunk (its key) and line ({side, n}); comment rows carry comment (id).
import os from 'node:os';
import path from 'node:path';
import { codeView } from './md/render.mjs';
import { highlightAsync } from './md/highlight.mjs';
import { plain, segsWidth, untab, wrapSegs } from './md/term.mjs';
import { fileTexts } from './workspace.mjs';
import { locate } from './state.mjs';

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

/**
 * All rows. opts: width, layout ('auto'|'split'|'unified'), fold (Map id → bool: an
 * explicit fold or unfold; ids are fid or hunk keys), hl (highlightFiles()).
 */
export function buildRows(ws, st, { width = 120, layout = 'auto', fold = new Map(), hl = new Map(), tint = true } = {}) {
  const rows = [];
  const marked = (k) => Boolean(st.marks[k]);
  const all = ws.repos.flatMap((r) => r.files.flatMap(unitsOf));
  const done = all.filter(marked).length;
  const files = ws.repos.reduce((n, r) => n + r.files.length, 0);
  const add = ws.repos.reduce((n, r) => n + r.files.reduce((m, f) => m + f.add, 0), 0);
  const del = ws.repos.reduce((n, r) => n + r.files.reduce((m, f) => m + f.del, 0), 0);
  const comments = st.comments.map((c) => ({ c, loc: locate(c, ws) }));
  const gone = comments.filter((x) => !x.loc);

  rows.push({
    kind: 'summary',
    segs: [
      [ws.name, 'bold'],
      [`  ${plural(ws.repos.length, 'service')} · ${plural(files, 'file')} · `, 'dim'],
      [`+${add}`, 'addfg'],
      [' ', ''],
      [`−${del}`, 'delfg'],
      ['  reviewed ', 'dim'],
      [`${done}/${all.length}`, all.length && done === all.length ? 'green bold' : 'bold'],
      ...(st.comments.length ? [[`  ${plural(st.comments.length, 'comment')}`, 'magenta']] : []),
    ],
  });
  for (const { c } of gone) rows.push(...commentRows(c, { gone: true }, width, { kind: 'comment', comment: c.id }));
  rows.push({ kind: 'blank', segs: [] });

  for (const r of ws.repos) {
    const units = r.files.flatMap(unitsOf);
    const rd = units.filter(marked).length;
    const head = [
      ['━━ ', 'cyan bold'],
      [r.name, 'cyan bold'],
      [' ', ''],
      ...(r.branch ? [[r.branch, 'cyan'], [' ', '']] : []),
      ...(r.base ? [[`base ${r.baseRef} ${short(r.base)}${r.baseFrom === 'guess' ? ' (guessed)' : ''}`, 'dim'], [' ', '']] : []),
      ...(r.error ? [] : [[`${plural(r.files.length, 'file')} `, ''], [`+${r.files.reduce((n, f) => n + f.add, 0)}`, 'addfg'], [' ', ''], [`−${r.files.reduce((n, f) => n + f.del, 0)}`, 'delfg'], [' ', '']]),
      ...(r.dirty ? [[`● ${r.dirty} uncommitted`, 'yellow'], [' ', '']] : []),
      ...(units.length ? [[`${rd}/${units.length}`, rd === units.length ? 'green' : ''], [' ', '']] : []),
    ];
    rows.push({ kind: 'repo', repo: r.name, segs: [...head, ['━'.repeat(Math.max(0, width - segsWidth(head))), 'cyan']] });
    if (r.error) {
      rows.push({ kind: 'error', repo: r.name, segs: [['   ' + r.error, 'red']] }, { kind: 'blank', segs: [] });
      continue;
    }
    if (!r.files.length) rows.push({ kind: 'blank', repo: r.name, segs: [['   no changes', 'dim']] });

    for (const f of r.files) {
      const id = fid(f);
      const us = unitsOf(f);
      const fd = us.filter(marked).length;
      const reviewed = fd === us.length;
      const folded = isFolded(id, reviewed, fold);
      const base = { repo: r.name, fid: id };
      const st2 = { A: ['A', 'addfg bold'], D: ['D', 'delfg bold'], R: ['R', 'yellow bold'], M: ['M', 'blue bold'] }[f.status];
      const fileComments = comments.filter((x) => x.loc?.file === f);
      rows.push({
        kind: 'file',
        ...base,
        units: us,
        segs: [
          [folded ? '▸ ' : '▾ ', 'dim'],
          [st2[0], st2[1]],
          [' ', ''],
          ...(f.status === 'R' ? [[f.old, 'dim'], [' → ', 'dim']] : []),
          [f.file, reviewed ? 'dim' : 'bold'],
          ['  ', ''],
          ...(f.binary ? [['binary  ', 'dim']] : []),
          ...(f.add ? [[`+${f.add} `, 'addfg']] : []),
          ...(f.del ? [[`−${f.del} `, 'delfg']] : []),
          ...(f.dirty ? [[' ● uncommitted', 'yellow']] : []),
          [reviewed ? '  ✓ reviewed' : us.length > 1 ? `  ${fd}/${us.length}` : '', reviewed ? 'green' : 'dim'],
          ...(folded && fileComments.length ? [[`  ${plural(fileComments.length, 'comment')}`, 'magenta']] : []),
        ],
      });
      if (folded) continue;
      for (const x of fileComments.filter((x) => x.loc.line == null)) rows.push(...commentRows(x.c, x.loc, width, { ...base, kind: 'comment', comment: x.c.id }));
      if (!f.hunks.length) {
        rows.push({ kind: 'blank', ...base, segs: [[`    ${f.binary ? 'binary file' : f.status === 'R' ? 'renamed, content unchanged' : 'no content changes'}`, 'dim']] });
        rows.push({ kind: 'blank', segs: [] });
        continue;
      }
      const h2 = hl.get(id);
      // highlighted text is used only where it is the diff's text (the file may have changed since)
      const segsFor = h2
        ? (l) => {
            const segs = l.t === '-' ? h2.old[l.old - 1] : h2.new[l.new - 1];
            return segs && plain(segs) === untab(l.s) ? segs : null;
          }
        : () => null; // not highlighted (yet): plain, never codeView's own (synchronous) highlighting
      for (const h of f.hunks) {
        const hr = marked(h.key);
        const hf = isFolded(h.key, hr, fold);
        const here = fileComments.filter((x) => x.loc.line != null && h.lines.some(([t, , o, n]) => (x.loc.side === 'old' ? o : n) === x.loc.line));
        rows.push({
          kind: 'hunk',
          ...base,
          hunk: h.key,
          segs: [
            [hf ? '  ▸ ' : '  ▾ ', 'dim'],
            [`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`, 'cyan'],
            ...(h.header ? [[' ' + h.header, 'dim']] : []),
            ...(hr ? [['  ✓ reviewed', 'green']] : []),
            ...(hf && here.length ? [[`  ${plural(here.length, 'comment')}`, 'magenta']] : []),
          ],
        });
        if (hf) continue;
        const lines = h.lines.map(([t, s, o, n]) => ({ t, s, old: o, new: n, hunk: h.key }));
        const code = codeView({ groups: [{ lines }], name: f.file, width, layout: f.status === 'A' || f.status === 'D' ? 'unified' : layout, tint, signs: !tint, segsFor }).map((x) => ({ ...x, ...base, kind: 'code' }));
        // comments go below the last row of their line
        const after = new Map();
        for (const x of here) {
          let at = -1;
          code.forEach((row, i) => {
            const l = row.line;
            if ((l?.side === x.loc.side && l?.n === x.loc.line) || (x.loc.side === 'old' && row.old === x.loc.line)) at = i;
          });
          if (!after.has(at)) after.set(at, []);
          after.get(at).push(x);
        }
        for (const x of after.get(-1) ?? []) rows.push(...commentRows(x.c, x.loc, width, { ...base, kind: 'comment', comment: x.c.id, hunk: h.key }));
        code.forEach((row, i) => {
          rows.push(row);
          for (const x of after.get(i) ?? []) rows.push(...commentRows(x.c, x.loc, width, { ...base, kind: 'comment', comment: x.c.id, hunk: h.key }));
        });
      }
      rows.push({ kind: 'blank', segs: [] });
    }
  }
  return rows;
}
