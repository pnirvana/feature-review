// Review state, in <parent>/.feature-review/state.json: reviewed marks keyed by stable hunk
// key (repository, file and changed lines: a mark survives a rebase and resets when the
// hunk changes), and comments anchored to a line of a file in a repository.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './workspace.mjs';

export const statePath = (root) => path.join(root, STATE_DIR, 'state.json');

const empty = () => ({ version: 1, marks: {}, comments: [], questions: [] });

export function readState(root) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
    return { ...empty(), ...s };
  } catch (e) {
    if (e.code === 'ENOENT') return empty();
    throw new Error(`${statePath(root)}: ${e.message}`);
  }
}

/** Write atomically (a reader never sees half a file). */
export function writeState(root, st) {
  const p = statePath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

/** Read, change, write: the file is re-read first so two viewers do not undo each other. */
export function update(root, fn) {
  const st = readState(root);
  fn(st);
  writeState(root, st);
  return st;
}

export function setMarks(st, keys, on) {
  const at = new Date().toISOString();
  for (const k of keys) {
    if (on) st.marks[k] ??= { at };
    else delete st.marks[k];
  }
}

/** A comment at {repo, file, side ('old'|'new'), line, quote, hunk} (line null: the whole file). */
export function addComment(st, at, text) {
  const c = { id: crypto.randomBytes(4).toString('hex'), ...at, text, at: new Date().toISOString() };
  st.comments.push(c);
  return c;
}

export function editComment(st, id, text) {
  const c = st.comments.find((x) => x.id === id);
  if (c) (c.text = text), (c.edited = new Date().toISOString());
  return c;
}

export function deleteComment(st, id) {
  st.comments = st.comments.filter((x) => x.id !== id);
}

/**
 * A question sent to the agent (the ask key), at {repo, file, side, line, quote, hunk,
 * group} or nowhere (the whole change): kept so it shows until the agent's answer, which
 * carries its id (`asked`), is in the annotation file.
 */
export function addQuestion(st, id, at, question) {
  const q = { id, ...at, question, at: new Date().toISOString() };
  (st.questions ??= []).push(q);
  return q;
}

/** The questions with no answer in the annotations yet (ann: the annotation file's object). */
export function pendingQuestions(st, ann) {
  const answered = new Set((Array.isArray(ann?.explanations) ? ann.explanations : []).map((e) => e?.asked).filter(Boolean));
  return (st?.questions ?? []).filter((q) => !answered.has(q.id));
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Where a comment is now. The line it was made on if its text is unchanged, else the
 * nearest line of the same file and side with that text, else the file (outdated), else
 * nowhere (the file is no longer in the change). → {file, side, line, outdated} | null.
 */
export function locate(c, ws) {
  const repo = ws.repos.find((r) => r.name === c.repo);
  const f = repo?.files.find((x) => x.file === c.file);
  if (!f) return null;
  if (c.line == null) return { file: f, side: null, line: null, outdated: false };
  const lines = f.hunks.flatMap((h) => h.lines.map(([t, s, o, n]) => ({ t, s, o, n })));
  const on = (l) => (c.side === 'old' ? l.o : l.n);
  const exact = lines.find((l) => on(l) === c.line && (c.quote == null || norm(l.s) === norm(c.quote)));
  if (exact) return { file: f, side: c.side, line: c.line, outdated: false };
  if (c.quote != null) {
    const same = lines.filter((l) => on(l) != null && norm(l.s) === norm(c.quote)).sort((a, b) => Math.abs(on(a) - c.line) - Math.abs(on(b) - c.line))[0];
    if (same) return { file: f, side: c.side, line: on(same), outdated: false, moved: true };
  }
  return { file: f, side: null, line: null, outdated: true };
}
