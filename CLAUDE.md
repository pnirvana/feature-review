# Feature review

A tool that helps a human review a large, agent-written change faster, without missing
what matters. A change is one feature across several microservices, laid out as a parent
directory with one git worktree per service (a single repository: the same layout, one
worktree). The changes are at the centre, as in a diff view; an agent's annotations
(groups, risk, design, naming, test intent, consumers, rollout) are attached to them.

**Read `docs/discovery.md` first.** It holds the problem, the decisions, the rejected
approaches and the open questions (§13a; §13 records what is decided). The first
version (§12) is built step by step; step 1, the viewer (`fr`, see README.md), is done.
Step 2, the annotation file, is specified in `docs/annotations.md`; groups, `fr hunks`
and `fr check` are built, the rest of its views are next (see the status there).

`npm test` runs the tests; `node test/fixture.mjs <dir>` builds a sample feature.

## Context

- The user reviews Java/Spring/DDD services built with Maven, but the stack is
  polyglot: Groovy/Spock tests, Python, Ansible, Helm, Kubernetes and more. Agents run
  with Pi on a devpod, inside herdr. The agent definitions are written on the target
  machine: this project defines the method and the annotation format, not the agent.
- **Two machines:** this one (private) is for development; the tool is used on a
  corporate machine where installing tools may not be allowed. Depend only on git and
  Node; every other tool is optional, and a missing one costs a signal, never a failure.
- The tool will be judged by daily use on real changes, so every step must be usable on
  its own and cheap to change.
- **ATF** (`~/Dev/agent-task-framework`) is the user's task board for multi-agent work.
  It is related but **not this project's core**: don't modify it from here. Its
  `src/md/` (terminal rendering, diffview-style code views) and parts of
  `src/review.mjs` (patch parsing, stable hunk keys) can be copied or reused;
  `docs/discovery.md` §14 lists what is there. ATF may later be one source of a review.
- `~/Dev/review-agents` is the user's earlier review-agent tool: the reference for what
  an agent investigates and how it cites evidence.

## Working with the user

- Commit only when asked, on a branch, never on the default branch; never push.
- Ask before deleting anything.
- `cd` is zoxide in the user's shell: use `builtin cd` or absolute paths.
- Give an opinion and counter-arguments when you disagree; the user asks for them.
