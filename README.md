# fr: feature review

Review a large, agent-written change across the worktrees of a feature: a parent
directory with one git worktree per service (or a single worktree). The changes are at
the centre, as in diffview. Why it is built this way: `docs/discovery.md`.

Needs only git and Node 25 or later; `bat` is used for highlighting when it is there.

Colours come from the terminal's theme (light or dark, e.g. any Catppuccin flavour): the
viewer asks the terminal for its background and palette and mixes every tint from them.

## Settings

`~/.config/feature-review/config.toml` (or under `$XDG_CONFIG_HOME`). `fr config init`
writes it with every option commented out and explained; `fr config` shows the settings
in effect and where each comes from.

| setting | default | |
|---|---|---|
| `viewer.vi_mode` | `false` | vi keys in the comment field (`$FR_VI_MODE`, else `$ATF_VI_MODE`, override it) |
| `viewer.layout` | `"auto"` | `split`, `unified`, or split from 110 columns |
| `viewer.lens` | `"groups"` | the lens to open in when there are annotations |
| `viewer.highlight` | `"auto"` | `bat` when installed, `builtin`, `none` |
| `viewer.editor` | `""` | the command `o` opens a line with; `""`: `$VISUAL`, else `$EDITOR`, else `vi` |
| `theme.background` | `"auto"` | ask the terminal, or `light`, `dark`, `"#rrggbb"` where it does not answer (some multiplexers); `$FR_BACKGROUND` overrides it |
| `theme.bat_light` | `"GitHub"` | bat's theme on a light background (`$BAT_THEME`, when set, wins for both) |
| `theme.bat_dark` | `""` | bat's theme on a dark one (`""`: bat's default) |

A command-line flag (`--layout`, `--lens`, `--highlight`) wins over the environment,
which wins over the file. A wrong value or an unknown key is an error that says where.

```sh
git clone <this repository> ~/feature-review
ln -s ~/feature-review/bin/fr.mjs ~/.local/bin/fr   # or: npm link

fr ~/work/idempotent-refunds        # the viewer
fr ~/work/idempotent-refunds --print | less -R
```

## What it shows

- Each worktree from its **merge base with origin's default branch** (`origin/HEAD`) to
  its **working tree**: uncommitted and untracked files are part of the change and marked
  `● uncommitted`. Override the base in `<dir>/feature-review.toml`:
  `base = "origin/release"`, or per worktree `[base]` with `gateway = "origin/feature-x"`.
- One heading per service (branch, base, size, uncommitted files, reviewed count), then
  its files and hunks, side by side from 110 columns, unified below.
- The repositories are only read; the working tree is read through a copy of the index.

### What fr checks itself

Facts the tool verifies, apart from the agent's words; blue badges mark them. Only git is
needed.

- **Verified mechanical**, folded like reviewed hunks (a glance, then `v`):
  - `WHITESPACE ONLY`: re-indented or re-wrapped, the same words in the same order. In
    Python, YAML and Makefiles a change of indentation is not whitespace.
  - `MOVED`: every changed line is part of a block of 3 lines (or a whole short block, at
    least 20 letters or digits) removed or added elsewhere in the change, in any file or
    service; the title says where to (`moved to gateway:H4`). A hunk partly moved says how
    much: `5 of 9 changed lines moved`.
  - `RENAMED ONLY`: a file renamed with its content unchanged.

  A group the agent calls mechanical says how many of its hunks are not verified.
- **Tests and code**, paired by name in the same repository (`FooTest`, `FooTests`,
  `FooIT`, `FooSpec`, `test_foo.py`, `foo_test.py`, `foo.spec.ts`):
  - on a changed source file: `test changed: FooTest.java`, `its test not changed:
    FooTest.java` or `no test found` (verified mechanical changes need none);
  - `EXISTING TEST CHANGED` on a hunk that changes or removes lines of an existing test
    whose code changes too: the expected values may have been made to fit the code;
  - `TEST DELETED`.

`fr hunks` lists the signals too (`mechanical: true` in `--json`), so the agent need not
explain what fr has verified.

## Reviewing

| keys | |
|---|---|
| `]u` `[u` | next / previous hunk not reviewed yet |
| `v` | mark the hunk reviewed and go on to the next one (on a file line: the file) |
| `V` | the whole file reviewed (again: not reviewed) |
| `tab` | lens: the agent's groups, or the services |
| `m` | the overview: design, names, contracts, rollout |
| `]]` `[[` · `]h` `[h` · `]g` `[g` · `]c` `[c` | file (or part) · hunk · group (or service) · comment |
| `space` `z` `Z` | fold the hunk · the file or group · all of them |
| `c` · `e` · `x` | comment on the line (on a file line: the file) · edit · delete |
| `o` | open the line in `$EDITOR` |
| `s` · `r` · `/` · `?` · `q` | side by side ↔ inline · reload · search · help · quit |

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

`m` opens the **overview**, the map of the change beyond its hunks, one tab each:
**Design** (types and responsibilities, new dependencies, signals, how the codebase does
it, the agent's opinion labelled as such), **Names** (flagged ones first, beside what the
codebase calls the same thing), **Contracts** (backward compatible or not, the fields
side by side, consumers changed or not) and **Rollout** (the deploy order, what breaks
while only some services are deployed, configuration). `h`/`l` or `1`-`4` switch tabs;
`⏎` on a citation of the change goes to that code in the review, on other code (an
unchanged consumer, another checkout) shows it in place; `m` goes back. Facts the tool
checks itself are marked **FR NOTICED**, apart from the agent's words.
`fr --print --overview` prints it.

## Development

```sh
npm test                          # node --test; test/viewer.test.mjs drives the viewer
                                  # through a fake terminal (keys in, screens out)
node test/fixture.mjs /tmp/sample [--annotate]  # a sample feature (with annotations) to try fr on
```

`src/md/` and `src/ui/textfield.mjs` are copied from agent-task-framework (each file
says from where and what changed).
