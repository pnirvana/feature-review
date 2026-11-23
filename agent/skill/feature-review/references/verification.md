# Verification

Last, with a deliberate change of stance: you now try to refute what you wrote. Assume
nothing in the file is true until you have seen it in the code again.

For every finding, test flag, ghost, contract and figure:

1. Open each cited range again and read the code around it yourself, at the side it
   cites (the base for `"side": "old"`).
2. Ask: does the code really do what the note says? Is the before/after right at the
   base and the new side? Is the cited precedent comparable? Is a "mechanical" group
   really behaviour-preserving (renames complete, the file name still matching the public
   class)? Is the severity defensible, neither inflated nor played down?
   For a figure: does every element exist, is every arrow a real call or association,
   is what is marked new, removed or changed really so, and do the columns line up
   (`fr --print --plain`)?
3. For "no test", "not reused" and "no caller" claims, search for the counter-example.
4. Then act on what you saw:
   - it holds: keep it;
   - it is false, or the cited lines do not show it: remove it;
   - it is overstated: lower it, and correct the note;
   - it cannot be decided from the code: keep it only if the reviewer needs to know,
     reworded as what is unknown (`not-traced`, or `unclear`).
5. Look for what is missing: read the diff once more, hunk by hunk, for a risky change no
   finding mentions. Add it, then verify it like the others.
6. Check the levels against each other: groups ordered by risk, and most groups and
   findings `medium` or `low`. If nearly everything is `high`, the reviewer cannot tell
   where to start: keep `high` for what can lose money or data, break a caller or a
   contract, or open a security hole.

Your final message reports the verification: how many items you kept, lowered and
removed, and what you added in step 5.

Running as two agents (a verifier that sees only the file and the code) is stronger:
the writer's reasoning cannot carry over. A single agent gets part of the way by doing
this pass last, as a separate step, without rereading its own notes on why.
