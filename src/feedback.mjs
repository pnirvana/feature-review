// The feedback key (discovery §11): while reviewing, the reader records at the cursor that
// what is there helped, that something is missing there, or that it is wrong, with an
// optional note. Read back after a few weeks (`fr feedback`), it says which annotations
// and signals earn their place, which are noise, and what no one flags yet.
//
// One log for every feature reviewed on this machine, not one per feature: the point is
// to read across features, and a feature's directory goes away when it is merged. Each
// entry keeps what was on screen (its text), so it reads without the worktrees.
// $XDG_STATE_HOME/feature-review/feedback.jsonl (default ~/.local/state/…), one JSON
// object per line, appended (two viewers never overwrite each other).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERDICTS = ['helped', 'missing', 'wrong'];

export const feedbackPath = (env = process.env, file = '') => file || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'feature-review', 'feedback.jsonl');

/** Append an entry: {verdict, note?, feature, repo?, file?, line?, hunk?, about, text, quote?, coverage?}. */
export function recordFeedback(file, entry) {
  if (!VERDICTS.includes(entry.verdict)) throw new Error(`feedback: ${entry.verdict}: use ${VERDICTS.join(', ')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const e = { v: 1, at: new Date().toISOString(), ...entry };
  fs.appendFileSync(file, JSON.stringify(e) + '\n');
  return e;
}

/** → {entries, bad: number of unreadable lines}. A missing log: none. */
export function readFeedback(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { entries: [], bad: 0 };
    throw e;
  }
  const entries = [];
  let bad = 0;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      const e = JSON.parse(l);
      if (e && VERDICTS.includes(e.verdict)) entries.push(e);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { entries, bad };
}

/** "2w", "10d", "36h", or a date → the earliest time (ms) wanted. */
export function parseSince(s, now = Date.now()) {
  const m = String(s).trim().match(/^(\d+)\s*([hdw])$/i);
  if (m) return now - Number(m[1]) * { h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2].toLowerCase()];
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`--since ${s}: use e.g. 2w, 10d, 36h or a date`);
  return t;
}

/**
 * The entries counted by what they were about (the kind of annotation or signal), most
 * entries first. → [{about, helped, missing, wrong, n, entries}]
 */
export function summarize(entries) {
  const by = new Map();
  for (const e of entries) {
    const k = e.about || '?';
    const s = by.get(k) ?? { about: k, helped: 0, missing: 0, wrong: 0, n: 0, entries: [] };
    s[e.verdict]++;
    s.n++;
    s.entries.push(e);
    by.set(k, s);
  }
  return [...by.values()].sort((a, b) => b.n - a.n || a.about.localeCompare(b.about));
}

/** The kind of thing a row of the review shows, for counting feedback by it. */
export function aboutRow(r) {
  if (!r) return '?';
  if (r.about) return r.about;
  if (r.kind === 'note') return r.group ? 'agent:group' : 'agent:note';
  return { group: 'agent:group', part: 'agent:part', summary: 'summary', comment: 'comment', code: 'code', cited: 'code:cited', file: 'file', hunk: 'hunk', repo: 'service' }[r.kind] ?? r.kind;
}

/** The report `fr feedback` prints. */
export function feedbackReport(entries, { bad = 0, file = '' } = {}) {
  if (!entries.length) return `no feedback yet${file ? ` (${file})` : ''}: in the viewer, ! at the cursor records helped, missing or wrong`;
  const out = [];
  const list = summarize(entries);
  const w = Math.max(5, ...list.map((s) => s.about.length));
  const features = new Set(entries.map((e) => e.feature)).size;
  const first = entries.map((e) => e.at).sort()[0]?.slice(0, 10);
  out.push(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} on ${features} feature${features === 1 ? '' : 's'} since ${first}${bad ? `  (${bad} unreadable line${bad === 1 ? '' : 's'} skipped)` : ''}`, '');
  out.push(`${'about'.padEnd(w)}  helped  missing  wrong`);
  for (const s of list) out.push(`${s.about.padEnd(w)}  ${String(s.helped || '·').padStart(6)}  ${String(s.missing || '·').padStart(7)}  ${String(s.wrong || '·').padStart(5)}`);
  // what to act on: the wrong and the missing, with what was on screen and the note
  for (const verdict of ['wrong', 'missing', 'helped']) {
    const es = entries.filter((e) => e.verdict === verdict);
    if (!es.length) continue;
    out.push('', `${verdict.toUpperCase()} (${es.length})`);
    for (const e of es) {
      const loc = [e.repo, e.file && `${e.file}${e.line ? `:${e.line.side === 'old' ? '-' : '+'}${e.line.n}` : ''}`].filter(Boolean).join('/');
      out.push(`  ${e.at.slice(0, 10)}  ${e.about}  ${path.basename(e.feature ?? '')}${loc ? `  ${loc}` : ''}`);
      if (e.note) out.push(`      ${e.note}`);
      const shown = String(e.text ?? '').replace(/\s+/g, ' ').trim();
      if (shown) out.push(`      │ ${shown.length > 110 ? `${shown.slice(0, 109)}…` : shown}`);
    }
  }
  return out.join('\n');
}
