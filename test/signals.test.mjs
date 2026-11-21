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
    'src/main/java/a/Zone.java': cls('Zone', '    String id() { return "eu"; }\n'),
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
    'src/main/java/a/Zone.java': cls('Zone', '    String id() { return "us"; }\n'),
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
  assert.deepEqual(sig(idOf('src/test/java/a/TaxTest.java')[0]), ['expected-changed']); // 10 → 20, with its code
  assert.match(ws.signals.units.get(unitIds(ws).find((u) => u.f.file === 'src/test/java/a/TaxTest.java').unit)[0].text, /^10 → 20, with its code \(Tax\.java\)/);
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
  assert.match(text, /EXPECTED VALUE CHANGED +10 → 20, with its code \(Tax\.java\)/);
  assert.doesNotMatch(text, /long sum = 0/); // the moved method is folded away
  assert.match(text, /return x \/ 5/); // the rest is not
});

test('a changed test comes right after its code, not in file order', () => {
  const rows = buildRows(ws, { marks: {}, comments: [] }, { width: 140, tint: false, lens: 'services' });
  const files = rows.filter((r) => r.kind === 'file').map((r) => plain(r.segs).match(/\S+\.(java|py)/)[0].split('/').pop());
  assert.deepEqual(files, ['app.py', 'Billing.java', 'Format.java', 'Orders.java', 'Price.java', 'Tax.java', 'TaxTest.java', 'Zone.java']);
  assert.deepEqual(ws.signals.codeOfTest.get('svc\0src/test/java/a/TaxTest.java'), ['svc\0src/main/java/a/Tax.java']);
});

// ---------- assertion heuristics ----------

import { testSignals, assertionLines } from '../src/asserts.mjs';
import { parsePatch } from '../src/workspace.mjs';

/** The signals of a test file changed from `old` to `now`: → [kind: text] of every hunk, then the file's. */
function weakening(file, old, now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-asserts-'));
  const a = path.join(dir, 'a');
  const b = path.join(dir, 'b');
  fs.writeFileSync(a, old);
  fs.writeFileSync(b, now);
  let diff = '';
  try {
    execFileSync('git', ['diff', '--no-index', '-U3', a, b], { env: ENV });
  } catch (e) {
    diff = e.stdout.toString(); // exit 1: they differ
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const [f] = parsePatch(diff);
  f.hunks.forEach((h, i) => (h.key = `H${i + 1}`));
  const res = testSignals({ file, hunks: f.hunks }, { old, new: now });
  return [...[...res.units.values()].flat(), ...res.file].map((s) => `${s.kind}: ${s.text}`);
}
const java = (body) => `class PriceTest {\n${body}}\n`;

test('JUnit: an exact check traded for a weaker one; a removed assertion', () => {
  assert.deepEqual(weakening('PriceTest.java', java('  @Test\n  void total() {\n    assertEquals(20, price.total());\n  }\n'), java('  @Test\n  void total() {\n    assertNotNull(price.total());\n  }\n')), ['loosened: assertEquals → assertNotNull']);
  const r = weakening('PriceTest.java', java('  @Test\n  void total() {\n    var t = price.total();\n    assertEquals(20, t);\n    assertTrue(t > 0);\n  }\n'), java('  @Test\n  void total() {\n    var t = price.total();\n    assertTrue(t > 0);\n  }\n'));
  assert.deepEqual(r, ['assertion-removed: 1 fewer here: assertEquals(20, t);', 'fewer-assertions: 2 → 1']);
});

test('Mockito and Spock: values traded for wildcards; an expected value changed', () => {
  assert.deepEqual(weakening('PriceTest.java', java('  void t() {\n    verify(ledger).book("o1", 5);\n  }\n'), java('  void t() {\n    verify(ledger).book(anyString(), anyLong());\n  }\n')), ['loosened: 0 → 2 wildcards (any value matches): verify(ledger).book(anyString(), anyLong());']);
  const spec = (then) => `import spock.lang.Specification\nclass PriceSpec extends Specification {\n  def 'books it'() {\n    when:\n    service.run()\n\n    then:\n    ${then}\n  }\n}\n`;
  assert.deepEqual(weakening('PriceSpec.groovy', spec("1 * ledger.book('o1', 5)"), spec("1 * ledger.book('o1', 7)")), ['expected-changed: 5 → 7']);
  // the when: block is not an assertion: changing it is not a removed assertion
  assert.equal(assertionLines(spec('x == 1'), 'spock').size, 1);
});

test('disabled, a catch-all, a longer timeout, a new test that asserts nothing', () => {
  assert.deepEqual(weakening('PriceTest.java', java('  @Test\n  void a() { assertEquals(1, a()); }\n'), java('  @Disabled\n  @Test\n  void a() { assertEquals(1, a()); }\n')), ['disabled: @Disabled']);
  assert.deepEqual(weakening('test_price.py', 'def test_a():\n    assert a() == 1\n', '@pytest.mark.skip\ndef test_a():\n    assert a() == 1\n'), ['disabled: @pytest.mark.skip']);
  assert.deepEqual(
    weakening('PriceTest.java', java('  @Test\n  void a() {\n    try { run(); } catch (IllegalStateException e) { fail(); }\n  }\n'), java('  @Test\n  void a() {\n    try { run(); } catch (Exception e) { fail(); }\n  }\n')),
    ['catch-all: try { run(); } catch (Exception e) { fail(); }'],
  );
  assert.deepEqual(weakening('PriceTest.java', java('  @Timeout(2)\n  @Test\n  void a() { assertEquals(1, a()); }\n'), java('  @Timeout(10)\n  @Test\n  void a() { assertEquals(1, a()); }\n')), ['timeout: 2 → 10']);
  assert.deepEqual(
    weakening('PriceTest.java', java('  @Test\n  void a() { assertEquals(1, a()); }\n'), java('  @Test\n  void a() { assertEquals(1, a()); }\n\n  @Test\n  void rejectsARefundOverTheTotal() {\n    assertDoesNotThrow(() -> refund(500));\n  }\n')),
    ['asserts-nothing: “rejectsARefundOverTheTotal”'],
  );
  assert.deepEqual(weakening('test_price.py', 'def test_a():\n    assert a() == 1\n', 'def test_a():\n    assert a() == 1\n\ndef test_b():\n    b()\n'), ['asserts-nothing: “test_b”']);
});

test('a stronger test raises nothing', () => {
  assert.deepEqual(weakening('PriceTest.java', java('  @Test\n  void a() {\n    assertNotNull(a());\n  }\n'), java('  @Test\n  void a() {\n    assertEquals(1, a());\n    assertEquals(2, b());\n  }\n')), []);
});
