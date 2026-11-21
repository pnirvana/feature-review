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
    'src/main/java/a/Gate.java': cls('Gate', '    long f(long x) {\n        return x;\n    }\n'),
    '.gitignore': 'target/\n',
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
    'src/main/java/a/Gate.java': cls('Gate', '    long f(long x) {\n        if (x < 0) {\n            return 0;\n        }\n        return x;\n    }\n'),
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
  assert.match(text, /EXPECTED VALUE CHANGED[\s┃│▌]*10 → 20, with its code/);
  assert.doesNotMatch(text, /long sum = 0/); // the moved method is folded away
  assert.match(text, /return x \/ 5/); // the rest is not
});

test('a changed test comes right after its code, not in file order', () => {
  const rows = buildRows(ws, { marks: {}, comments: [] }, { width: 140, tint: false, lens: 'services' });
  const files = rows.filter((r) => r.kind === 'file').map((r) => plain(r.segs).match(/\S+\.(java|py)/)[0].split('/').pop());
  assert.deepEqual(files, ['app.py', 'Billing.java', 'Format.java', 'Gate.java', 'Orders.java', 'Price.java', 'Tax.java', 'TaxTest.java', 'Zone.java']);
  assert.deepEqual(ws.signals.codeOfTest.get('svc\0src/test/java/a/TaxTest.java'), ['svc\0src/main/java/a/Tax.java']);
});

// ---------- coverage ----------

import { parseJacoco, findReports } from '../src/coverage.mjs';

const jacoco = (files) =>
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd"><report name="svc"><sessioninfo id="x" start="1" dump="2"/><package name="a">${Object.entries(files)
    .map(([f, lines]) => `<sourcefile name="${f}">${lines.map(([nr, mi, ci, mb = 0, cb = 0]) => `<line nr="${nr}" mi="${mi}" ci="${ci}" mb="${mb}" cb="${cb}"/>`).join('')}</sourcefile>`)
    .join('')}</package></report>`;

test('JaCoCo: the report is read per file and line; reports are found in Maven and Gradle builds', () => {
  const m = parseJacoco(jacoco({ 'Tax.java': [[4, 0, 3]], 'Zone.java': [[4, 0, 2, 1, 1]] }));
  assert.deepEqual([...m.keys()], ['a/Tax.java', 'a/Zone.java']);
  assert.deepEqual(m.get('a/Zone.java').get(4), { mi: 0, ci: 2, mb: 1, cb: 1 });
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-jacoco-'));
  write(d, { 'core/target/site/jacoco/jacoco.xml': jacoco({}), 'api/build/reports/jacoco/test/jacocoTestReport.xml': jacoco({}), 'core/src/main/resources/jacoco.xml': '<report/>', 'core/target/site/jacoco/index.html': '' });
  assert.deepEqual(findReports(d).map((f) => path.relative(d, f)).sort(), ['api/build/reports/jacoco/test/jacocoTestReport.xml', 'core/target/site/jacoco/jacoco.xml']);
  fs.rmSync(d, { recursive: true, force: true });
});

test('coverage of the changed lines: marked in the gutter, summed per hunk; an older report is not trusted', async () => {
  const wt = path.join(top, 'feature', 'svc');
  const report = path.join(wt, 'target/site/jacoco/jacoco.xml');
  write(wt, { 'target/site/jacoco/jacoco.xml': jacoco({ 'Tax.java': [[4, 0, 3]], 'Price.java': [[4, 2, 0]], 'Zone.java': [[4, 0, 2, 1, 1]], 'Gate.java': [[4, 0, 2], [5, 0, 2, 1, 1], [6, 2, 0], [8, 0, 2]] }) });
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(report, later, later);
  const w = await loadWorkspace(path.join(top, 'feature'));
  const kinds = (file) => (w.signals.units.get(w.repos[0].files.find((f) => f.file === file).hunks[0].key) ?? []).map((x) => `${x.kind}: ${x.text}`);
  assert.deepEqual(kinds('src/main/java/a/Tax.java'), ['covered: a test runs all 1 changed lines']);
  assert.deepEqual(kinds('src/main/java/a/Price.java'), ['not-covered: 1 of 1 changed lines · not run: 4']);
  // a branch not taken on a line that is no if: the dot alone says it
  assert.deepEqual(kinds('src/main/java/a/Zone.java'), ['partly-covered: 1 of 1 changed lines · branches not taken: 4']);
  // an if whose body never ran: never entered, said under it
  assert.deepEqual(kinds('src/main/java/a/Gate.java'), ['not-covered: 1 of 2 changed lines · not run: 6; branches not taken: 5', 'branch-not-taken: no test enters this if']);
  const gate = buildRows(w, { marks: {}, comments: [] }, { width: 140, tint: false, lens: 'services' });
  const callout = gate.findIndex((r) => /NEVER ENTERED +no test enters this if/.test(plain(r.segs)));
  assert.equal(gate[callout - 1].at?.new, 5); // under the if
  // side by side: under the new side, where its line and coverage mark are
  const divider = plain(gate[callout - 1].segs).indexOf('│');
  assert.ok(plain(gate[callout].segs).indexOf('┃') > divider, 'the note starts right of the divider');
  assert.equal(w.signals.reports.get('svc').length, 1);
  const rows = buildRows(w, { marks: {}, comments: [] }, { width: 140, tint: false, lens: 'services' });
  const priceLine = rows.find((r) => r.kind === 'code' && r.fid === 'svc\0src/main/java/a/Price.java' && r.at?.new === 4);
  // right after the new line's number: side by side, and inline
  const markAfter4 = (row) => row.segs.find((x, i) => i > 0 && /(^|\s)4$/.test(row.segs[i - 1][0]) && row.segs[i - 1][1] === 'gray' && /[●◐○]/.test(x[0]));
  assert.deepEqual(markAfter4(priceLine), ['○', 'delfg bold']);
  const unified = buildRows(w, { marks: {}, comments: [] }, { width: 140, tint: false, lens: 'services', layout: 'unified' });
  const priceNew = unified.find((r) => r.kind === 'code' && r.fid === 'svc\0src/main/java/a/Price.java' && r.at?.new === 4);
  assert.deepEqual(markAfter4(priceNew), ['○', 'delfg bold']);
  assert.ok(!priceLine.segs.some(([t]) => t === '┃')); // the divider stays plain
  assert.match(rows.map((r) => plain(r.segs)).join('\n'), /coverage: 1 report, 0m old/);
  // coverage alone: fr's other checks and their marks are left out, the coverage stays
  const only = buildRows(w, { marks: {}, comments: [] }, { width: 140, tint: false, lens: 'services', show: { agent: false, fr: false, comments: false } });
  const t = only.map((r) => plain(r.segs)).join('\n');
  assert.match(t, /NOT COVERED/);
  assert.match(t, /NEVER ENTERED/);
  assert.doesNotMatch(t, /TEST NOT CHANGED|EXPECTED VALUE CHANGED/);
  const noCov = buildRows(w, { marks: {}, comments: [] }, { width: 140, tint: false, lens: 'services', layout: 'unified', show: { coverage: false } });
  assert.ok(!noCov.some((r) => r.kind === 'code' && r.segs.some(([x]) => /[●◐○]/.test(x))));
  assert.doesNotMatch(noCov.map((r) => plain(r.segs)).join('\n'), /NOT COVERED/);

  // a report older than the file: its lines may have moved, nothing is marked
  const earlier = new Date(Date.now() - 3_600_000 * 5);
  fs.utimesSync(report, earlier, earlier);
  const w2 = await loadWorkspace(path.join(top, 'feature'));
  assert.deepEqual((w2.signals.files.get('svc\0src/main/java/a/Tax.java') ?? []).map((x) => x.kind), ['coverage-stale', 'test-changed']);
  assert.ok(!(w2.signals.units.get(w2.repos[0].files.find((f) => f.file === 'src/main/java/a/Tax.java').hunks[0].key) ?? []).some((x) => x.kind === 'covered'));
  fs.rmSync(path.join(wt, 'target'), { recursive: true, force: true });
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
  // kind, the line it is about (where the diff shows it), text
  return [...[...res.units.values()].flat(), ...res.file].map((s) => `${s.kind}${s.at ? ` @${s.at.side === 'old' ? '-' : '+'}${s.at.line}` : ''}: ${s.text}`);
}
const java = (body) => `class PriceTest {\n${body}}\n`;

test('JUnit: an exact check traded for a weaker one; a removed assertion', () => {
  assert.deepEqual(weakening('PriceTest.java', java('  @Test\n  void total() {\n    assertEquals(20, price.total());\n  }\n'), java('  @Test\n  void total() {\n    assertNotNull(price.total());\n  }\n')), ['loosened @+4: assertEquals → assertNotNull']);
  const r = weakening('PriceTest.java', java('  @Test\n  void total() {\n    var t = price.total();\n    assertEquals(20, t);\n    assertTrue(t > 0);\n  }\n'), java('  @Test\n  void total() {\n    var t = price.total();\n    assertTrue(t > 0);\n  }\n'));
  assert.deepEqual(r, ['assertion-removed @-5: 1 fewer in this hunk, 1 in the file', 'fewer-assertions: 2 → 1']);
});

test('Mockito and Spock: values traded for wildcards; an expected value changed', () => {
  assert.deepEqual(weakening('PriceTest.java', java('  void t() {\n    verify(ledger).book("o1", 5);\n  }\n'), java('  void t() {\n    verify(ledger).book(anyString(), anyLong());\n  }\n')), ['loosened @+3: 0 → 2 wildcards: any value matches']);
  const spec = (then) => `import spock.lang.Specification\nclass PriceSpec extends Specification {\n  def 'books it'() {\n    when:\n    service.run()\n\n    then:\n    ${then}\n  }\n}\n`;
  assert.deepEqual(weakening('PriceSpec.groovy', spec("1 * ledger.book('o1', 5)"), spec("1 * ledger.book('o1', 7)")), ['expected-changed @+8: 5 → 7']);
  // the when: block is not an assertion: changing it is not a removed assertion
  assert.equal(assertionLines(spec('x == 1'), 'spock').size, 1);
});

test('disabled, a catch-all, a longer timeout, a new test that asserts nothing', () => {
  assert.deepEqual(weakening('PriceTest.java', java('  @Test\n  void a() { assertEquals(1, a()); }\n'), java('  @Disabled\n  @Test\n  void a() { assertEquals(1, a()); }\n')), ['disabled @+2: @Disabled']);
  assert.deepEqual(weakening('test_price.py', 'def test_a():\n    assert a() == 1\n', '@pytest.mark.skip\ndef test_a():\n    assert a() == 1\n'), ['disabled @+1: @pytest.mark.skip']);
  assert.deepEqual(
    weakening('PriceTest.java', java('  @Test\n  void a() {\n    try { run(); } catch (IllegalStateException e) { fail(); }\n  }\n'), java('  @Test\n  void a() {\n    try { run(); } catch (Exception e) { fail(); }\n  }\n')),
    ['catch-all @+4: try { run(); } catch (Exception e) { fail(); }'],
  );
  assert.deepEqual(weakening('PriceTest.java', java('  @Timeout(2)\n  @Test\n  void a() { assertEquals(1, a()); }\n'), java('  @Timeout(10)\n  @Test\n  void a() { assertEquals(1, a()); }\n')), ['timeout @+2: 2 → 10']);
  assert.deepEqual(
    weakening('PriceTest.java', java('  @Test\n  void a() { assertEquals(1, a()); }\n'), java('  @Test\n  void a() { assertEquals(1, a()); }\n\n  @Test\n  void rejectsARefundOverTheTotal() {\n    assertDoesNotThrow(() -> refund(500));\n  }\n')),
    ['asserts-nothing @+5: “rejectsARefundOverTheTotal”'],
  );
  assert.deepEqual(weakening('test_price.py', 'def test_a():\n    assert a() == 1\n', 'def test_a():\n    assert a() == 1\n\ndef test_b():\n    b()\n'), ['asserts-nothing @+4: “test_b”']);
});

test('a stronger test raises nothing', () => {
  assert.deepEqual(weakening('PriceTest.java', java('  @Test\n  void a() {\n    assertNotNull(a());\n  }\n'), java('  @Test\n  void a() {\n    assertEquals(1, a());\n    assertEquals(2, b());\n  }\n')), []);
});
