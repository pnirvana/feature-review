# The annotation file (draft, step 2)

Written by the agent on the target machine; read by `fr`. This file defines the format
and the guarantees the tool gives. What to investigate, and how deep, is in the reference
agent: `agent/skill/feature-review/` (SKILL.md and its references).

Status (2026-11-21): **settled** (the answers are at the end). Built: `fr hunks`,
`fr check [--stamp]`, groups in the viewer (the groups lens), ghosts and test notes in
place (under their hunk, in both lenses; a folded hunk, file or group counts them; notes
on no hunk go to "Other notes"), and the overview (`m`): design, names, contracts and
rollout, one tab each, every citation a jump to its code. Step 2 is complete.

## Principles

- **The code stays the centre.** Annotations attach to hunks and lines; nothing is shown
  in place of code, and every hunk stays on screen whatever the agent says.
- **Point at the line.** What is smelly about a changed line is said under that line, in
  the diff (a finding), with a mark in the gutter: the reader looks at the change and is
  made aware of everything about it there, instead of matching a quote in a note to the
  diff. A finding, a test flag or a ghost that cites changed lines is shown that way;
  prose that explains *why* (intent, a group's why, a test's behaviour) stays above.
- **Every claim cites code; the tool extracts it.** No pasted code. A citation that does
  not resolve is an error, not a warning.
- **Prose is Markdown.** Every free-text field (`intent`, `why`, `note`, `behaviour`,
  `asserts`, `responsibility`, `opinion`, `effect`, …) is rendered as Markdown: inline
  code, emphasis, lists, quotes, tables. Code is not pasted: a fenced block longer than
  3 lines makes `fr check` warn, since pasted code can differ from the real code
  unnoticed; cite it instead. A figure the agent draws is fenced as ` ```diagram `:
  shown as written (plain text, any notation), never a warning.
- **Facts, signals and opinions are labelled apart** (discovery §7): a field is either
  something the tool can check, a signal with its evidence, or an `opinion`.
- **The agent checks its own file**: `fr check` resolves every citation and reports what
  is wrong (like `agent-review validate`); the agent fixes and runs it again.

## Where

`<dir>/.feature-review/annotations.json`, next to the review state. The viewer reloads
it when it changes.

## Citing code

A **ref** points at lines of a file:

```json
{"repo": "shop", "file": "src/main/java/shop/checkout/CheckoutController.java", "lines": "6-12"}
```

- `repo`: a worktree of the feature (its directory name), or for code outside the
  feature (consumers, precedent) `"path": "/abs/path/of/a/checkout"` instead, with an
  optional `"rev"` (default: its HEAD).
- `lines`: `"N"` or `"N-M"`, at most 60 lines.
- `side`: `"new"` (default: the working tree) or `"old"` (the base: removed code).
- `note`: optional, why this citation matters, and how it was found when by text search
  ("found by grep, may be incomplete").

A ref on the change is matched to the hunks it overlaps; the agent never computes hunk
keys. `fr hunks` lists the hunks with short ids (`shop:H3`) and line ranges, so the
agent can cite `{"hunk": "shop:H3"}` too; the tool resolves both forms to the stable
keys when the file is checked.

## The file

```json
{
  "version": 1,
  "intent": "What was asked for, e.g. the issue text, one paragraph.",
  "overview": "How the change works as a whole, for the reviewer to understand before reading code. Markdown; figures welcome.",
  "written": {"by": "review-agent", "at": "2026-11-21T16:00:00Z"},
  "groups": [],
  "findings": [],
  "design": [],
  "names": [],
  "tests": [],
  "ghosts": [],
  "contracts": [],
  "rollout": null
}
```

The agent writes `written.by` and `written.at`. `fr check --stamp` adds `written.heads`,
`written.changes` and `written.hunks` (never the agent): they let the viewer say "the annotations may be stale" when there are new
commits, when a repository's change differs (uncommitted edits too), or when a cited hunk
id now names a different hunk.

### overview: how it works, as a whole

Markdown, shown under the intent at the top of the review (before any code) and at the
top of the overview's design tab. What the reviewer must understand to read the change
quickly, in the form that fits: an interaction, a structure with its associations and
responsibilities, a data flow, a state machine, a decision table, a timeline, a
before/after table, or prose. Figures are drawn as text in ` ```diagram ` fences, changes
marked (`+` new, `−` removed, `~` changed), at most about 150 columns wide. Every element
of a figure names code that exists; cite the code in the text, or in the sections below.
The same goes for a group's `why` and a design entry's `responsibility`: a figure there
explains that group or type.

### groups: the feature slices, in reading order (§6, §10)

```json
{
  "id": "delivery-window",
  "title": "Orders carry a delivery window from checkout to the warehouse",
  "why": "Customers choose when the parcel arrives (intent, point 1).",
  "requested": "yes",
  "risk": "high",
  "risk_signals": ["public contract", "time zones"],
  "mechanical": null,
  "parts": [
    {"ref": {"repo": "shop", "file": "…/CheckoutRequest.java", "lines": "1-3"}, "role": "interface", "note": "the request gains the window"},
    {"ref": {"hunk": "shop:H2"}, "role": "implementation"},
    {"ref": {"repo": "warehouse", "file": "…/PickingPlanner.java", "lines": "4-8"}, "role": "implementation"},
    {"ref": {"repo": "warehouse", "file": "…/PickingPlannerSpec.groovy", "lines": "6-14"}, "role": "test"}
  ]
}
```

- Groups in the order to read them: the riskiest first. Parts in the order a request
  travels (across services), interface before implementation, each change next to its
  test.
- `requested`: `yes` | `no` | `unclear`, against `intent`.
- `risk`: `high` | `medium` | `low`. `risk_signals` from the list in §4; the tool adds
  its own (step 3) and never lowers the agent's.
- `mechanical`: a reason ("rename OrderDto to OrderResponse") when the agent claims the
  group changes no behaviour: shown collapsed, marked "claimed, not verified".
- `role`: `interface` | `implementation` | `test` | `config` | `migration` | `infra` |
  `docs`.
- **Coverage:** every hunk should be in exactly one group. The viewer shows hunks in no
  group under "Not grouped" (never hidden), and `fr check` lists them.

### findings: what is smelly about a changed line

```json
{"ref": {"repo": "shop", "file": "…/CheckoutController.java", "lines": "7-9", "side": "old"},
 "kind": "deleted-check", "severity": "high",
 "note": "The check that the address is in a delivery zone is gone; nothing else rejects an order the warehouse cannot ship."}
```

Shown under the last cited line, in the diff, with the cited lines marked in the gutter.
`also`: optional, more citations of changed lines where the same problem shows (a cause in
one service, its effect in another): each is marked too, with a pointer to the finding.
`kind`: a few words, shown as the badge (`deleted-check`, `money`, `transaction`,
`changed-exception-handling`, `concurrency`, …: the signals of discovery §4, at their
line). `severity`: `high` | `medium` | `low` (low is shown as information). Cite changed
lines (side `old` for removed ones); unchanged code that should have changed is a ghost.

### design: the design delta (§7)

```json
{
  "type": "PickingPlanner", "ref": {…}, "change": "changed", "layer": "domain",
  "responsibility": "Plans picking so a parcel leaves in time for its delivery window.",
  "dependencies_added": [{"to": "CarrierClient", "layer": "infrastructure", "ref": {…}}],
  "signals": [{"kind": "domain-depends-on-infrastructure", "refs": [{…}], "note": "…"}],
  "precedent": [{"ref": {"path": "/…/returns-service", "file": "…", "lines": "…"}, "note": "returns ask the carrier through a port"}],
  "opinion": "Optional, shown as the agent's opinion."
}
```

`change`: `new` | `changed` | `removed`. `layer` (of the type and of each dependency):
`domain` | `application` | `infrastructure` | `interface` | `test` | `config` | `other`.

Signal kinds: `single-implementation`, `pass-through`, `single-variant`,
`single-type-parameter`, `anemic-domain`, `rule-in-two-places`, `primitive-concept`,
`domain-depends-on-infrastructure`, `new-pattern`, `other`.

### names: the names list (§8)

```json
{"name": "slot", "kind": "field", "ref": {…}, "flag": "differs-from-codebase",
 "codebase": [{"name": "deliveryWindow", "ref": {…}}], "note": "the codebase calls this a delivery window"}
```

`kind`: `type` | `method` | `field` | `test` | `config-key` | `event` | `endpoint`.
`flag`: `ok` | `technical` | `differs-from-codebase` | `inconsistent-across-services`.
Terms come from the code (§13: the code is the single source of truth).

### tests: tests as a specification (§9)

```json
{"ref": {…}, "name": "plans picking before the window opens", "behaviour": "An order is picked early enough to reach its window.",
 "group": "delivery-window", "asserts": "That a plan exists, not when it starts.",
 "flags": [{"kind": "name-vs-assertion", "note": "named 'before the window' but checks only that a plan exists"},
           {"kind": "loosened", "refs": [{"repo": "warehouse", "file": "…Spec.groovy", "lines": "11", "side": "old"}]}]}
```

A flag that cites changed lines (`refs`) is shown in the diff under them; the others stay
with the test's intent, which is shown above the test's code.

Flag kinds: `name-vs-assertion`, `loosened`, `expected-changed-with-code`, `removed`,
`disabled`, `timeout-raised`, `mocks-unit-under-test`, `catch-all`, `snapshot-regenerated`.

### ghosts: what should have changed and did not (§5)

```json
{"ref": {"path": "/…/invoicing", "file": "…/ShipmentListener.java", "lines": "30-41"},
 "because": [{"repo": "warehouse", "file": "…/PickingPlanner.java", "lines": "4"}],
 "why": "Calls plan(order): the signature now needs a window.",
 "status": "broken", "found_by": "grep 'plan(' in all repositories"}
```

`status`: `ok` | `broken` | `unclear`. Shown in the diff under the changed line it
depends on (`because`), as one line naming the caller; ⏎ shows the caller's code. A
ghost whose `because` cites no changed line is shown under "Other notes".

### contracts: producer and consumers side by side (§6)

```json
{"name": "OrderPlaced event", "kind": "event",
 "producer": {"ref": {…}},
 "consumers": [{"ref": {…}, "changed": true, "status": "ok"}, {"ref": {…}, "changed": false, "status": "unclear", "note": "reads the address only"}],
 "fields": [{"name": "deliveryWindow", "producer": "object, required", "consumer": "absent", "note": "old consumers ignore it"}],
 "compatible": "yes"}
```

`kind`: `event` | `http` | `grpc` | `schema` | `db` | `config` | `helm-values` |
`unknown` (the transport is in no checkout: say so rather than guess).
`compatible`: `yes` | `no` | `unclear` (backward compatible while old and new run side
by side).

### rollout (§6)

```json
{"order": ["warehouse", "shop"],
 "why": "The shop sends the window; the warehouse must accept it first.",
 "partial": [{"deployed": ["shop"], "not": ["warehouse"], "effect": "orders are rejected: unknown field", "risk": "high"}],
 "config": [{"ref": {…}, "note": "cutoff 14:00 → 16:00, read in the server's time zone"}]}
```

## Questions settled (2026-11-21: all four as proposed)

1. **Hunk ids or ranges only?** Allowing `{"hunk": "shop:H3"}` (from `fr hunks`) is
   easier for an agent to get right than line ranges, and is what review-agents does;
   ranges are still needed for unchanged code (ghosts, precedent). Proposal: both.
2. **Staleness.** When the code changes after the annotations were written, line ranges
   drift. Proposal for now: `written.heads` plus a banner; relocating citations by their
   text, as comments do, later if it turns out to matter.
3. **What to build first.** Proposal: `fr hunks`, `fr check`, and groups in the viewer
   (they change the reading order, the core of the step). Then ghosts and tests in place,
   then design, names, contracts and rollout as views of their own.
4. **One file or one per concern?** One file is simpler to check; several agents in
   parallel (as in review-agents) would each want their own. Proposal: one file, merged
   by the agent definition; the tool could accept `annotations/*.json` later.
