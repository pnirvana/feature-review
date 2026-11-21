// The cheap objective signals (src/signals.mjs): verified mechanical changes, tests and code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { whitespaceOnly, testSubject } from '../src/signals.mjs';
import { loadWorkspace } from '../src/workspace.mjs';
import { unitIds } from '../src/annotations.mjs';
import { buildRows } from '../src/rows.mjs';
import { plain } from '../src/md/term.mjs';

const L = (spec) => spec.map(([t, s]) => [t, s]);

test('whitespace only: re-indented and re-wrapped, but not a changed word', () => {
  assert.ok(whitespaceOnly(L([['-', '  if (a) {'], ['-', '    run(a, b);'], ['+', 'if (a) {'], ['+', '\trun(a,'], ['+', '\t    b);']]), 'X.java'));
  assert.ok(whitespaceOnly(L([['+', ''], ['+', '   ']]), 'X.java')); // blank lines only
  assert.ok(!whitespaceOnly(L([['-', 'run(a, b);'], ['+', 'run(a, c);']]), 'X.java'));
  assert.ok(!whitespaceOnly(L([['-', 'ab'], ['+', 'a b']]), 'X.java')); // words split
});

test('whitespace only: indentation counts in Python and YAML', () => {
  const lines = L([['-', 'if a:'], ['-', '    run()'], ['+', 'if a:'], ['+', 'run()']]);
  assert.ok(!whitespaceOnly(lines, 'app.py'));
  assert.ok(!whitespaceOnly(L([['-', 'a:'], ['-', '  b: 1'], ['+', 'a:'], ['+', 'b: 1']]), 'values.yaml'));
  assert.ok(whitespaceOnly(L([['-', 'x =  1  '], ['+', 'x = 1']]), 'app.py'));
});

test('test files and what they test', () => {
  assert.equal(testSubject('src/test/java/a/PriceTest.java'), 'Price');
  assert.equal(testSubject('src/test/groovy/a/PriceSpec.groovy'), 'Price');
  assert.equal(testSubject('src/it/java/a/PriceIT.java'), 'Price');
  assert.equal(testSubject('tests/test_price.py'), 'price');
  assert.equal(testSubject('pkg/price_test.py'), 'price');
  assert.equal(testSubject('web/price.spec.ts'), 'price');
  assert.equal(testSubject('src/test/java/a/Fixtures.java'), null); // a test that names no subject
  assert.equal(testSubject('src/main/java/a/Price.java'), undefined);
  assert.equal(testSubject('helm/values.yaml'), undefined);
});

// ---------- a change with each signal ----------

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'S', GIT_AUTHOR_EMAIL: 's@example.invalid', GIT_COMMITTER_NAME: 'S', GIT_COMMITTER_EMAIL: 's@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const write = (dir, files) => {
  for (const [p, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), t);
  }
};
const cls = (name, body) => `package a;\n\npublic class ${name} {\n${body}}\n`;
const TOTAL = '    long total(List<Line> lines) {\n        long sum = 0;\n        for (Line l : lines) sum += l.price() * l.quantity();\n        return sum;\n    }\n';

let top;
let ws;
const sig = (id) => {
  const u = unitIds(ws).find((x) => x.id === id);
  return (ws.signals.units.get(u.unit) ?? []).map((s) => s.kind);
};
const fileSig = (file) => (ws.signals.files.get(`svc\0${file}`) ?? []).map((s) => s.kind);
const idOf = (file) => unitIds(ws).filter((u) => u.f.file === file).map((u) => u.id);

before(async () => {
  top = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-signals-'));
  const wt = path.join(top, 'feature', 'svc');
  fs.mkdirSync(wt, { recursive: true });
  sh(wt, 'init', '-q', '-b', 'main');
  write(wt, {
    'src/main/java/a/Orders.java': cls('Orders', `    void place() {}\n\n${TOTAL}`),
    'src/main/java/a/Billing.java': cls('Billing', '    void bill() {}\n'),
    'src/main/java/a/Format.java': cls('Format', '    String f(int a, int b) { return a + "," + b; }\n'),
    'src/main/java/a/Price.java': cls('Price', '    long of(long x) { return x; }\n'),
    'src/test/java/a/PriceTest.java': cls('PriceTest', '    void t() { assertEquals(1, new Price().of(1)); }\n'),
    'src/main/java/a/Tax.java': cls('Tax', '    long of(long x) { return x / 10; }\n'),
    'src/test/java/a/TaxTest.java': cls('TaxTest', '    void t() { assertEquals(10, new Tax().of(100)); }\n'),
    'app.py': 'def run(a):\n    if a:\n        go()\n    done()\n',
  });
  sh(wt, 'add', '-A');
  sh(wt, 'commit', '-q', '-m', 'base');
  sh(wt, 'switch', '-q', '-c', 'feature');
  write(wt, {
    'src/main/java/a/Orders.java': cls('Orders', '    void place() {}\n'), // total() moves out …
    'src/main/java/a/Billing.java': cls('Billing', `    void bill() {}\n\n${TOTAL}`), // … to Billing
    'src/main/java/a/Format.java': cls('Format', '    String f(int a,\n             int b) {\n        return a + "," + b;\n    }\n'),
    'src/main/java/a/Price.java': cls('Price', '    long of(long x) { return x * 2; }\n'),
    'src/main/java/a/Tax.java': cls('Tax', '    long of(long x) { return x / 5; }\n'),
    'src/test/java/a/TaxTest.java': cls('TaxTest', '    void t() { assertEquals(20, new Tax().of(100)); }\n'),
    'app.py': 'def run(a):\n    if a:\n        go()\n        done()\n',
  });
  write(path.join(top, 'feature'), { 'feature-review.toml': 'base = "main"\n' });
  ws = await loadWorkspace(path.join(top, 'feature'));
});
after(() => fs.rmSync(top, { recursive: true, force: true }));

test('moved code is verified mechanical on both sides, and says where it went', () => {
  const [from] = idOf('src/main/java/a/Orders.java');
  const [to] = idOf('src/main/java/a/Billing.java');
  assert.deepEqual(sig(from), ['moved']);
  assert.deepEqual(sig(to), ['moved']);
  const s = ws.signals.units.get(unitIds(ws).find((u) => u.id === from).unit)[0];
  assert.equal(s.text, `to ${to}`);
});

test('a re-wrapped method is whitespace only; an indentation change in Python is not', () => {
  assert.deepEqual(sig(idOf('src/main/java/a/Format.java')[0]), ['whitespace']);
  assert.deepEqual(sig(idOf('app.py')[0]), []);
});

test('tests and code: an existing test changed with its code; code whose test did not change', () => {
  assert.deepEqual(sig(idOf('src/test/java/a/TaxTest.java')[0]), ['test-with-code']);
  assert.deepEqual(fileSig('src/main/java/a/Tax.java'), ['test-changed']);
  assert.deepEqual(fileSig('src/test/java/a/TaxTest.java'), ['tests']);
  assert.deepEqual(fileSig('src/main/java/a/Price.java'), ['test-unchanged']);
  assert.deepEqual(fileSig('src/main/java/a/Billing.java'), []); // only moved code arrived
  assert.deepEqual(fileSig('app.py'), ['no-test']);
  // mechanical changes need no test
  assert.deepEqual(fileSig('src/main/java/a/Orders.java'), []);
  assert.deepEqual(fileSig('src/main/java/a/Format.java'), []);
});

test('the review shows the signals, and folds verified mechanical hunks', () => {
  const rows = buildRows(ws, { marks: {}, comments: [] }, { width: 140, tint: false });
  const text = rows.map((r) => plain(r.segs)).join('\n');
  assert.match(text, /Orders\.java .*MECHANICAL {2}verified: moved/);
  assert.match(text, /Format\.java .*MECHANICAL {2}verified: whitespace only/);
  assert.match(text, /EXISTING TEST CHANGED {2}with its code \(Tax\.java\)/);
  assert.doesNotMatch(text, /long sum = 0/); // the moved method is folded away
  assert.match(text, /return x \/ 5/); // the rest is not
});
