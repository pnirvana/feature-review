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
  const v = await runViewer({ dir, highlight: 'none', queryTheme: false, viMode: opts.viMode ?? false, input: term.input, output: term.output, exit: (c) => (exited = c) });
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
