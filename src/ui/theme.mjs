// Colours from the terminal's theme. Light or dark is not assumed: the viewer asks the
// terminal for its background, foreground and palette (OSC 10, 11, 4) and mixes every tint
// from them: group bands, diff backgrounds, badges. A terminal that does not answer gets
// FR_BACKGROUND (light | dark | #rrggbb), else COLORFGBG, else dark.
//
// The result is applied to STYLE (src/md/term.mjs) as named styles, so rows keep using
// names: band, bandalt, guide, rule, guidealt, role, riskhigh, riskmedium, risklow, fact, factsoft, factbar, agent, agentsoft, agentbar, explain, asked, explainbar, explainband, markexplain, markfr, markagent, markcomment, the diff
// tints addbg, delbg, addword, delword, addfg, delfg, filler, and code and link for the
// Markdown of annotations. It also picks bat's theme for a light or dark terminal.
import { STYLE } from '../md/term.mjs';
import { setBatBackground } from '../md/highlight.mjs';

// Catppuccin Mocha and Latte: the fallback palettes for dark and light
const DEFAULTS = {
  dark: { bg: [30, 30, 46], fg: [205, 214, 244], red: [243, 139, 168], green: [166, 227, 161], yellow: [249, 226, 175], blue: [137, 180, 250], magenta: [245, 194, 231], cyan: [148, 226, 213] },
  light: { bg: [239, 241, 245], fg: [76, 79, 105], red: [210, 15, 57], green: [64, 160, 43], yellow: [223, 142, 29], blue: [30, 102, 245], magenta: [234, 118, 203], cyan: [23, 146, 153] },
};

export const hex = (s) => {
  const m = String(s).trim().match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : null;
};
/** Relative luminance, 0 (black) to 1 (white). */
export const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
export const isLight = (rgb) => luminance(rgb) > 0.5;
/** a mixed toward b by t (0..1). */
export const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
const fg = (c) => `38;2;${c.join(';')}`;
const bg = (c) => `48;2;${c.join(';')}`;

/** "rgb:RRRR/GGGG/BBBB" (or 2-digit components) → [r, g, b]. */
export function parseRgb(s) {
  const m = String(s).match(/rgba?:([\da-f]+)\/([\da-f]+)\/([\da-f]+)/i);
  if (!m) return null;
  return [m[1], m[2], m[3]].map((h) => Math.round((parseInt(h, 16) / (16 ** h.length - 1)) * 255));
}

/** The colours to use without asking the terminal: FR_BACKGROUND, COLORFGBG, else dark. */
export function fallbackColors(env = process.env) {
  const want = String(env.FR_BACKGROUND ?? '').trim().toLowerCase();
  if (want === 'light' || want === 'dark') return { ...DEFAULTS[want] };
  const h = hex(want);
  if (h) return { ...DEFAULTS[isLight(h) ? 'light' : 'dark'], bg: h };
  // COLORFGBG: "fg;bg" in ANSI numbers; bg 7 or 15 (or 9-15 but 8) is light
  const parts = String(env.COLORFGBG ?? '').split(';');
  const b = Number(parts[parts.length - 1]);
  if (parts.length > 1 && Number.isInteger(b)) return { ...DEFAULTS[b === 7 || b === 15 ? 'light' : 'dark'] };
  return { ...DEFAULTS.dark };
}

/**
 * Ask the terminal for its colours: background (OSC 11), foreground (OSC 10), palette red,
 * green, yellow, blue, magenta, cyan (OSC 4;1..6). Ends at the answer to a device-attributes query, which
 * every terminal sends, or after `timeout` ms. Needs stdin in raw mode, before any other
 * reader. → {bg, fg, red, …, cyan} (what was answered) or null.
 */
export function queryColors({ input = process.stdin, output = process.stdout, timeout = 400 } = {}) {
  if (!input.isTTY || !output.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = '';
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    const done = () => {
      clearTimeout(timer);
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      const got = {};
      const re = /\x1b\](\d+)(?:;(\d+))?;(rgba?:[\da-f/]+)(?:\x07|\x1b\\)/gi;
      let m;
      while ((m = re.exec(buf))) {
        const rgb = parseRgb(m[3]);
        if (!rgb) continue;
        if (m[1] === '11') got.bg = rgb;
        else if (m[1] === '10') got.fg = rgb;
        else if (m[1] === '4') got[{ 1: 'red', 2: 'green', 3: 'yellow', 4: 'blue', 5: 'magenta', 6: 'cyan' }[m[2]]] = rgb;
      }
      resolve(got.bg ? got : null);
    };
    const onData = (d) => {
      buf += d.toString('latin1');
      if (/\x1b\[\?[\d;]*c/.test(buf)) done(); // the device attributes answer comes last
    };
    const timer = setTimeout(done, timeout);
    input.on('data', onData);
    input.resume();
    output.write('\x1b]11;?\x07\x1b]10;?\x07\x1b]4;1;?\x07\x1b]4;2;?\x07\x1b]4;3;?\x07\x1b]4;4;?\x07\x1b]4;5;?\x07\x1b]4;6;?\x07\x1b[c');
  });
}

/** The named styles for a theme's colours (missing ones from the light or dark defaults). */
export function makeStyles(colors) {
  const c = { ...DEFAULTS[isLight(colors.bg) ? 'light' : 'dark'], ...colors };
  const light = isLight(c.bg);
  const k = light ? 0.75 : 1; // light backgrounds show a tint more strongly
  return {
    band: bg(mix(c.bg, c.blue, 0.13 * k)),
    bandalt: bg(mix(c.bg, c.yellow, 0.16 * k)),
    guide: fg(mix(c.bg, c.blue, 0.75)),
    // a pane's border (the peek's top line): the accent, a little toned down
    rule: fg(mix(c.bg, c.blue, 0.85)),
    guidealt: fg(mix(c.bg, c.yellow, 0.8)),
    role: `1;${fg(c.blue)};${bg(mix(c.bg, c.blue, 0.18 * k))}`,
    riskhigh: `1;${fg(c.bg)};${bg(c.red)}`,
    riskmedium: `1;${fg(c.bg)};${bg(c.yellow)}`,
    risklow: `1;${fg(c.bg)};${bg(c.green)}`,
    // what the tool checked itself, apart from the agent's judgement
    fact: `1;${fg(c.bg)};${bg(c.blue)}`,
    // a fact that is only information: the same hue, no fill
    factsoft: `1;${fg(c.blue)}`,
    factbar: fg(mix(c.bg, c.blue, 0.75)),
    // what the agent says about a line, in the diff: its own hue
    agent: `1;${fg(c.bg)};${bg(c.cyan)}`,
    agentsoft: `1;${fg(c.cyan)}`,
    agentbar: fg(mix(c.bg, c.cyan, 0.75)),
    // the answers to the reviewer's questions: a hue of their own (between fr's and the
    // comments'), a filled label, and a tint under the whole answer, apart from the review
    explain: `1;${fg(c.bg)};${bg(mix(c.blue, c.magenta, 0.5))}`,
    asked: `1;${fg(mix(c.blue, c.magenta, 0.5))};${bg(mix(c.bg, mix(c.blue, c.magenta, 0.5), 0.25 * k))}`,
    explainbar: fg(mix(c.bg, mix(c.blue, c.magenta, 0.5), 0.8)),
    explainband: bg(mix(c.bg, mix(c.blue, c.magenta, 0.5), 0.09 * k)),
    markexplain: fg(mix(c.blue, c.magenta, 0.5)),
    // the gutter mark of a line something is said about: fr, the agent, a comment
    markfr: fg(c.blue),
    markagent: fg(c.cyan),
    markcomment: fg(c.magenta),
    // the diff, as diffview tints it: soft line backgrounds, the changed part stronger
    // the cursor's line: a soft tint; on an added or removed line, its own tint a little stronger
    cursorbg: bg(mix(c.bg, c.fg, light ? 0.1 : 0.09)),
    addbgcur: bg(mix(c.bg, c.green, 0.3 * k)),
    delbgcur: bg(mix(c.bg, c.red, 0.3 * k)),
    addbg: bg(mix(c.bg, c.green, 0.16 * k)),
    delbg: bg(mix(c.bg, c.red, 0.16 * k)),
    addword: bg(mix(c.bg, c.green, 0.34 * k)),
    delword: bg(mix(c.bg, c.red, 0.34 * k)),
    addfg: fg(c.green),
    delfg: fg(c.red),
    filler: fg(mix(c.bg, c.fg, 0.2)),
    // Markdown in the annotations
    code: `${fg(mix(c.yellow, c.fg, light ? 0.35 : 0.15))};${bg(mix(c.bg, c.fg, 0.07))}`,
    link: `4;${fg(c.blue)}`,
  };
}

let batEnv = process.env;
/** Apply a theme's styles to STYLE, and pick bat's theme for it. → the styles applied. */
export function applyTheme(colors) {
  const s = makeStyles(colors);
  Object.assign(STYLE, s);
  setBatBackground(isLight(colors.bg), batEnv);
  return s;
}

/**
 * The theme from the settings (src/config.mjs): bat's light and dark themes, and the
 * background when it is fixed. → true when the terminal should still be asked (auto).
 */
export function configureTheme(values, env = process.env) {
  batEnv = { BAT_THEME: env.BAT_THEME, BAT_THEME_LIGHT: values['theme.bat_light'], BAT_THEME_DARK: values['theme.bat_dark'] };
  const bg = values['theme.background'];
  applyTheme(fallbackColors({ COLORFGBG: env.COLORFGBG, ...(bg !== 'auto' ? { FR_BACKGROUND: bg } : {}) }));
  return bg === 'auto';
}

// until a theme is applied: the fallback (so --print and tests never see a missing name)
applyTheme(fallbackColors());
