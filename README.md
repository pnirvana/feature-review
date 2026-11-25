# fr: feature review

Review a large, agent-written change across the worktrees of a feature: a parent
directory with one git worktree per service (or a single worktree). The changes are at
the centre, as in diffview. Why it is built this way: `docs/discovery.md`.

Needs only git and Node 25 or later; `bat` is used for highlighting when it is there.

Colours come from the terminal's theme (light or dark, e.g. any Catppuccin flavour): the
viewer asks the terminal for its background and palette and mixes every tint from them.

## Install (on the devpod)

```
./install.sh
```

It links `fr` into `~/.local/bin`, and the review-preparing agent into Pi
(`~/.pi/agent`): the skill `feature-review` and the agent definition
`feature-review-prep`. Nothing is downloaded. Safe to run again.

## Preparing a review: the agent

The annotations come from a dedicated agent, not the one that made the change. The ATF
coordinator starts it as a task once the implementing agents are done, for example
`atf-herdr spawn T9 --agent feature-review-prep`. The task names the feature directory,
the intent (the issue text) and any other checkouts to search for consumers. The agent
reads the change and writes `<dir>/.feature-review/annotations.json`. It changes no
code. It runs `fr check` until the file is clean, stamps it, and finishes the task with
how to open the review and what needs a real read.

`agent/skill/feature-review/SKILL.md` holds its procedure and rules. Its references
hold the method, one file per concern as in review-agents: behaviour, design, language
and tests, contracts and callers, then a verification pass that tries to refute it all;
`writing.md` says where each result goes in fr's file. The skill uses
the Agent Skills format, so harnesses other than Pi can load it too.

## Asking while you review

`A` asks an agent about the line under the cursor. In the overview it asks about the
entry under the cursor (a design note, a name, a contract, a rollout step, or the tab
itself), and the answer shows under that entry; in the Questions tab, about the whole
change. Asked on text rather than a line of code (a group's header or description, a
part's note, the intent), the question and its answer show under the paragraph asked
on; asked on a note in the diff (a finding, a test's intent, an answer), right under that
note, whatever the answer cites. The question is written in the same multi-line field as a comment; fr sends it
with the place (repository, file, line, hunk, group, the line's text or the note under
the cursor) to an agent in a herdr pane beside fr. The first question opens that pane and
starts the agent there (`agent.kind`, Pi by default) as the agent definition
`feature-review-ask` (`agent/agents/feature-review-ask.md`: its model, thinking level,
tools and instructions), named `fr-<feature>`, or
`fr-<feature>-2` and so on when that name is taken. fr records its pane in
`<dir>/.feature-review/agent.json` and only ever sends to that pane, never to another
agent with a similar name.

The agent answers in its pane, where you can go on talking to it ("this line" there
means the cursor, which fr keeps in `<dir>/.feature-review/cursor.json`), and in the
annotation file's `explanations`: under the line, your question above the answer, marked
EXPLAINED and tinted apart from the prepared review, and in the overview's Questions tab.
Until the answer is there, your question shows at its line as ASKED and the header counts
the questions waiting: fr keeps what it sent in the review state, and the agent's answer
carries the question's id. When it arrives, its block shows again if you hid its notes
(`h`) or folded it, without moving your view. `f` `5` hides the answers; space folds one
to a single line. `x` on an answer you no longer need (in the diff or the Questions tab), twice,
deletes it with its question, and `x` on a question still waiting deletes that. The
deletion is kept in the review state, not in the agent's file (the agent rewrites it and
would bring the answer back): fr shows it nowhere again, `--print` included. Its instructions: `references/answering.md` in the
skill. `A` needs herdr; outside it, it says so.

**Which model.** The definition pins none, so the agent uses Pi's default, and the
flash on starting it says which. Set `agent.model` (e.g. `"anthropic/claude-sonnet-5-5"`)
for the ask agent alone, or uncomment `model:` and `thinking:` in a copy of the
definition in `~/.pi/agent/agents` (install.sh links fr's; replace the link with a file).
A running agent keeps its model: close its pane, and the next `A` starts a new one.

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
| `agent.kind` | `"pi"` | the agent `A` starts beside fr, as herdr names it (`pi`, `claude`, `codex`, …; `$FR_AGENT` overrides it) |
| `agent.definition` | `"feature-review-ask"` | the agent definition it runs as: fr's own, overridden by one of that name in `~/.pi/agent/agents` or the project's `.pi/agents`; `""`: none |
| `agent.model` | `""` | its model, winning over the definition's (`""`: the definition's, else the agent's default; `$FR_AGENT_MODEL`) |
| `agent.args` | `""` | extra arguments for it, split at spaces (`$FR_AGENT_ARGS`) |
| `feedback.file` | `""` | where `!` appends its entries; `""`: `$XDG_STATE_HOME/feature-review/feedback.jsonl`, else `~/.local/state/…` (`$FR_FEEDBACK` overrides it) |
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
  `● uncommitted`. Without `origin/HEAD` (a remote added by hand, or none), fr guesses:
  another remote's default branch, else `<remote>/main` or `master`, else the local
  `main` or `master`, and says "(guessed)". Override the base in `<dir>/feature-review.toml`:
  `base = "origin/release"`, or per worktree `[base]` with `gateway = "origin/feature-x"`.
- One heading per service (branch, base, size, uncommitted files, reviewed count), then
  its files and hunks, side by side from 110 columns, unified below.
- The repositories are only read; the working tree is read through a copy of the index.

### What fr checks itself

Facts the tool verifies, apart from the agent's words: blue badges, in a block under the
hunk or file they are about. A filled badge with yellow text asks you to look; an outlined
one is information. Colour says who speaks (blue fr, the agent's notes their own, your
comments magenta), not the kind of fact. Only git is needed.

- **Verified mechanical**, folded like reviewed hunks (a glance, then `v`):
  - `WHITESPACE ONLY`: re-indented or re-wrapped, the same words in the same order. In
    Python, YAML and Makefiles a change of indentation is not whitespace.
  - `MOVED`: every changed line is part of a block of 3 lines (or a whole short block, at
    least 20 letters or digits) removed or added elsewhere in the change, in any file or
    service, with where to (`moved to gateway:H4`). A hunk partly moved says how much:
    `PARTLY MOVED 5 of 9 changed lines`.
  - `RENAMED ONLY`: a file renamed with its content unchanged.

  A group the agent calls mechanical says how many of its hunks are not verified.
- **Tests and code**, paired by name in the same repository (`FooTest`, `FooTests`,
  `FooIT`, `FooSpec`, `test_foo.py`, `foo_test.py`, `foo.spec.ts`):
  - on a changed source file: `TEST CHANGED`, `TEST NOT CHANGED` or `NO TEST`, with the
    test's name (verified mechanical changes need none); on a test file: `TESTS` and its
    code, when that changed too. In the services lens a changed test comes right after
    its code instead of in file order; `gt` jumps between the two in either lens;
  - `EXISTING TEST CHANGED` on a hunk that changes or removes lines of an existing test
    whose code changes too: the expected values may have been made to fit the code;
  - `TEST DELETED`.
- **Weakened tests**, read from each changed test file before and after (JUnit, AssertJ,
  Mockito, Spock, pytest, unittest, Jest-style; line based, so a hint, not a proof):
  - `ASSERTION REMOVED` (when the file has fewer assertions, not merely moved ones; the
    file says `FEWER ASSERTIONS 5 → 3`);
  - `ASSERTION LOOSENED`: an exact check traded for a weaker one (`assertEquals →
    assertNotNull`, `times → atLeast`), or values for wildcards (`any()`, Spock's `_`);
  - `EXPECTED VALUE CHANGED`: the same assertion with another value (`10 → 20`), and
    with which code when that changed too;
  - `TEST DISABLED` (`@Disabled`, `@Ignore`, `@pytest.mark.skip`, `it.skip`, assumptions),
    `CATCHES ANY EXCEPTION`, `LONGER TIMEOUT`;
  - `ASSERTS NOTHING` or `ONLY CHECKS NOTHING IS THROWN` on a new test, with its name, to
    hold against what it claims.

- **Coverage of the changed lines**, from the JaCoCo reports a build left in the
  worktrees (Maven `target/site/*/jacoco.xml`, Gradle `build/reports/jacoco/*/*.xml`, in
  any module; or `[coverage] <worktree> = ["path/to/jacoco.xml"]` in
  `<dir>/feature-review.toml`). Each added line gets a dot right after its number: `●`
  a test runs it, `◐` some branches are not taken, `○` no test runs it (a shape apart
  from the bars `▌` of findings in the gutter). Each hunk says `NOT COVERED 2 of 8
  changed lines · not run: 7, 14, 18-19; branches not taken: 5, 13`, `BRANCHES NOT
  TAKEN` or `COVERED`. JaCoCo counts a line's branches but does not say which was not
  taken; where the code says it, fr does, under the line: an `if` or loop whose body
  never ran is `NEVER ENTERED`, one whose body ran but was never skipped `NEVER
  SKIPPED`. Elsewhere the `◐` alone says it. Several reports are merged. A report
  older than a file marks nothing in it (`COVERAGE OUT OF DATE`: its line numbers may
  have moved). The service's heading says how old the reports are, or that there is none.

`fr hunks` lists the signals too (`mechanical: true` in `--json`), so the agent need not
explain what fr has verified.

## Reviewing

| keys | |
|---|---|
| `]u` `[u` | next / previous hunk not reviewed yet |
| `v` | mark the hunk reviewed and go on to the next one (on a file line: the file) |
| `V` | the whole file reviewed (again: not reviewed) |
| `tab` | lens: the agent's groups, or the services |
| `m` | the overview: design, names, contracts, rollout, questions |
| `]]` `[[` · `]h` `[h` · `]g` `[g` · `]c` `[c` | file (or part) · hunk · group (or service) · comment |
| `gt` | from code to its test in the change, or back (`⏎` on a `TESTS` line: that file) |
| `⏎` | on an unchanged caller in the diff: show its code, or hide it |
| `f` | show or hide kinds of markers, notes and marks: `1` agent · `2` fr · `3` coverage · `4` comments · `5` questions · `0` all (`f` `1` `2` `4`: coverage alone) |
| `h` | hide every note in the diff block under the cursor (findings, fr's notes, answers, the test's intent; the gutter marks and your comments stay); its `@@` title says how many; again: show them |
| `a` | hide the annotations in and around the code: findings in the diff, fr's notes, test intents (their gutter marks stay; the intent, the groups' reasons and your comments stay); again: show them |
| `space` `z` `Z` | fold the hunk (on a note: the note, to one line, counted in the header) · the file or group · all of them |
| `c` · `e` · `x` | comment on the line (on a file line: the file) · edit · delete (`x` on an answer or a waiting question: delete it, twice) |
| `o` | open the line in `$EDITOR` |
| `p` | peek at the code a note points at, in a pane below; see "Peeking at what a note cites" |
| `A` | ask the agent beside fr about the line under the cursor (in the overview: the entry under it; in the Questions tab: the whole change); see "Asking while you review" |
| `!` | feedback on what is under the cursor: `h` helped · `m` missing here · `w` wrong, then an optional note |
| `s` · `r` · `/` · `?` · `q` | side by side ↔ inline · reload · search as you type (⏎ keeps the match, esc goes back) · help · quit |

Reviewed hunks and files fold away. A mark is keyed by the hunk's repository, file and
changed lines, so it survives a rebase and resets when the hunk changes. A comment
follows its line when the code around it moves, and shows as outdated when the line is
gone. Marks and comments are in `<dir>/.feature-review/state.json`.

### Peeking at what a note cites

Notes name other code all the time: the caller a ghost is about, a contract's
consumers, a precedent, the types an answer talks about. `p` on a note shows that code in
a pane over the lower part of the screen; the note and the diff above it stay where they
are. On a line of code, `p` shows that line's whole file, the change in place and the
cursor on the line (to read the code around a hunk without leaving it; `-` narrows it),
then what the notes under the line cite; in the overview,
at what the entry under the cursor cites (on a citation's own row: that one first).

What a note points at, in this order: first what the row under the cursor names, in the
order it stands on the row (put the cursor on the line of the text that names it), then the note's citations (as `fr
check` resolved them), the files its text names (`helm/values.yaml`,
`RefundService.java:12`), and the types, methods and fields it names
(`RefundService.refund`, `IdempotencyKey`, `refundable`), found by their declaration with
`git grep` and marked "found by name": a guess, though one that exists. The code the note
already sits under comes last; when that is all there is, fr says so. When there is more
than one place, a line under the pane's title lists them, numbered, the one shown marked:
a row has no column cursor, so `p` starts on the first and the digit picks another.

The pane shows the file around the cited lines, marked in the gutter. A file in the
change shows with the change in place, its removed lines among the others, and code at
the base or outside the feature says so. The pane has a cursor of its own, starting on
the cited lines (the review's stays marked, dim); the footer says where it is.

| in the peek | |
|---|---|
| `j` `k` · `ctrl-d` `ctrl-u` · `gg` `G` | move the cursor, the pane scrolling with it |
| `n` `N` · `1`-`9` | the next / previous place the note points at · the one with that number in the list |
| `+` `-` | more / less around it, up to the whole file (the cursor stays on its line) |
| `=` | full screen, or back |
| `⏎` | go to the cursor's line in the review (when it is in the change); `gt` comes back to where you were, the peek open again |
| `o` | open the cursor's line in `$EDITOR` (code at the base: a read-only copy) |
| `esc` `p` | close it: you are where you were |

A note's text can also point at another part of the review: a finding, a group, a
design entry, a name or a contract, as a link the agent writes
(`[the check-then-act finding](#finding:check-then-act)`, shown as its text), or a hunk
id (`gateway:H3`). These join the same list: the pane shows that part as the review does
(a finding with its code, a group with its why and parts, an overview entry), and `⏎`
goes there, into the overview for an entry of it; `gt` comes back. A link that points
nowhere says so; `fr check` reports it, and warns where a note refers to another part in
words only.

### Feedback: does fr earn its place?

`!` records, at the cursor, that what is there **helped**, that something is **missing**
there (a line nothing flagged but should have), or that it is **wrong** (noise, a false
alarm, a bad explanation), with an optional note. Each entry keeps what it was about (a
kind such as `fr:not-covered`, `agent:ghost:unclear`, `agent:finding:deleted-check`,
`code`), where, and the text as it was shown, so it reads after the worktrees are gone.

One log for every feature, on this machine only (`feedback.file`). `fr feedback
[--since 2w] [--json]` reads it back: counts by kind, then the wrong, missing and
helped entries with their notes. A kind marked wrong more than it helps is a candidate
to drop or tune; the missing ones say what to detect or ask the agent for next.

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

**Findings sit in the diff, under the line they are about**, and the line is marked in
the gutter (▌: cyan the agent, blue fr, magenta your comment). You read the change and
see there what is smelly about it, instead of matching a quoted line below to the diff:

- the agent's **findings** (`DELETED CHECK` under the removed check, with its note);
- **unchanged callers** that depend on a changed line, as one line naming the caller
  (`BREAKS A CALLER`, `CALLER TO CHECK`, `CALLER STILL FINE`); `⏎` shows its code;
- test **flags** that cite a line (a loosened assertion under the old line);
- fr's own test signals (`ASSERTION LOOSENED`, `EXPECTED VALUE CHANGED`, …).

What explains *why* stays above the code: a test's **intent** (the behaviour it
specifies, what it really asserts) comes before the test's code. A folded hunk, file or
group counts its findings. Text in the annotations is Markdown.

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
