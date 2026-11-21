// The annotation file (docs/annotations.md): <dir>/.feature-review/annotations.json,
// written by an agent. Reading it, resolving its citations against the workspace, and
// checking it (`fr check`): every citation must resolve, enums must be known, and every
// hunk should be in a group.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, git } from './workspace.mjs';
import { parseDoc } from './md/parse.mjs';

export const annotationsPath = (root) => path.join(root, STATE_DIR, 'annotations.json');
export const MAX_REF_LINES = 60;
/** Longer code blocks in prose are pasted code: a citation shows the real code instead. */
export const MAX_PASTED_LINES = 3;

export const ENUMS = {
  risk: ['high', 'medium', 'low'],
  requested: ['yes', 'no', 'unclear'],
  role: ['interface', 'implementation', 'test', 'config', 'migration', 'infra', 'docs'],
  side: ['new', 'old'],
  change: ['new', 'changed', 'removed'],
  layer: ['domain', 'application', 'infrastructure', 'interface', 'test', 'config', 'other'],
  signal: ['single-implementation', 'pass-through', 'single-variant', 'single-type-parameter', 'anemic-domain', 'rule-in-two-places', 'primitive-concept', 'domain-depends-on-infrastructure', 'new-pattern', 'other'],
  nameKind: ['type', 'method', 'field', 'test', 'config-key', 'event', 'endpoint'],
  nameFlag: ['ok', 'technical', 'differs-from-codebase', 'inconsistent-across-services'],
  testFlag: ['name-vs-assertion', 'loosened', 'expected-changed-with-code', 'removed', 'disabled', 'timeout-raised', 'mocks-unit-under-test', 'catch-all', 'snapshot-regenerated'],
  status: ['ok', 'broken', 'unclear'],
  contractKind: ['event', 'http', 'grpc', 'schema', 'db', 'config', 'helm-values'],
  compatible: ['yes', 'no', 'unclear'],
};

/** {ann} | {ann: null} (no file) | {error}. */
export function readAnnotations(root) {
  const p = annotationsPath(root);
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ann: null };
    return { error: `${p}: ${e.message}` };
  }
  try {
    return { ann: JSON.parse(text) };
  } catch (e) {
    return { error: `${p}: not valid JSON: ${e.message}` };
  }
}

// ---------- hunk ids ----------

/**
 * The reviewable units with short ids, per repository in file order: `<repo>:H<n>`, a hunk,
 * or a whole file when it has no hunks (a rename, a binary file). → [{id, unit, repo, f, h}]
 */
export function unitIds(ws) {
  const out = [];
  for (const r of ws.repos) {
    let n = 0;
    for (const f of r.files) {
      if (f.hunks.length) for (const h of f.hunks) out.push({ id: `${r.name}:H${++n}`, unit: h.key, repo: r.name, f, h });
      else out.push({ id: `${r.name}:H${++n}`, unit: f.key, repo: r.name, f, h: null });
    }
  }
  return out;
}

// ---------- citations ----------

const isRef = (x) => x && typeof x === 'object' && !Array.isArray(x) && (typeof x.hunk === 'string' || (typeof x.file === 'string' && x.lines !== undefined));

function parseLines(s) {
  const m = String(s).trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) return null;
  const a = +m[1];
  const b = m[2] === undefined ? a : +m[2];
  return a >= 1 && b >= a ? [a, b] : null;
}

/** The line range of a hunk on a side (a hunk with no lines there: the point where it is). */
export const hunkRange = (h, side) => {
  const [s, c] = side === 'old' ? [h.oldStart, h.oldCount] : [h.newStart, h.newCount];
  return c ? [s, s + c - 1] : [Math.max(1, s), Math.max(1, s)];
};
const overlaps = ([a, b], [c, d]) => a <= d && c <= b;

/**
 * A resolver over a workspace: resolve(ref) → {ok: true, repo, file, side, from, to,
 * units: [key], hunkId?, external?, code?: [{n, s}] (the cited lines)} | {ok: false, error}.
 * File texts are read once each.
 */
export function resolver(ws) {
  const ids = unitIds(ws);
  const byId = new Map(ids.map((u) => [u.id, u]));
  const texts = new Map();
  const readText = (key, fn) => {
    if (!texts.has(key)) texts.set(key, fn());
    return texts.get(key);
  };
  const lines = (t) => (t == null ? null : t.replace(/\n$/, '').split('\n'));

  async function textOf(repoDir, rev, file) {
    if (rev === null) {
      try {
        return fs.readFileSync(path.join(repoDir, file), 'utf8');
      } catch {
        return null;
      }
    }
    const r = await git(repoDir, ['show', `${rev}:${file}`]);
    return r.ok ? r.out : null;
  }

  async function resolve(ref) {
    if (!isRef(ref)) return { ok: false, error: 'not a citation: needs {"hunk": "<repo>:H<n>"} or {"repo"|"path", "file", "lines"}' };
    if (ref.hunk) {
      const u = byId.get(ref.hunk);
      if (!u) return { ok: false, error: `no hunk ${ref.hunk} (fr hunks lists them)` };
      const side = u.f.status === 'D' ? 'old' : 'new';
      const [from, to] = u.h ? hunkRange(u.h, side) : [1, 1];
      return { ok: true, repo: u.repo, file: u.f.file, side, from, to, units: [u.unit], hunkId: u.id };
    }
    const side = ref.side ?? 'new';
    if (!ENUMS.side.includes(side)) return { ok: false, error: `side "${side}": use new or old` };
    const range = parseLines(ref.lines);
    if (!range) return { ok: false, error: `lines "${ref.lines}": use "N" or "N-M"` };
    if (range[1] - range[0] + 1 > MAX_REF_LINES) return { ok: false, error: `lines ${ref.lines}: at most ${MAX_REF_LINES} lines per citation` };
    let text;
    let units = [];
    let repoName = ref.repo ?? null;
    if (ref.path) {
      // code outside the feature: another checkout
      const dir = path.resolve(ws.root, ref.path);
      if (!fs.existsSync(dir)) return { ok: false, error: `path ${ref.path} does not exist` };
      const rev = side === 'old' ? (ref.rev ?? 'HEAD') : (ref.rev ?? null);
      text = await readText(`${dir}\0${rev}\0${ref.file}`, () => textOf(dir, rev, ref.file));
      if (text == null) return { ok: false, error: `${ref.file} does not exist in ${ref.path}${rev ? ` at ${rev}` : ''}` };
      repoName = path.basename(dir);
    } else {
      const repo = ws.repos.find((r) => r.name === ref.repo);
      if (!repo) return { ok: false, error: `no worktree "${ref.repo}" in the feature (outside it: use "path")` };
      if (repo.error) return { ok: false, error: `${ref.repo}: ${repo.error}` };
      const f = repo.files.find((x) => (side === 'old' ? (x.old ?? x.file) : x.file) === ref.file);
      if (f && ((side === 'new' && f.status === 'D') || (side === 'old' && f.status === 'A'))) return { ok: false, error: `${ref.file} has no ${side} side (${f.status === 'D' ? 'deleted: use side old' : 'new: use side new'})` };
      const rev = side === 'old' ? repo.base : null;
      text = await readText(`${repo.dir}\0${rev}\0${ref.file}`, () => textOf(repo.dir, rev, ref.file));
      if (text == null) return { ok: false, error: `${ref.file} does not exist in ${ref.repo}${side === 'old' ? ' at the base' : ''}` };
      if (f) units = f.hunks.length ? f.hunks.filter((h) => overlaps(hunkRange(h, side), range)).map((h) => h.key) : [f.key];
    }
    const all = lines(text);
    if (range[1] > all.length) return { ok: false, error: `${ref.file} has ${all.length} lines${side === 'old' ? ' at the base' : ''}, not ${ref.lines}` };
    const code = all.slice(range[0] - 1, range[1]).map((s, k) => ({ n: range[0] + k, s }));
    return { ok: true, repo: repoName, file: ref.file, side, from: range[0], to: range[1], units, code, ...(ref.path ? { external: true } : {}) };
  }
  return { resolve, ids, byId };
}

// ---------- checking ----------

const str = (x) => typeof x === 'string' && x.trim() !== '';

/**
 * Check and resolve an annotation file. → {errors: [{at, msg}], warnings: [{at, msg}],
 * groups: [{g, parts: [{p, res}], units: [key]}], ungrouped: [unit id], multi: [{id,
 * groups}], refs: Map(ref object → resolution), ids}
 */
export async function checkAnnotations(ann, ws) {
  const errors = [];
  const warnings = [];
  const err = (at, msg) => errors.push({ at, msg });
  const warn = (at, msg) => warnings.push({ at, msg });
  const { resolve, ids, byId } = resolver(ws);
  const refs = new Map();

  if (!ann || typeof ann !== 'object' || Array.isArray(ann)) return { errors: [{ at: '', msg: 'the file must hold a JSON object' }], warnings, groups: [], ungrouped: ids.map((u) => u.id), multi: [], refs, ids };
  if (ann.version !== 1) err('version', 'must be 1');
  const known = ['version', 'intent', 'written', 'groups', 'design', 'names', 'tests', 'ghosts', 'contracts', 'rollout'];
  for (const k of Object.keys(ann)) if (!known.includes(k)) warn(k, 'unknown field, ignored');
  for (const k of ['groups', 'design', 'names', 'tests', 'ghosts', 'contracts']) if (ann[k] !== undefined && !Array.isArray(ann[k])) err(k, 'must be a list');

  // every citation anywhere, resolved
  const walk = async (x, at) => {
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) await walk(x[i], `${at}[${i}]`);
      return;
    }
    if (!x || typeof x !== 'object') return;
    if (isRef(x)) {
      const res = await resolve(x);
      refs.set(x, res);
      if (!res.ok) err(at, res.error);
      return;
    }
    for (const [k, v] of Object.entries(x)) if (k !== 'written') await walk(v, at ? `${at}.${k}` : k);
  };
  await walk(ann, '');

  const oneOf = (v, list, at, required = false) => {
    if (v === undefined || v === null) return required ? err(at, `missing (one of ${list.join(', ')})`) : undefined;
    if (!list.includes(v)) err(at, `"${v}": use one of ${list.join(', ')}`);
  };
  const needRef = (x, at) => {
    if (!isRef(x)) err(at, 'missing or not a citation');
  };

  // prose is Markdown; pasted code in it can differ from the real code unnoticed
  const prose = (x, at) => {
    if (typeof x === 'string') {
      if (!x.includes('```') && !x.includes('~~~')) return;
      for (const b of parseDoc(x).filter((y) => y.kind === 'code' && y.body.length > MAX_PASTED_LINES))
        warn(at, `${b.body.length} lines of pasted code: cite the code instead (a ref), so it comes from git`);
    } else if (Array.isArray(x)) x.forEach((y, i) => prose(y, `${at}[${i}]`));
    else if (x && typeof x === 'object' && !isRef(x)) for (const [k, v] of Object.entries(x)) if (k !== 'written') prose(v, at ? `${at}.${k}` : k);
  };
  prose(ann, '');

  // groups
  const groups = [];
  const seen = new Set();
  (Array.isArray(ann.groups) ? ann.groups : []).forEach((g, i) => {
    const at = `groups[${i}]`;
    if (!str(g?.id)) err(`${at}.id`, 'missing');
    else if (seen.has(g.id)) err(`${at}.id`, `"${g.id}" is used twice`);
    else seen.add(g.id);
    if (!str(g?.title)) err(`${at}.title`, 'missing');
    if (!str(g?.why)) warn(`${at}.why`, 'missing: why this change was made');
    oneOf(g?.risk, ENUMS.risk, `${at}.risk`, true);
    oneOf(g?.requested, ENUMS.requested, `${at}.requested`);
    if (g?.risk_signals !== undefined && !(Array.isArray(g.risk_signals) && g.risk_signals.every(str))) err(`${at}.risk_signals`, 'must be a list of strings');
    if (g?.mechanical != null && !str(g.mechanical)) err(`${at}.mechanical`, 'a reason, or null');
    if (!Array.isArray(g?.parts) || !g.parts.length) err(`${at}.parts`, 'must be a non-empty list');
    const parts = (Array.isArray(g?.parts) ? g.parts : []).map((p, j) => {
      needRef(p?.ref, `${at}.parts[${j}].ref`);
      oneOf(p?.role, ENUMS.role, `${at}.parts[${j}].role`);
      return { p, res: refs.get(p?.ref) ?? null };
    });
    const units = [...new Set(parts.flatMap((x) => (x.res?.ok ? x.res.units : [])))];
    groups.push({ g, parts, units });
  });

  // the other sections: their enums (citations were resolved above)
  const each = (k, fn) => (Array.isArray(ann[k]) ? ann[k] : []).forEach((x, i) => fn(x ?? {}, `${k}[${i}]`));
  each('design', (d, at) => {
    if (!str(d.type)) err(`${at}.type`, 'missing');
    oneOf(d.change, ENUMS.change, `${at}.change`);
    oneOf(d.layer, ENUMS.layer, `${at}.layer`);
    (d.signals ?? []).forEach((s, j) => oneOf(s?.kind, ENUMS.signal, `${at}.signals[${j}].kind`, true));
  });
  each('names', (n, at) => {
    if (!str(n.name)) err(`${at}.name`, 'missing');
    oneOf(n.kind, ENUMS.nameKind, `${at}.kind`);
    oneOf(n.flag, ENUMS.nameFlag, `${at}.flag`);
    needRef(n.ref, `${at}.ref`);
  });
  each('tests', (t, at) => {
    needRef(t.ref, `${at}.ref`);
    if (!str(t.behaviour)) warn(`${at}.behaviour`, 'missing: the behaviour the test specifies, as a sentence');
    if (t.group !== undefined && !seen.has(t.group)) err(`${at}.group`, `no group "${t.group}"`);
    (t.flags ?? []).forEach((f, j) => oneOf(f?.kind, ENUMS.testFlag, `${at}.flags[${j}].kind`, true));
  });
  each('ghosts', (g, at) => {
    needRef(g.ref, `${at}.ref`);
    if (!Array.isArray(g.because) || !g.because.length) err(`${at}.because`, 'must cite the change it depends on');
    oneOf(g.status, ENUMS.status, `${at}.status`, true);
    if (!str(g.why)) err(`${at}.why`, 'missing');
  });
  each('contracts', (c, at) => {
    if (!str(c.name)) err(`${at}.name`, 'missing');
    oneOf(c.kind, ENUMS.contractKind, `${at}.kind`);
    oneOf(c.compatible, ENUMS.compatible, `${at}.compatible`, true);
    needRef(c.producer?.ref, `${at}.producer.ref`);
    (c.consumers ?? []).forEach((x, j) => {
      needRef(x?.ref, `${at}.consumers[${j}].ref`);
      oneOf(x?.status, ENUMS.status, `${at}.consumers[${j}].status`);
    });
  });

  const ro = ann.rollout;
  if (ro != null) {
    if (typeof ro !== 'object' || Array.isArray(ro)) err('rollout', 'must be an object, or null');
    else {
      const names = new Set(ws.repos.map((r) => r.name));
      const svc = (list, at) => (Array.isArray(list) ? list : []).forEach((n, i) => !names.has(n) && warn(`${at}[${i}]`, `"${n}" is not a worktree of the feature`));
      if (ro.order !== undefined && !Array.isArray(ro.order)) err('rollout.order', 'must be a list of worktree names');
      svc(ro.order, 'rollout.order');
      (Array.isArray(ro.partial) ? ro.partial : []).forEach((p, i) => {
        oneOf(p?.risk, ENUMS.risk, `rollout.partial[${i}].risk`);
        svc(p?.deployed, `rollout.partial[${i}].deployed`);
        svc(p?.not, `rollout.partial[${i}].not`);
      });
      (Array.isArray(ro.config) ? ro.config : []).forEach((c, i) => needRef(c?.ref, `rollout.config[${i}].ref`));
    }
  }

  // coverage: every unit in exactly one group
  const unitGroups = new Map();
  for (const { g, units } of groups) for (const u of units) unitGroups.set(u, [...(unitGroups.get(u) ?? []), g.id]);
  const ungrouped = ids.filter((u) => !unitGroups.has(u.unit)).map((u) => u.id);
  const multi = ids.filter((u) => (unitGroups.get(u.unit)?.length ?? 0) > 1).map((u) => ({ id: u.id, groups: unitGroups.get(u.unit) }));
  if (ungrouped.length && groups.length) warn('groups', `${ungrouped.length} hunk(s) in no group: ${ungrouped.join(', ')}`);
  for (const m of multi) warn('groups', `${m.id} is in several groups: ${m.groups.join(', ')}`);

  // written for another state of the code?
  const stale = staleness(ann, ws, byId);
  for (const s of stale) warn('written', s);

  return { errors, warnings, groups, ungrouped, multi, refs, ids, stale };
}

/** A repository's change in one value: the keys of its hunks (and hunkless files). */
export const fingerprint = (r) =>
  crypto
    .createHash('sha256')
    .update(r.files.flatMap((f) => (f.hunks.length ? f.hunks.map((h) => h.key) : [f.key])).join('\n'))
    .digest('hex')
    .slice(0, 16);

/** Why the annotations may not fit the code any more (empty: they fit, or were never stamped). */
export function staleness(ann, ws, byId = new Map(unitIds(ws).map((u) => [u.id, u]))) {
  const w = ann?.written;
  if (!w?.heads) return [];
  const out = [];
  for (const r of ws.repos) {
    const was = w.heads[r.name];
    if (was && r.head && was !== r.head) out.push(`${r.name} has new commits since the annotations were written (${was.slice(0, 7)} → ${r.head.slice(0, 7)})`);
    else if (w.changes?.[r.name] && w.changes[r.name] !== fingerprint(r)) out.push(`${r.name}'s change differs from when the annotations were written`);
  }
  const changed = Object.entries(w.hunks ?? {}).filter(([id, key]) => byId.get(id)?.unit !== key).map(([id]) => id);
  if (changed.length) out.push(`hunks changed since the annotations were written: ${changed.join(', ')}`);
  return out;
}

/** Record the state the annotations fit: each worktree's HEAD and the keys of the hunk ids cited. */
export function stamp(ann, ws) {
  const ids = new Map(unitIds(ws).map((u) => [u.id, u.unit]));
  const cited = new Set();
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    if (typeof x.hunk === 'string') cited.add(x.hunk);
    for (const v of Object.values(x)) walk(v);
  };
  walk({ ...ann, written: null });
  return {
    ...ann,
    written: {
      ...(ann.written ?? {}),
      checked: new Date().toISOString(),
      heads: Object.fromEntries(ws.repos.filter((r) => r.head).map((r) => [r.name, r.head])),
      changes: Object.fromEntries(ws.repos.filter((r) => !r.error).map((r) => [r.name, fingerprint(r)])),
      hunks: Object.fromEntries([...cited].filter((id) => ids.has(id)).sort().map((id) => [id, ids.get(id)])),
    },
  };
}
