# Behaviour

Goal: the reviewer learns what the system now does differently, without parsing the
code. Writes: `findings` (at the changed lines), and the `requested` and `risk` of
`groups`.

1. For each hunk that is not mechanical, read the changed method **in full**, at the
   new side and at the base (`git -C <worktree> show <base>:<file>`), not only the hunk.
2. Walk up to what triggers it: a controller endpoint, a message listener, a scheduled
   job, a startup hook. Search for callers across all worktrees and the other
   checkouts; name the entry point in the finding. Callers found by text search: say so.
3. State each change as **"given X: before Y, now Z"**. One finding per observable
   change, not per file, at the line that makes the difference.
4. Compare with the intent. An unrequested behaviour change is the most important thing
   you can find: say "not requested" in the finding's note, and give its group
   `requested: "no"` (see "one hunk, two concerns" in `writing.md`).
5. Look specifically at changes to:
   - transactions, and what happens when a step fails half-way;
   - error handling: swallowed exceptions, narrower or wider catches, defaults returned
     instead of errors;
   - retries, timeouts, idempotency;
   - concurrency: check-then-act, shared state, ordering;
   - security configuration and authorisation checks, validation;
   - persistence and queries; caching;
   - null and empty handling, default values, feature flags;
   - state kept in memory that must be shared (per instance, lost on restart).
6. Find the test that demonstrates each change, and name it in the finding (by its
   name; its lines are cited in `tests`). None: say "no test" and raise the risk.
7. Do not build or run tests: builds write into the worktrees, and the reviewer's
   coverage report must stay the one their build produced. If the task says a build is
   allowed, say exactly what you ran and what you saw. Never imply you ran something
   you did not.
8. Changed or deleted tests: a weakened assertion, a removed test or a test switched off
   is a behaviour change, at least medium (`language.md` says how to describe the test).
9. Hunks that change no behaviour (renames, moves, formatting, imports) need no finding;
   the group's `mechanical` says why. **Check a rename is complete before calling it
   mechanical**: every reference renamed, and in Java a public class still matching its
   file name. fr verifies some renames itself, by content only; a hunk fr calls
   mechanical can still deserve a finding.

Where the order of steps or the failure path changed, show only the path that changed,
before and after: a short numbered list in the finding's note, or, when it spans
services or explains a whole group, a figure (`understanding.md`).
