# fr: feature review

Review a large, agent-written change across the worktrees of a feature: a parent
directory with one git worktree per service (or a single worktree). The changes are at
the centre, as in diffview. Why it is built this way: `docs/discovery.md`.

Needs only git and Node 25 or later; `bat` is used for highlighting when it is there.

Colours come from the terminal's theme (light or dark, e.g. any Catppuccin flavour): the
viewer asks the terminal for its background and palette and mixes every tint from them.
Where the terminal does not answer (some multiplexers), set `FR_BACKGROUND=light`,
`dark` or `#rrggbb`. Code highlighting is bat's: `BAT_THEME` if set, else
`BAT_THEME_LIGHT` / `BAT_THEME_DARK` for the terminal's background, else `GitHub` on a
light one and bat's default on a dark one.

```sh
git clone <this repository> ~/feature-review
ln -s ~/feature-review/bin/fr.mjs ~/.local/bin/fr   # or: npm link

fr ~/work/idempotent-refunds        # the viewer
fr ~/work/idempotent-refunds --print | less -R
```

## What it shows

- Each worktree from its **merge base with origin's default branch** (`origin/HEAD`) to
  its **working tree**: uncommitted and untracked files are part of the change and marked
  `● uncommitted`. Override the base in `<dir>/feature-review.json`:
  `{"base": "origin/release"}` or `{"base": {"gateway": "origin/feature-x"}}`.
- One heading per service (branch, base, size, uncommitted files, reviewed count), then
  its files and hunks, side by side from 110 columns, unified below.
- The repositories are only read; the working tree is read through a copy of the index.

## Reviewing

| keys | |
|---|---|
| `]u` `[u` | next / previous hunk not reviewed yet |
| `v` | mark the hunk reviewed and go on to the next one (on a file line: the file) |
| `V` | the whole file reviewed (again: not reviewed) |
| `tab` | lens: the agent's groups, or the services |
| `]]` `[[` · `]h` `[h` · `]g` `[g` · `]c` `[c` | file (or part) · hunk · group (or service) · comment |
| `space` `z` `Z` | fold the hunk · the file or group · all of them |
| `c` · `e` · `x` | comment on the line (on a file line: the file) · edit · delete |
| `o` | open the line in `$EDITOR` |
| `s` · `r` · `/` · `?` · `q` | layout · reload · search · help · quit |

Reviewed hunks and files fold away. A mark is keyed by the hunk's repository, file and
changed lines, so it survives a rebase and resets when the hunk changes. A comment
follows its line when the code around it moves, and shows as outdated when the line is
gone. Marks and comments are in `<dir>/.feature-review/state.json`.

## The agent's annotations

An agent writes `<dir>/.feature-review/annotations.json` (format: `docs/annotations.md`):
feature groups across services with their why and risk, and notes on design, names,
tests, unchanged callers and contracts. Every claim cites code; the tool shows the code.

```sh
fr hunks <dir>            # the hunks with ids (gateway:H3) for the agent to cite
fr check <dir>            # every citation resolves? enums known? every hunk in a group?
fr check <dir> --stamp    # once clean: record the state of the code the notes fit
```

With annotations, the viewer opens in the **groups lens**: the groups in the agent's
reading order (riskiest first), each with its parts across services, then **Not
grouped**: every hunk no group explains. `tab` switches to the services lens. `]u` and
`v` follow the lens's reading order; `v` on a group line marks the whole group. A group
the agent calls mechanical starts folded and says "claimed, not verified". The viewer
reloads the file when the agent rewrites it, and says when the notes may be stale.

Under a hunk, in either lens: the **unchanged callers** that depend on it (status
broken, unclear or ok, with their code), and **test intents** under a test's hunk (the
behaviour it specifies, what it really asserts, flags such as a loosened assertion with
the old line). Text in the annotations is Markdown.

## Development

```sh
npm test                          # node --test
node test/fixture.mjs /tmp/sample [--annotate]  # a sample feature (with annotations) to try fr on
```

`src/md/` and `src/ui/textfield.mjs` are copied from agent-task-framework (each file
says from where and what changed).
