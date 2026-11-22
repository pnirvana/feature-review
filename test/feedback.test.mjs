// The feedback log and its report (fr feedback).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordFeedback, readFeedback, summarize, feedbackReport, parseSince, feedbackPath, aboutRow } from '../src/feedback.mjs';

test('entries are appended and read back; a bad line is skipped, not fatal', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-fb-'));
  const file = path.join(d, 'sub', 'feedback.jsonl');
  assert.deepEqual(readFeedback(file), { entries: [], bad: 0 });
  recordFeedback(file, { verdict: 'helped', about: 'fr:not-covered', feature: '/x/f1', text: 'NOT COVERED' });
  fs.appendFileSync(file, 'not json\n');
  recordFeedback(file, { verdict: 'wrong', note: 'it is a DTO', about: 'fr:no-test', feature: '/x/f2', repo: 'billing', file: 'A.java', line: { side: 'new', n: 3 } });
  assert.throws(() => recordFeedback(file, { verdict: 'meh' }), /use helped, missing, wrong/);
  const { entries, bad } = readFeedback(file);
  assert.equal(entries.length, 2);
  assert.equal(bad, 1);
  assert.ok(entries[0].at && entries[0].v === 1);
  const report = feedbackReport(entries, { bad });
  assert.match(report, /2 entries on 2 features/);
  assert.match(report, /fr:no-test +· +· +1/);
  assert.match(report, /WRONG \(1\)[\s\S]*f2  billing\/A\.java:\+3\n {6}it is a DTO/);
  assert.match(report, /1 unreadable line skipped/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('summarize counts by kind, most first', () => {
  const s = summarize([{ verdict: 'helped', about: 'a' }, { verdict: 'wrong', about: 'b' }, { verdict: 'missing', about: 'b' }]);
  assert.deepEqual(s.map((x) => [x.about, x.helped, x.missing, x.wrong]), [['b', 0, 1, 1], ['a', 1, 0, 0]]);
});

test('since, the log path, the kind of a row', () => {
  const now = Date.parse('2026-11-22T00:00:00Z');
  assert.equal(parseSince('2w', now), now - 14 * 86400e3);
  assert.equal(parseSince('2026-11-01', now), Date.parse('2026-11-01'));
  assert.throws(() => parseSince('soon'), /--since soon/);
  assert.equal(feedbackPath({ XDG_STATE_HOME: '/s' }), '/s/feature-review/feedback.jsonl');
  assert.equal(feedbackPath({}, '/mine.jsonl'), '/mine.jsonl');
  assert.equal(aboutRow({ kind: 'note', about: 'fr:moved' }), 'fr:moved');
  assert.equal(aboutRow({ kind: 'code' }), 'code');
  assert.equal(aboutRow({ kind: 'note', group: 'g1' }), 'agent:group');
  assert.match(feedbackReport([]), /no feedback yet/);
});
