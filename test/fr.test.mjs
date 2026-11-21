import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSample, sampleAnnotations } from './fixture.mjs';
import { parsePatch, hunkKey, discover, loadWorkspace, units, MANIFEST } from '../src/workspace.mjs';
import { readState, update, setMarks, addComment, locate } from '../src/state.mjs';
import { buildRows, readingOrder, UNGROUPED } from '../src/rows.mjs';
import { checkAnnotations, unitIds, stamp, staleness, resolver } from '../src/annotations.mjs';
import { plain } from '../src/md/term.mjs';

let top;
let dir;
before(() => {
  top = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-test-'));
  dir = makeSample(top);
});
const scratch = [];
after(() => [top, ...scratch].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const text = (rows) => rows.map((r) => plain(r.segs)).join('\n');
const fileOf = (ws, repo, file) => ws.repos.find((r) => r.name === repo).files.find((f) => f.file.endsWith(file));

test('parsePatch: modified, new, deleted and renamed files', () => {
  const patch = [
    'diff --git a/m.txt b/m.txt',
    'index 1..2 100644',
    '--- a/m.txt',
    '+++ b/m.txt',
    '@@ -1,2 +1,2 @@',
    ' a',
    '-b',
    '+c',
    'diff --git a/n.txt b/n.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/n.txt',
    '@@ -0,0 +1 @@',
    '+x',
    'diff --git a/d.txt b/d.txt',
    'deleted file mode 100644',
    '--- a/d.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-y',
    'diff --git a/old name.txt b/new name.txt',
    'similarity index 100%',
    'rename from old name.txt',
    'rename to new name.txt',
  ].join('\n');
  const fs_ = parsePatch(patch);
  assert.deepEqual(
    fs_.map((f) => [f.status, f.file, f.old, f.hunks.length]),
    [
      ['M', 'm.txt', 'm.txt', 1],
      ['A', 'n.txt', null, 1],
      ['D', 'd.txt', 'd.txt', 1],
      ['R', 'new name.txt', 'old name.txt', 0],
    ],
  );
  assert.deepEqual(fs_[0].hunks[0].lines, [[' ', 'a', 1, 1], ['-', 'b', 2, null], ['+', 'c', null, 2]]);
});

test('hunkKey ignores line numbers and context, not the changed lines', () => {
  const a = hunkKey('r', 'f', [[' ', 'ctx', 1, 1], ['-', 'x', 2, null], ['+', 'y', null, 2]]);
  const b = hunkKey('r', 'f', [[' ', 'other', 40, 41], ['-', 'x', 41, null], ['+', 'y', null, 42]]);
  const c = hunkKey('r', 'f', [['-', 'x', 2, null], ['+', 'z', null, 2]]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, hunkKey('other-repo', 'f', [['-', 'x'], ['+', 'y']]));
});

test('discover: the worktrees of a parent directory, or a worktree on its own', () => {
  fs.mkdirSync(path.join(dir, '.feature-review'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  assert.deepEqual(discover(dir).repos.map((r) => r.name), ['gateway', 'refund-service']);
  const one = discover(path.join(dir, 'gateway'));
  assert.equal(one.single, true);
  assert.deepEqual(one.repos.map((r) => r.name), ['gateway']);
  assert.throws(() => discover(path.join(dir, 'notes')), /no git worktrees/);
});

test('a change: base to working tree, uncommitted and untracked files included, the index untouched', async () => {
  const statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: path.join(dir, 'gateway') }).toString();
  const ws = await loadWorkspace(dir);
  const gw = ws.repos.find((r) => r.name === 'gateway');
  assert.equal(gw.baseRef, 'origin/main');
  assert.equal(gw.branch, 'feature/idempotent-refunds');
  assert.deepEqual(gw.files.map((f) => [f.status, path.basename(f.file), f.dirty]), [
    ['A', 'IdempotencyKey.java', true], // untracked
    ['M', 'RefundController.java', false],
    ['A', 'RefundRequest.java', false],
    ['M', 'application.yml', true], // modified, not committed
  ]);
  const rs = ws.repos.find((r) => r.name === 'refund-service');
  assert.deepEqual(rs.files.map((f) => f.status).sort(), ['D', 'M', 'M', 'M', 'R']);
  assert.equal(fileOf(ws, 'refund-service', 'MoneyUtil.java').old, 'src/main/java/shop/refund/Util.java');
  assert.equal(units(ws).length, 9);
  const statusAfter = execFileSync('git', ['status', '--porcelain'], { cwd: path.join(dir, 'gateway') }).toString();
  assert.equal(statusAfter, statusBefore);
});

test('the manifest overrides the base', async () => {
  const gw = path.join(dir, 'gateway');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };
  execFileSync('git', ['tag', 'feature-base', 'HEAD'], { cwd: gw, env });
  fs.writeFileSync(path.join(dir, MANIFEST), '# the gateway starts from a feature branch\n[base]\ngateway = "feature-base"\n');
  try {
    const ws = await loadWorkspace(dir);
    const r = ws.repos.find((x) => x.name === 'gateway');
    assert.equal(r.baseFrom, MANIFEST);
    // only the uncommitted part is left
    assert.deepEqual(r.files.map((f) => path.basename(f.file)), ['IdempotencyKey.java', 'application.yml']);
    assert.equal(ws.repos.find((x) => x.name === 'refund-service').baseRef, 'origin/main');
  } finally {
    fs.rmSync(path.join(dir, MANIFEST));
  }
});

test('a repository without a base says so instead of failing the workspace', async () => {
  const lone = path.join(top, 'lonely', 'svc');
  fs.mkdirSync(lone, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: lone });
  const ws = await loadWorkspace(path.dirname(lone));
  assert.match(ws.repos[0].error, /no base/);
});

test('comments: kept at their line, moved with it, or outdated', async () => {
  const ws = await loadWorkspace(dir);
  const f = fileOf(ws, 'refund-service', 'RefundService.java');
  const line = f.hunks[0].lines.find(([t, s]) => t === '+' && s.includes('seen.contains'));
  const c = { repo: 'refund-service', file: f.file, side: 'new', line: line[3], quote: line[1] };
  assert.deepEqual(locate(c, ws), { file: f, side: 'new', line: line[3], outdated: false });
  const moved = locate({ ...c, line: line[3] + 2 }, ws);
  assert.equal(moved.line, line[3]);
  assert.equal(moved.moved, true);
  assert.equal(locate({ ...c, quote: 'not there' }, ws).outdated, true);
  assert.equal(locate({ ...c, file: 'gone.java' }, ws), null);
});

test('rows: reviewed hunks fold away, comments sit below their line', async () => {
  const ws = await loadWorkspace(dir);
  const f = fileOf(ws, 'refund-service', 'RefundService.java');
  const h = f.hunks[0];
  const line = h.lines.find(([t, s]) => t === '+' && s.includes('seen.contains'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-state-'));
  scratch.push(root);
  let st = update(root, (s) => addComment(s, { repo: 'refund-service', file: f.file, side: 'new', line: line[3], quote: line[1], hunk: h.key }, 'Is seen shared across instances?'));
  let rows = buildRows(ws, st, { width: 100, layout: 'unified', tint: false });
  const at = rows.findIndex((r) => r.kind === 'code' && r.hunk === h.key && r.line?.n === line[3] && r.line.side === 'new');
  assert.equal(rows[at + 1].kind, 'comment');
  assert.match(text(rows.slice(at + 1, at + 4)), /Is seen shared across instances\?/);

  st = update(root, (s) => setMarks(s, [h.key], true));
  assert.equal(readState(root).marks[h.key] !== undefined, true);
  rows = buildRows(ws, st, { width: 100, layout: 'unified', tint: false });
  const fileRow = rows.find((r) => r.kind === 'file' && r.fid.endsWith('RefundService.java'));
  assert.match(plain(fileRow.segs), /✓ reviewed {2}1 comment/);
  assert.equal(rows.some((r) => r.kind === 'code' && r.hunk === h.key), false);
  // unfolded on request
  rows = buildRows(ws, st, { width: 100, layout: 'unified', tint: false, fold: new Map([[fileRow.fid, false], [h.key, false]]) });
  assert.equal(rows.some((r) => r.kind === 'code' && r.hunk === h.key), true);
});

test('fr --print runs end to end', () => {
  const out = execFileSync(process.execPath, [path.resolve('bin/fr.mjs'), dir, '--print', '--plain', '--width', '100']).toString();
  assert.match(out, /gateway {3}feature\/idempotent-refunds\n *base origin\/main/);
  assert.match(out, /R {2}src\/main\/java\/shop\/refund\/Util\.java → src\/main\/java\/shop\/refund\/MoneyUtil\.java/);
  assert.match(out, /- {9}1 \* ledger\.book\('o1', -5\)|1 \* ledger\.book/);
});

// ---------- annotations ----------

const clone = (x) => JSON.parse(JSON.stringify(x));

test('hunk ids: per repository, in file order; a file without hunks has one too', async () => {
  const ws = await loadWorkspace(dir);
  const ids = unitIds(ws);
  assert.deepEqual(ids.filter((u) => u.repo === 'gateway').map((u) => [u.id, path.basename(u.f.file)]), [
    ['gateway:H1', 'IdempotencyKey.java'],
    ['gateway:H2', 'RefundController.java'],
    ['gateway:H3', 'RefundRequest.java'],
    ['gateway:H4', 'application.yml'],
  ]);
  const rename = ids.find((u) => u.f.status === 'R');
  assert.equal(rename.h, null);
  assert.equal(rename.unit, rename.f.key);
});

test('citations: hunk ids, ranges on either side, unchanged code, other checkouts', async () => {
  const ws = await loadWorkspace(dir);
  const { resolve } = resolver(ws);
  const h3 = await resolve({ hunk: 'gateway:H3' });
  assert.equal(h3.ok, true);
  assert.equal(h3.units.length, 1);
  const range = await resolve({ repo: 'refund-service', file: 'src/main/java/shop/refund/RefundService.java', lines: '5' });
  assert.equal(range.units.length, 1);
  const old = await resolve({ repo: 'refund-service', file: 'src/test/groovy/shop/refund/RefundServiceSpec.groovy', lines: '11', side: 'old' });
  assert.equal(old.code[0].s.trim(), "1 * ledger.book('o1', -5)");
  // a range in a changed file maps to the hunk it overlaps
  const yml = await resolve({ repo: 'gateway', file: 'src/main/resources/application.yml', lines: '1' });
  assert.deepEqual([yml.ok, yml.units.length], [true, 1]);
  const other = await resolve({ path: '../remotes/refund-service-seed', file: 'src/main/java/shop/refund/Legacy.java', lines: '4' });
  assert.deepEqual([other.ok, other.external, other.code[0].s.trim()], [true, true, '// old refund path']);
  for (const [ref, msg] of [
    [{ hunk: 'gateway:H9' }, /no hunk gateway:H9/],
    [{ repo: 'nope', file: 'x', lines: '1' }, /no worktree "nope"/],
    [{ repo: 'gateway', file: 'missing.java', lines: '1' }, /does not exist/],
    [{ repo: 'gateway', file: 'src/main/resources/application.yml', lines: '1-99' }, /at most 60 lines/],
    [{ repo: 'gateway', file: 'src/main/resources/application.yml', lines: '9' }, /has 4 lines/],
    [{ repo: 'gateway', file: 'src/main/resources/application.yml', lines: 'x' }, /use "N" or "N-M"/],
    [{ repo: 'refund-service', file: 'src/main/java/shop/refund/Legacy.java', lines: '1' }, /deleted: use side old/],
  ])
    assert.match((await resolve(ref)).error, msg);
});

test('fr check: the sample is valid; coverage, enums and broken citations are reported', async () => {
  const ws = await loadWorkspace(dir);
  const ok = await checkAnnotations(sampleAnnotations(), ws);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.ungrouped, ['gateway:H1']);
  assert.match(ok.warnings.map((w) => w.msg).join('\n'), /1 hunk\(s\) in no group: gateway:H1/);

  const bad = clone(sampleAnnotations());
  bad.groups[0].risk = 'huge';
  bad.groups[1].id = bad.groups[0].id;
  bad.groups[0].parts[0].ref = { hunk: 'gateway:H99' };
  bad.tests[0].flags[0].kind = 'odd';
  bad.ghosts[0].because = [];
  delete bad.findings[0].note;
  bad.groups[2].parts.push({ ref: { hunk: 'refund-service:H4' }, role: 'test' });
  const res = await checkAnnotations(bad, ws);
  const at = res.errors.map((e) => e.at);
  for (const want of ['groups[0].risk', 'groups[1].id', 'groups[0].parts[0].ref', 'tests[0].flags[0].kind', 'ghosts[0].because', 'findings[0].note']) assert.ok(at.includes(want), `${want} in ${at.join(', ')}`);
  assert.deepEqual(res.multi, [{ id: 'refund-service:H4', groups: ['refund-key', 'cleanup'] }]);
});

test('stamp and staleness: new commits and changed hunks are noticed', async () => {
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-stale-'));
  scratch.push(t2);
  const d2 = makeSample(t2);
  let ws = await loadWorkspace(d2);
  const stamped = stamp(sampleAnnotations(), ws);
  assert.ok(stamped.written.heads.gateway);
  assert.ok(stamped.written.hunks['refund-service:H5']);
  assert.deepEqual(staleness(stamped, ws), []);
  // the agent edits a cited hunk without committing
  const spec = path.join(d2, 'refund-service', 'src/test/groovy/shop/refund/RefundServiceSpec.groovy');
  fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace('_ * ledger.book(_, _)', "1 * ledger.book('o1', -5)"));
  ws = await loadWorkspace(d2);
  const why = staleness(stamped, ws).join('\n');
  assert.match(why, /refund-service's change differs/);
  assert.match(why, /hunks changed since the annotations were written: refund-service:H5/);
});

test('groups lens: reading order by group, ungrouped hunks last and never hidden', async () => {
  const ws = await loadWorkspace(dir);
  const ann = sampleAnnotations();
  const checked = { ann, ...(await checkAnnotations(ann, ws)) };
  const order = readingOrder(ws, checked, 'groups');
  assert.deepEqual([...new Set(order.map((u) => u.group))], ['refund-key', 'config', 'cleanup', null]);
  assert.equal(order.length, unitIds(ws).length);
  const rows = buildRows(ws, { marks: {}, comments: [] }, { width: 100, tint: false, lens: 'groups', ann: checked });
  const t = text(rows);
  assert.match(t, /▾ 1 {2}Refunds carry an idempotency key.*\n *HIGH {3}money · public contract · deleted check/);
  assert.match(t, /▸ 3 {2}Remove the legacy refund path.*\n.*claimed mechanical: 1 of 2 hunks not verified/); // mechanical: folded
  assert.match(t, /Not grouped *\n *1 hunk no group explains/);
  const ug = rows.findIndex((r) => r.kind === 'group' && r.group === UNGROUPED);
  assert.ok(rows.slice(ug).some((r) => r.kind === 'file' && r.fid.endsWith('IdempotencyKey.java')));
  // a part on unchanged lines shows those lines
  ann.groups[1].parts.push({ ref: { path: '../remotes/refund-service-seed', file: 'src/main/java/shop/refund/Legacy.java', lines: '3-4' }, role: 'docs' });
  const c2 = { ann, ...(await checkAnnotations(ann, ws)) };
  const rows2 = buildRows(ws, { marks: {}, comments: [] }, { width: 100, tint: false, lens: 'groups', ann: c2 });
  assert.match(rows2.filter((r) => r.kind === 'cited').map((r) => plain(r.segs)).join('\n'), /4 +\/\/ old refund path/);
});

// ---------- theme ----------

test('theme: colours from the terminal, light or dark, with fallbacks', async () => {
  const { parseRgb, fallbackColors, makeStyles, isLight } = await import('../src/ui/theme.mjs');
  assert.deepEqual(parseRgb('rgb:efef/f1f1/f5f5'), [239, 241, 245]);
  assert.deepEqual(parseRgb('rgb:1e/66/f5'), [30, 102, 245]);
  assert.equal(isLight(fallbackColors({ FR_BACKGROUND: 'light' }).bg), true);
  assert.equal(isLight(fallbackColors({ FR_BACKGROUND: '#1e1e2e' }).bg), false);
  assert.equal(isLight(fallbackColors({ COLORFGBG: '0;15' }).bg), true);
  assert.equal(isLight(fallbackColors({}).bg), false);
  // the tints are mixed from the theme's own background and colours
  const latte = makeStyles({ bg: [239, 241, 245], blue: [30, 102, 245] });
  assert.equal(latte.band, '48;2;219;227;245');
  const mocha = makeStyles({ bg: [30, 30, 46] });
  assert.notEqual(mocha.band, latte.band);
  assert.match(latte.riskhigh, /^1;38;2;239;241;245;48;2;/); // badge text in the background colour
});

// ---------- Markdown in annotations ----------

test('annotation prose is Markdown: rendered, not shown as markup', async () => {
  const ws = await loadWorkspace(dir);
  const ann = sampleAnnotations();
  const rows = buildRows(ws, { marks: {}, comments: [] }, { width: 100, tint: false, lens: 'groups', ann: { ann, ...(await checkAnnotations(ann, ws)) } });
  const t = text(rows);
  assert.match(t, /Refunds must be idempotent: a retried/); // **bold**: no asterisks
  assert.match(t, /• the gateway sends an idempotency key/); // a list
  assert.match(t, /1\. RefundRequest gains idempotencyKey/); // `code` in a numbered list
  assert.match(t, /the amount <= 0 check is gone/);
  assert.doesNotMatch(t, /\*\*|`/);
});

test('fr check warns about pasted code in prose, not about short snippets', async () => {
  const ws = await loadWorkspace(dir);
  const ann = sampleAnnotations();
  ann.groups[0].why = 'Short:\n\n```java\nseen.add(key);\n```\n\nLong:\n\n```java\na();\nb();\nc();\nd();\n```';
  const res = await checkAnnotations(ann, ws);
  const w = res.warnings.filter((x) => /pasted code/.test(x.msg));
  assert.equal(w.length, 1);
  assert.equal(w[0].at, 'groups[0].why');
  assert.match(w[0].msg, /4 lines of pasted code/);
  assert.deepEqual(res.errors, []);
});

test("bat's theme follows a light or dark terminal unless BAT_THEME is set", async () => {
  const { setBatBackground, batThemeNow } = await import('../src/md/highlight.mjs');
  setBatBackground(true, {});
  assert.equal(batThemeNow(), 'GitHub');
  setBatBackground(true, { BAT_THEME_LIGHT: 'Catppuccin Latte' });
  assert.equal(batThemeNow(), 'Catppuccin Latte');
  setBatBackground(false, {});
  assert.equal(batThemeNow(), null); // bat's default
  setBatBackground(true, { BAT_THEME: 'Nord' });
  assert.equal(batThemeNow(), null); // bat reads BAT_THEME itself
});

test('the intent shows on top in both lenses', async () => {
  const ws = await loadWorkspace(dir);
  const ann = sampleAnnotations();
  const checked = { ann, ...(await checkAnnotations(ann, ws)) };
  for (const lens of ['groups', 'services']) {
    const t = text(buildRows(ws, { marks: {}, comments: [] }, { width: 100, tint: false, lens, ann: checked }));
    assert.match(t, /Intent *\n *Refunds must be idempotent/, lens);
  }
});

// ---------- ghosts and test notes in place ----------

test('findings sit under their line in the diff; the test intent before its code; nothing is lost', async () => {
  const ws = await loadWorkspace(dir);
  const ann = sampleAnnotations();
  const checked = { ann, ...(await checkAnnotations(ann, ws)) };
  const rs = fileOf(ws, 'refund-service', 'RefundService.java').hunks[0].key;
  const spec = fileOf(ws, 'refund-service', 'RefundServiceSpec.groovy').hunks[0].key;
  for (const lens of ['groups', 'services']) {
    const rows = buildRows(ws, { marks: {}, comments: [] }, { width: 110, tint: false, lens, ann: checked });
    // the unchanged caller: under the changed line it depends on (new 4), the line marked
    const ghost = rows.findIndex((r) => /CALLER TO CHECK +refund-service-seed\/.*RefundService\.java:4-6/.test(plain(r.segs)));
    assert.ok(ghost > 0, `${lens}: the caller is shown`);
    assert.equal(rows[ghost].hunk, rs);
    assert.deepEqual(rows[ghost - 1].at, { old: null, new: 4 }, `${lens}: right under new line 4`);
    assert.match(plain(rows[ghost - 1].segs), /^▎? *▌/, `${lens}: the line is marked`);
    assert.ok(rows.slice(ghost + 1).some((r) => r.kind === 'code' && r.hunk === rs), `${lens}: inside the hunk, not after it`);
    // the agent's flag on the old line 11 of the spec, and fr's own on new line 12
    const flag = rows.findIndex((r) => /┃ +LOOSENED/.test(plain(r.segs)));
    assert.equal(rows[flag - 1].at?.old, 11);
    const fr = rows.findIndex((r) => /ASSERTION LOOSENED +0 → 3 wildcards/.test(plain(r.segs)));
    assert.equal(rows[fr - 1].at?.new, 12);
    // the intent comes before the test's code
    const intent = rows.findIndex((r) => /TEST INTENT +books a refund once per key/.test(plain(r.segs)));
    assert.equal(rows[intent].hunk, spec);
    assert.ok(intent < rows.findIndex((r) => r.kind === 'code' && r.hunk === spec));
    assert.match(text(rows), /NAME VS ASSERTION/); // a flag on no line stays with the intent
    // the agent's finding: under the last removed line it cites (old 9), all three marked
    const found = rows.findIndex((r) => /┃ +DELETED CHECK +The amount <= 0 check is gone/.test(plain(r.segs)));
    assert.equal(rows[found - 1].at?.old, 9, `${lens}: under old line 9`);
    const marked = rows.filter((r) => r.kind === 'code' && [7, 8, 9].includes(r.at?.old) && /▌/.test(plain(r.segs).slice(0, 4)));
    assert.equal(marked.length, 3, `${lens}: lines 7-9 marked`);
    assert.doesNotMatch(text(rows), /Other notes/);
  }
  // folded: the count on the title
  const folded = buildRows(ws, { marks: { [rs]: { at: 'x' } }, comments: [] }, { width: 110, tint: false, lens: 'services', ann: checked });
  assert.match(text(folded), /RefundService\.java.*✓ reviewed.*1 finding/);
  assert.doesNotMatch(text(folded), /Other notes/);
  // a caller depending on no changed line goes to "Other notes"
  const a2 = clone(ann);
  a2.ghosts[0].because = [{ path: '../remotes/refund-service-seed', file: 'src/main/java/shop/refund/Legacy.java', lines: '1' }];
  const c2 = { ann: a2, ...(await checkAnnotations(a2, ws)) };
  assert.match(text(buildRows(ws, { marks: {}, comments: [] }, { width: 110, tint: false, lens: 'groups', ann: c2 })), /Other notes[\s\S]*UNCHANGED/);
});

test('side by side: when one side wraps, the other side’s extra row leaves the number column untinted', async () => {
  const { codeView } = await import('../src/md/render.mjs');
  const long = 'x'.repeat(120);
  const rows = codeView({ groups: [{ lines: [{ t: '-', s: 'short()', old: 7, new: null }, { t: '+', s: long, old: null, new: 7 }] }], width: 110, layout: 'split', highlight: 'none' });
  assert.ok(rows.length > 1, 'the new side wraps');
  for (const r of rows) assert.ok(!/\b48;|bg\b/.test(r.segs[0][1] ?? '') || r.segs[0][0].trim(), `row ${rows.indexOf(r)}: no tint left of the code: ${JSON.stringify(r.segs[0])}`);
});
