// Copied from agent-task-framework (branch review-documents, 99738d7), codeView takes segsFor.
// Markdown for a terminal, like glow: no markup left. Headings as bars, wrapped
// paragraphs and lists, tables with box-drawing borders, quotes with a bar, code blocks and
// code views (line numbers, +/- lines with tinted backgrounds, syntax highlighting).
//
// Every function returns rows: {segs (src/md/term.mjs segments), src?, line?, ...}. `src`
// is the 1-based line within the block's source a row came from (where a comment on it
// points); code views put the code line there instead (`line`: {side, n} for a diff, the
// file's line number for code). No ATF imports.
import { LIST, TABLE_SEP } from './parse.mjs';
import { highlight } from './highlight.mjs';
import { hardWrap, pad, segsWidth, strWidth, untab, wrapSegs } from './term.mjs';

// ---------- inline ----------

function shortUrl(u) {
  const m = String(u).match(/^[a-z]+:\/\/(?:www\.)?([^/?#]+)([^?#]*)/i);
  if (!m) return u.length > 40 ? '…' + u.slice(-39) : u;
  const p = m[2].replace(/\/$/, '');
  const s = m[1] + p;
  return s.length > 40 ? m[1] + '/…' + p.slice(-Math.max(8, 38 - m[1].length)) : s;
}

const join = (a, b) => [a, b].filter(Boolean).join(' ');

/** Inline Markdown → segments with offsets: code spans, emphasis, strike, links, images. */
export function inline(text, base = '', off = 0) {
  const s = String(text);
  const out = [];
  let buf = '';
  let bufAt = 0;
  const flush = () => {
    if (buf) out.push([buf, base, off + bufAt]);
    buf = '';
  };
  const lit = (ch, at) => {
    if (!buf) bufAt = at;
    buf += ch;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const rest = s.slice(i);
    let m;
    if (c === '\\' && /[!-/:-@[-`{-~]/.test(s[i + 1] ?? '')) {
      lit(s[i + 1], i);
      i += 2;
      continue;
    }
    if (c === '`') {
      const ticks = rest.match(/^`+/)[0];
      const end = s.indexOf(ticks, i + ticks.length);
      if (end > 0) {
        flush();
        let body = s.slice(i + ticks.length, end);
        if (/^ .* $/.test(body)) body = body.slice(1, -1);
        out.push([body, join(base, 'code'), off + i]);
        i = end + ticks.length;
        continue;
      }
    }
    if ((m = rest.match(/^!\[([^\]]*)\]\(([^)\s]*)[^)]*\)/))) {
      flush();
      out.push([`[image: ${m[1] || m[2]}]`, join(base, 'dim'), off + i]);
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/))) {
      flush();
      out.push(...inline(m[1], join(base, 'link'), off + i + 1));
      const url = m[2];
      if (url && url !== m[1] && !url.startsWith('#')) out.push([` (${shortUrl(url)})`, join(base, 'dim'), off + i]);
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^<([a-z]+:\/\/[^>\s]+)>/i))) {
      flush();
      out.push([shortUrl(m[1]), join(base, 'link'), off + i]);
      i += m[0].length;
      continue;
    }
    // emphasis: ** __ ~~ (strong, strike), * _ (italic); _ only at word boundaries
    const pair = rest.startsWith('**') ? '**' : rest.startsWith('__') ? '__' : rest.startsWith('~~') ? '~~' : c === '*' || c === '_' ? c : null;
    if (pair && !/\s/.test(s[i + pair.length] ?? ' ') && !(c === '_' && /\w/.test(s[i - 1] ?? ''))) {
      let j = i + pair.length;
      let end = -1;
      while ((j = s.indexOf(pair, j)) > 0) {
        if (!/\s/.test(s[j - 1]) && !(c === '_' && /\w/.test(s[j + pair.length] ?? '')) && (pair.length === 2 || s[j + 1] !== c)) {
          end = j;
          break;
        }
        j += pair.length;
      }
      if (end > 0) {
        flush();
        const st = pair === '~~' ? 'strike' : pair.length === 2 ? 'bold' : 'italic';
        out.push(...inline(s.slice(i + pair.length, end), join(base, st), off + i + pair.length));
        i = end + pair.length;
        continue;
      }
    }
    lit(c, i);
    i++;
  }
  flush();
  return out;
}

// ---------- flowing text ----------

/**
 * Wrap source lines ({text, src}) as one paragraph (hard breaks: a line ending in two
 * spaces or a backslash). → rows {segs, src} with `first`/`rest` prefixes (segments).
 */
export function flow(lines, width, { first = [], rest = first, base = '' } = {}) {
  const groups = [[]];
  for (const l of lines) {
    groups[groups.length - 1].push(l);
    if (/( {2,}|\\)$/.test(l.text)) groups.push([]);
  }
  const rows = [];
  for (const g of groups.filter((x) => x.length)) {
    let text = '';
    const starts = [];
    for (const l of g) {
      if (text) text += ' ';
      starts.push([text.length, l.src]);
      text += l.text.trim().replace(/\\$/, '');
    }
    const segs = inline(text, base);
    const w = width - segsWidth(rows.length ? rest : first);
    for (const r of wrapSegs(segs, Math.max(8, w))) {
      const o = Math.min(...r.filter((x) => x[2] != null).map((x) => x[2]), Infinity);
      let src = g[0].src;
      for (const [at, sl] of starts) if (at <= o) src = sl;
      rows.push({ segs: [...(rows.length ? rest : first), ...r], src });
    }
  }
  return rows;
}

// ---------- blocks ----------

const BULLETS = ['•', '◦', '▪'];

function listRows(block, width) {
  // items: a marker line starts one; other lines continue the current item
  const items = [];
  const indents = [];
  block.lines.forEach((l, k) => {
    const m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/);
    if (m && LIST.test(l)) {
      const ind = untab(m[1]).length;
      while (indents.length && indents[indents.length - 1] > ind) indents.pop();
      if (!indents.length || indents[indents.length - 1] < ind) indents.push(ind);
      items.push({ depth: indents.length - 1, marker: m[2], task: m[3] ? /x/i.test(m[3]) : null, lines: [{ text: m[4], src: k + 1 }] });
    } else if (items.length && l.trim()) items[items.length - 1].lines.push({ text: l.trim(), src: k + 1 });
  });
  const rows = [];
  for (const it of items) {
    const sym = it.task !== null ? (it.task ? '☑' : '☐') : /\d/.test(it.marker) ? it.marker.replace(')', '.') : BULLETS[it.depth % BULLETS.length];
    const lead = '  '.repeat(it.depth) + ' ';
    const first = [[lead, ''], [sym, it.task ? 'green' : 'cyan'], [' ', '']];
    const rest = [[' '.repeat(strWidth(lead + sym + ' ')), '']];
    rows.push(...flow(it.lines, width, { first, rest, base: it.task ? 'dim' : '' }));
  }
  return rows;
}

function quoteRows(block, width) {
  const rows = [];
  let para = [];
  const bar = [['│ ', 'gray']];
  const done = () => {
    if (para.length) rows.push(...flow(para, width, { first: bar, base: 'italic' }));
    para = [];
  };
  block.lines.forEach((l, k) => {
    const t = l.replace(/^\s*>\s?/, '');
    if (!t.trim()) {
      done();
      if (rows.length) rows.push({ segs: [['│', 'gray']], src: k + 1 });
    } else para.push({ text: t.replace(/^\s*>\s?/, ''), src: k + 1 });
  });
  done();
  return rows;
}

const cellsOf = (l) => {
  let s = l.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
};

function tableRows(block, width) {
  const src = block.lines.map((l, k) => ({ l, src: k + 1 })).filter((x, k) => !(k === 1 && TABLE_SEP.test(x.l)));
  const align = cellsOf(block.lines[1] ?? '').map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : 'left'));
  const data = src.map((x) => ({ cells: cellsOf(x.l).map((c, i) => inline(c, x.src === 1 ? 'bold' : '')), src: x.src }));
  const ncol = Math.max(...data.map((r) => r.cells.length));
  const want = Array.from({ length: ncol }, (_, i) => Math.max(1, ...data.map((r) => segsWidth(r.cells[i] ?? []))));
  const room = width - (ncol * 3 + 1);
  const w = [...want];
  // too wide: shrink the widest column, one step at a time
  while (w.reduce((a, b) => a + b, 0) > room && Math.max(...w) > 4) w[w.indexOf(Math.max(...w))]--;
  const line = (l, m, r) => ({ segs: [[l + w.map((x) => '─'.repeat(x + 2)).join(m) + r, 'gray']] });
  const rows = [line('┌', '┬', '┐')];
  data.forEach((r, k) => {
    const wrapped = w.map((cw, i) => wrapSegs(r.cells[i] ?? [], cw));
    const h = Math.max(...wrapped.map((x) => x.length));
    for (let y = 0; y < h; y++) {
      const segs = [['│', 'gray']];
      wrapped.forEach((cell, i) => {
        const c = cell[y] ?? [];
        const free = w[i] - segsWidth(c);
        const a = align[i] ?? 'left';
        const left = a === 'right' ? free : a === 'center' ? Math.floor(free / 2) : 0;
        segs.push([' ' + ' '.repeat(left), ''], ...c, [' '.repeat(free - left) + ' ', ''], ['│', 'gray']);
      });
      rows.push({ segs, src: r.src });
    }
    if (k === 0 && data.length > 1) rows.push(line('├', '┼', '┤'));
  });
  rows.push(line('└', '┴', '┘'));
  return rows;
}

const PLAIN_LANGS = new Set(['', 'text', 'txt', 'plain', 'ascii', 'diagram', 'art', 'output', 'console-output']);

function codeRows(block, width, mode) {
  const lang = block.lang || '';
  const lines = block.body.map((l) => untab(l));
  const hl = PLAIN_LANGS.has(lang.toLowerCase()) ? lines.map((l) => [[l, '']]) : highlight(lines, lang, mode);
  const rows = [];
  if (lang && !PLAIN_LANGS.has(lang.toLowerCase())) rows.push({ segs: [['  ' + lang, 'dim italic']], src: 1 });
  hl.forEach((segs, k) => {
    hardWrap(segs, width - 2).forEach((r, y) => rows.push({ segs: [[y ? '┆ ' : '│ ', 'gray'], ...r], src: k + 2 }));
  });
  return rows;
}

/** The changed middle of two lines (vim's DiffText, as diffview shows it): [[from, to] in a, [from, to] in b]. */
export function changedMiddle(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return [[p, a.length - q], [p, b.length - q]];
}

/** Add a style to the characters [from, to) of a line of segments. */
export function styleRange(segs, from, to, extra) {
  if (from >= to) return segs;
  const out = [];
  let pos = 0;
  for (const [t, s, o] of segs) {
    const end = pos + t.length;
    const cuts = [pos, Math.max(pos, Math.min(end, from)), Math.max(pos, Math.min(end, to)), end];
    for (let i = 0; i < 3; i++) {
      const piece = t.slice(cuts[i] - pos, cuts[i + 1] - pos);
      if (piece) out.push([piece, i === 1 ? [s, extra].filter(Boolean).join(' ') : s, o == null ? o : o + cuts[i] - pos]);
    }
    pos = end;
  }
  return out;
}

/** Diff lines in runs: {ctx: line} or {del: [lines], add: [lines]} (a change: removals, then additions). */
function runs(lines) {
  const out = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (l.t === ' ') out.push({ ctx: l });
    else if (last && !last.ctx && (l.t === '+' || !last.add.length)) last[l.t === '-' ? 'del' : 'add'].push(l);
    else out.push({ del: l.t === '-' ? [l] : [], add: l.t === '+' ? [l] : [] });
  }
  return out;
}

/**
 * Render a code view: groups of lines ({t: '+'|'-'|' ', s, old?, new?, n?, changed?}) with
 * a title row each. `name` (a file name) picks the highlighting. A diff (lines with old/new)
 * is drawn like diffview: soft line backgrounds, the changed part of a changed line
 * stronger, and (layout 'split', or 'auto' when there is room) old and new side by side
 * with ╱ where a side has no line. `signs` adds +/- (for plain text, where colour is gone).
 * Plain code shows its line number and a bar on changed lines. → rows with `line` ({side,
 * n} for a diff: the new side where a row has one, n for code), `at` ({old, new}: the
 * line numbers a diff row shows), `group` and `title`.
 */
export function codeView({ groups, name = '', width = 100, highlight: mode = 'auto', tint = true, layout = 'unified', signs = false, segsFor = null }) {
  const isDiff = groups.some((g) => g.lines.some((l) => l.old !== undefined || l.new !== undefined) && !g.lines.some((l) => l.n !== undefined));
  const nums = groups.flatMap((g) => g.lines.flatMap((l) => [l.old, l.new, l.n])).filter((x) => x != null);
  const nw = Math.max(3, String(Math.max(0, ...nums)).length);
  const split = isDiff && (layout === 'split' || (layout === 'auto' && width >= 110));
  const rows = [];
  groups.forEach((g, gi) => {
    if (g.title) rows.push({ segs: g.title, group: gi, title: true });
    // highlight each side as one text, so multi-line strings and comments come out right
    const segsOf = new Map();
    if (segsFor) {
      // the caller highlighted the whole files (feature-review: one bat call per side)
      for (const l of g.lines) {
        const s = segsFor(l);
        if (s) segsOf.set(l, s);
      }
    } else if (isDiff) {
      for (const side of ['new', 'old']) {
        const idx = g.lines.map((l, k) => [l, k]).filter(([l]) => (side === 'new' ? l.t !== '-' : l.t !== '+'));
        const hl = highlight(idx.map(([l]) => l.s), name, mode);
        idx.forEach(([l, k], j) => !segsOf.has(l) && (side === 'new' || l.t === '-') && segsOf.set(l, hl[j]));
      }
    } else highlight(g.lines.map((l) => l.s), name, mode).forEach((h, k) => segsOf.set(g.lines[k], h));
    const body = (l) => segsOf.get(l) ?? [[untab(l.s), '']];
    const meta = (l) => ({ group: gi, ...(l?.hunk ? { hunk: l.hunk } : {}) });

    if (!isDiff) {
      for (const l of g.lines) {
        const bg = tint && l.changed ? 'addbg' : '';
        const gutter = [[`${l.n ?? ''}`.padStart(nw) + ' ', 'gray'], [l.changed ? '▎' : ' ', 'yellow'], [' ', '']];
        const gw = segsWidth(gutter);
        hardWrap(body(l).map(([t, st]) => [t, [st, bg].filter(Boolean).join(' ')]), Math.max(8, width - gw)).forEach((r, y) => {
          const g2 = y ? [[' '.repeat(gw - 2), ''], ['┆ ', 'gray']] : gutter;
          rows.push({ segs: bg ? pad([...g2, ...r], width, bg) : [...g2, ...r], line: l.n, ...meta(l) });
        });
      }
      return;
    }

    // a diff: each line's text, tinted, its changed part stronger where it pairs with a line of the other side
    const styled = new Map();
    for (const run of runs(g.lines)) {
      if (run.ctx) {
        styled.set(run.ctx, body(run.ctx));
        continue;
      }
      run.del.forEach((l, k) => {
        let segs = body(l).map(([t, st]) => [t, [st, tint ? 'delbg' : ''].filter(Boolean).join(' ')]);
        const other = run.add[k];
        if (tint && other) {
          const [[a, b]] = changedMiddle(untab(l.s), untab(other.s));
          segs = styleRange(segs, a, b, 'delword');
        }
        styled.set(l, segs);
      });
      run.add.forEach((l, k) => {
        let segs = body(l).map(([t, st]) => [t, [st, tint ? 'addbg' : ''].filter(Boolean).join(' ')]);
        const other = run.del[k];
        if (tint && other) {
          const [, [a, b]] = changedMiddle(untab(other.s), untab(l.s));
          segs = styleRange(segs, a, b, 'addword');
        }
        styled.set(l, segs);
      });
    }
    const bgOf = (l) => (!tint || !l || l.t === ' ' ? '' : l.t === '+' ? 'addbg' : 'delbg');
    const lineOf = (l) => (l.t === '-' ? { side: 'old', n: l.old } : { side: 'new', n: l.new });

    if (!split) {
      for (const l of g.lines) {
        const bg = bgOf(l);
        const gutter = [[`${l.old ?? ''}`.padStart(nw) + ' ' + `${l.new ?? ''}`.padStart(nw) + ' ', 'gray'], ...(signs ? [[l.t === ' ' ? '  ' : l.t + ' ', l.t === '+' ? 'addfg bold' : l.t === '-' ? 'delfg bold' : '']] : [[' ', bg]])];
        const gw = segsWidth(gutter);
        hardWrap(styled.get(l), Math.max(8, width - gw)).forEach((r, y) => {
          const g2 = y ? [[' '.repeat(gw - 2), ''], ['┆', 'gray'], [' ', bg]] : gutter;
          rows.push({ segs: bg ? pad([...g2, ...r], width, bg) : [...g2, ...r], line: lineOf(l), at: { old: l.old ?? null, new: l.new ?? null }, ...meta(l) });
        });
      }
      return;
    }

    // side by side: old | new, a change's removals beside its additions, ╱ where a side has none
    const half = Math.floor((width - 1) / 2);
    const codeW = Math.max(4, half - nw - 2);
    const side = (l, n) => {
      if (!l) return [[['╱'.repeat(half), 'filler']]];
      const bg = bgOf(l);
      return hardWrap(styled.get(l), codeW).map((r, y) => pad([[y ? ' '.repeat(nw - 1) + '┆' : String(n).padStart(nw), 'gray'], [' ', bg], ...r], half, bg));
    };
    const pairs = [];
    for (const run of runs(g.lines)) {
      if (run.ctx) pairs.push([run.ctx, run.ctx]);
      else for (let k = 0; k < Math.max(run.del.length, run.add.length); k++) pairs.push([run.del[k] ?? null, run.add[k] ?? null]);
    }
    for (const [o, n] of pairs) {
      const L = side(o, o?.old);
      const R = side(n, n?.new);
      const h = Math.max(L.length, R.length);
      const anchor = n ?? o;
      for (let y = 0; y < h; y++) {
        const left = L[y] ?? (o ? [[' '.repeat(half), bgOf(o)]] : [['╱'.repeat(half), 'filler']]);
        const right = R[y] ?? (n ? [[' '.repeat(half), bgOf(n)]] : [['╱'.repeat(half), 'filler']]);
        rows.push({ segs: [...left, ['│', 'gray'], ...right], line: lineOf(anchor), at: { old: o?.old ?? null, new: n?.new ?? null }, ...(o && n && o !== n ? { old: o.old } : {}), ...meta(anchor) });
      }
    }
  });
  return rows;
}

/**
 * Render one block. opts: width, highlight (auto|bat|builtin|none), note (segments after a
 * heading), embed(block) → rows for blocks the caller draws itself (e.g. references).
 */
export function renderBlock(block, { width = 100, highlight: mode = 'auto', note = null, embed = null } = {}) {
  if (embed) {
    const r = embed(block);
    if (r) return r;
  }
  switch (block.kind) {
    case 'heading': {
      const t = inline(block.title, 'bold');
      const extra = note ? [['  ', ''], ...note] : [];
      if (block.level === 1) return [{ segs: pad([[' ', 'inverse bold'], ...t.map(([x, s]) => [x, s + ' inverse']), [' ', 'inverse'], ...extra.map(([x, s]) => [x, (s || '') + ' inverse'])], width, 'inverse'), src: 1 }];
      if (block.level === 2) {
        const head = [['━━ ', 'cyan bold'], ...t.map(([x, s]) => [x, s + ' cyan']), [' ', '']];
        const used = segsWidth([...head, ...extra]);
        return [{ segs: [...head, ...extra, ...(extra.length ? [[' ', '']] : []), ['━'.repeat(Math.max(0, width - used - (extra.length ? 1 : 0))), 'cyan']], src: 1 }];
      }
      if (block.level === 3) return [{ segs: [['── ', 'cyan'], ...t, ...extra], src: 1 }];
      return [{ segs: [...t.map(([x, s]) => [x, s + ' italic']), ...extra], src: 1 }];
    }
    case 'para':
      return flow(block.lines.map((text, k) => ({ text, src: k + 1 })), width);
    case 'list':
      return listRows(block, width);
    case 'quote':
      return quoteRows(block, width);
    case 'table':
      return tableRows(block, width);
    case 'hr':
      return [{ segs: [['─'.repeat(width), 'gray']], src: 1 }];
    default:
      // code, and fenced blocks of a kind the caller did not draw
      return codeRows({ ...block, lang: block.kind === 'code' ? block.lang : '' }, width, mode);
  }
}

/** Render a whole document (blocks from parseDoc) with an empty row between blocks. */
export function renderDoc(blocks, opts = {}) {
  const rows = [];
  for (const b of blocks) {
    if (rows.length) rows.push({ segs: [], block: null });
    for (const r of renderBlock(b, opts)) rows.push({ ...r, block: b });
  }
  return rows;
}
