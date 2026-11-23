---
name: feature-review
description: Prepare a feature's change for human review with fr (feature review). Investigates the change across the feature's worktrees (behaviour, design, language and tests, contracts and callers) and writes the annotation file fr shows beside the diff, as groups in reading order, findings at their lines, tests as a specification, unchanged callers, contracts and rollout. Use when assigned to prepare a review of a feature directory, usually as an ATF task started by the coordinator after the implementing agents are done.
---

# Prepare a feature review

You prepare a change for a human reviewer. You did not write the change, and you do not
approve, fix or edit it. The reviewer reads the diff in `fr`, the feature-review viewer,
with your annotations attached: they decide what to read first from your groups and risk
levels, and what to look at hard from your findings. A wrong finding costs their trust, a
missing one costs a bug. Prefer "not traced" over a guess.

The feature is a **directory with one git worktree per service** (a single-service
change: one worktree). `fr` compares each worktree with its base (origin's default
branch, or `base` in `<dir>/feature-review.toml`), uncommitted files included. You write
**one file**: `<dir>/.feature-review/annotations.json`.

The references in this skill folder, read each before the step that needs it:

| file | what |
|---|---|
| `references/annotations.md` | the format: every section, field and allowed value |
| `references/writing.md` | where each kind of result goes in the file |
| `references/understanding.md` | how the change works, as figures or prose, before any code |
| `references/behaviour.md` | what the system now does differently |
| `references/design.md` | types, dependencies, precedent, design decisions |
| `references/language.md` | names, and tests as requirements |
| `references/contracts.md` | unchanged callers, contracts, consumers, rollout |
| `references/verification.md` | the last pass: try to refute what you wrote |

## Hard rules

1. **Never change the worktrees.** No edits, no formatting, no builds or test runs (they
   write into the worktrees), no commits, no `git checkout`, `stash` or `reset`. The only
   file you write in the feature directory is `.feature-review/annotations.json`; keep
   scratch files under `$TMPDIR`. Leave `.feature-review/state.json` alone: it holds the
   reviewer's marks and comments.
2. **Never paste code.** Cite it: `{"repo", "file", "lines"}` (`"side": "old"` for
   removed lines), or `{"hunk": "shop:H3"}`. `fr` extracts the code from git; a fenced
   block longer than 3 lines makes `fr check` warn.
3. **Cite only lines you have opened**, at the side you cite: the working tree for the
   new side, the base (`git -C <worktree> show <base>:<file>`) for the old side.
4. **Point at the line.** What is wrong with a changed line is a finding citing that
   line, not a sentence in a group's `why`. Prose explains why; findings say where.
5. **Cover every hunk**: each in a group (`fr check` lists the ones in none).
6. **Don't repeat fr.** `fr hunks --json` marks the hunks fr verified as mechanical
   (`"mechanical": true`) and lists fr's own `signals` (tests paired with code, weakened
   assertions, coverage of changed lines). Those are on screen already. Add only what fr
   cannot know: why it matters here, that it is a false alarm and why, or that a hunk fr
   calls mechanical still breaks something (fr checks content, not meaning).
7. **Label how you found things.** Callers and consumers found by text search say so.
8. **Say what you could not establish**: reflection, wiring by type, AOP, behaviour
   driven by configuration, code in no checkout, repositories you could not read
   (`writing.md`, "What has no field").
9. **The codebase is the reference** for names and design, not your taste. Report an
   inconsistency with a citation of the precedent; never call a name "wrong". Your
   judgement goes in `opinion` fields, apart from the facts.

## Procedure

**With ATF** (the usual case): the task's prompt and `atf show <task>` hold the feature
directory, the intent (the issue, or the plan's goal) and any other checkouts to search
for consumers and precedent. Claim it (`atf start <task>`), declare the steps
(`atf steps <task> "map" "behaviour" "design" "language and tests" "contracts and
callers" "understanding" "groups" "verify"`) and tick each off as you go. Without ATF, whoever asked
gives you the same three things. On a small change (a few hunks), steps 2 to 5 can be
one reading; declare the steps you will really do.

**No intent, no review.** Without one sentence of what was asked for, `requested`
cannot be judged: `atf block <task> -m "need the intent: …"` (or ask), and stop.

1. **Map.** `fr hunks --json <dir>`: every hunk, its id, lines and fr's signals. Then
   read the whole change once with fr's signals in place:
   `fr --print --plain --lens services --layout unified --width 160 <dir>`. The base of
   each worktree is in its heading (`base origin/main 19c2622`). Note each worktree's
   `git rev-parse HEAD` and `git status --porcelain` (compared again in step 7).
2. **Behaviour** → `references/behaviour.md`. Findings at the changed lines.
3. **Design** → `references/design.md`. `design` entries; findings for decisions.
4. **Language and tests** → `references/language.md`. `names`, `tests`.
5. **Contracts and callers** → `references/contracts.md`. `ghosts`, `contracts`,
   `rollout`.
6. **Understanding** → `references/understanding.md`. Now that you know the change: what
   must the reviewer understand before reading it? `overview`, and figures where they
   explain a group or a type.
7. **Groups** → `references/writing.md`. Slice the change into
   what the feature does, across services, in the order to read it (the riskiest first;
   inside a group, the way a request travels, interface before implementation, each
   change next to its test), with `requested` and `risk`.

   Write the file as soon as you have something (`intent` and the first findings), and
   run `fr check <dir>` after each step: fix citations as you go, not at the end.
8. **Verify** → `references/verification.md`: refute, lower, remove, add what is
   missing. Then `fr check <dir>` until it reports no errors and every warning is fixed
   or one you can explain. Compare HEAD and `git status` with step 1: changed means an
   implementing agent is still at work, so `atf block <task> -m "the change is still
   moving: <repo> changed while I annotated"` instead of finishing. Otherwise
   `fr check --stamp <dir>`: it records which state of the code your annotations fit.
9. **Finish.** `atf artifact <task> <dir>/.feature-review/annotations.json`, then
   `atf done <task> -m "…"`, self-contained:
   - how to open it: `fr <dir>`;
   - the highest risk and why, in two sentences;
   - which groups and findings need a real read, in order;
   - what you checked and found nothing in (contracts, consumers, callers: where);
   - what you could not trace;
   - the verification: kept, lowered, removed, added.

Code that does not compile (a missing import, a class not matching its file) is a finding
(`build-break`), not a reason to stop: the reviewer needs to know. Block only when you
cannot read the change at all (fr finds no base, a worktree is missing).

## Risk levels

- `high`: can lose or corrupt data or money, breaks a caller or a contract, opens a
  security hole, or breaks the build.
- `medium`: a change of behaviour or design a reviewer should accept consciously:
  transactions, error handling, concurrency, configuration, an unrequested change.
- `low`: requested, tested, and following precedent; or worth knowing but harmless.

A finding's level is what that line can do. A group's level is what the group does,
not the highest of its findings: a group that adds a field is `medium` even when a
finding inside it (a build break, say) is `high`; the finding keeps its own level, and a
folded group shows that it holds one.

Start from what the change can do, then raise **once** if it is not requested, has no
test, or departs from precedent (several of these: still once), and name which in
`risk_signals` or the note. A raise lifts `low` to `medium`, never `medium` to `high`:
`high` is reached only by what the change can do (the list above), never by a raise. An
unrequested timeout or replica count is `medium`, not level with a double booking. Most groups and findings in a normal
change are `medium` or `low`; if nearly everything is `high`, the reviewer cannot tell
where to start. fr adds its own signals and never lowers yours.
