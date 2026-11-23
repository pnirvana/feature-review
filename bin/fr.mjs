#!/usr/bin/env node
// fr: review a feature's change across the worktrees of a parent directory.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadWorkspace } from '../src/workspace.mjs';
import { readState, withoutDeleted } from '../src/state.mjs';
import { buildRows, highlightFiles } from '../src/rows.mjs';
import { annotationsPath, readAnnotations, checkAnnotations, unitIds, hunkRange, stamp } from '../src/annotations.mjs';
import { fit, plain } from '../src/md/term.mjs';
import { loadConfig, initConfig, SETTINGS } from '../src/config.mjs';
import { configureTheme } from '../src/ui/theme.mjs';
import { overviewRows, TABS } from '../src/overview.mjs';
import { feedbackPath, readFeedback, feedbackReport, parseSince } from '../src/feedback.mjs';

const USAGE = `usage: fr [dir] [options]          the viewer (or --print)
       fr hunks [dir] [--json]      the hunks with their ids, for citing them
       fr check [dir] [--stamp]     check the annotation file
       fr config [init]             the settings in effect; init writes the settings file
       fr feedback [--since 2w] [--json]  what the feedback key (!) recorded, by kind

<dir> (default: the current directory) is a parent directory with one git worktree
per service, or a single worktree. Each worktree is compared from its merge base with
origin's default branch to its working tree (uncommitted and untracked files
included). Override the base in <dir>/feature-review.toml: base = "origin/x", or per
worktree: [base] <worktree> = "origin/x".

Settings (vi mode, layout, theme, editor, …): ~/.config/feature-review/config.toml;
fr config shows them, fr config init writes the file with every option explained.

The annotation file is <dir>/.feature-review/annotations.json (docs/annotations.md).
fr check resolves every citation and exits 1 on errors; --stamp then records the
state of the code the annotations fit, so the viewer can tell when they are stale.

options:
  --print           print the review instead of opening the viewer
  --overview        with --print: the overview instead (design, names, contracts, rollout)
  --plain           with --print: no colours
  --width N         with --print: the width (default: the terminal's, or 120)
  --layout L        auto | split | unified (default auto: split from 110 columns)
  --lens L          groups | services (default groups, when there are annotations)
  --highlight M     auto | bat | builtin | none (default auto: bat if installed)
                    (these three override the settings file)
  --since T         with feedback: only entries since T (2w, 10d, 36h or a date)
  --json            with hunks, check and feedback: JSON output
  -h, --help        this help

Review state (marks, comments) is kept in <dir>/.feature-review/.`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      print: { type: 'boolean' },
      overview: { type: 'boolean' },
      plain: { type: 'boolean' },
      width: { type: 'string' },
      layout: { type: 'string' },
      lens: { type: 'string' },
      highlight: { type: 'string' },
      json: { type: 'boolean' },
      stamp: { type: 'boolean' },
      since: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (e) {
  console.error(`fr: ${e.message}\n\n${USAGE}`);
  process.exit(2);
}
const o = args.values;
if (o.help) {
  console.log(USAGE);
  process.exit(0);
}
const pos = [...args.positionals];
const cmd = ['hunks', 'check', 'config', 'feedback'].includes(pos[0]) ? pos.shift() : 'view';
let cfg;
try {
  cfg = loadConfig({ flags: { layout: o.layout, lens: o.lens, highlight: o.highlight } });
} catch (e) {
  console.error(`fr: ${e.message}`);
  process.exit(2);
}
const set = cfg.values;
const dir = path.resolve(cmd === 'config' || cmd === 'feedback' ? '.' : (pos[0] ?? '.'));
// piped into head or less that quits early: not an error
process.stdout.on('error', (e) => process.exit(e.code === 'EPIPE' ? 0 : 1));

const range = ([a, b]) => (a === b ? `${a}` : `${a}-${b}`);

async function hunks() {
  const ws = await loadWorkspace(dir);
  const sigText = (s) => [s.label?.toLowerCase(), s.text].filter(Boolean).join(': ');
  const list = unitIds(ws).map(({ id, unit, repo, f, h }) => ({
    id,
    repo,
    file: f.file,
    ...(f.old && f.old !== f.file ? { old_file: f.old } : {}),
    status: f.status,
    ...(h && f.status !== 'A' ? { old_lines: range(hunkRange(h, 'old')) } : {}),
    ...(h && f.status !== 'D' ? { new_lines: range(hunkRange(h, 'new')) } : {}),
    add: h ? h.lines.filter(([t]) => t === '+').length : 0,
    del: h ? h.lines.filter(([t]) => t === '-').length : 0,
    ...(h?.header ? { context: h.header } : {}),
    ...(f.dirty ? { uncommitted: true } : {}),
    ...(f.binary ? { binary: true } : {}),
    // what fr verified itself: an agent may skip explaining these
    ...(ws.signals.mechanical.has(unit) ? { mechanical: true } : {}),
    ...(ws.signals.units.get(unit)?.length ? { signals: ws.signals.units.get(unit).map(sigText) } : {}),
  }));
  if (o.json) return console.log(JSON.stringify(list, null, 2));
  for (const r of ws.repos) {
    console.log(`${r.name}${r.error ? `  ${r.error}` : `  base ${r.baseRef} ${r.base?.slice(0, 7)}`}`);
    const mine = list.filter((y) => y.repo === r.name);
    const w = Math.max(0, ...mine.map((y) => y.id.length));
    for (const x of mine) {
      const lines = [x.old_lines && `old ${x.old_lines}`, x.new_lines && `new ${x.new_lines}`].filter(Boolean).join(' ') || (x.status === 'R' ? `renamed from ${x.old_file}` : 'no lines');
      console.log(`  ${x.id.padEnd(w)}  ${x.status} ${x.file}  ${lines}  +${x.add} −${x.del}${x.context ? `  ${x.context}` : ''}${x.uncommitted ? '  (uncommitted)' : ''}${x.signals ? `  [${x.signals.join('; ')}]` : ''}`);
    }
  }
}

async function check() {
  const ws = await loadWorkspace(dir);
  const { ann, error } = readAnnotations(ws.root);
  if (error || !ann) {
    const msg = error ?? `no annotation file: ${annotationsPath(ws.root)}`;
    if (o.json) console.log(JSON.stringify({ ok: false, errors: [{ at: '', msg }], warnings: [] }, null, 2));
    else console.error(`fr check: ${msg}`);
    process.exit(1);
  }
  const res = await checkAnnotations(ann, ws);
  const ok = res.errors.length === 0;
  let stamped = false;
  if (ok && o.stamp) {
    const p = annotationsPath(ws.root);
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(stamp(ann, ws), null, 2) + '\n');
    fs.renameSync(`${p}.tmp`, p);
    stamped = true;
  }
  const citations = [...res.refs.values()].length;
  if (o.json) {
    console.log(JSON.stringify({ ok, errors: res.errors, warnings: res.warnings, groups: res.groups.length, citations, ungrouped: res.ungrouped, multi: res.multi, stamped }, null, 2));
  } else {
    for (const e of res.errors) console.log(`error   ${e.at}: ${e.msg}`);
    for (const w of res.warnings) console.log(`warning ${w.at}: ${w.msg}`);
    const grouped = res.ids.length - res.ungrouped.length;
    console.log(
      `${ok ? 'ok' : `${res.errors.length} error(s)`}: ${res.groups.length} group(s), ${citations} citation(s), ${grouped}/${res.ids.length} hunks grouped` +
        (stamped ? '; stamped with the current state of the code' : ok && !o.stamp ? '' : !ok && o.stamp ? '; not stamped (fix the errors first)' : ''),
    );
  }
  process.exit(ok ? 0 : 1);
}

function config() {
  if (pos[0] === 'init') {
    const { file, written } = initConfig();
    console.log(written ? `wrote ${file}: every option is commented out, uncomment what you change` : `${file} exists: not changed`);
    return;
  }
  if (pos[0]) throw new Error(`fr config ${pos[0]}: use fr config, or fr config init`);
  console.log(`${cfg.file}${cfg.exists ? '' : '  (not there: fr config init writes it)'}\n`);
  const w = Math.max(...SETTINGS.map((s) => s.key.length));
  for (const s of SETTINGS) {
    const src = cfg.sources[s.key];
    console.log(`${s.key.padEnd(w)}  ${JSON.stringify(set[s.key]).padEnd(12)}  ${src === cfg.file ? 'from the file' : src === 'default' ? 'default' : src === 'flag' ? 'from the command line' : `from ${src}`}`);
  }
}

function feedback() {
  const file = feedbackPath(process.env, set['feedback.file']);
  const { entries, bad } = readFeedback(file);
  const from = o.since ? parseSince(o.since) : -Infinity;
  const es = entries.filter((e) => Date.parse(e.at) >= from);
  if (o.json) return console.log(JSON.stringify(es, null, 2));
  console.log(feedbackReport(es, { bad, file }));
}

async function view() {
  const askTerminal = configureTheme(set);
  const lensWanted = o.lens ?? (cfg.sources['viewer.lens'] === 'default' ? null : set['viewer.lens']);
  if (o.print || !process.stdout.isTTY || !process.stdin.isTTY) {
    const ws = await loadWorkspace(dir);
    const st = readState(ws.root);
    const width = Number(o.width) || process.stdout.columns || 120;
    const { ann, error } = readAnnotations(ws.root);
    if (error) console.error(`fr: ${error}`);
    withoutDeleted(ann, st); // the explanations the reviewer deleted
    const checked = ann ? await checkAnnotations(ann, ws) : null;
    const hl = await highlightFiles(ws, o.plain ? 'none' : set['viewer.highlight']);
    if (o.overview) {
      if (!ann) throw new Error(`no annotations: ${annotationsPath(ws.root)}`);
      const out = [];
      for (const t of TABS) {
        out.push(`${o.plain ? '' : '\x1b[1m'}${t.title}${o.plain ? '' : '\x1b[0m'}`, '');
        for (const r of overviewRows({ ann, ...checked }, t.id, { width })) out.push(o.plain ? plain(r.segs).trimEnd() : fit(r.segs, width));
        out.push('', '');
      }
      return void process.stdout.write(out.join('\n').trimEnd() + '\n');
    }
    const lens = lensWanted ?? (checked?.groups.length ? 'groups' : 'services');
    const rows = buildRows(ws, st, { width, layout: set['viewer.layout'], hl, tint: !o.plain, lens, ann: checked && { ann, ...checked } });
    process.stdout.write(rows.map((r) => (o.plain ? plain(r.segs).trimEnd() : fit(r.segs, width))).join('\n') + '\n');
  } else {
    const { runViewer } = await import('../src/viewer.mjs');
    await runViewer({ dir, layout: set['viewer.layout'], highlight: set['viewer.highlight'], lens: lensWanted, queryTheme: askTerminal, viMode: set['viewer.vi_mode'], editor: set['viewer.editor'], feedbackFile: feedbackPath(process.env, set['feedback.file']), agentKind: set['agent.kind'], agentDefinition: set['agent.definition'], agentModel: set['agent.model'], agentArgs: set['agent.args'].split(/\s+/).filter(Boolean) });
  }
}

try {
  await { hunks, check, config, feedback, view }[cmd]();
} catch (e) {
  console.error(`fr: ${e.message}`);
  process.exit(1);
}
