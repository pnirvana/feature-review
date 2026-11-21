// The overview (discovery §10, "the map first"): the annotations that describe the whole
// change rather than a hunk, one tab each: design (§7), names (§8), contracts and rollout
// (§6). Each citation is a row the viewer can jump from (⏎: to the code in the review, or
// the cited code expanded in place when it is not part of the change).
//
// Facts the tool can check are added as "fr noticed", apart from the agent's own words.
import { renderBlock } from './md/render.mjs';
import { parseDoc } from './md/parse.mjs';
import { codeView } from './md/render.mjs';
import { pad, restyle } from './md/term.mjs';

export const TABS = [
  { id: 'design', title: 'Design', count: (a) => (Array.isArray(a.design) ? a.design.length : 0) },
  { id: 'names', title: 'Names', count: (a) => (Array.isArray(a.names) ? a.names.length : 0) },
  { id: 'contracts', title: 'Contracts', count: (a) => (Array.isArray(a.contracts) ? a.contracts.length : 0) },
  { id: 'rollout', title: 'Rollout', count: (a) => (a.rollout && typeof a.rollout === 'object' ? 1 : 0) },
];

const BADGE = { high: 'riskhigh', medium: 'riskmedium', low: 'risklow', broken: 'riskhigh', unclear: 'riskmedium', ok: 'risklow', no: 'riskhigh', yes: 'risklow' };
const badge = (text, style) => [` ${String(text).toUpperCase().replace(/-/g, ' ')} `, style];
const spacer = () => ({ kind: 'blank', spacer: true, segs: [] });
const str = (x) => typeof x === 'string' && x.trim() !== '';

function md(text, width, indent = 2, extra = '') {
  const rows = [];
  parseDoc(String(text ?? '')).forEach((b, i) => {
    if (i) rows.push(spacer());
    for (const r of renderBlock(b, { width: Math.max(10, width - indent), highlight: 'builtin' })) rows.push({ kind: 'text', segs: [[' '.repeat(indent), ''], ...(extra ? restyle(r.segs, extra) : r.segs)] });
  });
  return rows;
}

const where = (res, ref) => {
  if (!res?.ok) return ref?.hunk ?? `${ref?.repo ?? ref?.path ?? '?'}/${ref?.file ?? '?'}:${ref?.lines ?? '?'}`;
  return `${res.repo}/${res.file}:${res.side === 'old' ? '-' : ''}${res.from === res.to ? res.from : `${res.from}-${res.to}`}`;
};

/**
 * A citation as a row to jump from, and, when expanded, its code. inChange: the cited lines
 * are part of the change (⏎ jumps to them in the review); else ⏎ expands them here.
 */
function refRows(ctx, ref, { indent = 2, label = null, note = null } = {}) {
  const res = ctx.refs.get(ref) ?? null;
  const inChange = Boolean(res?.ok && res.units.length);
  const rows = [
    {
      kind: 'ref',
      ref,
      res,
      segs: [
        [' '.repeat(indent), ''],
        ...(label ? [[label, 'dim'], [' ', '']] : []),
        [where(res, ref), res?.ok ? (inChange ? 'link' : 'bold') : 'red'],
        ...(res && !res.ok ? [[`  does not resolve: ${res.error}`, 'red']] : res?.external ? [['  outside the feature', 'dim']] : !inChange && res?.ok ? [['  unchanged', 'dim']] : []),
        ...(note ? [['  ', ''], ...note] : []),
      ],
    },
  ];
  if (res?.ok && !inChange && ctx.expanded.has(ref))
    rows.push(
      ...codeView({ groups: [{ lines: res.code.map((l) => ({ t: ' ', s: l.s, n: l.n })) }], name: res.file, width: ctx.width - indent - 2, highlight: 'builtin' }).map((r) => ({ kind: 'code', ref, segs: [[' '.repeat(indent + 2), ''], ...r.segs] })),
    );
  return rows;
}

/** A heading on a band; a badge keeps its own background. */
const OWN_BG = /\b(risk\w+|role|fact)\b|(^|[ ;])48;/;
const heading = (segs, width) => ({ kind: 'item', segs: pad(segs.map((x) => (OWN_BG.test(x[1] ?? '') ? x : restyle([x], 'band')[0])), width, 'band') });
const empty = (what) => [{ kind: 'text', segs: [[`  The agent wrote no ${what}.`, 'dim']] }];

function design(ctx) {
  const list = Array.isArray(ctx.ann.design) ? ctx.ann.design : [];
  if (!list.length) return empty('design notes');
  const rows = [];
  list.forEach((d, i) => {
    if (i) rows.push(spacer(), spacer());
    rows.push(heading([[' ', ''], [String(d.type ?? '?'), 'bold'], ['   ', ''], ...(d.change ? [badge(d.change, 'role'), [' ', '']] : []), ...(d.layer ? [[d.layer, 'dim']] : [])], ctx.width));
    if (d.ref) rows.push(...refRows(ctx, d.ref));
    if (str(d.responsibility)) rows.push(spacer(), ...md(d.responsibility, ctx.width));
    // facts the tool sees for itself
    const noticed = [];
    if (str(d.responsibility) && /\band\b/i.test(d.responsibility)) noticed.push('the responsibility needs an “and”: one type doing two things?');
    for (const dep of Array.isArray(d.dependencies_added) ? d.dependencies_added : [])
      if (d.layer === 'domain' && dep?.layer === 'infrastructure' && !(d.signals ?? []).some((s) => s?.kind === 'domain-depends-on-infrastructure')) noticed.push(`a domain type now depends on infrastructure: ${dep.to}`);
    const deps = Array.isArray(d.dependencies_added) ? d.dependencies_added : [];
    if (deps.length) {
      rows.push(spacer(), { kind: 'text', segs: [['  new dependencies', 'dim bold']] });
      for (const dep of deps) rows.push(...(dep?.ref ? refRows(ctx, dep.ref, { indent: 4, label: `→ ${dep?.to ?? '?'}${dep?.layer ? ` (${dep.layer})` : ''}` }) : [{ kind: 'text', segs: [[`    → ${dep?.to ?? '?'}${dep?.layer ? ` (${dep.layer})` : ''}`, '']] }]));
    }
    for (const s of Array.isArray(d.signals) ? d.signals : []) {
      rows.push(spacer(), { kind: 'text', segs: [['  ', ''], badge(s?.kind ?? '?', 'riskmedium')] });
      if (str(s?.note)) rows.push(...md(s.note, ctx.width, 4));
      for (const r of Array.isArray(s?.refs) ? s.refs : []) rows.push(...refRows(ctx, r, { indent: 4 }));
    }
    for (const n of noticed) rows.push(spacer(), { kind: 'text', segs: [['  ', ''], [' FR NOTICED ', 'fact'], ['  ', ''], [n, '']] });
    const prec = Array.isArray(d.precedent) ? d.precedent : [];
    if (prec.length) {
      rows.push(spacer(), { kind: 'text', segs: [['  how the codebase does it', 'dim bold']] });
      for (const p of prec) {
        if (p?.ref) rows.push(...refRows(ctx, p.ref, { indent: 4 }));
        if (str(p?.note)) rows.push(...md(p.note, ctx.width, 4));
      }
    }
    if (str(d.opinion)) rows.push(spacer(), { kind: 'text', segs: [["  the agent's opinion", 'dim bold']] }, ...md(d.opinion, ctx.width, 4, 'italic'));
  });
  return rows;
}

const NAME_FLAG = { ok: 'risklow', technical: 'riskmedium', 'differs-from-codebase': 'riskmedium', 'inconsistent-across-services': 'riskhigh' };

function names(ctx) {
  const list = Array.isArray(ctx.ann.names) ? ctx.ann.names : [];
  if (!list.length) return empty('names list');
  // flagged names first, side by side; "ok" ones after
  const order = [...list].sort((a, b) => (a?.flag === 'ok') - (b?.flag === 'ok'));
  const w = Math.min(28, Math.max(...order.map((n) => String(n?.name ?? '').length)));
  const rows = [];
  order.forEach((n, i) => {
    if (i) rows.push(spacer());
    rows.push({
      kind: 'item',
      segs: [
        [' ', ''],
        [String(n?.name ?? '?').padEnd(w), 'bold'],
        ['  ', ''],
        [String(n?.kind ?? '').padEnd(10), 'dim'],
        ['  ', ''],
        ...(n?.flag ? [badge(n.flag, NAME_FLAG[n.flag] ?? 'riskmedium')] : []),
      ],
    });
    if (n?.ref) rows.push(...refRows(ctx, n.ref, { indent: 3 }));
    for (const c of Array.isArray(n?.codebase) ? n.codebase : []) rows.push(...(c?.ref ? refRows(ctx, c.ref, { indent: 3, label: `the codebase calls it ${c?.name ?? '?'}:` }) : []));
    if (str(n?.note)) rows.push(...md(n.note, ctx.width, 3));
  });
  return rows;
}

function contracts(ctx) {
  const list = Array.isArray(ctx.ann.contracts) ? ctx.ann.contracts : [];
  if (!list.length) return empty('contract notes');
  const rows = [];
  list.forEach((c, i) => {
    if (i) rows.push(spacer(), spacer());
    rows.push(heading([[' ', ''], [String(c?.name ?? '?'), 'bold'], ['   ', ''], ...(c?.kind ? [[c.kind, 'dim'], ['   ', '']] : []), ['backward compatible ', ''], ...(c?.compatible ? [badge(c.compatible, BADGE[c.compatible] ?? 'riskmedium')] : [])], ctx.width));
    if (c?.producer?.ref) rows.push(...refRows(ctx, c.producer.ref, { label: 'producer' }));
    const fields = Array.isArray(c?.fields) ? c.fields : [];
    if (fields.length) {
      const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
      const table = ['| field | producer | consumer | note |', '|---|---|---|---|', ...fields.map((f) => `| \`${esc(f?.name)}\` | ${esc(f?.producer)} | ${esc(f?.consumer)} | ${esc(f?.note)} |`)].join('\n');
      rows.push(spacer(), ...md(table, ctx.width));
    }
    const cons = Array.isArray(c?.consumers) ? c.consumers : [];
    if (cons.length) {
      rows.push(spacer(), { kind: 'text', segs: [['  consumers', 'dim bold']] });
      for (const x of cons) {
        rows.push(
          ...(x?.ref
            ? refRows(ctx, x.ref, {
                indent: 4,
                note: [...(x?.status ? [badge(x.status, BADGE[x.status] ?? 'riskmedium'), [' ', '']] : []), [x?.changed ? 'changed' : 'not changed', x?.changed ? 'dim' : 'yellow']],
              })
            : []),
        );
        if (str(x?.note)) rows.push(...md(x.note, ctx.width, 6));
      }
    }
  });
  return rows;
}

function rollout(ctx) {
  const ro = ctx.ann.rollout;
  if (!ro || typeof ro !== 'object') return empty('rollout notes');
  const rows = [];
  const order = Array.isArray(ro.order) ? ro.order : [];
  if (order.length) {
    rows.push(heading([[' deploy in this order   ', 'bold'], ...order.flatMap((n, i) => [...(i ? [['  →  ', 'dim']] : []), [`${i + 1}. ${n}`, 'bold']])], ctx.width));
    if (str(ro.why)) rows.push(spacer(), ...md(ro.why, ctx.width));
  }
  const partial = Array.isArray(ro.partial) ? ro.partial : [];
  if (partial.length) {
    rows.push(spacer(), spacer(), heading([[' while only some services are deployed', 'bold']], ctx.width));
    for (const p of partial) {
      rows.push(spacer(), {
        kind: 'item',
        segs: [
          ['  ', ''],
          ...(p?.risk ? [badge(p.risk, BADGE[p.risk] ?? 'riskmedium'), ['  ', '']] : []),
          ['deployed ', 'dim'],
          [(p?.deployed ?? []).join(', ') || '?', 'bold'],
          ['   not yet ', 'dim'],
          [(p?.not ?? []).join(', ') || '?', 'bold'],
        ],
      });
      if (str(p?.effect)) rows.push(...md(p.effect, ctx.width, 4));
    }
  }
  const config = Array.isArray(ro.config) ? ro.config : [];
  if (config.length) {
    rows.push(spacer(), spacer(), heading([[' configuration', 'bold']], ctx.width));
    for (const c of config) {
      rows.push(spacer());
      if (c?.ref) rows.push(...refRows(ctx, c.ref));
      if (str(c?.note)) rows.push(...md(c.note, ctx.width, 4));
    }
  }
  return rows.length ? rows : empty('rollout notes');
}

/**
 * One tab's rows. checked: checkAnnotations() plus {ann}; expanded: the refs whose code is
 * shown. Rows: kind 'item' | 'text' | 'ref' (ref, res: a jump target) | 'code' | 'blank'.
 */
export function overviewRows(checked, tab, { width = 100, expanded = new Set() } = {}) {
  const ctx = { ann: checked?.ann ?? {}, refs: checked?.refs ?? new Map(), width, expanded };
  const fn = { design, names, contracts, rollout }[tab];
  return fn ? fn(ctx) : [];
}

/** The tab bar: each tab with its count, the current one marked. */
export const tabBar = (checked, current) =>
  TABS.flatMap((t, i) => {
    const n = t.count(checked?.ann ?? {});
    return [[i ? '  ' : '', ''], [` ${i + 1} ${t.title}${n ? ` ${n}` : ''} `, t.id === current ? 'inverse bold' : n ? '' : 'dim']];
  });
