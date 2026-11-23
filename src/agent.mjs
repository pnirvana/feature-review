// The agent the reviewer asks questions (the ask key, discovery §13): a coding agent in a
// herdr pane beside fr. fr sends it the question and where the reviewer is; the agent
// answers in its pane, and writes answers worth keeping into the annotation file
// (`explanations`), which fr shows when it reloads.
//
// fr talks to herdr only through its CLI. The agent is the one fr started for this feature,
// recorded by pane in <dir>/.feature-review/agent.json: fr never sends to an agent it did
// not start, whatever its name.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDefinition, definitionArgs } from './agentdef.mjs';

/** The instructions for answering, shipped with fr (the skill's reference file). */
export const ANSWERING = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'skill', 'feature-review', 'references', 'answering.md');

/** fr itself, for the agent's `fr check` where fr is not on its PATH. */
export const FR_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fr.mjs');

export const agentFile = (root) => path.join(root, '.feature-review', 'agent.json');
export const cursorFile = (root) => path.join(root, '.feature-review', 'cursor.json');

export function herdrBin(env = process.env) {
  if (env.HERDR_BIN_PATH) return env.HERDR_BIN_PATH;
  const local = path.join(os.homedir(), '.local/bin/herdr');
  return fs.existsSync(local) ? local : 'herdr';
}

/** Runs herdr; → its parsed `.result`, or throws with herdr's own message. */
export function herdrCli(env = process.env) {
  return (args, { timeout = 15_000 } = {}) =>
    new Promise((resolve, reject) =>
      execFile(herdrBin(env), args, { timeout, env }, (e, out, errOut) => {
        let json = null;
        try {
          json = JSON.parse(out);
        } catch {}
        if (e || !json) {
          const msg = json?.error?.message ?? (String(errOut || '').trim().split('\n').pop() || e?.message || 'no answer');
          return reject(new Error(`herdr ${args.slice(0, 2).join(' ')}: ${msg}`));
        }
        resolve(json.result ?? json);
      }),
    );
}

/** A name no agent in herdr has yet: fr-<feature>, else fr-<feature>-2, -3, … */
export function freeName(root, taken) {
  const base = `fr-${path.basename(path.resolve(root)).replace(/[^\w.-]+/g, '-')}`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

function readRecord(root) {
  try {
    return JSON.parse(fs.readFileSync(agentFile(root), 'utf8'));
  } catch {
    return null;
  }
}

/** The agent fr started for this feature, if its pane still runs it (same pane, same name). */
export async function findAgent(root, herdr) {
  const rec = readRecord(root);
  if (!rec?.pane || !rec?.name) return null;
  const a = await herdr(['agent', 'get', rec.pane]).catch(() => null);
  const agent = a?.agent ?? a;
  if (!agent || agent.pane_id !== rec.pane || (agent.name && agent.name !== rec.name)) return null;
  return { ...rec, status: agent.agent_status ?? null };
}

/**
 * Starts the agent in a new pane beside fr's (to the right), named so it clashes with no
 * other agent, and records it. kind: herdr's agent kind (pi, claude, …); definition: the
 * agent definition it runs as (agentdef.mjs; null: none); model: wins over the
 * definition's; args: extra arguments, last.
 */
export async function startAgent({ root, herdr, env = process.env, kind = 'pi', definition = 'feature-review-ask', model = null, args = [] }) {
  const def = definition ? findDefinition(definition, root, { env }) : null;
  if (definition && !def) throw new Error(`no agent definition "${definition}" (fr's agent/agents, ~/.pi/agent/agents, .pi/agents): check agent.definition`);
  const d = definitionArgs(kind, def, { model, env, promptDir: path.join(root, '.feature-review', 'agent-prompts') });
  args = [...d.args, ...args];
  const list = await herdr(['agent', 'list']).catch(() => ({ agents: [] }));
  const name = freeName(root, new Set((list?.agents ?? []).map((a) => a.name).filter(Boolean)));
  const at = env.HERDR_PANE_ID;
  const split = await herdr(['pane', 'split', ...(at ? ['--pane', at] : ['--current']), '--direction', 'right', '--cwd', root, '--no-focus']);
  const pane = split?.pane?.pane_id;
  if (!pane) throw new Error('herdr opened no pane');
  try {
    await herdr(['agent', 'start', name, '--kind', kind, '--pane', pane, ...(args.length ? ['--', ...args] : [])], { timeout: 60_000 });
  } catch (e) {
    await herdr(['pane', 'close', pane]).catch(() => {});
    throw e;
  }
  await herdr(['pane', 'rename', pane, name]).catch(() => {});
  const rec = { name, pane, kind, definition: def?.name ?? null, model: d.model, started: new Date().toISOString() };
  fs.mkdirSync(path.dirname(agentFile(root)), { recursive: true });
  fs.writeFileSync(agentFile(root), JSON.stringify(rec, null, 2) + '\n');
  return { ...rec, fresh: true };
}

/** Where the reviewer is, in words, for the prompt: from feedbackTarget() in the viewer. */
export function placeText(t) {
  if (!t) return 'about the whole change';
  const lines = [];
  if (t.repo && t.file) lines.push(`at ${t.repo}/${t.file}${t.line ? `:${t.line.side === 'old' ? '-' : '+'}${t.line.n} (${t.line.side === 'old' ? 'a removed line, at the base' : 'the new side'})` : ''}`);
  else if (t.repo) lines.push(`in ${t.repo}`);
  if (t.hunk) lines.push(`hunk ${t.hunk}`);
  if (t.group) lines.push(`group "${t.group}"`);
  if (t.quote != null) lines.push(`the line: ${t.quote.trim()}`);
  else if (t.text) lines.push(`what the reviewer reads there:\n${t.text}`);
  if (t.tab) lines.push(`in the overview, tab ${t.tab}`);
  return lines.join('\n');
}

/** The prompt for one question; the first one also says who the agent is and what to read. */
export function questionPrompt({ root, question, target, first, id = null }) {
  const where = target ? placeText(target) : 'about the whole change (asked from the overview)';
  const intro = first
    ? [
        `[fr] You answer the questions of a human reviewing the feature in ${root} with fr (feature review).`,
        `Read ${ANSWERING} first: how to answer, and when and how to add an answer to ${path.join(root, '.feature-review', 'annotations.json')}.`,
        `Where the reviewer's cursor is now: ${cursorFile(root)} (updated as they move).`,
        `fr is \`fr\`, or \`node ${FR_BIN}\` where that is not on your PATH.`,
        '',
      ]
    : ['[fr] A question from the reviewer.', ''];
  const keep = id
    ? [
        '',
        `Answer in your pane, and always add the answer to \`explanations\` in ${path.join(root, '.feature-review', 'annotations.json')}, with "asked": "${id}", the question word for word${target?.line ? ', and a ref to the lines it is about' : ''}: the reviewer reads it there, under the line, and their question shows as waiting until it is.`,
      ]
    : [];
  return [...intro, `Where: ${where}`, '', 'Question:', question.trim(), ...keep].join('\n');
}

/**
 * Asks: finds the agent (or starts it) and submits the question. → {name, pane, started}.
 * herdr: herdrCli() (tests pass a fake).
 */
export async function askAgent({ root, question, target, id = null, herdr = herdrCli(), env = process.env, kind = 'pi', definition = 'feature-review-ask', model = null, args = [] }) {
  let agent = await findAgent(root, herdr);
  const started = !agent;
  if (!agent) agent = await startAgent({ root, herdr, env, kind, definition, model, args });
  if (agent.status === 'blocked') throw new Error(`${agent.name} waits for an answer in its pane: answer it there first`);
  await herdr(['agent', 'prompt', agent.pane, questionPrompt({ root, question, target, first: started, id })]);
  return { name: agent.name, pane: agent.pane, started, definition: agent.definition ?? null, model: agent.model ?? null, kind: agent.kind ?? kind };
}

/** In herdr? (the ask key needs it.) */
export const inHerdr = (env = process.env) => Boolean(env.HERDR_PANE_ID || env.HERDR_ENV);

/** Writes where the reviewer is, for the agent ("this line"); never fails the viewer. */
export function writeCursor(root, target) {
  try {
    const dir = path.dirname(cursorFile(root));
    if (!fs.existsSync(dir)) return;
    const tmp = `${cursorFile(root)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), ...target }, null, 2) + '\n');
    fs.renameSync(tmp, cursorFile(root));
  } catch {}
}
