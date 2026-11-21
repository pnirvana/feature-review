// A feature's workspace: a parent directory with one git worktree per service (discovery
// §2). Finds the worktrees and each one's base, and reads the change of each: the base
// against the working tree, so uncommitted and untracked files are part of it.
//
// The repositories are only read. The working tree's state goes through a copy of the
// worktree's index (GIT_INDEX_FILE), never the index itself; `git add` there writes blob
// objects into the repository, which is harmless (gc removes unreferenced ones).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STATE_DIR = '.feature-review';
export const MANIFEST = 'feature-review.json';

export function git(cwd, args, { env = {}, input = null } = {}) {
  return new Promise((resolve) => {
    const p = execFile(
      'git',
      ['-c', 'core.quotePath=false', ...args],
      { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...env }, timeout: 60_000, maxBuffer: 256 << 20 },
      (err, stdout, stderr) => resolve(err ? { ok: false, out: String(stdout), err: String(stderr).trim() || err.message } : { ok: true, out: String(stdout) }),
    );
    if (input !== null) p.stdin.end(input);
  });
}
const gitOut = async (cwd, args, opts) => {
  const r = await git(cwd, args, opts);
  return r.ok ? r.out.trim() : null;
};

// ---------- hunks ----------

/** A hunk's key: repository, path and its removed and added lines (not line numbers), as in ATF. */
export function hunkKey(repo, file, lines) {
  const h = crypto.createHash('sha256');
  h.update(`${repo}\0${file}\0`);
  for (const [t, s] of lines) if (t !== ' ') h.update(`${t}${s}\n`);
  return h.digest('hex').slice(0, 16);
}

/**
 * Parse a unified diff (git diff -M, prefixes a/ b/) into files: [{file, old, status
 * (A|D|M|R), binary?, hunks: [{n, oldStart, oldCount, newStart, newCount, header, lines:
 * [[t, s, old, new]]}]}]. Based on ATF's parsePatch, plus new, deleted and renamed files.
 */
export function parsePatch(text) {
  const files = [];
  let f = null;
  let h = null;
  let o = 0;
  let nw = 0;
  const unq = (p) => (p.startsWith('"') ? JSON.parse(p) : p);
  for (const l of String(text || '').split('\n')) {
    if (l.startsWith('diff --git ')) {
      // "a/x b/x": the two halves are equal unless renamed (then rename from/to follow)
      const rest = l.slice(11);
      const half = rest.length >> 1;
      const guess = rest[half] === ' ' && rest.slice(2, half) === rest.slice(half + 3) ? rest.slice(2, half) : null;
      f = { file: guess, old: guess, status: 'M', hunks: [] };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    if (!h) {
      if (l.startsWith('new file mode')) f.status = 'A';
      else if (l.startsWith('deleted file mode')) f.status = 'D';
      else if (l.startsWith('rename from ')) (f.old = unq(l.slice(12))), (f.status = 'R');
      else if (l.startsWith('rename to ')) (f.file = unq(l.slice(10))), (f.status = 'R');
      else if (l.startsWith('--- ')) {
        const p = unq(l.slice(4));
        if (p !== '/dev/null') f.old = p.replace(/^a\//, '');
      } else if (l.startsWith('+++ ')) {
        const p = unq(l.slice(4));
        if (p !== '/dev/null') f.file = p.replace(/^b\//, '');
        else f.file = f.old;
      } else if (l.startsWith('Binary files')) f.binary = true;
    }
    const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (m) {
      h = { n: f.hunks.length + 1, oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], header: m[5].trim(), lines: [] };
      f.hunks.push(h);
      o = h.oldStart;
      nw = h.newStart;
      continue;
    }
    if (!h) continue;
    if (l.startsWith('+')) h.lines.push(['+', l.slice(1), null, nw++]);
    else if (l.startsWith('-')) h.lines.push(['-', l.slice(1), o++, null]);
    else if (l.startsWith(' ')) h.lines.push([' ', l.slice(1), o++, nw++]);
    // "\ No newline at end of file" and anything else: skipped
  }
  for (const x of files) {
    if (x.status === 'A') x.old = null;
    if (x.status === 'D') x.file = x.old;
  }
  return files;
}

// ---------- discovery ----------

export function readManifest(root) {
  const p = path.join(root, MANIFEST);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`${p}: ${e.message}`);
  }
}

const isWorktree = (dir) => fs.existsSync(path.join(dir, '.git'));

/**
 * The worktrees of a parent directory: its children that are git worktrees (dot
 * directories skipped). A directory that is itself a worktree is a workspace of one.
 * → {root, name, repos: [{name, dir}]}
 */
export function discover(dir) {
  const root = path.resolve(dir);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${root} is not a directory`);
  if (isWorktree(root)) return { root, name: path.basename(root), repos: [{ name: path.basename(root), dir: root }], single: true };
  const repos = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && isWorktree(path.join(root, e.name)))
    .map((e) => ({ name: e.name, dir: path.join(root, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!repos.length) throw new Error(`${root} has no git worktrees as children`);
  return { root, name: path.basename(root), repos };
}

/** The base ref a repository's change is measured from: the manifest's, else origin's default branch. */
async function baseRef(dir, name, manifest) {
  const b = manifest.base;
  const want = typeof b === 'string' ? b : b?.[name];
  if (want) return { ref: want, from: MANIFEST };
  const head = await gitOut(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head) return { ref: head, from: 'origin/HEAD' };
  for (const r of ['origin/main', 'origin/master']) if (await gitOut(dir, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`])) return { ref: r, from: 'guess' };
  return null;
}

// ---------- reading a change ----------

/** The working tree as a tree in a temporary copy of the index: tracked changes and untracked files, .gitignore respected. */
async function workingTreeIndex(dir) {
  const real = await gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fr-')), 'index');
  if (real && fs.existsSync(real)) fs.copyFileSync(real, tmp); // keeps the stat cache: add -A only hashes what changed
  const env = { GIT_INDEX_FILE: tmp };
  if (!real || !fs.existsSync(real)) await git(dir, ['read-tree', 'HEAD'], { env });
  const add = await git(dir, ['add', '-A', '--', '.'], { env });
  return { env, ok: add.ok, err: add.err, done: () => fs.rmSync(path.dirname(tmp), { recursive: true, force: true }) };
}

/**
 * One repository's change: base, head and its files with hunks (keys set), each file
 * marked `dirty` when it differs from HEAD (not committed yet).
 */
export async function readRepo(repo, manifest = {}) {
  const { dir, name } = repo;
  const out = { name, dir, files: [] };
  const br = await baseRef(dir, name, manifest);
  if (!br) return { ...out, error: `no base: origin has no default branch here; set "base" in ${MANIFEST}` };
  out.baseRef = br.ref;
  out.baseFrom = br.from;
  out.head = await gitOut(dir, ['rev-parse', 'HEAD']);
  out.branch = await gitOut(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  out.base = await gitOut(dir, ['merge-base', 'HEAD', br.ref]);
  if (!out.base) return { ...out, error: `no merge base between HEAD and ${br.ref}` };
  const idx = await workingTreeIndex(dir);
  try {
    if (!idx.ok) return { ...out, error: `reading the working tree: ${idx.err}` };
    const diff = await git(dir, ['--no-pager', 'diff', '--cached', '-M', '--no-color', '--no-ext-diff', '-U3', out.base], { env: idx.env });
    if (!diff.ok) return { ...out, error: diff.err };
    const dirty = await git(dir, ['diff', '--cached', '--name-only', '-z', 'HEAD'], { env: idx.env });
    const dirtySet = new Set(dirty.ok ? dirty.out.split('\0').filter(Boolean) : []);
    out.dirty = dirtySet.size;
    for (const f of parsePatch(diff.out)) {
      if (!f.file) continue;
      for (const h of f.hunks) h.key = hunkKey(name, f.file, h.lines);
      const add = f.hunks.reduce((n, h) => n + h.lines.filter(([t]) => t === '+').length, 0);
      const del = f.hunks.reduce((n, h) => n + h.lines.filter(([t]) => t === '-').length, 0);
      out.files.push({
        repo: name,
        file: f.file,
        old: f.old,
        status: f.status,
        ...(f.binary ? { binary: true } : {}),
        dirty: dirtySet.has(f.file) || (f.old ? dirtySet.has(f.old) : false),
        add,
        del,
        hunks: f.hunks,
        // a file without hunks (binary, pure rename, empty) is marked as a whole
        key: hunkKey(name, f.file, [['F', `${f.status} ${f.old ?? ''} ${f.binary ? 'binary' : ''}`], ...f.hunks.flatMap((h) => h.lines)]),
      });
    }
    out.files.sort((a, b) => a.file.localeCompare(b.file));
    return out;
  } finally {
    idx.done();
  }
}

/** A file's text at the base (null: not there) and in the working tree. */
export async function fileTexts(repo, f) {
  let old = null;
  if (f.status !== 'A' && !f.binary) {
    const r = await git(repo.dir, ['show', `${repo.base}:${f.old ?? f.file}`]);
    if (r.ok) old = r.out; // not trimmed: line numbers must stay
  }
  let nw = null;
  if (f.status !== 'D' && !f.binary) {
    try {
      nw = fs.readFileSync(path.join(repo.dir, f.file), 'utf8');
    } catch {
      nw = null;
    }
  }
  return { old, new: nw };
}

/** The whole workspace: discovery, manifest and every repository's change. */
export async function loadWorkspace(dir) {
  const ws = discover(dir);
  const manifest = readManifest(ws.root);
  const repos = await Promise.all(ws.repos.map((r) => readRepo(r, manifest)));
  return { ...ws, manifest, repos };
}

/** Every reviewable unit of a workspace: a hunk, or a whole file when it has none. */
export function units(ws) {
  return ws.repos.flatMap((r) => r.files.flatMap((f) => (f.hunks.length ? f.hunks.map((h) => h.key) : [f.key])));
}
