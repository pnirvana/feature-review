import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSample, sampleAnnotations } from './fixture.mjs';
import { loadWorkspace } from '../src/workspace.mjs';
import { checkAnnotations } from '../src/annotations.mjs';
import { overviewRows, TABS } from '../src/overview.mjs';
import { plain } from '../src/md/term.mjs';

let top;
let ws;
before(async () => {
  top = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-overview-'));
  ws = await loadWorkspace(makeSample(top));
});
after(() => fs.rmSync(top, { recursive: true, force: true }));

const rows = async (ann, tab, opts) => overviewRows({ ann, ...(await checkAnnotations(ann, ws)) }, tab, { width: 110, ...opts });
const text = (rs) => rs.map((r) => plain(r.segs).trimEnd()).join('\n');

test('the sample: every tab has its entries, every citation resolves', async () => {
  const ann = sampleAnnotations();
  const res = await checkAnnotations(ann, ws);
  assert.deepEqual(res.errors, []);
  for (const t of TABS) assert.ok(t.count(ann) > 0, t.id);
});

test('design: the agent’s signals, facts fr notices, precedent, the opinion labelled', async () => {
  const t = text(await rows(sampleAnnotations(), 'design'));
  assert.match(t, /RefundService +CHANGED +domain/);
  assert.match(t, /PRIMITIVE CONCEPT\n.*the idempotency key is a bare String/);
  assert.match(t, /FR NOTICED +the responsibility needs an “and”/);
  assert.match(t, /FR NOTICED +a domain type now depends on infrastructure: Set<String> seen/);
  assert.match(t, /how the codebase does it\n.*Util\.java:3-5 +outside the feature/);
  assert.match(t, /the agent's opinion\n +An IdempotencyKey value object/);
  // fr does not repeat what the agent already flagged
  const a = sampleAnnotations();
  a.design[0].signals.push({ kind: 'domain-depends-on-infrastructure' });
  assert.doesNotMatch(text(await rows(a, 'design')), /FR NOTICED +a domain type/);
});

test('names: flagged names first, the codebase’s name beside them', async () => {
  const t = text(await rows(sampleAnnotations(), 'names'));
  const order = [...t.matchAll(/^ (\w+) +(field|type)/gm)].map((m) => m[1]);
  assert.deepEqual(order, ['seen', 'idempotencyKey', 'RefundRequest']);
  assert.match(t, /the codebase calls it processedRefunds: .*Legacy\.java:4/);
});

test('contracts: compatibility, the fields side by side, consumers changed or not', async () => {
  const t = text(await rows(sampleAnnotations(), 'contracts'));
  assert.match(t, /POST \/refunds +http +backward compatible +NO/);
  assert.match(t, /│ idempotencyKey │ String, required │ absent in old clients │/);
  assert.match(t, /RefundService\.java:4 +outside the feature +BROKEN +not changed/);
});

test('rollout: the order, what breaks while only some are deployed, configuration', async () => {
  const t = text(await rows(sampleAnnotations(), 'rollout'));
  assert.match(t, /deploy in this order +1\. refund-service +→ +2\. gateway/);
  assert.match(t, /HIGH +deployed gateway +not yet refund-service\n +refunds fail/);
  assert.match(t, /helm\/values\.yaml:1\n +replicaCount 2 → 3: the in-memory key set is per replica/);
});

test('citations: changed code is a jump target, other code expands in place', async () => {
  const ann = sampleAnnotations();
  const checked = { ann, ...(await checkAnnotations(ann, ws)) };
  const rs = overviewRows(checked, 'contracts', { width: 110 });
  const refs = rs.filter((r) => r.kind === 'ref');
  assert.ok(refs.find((r) => r.res.hunkId === 'gateway:H3' && r.res.units.length)); // the producer: in the change
  const other = refs.find((r) => r.res.external);
  assert.equal(other.res.units.length, 0);
  const open = overviewRows(checked, 'contracts', { width: 110, expanded: new Set([other.ref]) });
  assert.match(text(open), /4 +public void refund\(String orderId, long amount\) \{/);
});

test('empty sections say so; fr check checks the rollout', async () => {
  const a = sampleAnnotations();
  delete a.design;
  a.rollout.order = ['refund-service', 'billing'];
  a.rollout.partial[0].risk = 'severe';
  assert.match(text(await rows(a, 'design')), /The agent wrote no design notes/);
  const res = await checkAnnotations(a, ws);
  assert.ok(res.errors.some((e) => e.at === 'rollout.partial[0].risk'));
  assert.ok(res.warnings.some((w) => w.at === 'rollout.order[1]' && /"billing" is not a worktree/.test(w.msg)));
});
