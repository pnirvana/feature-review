// The viewer driven through a fake terminal: keys in, screens out. Covers what only shows
// when a person uses it (keys reach the viewer, the review flow, the lens switch).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { makeSample, sampleAnnotations } from './fixture.mjs';
import { runViewer } from '../src/viewer.mjs';
import { readState } from '../src/state.mjs';
import { plain } from '../src/md/term.mjs';
import { readFeedback } from '../src/feedback.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const v = await runViewer({ dir, layout: opts.layout ?? 'auto', feedbackFile: path.join(top, 'feedback.jsonl'), highlight: 'none', queryTheme: false, viMode: opts.viMode ?? false, env: opts.env ?? {}, askAgent: opts.askAgent, input: term.input, output: term.output, exit: (c) => (exited = c) });
  open.push(v);
  return { term, v, exited: () => exited };
}

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
  const { term } = await viewer({ rows: 40, cols: 130, layout: 'unified', env: { HERDR_PANE_ID: 'w:p1' }, askAgent });
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
  // in the overview: no line
  await term.type('m', 'A', ...'what is risky?', '\r');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asked.length, 2);
  assert.equal(asked[1].target, null);
  assert.match(term.screen().join('\n'), /asked fr-feature: the answer comes in its pane/);
  // esc: nothing asked
  await term.type('A', 'x', '\x1b');
  assert.equal(asked.length, 2);
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
