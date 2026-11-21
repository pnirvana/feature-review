#!/usr/bin/env node
// fr: review a feature's change across the worktrees of a parent directory.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadWorkspace } from '../src/workspace.mjs';
import { readState } from '../src/state.mjs';
import { buildRows, highlightFiles } from '../src/rows.mjs';
import { annotationsPath, readAnnotations, checkAnnotations, unitIds, hunkRange, stamp } from '../src/annotations.mjs';
import { fit, plain } from '../src/md/term.mjs';

const USAGE = `usage: fr [dir] [options]          the viewer (or --print)
       fr hunks [dir] [--json]      the hunks with their ids, for citing them
       fr check [dir] [--stamp]     check the annotation file

<dir> (default: the current directory) is a parent directory with one git worktree
per service, or a single worktree. Each worktree is compared from its merge base with
origin's default branch to its working tree (uncommitted and untracked files
included). Override the base in <dir>/feature-review.json: {"base": "origin/x"} or
{"base": {"<worktree>": "origin/x"}}.

The annotation file is <dir>/.feature-review/annotations.json (docs/annotations.md).
fr check resolves every citation and exits 1 on errors; --stamp then records the
state of the code the annotations fit, so the viewer can tell when they are stale.

options:
  --print           print the review instead of opening the viewer
  --plain           with --print: no colours
  --width N         with --print: the width (default: the terminal's, or 120)
  --layout L        auto | split | unified (default auto: split from 110 columns)
  --lens L          groups | services (default: groups when there are annotations)
  --highlight M     auto | bat | builtin | none (default auto: bat if installed)
  --json            with hunks and check: JSON output
  -h, --help        this help

Review state (marks, comments) is kept in <dir>/.feature-review/.`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      print: { type: 'boolean' },
      plain: { type: 'boolean' },
      width: { type: 'string' },
      layout: { type: 'string', default: 'auto' },
      lens: { type: 'string' },
      highlight: { type: 'string', default: 'auto' },
      json: { type: 'boolean' },
      stamp: { type: 'boolean' },
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
const cmd = ['hunks', 'check'].includes(pos[0]) ? pos.shift() : 'view';
if (!['auto', 'split', 'unified'].includes(o.layout)) {
  console.error(`fr: --layout ${o.layout}: use auto, split or unified`);
  process.exit(2);
}
if (o.lens && !['groups', 'services'].includes(o.lens)) {
  console.error(`fr: --lens ${o.lens}: use groups or services`);
  process.exit(2);
}
const dir = path.resolve(pos[0] ?? '.');
// piped into head or less that quits early: not an error
process.stdout.on('error', (e) => process.exit(e.code === 'EPIPE' ? 0 : 1));

const range = ([a, b]) => (a === b ? `${a}` : `${a}-${b}`);

async function hunks() {
  const ws = await loadWorkspace(dir);
  const list = unitIds(ws).map(({ id, repo, f, h }) => ({
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
  }));
  if (o.json) return console.log(JSON.stringify(list, null, 2));
  for (const r of ws.repos) {
    console.log(`${r.name}${r.error ? `  ${r.error}` : `  base ${r.baseRef} ${r.base?.slice(0, 7)}`}`);
    const mine = list.filter((y) => y.repo === r.name);
    const w = Math.max(0, ...mine.map((y) => y.id.length));
    for (const x of mine) {
      const lines = [x.old_lines && `old ${x.old_lines}`, x.new_lines && `new ${x.new_lines}`].filter(Boolean).join(' ') || (x.status === 'R' ? `renamed from ${x.old_file}` : 'no lines');
      console.log(`  ${x.id.padEnd(w)}  ${x.status} ${x.file}  ${lines}  +${x.add} −${x.del}${x.context ? `  ${x.context}` : ''}${x.uncommitted ? '  (uncommitted)' : ''}`);
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

async function view() {
  if (o.print || !process.stdout.isTTY || !process.stdin.isTTY) {
    const ws = await loadWorkspace(dir);
    const st = readState(ws.root);
    const width = Number(o.width) || process.stdout.columns || 120;
    const { ann, error } = readAnnotations(ws.root);
    if (error) console.error(`fr: ${error}`);
    const checked = ann ? await checkAnnotations(ann, ws) : null;
    const hl = await highlightFiles(ws, o.plain ? 'none' : o.highlight);
    const lens = o.lens ?? (checked?.groups.length ? 'groups' : 'services');
    const rows = buildRows(ws, st, { width, layout: o.layout, hl, tint: !o.plain, lens, ann: checked && { ann, ...checked } });
    process.stdout.write(rows.map((r) => (o.plain ? plain(r.segs).trimEnd() : fit(r.segs, width))).join('\n') + '\n');
  } else {
    const { runViewer } = await import('../src/viewer.mjs');
    await runViewer({ dir, layout: o.layout, highlight: o.highlight, lens: o.lens });
  }
}

try {
  await { hunks, check, view }[cmd]();
} catch (e) {
  console.error(`fr: ${e.message}`);
  process.exit(1);
}
