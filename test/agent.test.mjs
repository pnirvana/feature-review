import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askAgent, freeName, questionPrompt, agentFile, ANSWERING } from '../src/agent.mjs';
import { findDefinition, definitionArgs, parseFrontmatter } from '../src/agentdef.mjs';

/** A fake herdr: agents by pane, the calls made. */
function fakeHerdr({ others = [], failStart = false } = {}) {
  const calls = [];
  const panes = new Map(others.map((a) => [a.pane_id, a]));
  let n = 10;
  const herdr = async (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === 'agent' && b === 'list') return { agents: [...panes.values()] };
    if (a === 'agent' && b === 'get') {
      const x = panes.get(args[2]);
      if (!x) throw new Error('herdr agent get: not found');
      return { agent: x };
    }
    if (a === 'pane' && b === 'split') return { pane: { pane_id: `w:p${n++}` } };
    if (a === 'agent' && b === 'start') {
      if (failStart) throw new Error('herdr agent start: pi not found');
      panes.set(args[args.indexOf('--pane') + 1], { name: args[2], pane_id: args[args.indexOf('--pane') + 1], agent_status: 'idle' });
      return {};
    }
    return {};
  };
  return { herdr, calls, panes };
}

const feature = () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fr-agent-')), 'feature');
  fs.mkdirSync(path.join(root, '.feature-review'), { recursive: true });
  return root;
};

test('a name no other agent has: fr-<feature>, else numbered', () => {
  assert.equal(freeName('/x/feature', new Set()), 'fr-feature');
  assert.equal(freeName('/x/feature', new Set(['feature', 'fr-feature'])), 'fr-feature-2');
  assert.equal(freeName('/x/my feature', new Set()), 'fr-my-feature');
});

test('the first question starts the agent beside fr, under a free name; the next ones go to it', async () => {
  const root = feature();
  // an agent already runs under the feature's name, and one under fr's
  const h = fakeHerdr({ others: [{ name: 'feature', pane_id: 'w:p1' }, { name: 'fr-feature', pane_id: 'w:p2' }] });
  const env = { HERDR_PANE_ID: 'w:p1', PI_CODING_AGENT_DIR: path.join(root, 'no-pi') };
  const r = await askAgent({ root, question: 'why?', target: { repo: 'gateway', file: 'A.java', line: { side: 'new', n: 4 }, quote: 'x();' }, herdr: h.herdr, env });
  assert.deepEqual(r, { name: 'fr-feature-2', pane: 'w:p10', started: true, definition: 'feature-review-ask', model: null, kind: 'pi' });
  assert.deepEqual(h.calls.find((c) => c[1] === 'split'), ['pane', 'split', '--pane', 'w:p1', '--direction', 'right', '--cwd', root, '--no-focus']);
  const start = h.calls.find((c) => c[1] === 'start');
  assert.deepEqual(start.slice(0, 8), ['agent', 'start', 'fr-feature-2', '--kind', 'pi', '--pane', 'w:p10', '--']);
  // run as fr's agent definition: its tools and instructions, the skill Pi lacks here
  const piArgs = start.slice(8);
  assert.equal(piArgs[piArgs.indexOf('--tools') + 1], 'read,grep,find,ls,bash,edit,write');
  assert.match(fs.readFileSync(piArgs[piArgs.indexOf('--append-system-prompt') + 1], 'utf8'), /^# Answer the reviewer's questions/);
  assert.match(piArgs[piArgs.indexOf('--skill') + 1], /agent\/skill\/feature-review$/);
  assert.ok(!piArgs.includes('--model'), "the definition pins no model: Pi's default");
  assert.equal(r.definition, 'feature-review-ask');
  assert.equal(JSON.parse(fs.readFileSync(agentFile(root), 'utf8')).definition, 'feature-review-ask');
  const prompt = h.calls.find((c) => c[1] === 'prompt');
  assert.equal(prompt[2], 'w:p10');
  assert.ok(prompt[3].includes(ANSWERING), 'the first prompt says what to read');
  assert.match(prompt[3], /at gateway\/A\.java:\+4 \(the new side\)/);
  assert.match(prompt[3], /the line: x\(\);/);
  assert.match(prompt[3], /Question:\nwhy\?$/);
  assert.equal(JSON.parse(fs.readFileSync(agentFile(root), 'utf8')).pane, 'w:p10');
  // the next question: the same agent, no new pane, no introduction
  h.calls.length = 0;
  const r2 = await askAgent({ root, question: 'and this?', target: null, herdr: h.herdr, env });
  assert.equal(r2.started, false);
  assert.ok(!h.calls.some((c) => c[1] === 'split'));
  const p2 = h.calls.find((c) => c[1] === 'prompt')[3];
  assert.ok(!p2.includes(ANSWERING));
  assert.match(p2, /about the whole change/);
});

test('never another agent: the recorded pane now runs something else, so a new one starts', async () => {
  const root = feature();
  fs.writeFileSync(agentFile(root), JSON.stringify({ name: 'fr-feature', pane: 'w:p3' }));
  const h = fakeHerdr({ others: [{ name: 'implementer', pane_id: 'w:p3' }] });
  const r = await askAgent({ root, question: 'q', target: null, herdr: h.herdr, env: {} });
  assert.equal(r.started, true);
  assert.notEqual(r.pane, 'w:p3');
  assert.ok(!h.calls.some((c) => c[1] === 'prompt' && c[2] === 'w:p3'));
});

test('an agent waiting for an answer is not prompted; a failed start closes its pane', async () => {
  const root = feature();
  fs.writeFileSync(agentFile(root), JSON.stringify({ name: 'fr-feature', pane: 'w:p3' }));
  const h = fakeHerdr({ others: [{ name: 'fr-feature', pane_id: 'w:p3', agent_status: 'blocked' }] });
  await assert.rejects(askAgent({ root, question: 'q', target: null, herdr: h.herdr, env: {} }), /waits for an answer in its pane/);
  const root2 = feature();
  const f = fakeHerdr({ failStart: true });
  await assert.rejects(askAgent({ root: root2, question: 'q', target: null, herdr: f.herdr, env: {} }), /pi not found/);
  assert.deepEqual(f.calls.at(-1), ['pane', 'close', 'w:p10']);
  assert.ok(!fs.existsSync(agentFile(root2)));
});

test('the prompt names the place: a removed line, a note, the overview tab', () => {
  const p = questionPrompt({ root: '/f', question: 'q', target: { repo: 'r', file: 'F', line: { side: 'old', n: 9 }, quote: 'check();' }, first: false });
  assert.match(p, /at r\/F:-9 \(a removed line, at the base\)/);
  const n = questionPrompt({ root: '/f', question: 'q', target: { repo: 'r', file: 'F', hunk: 'r:H1', group: 'g1', text: 'DELETED CHECK the check is gone' }, first: false });
  assert.match(n, /hunk r:H1\ngroup "g1"\nwhat the reviewer reads there:\nDELETED CHECK/);
});

test('the agent definition: fr\'s own, else the user\'s or the project\'s; the model from the setting wins', async () => {
  const root = feature();
  const pi = path.join(root, '..', 'pi');
  const env = { PI_CODING_AGENT_DIR: pi };
  // fr's own, with its commented-out model and thinking
  const own = findDefinition('feature-review-ask', root, { env });
  assert.equal(own.model, null);
  assert.equal(own.thinking, null);
  assert.deepEqual(own.skills, ['feature-review']);
  assert.equal(parseFrontmatter('---\nname: x\n# model: m\n---\nbody').fm.model, undefined);
  // the user's copy wins: a model and thinking pinned
  fs.mkdirSync(path.join(pi, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(pi, 'skills', 'feature-review'), { recursive: true });
  fs.writeFileSync(path.join(pi, 'agents', 'mine.md'), '---\nname: feature-review-ask\ndescription: d\nmodel: anthropic/claude-sonnet-5-5\nthinking: low\ntools: [read, bash]\nskills: feature-review\n---\nBe brief.\n');
  const user = findDefinition('feature-review-ask', root, { env });
  assert.equal(user.model, 'anthropic/claude-sonnet-5-5');
  const prompts = path.join(root, 'prompts');
  let a = definitionArgs('pi', user, { env, promptDir: prompts });
  assert.deepEqual(a.args.slice(0, 6), ['--model', 'anthropic/claude-sonnet-5-5', '--thinking', 'low', '--tools', 'read,bash']);
  assert.ok(!a.args.includes('--skill'), 'Pi has the skill installed');
  assert.equal(fs.readFileSync(a.args[7], 'utf8'), 'Be brief.');
  // fr's agent.model wins
  a = definitionArgs('pi', user, { env, promptDir: prompts, model: 'openai/gpt-6' });
  assert.deepEqual(a.args.slice(0, 2), ['--model', 'openai/gpt-6']);
  assert.equal(a.model, 'openai/gpt-6');
  // the project's wins over the user's
  fs.mkdirSync(path.join(root, '.pi', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pi', 'agents', 'p.md'), '---\nname: feature-review-ask\nmodel: local/m\n---\nx');
  assert.equal(findDefinition('feature-review-ask', root, { env }).model, 'local/m');
  // other kinds
  assert.deepEqual(definitionArgs('claude', user, { env, promptDir: prompts }).args, ['--model', 'anthropic/claude-sonnet-5-5', '--append-system-prompt', 'Be brief.']);
  assert.deepEqual(definitionArgs('codex', user, { env, promptDir: prompts }), { args: [], model: null });
  // an unknown definition: said, nothing started
  const h = fakeHerdr();
  await assert.rejects(askAgent({ root, question: 'q', target: null, herdr: h.herdr, env, definition: 'nope' }), /no agent definition "nope"/);
  assert.ok(!h.calls.some((c) => c[1] === 'split'));
});
