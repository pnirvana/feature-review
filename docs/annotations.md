# The annotation file (draft, step 2)

Written by the agent on the target machine; read by `fr`. This file defines the format
and the guarantees the tool gives; the agent definition (what to investigate, how) is
written there.

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
  unnoticed; cite it instead.
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
{"repo": "gateway", "file": "src/main/java/shop/gateway/RefundController.java", "lines": "6-12"}
```

- `repo`: a worktree of the feature (its directory name), or for code outside the
  feature (consumers, precedent) `"path": "/abs/path/of/a/checkout"` instead, with an
  optional `"rev"` (default: its HEAD).
- `lines`: `"N"` or `"N-M"`, at most 60 lines.
- `side`: `"new"` (default: the working tree) or `"old"` (the base: removed code).
- `note`: optional, why this citation matters, and how it was found when by text search
  ("found by grep, may be incomplete").

A ref on the change is matched to the hunks it overlaps; the agent never computes hunk
keys. `fr hunks` lists the hunks with short ids (`gateway:H3`) and line ranges, so the
agent can cite `{"hunk": "gateway:H3"}` too; the tool resolves both forms to the stable
keys when the file is checked.

## The file

```json
{
  "version": 1,
  "intent": "What was asked for, e.g. the issue text, one paragraph.",
  "written": {"by": "review-agent", "at": "2026-11-21T16:00:00Z", "heads": {"gateway": "4c4f363…", "refund-service": "a3ec0c4…"}},
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

`written.heads`, `written.changes` and `written.hunks` (filled in by `fr check --stamp`,
not the agent) let the viewer say "the annotations may be stale" when there are new
commits, when a repository's change differs (uncommitted edits too), or when a cited hunk
id now names a different hunk.

### groups: the feature slices, in reading order (§6, §10)

```json
{
  "id": "refund-key",
  "title": "Refunds carry an idempotency key from the gateway to the ledger",
  "why": "Retries of a refund must not book it twice (intent, point 2).",
  "requested": "yes",
  "risk": "high",
  "risk_signals": ["money", "public contract", "deleted check"],
  "mechanical": null,
  "parts": [
    {"ref": {"repo": "gateway", "file": "…/RefundRequest.java", "lines": "1-3"}, "role": "interface", "note": "the request gains the key"},
    {"ref": {"repo": "gateway", "file": "…/RefundController.java", "lines": "6-9"}, "role": "implementation"},
    {"ref": {"repo": "refund-service", "file": "…/RefundService.java", "lines": "4-8"}, "role": "implementation"},
    {"ref": {"repo": "refund-service", "file": "…/RefundServiceSpec.groovy", "lines": "6-14"}, "role": "test"}
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
{"ref": {"repo": "gateway", "file": "…/RefundController.java", "lines": "7-9", "side": "old"},
 "kind": "deleted-check", "severity": "high",
 "note": "The `amount <= 0` check is gone; nothing else rejects a negative refund."}
```

Shown under the last cited line, in the diff, with the cited lines marked in the gutter.
`kind`: a few words, shown as the badge (`deleted-check`, `money`, `transaction`,
`changed-exception-handling`, `concurrency`, …: the signals of discovery §4, at their
line). `severity`: `high` | `medium` | `low` (low is shown as information). Cite changed
lines (side `old` for removed ones); unchanged code that should have changed is a ghost.

### design: the design delta (§7)

```json
{
  "type": "RefundService", "ref": {…}, "change": "changed", "layer": "domain",
  "responsibility": "Books a refund once per idempotency key.",
  "dependencies_added": [{"to": "SeenKeys", "layer": "infrastructure", "ref": {…}}],
  "signals": [{"kind": "domain-depends-on-infrastructure", "refs": [{…}], "note": "…"}],
  "precedent": [{"ref": {"path": "/…/payment-service", "file": "…", "lines": "…"}, "note": "payments keep keys in an entity"}],
  "opinion": "Optional, shown as the agent's opinion."
}
```

Signal kinds: `single-implementation`, `pass-through`, `single-variant`,
`single-type-parameter`, `anemic-domain`, `rule-in-two-places`, `primitive-concept`,
`domain-depends-on-infrastructure`, `new-pattern`, `other`.

### names: the names list (§8)

```json
{"name": "seen", "kind": "field", "ref": {…}, "flag": "technical",
 "codebase": [{"name": "processedRefunds", "ref": {…}}], "note": "the codebase calls this processed refunds"}
```

`kind`: `type` | `method` | `field` | `test` | `config-key` | `event` | `endpoint`.
`flag`: `ok` | `technical` | `differs-from-codebase` | `inconsistent-across-services`.
Terms come from the code (§13: the code is the single source of truth).

### tests: tests as a specification (§9)

```json
{"ref": {…}, "name": "books a refund once per key", "behaviour": "A refund retried with the same key is booked once.",
 "group": "refund-key", "asserts": "That ledger.book is called any number of times with any arguments.",
 "flags": [{"kind": "name-vs-assertion", "note": "named 'once' but asserts _ * (any count)"},
           {"kind": "loosened", "refs": [{"repo": "refund-service", "file": "…Spec.groovy", "lines": "11", "side": "old"}]}]}
```

A flag that cites changed lines (`refs`) is shown in the diff under them; the others stay
with the test's intent, which is shown above the test's code.

Flag kinds: `name-vs-assertion`, `loosened`, `expected-changed-with-code`, `removed`,
`disabled`, `timeout-raised`, `mocks-unit-under-test`, `catch-all`, `snapshot-regenerated`.

### ghosts: what should have changed and did not (§5)

```json
{"ref": {"path": "/…/ledger", "file": "…/RefundListener.java", "lines": "30-41"},
 "because": [{"repo": "refund-service", "file": "…/RefundService.java", "lines": "4"}],
 "why": "Calls refund(orderId, amount): the signature now needs a key.",
 "status": "broken", "found_by": "grep 'refund(' in all repositories"}
```

`status`: `ok` | `broken` | `unclear`. Shown in the diff under the changed line it
depends on (`because`), as one line naming the caller; ⏎ shows the caller's code. A
ghost whose `because` cites no changed line is shown under "Other notes".

### contracts: producer and consumers side by side (§6)

```json
{"name": "RefundRequested event", "kind": "event",
 "producer": {"ref": {…}},
 "consumers": [{"ref": {…}, "changed": true, "status": "ok"}, {"ref": {…}, "changed": false, "status": "unclear", "note": "reads amount only"}],
 "fields": [{"name": "idempotencyKey", "producer": "String, required", "consumer": "absent", "note": "old consumers ignore it"}],
 "compatible": "yes"}
```

`kind`: `event` | `http` | `grpc` | `schema` | `db` | `config` | `helm-values`.
`compatible`: `yes` | `no` | `unclear` (backward compatible while old and new run side
by side).

### rollout (§6)

```json
{"order": ["refund-service", "gateway"],
 "why": "The gateway sends the key; refund-service must accept it first.",
 "partial": [{"deployed": ["gateway"], "not": ["refund-service"], "effect": "refunds fail: unknown field", "risk": "high"}],
 "config": [{"ref": {…}, "note": "replicaCount 2 → 3: the in-memory key set is per instance"}]}
```

## Questions settled (2026-11-21: all four as proposed)

1. **Hunk ids or ranges only?** Allowing `{"hunk": "gateway:H3"}` (from `fr hunks`) is
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
