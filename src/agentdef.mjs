// The definition of the agent the ask key starts (agent/agents/feature-review-ask.md):
// Markdown with frontmatter (name, description, tools, model, thinking, skills) whose body
// is the agent's system prompt, as pi's subagent extension and ATF read them. Adapted from
// ATF's adapters/herdr/lib/agents.mjs.
//
// Found, later ones winning: fr's own (agent/agents, so it works without install.sh), the
// user's (~/.pi/agent/agents), the nearest project's (.pi/agents above the feature).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OWN_AGENTS = path.join(HERE, '..', 'agent', 'agents');
export const OWN_SKILL = path.join(HERE, '..', 'agent', 'skill', 'feature-review');
const piDir = (env) => env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');

/** Frontmatter as flat key: value (lists in [a, b] or a, b), comments skipped; the body. */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else v = v.replace(/^["']|["']$/g, '');
    fm[kv[1]] = v;
  }
  return { fm, body: m[2] };
}

const list = (t) => (Array.isArray(t) ? t : typeof t === 'string' ? t.split(',') : []).map((x) => String(x).trim()).filter(Boolean);

function fromDir(dir, name) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const file = path.join(dir, f);
      const { fm, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      if (fm.name !== name) continue;
      return { name, model: str(fm.model), thinking: str(fm.thinking), tools: list(fm.tools), skills: list(fm.skills), prompt: body.trim() || null, file };
    } catch {}
  }
  return null;
}
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function nearest(from, rel) {
  for (let d = path.resolve(from); ; d = path.dirname(d)) {
    const c = path.join(d, rel);
    if (fs.existsSync(c)) return c;
    if (path.dirname(d) === d) return null;
  }
}

/** The definition named `name`, as seen from the feature directory; null if none. */
export function findDefinition(name, root, { env = process.env, own = OWN_AGENTS } = {}) {
  const dirs = [own, path.join(piDir(env), 'agents'), nearest(root, path.join('.pi', 'agents'))].filter(Boolean);
  let found = null;
  for (const d of dirs) found = fromDir(d, name) ?? found;
  return found;
}

/**
 * The agent's arguments for a definition, by agent kind. Pi: --model, --thinking,
 * --tools, --append-system-prompt (the body, in a file in promptDir), --skill for a
 * skill Pi does not have installed. Claude: --model, --append-system-prompt (text).
 * Other kinds: none (they start as configured). model: fr's agent.model, winning over
 * the definition's. → {args, model}
 */
export function definitionArgs(kind, def, { model = null, promptDir, env = process.env } = {}) {
  const m = model || def?.model || null;
  if (kind === 'pi') {
    const args = [];
    if (m) args.push('--model', m);
    if (def?.thinking) args.push('--thinking', def.thinking);
    if (def?.tools?.length) args.push('--tools', def.tools.join(','));
    if (def?.prompt) {
      fs.mkdirSync(promptDir, { recursive: true });
      const tag = crypto.createHash('sha1').update(def.file ?? def.name).digest('hex').slice(0, 8);
      const file = path.join(promptDir, `${def.name.replace(/[^\w.-]/g, '_')}-${tag}.md`);
      fs.writeFileSync(file, def.prompt, { mode: 0o600 });
      args.push('--append-system-prompt', file);
    }
    for (const s of def?.skills ?? []) if (s === 'feature-review' && !fs.existsSync(path.join(piDir(env), 'skills', s))) args.push('--skill', OWN_SKILL);
    return { args, model: m };
  }
  if (kind === 'claude') return { args: [...(m ? ['--model', m] : []), ...(def?.prompt ? ['--append-system-prompt', def.prompt] : [])], model: m };
  return { args: [], model: null };
}
