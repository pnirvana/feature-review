# Answering the reviewer's questions

You answer the questions of a human who reads the change in `fr`, while they read it.
The review was prepared before (`.feature-review/annotations.json`); you did not write
the change, and you do not approve, fix or edit it. The hard rules in `../SKILL.md` hold
here too: never change the worktrees, cite code instead of pasting it, cite only lines
you have opened. An answer that refers to another part of the review links to it
(`[the race](#finding:race)`; the anchors are in `annotations.md`, "Linking to another
part of the review").

## The question

Each question comes as a prompt from fr:

- `Where:` the place the reviewer stood when asking: a repository, file and line (`+12`
  the new side, `-9` a removed line, at the base), its hunk and group, the line's text,
  or the note under the cursor. "This", "here" and "this line" mean that place. Asked on
  text (a group's description, a part's note, the intent), fr shows the answer under that
  paragraph, whatever it cites. In fr's
  overview, the place is a tab and the entry under the cursor (a design note, a name, a
  contract, a rollout step) with its text as the reviewer reads it: "this" means that
  entry. fr shows the answer under that entry; a `ref` is still welcome when the answer is
  about particular code. No place (asked from the Questions tab): the question is about
  the change as a whole.
- A question typed straight into your pane names no place: read
  `.feature-review/cursor.json` for where the reviewer's cursor is now.

Before the first answer, read `annotations.json` (the intent, the overview, the groups and
findings about the place) and `annotations.md` (beside this file) for the format. Then read the code the
question is about, at both sides where it changed (`git -C <worktree> show
<base>:<file>`; the base is in `fr hunks --json <dir>`), and as far up and down the call
path as the question needs.

## The answer, in your pane

- Direct and short: the answer first, then the evidence. Cite as `repo/file:line`.
- A picture when the question is about how things work together: a figure as text, under
  the rules in `understanding.md` (beside this file).
- What you could not establish: say so ("not traced: the client of the other service is
  in no checkout"). Never guess to fill a gap.
- When the answer shows that the prepared review is wrong or missed something, say so
  plainly, with the evidence. Change `findings` and the other sections only when the
  reviewer asks you to.

## Keeping it in the document

**A question sent from fr is always answered in the document too.** Its prompt carries an
id (`q-…`); until an entry with that id is in `explanations`, fr shows the question at
its line as waiting, so an answer only in your pane looks like no answer at all. Write
the answer in your pane and add it to the file, every time:

- `asked`: the id from the prompt;
- `question`: the reviewer's question, word for word;
- `answer`: Markdown, the same answer as in your pane, figures in ` ```diagram ` fences;
- `ref`: when the question is about a place, the lines the answer is about (the `Where:`
  line, or a range when it explains a block). It is shown under those lines in the diff.
  No `ref` for a question about the whole change.

A question typed straight into your pane has no id: add it to the file when the reviewer
asks ("add this", "write it down"), or when the answer is worth keeping on its own (a
figure, more than a few lines), without `asked`. Say in your pane what you added.

Write the file safely, since fr reloads it as soon as it changes: read it again just
before writing, append to `explanations` (create the list if missing), write the whole
file to a temporary file in `.feature-review/`, then rename it over `annotations.json`.
Run `fr check <dir>`: no new errors. Do not run `--stamp`, and leave `written` alone.
