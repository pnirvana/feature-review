import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSample } from './fixture.mjs';
import { parsePatch, hunkKey, discover, loadWorkspace, units, MANIFEST } from '../src/workspace.mjs';
import { readState, update, setMarks, addComment, locate } from '../src/state.mjs';
import { buildRows } from '../src/rows.mjs';
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
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ base: { gateway: 'feature-base' } }));
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
  assert.match(out, /━━ gateway feature\/idempotent-refunds base origin\/main/);
  assert.match(out, /R src\/main\/java\/shop\/refund\/Util\.java → src\/main\/java\/shop\/refund\/MoneyUtil\.java/);
  assert.match(out, /- {9}1 \* ledger\.book\('o1', -5\)|1 \* ledger\.book/);
});
