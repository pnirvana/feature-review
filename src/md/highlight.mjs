// Copied from agent-task-framework (branch review-documents, 99738d7), plus highlightAsync.
// Syntax highlighting for code views, line by line (a line in is a line out, so line
// numbers and anchors stay 1:1). `bat` when it is installed (mode auto|bat), else a small
// built-in highlighter: keywords, strings, comments, numbers. No ATF imports.
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseAnsi, untab } from './term.mjs';

let batOk;
let batTheme = null;
/**
 * The bat theme for a light or dark terminal: BAT_THEME wins (bat reads it itself), else
 * BAT_THEME_LIGHT / BAT_THEME_DARK, else GitHub on light and bat's default on dark.
 * (feature-review: bat runs without a terminal, so it cannot tell by itself.)
 */
export function setBatBackground(light, env = process.env) {
  if (env.BAT_THEME) batTheme = null;
  else batTheme = light ? (env.BAT_THEME_LIGHT || 'GitHub') : (env.BAT_THEME_DARK || null);
}
const themeArgs = () => (batTheme ? ['--theme', batTheme] : []);
/** The theme bat is given (null: bat's own choice). */
export const batThemeNow = () => batTheme;
/** Is bat installed? (checked once) */
export function hasBat() {
  if (batOk === undefined) {
    try {
      batOk = spawnSync('bat', ['--version'], { stdio: 'ignore', timeout: 3000 }).status === 0;
    } catch {
      batOk = false;
    }
  }
  return batOk;
}

const EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', json: 'json',
  py: 'py', rb: 'rb', sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh',
  java: 'c', kt: 'c', kts: 'c', scala: 'c', c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cs: 'c', go: 'c', rs: 'c', swift: 'c', dart: 'c', php: 'c',
  sql: 'sql', lua: 'lua', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'toml', md: 'md', html: 'html', xml: 'html', css: 'c',
};
const LANG = { javascript: 'js', typescript: 'js', node: 'js', python: 'py', ruby: 'rb', shell: 'sh', console: 'sh', golang: 'go', rust: 'rs', kotlin: 'kt' };
/** The built-in highlighter's family for a file name or fence language ('' if unknown). */
export function family(nameOrLang) {
  const s = String(nameOrLang || '').toLowerCase();
  const ext = s.includes('.') ? path.extname(s).slice(1) : s;
  const k = LANG[ext] ?? ext;
  return EXT[k] ?? (EXT[s] ? EXT[s] : '');
}

const KEYWORDS = new Set(
  (
    'abstract as async await break case catch class const continue def default defer del delete do elif else enum export extends ' +
    'false final finally fn for from func function go if impl implements import in instanceof interface is lambda let loop match mod ' +
    'module mut new nil none not null of or and override package pass private protected pub public raise return self static struct ' +
    'super switch this throw throws trait true try type typeof undefined unless until use val var void when where while with yield ' +
    'True False None elsif end begin then fi esac done local echo export readonly select from where insert update into values join on group by order limit'
  ).split(' '),
);
const COMMENT = { js: ['//', '/*'], c: ['//', '/*'], json: [], py: ['#'], rb: ['#'], sh: ['#'], toml: ['#'], yaml: ['#'], sql: ['--', '/*'], lua: ['--'], md: [], html: ['<!--'] };

/** The built-in highlighter: one list of segments per line. */
export function builtinHighlight(lines, fam) {
  const cm = COMMENT[fam] ?? ['//', '#', '/*'];
  const line1 = cm.filter((c) => c !== '/*' && c !== '<!--');
  const blockOpen = cm.includes('/*') ? '/*' : cm.includes('<!--') ? '<!--' : null;
  const blockClose = blockOpen === '/*' ? '*/' : '-->';
  let inBlock = false;
  return lines.map((raw) => {
    const s = untab(raw);
    const out = [];
    let i = 0;
    let plainText = '';
    const flush = () => plainText && (out.push([plainText, '']), (plainText = ''));
    while (i < s.length) {
      if (inBlock) {
        const e = s.indexOf(blockClose, i);
        const to = e < 0 ? s.length : e + blockClose.length;
        out.push([s.slice(i, to), 'gray italic']);
        i = to;
        if (e >= 0) inBlock = false;
        continue;
      }
      const rest = s.slice(i);
      if (blockOpen && rest.startsWith(blockOpen)) {
        flush();
        inBlock = true;
        continue;
      }
      const lc = line1.find((c) => rest.startsWith(c) && (c !== '#' || fam !== 'c'));
      if (lc && (lc !== '#' || i === 0 || /\s/.test(s[i - 1]))) {
        flush();
        out.push([rest, 'gray italic']);
        break;
      }
      const q = rest[0];
      if (q === '"' || q === "'" || q === '`') {
        flush();
        let j = 1;
        while (j < rest.length && rest[j] !== q) j += rest[j] === '\\' ? 2 : 1;
        out.push([rest.slice(0, j + 1), 'green']);
        i += j + 1;
        continue;
      }
      const num = rest.match(/^(0x[\da-f]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)\b/i);
      if (num && !/[\w$]/.test(s[i - 1] ?? '')) {
        flush();
        out.push([num[0], 'magenta']);
        i += num[0].length;
        continue;
      }
      const word = rest.match(/^[A-Za-z_$][\w$]*/);
      if (word) {
        const w = word[0];
        if (KEYWORDS.has(w) && fam !== 'md') flush(), out.push([w, 'blue bold']);
        else if (rest[w.length] === '(') flush(), out.push([w, 'cyan']);
        else if (fam && /^[A-Z][a-z]\w*$/.test(w) && fam !== 'md') flush(), out.push([w, 'yellow']);
        else plainText += w;
        i += w.length;
        continue;
      }
      plainText += s[i++];
    }
    flush();
    return out;
  });
}

const batCache = new Map();
/**
 * Highlight lines of code. `name` is a file name or a fence language. mode: auto (bat if
 * installed, else built-in) | bat | builtin | none. → one list of segments per line.
 */
export function highlight(lines, name, mode = 'auto') {
  if (!lines.length) return [];
  const none = () => lines.map((l) => [[untab(l), '']]);
  if (mode === 'none' || mode === false) return none();
  if ((mode === 'auto' || mode === 'bat') && hasBat() && name) {
    const text = lines.join('\n') + '\n';
    const key = `${name}\0${text}`;
    if (!batCache.has(key)) {
      const args = ['--color=always', '--style=plain', '--paging=never', '--tabs=4', ...themeArgs()];
      args.push(...(String(name).includes('.') ? ['--file-name', String(name)] : ['--language', String(name)]));
      let res = null;
      try {
        const outText = execFileSync('bat', args, { input: text, stdio: ['pipe', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 32 << 20 }).toString();
        const got = outText.replace(/\n$/, '').split('\n');
        // a line in is a line out, or not at all
        if (got.length === lines.length) res = got.map(parseAnsi);
      } catch {
        res = null; // unknown language: the built-in highlighter
      }
      if (batCache.size > 500) batCache.clear();
      batCache.set(key, res);
    }
    const hit = batCache.get(key);
    if (hit) return hit;
  }
  if (mode === 'bat' && !hasBat()) return builtinHighlight(lines, family(name));
  return builtinHighlight(lines, family(name));
}

/**
 * highlight(), without blocking: bat runs as a child process, so several can run at once
 * and the caller stays responsive. (feature-review)
 */
export function highlightAsync(lines, name, mode = 'auto') {
  if (!lines.length) return Promise.resolve([]);
  if (mode === 'none' || mode === false) return Promise.resolve(lines.map((l) => [[untab(l), '']]));
  if (!((mode === 'auto' || mode === 'bat') && hasBat() && name)) return Promise.resolve(builtinHighlight(lines, family(name)));
  const args = ['--color=always', '--style=plain', '--paging=never', '--tabs=4', ...themeArgs()];
  args.push(...(String(name).includes('.') ? ['--file-name', String(name)] : ['--language', String(name)]));
  return new Promise((resolve) => {
    const p = execFile('bat', args, { timeout: 60_000, maxBuffer: 256 << 20 }, (err, stdout) => {
      const got = err ? null : String(stdout).replace(/\n$/, '').split('\n');
      // a line in is a line out, or the built-in highlighter
      resolve(got && got.length === lines.length ? got.map(parseAnsi) : builtinHighlight(lines, family(name)));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(lines.join('\n') + '\n');
  });
}
