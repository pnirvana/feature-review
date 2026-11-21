// Assertion heuristics (discovery §9): signs that a test was weakened to make code pass,
// read from a test file's text before and after the change. Line based, no parser:
// JUnit, AssertJ, Mockito (Java, Kotlin, Groovy), Spock, pytest and unittest, Jest-style.
// A heuristic can be wrong; each signal says what it saw, the reviewer judges.

/** The test dialect of a file: 'spock' | 'java' | 'python' | 'js' | null. */
export function dialect(file, text = '') {
  if (/\.py$/i.test(file)) return 'python';
  if (/\.(m?[jt]sx?|cjs)$/i.test(file)) return 'js';
  if (/\.groovy$/i.test(file)) return /spock\.lang|extends\s+Specification\b/.test(text) ? 'spock' : 'java';
  if (/\.(java|kts?|scala)$/i.test(file)) return 'java';
  return null;
}

const ASSERT = {
  java: /\b(assert[A-Z]\w*|assertThat|fail|verify\w*|expect)\s*\(|^\s*assert\s/,
  spock: /^\s*assert\s/,
  python: /^\s*assert\b|\bself\.(assert\w+|fail)\(|\bpytest\.(raises|fail)\(|\.assert_\w+\(/,
  js: /\bexpect\s*\(|\bassert(\.\w+)?\s*\(/,
};
const COMMENT = /^\s*(\/\/|#|\*|\/\*)/;
const SPOCK_LABEL = /^\s*(given|setup|when|then|expect|where|cleanup|and):/;

/**
 * The lines of a text that assert something (1-based numbers). In Spock every condition in
 * a then: or expect: block is one, and so is an interaction (`1 * ledger.book(…)`).
 */
export function assertionLines(text, lang) {
  const out = new Set();
  if (text == null || !lang) return out;
  let block = null;
  text.split('\n').forEach((s, i) => {
    if (COMMENT.test(s) || !/[\p{L}\p{N}_]/u.test(s)) return;
    if (lang === 'spock') {
      if (/^\s*def\s/.test(s) && !/=/.test(s)) block = null; // a new feature method
      const m = s.match(SPOCK_LABEL);
      if (m) return void (m[1] !== 'and' && (block = m[1]));
      if (((block === 'then' || block === 'expect') && !/^\s*def\s/.test(s)) || ASSERT.spock.test(s)) out.add(i + 1);
      return;
    }
    if (ASSERT[lang].test(s)) out.add(i + 1);
  });
  return out;
}

const STRONG = /\b(assertEquals|assertArrayEquals|assertIterableEquals|assertSame|assertLinesMatch|assertThrows|isEqualTo|isSameAs|containsExactly\w*|hasSize|isEqualByComparingTo|toEqual|toStrictEqual|toBe|assertEqual|assertListEqual|assertDictEqual|assertRaises|times)\b|(?<![!=<>])==(?!=)|\braises\(/;
const WEAK = /\b(assertNotNull|isNotNull|assertTrue|isTrue|assertFalse|isFalse|isNotEmpty|isNotBlank|isInstanceOf|assertDoesNotThrow|doesNotThrowAnyException|notThrown|noExceptionThrown|toBeDefined|toBeTruthy|assertIsNotNone|atLeast\w*|atMost\w*)\b|!=\s*null|\bis not None\b/;
const WILDCARD = /\bany(String|Int|Long|Boolean|Double|Float|List|Map|Set|Collection|Iterable|Object)?\s*\(\s*(\w+(\.class)?)?\s*\)|\bArgumentMatchers\.\w+|(?<![\w$])_(?![\w$])|\bANY\b|\bexpect\.(anything|any)\(/;
const WILDCARDS = new RegExp(WILDCARD.source, 'g');
const NOTHROW = /\b(assertDoesNotThrow|doesNotThrowAnyException|notThrown|noExceptionThrown)\b/;
const DISABLED = /@(Disabled|Ignore|IgnoreIf|PendingFeature)\b|@pytest\.mark\.(skip|skipif|xfail)\b|@unittest\.skip|\bpytest\.skip\(|\b(it|test|describe)\.skip\(|\bx(it|describe|test)\(|\bAssumptions?\.assume\w*\(|\bassume(True|False|That)\(/;
const CATCH_ALL = /\bcatch\s*\(\s*(final\s+)?(Exception|Throwable|RuntimeException)\b|\bexcept\s*(\(\s*)?(Exception|BaseException)?\s*\)?\s*(as\s+\w+)?\s*:|\bthrown\(\s*(Exception|Throwable|RuntimeException)?\s*\)|\bassertThrows\(\s*(Exception|Throwable|RuntimeException)\.class|\bpytest\.raises\(\s*(Exception|BaseException)\s*\)/;
const TIMEOUT = /timeout|Timeout|\bwithin\(|ofSeconds|ofMillis|ofMinutes|Duration\./;
const LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\b\d+(?:\.\d+)?[LlFfDd]?\b/g;

const count = (xs, re) => xs.filter((s) => re.test(s)).length;
const wildcards = (xs) => xs.reduce((n, s) => n + (s.match(WILDCARDS)?.length ?? 0), 0);
const short = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstName = (xs, re) => xs.map((s) => s.match(re)?.[0]).find(Boolean);

/** The tests declared in a text: [{line (1-based), end, name}] in order. */
export function testDecls(text, lang) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  lines.forEach((s, i) => {
    let name = null;
    if (lang === 'java' && /^\s*@(Test|ParameterizedTest|RepeatedTest|TestFactory)\b/.test(s)) {
      for (let k = i; k < Math.min(lines.length, i + 4) && !name; k++) name = lines[k].match(/\b(?:void|fun|def)\s+`?([\w ]+?)`?\s*\(/)?.[1] ?? null;
      name ??= '(test)';
    } else if (lang === 'spock') name = s.match(/^\s*def\s+(["'])(.+)\1\s*\(/)?.[2] ?? null;
    else if (lang === 'python') name = s.match(/^\s*(?:async\s+)?def\s+(test\w*)\s*\(/)?.[1] ?? null;
    else if (lang === 'js') name = s.match(/^\s*(?:it|test)\s*\(\s*(["'`])(.+?)\1/)?.[2] ?? null;
    if (name) out.push({ line: i + 1, name });
  });
  out.forEach((d, k) => (d.end = k + 1 < out.length ? out[k + 1].line - 1 : lines.length));
  return out;
}

/**
 * The weakening signs of one test file's change. texts: {old, new} (null: not there).
 * → {units: Map hunk key → [signal], file: [signal]} (signals as in src/signals.mjs)
 */
export function testSignals(f, texts) {
  const units = new Map();
  const file = [];
  const lang = dialect(f.file, texts.new ?? texts.old ?? '');
  if (!lang) return { units, file };
  const add = (key, s) => units.set(key, [...(units.get(key) ?? []), { level: 'warn', ...s }]);
  const was = assertionLines(texts.old, lang);
  const now = assertionLines(texts.new, lang);
  if (texts.old != null && texts.new != null && now.size < was.size) file.push({ kind: 'fewer-assertions', label: 'FEWER ASSERTIONS', text: `${was.size} → ${now.size}`, level: 'warn' });

  const added = testDecls(texts.new, lang);
  const newLines = String(texts.new ?? '').split('\n');
  for (const h of f.hunks) {
    const del = h.lines.filter(([t]) => t === '-');
    const ins = h.lines.filter(([t]) => t === '+');
    const delA = del.filter(([, , o]) => was.has(o)).map(([, s]) => s);
    const insA = ins.filter(([, , , n]) => now.has(n)).map(([, s]) => s);
    const delS = del.map(([, s]) => s);
    const insS = ins.map(([, s]) => s);
    // the line a signal is about: shown under it, in the diff (the text need not repeat it)
    const atNew = (fn) => {
      const l = ins.find(([, s, , n]) => fn(s, n));
      return l ? { at: { side: 'new', line: l[3] } } : {};
    };
    const atOld = (fn) => {
      const l = del.find(([, s, o]) => fn(s, o));
      return l ? { at: { side: 'old', line: l[2] } } : {};
    };

    // removed assertions, when the file has fewer of them (not merely moved within it)
    if (delA.length > insA.length && now.size < was.size) add(h.key, { kind: 'assertion-removed', label: 'ASSERTION REMOVED', text: `${delA.length - insA.length} fewer in this hunk, ${was.size - now.size} in the file`, ...atOld((x, o) => was.has(o)) });

    // an expected value changed: the same assertion with other literals
    const shape = (s) => s.trim().replace(LITERAL, '§');
    for (const d of delA) {
      const i = insA.find((s) => shape(s) === shape(d) && s.trim() !== d.trim());
      if (!i) continue;
      const a = d.match(LITERAL) ?? [];
      const b = i.match(LITERAL) ?? [];
      const k = a.findIndex((x, j) => x !== b[j]);
      add(h.key, { kind: 'expected-changed', label: 'EXPECTED VALUE CHANGED', text: `${short(a[k] ?? '?', 30)} → ${short(b[k] ?? '?', 30)}`, ...atNew((x) => x === i) });
      break;
    }

    // exact checks traded for weaker ones, or wildcards for values
    if (count(delA, STRONG) > count(insA, STRONG) && count(insA, WEAK) > count(delA, WEAK))
      add(h.key, { kind: 'loosened', label: 'ASSERTION LOOSENED', text: `${firstName(delA, STRONG) ?? 'exact'} → ${firstName(insA, WEAK) ?? 'weaker'}`, ...atNew((x, n) => now.has(n) && WEAK.test(x)) });
    else if (wildcards(insA) > wildcards(delA) && delA.length)
      add(h.key, { kind: 'loosened', label: 'ASSERTION LOOSENED', text: `${wildcards(delA)} → ${wildcards(insA)} wildcards: any value matches`, ...atNew((x, n) => now.has(n) && WILDCARD.test(x)) });

    if (count(insS, DISABLED) > count(delS, DISABLED)) add(h.key, { kind: 'disabled', label: 'TEST DISABLED', text: short(insS.find((x) => DISABLED.test(x)).trim(), 50), ...atNew((x) => DISABLED.test(x)) });
    if (count(insS, CATCH_ALL) > count(delS, CATCH_ALL)) add(h.key, { kind: 'catch-all', label: 'CATCHES ANY EXCEPTION', text: short(insS.find((x) => CATCH_ALL.test(x)).trim(), 50), ...atNew((x) => CATCH_ALL.test(x)) });

    const nums = (xs) => xs.filter((s) => TIMEOUT.test(s)).flatMap((s) => (s.match(/\b\d+(?:\.\d+)?\b/g) ?? []).map(Number));
    const [tOld, tNew] = [nums(delS), nums(insS)];
    if (tOld.length && tNew.length && Math.max(...tNew) > Math.max(...tOld)) add(h.key, { kind: 'timeout', label: 'LONGER TIMEOUT', text: `${Math.max(...tOld)} → ${Math.max(...tNew)}`, ...atNew((x) => TIMEOUT.test(x)) });

    // a test added here that asserts nothing, or only that nothing is thrown
    for (const d of added) {
      if (!ins.some(([, , , n]) => n === d.line)) continue;
      const body = [...now].filter((n) => n > d.line && n <= d.end).map((n) => newLines[n - 1]);
      if (!body.length) add(h.key, { kind: 'asserts-nothing', label: 'ASSERTS NOTHING', text: `“${short(d.name, 50)}”`, at: { side: 'new', line: d.line } });
      else if (body.every((s) => NOTHROW.test(s))) add(h.key, { kind: 'asserts-nothing', label: 'ONLY CHECKS NOTHING IS THROWN', text: `“${short(d.name, 50)}”`, at: { side: 'new', line: d.line } });
    }
  }
  return { units, file };
}
