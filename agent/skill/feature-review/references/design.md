# Design

Goal: the reviewer can judge class design and architecture without navigating the
surrounding, untouched code. You do that navigation and bring back the relevant lines.
Writes: `design` (one entry per new, removed or re-shaped type), and `findings` for the
design decisions.

1. **Structural delta**: new, removed and re-shaped types; changed public signatures;
   new dependencies between classes and between packages; new beans and configuration;
   changes to `pom.xml` and other build files. Each type is a `design` entry: `change`
   (`new` | `changed` | `removed`), `layer` (`domain` | `application` |
   `infrastructure` | `interface` | `test` | `config` | `other`), its `responsibility`
   in one sentence, `dependencies_added`.
2. **Neighbourhood**: for each new or re-shaped type, read its direct collaborators
   (callers, callees, implemented interfaces, injected dependencies). Cite what matters
   in the entry's refs and dependencies; collaborators that did not change but should
   have are ghosts (`contracts.md`).
3. **Precedent**: how this codebase already solves the same kind of problem (other
   listeners, validators, publishers, repositories, mappers). Cite one or two in
   `precedent`, and say in its note whether the change follows or departs from it.
4. **Duplication**: search for an existing class or helper that already does what the
   new code does. An agent re-implementing something that exists is a finding
   (`kind: "not-reused"`) at the new code, naming what exists.
5. **Placement**: is the logic in the layer where this codebase puts it? Judge against
   the existing packages and cite them. A departure is a `signals` entry
   (`domain-depends-on-infrastructure`, `anemic-domain`, `rule-in-two-places`,
   `primitive-concept`, `pass-through`, `single-implementation`, `single-variant`,
   `single-type-parameter`, `new-pattern`, `other`).
6. **Decisions**: each design choice the change makes is a finding
   (`kind: "design-decision"`, severity `medium`) at the line that makes it, naming the
   alternative not taken: "new class DeliveryWindow; the existing TimeSlot has the same
   shape and was not reused". The human decides; you make the decision visible. A change
   that simply follows precedent needs no finding: its `design` entry says so.

7. **The picture**: the structure of the touched types plus one hop (responsibilities,
   associations and their kind, what is new) usually explains more than the entries one
   by one. Draw it in `overview` or the group's `why` (`understanding.md`).

Your own judgement goes in the entry's `opinion`, short, apart from the facts.
