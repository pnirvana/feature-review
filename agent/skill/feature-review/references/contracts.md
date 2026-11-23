# Contracts, callers and system impact

Goal: tell the reviewer whether anything outside the changed code is affected, and show
the evidence. "No external impact" is a valuable result when it is backed. Writes:
`ghosts` (unchanged callers), `contracts`, `rollout`.

## Callers that did not change (ghosts)

The diff cannot show them, so this is where you add the most. For every changed
signature, removed or renamed member, changed return value or exception, changed
behaviour of a public method, changed config key, message field or endpoint:

1. Search every worktree and the other checkouts the task names: a text search for the
   name, then open each hit. For Spring, also wiring by type and by configuration.
2. Each caller that did not change is a ghost, with `because` citing the changed line it
   depends on (it is shown there, in the diff): `broken` (it will fail or misbehave: say
   how), `unclear` (you could not tell: say what is missing), `ok` (it still works, and
   why; only when a reviewer would worry).
3. `found_by`: how you searched, and where.
4. Code that a change depends on but that exists in **no** checkout (a client of another
   service, a transport, a framework callback you cannot see) is not a ghost, since there
   is nothing to cite: it is a finding of kind `not-traced` at the line that depends on
   it, naming what is missing and where you looked.

## Contracts

1. Find the contract surface the change touches:
   - REST: controllers, request and response types, paths, status codes, validation
     annotations, OpenAPI files;
   - messaging: event and command types, topics, queues, headers, serialisation;
   - persistence: entities, migrations, queries against shared data;
   - configuration: property keys, environment variables, Helm or deployment values,
     feature flags;
   - shared libraries: version changes, changes to published API;
   - outbound calls: clients of other services (paths, payloads, timeouts).
2. None touched: `contracts: []`, and your final message says what you checked.
3. Each contract change is a `contracts` entry (`kind`: `event` | `http` | `grpc` |
   `schema` | `db` | `config` | `helm-values`, or `unknown` when the transport is in no
   checkout: never guess one). Classify it in a field's `note` or the
   entry: **additive**, **breaking** or **behavioural** (same shape, different meaning),
   and what makes it so: a required field, a removed value, a changed default, a renamed
   property.
4. **Consumers**: search the other checkouts for the event type, topic, path or property
   key; each match is a consumer (`changed`, `status`), and its ref's `note` says it was
   found by text search. Name the repositories you could **not** search: never claim "no
   consumers" from a search of a subset, claim "no consumers found in <list>".
5. **Tolerance** on the consumer side, where it decides compatibility: unknown-property
   handling, enum deserialisation, required fields. It decides `compatible`
   (`yes` | `no` | `unclear`: can old and new run side by side?).

## Rollout

When more than one service changed, or a contract or configuration did: the `order` to
deploy in and why; what happens while only some services run the new code (`partial`,
each with its `effect` and `risk`); whether a migration is reversible; configuration that
behaves differently per instance or environment (`config`). Otherwise `rollout: null`.
