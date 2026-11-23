// Findings in the diff: what fr and the agent say about particular changed lines, collected
// so the viewer shows each under its line (a callout) and marks the lines in the gutter.
// The reader looks at the change and is made aware of what is smelly about it there,
// instead of matching a quoted line in a note below to the diff above.
//
// Sources: fr's signals that know their line (src/signals.mjs, src/asserts.mjs); the
// agent's unchanged callers (anchored at the change they depend on), test flags and
// findings that cite changed lines. What cites no changed line stays a note, as before.
import { hunkRange } from './annotations.mjs';
import { signalLayer } from './signals.mjs';

const where = (r) => `${r.repo}/${r.file.split('/').pop()}:${r.side === 'old' ? '-' : ''}${r.from === r.to ? r.from : `${r.from}-${r.to}`}`;
const human = (kind) => String(kind ?? '').replace(/[-_]/g, ' ').toUpperCase();
const CALLER = { broken: 'BREAKS A CALLER', unclear: 'CALLER TO CHECK', ok: 'CALLER STILL FINE' };

/**
 * → {byUnit: Map hunk key → [callout], inlined: Set of the annotation objects shown inline}
 * A callout: {key, source: 'fr' | 'agent', level: 'warn' | 'info', label, text, md (text is
 * Markdown), side, from, to (the lines it is about), ref? (the code it names, resolved),
 * expand? (code to show on ⏎), found_by?}.
 */
export function collectCallouts(ws, ann) {
  const byUnit = new Map();
  const inlined = new Set();
  const hunkOf = new Map();
  for (const r of ws.repos) for (const f of r.files) for (const h of f.hunks) hunkOf.set(h.key, h);
  const add = (u, c) => byUnit.set(u, [...(byUnit.get(u) ?? []), c]);

  // fr: signals with a line
  for (const [u, list] of ws.signals?.units ?? [])
    for (const s of list)
      if (s.at && hunkOf.has(u))
        add(u, { key: `fr:${u}:${s.kind}:${s.at.side}${s.at.line}`, source: 'fr', about: `fr:${s.kind}`, layer: signalLayer(s), level: s.level === 'info' ? 'info' : 'warn', label: s.label, text: s.text, md: false, side: s.at.side, from: s.at.line, to: s.at.line });

  if (!ann?.ann) return { byUnit, inlined };
  const res = (ref) => ann.refs?.get(ref) ?? null;
  const inChange = (r) => r?.ok && !r.external && r.units.some((u) => hunkOf.has(u));
  // the hunk that holds the cited range's last line (the callout goes under it)
  const unitFor = (r) => {
    const us = r.units.filter((u) => hunkOf.has(u));
    return (
      us.find((u) => {
        const [a, b] = hunkRange(hunkOf.get(u), r.side);
        return r.to >= a && r.to <= b;
      }) ?? us[us.length - 1]
    );
  };
  // a citation of a whole hunk marks no line in particular: the callout goes at its end
  const span = (r) => ({ side: r.side, from: r.hunkId ? r.to : r.from, to: r.to });
  const list = (k) => (Array.isArray(ann.ann[k]) ? ann.ann[k] : []);

  list('ghosts').forEach((g, i) => {
    const b = (Array.isArray(g?.because) ? g.because : []).map(res).find(inChange);
    if (!b) return;
    inlined.add(g);
    const r = res(g.ref);
    add(unitFor(b), {
      key: `ghost:${i}`,
      source: 'agent',
      about: `agent:ghost${g.status ? `:${g.status}` : ''}`,
      level: g.status === 'ok' ? 'info' : 'warn',
      label: CALLER[g.status] ?? 'UNCHANGED CALLER',
      text: g.why ?? '',
      md: true,
      ref: r,
      refRaw: g.ref,
      ...(r?.ok && r.code?.length ? { expand: r } : {}),
      ...(g.found_by ? { found_by: String(g.found_by) } : {}),
      ...span(b),
    });
  });

  list('tests').forEach((t, i) =>
    (Array.isArray(t?.flags) ? t.flags : []).forEach((f, j) => {
      const r = (Array.isArray(f?.refs) ? f.refs : []).map(res).find(inChange);
      if (!r) return;
      inlined.add(f);
      add(unitFor(r), { key: `flag:${i}:${j}`, source: 'agent', about: `agent:test-flag${f?.kind ? `:${f.kind}` : ''}`, level: 'warn', label: human(f.kind), text: f.note ?? '', md: true, ...span(r) });
    }),
  );

  list('findings').forEach((f, i) => {
    const r = res(f?.ref);
    if (!inChange(r)) return;
    inlined.add(f);
    const c = { key: `finding:${i}`, source: 'agent', about: `agent:finding${f?.kind ? `:${f.kind}` : ''}`, level: f.severity === 'low' ? 'info' : 'warn', label: human(f.kind || 'finding'), md: true };
    add(unitFor(r), { ...c, text: f.note ?? '', ...span(r) });
    // the other lines the same problem shows at: marked, with a pointer to the finding
    (Array.isArray(f.also) ? f.also : []).map(res).forEach((a, j) => {
      if (inChange(a)) add(unitFor(a), { ...c, key: `finding:${i}:also:${j}`, md: false, text: `see the finding at ${where(r)}`, ...span(a) });
    });
  });
  return { byUnit, inlined };
}
