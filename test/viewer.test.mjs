// The viewer driven through a fake terminal: keys in, screens out. Covers what only shows
// when a person uses it (keys reach the viewer, the review flow, the lens switch).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { makeSample, sampleAnnotations } from './fixture.mjs';
import { buildRows } from '../src/rows.mjs';
import { runViewer } from '../src/viewer.mjs';
import { readState } from '../src/state.mjs';
import { plain } from '../src/md/term.mjs';
import { readFeedback } from '../src/feedback.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rowText = (r) => plain(r?.segs ?? []).trim();

/** A terminal of cols × rows: type() sends keys, screen() is what is shown now. */
function fakeTerminal(cols = 110, rows = 24) {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(v) { this.isRaw = v; } });
  let written = '';
  const output = new Writable({
    write(chunk, _enc, cb) {
      written += chunk;
      cb();
    },
  });
  Object.assign(output, { isTTY: true, columns: cols, rows });
  return {
    input,
    output,
    /** Send keys one by one, as a person types them, and let the viewer draw. */
    async type(...keys) {
      for (const k of keys) {
        input.write(k);
        await sleep(15);
      }
    },
    /** The last frame drawn, as plain lines. */
    screen() {
      const frame = written.split('\x1b[H').pop();
      return frame.replace(/\x1b\[[\d;?]*[A-Za-z]/g, '').split('\r\n');
    },
    /** The last frame as drawn, escape codes and all, by row. */
    raw() {
      return written.split('\x1b[H').pop().split('\r\n');
    },
    /** The line the cursor is on, and its row on the screen. */
    cursor() {
      const lines = this.screen();
      const row = lines.findIndex((l) => l.startsWith('▌'));
      return { row, text: (lines[row] ?? '').trimEnd() }; // its highlight pads it to the width
    },
    /** The footer's location line (repo/file:line of the cursor). */
    where() {
      return this.screen().filter((l) => l.trim()).pop().trim();
    },
  };
}

let top;
let dir;
const open = [];
before(() => {
  top = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-viewer-'));
  dir = makeSample(top);
  fs.mkdirSync(path.join(dir, '.feature-review'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.feature-review', 'annotations.json'), JSON.stringify(sampleAnnotations(), null, 2));
});
after(() => {
  for (const v of open) v.close();
  fs.rmSync(top, { recursive: true, force: true });
});

async function viewer(opts = {}) {
  fs.rmSync(path.join(dir, '.feature-review', 'state.json'), { force: true });
  const term = fakeTerminal(opts.cols, opts.rows);
  let exited = null;
  const v = await runViewer({ dir, layout: opts.layout ?? 'auto', feedbackFile: path.join(top, 'feedback.jsonl'), highlight: opts.highlight ?? 'none', hlBudget: opts.hlBudget, editor: opts.editor ?? '', queryTheme: false, viMode: opts.viMode ?? false, env: opts.env ?? {}, askAgent: opts.askAgent, input: term.input, output: term.output, exit: (c) => (exited = c) });
  open.push(v);
  return { term, v, exited: () => exited };
}

test('highlighting: the files near the screen as they come into view, within a budget of lines', async () => {
  const settle = async (v) => {
    for (let i = 0; i < 100 && (v.ui.highlighting || !v.ui.hl.size); i++) await new Promise((r) => setTimeout(r, 20));
  };
  const files = (v) => [...new Set(v.ui.rows.map((r) => r.fid).filter(Boolean))];
  const { term, v } = await viewer({ rows: 12, cols: 130, layout: 'unified', highlight: 'builtin' });
  await settle(v);
  const all = files(v);
  const first = all.find((f) => v.ui.hl.has(f));
  assert.ok(first, 'a file on screen is highlighted');
  assert.ok(all.some((f) => !v.ui.hl.has(f)), 'a file far below is not, yet');
  await term.type('G');
  await settle(v);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(v.ui.hl.has(all.findLast((f) => v.ui.rows.some((r) => r.fid === f && r.kind === 'code'))), 'the last file, once in view');
  // within the budget: the files seen longest ago go back to plain
  const small = await viewer({ rows: 12, cols: 130, layout: 'unified', highlight: 'builtin', hlBudget: 1 });
  await settle(small.v);
  const was = [...small.v.ui.hl.keys()];
  await small.term.type('G');
  await settle(small.v);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(was.some((f) => !small.v.ui.hl.has(f)), 'a file seen before is let go');
});

test('keys reach the viewer: ? shows the help, q quits', async () => {
  const { term, exited } = await viewer();
  assert.match(term.screen()[0], /fr {2}feature {2}reviewed 0\/9 {2}groups/);
  await term.type('?');
  assert.ok(term.screen().some((l) => l.includes('fr: feature review')));
  await term.type('x', 'q');
  assert.equal(exited(), 0);
});

test('the review flow: ]u goes to a hunk not reviewed, v marks it and goes on', async () => {
  const { term } = await viewer();
  await term.type(']', 'u');
  assert.match(term.cursor().text, /▾ @@ -0,0 \+1,3 @@/); // group 1's first part: RefundRequest
  assert.match(term.where(), /gateway\/src\/main\/java\/shop\/gateway\/RefundRequest\.java/);
  await term.type('v');
  assert.equal(Object.keys(readState(dir).marks).length, 1);
  assert.match(term.where(), /RefundController\.java/); // on to the next
  assert.match(term.screen()[0], /reviewed 1\/9/);
});

test('v: the reviewed hunk folds where it is, the next one shows below it', async () => {
  const { term } = await viewer({ rows: 30 });
  await term.type(']', 'u', 'v', 'j', 'j', 'j'); // in RefundController's code
  await term.type('v');
  const s = term.screen();
  const reviewed = s.findIndex((l) => /@@ -2,11 \+2,8 @@.*✓ reviewed/.test(l));
  const cur = term.cursor().row;
  assert.ok(reviewed > 0 && reviewed < cur, `the reviewed hunk (${reviewed}) shows above the next one (${cur})`);
  assert.match(term.cursor().text, /@@ -1,7 \+1,9 @@/); // RefundService: the next not reviewed
});

test('v when the next hunk does not fit: its heading goes to the top', async () => {
  const { term } = await viewer({ rows: 14 });
  await term.type(']', 'u', 'v', 'j', 'v');
  const s = term.screen();
  assert.match(s.slice(1, 4).join('\n'), /IMPLEMENTATION +refund-service\/src\/main\/java\/shop\/refund\/RefundService\.java/);
  assert.match(term.cursor().text, /@@ -1,7 \+1,9 @@/);
});

test('v on a reviewed hunk: not reviewed again, the cursor stays on the same line', async () => {
  const { term } = await viewer({ rows: 24 });
  await term.type(']', 'u', 'v', '[', 'h'); // back on RefundRequest's folded hunk
  const before = term.cursor();
  assert.match(before.text, /@@ -0,0 \+1,3 @@ +✓ reviewed/);
  await term.type('v');
  const after = term.cursor();
  assert.equal(after.row, before.row);
  assert.match(after.text, /▾ @@ -0,0 \+1,3 @@$/);
  assert.ok(term.screen().some((l) => /public record RefundRequest/.test(l))); // unfolded below
  assert.equal(Object.keys(readState(dir).marks).length, 0);
});

test('tab keeps the cursor on the same line and the same screen row', async () => {
  const { term } = await viewer({ rows: 24 });
  await term.type(']', 'u', 'v', 'v'); // on to RefundService's hunk
  await term.type('j', 'j', 'j', 'j');
  const before = { where: term.where(), cursor: term.cursor() };
  assert.match(before.where, /RefundService\.java:[-+]\d+/);
  await term.type('\t');
  assert.match(term.screen()[0], /services/);
  assert.equal(term.where(), before.where);
  assert.equal(term.cursor().row, before.cursor.row);
  await term.type('\t');
  assert.match(term.screen()[0], /groups/);
  assert.equal(term.where(), before.where);
});

test('tab without annotations says why there is no other lens', async () => {
  const file = path.join(dir, '.feature-review', 'annotations.json');
  fs.renameSync(file, `${file}.away`);
  try {
    const { term } = await viewer();
    await term.type('\t');
    assert.match(term.screen()[0], /services/);
    assert.ok(term.screen().some((l) => l.includes('no groups: the agent writes them to')));
  } finally {
    fs.renameSync(`${file}.away`, file);
  }
});

test('gt goes from code to its test and back; ⏎ on a TESTS line too', async () => {
  const { term } = await viewer({ rows: 30 });
  await term.type('\t', '/', ...'RefundService.java', '\r', '\x1b'); // the services lens, on the code's file
  assert.match(term.cursor().text, /M {2}src\/main\/java\/shop\/refund\/RefundService\.java/);
  await term.type('g', 't');
  assert.match(term.cursor().text, /RefundServiceSpec\.groovy/);
  await term.type('g', 't');
  assert.match(term.cursor().text, /RefundService\.java/);
  await term.type('g', 't', 'j'); // on the spec's TESTS line (empty rows are skipped)
  assert.match(term.cursor().text, /TESTS +RefundService\.java, changed too/);
  await term.type('\r');
  assert.match(term.cursor().text, /M {2}src\/main\/java\/shop\/refund\/RefundService\.java/);
});

test('tab on a group heading goes to that group’s first hunk', async () => {
  const { term } = await viewer();
  await term.type(']', 'g', ']', 'g'); // group 2: the config
  assert.match(term.cursor().text, /2 {2}Longer refund timeout/);
  await term.type('\t');
  assert.match(term.where(), /gateway\/src\/main\/resources\/application\.yml/);
});

test('c comments on the line under the cursor', async () => {
  const { term } = await viewer();
  await term.type(']', 'u', 'j', 'j');
  const at = term.where();
  await term.type('c', ...'Why a record?', '\r');
  const c = readState(dir).comments;
  assert.equal(c.length, 1);
  assert.equal(c[0].text, 'Why a record?');
  assert.equal(`${c[0].repo}/${c[0].file}:${c[0].side === 'old' ? '-' : '+'}${c[0].line}`, at);
  assert.ok(term.screen().some((l) => l.includes('Why a record?')));
});

test('vi mode in the comment field: esc to normal mode, vi edits, ⏎ saves', async () => {
  const { term } = await viewer({ viMode: true });
  await term.type(']', 'u', 'j', 'c', ...'Why a record here?', '\x1b');
  assert.ok(term.screen().some((l) => l.includes('-- NORMAL --')));
  await term.type('0', 'c', 'w', ...'How', '\x1b', '\r');
  assert.deepEqual(readState(dir).comments.map((c) => c.text), ['How a record here?']);
});

test('m opens the overview; ⏎ on a citation of the change goes to that code; m goes back', async () => {
  const { term } = await viewer();
  await term.type('m');
  assert.match(term.screen()[0], /1 Design 2 +2 Names 3 +3 Contracts 1 +4 Rollout 1/);
  assert.match(term.cursor().text, /RefundService +CHANGED/);
  await term.type('3', 'j'); // contracts: the producer
  assert.match(term.cursor().text, /producer gateway\/.*RefundRequest\.java:1-3/);
  await term.type('\r');
  assert.match(term.screen()[0], /reviewed 0\/9 +groups/); // back in the review
  assert.match(term.where(), /gateway\/src\/main\/java\/shop\/gateway\/RefundRequest\.java:\+1/);
  await term.type('m'); // the overview opens where it was left
  assert.match(term.cursor().text, /POST \/refunds|producer/);
  await term.type('m');
  assert.match(term.screen()[0], /reviewed/);
});

test('in the overview, ⏎ on code outside the change shows it in place', async () => {
  const { term } = await viewer({ rows: 30 });
  await term.type('m', '3', 'G', 'k'); // the consumer in another checkout
  assert.match(term.cursor().text, /refund-service-seed\/.*RefundService\.java:4 +outside the feature/);
  await term.type('\r');
  assert.ok(term.screen().some((l) => /4 +public void refund\(String orderId, long amount\) \{/.test(l)));
  assert.match(term.screen()[0], /Contracts/); // still in the overview
});

test('the viewer picks up annotations the agent rewrites', async () => {
  const { term } = await viewer();
  const a = sampleAnnotations();
  a.groups[1].title = 'Timeout and replicas, rewritten';
  fs.writeFileSync(path.join(dir, '.feature-review', 'annotations.json'), JSON.stringify(a, null, 2));
  await sleep(1600); // the file is polled every second
  await term.type(']', 'g', ']', 'g');
  assert.match(term.cursor().text, /Timeout and replicas, rewritten/);
  fs.writeFileSync(path.join(dir, '.feature-review', 'annotations.json'), JSON.stringify(sampleAnnotations(), null, 2));
});

test('s switches side by side ↔ inline with one press each way', async () => {
  const { term } = await viewer({ cols: 130, rows: 40 });
  // a changed file's code (new files are always inline): line numbers on both sides of │
  const split = () => term.screen().some((l) => /\d+ .*│ +\d+ /.test(l));
  assert.match(term.screen()[0], /side by side \(auto\)/);
  await term.type(']', 'u', 'v'); // on to RefundController, a changed file
  assert.ok(split());
  await term.type('s');
  assert.match(term.screen()[0], /· inline/);
  assert.ok(!split());
  await term.type('s');
  assert.match(term.screen()[0], /· side by side/);
  assert.ok(split());
});

test('⏎ on an unchanged caller in the diff shows its code, again hides it', async () => {
  const { term } = await viewer({ rows: 40, cols: 130 });
  await term.type('/', ...'CALLER TO CHECK', '\r', '\x1b');
  assert.match(term.cursor().text, /CALLER TO CHECK .*⏎ show the code/);
  assert.match(term.screen()[term.cursor().row + 1], /RefundService\.java:4-6/); // the caller, below (shortened to fit)
  const seedLine = (l) => /4 +public void refund\(String orderId/.test(l) && /┃/.test(l);
  assert.ok(!term.screen().some(seedLine));
  await term.type('\r');
  assert.match(term.cursor().text, /⏎ hide the code/);
  assert.ok(term.screen().some(seedLine), term.screen().join('\n'));
  await term.type('\r');
  assert.ok(!term.screen().some(seedLine));
});

test('a hides the annotations and shows them again; the top line stays, the cursor keeps its line', async () => {
  const { term } = await viewer({ rows: 40, cols: 130 });
  await term.type('/', ...'seen.contains', '\r', '\x1b');
  // the first line on screen that stays (annotations hiding have a ┃ bar down their left)
  const firstLine = () => term.screen().slice(1).find((l) => l.replace(/[▎\s]/g, '') && !l.includes('┃'));
  const before = { where: term.where(), top: firstLine() };
  assert.ok(term.screen().some((l) => /CALLER TO CHECK/.test(l)));
  await term.type('a');
  assert.match(term.screen()[0], /annotations hidden/);
  assert.ok(!term.screen().some((l) => /CALLER TO CHECK|TEST CHANGED/.test(l)));
  assert.ok(term.screen().some((l) => /▌.*public void refund\(String orderId, long amount/.test(l))); // the mark stays
  assert.equal(term.where(), before.where);
  assert.equal(firstLine(), before.top); // what is below closes up, as a fold does
  await term.type('a');
  assert.ok(term.screen().some((l) => /CALLER TO CHECK/.test(l)));
});

test('a on a note that goes away: the next line that stays; a again: back on the note', async () => {
  const { term } = await viewer({ rows: 30, cols: 130 });
  await term.type('/', ...'none found by name', '\r', '\x1b'); // fr's note under RefundRequest's part
  assert.match(term.cursor().text, /NO TEST +none found by name/);
  await term.type('a');
  assert.match(term.cursor().text, /▾ @@ -0,0 \+1,3 @@/); // its hunk, the next line that stays
  assert.ok(term.screen().some((l) => /RefundService\.refund skips a key it has seen/.test(l))); // the group's why stays
  await term.type('a');
  assert.match(term.cursor().text, /NO TEST +none found by name/);
});

test('/ searches as you type; esc goes back to where it started', async () => {
  const { term } = await viewer({ rows: 30, cols: 130 });
  const start = term.where();
  await term.type('/', ...'seen.ad');
  assert.match(term.cursor().text, /seen\.add\(key\)/); // there before ⏎
  assert.match(term.screen().at(-1) + term.screen().join(''), /\/seen\.ad/);
  await term.type('\x1b');
  assert.equal(term.where(), start);
  await term.type('/', ...'IdempotencyKey', '\r');
  assert.match(term.cursor().text, /IdempotencyKey/);
});

test('f: show or hide kinds of markers, their notes and their marks', async () => {
  const { term } = await viewer({ rows: 40, cols: 130 });
  await term.type('/', ...'seen.contains', '\r', '\x1b');
  await term.type('f');
  assert.match(term.screen().join('\n'), /show: +1 agent ✓ +2 fr ✓ +3 coverage ✓ +4 comments ✓/);
  await term.type('1', '\x1b');
  assert.match(term.screen()[0], /only fr, coverage, comments/);
  assert.ok(!term.screen().some((l) => /CALLER TO CHECK/.test(l)));
  assert.ok(term.screen().some((l) => /TEST CHANGED|NO TEST/.test(l))); // fr's stay
  await term.type('f', '0', '\x1b');
  assert.ok(term.screen().some((l) => /CALLER TO CHECK/.test(l)));
  assert.doesNotMatch(term.screen()[0], /only/);
});

test('the cursor’s whole line is highlighted, across the width', async () => {
  const { term } = await viewer({ cols: 110 });
  const { row } = term.cursor();
  const line = term.raw()[row];
  assert.match(line, /\x1b\[48;[\d;]+m {20,}/, 'a background reaches the end of the line');
  assert.doesNotMatch(term.raw()[row + 1] ?? '', /\x1b\[48;[\d;]+m {20,}/);
});

test('! records feedback on what is under the cursor: the verdict, a note, what was shown', async () => {
  const log = path.join(top, 'feedback.jsonl');
  fs.rmSync(log, { force: true });
  const { term } = await viewer({ rows: 40, cols: 130 });
  await term.type('/', ...'CALLER TO CHECK', '\r', '\x1b');
  await term.type('!');
  assert.match(term.screen().join('\n'), /feedback on agent:ghost:unclear .*h helped .*m missing here .*w wrong/);
  await term.type('w', ...'the caller is fine', '\r');
  assert.match(term.screen().join('\n'), /feedback recorded: wrong · agent:ghost:unclear/);
  // esc on the note: nothing recorded
  await term.type('!', 'h', '\x1b');
  assert.match(term.screen().join('\n'), /feedback not recorded/);
  const { entries } = readFeedback(log);
  assert.equal(entries.length, 1);
  const [e] = entries;
  assert.equal(e.verdict, 'wrong');
  assert.equal(e.note, 'the caller is fine');
  assert.equal(e.about, 'agent:ghost:unclear');
  assert.equal(e.feature, dir);
  assert.ok(e.repo && e.file && e.hunk, JSON.stringify(e));
  assert.match(e.text, /CALLER TO CHECK/); // the whole finding as shown, not only its first row
  assert.ok(e.text.split('\n').length > 1, e.text);
});

test('! on a changed line: the line, its text; an empty note is fine', async () => {
  const log = path.join(top, 'feedback.jsonl');
  fs.rmSync(log, { force: true });
  const { term } = await viewer({ rows: 40, cols: 130, layout: 'unified' });
  await term.type('/', ...'amount, idempotencyKey);', '\r', '\x1b', '!', 'm', '\r');
  const { entries } = readFeedback(log);
  assert.equal(entries.length, 1);
  const [e] = entries;
  assert.equal(e.verdict, 'missing');
  assert.equal(e.note, undefined);
  assert.equal(e.about, 'code');
  assert.equal(e.repo, 'gateway');
  assert.deepEqual(e.line, { side: 'new', n: 7 });
  assert.match(e.quote, /return client\.refund\(orderId, amount, idempotencyKey\);/);
});

test('A asks the agent about the line under the cursor, in the multi-line field; in the overview, about the whole change', async () => {
  // outside herdr: it says what it needs
  const plainTerm = await viewer({ rows: 40, cols: 130 });
  await plainTerm.term.type('A');
  assert.match(plainTerm.term.screen().join('\n'), /A needs herdr/);

  const asked = [];
  const askAgent = async (q) => (asked.push(q), { name: 'fr-feature', pane: 'w:p2', started: asked.length === 1 });
  const { term, v } = await viewer({ rows: 40, cols: 130, layout: 'unified', env: { HERDR_PANE_ID: 'w:p1' }, askAgent });
  await term.type('/', ...'amount, idempotencyKey);', '\r', '\x1b', 'A');
  assert.match(term.screen().join('\n'), /ask the agent about gateway\/.*RefundController\.java:\+\d+: .*⏎ send · alt\+⏎ new line/);
  await term.type(...'why the key', '\x1b\r', ...'here?', '\r');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].question, 'why the key\nhere?');
  assert.match(asked[0].id, /^q-[0-9a-f]{6}$/);
  assert.equal(asked[0].root, dir);
  assert.equal(asked[0].target.repo, 'gateway');
  assert.equal(asked[0].target.line.side, 'new');
  assert.match(asked[0].target.quote, /amount, idempotencyKey\);/);
  assert.match(term.screen().join('\n'), /started fr-feature beside fr and asked it/);
  // in the overview: about the entry under the cursor
  await term.type('m', '1');
  while (!/RefundService/.test(plain(v.ui.ov.rows[v.ui.ov.cur].segs))) await term.type('j');
  await term.type('A');
  assert.match(term.screen().join('\n'), /ask the agent about Design · RefundService/);
  await term.type(...'what is risky?', '\r');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asked.length, 2);
  assert.equal(asked[1].target.overview.tab, 'Design');
  assert.equal(asked[1].target.overview.item, 'design:RefundService');
  assert.match(asked[1].target.overview.text, /Books a refund/);
  assert.match(term.screen().join('\n'), /asked fr-feature: the answer comes in its pane/);
  // in the Questions tab: the whole change
  await term.type('5', 'A', ...'and overall?', '\r');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asked[2].target, null);
  // esc: nothing asked
  await term.type('A', 'x', '\x1b');
  assert.equal(asked.length, 3);
});

test('a question asked on an overview entry: waiting, then answered, under that entry, not in the diff', async () => {
  const st0 = path.join(dir, '.feature-review', 'state.json');
  const annFile = path.join(dir, '.feature-review', 'annotations.json');
  const saved = fs.readFileSync(annFile, 'utf8');
  const asked = [];
  const { term, v } = await viewer({ rows: 50, cols: 130, layout: 'unified', env: { HERDR_PANE_ID: 'w:p1' }, askAgent: async (q) => (asked.push(q), { name: 'a', pane: 'p', started: false }) });
  // on a long entry, a paragraph near its top: the question shows under that paragraph, on screen
  const small = await viewer({ rows: 16, cols: 130, layout: 'unified', env: { HERDR_PANE_ID: 'w:p1' }, askAgent: async (q) => (asked.push(q), { name: 'a', pane: 'p', started: false }) });
  await small.term.type('m', '1');
  while (!/^Books a refund/.test(plain(small.v.ui.ov.rows[small.v.ui.ov.cur].segs).trim())) await small.term.type('j');
  await small.term.type('A', ...'books twice?', '\r');
  await new Promise((r) => setTimeout(r, 30));
  const ov = small.v.ui.ov;
  const qi = ov.rows.findIndex((r) => /books twice/.test(plain(r.segs)));
  assert.ok(qi > ov.cur && qi < ov.rows.findIndex((r) => /new dependencies/.test(plain(r.segs))), 'under the paragraph, before the rest of the entry');
  assert.match(small.term.screen().join('\n'), /ASKED[\s\S]*books twice\?[\s\S]*waiting for the agent/);
  assert.match(small.term.screen().join('\n'), /▌.*Books a refund/, 'the cursor stays on screen');
  assert.equal(asked.at(-1).target.overview.at, 'Books a refund and remembers its idempotency key.');
  fs.rmSync(st0, { force: true });
  asked.length = 0;
  await term.type('m', '1');
  while (!/RefundService/.test(plain(v.ui.ov.rows[v.ui.ov.cur].segs))) await term.type('j');
  const row = v.ui.ov.cur - v.ui.ov.top;
  await term.type('A', ...'why a Set?', '\r');
  await new Promise((r) => setTimeout(r, 30));
  const scr = () => term.screen().join('\n');
  assert.match(scr(), /ASKED[\s\S]*why a Set\?[\s\S]*waiting for the agent/);
  assert.equal(v.ui.ov.cur - v.ui.ov.top, row, 'the cursor stays on its screen row');
  assert.match(plain(v.ui.ov.rows[v.ui.ov.cur].segs), /RefundService/);
  // the agent answers, citing code: under the entry, not in the diff
  const ann = JSON.parse(saved);
  ann.explanations.push({ asked: asked[0].id, question: 'why a Set?', answer: 'It remembers the keys seen: in memory only.', ref: { repo: 'refund-service', file: 'src/main/java/shop/refund/RefundService.java', lines: '5' } });
  fs.writeFileSync(annFile, JSON.stringify(ann));
  for (let i = 0; i < 40 && !/in memory only/.test(scr()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(scr(), /EXPLAINED[\s\S]*why a Set\?[\s\S]*in memory only/);
  assert.match(scr(), /the agent answered: why a Set\?.*in the overview/);
  assert.doesNotMatch(scr(), /waiting for the agent/);
  // the Questions tab says where it was asked
  await term.type('5');
  assert.match(scr(), /asked in the overview: Design · RefundService/);
  // not in the diff
  await term.type('m');
  assert.ok(!v.ui.rows.some((r) => /in memory only/.test(plain(r.segs))));
  // x deletes it under the entry
  await term.type('m', '1');
  while (!v.ui.ov.rows[v.ui.ov.cur]?.del) await term.type('j');
  await term.type('x', 'x');
  assert.doesNotMatch(scr(), /in memory only/);
  fs.writeFileSync(annFile, saved);
  fs.rmSync(st0, { force: true });
});

test('a question asked on a group\'s text: waiting, then answered, under that paragraph, not elsewhere', async () => {
  const st0 = path.join(dir, '.feature-review', 'state.json');
  const annFile = path.join(dir, '.feature-review', 'annotations.json');
  const saved = fs.readFileSync(annFile, 'utf8');
  fs.rmSync(st0, { force: true });
  const asked = [];
  const { term, v } = await viewer({ rows: 50, cols: 130, layout: 'unified', env: { HERDR_PANE_ID: 'w:p1' }, askAgent: async (q) => (asked.push(q), { name: 'a', pane: 'p', started: false }) });
  await term.type('/', ...'Retries of a refund', '\r', '\x1b');
  assert.match(plain(v.ui.rows[v.ui.cur].segs), /Retries of a refund/);
  await term.type('A', ...'why not a header?', '\r');
  await new Promise((r) => setTimeout(r, 30));
  assert.match(plain(v.ui.rows[v.ui.cur].segs), /Retries of a refund/, 'the cursor stays on the text asked on');
  const scr = () => term.screen().join('\n');
  const idx = (re) => v.ui.rows.findIndex((r) => re.test(plain(r.segs)));
  // under the paragraph asked on, before the list that follows it
  assert.match(scr(), /Retries of a refund[\s\S]*ASKED[\s\S]*why not a header\?[\s\S]*RefundRequest gains/);
  assert.ok(idx(/why not a header/) > idx(/Retries of a refund/) && idx(/why not a header/) < idx(/RefundRequest gains/));
  // the agent answers, citing a line: still there, not under that line
  const ann = JSON.parse(saved);
  ann.explanations.push({ asked: asked[0].id, question: 'why not a header?', answer: 'The key is in the body: idempotent retries.', ref: { repo: 'refund-service', file: 'src/main/java/shop/refund/RefundService.java', lines: '5' } });
  fs.writeFileSync(annFile, JSON.stringify(ann));
  for (let i = 0; i < 40 && !/idempotent retries/.test(scr()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(scr(), /Retries of a refund[\s\S]*EXPLAINED[\s\S]*why not a header\?[\s\S]*idempotent retries[\s\S]*RefundRequest gains/);
  assert.equal(v.ui.rows.filter((r) => /idempotent retries/.test(plain(r.segs))).length, 1, 'once');
  // asked on the group's header: first in its body
  while (!/HIGH/.test(plain(v.ui.rows[v.ui.cur].segs))) await term.type('k');
  await term.type('A', ...'what is this group?', '\r');
  await new Promise((r) => setTimeout(r, 30));
  assert.match(scr(), /Refunds carry an idempotency key[\s\S]*ASKED +waiting for the agent[^\n]*\n[^\n]*what is this group\?[\s\S]*Retries of a refund/);
  // asked before fr kept the text: in its group, first
  const older = { ...v.ui.st, questions: [{ id: 'q-old001', group: 'refund-key', question: 'an older one?', at: '2026-01-01T00:00:00Z' }] };
  const built = buildRows(v.ui.ws, older, { width: 130, layout: 'unified', lens: 'groups', ann: v.ui.ann }).map((r) => plain(r.segs));
  const pos = (re) => built.findIndex((t) => re.test(t));
  assert.ok(pos(/an older one\?/) > pos(/Refunds carry an idempotency key/) && pos(/an older one\?/) < pos(/Retries of a refund/), 'first in its group');
  fs.writeFileSync(annFile, saved);
  fs.rmSync(st0, { force: true });
});

test('a question asked on a note in the diff (a finding): right under it, on screen; its answer too, whatever it cites', async () => {
  const st0 = path.join(dir, '.feature-review', 'state.json');
  const annFile = path.join(dir, '.feature-review', 'annotations.json');
  const saved = fs.readFileSync(annFile, 'utf8');
  const asked = [];
  for (const lens of ['groups', 'services']) {
    asked.length = 0;
    const { term, v } = await viewer({ rows: 30, cols: 130, layout: 'unified', env: { HERDR_PANE_ID: 'w:p1' }, askAgent: async (q) => (asked.push(q), { name: 'a', pane: 'p', started: false }) });
    if (lens === 'services') await term.type('\t');
    await term.type('/', ...'nothing else rejects', '\r', '\x1b');
    const note = v.ui.rows[v.ui.cur].callout;
    assert.match(note, /^finding:/);
    await term.type('A', ...'is that so?', '\r');
    await new Promise((r) => setTimeout(r, 30));
    const scr = () => term.screen().join('\n');
    // right after the finding's rows
    const i = v.ui.rows.findIndex((r) => r.callout === `asked:${asked[0].id}`);
    const last = v.ui.rows.findLastIndex((r) => r.callout === note);
    assert.ok(i > last && v.ui.rows.slice(last + 1, i).every((r) => r.gap || !r.segs.length || r.callout === undefined), `${lens}: under the finding`);
    assert.match(scr(), /nothing else rejects a negative refund[\s\S]*ASKED[\s\S]*is that so\?/, `${lens}: on screen`);
    // the answer cites another line: still under the finding
    const ann = JSON.parse(saved);
    ann.explanations.push({ asked: asked[0].id, question: 'is that so?', answer: 'Yes: no validator downstream.', ref: { repo: 'refund-service', file: 'src/main/java/shop/refund/RefundService.java', lines: '5' } });
    fs.writeFileSync(annFile, JSON.stringify(ann));
    for (let k = 0; k < 40 && !v.ui.rows.some((r) => /no validator downstream/.test(plain(r.segs))); k++) await new Promise((r) => setTimeout(r, 100));
    const a = v.ui.rows.findIndex((r) => /no validator downstream/.test(plain(r.segs)));
    assert.ok(a > v.ui.rows.findLastIndex((r) => r.callout === note) && v.ui.rows[a].hunk === v.ui.rows.find((r) => r.callout === note).hunk, `${lens}: the answer under the finding`);
    assert.equal(v.ui.rows.filter((r) => /no validator downstream/.test(plain(r.segs))).length, 1);
    // on a note that is no finding (a test's intent): after that note
    await term.type('/', ...'any number of times', '\r', '\x1b');
    const t = v.ui.cur;
    await term.type('A', ...'and the intent?', '\r');
    await new Promise((r) => setTimeout(r, 30));
    const q = v.ui.rows.findIndex((r) => r.callout === `asked:${asked[1].id}`);
    assert.ok(q > t && v.ui.rows.slice(t, q).every((r) => r.hunk === v.ui.rows[t].hunk), `${lens}: under the test's note, in its hunk`);
    fs.writeFileSync(annFile, saved);
    fs.rmSync(st0, { force: true });
    await new Promise((r) => setTimeout(r, 300));
  }
});

test('a question on an answer: under it, a thread; the agent gets the answer as the place', async () => {
  const st0 = path.join(dir, '.feature-review', 'state.json');
  const annFile = path.join(dir, '.feature-review', 'annotations.json');
  const saved = fs.readFileSync(annFile, 'utf8');
  const asked = [];
  try {
    const { term, v } = await viewer({ rows: 60, cols: 130, layout: 'unified', env: { HERDR_PANE_ID: 'w:p1' }, askAgent: async (q) => (asked.push(q), { name: 'a', pane: 'p', started: false }) });
    const text = () => v.ui.rows.map((r) => plain(r.segs)).join('\n');
    const answer = async (q, a, ref) => {
      const ann = JSON.parse(fs.readFileSync(annFile, 'utf8'));
      ann.explanations.push({ asked: q.id, question: q.question, answer: a, ...(ref ? { ref } : {}) });
      fs.writeFileSync(annFile, JSON.stringify(ann));
      for (let i = 0; i < 40 && !text().includes(a); i++) await sleep(100);
    };
    await term.type('/', ...'nothing else rejects', '\r', '\x1b', 'A', ...'Q1 why?', '\r');
    await sleep(50);
    // the answer cites another file: still under the finding
    await answer(asked[0], 'A1 the check is gone.', { repo: 'gateway', file: 'src/main/java/shop/gateway/RefundRequest.java', lines: '3' });
    await term.type('/', ...'A1 the check', '\r', '\x1b', 'A', ...'Q2 and then?', '\r');
    await sleep(50);
    assert.match(asked[1].target.text, /Q1 why\?\nA1 the check is gone\./, 'the agent reads what it follows up');
    await answer(asked[1], 'A2 it pays out.');
    await term.type('/', ...'A2 it pays', '\r', '\x1b', 'A', ...'Q3 sure?', '\r');
    await sleep(50);
    // also a second question on the first answer: after the whole thread under it
    await term.type('/', ...'A1 the check', '\r', '\x1b', 'A', ...'Q4 besides?', '\r');
    await sleep(50);
    assert.match(text(), /nothing else rejects a negative refund[^]*Q1 why\?[^]*A1 the check is gone[^]*Q2 and then\?[^]*A2 it pays out[^]*ASKED[^]*Q3 sure\?[^]*ASKED[^]*Q4 besides\?/);
    // a thread on an answer under a group's text (its answer cites code elsewhere): there too
    await term.type('/', ...'Retries of a refund', '\r', '\x1b', 'A', ...'T1 why retries?', '\r');
    await sleep(50);
    await answer(asked[4], 'T1 answer: clients retry.', { repo: 'refund-service', file: 'src/main/java/shop/refund/RefundService.java', lines: '5' });
    await term.type('/', ...'T1 answer', '\r', '\x1b', 'A', ...'T2 which clients?', '\r');
    await sleep(50);
    assert.match(text(), /Retries of a refund[^]*T1 why retries\?[^]*T1 answer: clients retry[^]*ASKED[^]*T2 which clients\?[^]*RefundRequest gains/);
    assert.equal(v.ui.rows.filter((r) => /T2 which clients/.test(plain(r.segs))).length, 1);
  } finally {
    fs.writeFileSync(annFile, saved);
    fs.rmSync(st0, { force: true });
    await sleep(300);
  }
});

test('p on a link to another part of the review: that part in the pane; ⏎ goes there, gt comes back', async () => {
  const annFile = path.join(dir, '.feature-review', 'annotations.json');
  const saved = fs.readFileSync(annFile, 'utf8');
  const ann = JSON.parse(saved);
  ann.findings[0].id = 'no-check';
  ann.findings.push({ ref: ann.findings[0].ref, kind: 'money', note: 'A negative amount pays out: see [the deleted check](#finding:no-check), in gateway:H3, and [the key](#design:RefundService). Why: [the key group](#group:refund-key).' });
  fs.writeFileSync(annFile, JSON.stringify(ann));
  try {
    const { term, v } = await viewer({ rows: 50, cols: 130, layout: 'unified' });
    const scr = () => term.screen().join('\n');
    await term.type('/', ...'pays out', '\r', '\x1b', 'p');
    await sleep(300);
    const p = v.ui.peek;
    assert.deepEqual(p.targets.filter((t) => t.row).map((t) => t.hunk ?? `${t.section.kind}:${t.section.key}`), ['finding:no-check', 'gateway:H3', 'design:RefundService', 'group:refund-key']);
    // the finding as the review shows it, then its code
    assert.match(scr(), /PEEK +1\/\d+ [ ─]+finding no-check: deleted-check ─ in the review · ⏎ goes there/);
    assert.match(scr(), /1 the deleted check .*2 gateway:H3 .*3 the key/);
    assert.match(scr(), /DELETED CHECK[\s\S]*nothing else rejects a negative refund[\s\S]*if \(amount <= 0\)/);
    // ⏎ on it: the finding in the diff; gt: back, the peek open again
    const back = plain(v.ui.rows[v.ui.cur].segs);
    await term.type('\r');
    assert.equal(v.ui.peek, null);
    assert.equal(v.ui.rows[v.ui.cur].callout, 'finding:0');
    assert.match(scr(), /finding no-check: deleted-check +gt: back/);
    await term.type('g', 't');
    assert.equal(plain(v.ui.rows[v.ui.cur].segs), back);
    assert.ok(v.ui.peek);
    // the design entry: from the overview; ⏎ opens it there, gt comes back to the diff
    await term.type('3');
    await sleep(200);
    assert.match(scr(), /design entry RefundService ─ in the overview/);
    assert.match(scr(), /Books a refund/);
    await term.type('\r');
    assert.equal(v.ui.ov?.tab, 'design');
    assert.equal(v.ui.ov.rows[v.ui.ov.cur].item, 'design:RefundService');
    await term.type('g', 't');
    assert.equal(v.ui.ov, null);
    assert.equal(plain(v.ui.rows[v.ui.cur].segs), back);
    // the hunk: its code
    await term.type('2');
    await sleep(200);
    assert.match(scr(), /public record RefundRequest/);
    // a group: its header, why and parts; ⏎: its header in the review
    const g = v.ui.peek.targets.findIndex((t) => t.section?.kind === 'group');
    assert.ok(g >= 0);
    await term.type(String(g + 1));
    await sleep(200);
    assert.match(scr(), /group Refunds carry an idempotency key[\s\S]*Retries of a refund must not book it twice[\s\S]*INTERFACE/);
    await term.type('\r');
    assert.equal(v.ui.rows[v.ui.cur].kind, 'group');
    assert.equal(v.ui.rows[v.ui.cur].group, 'refund-key');
  } finally {
    fs.writeFileSync(annFile, saved);
  }
});

test('the cursor is written for the agent ("this line"), a moment after it stops', async () => {
  const file = path.join(dir, '.feature-review', 'cursor.json');
  fs.rmSync(file, { force: true });
  const { term } = await viewer({ rows: 40, cols: 130, layout: 'unified' });
  await term.type('/', ...'amount, idempotencyKey);', '\r', '\x1b');
  await new Promise((r) => setTimeout(r, 600));
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(c.repo, 'gateway');
  assert.match(c.quote, /amount, idempotencyKey\);/);
  assert.ok(c.at);
});

test('the answers: under their line, in the Questions tab, hidden with f 5', async () => {
  const { term } = await viewer({ rows: 60, cols: 130 });
  await term.type('/', ...'EXPLAINED', '\r', '\x1b');
  assert.match(term.screen().join('\n'), /Why does this check matter/);
  await term.type('f', '5', 'f');
  assert.doesNotMatch(term.screen().join('\n'), /EXPLAINED/);
  await term.type('f', '0', 'f', 'm', '5');
  const s = term.screen().join('\n');
  assert.match(s, /5 Questions 2/);
  assert.match(s, /EXPLAINED +Why does this check matter/);
  assert.match(s, /about the whole change/);
  assert.match(s, /gateway ──refund\(key\)──► refund-service/);
});

test('space folds the note under the cursor to one line that says so; the header counts them', async () => {
  const { term } = await viewer({ rows: 60, cols: 130 });
  await term.type('/', ...'Why does this check matter', '\r', '\x1b');
  const before = term.screen().join('\n');
  assert.match(before, /you asked/);
  await term.type(' ');
  let s = term.screen().join('\n');
  assert.match(s, /EXPLAINED +Why does this check matter.*▸ folded · space shows it/);
  assert.doesNotMatch(s, /you asked/);
  assert.match(term.screen()[0], /1 note folded/);
  // a finding folds the same way
  await term.type('/', ...'DELETED CHECK', '\r', '\x1b', ' ');
  assert.match(term.screen().join('\n'), /DELETED CHECK +The amount <= 0 check is gone.*▸ folded/);
  assert.match(term.screen()[0], /2 notes folded/);
  // open again
  await term.type(' ');
  assert.match(term.screen()[0], /1 note folded/);
  await term.type('/', ...'Why does this check matter', '\r', '\x1b', ' ');
  assert.doesNotMatch(term.screen()[0], /folded/);
  assert.match(term.screen().join('\n'), /you asked/);
});

test('a question asked waits at its line until the answer with its id is in the file; shown alone where notes are hidden', async () => {
  const file = path.join(dir, '.feature-review', 'annotations.json');
  const saved = fs.readFileSync(file, 'utf8');
  try {
    let id = null;
    const askAgent = async (q) => ((id = q.id), { name: 'fr-feature', pane: 'w:p2', started: false });
    const { term } = await viewer({ rows: 60, cols: 130, layout: 'unified', env: { HERDR_PANE_ID: 'w:p1' }, askAgent });
    // the block's notes hidden first (h): the finding and an earlier answer are in it
    await term.type('/', ...'amount, idempotencyKey);', '\r', '\x1b', 'h');
    const hiddenBefore = term.screen().join('\n');
    assert.match(hiddenBefore, /notes? hidden · h shows them/);
    assert.doesNotMatch(hiddenBefore, /Why does this check matter|DELETED CHECK/);
    await term.type('A', ...'is the key ever empty?', '\r');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(readState(dir).questions[0].id, id);
    assert.equal(readState(dir).questions[0].repo, 'gateway');
    assert.match(term.screen()[0], /1 question waiting/);
    // at once, waiting, though the block's notes are hidden; the others stay hidden
    let s = term.screen().join('\n');
    assert.match(s, /ASKED +waiting for the agent's answer[^]*is the key ever empty\?/);
    assert.doesNotMatch(s, /Why does this check matter|DELETED CHECK/);
    assert.match(s, /notes? hidden · h shows them/);
    const row = term.cursor();
    // the agent writes its answer, with the id
    const ann = JSON.parse(saved);
    ann.explanations.push({ asked: id, question: 'is the key ever empty?', ref: { hunk: 'gateway:H2' }, answer: 'Yes: old clients send none.' });
    fs.writeFileSync(file, JSON.stringify(ann));
    await new Promise((r) => setTimeout(r, 1600));
    s = term.screen().join('\n');
    assert.match(s, /the agent answered: is the key ever empty\?/);
    assert.match(s, /EXPLAINED[^]*is the key ever empty\?[^]*Yes: old clients send none/);
    assert.doesNotMatch(s, /Why does this check matter|DELETED CHECK/, 'the answer alone, not the notes hidden around it');
    assert.match(s, /notes? hidden · h shows them/);
    const code = (c) => ({ row: c.row, text: c.text.replace(/^[▌▎ ]+/, '') }); // (its gutter mark may change)
    assert.deepEqual(code(term.cursor()), code(row), "the reader's line stays where it was");
    assert.doesNotMatch(term.screen()[0], /waiting/);
    assert.doesNotMatch(s, /ASKED/);
    // h decides for the whole block again: all shown, then all hidden, the answer too
    await term.type('h');
    assert.match(term.screen().join('\n'), /DELETED CHECK/);
    await term.type('h');
    assert.doesNotMatch(term.screen().join('\n'), /Yes: old clients send none|DELETED CHECK/);
  } finally {
    fs.writeFileSync(file, saved);
  }
});

test('h hides every note in the diff block under the cursor, says so on its title, and shows them again', async () => {
  const { term, v } = await viewer({ rows: 80, cols: 130, layout: 'unified' });
  await term.type('/', ...'DELETED CHECK', '\r', '\x1b');
  const hunk = v.ui.rows[v.ui.cur].hunk;
  const notesOf = () => v.ui.rows.filter((r) => r.hunk === hunk && r.kind === 'note').length;
  assert.ok(notesOf() > 0);
  const marks = () => v.ui.rows.filter((r) => r.hunk === hunk && r.kind === 'code' && /▌/.test(plain(r.segs).slice(0, 2))).length;
  const marked = marks();
  await term.type('h');
  assert.equal(notesOf(), 0, 'no note left in the block');
  assert.equal(marks(), marked, 'the gutter marks stay');
  assert.equal(v.ui.rows[v.ui.cur].hunk, hunk, 'the cursor stays in the block');
  assert.match(term.screen().join('\n'), /@@ .*\d+ notes? hidden · h shows them/);
  // other blocks keep theirs
  assert.ok(v.ui.rows.some((r) => r.hunk !== hunk && r.kind === 'note'));
  await term.type('h');
  assert.ok(notesOf() > 0);
  assert.doesNotMatch(term.screen().join('\n'), /hidden · h shows them/);
});

test('h and space on a note leave what you look at where it is on the screen', async () => {
  const { term } = await viewer({ rows: 40, cols: 130, layout: 'unified' });
  // on a code line in the middle of the screen
  await term.type('/', ...'amount, idempotencyKey);', '\r', '\x1b', 'j', 'j', 'j', 'j', 'j', 'j', 'k', 'k', 'k', 'k', 'k', 'k');
  const before = term.cursor();
  await term.type('h');
  assert.deepEqual(term.cursor(), before, 'hidden: the line stays on its screen row');
  await term.type('h');
  assert.deepEqual(term.cursor(), before, 'shown again: the same');
  // on a note far below its line: the line takes the note's place on the screen
  await term.type('/', ...'Consequence', '\r', '\x1b');
  const row = term.cursor().row;
  await term.type('h');
  assert.equal(term.cursor().row, row, 'the cursor stays on its screen row');
  assert.ok(/^\S?▌?\s*\d/.test(term.cursor().text.trimStart()) || /\d+ [+-]? /.test(term.cursor().text), `on the code line now: ${term.cursor().text}`);
  await term.type('h');
  // space on a note: its first row stays put, folded to that one row
  await term.type('/', ...'Why does this check matter', '\r', '\x1b');
  const first = term.cursor().row - 2; // the label, above "you asked" and the question
  assert.match(term.screen()[first], /EXPLAINED/);
  await term.type(' ');
  assert.match(term.screen()[first], /EXPLAINED.*▸ folded/);
});

test('x deletes an answer the reviewer no longer needs, with its question: in the diff, in the Questions tab, a question waiting', async () => {
  const st0 = path.join(dir, '.feature-review', 'state.json');
  const { term, v } = await viewer({ rows: 60, cols: 130, layout: 'unified', env: { HERDR_PANE_ID: 'w:p1' }, askAgent: async () => ({ name: 'a', pane: 'p', started: false }) });
  // in the diff: x asks, x again deletes; the answer has no id (asked in the agent's pane)
  await term.type('/', ...'Why does this check matter', '\r', '\x1b', 'x');
  assert.match(term.screen().join('\n'), /delete this explanation and its question\? x again/);
  assert.match(term.screen().join('\n'), /Why does this check matter/, 'not yet');
  await term.type('x');
  assert.doesNotMatch(term.screen().join('\n'), /Why does this check matter/);
  assert.match(term.screen().join('\n'), /explanation deleted/);
  assert.equal(readState(dir).deleted.length, 1);
  // the agent's file keeps it; fr does not show it again, also after a reload or in --print
  assert.match(fs.readFileSync(path.join(dir, '.feature-review', 'annotations.json'), 'utf8'), /Why does this check matter/);
  await term.type('r');
  await new Promise((r) => setTimeout(r, 300));
  assert.doesNotMatch(term.screen().join('\n'), /Why does this check matter/);
  // in the Questions tab: the general one
  await term.type('m', '5');
  assert.match(term.screen().join('\n'), /5 Questions 1/);
  while (!v.ui.ov.rows[v.ui.ov.cur]?.del) await term.type('j');
  await term.type('x', 'x');
  assert.doesNotMatch(term.screen().join('\n'), /How does a refund travel now/);
  assert.match(term.screen().join('\n'), /No questions yet/);
  await term.type('m');
  // a question waiting: x on its ASKED note
  await term.type('/', ...'amount, idempotencyKey);', '\r', '\x1b', 'A', ...'still there?', '\r');
  await new Promise((r) => setTimeout(r, 30));
  await term.type('/', ...'ASKED', '\r', '\x1b', 'x', 'x');
  assert.doesNotMatch(term.screen().join('\n'), /ASKED|still there\?/);
  assert.doesNotMatch(term.screen()[0], /waiting/);
  assert.equal(readState(dir).questions.length, 0);
  fs.rmSync(st0, { force: true });
});

test('p peeks at the code a note points at, below, the review in place; n, +, =, esc', async () => {
  const { term, v } = await viewer({ rows: 40, cols: 130, layout: 'unified' });
  await term.type('/', ...'CALLER TO CHECK', '\r', '\x1b');
  const at = { cur: v.ui.cur, top: v.ui.top };
  await term.type('p');
  await sleep(300);
  const scr = () => term.screen().join('\n');
  // the caller outside the feature first; the line the note sits under last
  assert.match(scr(), /PEEK +1\/2 [ ─]+refund-service-seed\/src\/main\/java\/shop\/refund\/RefundService\.java:4-6 [ ─]+outside the feature/);
  assert.match(scr(), /CALLER TO CHECK/, 'the note stays on screen');
  assert.match(scr(), /▌ +4 +public void refund\(String orderId, long amount\)/, 'the cited lines marked');
  assert.match(scr(), /peek: +j\/k move/);
  assert.match(scr(), /^▌▌ +4 +public void refund/m, 'the cursor on the first cited line');
  assert.match(term.where(), /peek: refund-service-seed\/src\/main\/java\/shop\/refund\/RefundService\.java:\+4/);
  // the next one: the line in the change it is about
  await term.type('n');
  await sleep(200);
  assert.match(scr(), /PEEK +2\/2 [ ─]+refund-service\/src\/main\/java\/shop\/refund\/RefundService\.java:4 [ ─]+in the change/);
  // more around it, then all of the file
  const rows = v.ui.peek.rows.length;
  await term.type('+', '+', '+', '+');
  assert.ok(v.ui.peek.rows.length >= rows);
  assert.doesNotMatch(scr(), /lines (above|below) · \+ shows more/);
  await term.type('=');
  assert.match(term.screen()[1], /PEEK/, 'full screen');
  await term.type('=', '\x1b');
  assert.equal(v.ui.peek, null);
  assert.deepEqual({ cur: v.ui.cur, top: v.ui.top }, at, 'back exactly where it was');
});

test('p: ⏎ goes to code in the change, gt comes back with the peek open; on a line of code: its notes', async () => {
  const { term, v } = await viewer({ rows: 40, cols: 130, layout: 'unified' });
  await term.type('/', ...'CALLER TO CHECK', '\r', '\x1b', 'p');
  await sleep(300);
  // outside the feature: no going there
  await term.type('\r');
  assert.match(term.screen().join('\n'), /outside the feature: o opens it in the editor/);
  const back = rowText(v.ui.rows[v.ui.cur]);
  await term.type('n');
  await sleep(200);
  await term.type('\r');
  assert.equal(v.ui.peek, null);
  assert.equal(v.ui.rows[v.ui.cur].line?.n, 4);
  assert.match(term.screen().join('\n'), /RefundService\.java:4 +gt: back/);
  await term.type('j', 'g', 't');
  assert.equal(rowText(v.ui.rows[v.ui.cur]), back);
  assert.ok(v.ui.peek, 'the peek open again');
  assert.equal(v.ui.peek.i, 1);
  await term.type('\x1b');
  // on a line of code: its whole file, the cursor on that line, then what the notes under it cite
  while (v.ui.rows[v.ui.cur].kind !== 'code') await term.type('k');
  const line = v.ui.rows[v.ui.cur].line;
  await term.type('p');
  await sleep(300);
  const pk = v.ui.peek;
  assert.equal(pk.targets[0].here, true);
  assert.equal(pk.context, Infinity);
  assert.match(term.screen().join('\n'), /PEEK +1\/\d+ .*the line under the cursor · its whole file/);
  const at = pk.rows[pk.cur];
  assert.equal((line.side === 'old' ? at.at?.old : (at.at?.new ?? at.line)), line.n);
  assert.ok(pk.targets.some((t) => t.repo === 'refund-service-seed'), 'the notes\' citations after it');
  await term.type('\x1b');
  // nothing cited
  await term.type('g', 'g', 'p');
  assert.match(term.screen().join('\n'), /nothing cited here/);
});

test('p: the types and members the prose names, found by name; in the overview, from a citation', async () => {
  const { term, v } = await viewer({ rows: 40, cols: 130, layout: 'unified' });
  await term.type('/', ...'gains', '\r', '\x1b', 'p');
  await sleep(500);
  const names = v.ui.peek.targets.filter((t) => t.how === 'found').map((t) => `${t.symbol} ${t.repo}/${path.basename(t.file)}:${t.from}`);
  assert.ok(names.includes('RefundService.refund refund-service/RefundService.java:4'), names.join(', '));
  assert.ok(names.some((n) => n.startsWith('RefundRequest gateway/RefundRequest.java')), names.join(', '));
  assert.match(term.screen().join('\n'), /found by name/);
  // on the row "1. RefundRequest gains idempotencyKey": that type first
  assert.match(term.screen().join('\n'), /PEEK +1\/\d+ [ ─]+gateway\/src\/main\/java\/shop\/gateway\/RefundRequest\.java:\d+ .*found by name: RefundReq/);
  await term.type('\x1b');
  // on the next row, its name first
  await term.type('/', ...'skips a key', '\r', '\x1b', 'p');
  await sleep(500);
  assert.match(term.screen().join('\n'), /PEEK +1\/\d+ [ ─]+refund-service\/src\/main\/java\/shop\/refund\/RefundService\.java:4 .*found by name: Refun/); // (the title is cut at the width)
  assert.equal(v.ui.peek.targets[0].symbol, 'RefundService.refund');
  await term.type('\x1b');
  // the overview: on a consumer's citation, that one first
  await term.type('m', '3');
  while (!/refund-service-seed.*RefundService\.java:4/.test(plain(v.ui.ov.rows[v.ui.ov.cur].segs))) await term.type('j');
  await term.type('p');
  await sleep(300);
  assert.match(term.screen().join('\n'), /PEEK +\d\/\d [ ─]+refund-service-seed\/src\/main\/java\/shop\/refund\/RefundService\.java:4 [ ─]+outside the feature/);
  assert.ok(v.ui.ov, 'still in the overview');
  await term.type('\x1b');
  assert.equal(v.ui.peek, null);
  assert.ok(v.ui.ov);
});

test('the peek has a cursor: j moves it, ⏎ goes to its line in the change, o opens its line', async () => {
  const log = path.join(top, 'editor.log');
  fs.rmSync(log, { force: true });
  const { term, v } = await viewer({ rows: 40, cols: 130, layout: 'unified', editor: `printf '%s %s\\n' >> ${log}` });
  await term.type('/', ...'CALLER TO CHECK', '\r', '\x1b', 'p');
  await sleep(300);
  await term.type('n');
  await sleep(200);
  // on the cited line; two down: line 6 of the new side
  await term.type('j', 'j');
  assert.match(term.where(), /peek: refund-service\/src\/main\/java\/shop\/refund\/RefundService\.java:\+6/);
  assert.match(term.screen().join('\n'), /^▌ +5 +6 +ledger\.book/m);
  await term.type('o');
  assert.match(fs.readFileSync(log, 'utf8'), /^\+6 .*refund-service\/src\/main\/java\/shop\/refund\/RefundService\.java$/m);
  await term.type('\r');
  assert.equal(v.ui.peek, null);
  assert.deepEqual(v.ui.rows[v.ui.cur].line, { side: 'new', n: 6 });
  // back, the peek's cursor where it was
  await term.type('g', 't');
  assert.match(term.where(), /RefundService\.java:\+6/);
  // + keeps the cursor on its line
  await term.type('+');
  assert.match(term.where(), /RefundService\.java:\+6/);
});
