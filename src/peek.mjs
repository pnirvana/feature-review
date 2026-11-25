// Peek (p): the code an annotation points at, in a pane over the lower part of the screen,
// so the reviewer reads it where they are and goes back to exactly that place.
//
// What a row points at, in order: the citations of the annotation it belongs to (its
// `src`, structured refs, as fr check resolved them), then files named in its prose
// (`path/File.java:12`, `File.java`), then types and members named in backticks
// (`RefundService.refund`), found by their declaration with git grep. The last two are
// guesses and say so ("named in the text", "found by name").
import fs from 'node:fs';
import path from 'node:path';
import { isRef } from './annotations.mjs';
import { git } from './workspace.mjs';
import { codeView } from './md/render.mjs';
import { pad, segsWidth } from './md/term.mjs';

/** Every citation inside an annotation item, in the order written. */
export function refsIn(x, out = []) {
  if (Array.isArray(x)) for (const y of x) refsIn(y, out);
  else if (x && typeof x === 'object') {
    if (isRef(x)) out.push(x);
    else for (const [k, v] of Object.entries(x)) if (k !== 'written') refsIn(v, out);
  }
  return out;
}

/** Every string inside an annotation item (its prose). */
function textsIn(x, out = []) {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) for (const y of x) textsIn(y, out);
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) if (k !== 'written' && !isRef(v)) textsIn(v, out);
  return out;
}

// a path with an extension, optionally :lines (src/main/java/X.java:12-20, X.java, values.yaml)
const PATH = /(?<![\w/.@:-])((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z][\w]*)(?::(\d+)(?:-(\d+))?)?(?![\w/])/g;
// a type, or a type's member, in backticks: `RefundService`, `RefundService.refund()`;
// in plain prose, Type.member and types of two words or more (RefundService, IdempotencyKey):
// kept only where a declaration is found
const SYMBOL = /`([A-Z][A-Za-z0-9_]*)(?:[.#]([a-z_][A-Za-z0-9_]*))?(?:\(\))?`/g;
const MEMBER = /(?<![\w.`])([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)*)[.#]([a-z_][A-Za-z0-9_]*)\b(?![.\w])/g;
const TYPE = /(?<![\w.`])([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b(?![.\w`])/g;
// a method or field in backticks: `refundable`, `ledger.book`, `order.paid()` (the member: book, paid)
const MEMBER_TICK = /`(?:[a-z_][A-Za-z0-9_]*\.)?([a-z_][A-Za-z0-9_]*)(?:\([^`]*\))?`/g;
const NOT_MEMBER = new Set('this null true false return new if else for while key value id it self var val let const void int long boolean string list map set get set put add of to from and or not'.split(' '));
// files fr looks for: source, build and deployment files (not Type.member)
const EXT = /\.(java|groovy|kts?|scala|py|go|tsx?|jsx?|mjs|rb|cs|xml|ya?ml|json|properties|gradle|sql|toml|conf|sh|tf|j2|md|txt|html|css|proto|avsc|graphql|feature)$/;
const COMMON = new Set('String Integer Long Short Byte Double Float Boolean Character Object Class Void List Map Set Collection Optional Stream Iterable Iterator Exception RuntimeException Error Thread Runnable Callable BigDecimal BigInteger Instant Duration LocalDate LocalDateTime UUID Math System Arrays Collections Objects True False None JSON HTTP REST API SQL'.split(' '));

/** What the prose of an item names: paths ({file, from, to}) and symbols ({type, member}). */
export function mentionsIn(x) {
  const paths = [];
  const symbols = [];
  for (const t of textsIn(x)) {
    for (const m of t.matchAll(PATH)) {
      if (/^\d/.test(m[1]) || !EXT.test(m[1])) continue;
      paths.push({ file: m[1], from: m[2] ? Number(m[2]) : null, to: m[3] ? Number(m[3]) : m[2] ? Number(m[2]) : null });
    }
    for (const re of [SYMBOL, MEMBER, TYPE]) for (const m of t.matchAll(re)) if (!COMMON.has(m[1]) && m[1].length > 2) symbols.push({ type: m[1], member: m[2] ?? null });
    for (const m of t.matchAll(MEMBER_TICK)) if (!NOT_MEMBER.has(m[1]) && m[1].length > 2) symbols.push({ type: null, member: m[1] });
  }
  // once each; a type named with a member too is the member
  const seen = new Set();
  const once = symbols.filter((s) => {
    const k = `${s.type}.${s.member ?? ''}`;
    if (seen.has(k) || (!s.member && symbols.some((x) => x.type === s.type && x.member))) return false;
    // a member named alone, when it is also named with its type: that one
    if (!s.type && symbols.some((x) => x.type && x.member === s.member)) return false;
    seen.add(k);
    return true;
  });
  // a file name is not a type (Util.java)
  return { paths, symbols: once.filter((s) => !/^(java|groovy|kt|py|ts|js|go|yaml|yml|xml|json|md|properties|gradle)$/.test(s.member ?? '')) };
}

const readSide = async (dir, rev, file) => {
  if (rev == null) {
    try {
      return fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      return null;
    }
  }
  const r = await git(dir, ['show', `${rev}:${file}`]);
  return r.ok ? r.out : null;
};
const linesOf = (t) => (t == null ? null : t.replace(/\n$/, '').split('\n'));

/**
 * The places an item points at → [target]. target: {repo, dir, file, side, rev (null: the
 * working tree), from, to (null: the file as a whole), units (its hunks in the change),
 * external, how: 'cited' | 'named' | 'found', error?}. refs: the item's citations (with
 * `checked.refs` resolving them); first: a citation to start on; names: false leaves out
 * the declarations found by name (git grep: the slow part on a large repository).
 */
export async function targetsFor(ws, checked, src, { first = null, names = true, row = null } = {}) {
  const out = [];
  const seen = new Set();
  const add = (t, onRow = false) => {
    const k = `${t.repo}|${t.file}|${t.side}|${t.from ?? ''}`;
    if (seen.has(k)) return;
    // a mention of a file already cited adds nothing (unless the reader points at it)
    if (!onRow && t.how !== 'cited' && out.some((x) => x.repo === t.repo && x.file === t.file && x.side === t.side && (t.from == null || (x.from != null && t.from >= x.from && t.from <= x.to)))) return;
    seen.add(k);
    out.push(onRow ? { ...t, row: true } : t);
  };
  // what the row under the cursor names comes first, in the order it stands there: the
  // reader points at it (a row has no column: the list in the pane lets them pick)
  if (row) {
    // the row is rendered text (no backticks): its paths as written, its names those of the
    // note's source that show on it; row: the row's text, or variants of it (a wrapped path)
    const variants = [].concat(row);
    const at = (w) => {
      if (!w) return -1;
      // a word on its own: not part of a path or a longer name (refund of refund-service)
      const re = new RegExp(`(^|[^A-Za-z0-9_/-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_/-]|\\.\\w)`);
      const hits = variants.map((v) => { const m = re.exec(v); return m ? m.index + m[1].length : -1; }).filter((x) => x >= 0);
      return hits.length ? Math.min(...hits) : -1;
    };
    const m = mentionsIn(variants.join(' '));
    const symName = (s) => (s.type && s.member ? `${s.type}.${s.member}` : (s.member ?? s.type));
    const symPos = (s) => {
      if (s.type && s.member) for (const sep of ['.', '#']) { const x = at(`${s.type}${sep}${s.member}`); if (x >= 0) return x; }
      return at(s.member ?? s.type);
    };
    const items = [];
    const once = new Set();
    for (const p of m.paths) {
      const name = `${p.file}${p.from != null ? `:${p.from}${p.to !== p.from ? `-${p.to}` : ''}` : ''}`;
      if (once.has(name)) continue;
      once.add(name);
      items.push({ pos: Math.max(at(name), at(p.file)), name, find: () => findPath(ws, p) });
    }
    for (const s of [...m.symbols, ...mentionsIn(src).symbols]) {
      const name = symName(s);
      const pos = symPos(s);
      if (pos < 0 || once.has(name)) continue;
      once.add(name);
      items.push({ pos, name, find: () => findSymbol(ws, s) });
    }
    // a name inside a path already listed (RefundService of RefundService.java) is that path
    const inside = (a, b) => a !== b && b.name.length > a.name.length && a.pos >= b.pos && a.pos < b.pos + b.name.length;
    const kept = items.filter((a) => !items.some((b) => inside(a, b))).sort((a, b) => a.pos - b.pos).slice(0, 9);
    for (const it of kept) for (const t of await it.find()) add({ ...t, named: it.name }, true);
  }
  const refs = refsIn(src);
  if (first && !refs.includes(first)) refs.unshift(first);
  for (const ref of refs) add(fromRef(ws, checked, ref));
  const { paths, symbols } = mentionsIn(src);
  for (const p of paths.slice(0, 12)) for (const t of await findPath(ws, p)) add(t);
  if (names) for (const s of symbols.slice(0, 8)) for (const t of await findSymbol(ws, s)) add(t);
  const at = first ? out.findIndex((t) => t.ref === first) : 0;
  return { targets: out, at: Math.max(0, at) };
}

/** A structured citation as a target. */
export function fromRef(ws, checked, ref) {
  const res = checked?.refs?.get(ref);
  const label = ref.hunk ?? `${ref.repo ?? ref.path ?? '?'}/${ref.file}:${ref.lines}`;
  if (!res?.ok) return { ref, how: 'cited', repo: ref.repo ?? ref.path ?? '?', file: ref.file ?? ref.hunk ?? '?', side: ref.side ?? 'new', from: null, to: null, units: [], error: res?.error ?? 'not checked yet', label };
  if (res.external) {
    const dir = path.resolve(ws.root, ref.path);
    return { ref, how: 'cited', repo: res.repo, dir, file: res.file, side: res.side, rev: res.side === 'old' ? (ref.rev ?? 'HEAD') : (ref.rev ?? null), from: res.from, to: res.to, units: [], external: true };
  }
  const repo = ws.repos.find((r) => r.name === res.repo);
  return { ref, how: 'cited', repo: res.repo, dir: repo?.dir, file: res.file, side: res.side, rev: res.side === 'old' ? repo?.base : null, from: res.from, to: res.to, units: res.units ?? [] };
}

const tracked = new Map(); // repo dir → [file] (one peek session's worth; a reload starts over)
async function filesOf(repo) {
  if (!tracked.has(repo.dir)) {
    const r = await git(repo.dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    tracked.set(repo.dir, r.ok ? r.out.split('\0').filter(Boolean) : []);
  }
  return tracked.get(repo.dir);
}
export const forgetFiles = () => tracked.clear();

const inChange = (ws, repo, file) => ws.repos.find((r) => r.name === repo)?.files.find((f) => f.file === file);
const unitsAt = (f, from, to) => {
  if (!f) return [];
  if (!f.hunks.length) return [f.key];
  if (from == null) return f.hunks.map((h) => h.key);
  return f.hunks.filter((h) => h.newStart <= to && h.newStart + Math.max(1, h.newCount) - 1 >= from).map((h) => h.key);
};

/** A path named in prose: in the worktree it starts with, else wherever it ends a path. */
async function findPath(ws, p) {
  const out = [];
  const parts = p.file.split('/');
  const repos = ws.repos.filter((r) => !r.error);
  const named = repos.find((r) => r.name === parts[0] && parts.length > 1);
  const look = named ? [[named, parts.slice(1).join('/')]] : repos.map((r) => [r, p.file]);
  for (const [repo, rel] of look) {
    for (const f of await filesOf(repo)) {
      if (f !== rel && !f.endsWith(`/${rel}`)) continue;
      const cf = inChange(ws, repo.name, f);
      out.push({ how: 'named', repo: repo.name, dir: repo.dir, file: f, side: 'new', rev: null, from: p.from, to: p.to, units: cf && cf.status !== 'D' ? unitsAt(cf, p.from, p.to) : [] });
      if (out.length >= 5) return out;
    }
  }
  return out;
}

const CODE = ['*.java', '*.groovy', '*.kt', '*.scala', '*.py', '*.go', '*.ts', '*.js', '*.cs', '*.rb'];
/** A type (and member) named in backticks: its declaration, by git grep. */
async function findSymbol(ws, { type, member }) {
  if (!type) return findMember(ws, member);
  const out = [];
  for (const repo of ws.repos.filter((r) => !r.error)) {
    const r = await git(repo.dir, ['grep', '-n', '-I', '--untracked', '-E', `(^|[^A-Za-z0-9_])(class|interface|enum|record|trait|object|type)[[:space:]]+${type}([^A-Za-z0-9_]|$)`, '--', ...CODE]);
    if (!r.ok) continue;
    for (const hit of r.out.split('\n').filter(Boolean).slice(0, 3)) {
      const m = /^(.*?):(\d+):/.exec(hit);
      if (!m) continue;
      let line = Number(m[2]);
      if (member) {
        const text = linesOf(await readSide(repo.dir, null, m[1])) ?? [];
        const decl = new RegExp(`(^|[\\s.])(def\\s+|fun\\s+|func\\s+)?${member}\\s*\\(`);
        const at = text.findIndex((s, i) => i >= line - 1 && decl.test(s) && !/^\s*(return|if|while|for|else|\.|\/\/|\*)/.test(s) && !/;\s*$/.test(s) && !/[=]\s*[\w.]*\b/.test(s.split(member)[0]));
        if (at < 0) continue;
        line = at + 1;
      }
      const cf = inChange(ws, repo.name, m[1]);
      out.push({ how: 'found', repo: repo.name, dir: repo.dir, file: m[1], side: 'new', rev: null, from: line, to: line, units: cf && cf.status !== 'D' ? unitsAt(cf, line, line) : [], symbol: member ? `${type}.${member}` : type });
    }
  }
  return out;
}

// a method's or field's declaration: modifiers and a type before the name, ( or = or ; after
// (not a call: no receiver before it, not a statement, not an assignment to something else)
const declares = (name) => new RegExp(`^\\s*(?:@\\w+\\s+)*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|override|open|suspend|async|def|fun|func|val|var|let|const|readonly)\\s+)*(?:[\\w<>\\[\\],.?]+\\s+)?${name}\\s*(?:\\(|=(?!=)|;|:)`);
const NOT_DECL = /^\s*(return|if|while|for|else|switch|case|throw|new|assert|import|package|\/\/|\*|#)\b/;
/** A method or field named alone (`refundable`, the book of `ledger.book`): its declaration, by name. */
async function findMember(ws, member) {
  const out = [];
  const decl = declares(member);
  for (const repo of ws.repos.filter((r) => !r.error)) {
    const r = await git(repo.dir, ['grep', '-n', '-I', '--untracked', '-E', `(^|[^A-Za-z0-9_.])${member}[[:space:]]*[(=;:]`, '--', ...CODE]);
    if (!r.ok) continue;
    for (const hit of r.out.split('\n').filter(Boolean)) {
      const m = /^(.*?):(\d+):(.*)$/.exec(hit);
      if (!m || NOT_DECL.test(m[3]) || !decl.test(m[3])) continue;
      // a call statement (foo(x);) is not a declaration; a declaration has something before the name
      const before = m[3].split(new RegExp(`\\b${member}\\b`))[0];
      if (!before.trim() && !/^\s*(def|fun|func)\b/.test(m[3])) continue;
      if (/;\s*$/.test(m[3]) && /\(/.test(m[3]) && !/\b(abstract|interface)\b/.test(m[3])) continue;
      const line = Number(m[2]);
      const cf = inChange(ws, repo.name, m[1]);
      out.push({ how: 'found', repo: repo.name, dir: repo.dir, file: m[1], side: 'new', rev: null, from: line, to: line, units: cf && cf.status !== 'D' ? unitsAt(cf, line, line) : [], symbol: member });
      if (out.length >= 4) return out;
    }
  }
  return out;
}

/**
 * A file at a target's side as diff lines for codeView: for a file in the change, the
 * whole file with the change in it (removed lines among the others), else the file as is.
 * → {lines: [{t, s, old, new}|{t, s, n}], at: (line) → number on the target's side} | {error}
 */
export async function peekLines(ws, t) {
  if (t.error) return { error: t.error };
  if (!t.dir) return { error: `no worktree ${t.repo}` };
  const text = await readSide(t.dir, t.rev ?? null, t.file);
  const all = linesOf(text);
  if (!all) return { error: `${t.file} is not there${t.rev ? ` at ${String(t.rev).slice(0, 7)}` : ''}` };
  const f = !t.external && ws.repos.find((r) => r.name === t.repo)?.files.find((x) => (t.side === 'old' ? (x.old ?? x.file) : x.file) === t.file);
  if (!f || !f.hunks.length) return { lines: all.map((s, i) => ({ t: ' ', s, n: i + 1 })), diff: false };
  // the whole file with its hunks in place
  const lines = [];
  const side = t.side === 'old' ? 'old' : 'new';
  const num = (l) => (side === 'old' ? l[2] : l[3]);
  let pos = 1;
  let delta = 0; // old - new, between hunks
  const plainTo = (end) => {
    for (; pos <= Math.min(end, all.length); pos++) lines.push({ t: ' ', s: all[pos - 1], old: side === 'old' ? pos : pos + delta, new: side === 'new' ? pos : pos - delta });
  };
  for (const h of [...f.hunks].sort((a, b) => (side === 'old' ? a.oldStart - b.oldStart : a.newStart - b.newStart))) {
    const hl = h.lines.filter(([x]) => x === '+' || x === '-' || x === ' ');
    const firstNum = hl.map(num).find((n) => n != null) ?? (side === 'old' ? h.oldStart + 1 : h.newStart + 1);
    plainTo(firstNum - 1);
    for (const [x, s, o, n] of hl) lines.push({ t: x, s, old: o ?? null, new: n ?? null });
    const nums = hl.map(num).filter((n) => n != null);
    if (nums.length) pos = Math.max(pos, nums[nums.length - 1] + 1);
    delta += h.oldCount - h.newCount;
  }
  plainTo(all.length);
  return { lines, diff: true };
}

/** The label of a target: where, and what it is. */
export function targetText(t) {
  const where = `${t.repo}/${t.file}${t.from != null ? `:${t.side === 'old' ? '-' : ''}${t.from === t.to ? t.from : `${t.from}-${t.to}`}` : ''}`;
  const what = t.error
    ? `does not resolve: ${t.error}`
    : t.here
    ? `the line under the cursor · its whole file${t.side === 'old' ? ' at the base' : ''}`
    : [
        t.external ? 'outside the feature' : t.units.length ? 'in the change · ⏎ goes there' : 'unchanged',
        t.side === 'old' ? 'at the base' : null,
        t.how === 'named' ? 'named in the text' : t.how === 'found' ? `found by name: ${t.symbol}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
  return { where, what };
}

/**
 * The peek pane's code rows: the file around the target, `context` lines either side
 * (Infinity: all of it), the cited lines marked in the gutter. → {rows, focus (index of
 * the first cited row)}
 */
export function peekRows(lines, t, { width, context = 8, tint = true }) {
  const n = (l) => (l.n != null ? l.n : t.side === 'old' ? l.old : l.new);
  const cited = (l) => t.from != null && n(l) != null && n(l) >= t.from && n(l) <= t.to;
  let a = 0;
  let b = lines.length - 1;
  if (t.from != null && context !== Infinity) {
    const first = lines.findIndex(cited);
    const last = lines.findLastIndex(cited);
    if (first >= 0) {
      a = Math.max(0, first - context);
      b = Math.min(lines.length - 1, last + context);
    }
  }
  const shown = lines.slice(a, b + 1);
  const rows = codeView({ groups: [{ lines: shown }], name: t.file, width: width - 2, layout: 'unified', highlight: 'builtin', tint });
  const isCited = (r) => {
    const v = typeof r.line === 'number' ? r.line : r.at ? (t.side === 'old' ? r.at.old : r.at.new) : null;
    return t.from != null && v != null && v >= t.from && v <= t.to;
  };
  const out = rows.map((r) => ({ ...r, segs: [isCited(r) ? ['▌', 'cyan bold'] : [' ', ''], [' ', ''], ...r.segs] }));
  return { rows: out, focus: Math.max(0, out.findIndex(isCited)), clipped: { above: a, below: lines.length - 1 - b } };
}

/** The pane's title band. */
export function peekTitle(t, i, n, width) {
  const { where, what } = targetText(t);
  // the pane's top border, its title set into it (as herdr and nvim draw a split): a rule
  // across the screen, apart from the review above
  const segs = [['──', 'rule'], [' PEEK ', 'rule inverse bold'], [n > 1 ? ` ${i + 1}/${n} ` : ' ', 'rule bold'], ['─ ', 'rule'], [where, t.error ? 'red bold' : 'bold'], [' ─ ', 'rule'], [what, t.error ? 'red' : 'dim'], [' ', '']];
  const used = segsWidth(segs);
  return used < width ? [...segs, ['─'.repeat(width - used), 'rule']] : segs;
}

/** A target's short name in the pane's list: what the row calls it, else its file and line. */
export function targetName(t, all = []) {
  const file = `${path.basename(t.file ?? '?')}${t.from != null ? `:${t.from}` : ''}`;
  // a file named: its name and line (the title has the path)
  const name = t.how === 'named' ? null : (t.named ?? t.symbol ?? null);
  if (!name) return file;
  // one name, several places (refund in two classes): which one
  return all.filter((x) => (x.named ?? x.symbol) === name).length > 1 ? `${name} ${file}` : name;
}

/** The places the peek can show, numbered (the digit picks one), the current one marked; null for one. */
export function peekChoices(targets, i, width) {
  if (targets.length < 2) return null;
  const segs = [[' ', '']];
  let used = 1;
  for (let k = 0; k < targets.length; k++) {
    const label = `${k < 9 ? k + 1 : '·'} ${targetName(targets[k], targets)}`;
    const rest = targets.length - k;
    if (used + label.length + 2 > width - (rest > 1 ? 8 : 0)) {
      segs.push([`+${rest} n N`, 'dim']);
      break;
    }
    segs.push([` ${label} `, k === i ? 'inverse bold' : targets[k].row ? 'bold' : 'dim'], [' ', '']);
    used += label.length + 3;
  }
  return pad(segs, width);
}
