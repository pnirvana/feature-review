# Language, and tests as requirements

This team works domain-driven. Names carry the domain language, and tests should read as
requirements. There is no glossary: the existing domain code of this service is the
reference. Writes: `names`, `tests`, and findings for names that lie about behaviour.

## Names

1. Collect the new and renamed names in added lines of domain, application and API code:
   types, methods, fields, parameters, constants, config keys, events, endpoints, test
   names. Local variables only where they carry a domain concept.
2. For each, check:
   - **A second name for an existing concept**: search the domain packages for a type or
     term with the same meaning or shape; cite it in `codebase`. Flag
     `differs-from-codebase`.
   - **Technical filler in domain code**: Manager, Helper, Util, Data, Info, Processor,
     Handler without a domain meaning; `flag`, `temp`, `data`, `check`, `process`,
     `list`. Flag `technical`.
   - **Sibling conventions**: how neighbouring methods, classes and tests are named. Cite
     a sibling when the new name breaks the pattern (`differs-from-codebase`).
   - **Inconsistent verbs** for the same action (create, place, submit, register), and
     the same concept named differently in two services (`inconsistent-across-services`).
   - **Name versus behaviour**: the code does more than, or other than, the name says (a
     `validate` that mutates, a `publish` that also retries and suppresses failures, a
     getter with side effects). That is a finding (`kind: "name-vs-behaviour"`) at the
     declaration, since it misleads every reader of the call sites.
   - **Terms from another bounded context** leaking in.
3. Word it as an inconsistency with evidence. You cannot know which of two competing
   names is right; say that there are two, and where.
4. The names that pass: one `names` entry each with `flag: "ok"` and no note, for new
   types, public methods and config keys only. The reviewer sees the check was complete.

## Tests

1. Every new or changed test is a `tests` entry, with its name as written.
2. Does the name state a requirement (a subject, a condition, an expected outcome)?
   `testValidate2` and "should work" do not. Say so in `behaviour`.
3. Does the body match the name? Read the assertions; write what they really check in
   `asserts`. Where they part, a flag: `name-vs-assertion`, `loosened`,
   `expected-changed-with-code` (did the requirement change, or was the test made to
   pass?), `removed`, `disabled`, `timeout-raised`, `mocks-unit-under-test`,
   `catch-all`, `snapshot-regenerated`. Cite the changed test lines in the flag's
   `refs`, so it shows in the diff under them.
4. Structure: a visible arrange / act / assert (given / when / then) split, one
   behaviour per test, the action not hidden inside the assertion. Say where not.
5. Read the test names of a test class top to bottom as a specification. Which
   behaviour changes (your behaviour findings) have no sentence in it? Each is a finding
   (`kind: "untested"`) at the changed line.

fr detects many weakened assertions by pattern and shows them already; your part is the
meaning. Keep it short: at most about eight findings and flags that need attention. If
there are more, report the most serious individually and the rest by pattern, once.
