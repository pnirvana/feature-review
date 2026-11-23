# Understanding first

Goal: the reviewer understands how the change works before reading a line of it, and
reads the code to check that it does what they now expect. This is where you save them
the most time on a large change, and where you are least constrained: choose whatever
explains best. Writes: `overview` (the change as a whole), and figures in a group's `why`
or a type's `responsibility` (that group or type).

## Ask the question, then pick the form

For the change as a whole, and again for each group: **what must the reviewer understand
to read this quickly?** Answer that question; don't fill a template. Common answers, as
examples, not a menu:

| the reviewer needs to see | a form that shows it |
|---|---|
| who calls whom, in what order, and what changed in that path | an interaction (sequence) |
| the types, what each is responsible for, how they are associated | a structure: boxes with responsibilities, associations with their kind (has, uses, creates, implements) and multiplicity |
| where a value comes from, how it is transformed, where it ends up | a data flow, hop by hop, across services |
| the states something can be in and the transitions the change adds or removes | a state machine, or a transition table |
| which inputs lead to which outcome | a decision table |
| what happens over time: retries, timeouts, a partial rollout | a timeline |
| what differs between old and new | a before/after table |
| which service owns which data, and who reads it | an ownership map |
| none of these, the code is clear | nothing: no figure is better than a decorative one |

Combine them when one does not say it all (a structure, then the one interaction that
changed). Prose between figures says what to notice.

## How to draw

- Draw as text in a fenced block marked `diagram`, with Unicode box drawing
  (`─ │ ┌ ┐ └ ┘ ├ ┤ ► ◄ ▼ ▲`). fr shows it exactly as written. Tables are Markdown
  tables.
- At most about 150 columns wide and 40 lines high. Larger means two figures, or less in
  one.
- **Show the change, not only the code**: mark new elements `+`, removed ones `−`,
  changed ones `~`, in a margin column or beside the label, and say so in a legend line.
  A removed step stays in the picture, marked: what is gone matters.
- Mark what you could not trace (`?`, a dotted `┄` edge) instead of drawing it as fact.
- Every box, arrow and label names code that exists: a type, a method, a field, a config
  key, a service. Cite it in the prose under the figure, or rely on the citations in the
  same group's parts and the design entries. Never invent an element to make a picture
  tidy.
- Before you write the figure into the file, look at it once in a monospace view
  (`fr --print --plain …` after writing): columns that do not line up mislead.

## Where it goes

- `overview`: the change as a whole. On a multi-service change, almost always a figure of
  how the services and the touched types work together, and what is new in that.
- A group's `why`: the figure for that slice, after the two or three sentences of why.
- A `design` entry's `responsibility`: the type's own structure, when its associations or
  members are the point.

Your figures are claims like any other: the verification pass checks them against the
code.
