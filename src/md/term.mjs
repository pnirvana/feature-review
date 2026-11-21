// Copied from agent-task-framework (branch review-documents, 99738d7), unchanged.
// Terminal text: display widths, styled segments, wrapping, ANSI in and out.
//
// A line is a list of segments [text, style, offset?]. A style is a space-separated list of
// names (STYLE) or raw SGR codes ("38;5;180", "48;2;30;60;35"); the optional offset is where
// the text came from (the renderer uses it to map a row back to its source line).
// No ATF imports: this directory is the generic part of the review viewer.

export const ESC = '\x1b[';
export const STYLE = {
  reset: 0, bold: 1, dim: 2, italic: 3, underline: 4, inverse: 7, strike: 9,
  selected: '44;97', match: '22;30;43', matchcur: '22;30;46',
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90,
  // diff tints, soft like diffview's DiffAdd / DiffDelete, the changed part (DiffText) stronger
  cursorbg: '48;2;45;46;62', addbgcur: '48;2;50;80;60', delbgcur: '48;2;90;48;58',
  addbg: '48;2;35;52;40', delbg: '48;2;58;34;40', addword: '48;2;48;84;56', delword: '48;2;100;44;54',
  addfg: '38;5;114', delfg: '38;5;174', filler: '38;5;238',
  code: '38;5;180', link: '4;38;5;111',
};
const code = (n) => (STYLE[n] !== undefined ? STYLE[n] : /^[\d;]+$/.test(n) ? n : null);
/** The escape sequence for a style ('' for none). */
export const sty = (names) =>
  names
    ? String(names)
        .split(' ')
        .map(code)
        .filter((c) => c !== null)
        .map((c) => `${ESC}${c}m`)
        .join('')
    : '';

// Display width of a character: wide ones (emoji, CJK) take two columns, combining marks
// and variation selectors none. A line wider than the pane wraps and breaks the layout.
const WIDE = [[0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd]];
export function charWidth(ch) {
  const c = ch.codePointAt(0);
  if (c < 0x300) return c < 32 ? 0 : 1;
  if ((c >= 0x300 && c <= 0x36f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x20d0 && c <= 0x20ff) || (c >= 0xfe00 && c <= 0xfe0f)) return 0;
  for (const [a, b] of WIDE) if (c >= a && c <= b) return 2;
  return 1;
}
/** Display width of a string (columns). */
export const strWidth = (s) => [...String(s)].reduce((n, ch) => n + charWidth(ch), 0);
/** Display width of a line of segments. */
export const segsWidth = (segs) => segs.reduce((n, [t]) => n + strWidth(t), 0);
/** Tabs to spaces (a tab has no width of its own in a terminal cell count). */
export const untab = (s, n = 4) => String(s).replace(/\t/g, ' '.repeat(n));

/** A line of segments, truncated to `width` columns, as ANSI (fill: pad with spaces). */
export function fit(segs, width, fill = false) {
  let out = '';
  let used = 0;
  for (const [text, style] of segs) {
    if (used >= width) break;
    let take = '';
    for (const ch of String(text)) {
      const w = charWidth(ch);
      if (used + w > width) {
        used = width; // a wide character that does not fit: leave the column empty
        break;
      }
      take += ch;
      used += w;
    }
    out += style ? sty(style) + take + `${ESC}0m` : take;
  }
  if (fill && used < width) out += ' '.repeat(width - used);
  return out;
}

/** Does a style give a background? */
export const hasBg = (names) =>
  String(names ?? '')
    .split(' ')
    .map(code)
    .some((c) => c !== null && /(^|;)(48;|4[0-7](;|$)|10[0-7](;|$))/.test(c));

/** A line of segments as plain text. */
export const plain = (segs) => segs.map(([t]) => t).join('');

/** Add a style to every segment (e.g. a tint over highlighted code). */
export const restyle = (segs, extra) => segs.map(([t, s, o]) => [t, [s, extra].filter(Boolean).join(' '), o]);

/** Pad a line of segments to `width` columns with a styled filler. */
export function pad(segs, width, style = '') {
  const w = segsWidth(segs);
  return w < width ? [...segs, [' '.repeat(width - w), style]] : segs;
}

/**
 * Cut a line of segments into rows of at most `width` columns, character-wise (code: no
 * word wrap, nothing is lost).
 */
export function hardWrap(segs, width) {
  width = Math.max(1, width);
  const rows = [[]];
  let used = 0;
  for (const [text, style, off] of segs) {
    let cur = '';
    let k = 0;
    let start = off;
    for (const ch of String(text)) {
      const w = charWidth(ch);
      if (used + w > width && used > 0) {
        if (cur) rows[rows.length - 1].push([cur, style, start]);
        rows.push([]);
        used = 0;
        cur = '';
        start = off == null ? off : off + k;
      }
      cur += ch;
      used += w;
      k += ch.length;
    }
    if (cur) rows[rows.length - 1].push([cur, style, start]);
  }
  return rows;
}

/**
 * Word-wrap a line of segments to `width` columns. Spaces at a break are dropped; a word
 * longer than the line is cut. → rows of segments (offsets kept).
 */
export function wrapSegs(segs, width) {
  width = Math.max(4, width);
  // words: runs of non-space characters, each a list of segment pieces
  const words = []; // {pieces: [[t, s, o]], w, space: bool}
  for (const [text, style, off] of segs) {
    let k = 0;
    for (const part of String(text).split(/(\s+)/)) {
      if (!part) continue;
      const o = off == null ? off : off + k;
      k += part.length;
      if (/^\s+$/.test(part)) words.push({ space: true, pieces: [[' ', style, o]], w: 1 });
      else {
        const last = words[words.length - 1];
        if (last && !last.space) {
          last.pieces.push([part, style, o]);
          last.w += strWidth(part);
        } else words.push({ space: false, pieces: [[part, style, o]], w: strWidth(part) });
      }
    }
  }
  const rows = [];
  let row = [];
  let used = 0;
  let pendingSpace = null;
  const flush = () => {
    rows.push(row);
    row = [];
    used = 0;
    pendingSpace = null;
  };
  for (const wd of words) {
    if (wd.space) {
      if (used > 0) pendingSpace = wd;
      continue;
    }
    const sp = pendingSpace ? 1 : 0;
    if (used > 0 && used + sp + wd.w > width) flush();
    if (pendingSpace && used > 0) {
      row.push(...pendingSpace.pieces);
      used += 1;
    }
    pendingSpace = null;
    if (wd.w > width) {
      // a path or a URL longer than the line: cut it
      const parts = hardWrap(wd.pieces, width - used);
      row.push(...parts[0]);
      for (const p of parts.slice(1)) {
        flush();
        const more = hardWrap(p, width);
        row.push(...more[0]);
        for (const m of more.slice(1)) flush(), row.push(...m);
      }
      used = segsWidth(row);
      continue;
    }
    row.push(...wd.pieces);
    used += wd.w;
  }
  if (row.length || !rows.length) rows.push(row);
  return rows;
}

/**
 * ANSI text (one line, e.g. from bat) → segments with raw SGR styles. Resets clear the
 * style; other codes accumulate.
 */
export function parseAnsi(line) {
  const segs = [];
  let style = [];
  let last = 0;
  const re = /\x1b\[([\d;]*)m/g;
  let m;
  const push = (t) => t && segs.push([t, style.join(' ')]);
  while ((m = re.exec(line))) {
    push(line.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] === '' ? '0' : m[1];
    if (codes === '0') style = [];
    else if (codes.startsWith('0;')) style = [codes.slice(2)];
    else style.push(codes);
  }
  push(line.slice(last));
  // other escapes (OSC etc.) are dropped
  return segs.map(([t, s]) => [t.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[\d;?]*[A-Za-z]/g, ''), s]).filter(([t]) => t);
}
