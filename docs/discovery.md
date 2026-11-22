# Feature review: what we found out so far

Notes from a design discussion held in the ATF project (`~/Dev/agent-task-framework`), on
2026-11-20 and 2026-11-21, before this project existed. They record the problem, the
decisions taken, the approaches rejected and why, and what is still open. Nothing is
built yet.

## 1. The problem

Agents now write most of the code. A feature is implemented **in one go across all the
microservices it touches**, not as many independent changes. Agent reviews run on it
first and their fixes are applied. The **human review comes last**, and it is the
bottleneck:

- there is a lot of code at once, spread over several repositories;
- reading it all, top to bottom, is slow and taxing;
- skimming it risks missing a fatal error.

The goal: make reviewing a large, agent-written change **faster and less taxing, without
raising the risk of missing what matters**. The tool supports the human reviewer. It
does not review the code itself, and it does not approve anything.

Before agents, each service's change was reviewed in isolation. That had its own risk:
the reviewer had to keep all the other changes in mind. Reviewing the whole feature lets
it be checked for consistency as a whole, but it means more code at once.

## 2. Setting

- **The layout:** a parent directory named after the feature, with one git worktree per
  affected service as a child. A change to a single repository uses the same layout,
  with one worktree. The tool has a single case: a parent directory with N worktrees.
- **The base:** per worktree, the merge base with the repository's default branch at
  `origin`. Rarely, a feature branch is the base instead, so there is an optional
  override (e.g. a small manifest in the parent directory).
- **Code access:** the agent can read **all** repositories of the system, not only the
  changed ones. This matters for consumers, callers and precedent (§5, §6).
- **The stack (target machine):** Java and Spring services, DDD, Maven, but polyglot:
  Groovy/Spock tests, Python, Ansible, Helm, Kubernetes and more (§13). Agents run with
  Pi on a devpod, inside herdr. The agent definitions are made on the target machine,
  so this project defines the format and the method, not the agent itself.

## 3. The core decision: code first, notes on top

**The changes are at the centre, as in a diff view.** Explanations, risk and design
notes are attached to the code they describe, and grouped with it.

Why:

- **The code is the ground truth.** A narrative-first review invites the reviewer to read
  the story and trust it. The agent shares the blind spots of the code it wrote or
  reviewed. Next to the code, a wrong explanation shows.
- **Nothing can be left out:** every hunk is on screen by construction.
- **It matches how review works:** the reviewer verifies code, not an essay about it.

Rejected: **a document-first briefing**, the review written as a Markdown document that
cites code. ATF built one (SPEC §16 there), and it showed the problems above: the reader
follows the narrative, and completeness has to be checked separately. Its parts are
reusable (§11).

## 4. Triage: glance over the safe parts, focus on the risky ones

The reviewer should be able to skim non-critical areas. But if the agent alone decides
what is critical, its misjudgement becomes the reviewer's blind spot. Fatal errors hide
in the "trivial refactor" and the "just config". So:

- **The risk comes mostly from facts that can be checked**; the agent's judgement only
  adds to it.
- **Verified mechanical changes** can be skipped safely: whitespace or formatting only,
  moved code (git's `--color-moved`), pure renames (an AST-level diff). A tool proves
  these.
- **Claimed mechanical changes** (only the agent says so) are shown collapsed, but
  marked "claimed, not verified".
- **These signals raise the risk, whatever the agent thinks:**
  - money, authorisation, persistence, transactions;
  - public contracts, serialization, migrations;
  - deleted conditions or checks, changed exception handling;
  - concurrency;
  - changed lines that no test covers;
  - a test changed in the same change as the code it tests.

## 5. Absence: what should have changed and did not

A diff cannot show missing code, yet many fatal errors are exactly that:

- a second caller that still assumes the old behaviour;
- a consumer in another service;
- a missing migration;
- a `switch` that lacks the new case.

**Ghost hunks:** the unchanged call sites and consumers of changed signatures,
behaviour and contracts, shown in place with a note on whether each is still correct.
They are searched in **all** repositories of the system. This is where an agent's
investigation adds the most.

## 6. Across services

The whole-feature review can show what isolated reviews could not:

- **Contract pairs:** a producer's change to an event, API or schema, shown next to its
  consumers' changes and the consumers that did not change. The tool compares the field
  added on one side with the one read on the other (types, optionality, defaults).
- **Consistency:** a domain concept carries the same name, validation and rules in every
  service. The names list (§8) works across services, so drift such as `refundId` in
  one service and `reversalId` in another stands out.
- **Groups by feature slice, not by repository:** a group like "idempotent refunds"
  spans gateway, refund-service and ledger, in call order, so the reviewer reads the
  flow as a request travels. The per-repository view stays as a second lens.
- **Compatibility and rollout.** This is a risk the one-go review hides: it invites
  assuming the feature ships as one, but each service merges and deploys on its own, so
  old and new versions run side by side for a while. Fatal errors live in that window:
  - a consumer deployed before its producer;
  - a required field the old version does not send;
  - a renamed event nobody listens to yet;
  - a migration that breaks the old code still running.

  So the tool needs a view of every contract change marked backward compatible or not,
  the deploy order it requires, and what happens when only some services are deployed.
- **Merging stays per repository:** review marks and comments keep their repository and
  hunk, so they can map back to each service's PR, and perhaps be posted there later.

## 7. Design

The reviewer must be able to assess design changes, especially in the domain. Agents
often get this wrong: responsibilities that are poorly abstracted, or abstractions that
are not needed. A diff shows lines; design shows in structure. So there is a **design
delta** above the hunks, in mostly factual terms:

- **Types and responsibilities:** each new or changed class or interface, with its
  one-sentence responsibility and its layer (domain, application, infrastructure). A
  responsibility that needs an "and" is a hint.
- **Dependencies:** the edges added between types and packages, and their direction. A
  domain type that now depends on infrastructure shows at a glance.
- **Signs of unnecessary abstraction:**
  - an interface with one implementation;
  - a pass-through layer that only delegates;
  - a factory or strategy with one variant;
  - a generic type parameter used with one type.
- **Signs of misplaced responsibility:**
  - logic that belongs on an entity or value object but sits in a service (an anemic
    domain);
  - one rule implemented in two places;
  - a domain concept kept as a bare primitive.
- **Precedent:** how the codebase already solves the same problem, cited. "This
  introduces a new pattern" is information the reviewer needs before judging whether it
  is justified.

Each design element links down to its hunks.

**Caution:** the agent is weakest at judging design honestly, because the same kind of
model produced the poor abstraction. So the design view shows **facts and signals**,
labels any agent opinion as an opinion, and leaves the judgement to the reviewer.

## 8. Naming

Names should reveal intent and match the domain's language, and that applies to tests
too. Names are spread over hunks, so they are hard to judge one hunk at a time.

A **names list** shows every new or renamed type, method, field and test side by side,
across all services. Next to each name:

- the domain term it should match, taken from a glossary, the design docs and the
  existing code;
- a flag when the name is technical rather than domain language
  (`RefundHandlerManager`), or differs from what the codebase already calls the same
  thing.

## 9. Tests

Changes to test code need special attention, so that tests weakened to make faulty code
look good are easy to spot.

- **Tests as a specification.** Show the added, changed and removed tests as sentences,
  grouped by behaviour. Someone who knows the domain should recognise the requirements
  in them. Each test's intent is explained.
- **Name against assertion.** A test named "rejects a refund over the order total" that
  only asserts that nothing was thrown is flagged.
- **Weakening signals, detected mechanically:**
  - an assertion removed or loosened (`assertEquals` becoming `assertNotNull`, an exact
    value becoming `any()`);
  - **an expected value changed in the same change as the production code** ("the test
    was made to match the code"): the reviewer decides which side is right;
  - a test deleted, `@Disabled` or skipped, or given a longer timeout;
  - a new mock of the unit under test, a catch-all exception, a regenerated snapshot.
- **Objective checks:**
  - **The new and changed tests are run against the base code.** A test for a behaviour
    change must fail there; if it passes on the old code, it does not test the change,
    whatever its name says.
  - **Mutation testing on the changed lines only** (PIT for Java can limit itself to
    changed code). Line coverage says the code ran; mutation testing says a test would
    notice if it were wrong.
- **A coverage view, of the changed lines only.** Overall coverage says nothing about the
  review. Each changed line gets a gutter mark: covered, not covered, or covered but its
  mutants survive. Coverage comes from the build's JaCoCo report, per service.

## 10. Lower cognitive load

- **The map first:** one row per feature group (services spanned, risk, size, verified
  mechanical, test status, ghost hunks) and one per service, so the reviewer sees the
  shape of the work before reading a line.
- **A reading order instead of file order:**
  - interface before implementation;
  - each code change next to the test that pins it down;
  - the riskiest group first, while attention is fresh.
- **A time budget by risk:** verified mechanical groups get a glance, risky ones a full
  read. Reviewed marks show what is left.
- **Upstream:** smaller, sliced changes would shrink every review. That can be steered
  when the work is planned, not when it is reviewed.

## 11. How the tool will be judged

By **using it on real changes in daily work**, not by a proof of concept. Picking
representative agent changes by hand is hard, and they would not cover every aspect. So
the first version must be usable day to day, cheap to change, and must collect its own
evidence: a **feedback key** that, while reviewing, records "helped", "missing" or
"wrong" at the current location, to read back after a few weeks.

## 12. The first version (proposed)

Built in this order, each step usable on its own:

1. **A diff-centred viewer over a parent directory.**
   - It discovers the worktrees, finds each base (§2), and shows the hunks of all of them.
   - It has groups, reviewed marks per hunk and per file, and comments anchored to a
     line, all keyed by repository and hunk.
   - Diffs look like diffview's: side by side, soft line backgrounds, the changed part of
     a line stronger.

   **Built (2026-11-21), on branch `viewer`:** `fr <dir>` (README.md). The change is the
   base against the working tree, so uncommitted and untracked files are included and
   marked. Groups are by service and file until step 2 brings feature groups. Not yet:
   live reload (`r` reloads), feedback key (step 4). Highlighting covers each hunk plus
   20 lines above it, since `bat` is slow on whole files.
2. **An annotation file written by the agent.** The format is defined here; the
   investigation is done by the agent definition on the target machine. It holds:
   - feature groups across services, each with its "why" and risk;
   - the design delta (§7);
   - the names list (§8);
   - test intents (§9);
   - ghost hunks (§5);
   - contract pairs, and the compatibility and rollout notes (§6).

   Every claim cites file and lines (the tool extracts the code from git; nothing is
   pasted).

   **Built (2026-11-21), specified in `docs/annotations.md`:** `fr hunks`, `fr check`,
   the groups lens, ghosts and test intents under their hunks, the overview (`m`) with
   design, names, contracts and rollout.
3. **Cheap objective signals:**
   - verified mechanical changes;
   - tests changed together with code;
   - assertion heuristics;
   - coverage of the changed lines from existing JaCoCo reports.

   **Built so far (2026-11-21), `src/signals.mjs`, README "What fr checks itself":**
   verified mechanical (whitespace only, moved anywhere in the change, renamed only),
   folded like reviewed hunks; tests paired with their code by name, with "its test not
   changed", "no test found" and "existing test changed with its code"; assertion
   heuristics (`src/asserts.mjs`: removed, loosened, expected value changed, disabled,
   catch-all, longer timeout, a new test that asserts nothing); JaCoCo coverage of the
   added lines (`src/coverage.mjs`: reports found or configured, merged, not trusted when
   older than the file). Step 3 is complete.

   **Decided while building (2026-11-21): findings sit in the diff.** The reader looks at
   a change and is made aware there of everything smelly about it. fr's line signals,
   the agent's `findings` (new section), test flags and unchanged callers that cite
   changed lines are shown under those lines, with a gutter mark (`src/inline.mjs`);
   prose that explains why stays above the code. Quoting a changed line in a note below
   the hunk made the reader match it to the diff: too much load.
   Pure identifier renames (an AST-level diff) are not verified yet.
4. **The feedback key** (§11). Built (2026-11-22): `!` records helped / missing /
   wrong at the cursor, with a note, in one append-only log for all features
   (`$XDG_STATE_HOME/feature-review/feedback.jsonl`, `src/feedback.mjs`); each entry
   keeps the kind of thing it was about, its location and the text shown. `fr
   feedback` counts them by kind and lists the notes. One log rather than one per
   feature: the point is to read across features, and a feature's directory goes away.

Later: running the changed tests against the base, mutation testing on the changed
lines, posting comments to the per-service PRs, and talking to the agent from inside the
viewer (comments answered in place).

## 13. Decisions on the former open questions (2026-11-21)

- **The stack is polyglot, not only Java.** Besides Java/Spring/Maven: Groovy with Spock
  for tests, Python, Ansible, Helm, Kubernetes manifests, and more. So:
  - the viewer and the annotation format are language-neutral;
  - detectors are pluggable per language or file kind, and a file kind without a
    detector simply gets no verified signal (never a false "safe");
  - the signals that work for any text come first: whitespace-only, moved code;
  - test heuristics (§9) need one variant per test framework: JUnit/AssertJ/Mockito,
    Spock (`then:`/`expect:` blocks, `thrown()`, `_` matchers, `@Ignore`), pytest;
  - infrastructure files (Helm values, manifests, Ansible) are part of the rollout view
    (§6): replicas, resources, probes, config keys and secrets read by the code.
- **Runtime:** Node.js (ESM), no dependencies, reusing ATF's rendering (§14). Heavier,
  language-specific detectors may be external tools the viewer calls, emitting JSON.
- **Two machines.** It is developed on a private machine. It is used on a corporate
  machine (the devpod), where installing tools may not be allowed. So the tool must
  run with only what is already there (git, Node, the build's own toolchain), and any
  external tool is optional: a missing one means a missing signal, never a failure.
- **Annotation format:** JSON. Claims reference code as `{repo, path, lines}` ranges on
  the head (or the base, for removed code); the tool maps ranges to hunks. Ghost hunks
  use the same form on unchanged lines. Agents never compute hunk keys.
- **Who runs the agent:** a separate command writes the annotation file; the viewer reads
  it and reloads when it changes. The agent in a herdr pane answering comments is later.
- **Front end:** a terminal UI first. Neovim may come later over the same data.
- **Glossary:** the code is the single source of truth. The names list (§8) compares
  names against what the existing code already calls the same thing. Whether a
  maintained glossary is worth it is undecided; if so, it is a separate project.
- **Review state:** a hidden directory in the parent directory, keyed by repository and
  stable hunk key.

## 13a. Still open

- How groups, ghost hunks and contract pairs reference code in detail (the schema).
- What is available on the corporate machine. Known (2026-11-21): Node 26.4.0, `bat`,
  an internal npm registry, micromamba, and a Python package registry, but not every
  package is mirrored. The code moves to work through the user's personal git
  repository. Unknown: a JDK on the review machine, a Maven mirror. (The private machine
  has Node 25: don't use anything newer than Node 25 offers.)
- Optional packages are therefore possible, but each must be checked as available at
  work before relying on it. The core (viewer, annotations, review state) stays
  dependency-free.
- Structural (AST-level) diffs across the languages above. difftastic or tree-sitter
  tools may not be installable at work (see "Two machines"). Candidates to check against
  the work registries: `web-tree-sitter` with WASM grammars (npm, no native build),
  difftastic or tree-sitter via micromamba, tree-sitter wheels via the Python registry.
  Fallbacks: parsers the build already has (a JDK, Python's `ast`), plain-text heuristics.
  Internet downloads are blocked at work, so parsers must come from the internal
  registries, never from a download at install or run time (as `:TSInstall` or node-gyp
  would do). Neovim at work already uses tree-sitter, so two routes are likely:
  - **headless Neovim as the parser** (`nvim --headless -l script.lua`, using
    `vim.treesitter`), with whatever parsers are installed there: nothing new to
    install, but only the languages Neovim already has;
  - **`web-tree-sitter` with WASM grammars from the npm registry**: needs the grammar
    packages to ship `.wasm` files (to check per language; Groovy is the doubtful one).

## 14. Prior work to reuse or learn from

- **ATF** (`~/Dev/agent-task-framework`, branch `review-documents`): a task board for
  multi-agent work. It is not this project's core, but the review tool may later take a
  plan's task as one source of a review, and runs alongside it in herdr. Reusable:
  - `src/md/`: terminal rendering with no ATF imports.
    - `term.mjs`: display widths, styled segments, wrapping, ANSI.
    - `highlight.mjs`: syntax highlighting via `bat`, or a built-in fallback.
    - `render.mjs`: Markdown rendering and `codeView`, diffview-style diffs (split or
      unified, soft backgrounds, the changed part of a line stronger).
  - `src/review.mjs`:
    - `parsePatch`;
    - `hunkKey`, a stable hunk key: sha256 of the repository, the file and the
      removed/added lines, so a reviewed mark survives a rebase and resets when the hunk
      changes.
  - `src/review-viewer.mjs`: a full-screen viewer with comments anchored to lines,
    threads, per-hunk marks, folding, search and live reload. Good reference, not
    necessarily the code to keep.
  - `docs/review-design.md` and `SPEC.md` §16: the document-first design that was
    rejected (§3), and the reasoning behind it.
- **`~/Dev/review-agents`:** the user's earlier tool for assisted review of agent-written
  branches. Its method is the reference for what the agent investigates:
  - concerns (behaviour, contracts, design, language, tests);
  - evidence-backed findings (kind, risk, requested, claim, consequence, evidence as line
    citations);
  - every hunk covered, `mechanical` and `untraced` findings;
  - a verifier.

  It has Pi agent definitions and the `agent-review` command (Python). It renders only a
  `report.md`; it has no viewer.
- **`~/Dev/ai-review`:** an earlier, simpler attempt: a finding list in quickfix format,
  opened in Neovim, and a fix agent. Not the intent here.
