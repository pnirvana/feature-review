// Coverage of the changed lines from the JaCoCo reports a build left in the worktrees
// (discovery §9): which added lines a test runs. Overall coverage says nothing about a
// review; a changed line no test runs does. No report: no signal, never a failure.
//
// Reports: <dir>/feature-review.toml `[coverage] <worktree> = ["path/to/jacoco.xml", …]`,
// else found: Maven `target/site/*/jacoco.xml`, Gradle `build/reports/jacoco/*/*.xml`, in
// any module. Several reports (unit, integration) are merged: a line is covered when any
// covers it. A report older than a file says nothing about that file's lines (they moved).
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', 'src', '.git', '.idea', '.mvn', '.gradle', '.feature-review']);
const MAX_DEPTH = 5;

/** The JaCoCo XML reports under a worktree (build outputs, not tracked files). */
export function findReports(dir) {
  const out = [];
  const xmls = (d) => {
    try {
      return fs.readdirSync(d).filter((f) => f.endsWith('.xml')).map((f) => path.join(d, f));
    } catch {
      return [];
    }
  };
  const subdirs = (d) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name));
    } catch {
      return [];
    }
  };
  const walk = (d, depth) => {
    for (const sub of subdirs(d)) {
      const name = path.basename(sub);
      if (name === 'target') for (const s of subdirs(path.join(sub, 'site'))) out.push(...xmls(s).filter((f) => path.basename(f) === 'jacoco.xml'));
      else if (name === 'build') for (const s of subdirs(path.join(sub, 'reports', 'jacoco'))) out.push(...xmls(s));
      else if (depth < MAX_DEPTH && !SKIP.has(name) && !name.startsWith('.')) walk(sub, depth + 1);
    }
  };
  walk(dir, 0);
  return out.filter((f) => isJacoco(f));
}
const isJacoco = (file) => {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(400);
    fs.readSync(fd, buf, 0, 400, 0);
    fs.closeSync(fd);
    return /<report\b|JACOCO/i.test(buf.toString());
  } catch {
    return false;
  }
};

/**
 * A JaCoCo XML report's lines. → Map "pkg/path/File.java" → Map line → {mi, ci, mb, cb}
 * (missed and covered instructions, missed and covered branches).
 */
export function parseJacoco(xml) {
  const out = new Map();
  let pkg = '';
  let file = null;
  const re = /<package\s+name="([^"]*)"|<sourcefile\s+name="([^"]*)"|<\/sourcefile>|<line\s+([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) pkg = m[1];
    else if (m[2] !== undefined) {
      file = new Map();
      out.set(pkg ? `${pkg}/${m[2]}` : m[2], file);
    } else if (m[0] === '</sourcefile>') file = null;
    else if (file) {
      const a = Object.fromEntries([...m[3].matchAll(/(\w+)="(\d+)"/g)].map(([, k, v]) => [k, Number(v)]));
      if (a.nr) file.set(a.nr, { mi: a.mi ?? 0, ci: a.ci ?? 0, mb: a.mb ?? 0, cb: a.cb ?? 0 });
    }
  }
  return out;
}

/** A line's state: 'covered' | 'partly' (some branches not taken) | 'missed'. */
export const lineState = (l) => (l.ci > 0 ? (l.mb > 0 ? 'partly' : 'covered') : l.mi > 0 ? 'missed' : null);

/**
 * The coverage of a repository's changed files. manifest: the feature's settings.
 * → {reports: [{file, mtime}], files: Map "repo\0file" → {lines: Map new line → state (the
 * lines the hunks show on the new side),
 * branches: Map new line → {missed, taken} (lines with branches not taken), stale: bool,
 * report: file}} (only files a report knows)
 */
export function repoCoverage(r, manifest = {}) {
  const want = manifest.coverage?.[r.name];
  const paths = (Array.isArray(want) ? want : typeof want === 'string' ? [want] : null)?.map((p) => path.resolve(r.dir, p)) ?? findReports(r.dir);
  const reports = [];
  const merged = new Map(); // key → {lines: Map, mtime (the newest report knowing it), report}
  for (const p of paths) {
    let xml;
    let st;
    try {
      st = fs.statSync(p);
      xml = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    reports.push({ file: p, mtime: st.mtimeMs });
    for (const [key, lines] of parseJacoco(xml)) {
      const m = merged.get(key) ?? { lines: new Map(), mtime: 0, report: p };
      for (const [n, l] of lines) {
        const o = m.lines.get(n);
        // merged: covered by any; branches: the most taken
        m.lines.set(n, o ? { mi: Math.min(o.mi, l.mi), ci: Math.max(o.ci, l.ci), mb: Math.min(o.mb, l.mb), cb: Math.max(o.cb, l.cb) } : l);
      }
      if (st.mtimeMs > m.mtime) Object.assign(m, { mtime: st.mtimeMs, report: p });
      merged.set(key, m);
    }
  }
  const files = new Map();
  if (!merged.size) return { reports, files };
  for (const f of r.files) {
    if (f.status === 'D' || !/\.(java|kt|groovy|scala)$/.test(f.file)) continue;
    // the report names a file by package path: …/src/main/java/<pkg>/<File> ends with it
    const key = [...merged.keys()].filter((k) => f.file === k || f.file.endsWith(`/${k}`)).sort((a, b) => b.length - a.length)[0];
    if (!key) continue;
    const m = merged.get(key);
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(r.dir, f.file)).mtimeMs;
    } catch {}
    const lines = new Map();
    const branches = new Map();
    for (const h of f.hunks)
      for (const [t, , , n] of h.lines) {
        if (t === '-') continue; // every line the hunk shows on the new side (an if's body may be unchanged)
        const l = m.lines.get(n);
        const s = l && lineState(l);
        if (s) lines.set(n, s);
        if (s === 'partly') branches.set(n, { missed: l.mb, taken: l.cb });
      }
    files.set(`${r.name}\0${f.file}`, { lines, branches, stale: mtime > m.mtime, report: m.report, reportTime: m.mtime });
  }
  return { reports, files };
}
