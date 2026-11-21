#!/usr/bin/env node
// fr: review a feature's change across the worktrees of a parent directory.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadWorkspace } from '../src/workspace.mjs';
import { readState } from '../src/state.mjs';
import { buildRows, highlightFiles } from '../src/rows.mjs';
import { fit, plain } from '../src/md/term.mjs';

const USAGE = `usage: fr [dir] [options]

Review the change in <dir> (default: the current directory): a parent directory with
one git worktree per service, or a single worktree. Each worktree is compared from its
merge base with origin's default branch to its working tree (uncommitted and untracked
files included). Override the base in <dir>/feature-review.json: {"base": "origin/x"}
or {"base": {"<worktree>": "origin/x"}}.

options:
  --print           print the review instead of opening the viewer
  --plain           with --print: no colours
  --width N         with --print: the width (default: the terminal's, or 120)
  --layout L        auto | split | unified (default auto: split from 110 columns)
  --highlight M     auto | bat | builtin | none (default auto: bat if installed)
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
      highlight: { type: 'string', default: 'auto' },
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
if (!['auto', 'split', 'unified'].includes(o.layout)) {
  console.error(`fr: --layout ${o.layout}: use auto, split or unified`);
  process.exit(2);
}
const dir = path.resolve(args.positionals[0] ?? '.');
// piped into head or less that quits early: not an error
process.stdout.on('error', (e) => process.exit(e.code === 'EPIPE' ? 0 : 1));

try {
  if (o.print || !process.stdout.isTTY || !process.stdin.isTTY) {
    const ws = await loadWorkspace(dir);
    const st = readState(ws.root);
    const width = Number(o.width) || process.stdout.columns || 120;
    const hl = await highlightFiles(ws, o.plain ? 'none' : o.highlight);
    const rows = buildRows(ws, st, { width, layout: o.layout, hl, tint: !o.plain });
    process.stdout.write(rows.map((r) => (o.plain ? plain(r.segs).trimEnd() : fit(r.segs, width))).join('\n') + '\n');
  } else {
    const { runViewer } = await import('../src/viewer.mjs');
    await runViewer({ dir, layout: o.layout, highlight: o.highlight });
  }
} catch (e) {
  console.error(`fr: ${e.message}`);
  process.exit(1);
}
