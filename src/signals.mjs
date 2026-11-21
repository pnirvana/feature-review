// Cheap objective signals (discovery §4, §9, §12 step 3): facts the tool checks itself,
// apart from what the agent says. Only git is needed.
//
// - Verified mechanical: a hunk that only changes whitespace, code moved unchanged
//   (here or in another file or service), a file renamed with its content unchanged.
// - Tests and code: each changed source file is paired with its tests by name (FooTest,
//   FooSpec, test_foo, …); a change to code without one to its test is noted, and so is
//   an existing test changed in the same change as its code ("made to match the code?").
import path from 'node:path';
import { git } from './workspace.mjs';
import { unitIds } from './annotations.mjs';

// ---------- mechanical ----------

/** Files where indentation is meaning (Python, YAML, Makefiles): a change of it is not whitespace only. */
const INDENT_MATTERS = /\.(py|ya?ml|mk|haml|pug|slim|coffee|nim)$|(^|\/)(Makefile|GNUmakefile)$/i;
const MIN_MOVED_CHARS = 20; // a moved block needs this many letters or digits (as git's --color-moved)
const GRAM = 3; // consecutive lines that must match elsewhere for a line to count as moved

/** Do a hunk's removed and added lines differ only in whitespace? (blank lines ignored) */
export function whitespaceOnly(lines, file) {
  const del = lines.filter(([t]) => t === '-').map(([, s]) => s);
  const add = lines.filter(([t]) => t === '+').map(([, s]) => s);
  if (!del.length && !add.length) return false;
  if (INDENT_MATTERS.test(file)) {
    // per line: the same indentation and the same words
    const norm = (xs) => xs.filter((s) => s.trim()).map((s) => `${s.match(/^\s*/)[0].replace(/\t/g, '    ').length}:${s.trim().split(/\s+/).join(' ')}`);
    return norm(del).join('\n') === norm(add).join('\n');
  }
  // the same words in the same order: re-indented, re-wrapped, spaces changed
  const words = (xs) => xs.join('\n').split(/\s+/).filter(Boolean).join(' ');
  return words(del) === words(add);
}

const significant = (s) => /[\p{L}\p{N}]/u.test(s);
const normLine = (s) => s.trim().replace(/\s+/g, ' ');
const alnum = (xs) => xs.reduce((n, s) => n + (s.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0);

/**
 * The runs of a hunk: maximal blocks of removed or of added lines, each as its significant
 * lines (a line of only punctuation, `}`, is left out; it needs no proof).
 */
function runs(h) {
  const out = [];
  let cur = null;
  h.lines.forEach(([t, s], i) => {
    if (t === ' ') return void (cur = null);
    if (!cur || cur.t !== t) out.push((cur = { t, lines: [] }));
    if (significant(s)) cur.lines.push({ i, s: normLine(s) });
  });
  return out.filter((r) => r.lines.length);
}

/**
 * Moved code across the whole change: a removed line is moved when it is part of GRAM
 * consecutive lines added somewhere (and the other way round); a shorter block must be
 * found whole. → Map hunk key → {moved: lines moved, of: significant lines changed, with: Set of hunk keys}
 */
function movedLines(hunks) {
  const all = hunks.flatMap(({ h }) => runs(h).map((r) => ({ ...r, key: h.key })));
  const grams = { '+': new Map(), '-': new Map() }; // side → gram → Set of hunk keys
  const whole = { '+': [], '-': [] }; // side → [{text, key}] for short blocks
  for (const r of all) {
    const ls = r.lines.map((l) => l.s);
    whole[r.t].push({ text: `\n${ls.join('\n')}\n`, key: r.key });
    for (let i = 0; i + GRAM <= ls.length; i++) {
      const g = ls.slice(i, i + GRAM).join('\n');
      if (!grams[r.t].has(g)) grams[r.t].set(g, new Set());
      grams[r.t].get(g).add(r.key);
    }
  }
  // each side's blocks as one text, to find a short block with one search
  const joined = {};
  for (const t of ['+', '-']) {
    let text = '';
    const starts = [];
    for (const w of whole[t]) {
      starts.push([text.length, w.key]);
      text += w.text;
    }
    joined[t] = { text, starts };
  }
  const blockAt = (t, pos) => {
    const st = joined[t].starts;
    let lo = 0;
    let hi = st.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (st[mid][0] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return st[lo]?.[1];
  };
  const out = new Map();
  for (const r of all) {
    const other = r.t === '-' ? '+' : '-';
    const ls = r.lines.map((l) => l.s);
    const covered = new Array(ls.length).fill(false);
    const with_ = new Set();
    if (ls.length < GRAM) {
      const text = `\n${ls.join('\n')}\n`;
      // blocks end in \n and start with \n: a match never spans two of them
      const at = alnum(ls) >= MIN_MOVED_CHARS ? joined[other].text.indexOf(text) : -1;
      if (at >= 0) covered.fill(true), with_.add(blockAt(other, at));
    } else {
      const hits = [];
      for (let i = 0; i + GRAM <= ls.length; i++) {
        const keys = grams[other].get(ls.slice(i, i + GRAM).join('\n'));
        if (!keys) continue;
        for (let k = i; k < i + GRAM; k++) covered[k] = true;
        hits.push([i, keys]);
      }
      // a covered stretch too short to mean anything (`return x;` three times) does not count
      let a = 0;
      while (a < ls.length) {
        if (!covered[a]) {
          a++;
          continue;
        }
        let b = a;
        while (b < ls.length && covered[b]) b++;
        if (alnum(ls.slice(a, b)) < MIN_MOVED_CHARS) covered.fill(false, a, b);
        a = b;
      }
      for (const [i, keys] of hits) if (covered[i]) for (const k of keys) with_.add(k);
    }
    const o = out.get(r.key) ?? { moved: 0, of: 0, with: new Set() };
    o.moved += covered.filter(Boolean).length;
    o.of += ls.length;
    if (covered.some(Boolean)) for (const k of with_) if (k !== r.key) o.with.add(k);
    out.set(r.key, o);
  }
  return out;
}

// ---------- tests and code ----------

const CODE = /\.(java|groovy|kt|kts|scala|py|js|mjs|cjs|ts|tsx|jsx|go|rb|cs|php|rs|swift)$/i;
const TEST_DIR = /(^|\/)(src\/(test|it|integration[-_]?test|functional[-_]?test)[^/]*\/|tests?\/|__tests__\/|spec\/)/;
const TEST_NAME = [/^(.+?)(?:Tests?|IT|ITCase|IntegrationTest|Spec|Specification)$/, /^(.+?)[._](?:test|spec)$/, /^test_(.+)$/];
const stem = (file) => path.basename(file).replace(/\.[^.]+$/, '');

/** Is this a test file? → the name of what it tests (null: a test that names no subject), or undefined: not a test. */
export function testSubject(file) {
  if (!CODE.test(file)) return undefined;
  const s = stem(file);
  for (const re of TEST_NAME) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return TEST_DIR.test(file) ? null : undefined;
}
const isCode = (file) => CODE.test(file) && testSubject(file) === undefined;
const subjectKey = (s) => s.toLowerCase().replace(/[_-]/g, '');

/** Every file of a repository's working tree, tracked or not (.gitignore respected). */
async function repoFiles(r) {
  const res = await git(r.dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return res.ok ? res.out.split('\0').filter(Boolean) : [];
}

// ---------- all signals ----------

/**
 * The signals of a workspace (loadWorkspace()).
 * → {units: Map unit → [signal], files: Map "repo\0file" → [signal], mechanical: Set of units}
 * A signal is {kind, label (a badge, or null), text, level: 'fact' | 'warn' | 'info'}.
 */
export async function computeSignals(ws) {
  const units = new Map();
  const files = new Map();
  const mechanical = new Set();
  const add = (map, k, s) => map.set(k, [...(map.get(k) ?? []), s]);
  const ids = new Map(unitIds(ws).map((u) => [u.unit, u.id]));
  const repos = ws.repos.filter((r) => !r.error);

  // mechanical
  const hunks = repos.flatMap((r) => r.files.flatMap((f) => f.hunks.map((h) => ({ f, h }))));
  const moved = movedLines(hunks);
  for (const { f, h } of hunks) {
    if (whitespaceOnly(h.lines, f.file)) {
      mechanical.add(h.key);
      add(units, h.key, { kind: 'whitespace', label: 'WHITESPACE ONLY', text: '', level: 'fact' });
      continue;
    }
    const m = moved.get(h.key);
    if (!m?.moved) continue;
    const dir = h.lines.some(([t]) => t === '+') ? (h.lines.some(([t]) => t === '-') ? 'from/to' : 'from') : 'to';
    const where = [...m.with].map((k) => ids.get(k)).filter(Boolean);
    const whereText = where.length ? ` ${dir} ${where.slice(0, 3).join(', ')}${where.length > 3 ? ', …' : ''}` : ' within this hunk';
    if (m.moved === m.of) {
      mechanical.add(h.key);
      add(units, h.key, { kind: 'moved', label: 'MOVED', text: whereText.trim(), level: 'fact' });
    } else add(units, h.key, { kind: 'partly-moved', label: null, text: `${m.moved} of ${m.of} changed lines moved${whereText}`, level: 'info' });
  }
  for (const r of repos)
    for (const f of r.files)
      if (!f.hunks.length && f.status === 'R' && !f.binary) {
        mechanical.add(f.key);
        add(units, f.key, { kind: 'renamed', label: 'RENAMED ONLY', text: 'content unchanged', level: 'fact' });
      }

  // tests and code, per repository (a test lives with its code)
  await Promise.all(
    repos.map(async (r) => {
      const changed = new Map(r.files.map((f) => [f.file, f]));
      const all = new Set([...(await repoFiles(r)), ...changed.keys()]);
      const testsOf = new Map(); // subject key → [file]
      for (const p of all) {
        const s = testSubject(p);
        if (s) testsOf.set(subjectKey(s), [...(testsOf.get(subjectKey(s)) ?? []), p]);
      }
      const codeChanged = new Map(); // subject key → [changed code file]
      for (const f of r.files) if (isCode(f.file) && f.status !== 'D') codeChanged.set(subjectKey(stem(f.file)), [...(codeChanged.get(subjectKey(stem(f.file))) ?? []), f]);
      const fk = (f) => `${f.repo}\0${f.file}`;

      for (const f of r.files) {
        if (!isCode(f.file) || f.status === 'D') continue;
        const us = f.hunks.length ? f.hunks.map((h) => h.key) : [f.key];
        if (us.every((u) => mechanical.has(u))) continue; // nothing a test would catch
        const tests = testsOf.get(subjectKey(stem(f.file))) ?? [];
        const touched = tests.filter((t) => changed.has(t));
        const names = (xs) => xs.map((t) => path.basename(t)).join(', ');
        if (!tests.length) add(files, fk(f), { kind: 'no-test', label: null, text: 'no test found', level: 'info' });
        else if (!touched.length) add(files, fk(f), { kind: 'test-unchanged', label: null, text: `its test not changed: ${names(tests)}`, level: 'warn' });
        else add(files, fk(f), { kind: 'test-changed', label: null, text: `test changed: ${names(touched)}`, level: 'info' });
      }

      for (const t of r.files) {
        const s = testSubject(t.file);
        if (!s) continue;
        const code = codeChanged.get(subjectKey(s)) ?? [];
        if (t.status === 'D') {
          add(files, fk(t), { kind: 'test-deleted', label: 'TEST DELETED', text: code.length ? `${code.map((f) => path.basename(f.file)).join(', ')} changes too` : '', level: 'warn' });
          continue;
        }
        if (code.length) add(files, fk(t), { kind: 'tests', label: null, text: `tests ${code.map((f) => path.basename(f.file)).join(', ')} (changed too)`, level: 'info' });
        if (!code.length) continue;
        // an existing test's lines changed or removed, with its code: the expected values may have been made to fit
        for (const h of t.hunks)
          if (h.lines.some(([x, line]) => x === '-' && significant(line)) && !mechanical.has(h.key))
            add(units, h.key, { kind: 'test-with-code', label: 'EXISTING TEST CHANGED', text: `with its code (${code.map((f) => path.basename(f.file)).join(', ')}): which side is right?`, level: 'warn' });
      }
    }),
  );
  return { units, files, mechanical };
}
