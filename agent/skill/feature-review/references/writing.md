# Writing it into fr's file

The concern files say what to find. This one says where each piece goes in
`annotations.json`, so the reviewer sees it at the right place: a finding under its line,
the reason for a group above its code, the rest in the overview (`m`).

## A finding

```json
{"ref": {"repo": "order-service", "file": "src/main/java/shop/order/OrderEventPublisher.java", "lines": "68-74"},
 "kind": "error-handling", "severity": "high",
 "note": "**Publishing failures are swallowed after 3 attempts.** Given the broker is down when an order is created: before, the failed publish propagated and rolled back the order transaction; now it is caught and logged, so the order commits without its event. Not requested; no test covers the failure path; the other publishers rethrow.\n\nConsequence: an order can exist without an `OrderCreated` event."}
```

- `note` holds what review-agents splits into fields: a **bold one-line title** that
  states the change (not the topic), then the claim as before/after (1 to 4 sentences),
  whether it was requested, the test that shows it or "no test", then the consequence.
- `ref`: the changed lines that make the difference (`"side": "old"` for removed lines).
  A pure rename has no changed line inside the body: cite the declaration line. One
  finding cites one range; context, precedent and callers go in their own sections
  (`design`, `ghosts`), where they are cited and shown.
- `kind`: a few words, the badge: `concurrency`, `transaction`, `deleted-check`,
  `error-handling`, `money`, `security`, `untested`, `not-reused`, `design-decision`,
  `name-vs-behaviour`, `not-traced`, `build-break`, `not-requested`, `configuration`, …
  Use these spellings when they fit, so the same thing has the same badge everywhere.
- `severity`: the risk levels in SKILL.md.
- `also`: other changed lines where the same problem shows, as citations (a cause in one
  service, its effect in another: a field made optional, and the consumer that now reads
  it without a null check; a code change and the configuration line it relies on). Each is marked in the diff with a pointer to this finding. One finding, not
  two that mention each other.

## A group

- `why`: what the group achieves and which part of the intent asks for it, in two or
  three sentences. Not a walk through the code: the parts and the diff show that.
- A figure, after the sentences, when one explains the slice (`understanding.md`).
- `requested`, `risk` (what the group does, not its worst finding: SKILL.md),
  `risk_signals` (which raised the level: "not requested",
  "no test", "departs from precedent", and the topic: "money", "public contract", …).
- `parts`: every hunk of the group, in reading order, each with a `role`:
  `{"ref": {"hunk": "gateway:H3"}, "role": "interface"}` or
  `{"ref": {"repo": "…", "file": "…", "lines": "4-8"}, "role": "implementation", "note": "…"}`.
  Roles: `interface` | `implementation` | `test` | `config` | `migration` | `infra` |
  `docs`.
- `mechanical`: the reason, for a group that changes no behaviour.

**One hunk, two concerns** (a requested change and an unrequested one in the same
hunk): cite the hunk's line ranges, not the hunk id, and put each range in the group it
belongs to. A new-side range covers the removed lines inside it too; cite the old side
only for a hunk that removes lines and adds none. Every hunk must be covered, by one group or by ranges in several. `fr check`
then warns that the hunk is in several groups: expected here, and the viewer shows it in
each, marked "also in".

## What has no field

- **Checked, nothing found** (no contract touched, no callers, no consumers found in
  these repositories): say it in your final message, which the coordinator passes on.
  An empty section means only that nothing was found.
- **Figures**: drawn as text in ` ```diagram ` fences, in `overview`, a group's `why` or a
  design entry (`understanding.md`). In a finding's note, a short numbered path is
  usually clearer than a figure.
- **What you could not trace**: a `not-traced` finding at the dependent line, or a ghost
  with `status: "unclear"` when there is a caller to cite. Repeat the list in your final
  message.
