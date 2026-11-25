// Links between the parts of a review: an annotation's text points at another part (a
// finding, a group, a design entry, a name, a contract, a hunk) with a Markdown link to an
// anchor fr knows, `[the check-then-act finding](#finding:check-then-act)`. fr shows the
// link as its text; p peeks at that part, ⏎ there goes to it (discovery §13). A hunk id as
// fr numbers them (`gateway:H3`) is a link as it stands.
//
// fr check resolves every link (one that points nowhere is an error) and warns where the
// text refers to another part in words only ("see the … finding"): the agent adds the link.

/** The kinds of anchor, and where each one's key is in the annotation file. */
export const SECTION_KINDS = {
  finding: { list: 'findings', key: 'id', what: 'finding' },
  group: { list: 'groups', key: 'id', what: 'group' },
  design: { list: 'design', key: 'type', what: 'design entry' },
  name: { list: 'names', key: 'name', what: 'name' },
  contract: { list: 'contracts', key: 'name', what: 'contract' },
  hunk: { list: null, key: null, what: 'hunk' },
};

const LINK = /\[([^\]]+)\]\(#([a-z]+):([^)\s]+)\)/g;
const HUNK = /(?<![\w/.:-])([A-Za-z0-9][\w.-]*):H(\d+)(?![\w-])/g;

/** The links in a text (Markdown): [{kind, key, text, index}]; kinds fr does not know too (check says so). */
export function linksIn(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(LINK)) out.push({ kind: m[2], key: decodeURIComponent(m[3]), text: m[1], index: m.index });
  return out;
}

/** The hunk ids in a text (`gateway:H3`) of the worktrees named: [{kind: 'hunk', key, text, index}]. */
export function hunkIdsIn(text, repos) {
  const out = [];
  for (const m of String(text ?? '').matchAll(HUNK)) if (repos.has(m[1])) out.push({ kind: 'hunk', key: `${m[1]}:H${m[2]}`, text: `${m[1]}:H${m[2]}`, index: m.index });
  return out;
}

/**
 * What a link points at in the annotation file. → {ok: true, kind, key, i (its index in
 * its list), item, label} | {ok: false, error}. ids: unitIds(ws) (for hunks).
 */
export function resolveSection(ann, { kind, key }, ids = []) {
  const k = SECTION_KINDS[kind];
  if (!k) return { ok: false, error: `#${kind}:${key}: fr knows no anchor "${kind}" (${Object.keys(SECTION_KINDS).join(', ')})` };
  if (kind === 'hunk') {
    const u = ids.find((x) => x.id === key);
    return u ? { ok: true, kind, key, i: null, item: u, label: `hunk ${key}` } : { ok: false, error: `#hunk:${key}: no hunk ${key} in the change` };
  }
  const list = Array.isArray(ann?.[k.list]) ? ann[k.list] : [];
  const i = list.findIndex((x) => x && String(x[k.key] ?? '') === key);
  if (i < 0) return { ok: false, error: `#${kind}:${key}: no ${k.what} with ${k.key} "${key}"${kind === 'finding' ? ' (a finding needs an id to be linked to)' : ''}` };
  const x = list[i];
  const label = kind === 'finding' ? `finding ${key}${x.kind ? `: ${x.kind}` : ''}` : kind === 'group' ? `group ${x.title ?? key}` : `${k.what} ${key}`;
  return { ok: true, kind, key, i, item: x, label };
}

// words that refer to another part of the review, without a link
const REFERS = /\b(?:see|cf\.|as (?:noted|described|discussed|explained|flagged)|described|covered|discussed)\b[^.;:\n()[\]]{0,70}?\b(?:finding|group|topic|section|entry|design note|contract|tab|above|below)\b/gi;

/** Where a text refers to another part of the review in words only: [the words]. */
export function unlinkedRefs(text) {
  const s = String(text ?? '');
  // a sentence with a link in it is linked
  return [...s.matchAll(REFERS)].filter((m) => {
    const from = s.lastIndexOf('.', m.index) + 1;
    const to = s.indexOf('.', m.index + m[0].length);
    const sentence = s.slice(from, to < 0 ? s.length : to);
    // (a hunk id is a link as it stands)
    return !/\]\(#/.test(sentence) && !/[\w.-]:H\d+\b/.test(sentence);
  }).map((m) => m[0]);
}
