// Copied from agent-task-framework (branch review-documents, 99738d7), unchanged.
// Markdown documents for a terminal: the blocks of a document, with their section (heading
// path), their index in it and an anchor ("<section path>#<n>"). Fenced blocks whose
// language is in `kinds` get that language as their kind (the review document's changeset
// references). No ATF imports.

export const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
export const LIST = /^\s*([-*+]|\d+[.)])\s+/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
export const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** `key=value key2="a b"` → {key: value, key2: 'a b'}. */
export function parseAttrs(s) {
  const out = {};
  for (const m of String(s || '').matchAll(/([a-z][\w-]*)=("([^"]*)"|'([^']*)'|(\S+))/gi)) out[m[1]] = m[3] ?? m[4] ?? m[5];
  return out;
}

/**
 * The blocks of a Markdown document, in order: {kind, start, end (0-based lines, end
 * exclusive), lines, section (heading path), n (index in its section: 0 is the heading),
 * anchor ("<section path>#<n>"), and per kind: level/title (heading), lang/info/attrs/body
 * (code)}.
 * Kinds: heading, para, list, quote, table, hr, code, and the fence languages in `kinds`.
 */
export function parseDoc(md, { kinds = [] } = {}) {
  const L = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const stack = []; // [{level, title}]
  let n = 0;
  const section = () => stack.map((h) => h.title);
  const push = (b) => {
    b.section = section();
    b.n = b.kind === 'heading' ? 0 : ++n;
    b.anchor = anchorOf(b.section, b.n);
    blocks.push(b);
  };
  let i = 0;
  const blank = (s) => !s || !s.trim();
  const starts = (s) => FENCE.test(s) || HEADING.test(s) || HR.test(s);
  while (i < L.length) {
    const l = L[i];
    if (blank(l)) {
      i++;
      continue;
    }
    let m;
    if ((m = l.match(FENCE))) {
      const fence = m[1];
      const lang = m[2] || '';
      let j = i + 1;
      while (j < L.length && !new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(L[j])) j++;
      const body = L.slice(i + 1, j);
      const kind = kinds.includes(lang) ? lang : 'code';
      push({ kind, start: i, end: Math.min(j + 1, L.length), lines: L.slice(i, Math.min(j + 1, L.length)), lang, info: m[3] || '', attrs: parseAttrs(m[3]), body });
      i = j + 1;
      continue;
    }
    if ((m = l.match(HEADING))) {
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2] });
      n = 0;
      push({ kind: 'heading', start: i, end: i + 1, lines: [l], level, title: m[2] });
      i++;
      continue;
    }
    if (HR.test(l)) {
      push({ kind: 'hr', start: i, end: i + 1, lines: [l] });
      i++;
      continue;
    }
    let kind = 'para';
    if (/^\s*>/.test(l)) kind = 'quote';
    else if (LIST.test(l)) kind = 'list';
    else if (l.includes('|') && TABLE_SEP.test(L[i + 1] ?? '')) kind = 'table';
    let j = i + 1;
    while (j < L.length) {
      const s = L[j];
      if (kind === 'list') {
        // a list goes on over blank lines while the next line is indented or another item
        if (blank(s)) {
          const nx = L[j + 1];
          if (nx !== undefined && !blank(nx) && (LIST.test(nx) || /^\s{2,}/.test(nx))) {
            j++;
            continue;
          }
          break;
        }
        if (starts(s)) break;
      } else if (blank(s) || starts(s) || (kind === 'para' && (LIST.test(s) || /^\s*>/.test(s)))) break;
      else if (kind === 'quote' && !/^\s*>/.test(s)) break;
      else if (kind === 'table' && !s.includes('|')) break;
      j++;
    }
    push({ kind, start: i, end: j, lines: L.slice(i, j) });
    i = j;
  }
  return blocks;
}

export const anchorOf = (section, n, line) => `${section.join(' / ')}#${n}${line != null ? `:${line}` : ''}`;
