// Peek (p): what an annotation points at, and the file around it with the change in place.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSample } from './fixture.mjs';
import { loadWorkspace } from '../src/workspace.mjs';
import { mentionsIn, refsIn, peekLines, targetsFor, peekChoices } from '../src/peek.mjs';
import { plain } from '../src/md/term.mjs';

let top;
let ws;
before(async () => {
  top = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-peek-'));
  ws = await loadWorkspace(makeSample(top));
});
after(() => fs.rmSync(top, { recursive: true, force: true }));

test('mentions: paths with lines, types and members in backticks or plain prose; not file names, not common types', () => {
  const m = mentionsIn({
    note: 'See refund-service/src/main/java/shop/refund/RefundService.java:4-6 and `values.yaml`; `RefundService.refund()` takes a `String`, unlike LegacyRefunds.book in Util.java (e.g. here).',
    ref: { repo: 'x', file: 'Ignored.java', lines: '1' },
  });
  assert.deepEqual(m.paths, [
    { file: 'refund-service/src/main/java/shop/refund/RefundService.java', from: 4, to: 6 },
    { file: 'values.yaml', from: null, to: null },
    { file: 'Util.java', from: null, to: null },
  ]);
  assert.deepEqual(m.symbols, [
    { type: 'RefundService', member: 'refund' },
    { type: 'LegacyRefunds', member: 'book' },
  ]);
  assert.equal(refsIn([{ a: { ref: { hunk: 'g:H1' } } }, { repo: 'r', file: 'f', lines: '1' }]).length, 2);
});

test('a file in the change: the whole file, its removed lines in place, numbered on both sides', async () => {
  const rs = ws.repos.find((r) => r.name === 'refund-service');
  const t = { repo: 'refund-service', dir: rs.dir, file: 'src/main/java/shop/refund/RefundService.java', side: 'new', rev: null, from: 4, to: 4, units: ['x'] };
  const { lines, diff } = await peekLines(ws, t);
  assert.ok(diff);
  const text = fs.readFileSync(path.join(rs.dir, t.file), 'utf8').replace(/\n$/, '').split('\n');
  // every line of the file, in order, numbered on the new side
  assert.deepEqual(lines.filter((l) => l.t !== '-').map((l) => l.s), text);
  assert.deepEqual(lines.filter((l) => l.t !== '-').map((l) => l.new), text.map((_, i) => i + 1));
  const removed = lines.filter((l) => l.t === '-');
  assert.ok(removed.length && removed.every((l) => l.old != null && l.new == null));
  // unchanged lines after a change keep their base numbers
  const last = lines[lines.length - 1];
  assert.equal(last.t, ' ');
  assert.ok(last.old != null);
  // the base side: the file at the merge base, the added lines in place
  const old = await peekLines(ws, { ...t, side: 'old', rev: rs.base });
  assert.deepEqual(old.lines.filter((l) => l.t !== '+').map((l) => l.old), old.lines.filter((l) => l.t !== '+').map((_, i) => i + 1));
});

test('targets: citations first, then files named, then declarations found by name; a mention of a cited file adds nothing', async () => {
  const RS = 'src/main/java/shop/refund/RefundService.java';
  const ref = { repo: 'refund-service', file: RS, lines: '4' };
  const res = { ok: true, repo: 'refund-service', file: RS, side: 'new', from: 4, to: 4, units: ['u'] };
  const checked = { refs: new Map([[ref, res]]) };
  const { targets } = await targetsFor(ws, checked, { ref, note: `${RS}:4 is called by \`RefundController.refund\`; see helm/values.yaml` });
  assert.deepEqual(
    targets.map((t) => [t.how, t.repo, path.basename(t.file), t.from]),
    [
      ['cited', 'refund-service', 'RefundService.java', 4],
      ['named', 'refund-service', 'values.yaml', null],
      ['found', 'gateway', 'RefundController.java', targets[2].from],
    ],
  );
  assert.ok(targets[2].from > 1);
});

test('names in backticks in lower case: the declarations of that method or field, not its calls', async () => {
  const { targets } = await targetsFor(ws, null, { note: 'the gateway calls `refund()`; `ledger.book` is declared nowhere here' });
  const found = targets.map((t) => `${t.repo}/${path.basename(t.file)}:${t.from}`);
  assert.deepEqual(found.sort(), ['gateway/RefundController.java:6', 'refund-service/RefundService.java:4']);
  assert.ok(targets.every((t) => t.how === 'found' && t.symbol === 'refund'));
});

test('the row under the cursor first: its paths, and the names of the note that stand on it, in their order', async () => {
  const src = { why: '1. `RefundRequest` gains `idempotencyKey`\n2. `RefundService.refund` skips a key it has *seen*' };
  // the row as rendered: no backticks
  const { targets } = await targetsFor(ws, null, src, { row: '2. RefundService.refund skips a key it has seen' });
  assert.equal(targets[0].row, true);
  assert.equal(`${targets[0].symbol} ${path.basename(targets[0].file)}:${targets[0].from}`, 'RefundService.refund RefundService.java:4');
  // the rest of the note after it
  assert.ok(targets.some((t) => !t.row && t.symbol === 'RefundRequest'));
  // a path on the row comes first even when the note cites the same lines
  const RS = 'src/main/java/shop/refund/RefundService.java';
  const ref = { repo: 'refund-service', file: RS, lines: '4-8' };
  const checked = { refs: new Map([[ref, { ok: true, repo: 'refund-service', file: RS, side: 'new', from: 4, to: 8, units: ['u'] }]]) };
  const r2 = await targetsFor(ws, checked, { ref, note: `see refund-service/${RS}:5` }, { row: `see refund-service/${RS}:5` });
  assert.deepEqual(r2.targets.map((t) => [t.how, t.from, Boolean(t.row)]), [['named', 5, true], ['cited', 4, false]]);
});

test('several places on the row: in the order they stand there, files and names alike; the pane lists them', async () => {
  const RS = 'refund-service/src/main/java/shop/refund/RefundService.java';
  const src = { note: `\`RefundRequest\` reaches ${RS}:5, which calls \`refund()\`` };
  const { targets } = await targetsFor(ws, null, src, { row: `RefundRequest reaches ${RS}:5, which calls refund()` });
  const row = targets.filter((t) => t.row);
  // the type, then the file, then the method: never the file first because it is a file
  assert.deepEqual([...new Set(row.map((t) => t.named))], ['RefundRequest', `${RS}:5`, 'refund']);
  // the list under the title: numbered, a name twice (refund in two classes) says where
  const line = plain(peekChoices(targets, 1, 200));
  assert.match(line, /1 RefundRequest .*2 RefundService\.java:5 .*3 refund \w+\.java:\d+/);
  assert.equal(peekChoices(targets.slice(0, 1), 0, 200), null);
});
