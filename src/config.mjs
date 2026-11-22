// Settings: ~/.config/feature-review/config.toml (or under $XDG_CONFIG_HOME), as ATF keeps
// its own. Each setting comes from, in order: a command-line flag, an environment
// variable, the file, the default. `fr config` shows them and where each came from;
// `fr config init` writes the file with every option commented out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfigFile } from './toml.mjs';

export const configDir = (env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'feature-review');

/** Every setting: its section and key, values, default, the environment variables that override it, and what it does. */
export const SETTINGS = [
  { key: 'viewer.vi_mode', type: 'boolean', default: false, env: ['FR_VI_MODE', 'ATF_VI_MODE'], doc: 'vi keys in the comment field (esc: normal mode, ⏎ there saves)' },
  { key: 'viewer.layout', values: ['auto', 'split', 'unified'], default: 'auto', flag: 'layout', doc: 'diffs side by side (split), in one column (unified), or split from 110 columns (auto)' },
  { key: 'viewer.lens', values: ['groups', 'services'], default: 'groups', flag: 'lens', doc: 'the lens to open in when there are annotations (tab switches)' },
  { key: 'viewer.highlight', values: ['auto', 'bat', 'builtin', 'none'], default: 'auto', flag: 'highlight', doc: 'code highlighting: bat when installed (auto), bat, the built-in one, or none' },
  { key: 'viewer.editor', type: 'string', default: '', env: ['VISUAL', 'EDITOR'], doc: 'the command o opens a line with (+LINE FILE appended); "": $VISUAL, else $EDITOR, else vi', envFirst: false },
  { key: 'feedback.file', type: 'string', default: '', env: ['FR_FEEDBACK'], doc: 'where the feedback key (!) appends its entries ("": $XDG_STATE_HOME/feature-review/feedback.jsonl, else ~/.local/state/…)' },
  { key: 'theme.background', type: 'background', default: 'auto', env: ['FR_BACKGROUND'], doc: 'auto (ask the terminal), light, dark or "#rrggbb": set it where the terminal does not answer' },
  { key: 'theme.bat_light', type: 'string', default: 'GitHub', env: ['BAT_THEME_LIGHT'], doc: "bat's theme on a light background ($BAT_THEME, when set, wins for both)" },
  { key: 'theme.bat_dark', type: 'string', default: '', env: ['BAT_THEME_DARK'], doc: 'bat\'s theme on a dark background ("": bat\'s default)' },
];

const TRUE = ['1', 'true', 'yes', 'on'];
const FALSE = ['0', 'false', 'no', 'off', ''];

function check(s, v, where) {
  if (s.type === 'boolean') {
    if (typeof v === 'boolean') return v;
    const t = String(v).trim().toLowerCase();
    if (TRUE.includes(t)) return true;
    if (FALSE.includes(t)) return false;
    throw new Error(`${where}: ${s.key} = ${JSON.stringify(v)}: use true or false`);
  }
  if (s.values) {
    if (!s.values.includes(v)) throw new Error(`${where}: ${s.key} = ${JSON.stringify(v)}: use one of ${s.values.join(', ')}`);
    return v;
  }
  if (s.type === 'background') {
    const t = String(v).trim().toLowerCase();
    if (['auto', 'light', 'dark'].includes(t) || /^#[\da-f]{6}$/.test(t)) return t;
    throw new Error(`${where}: ${s.key} = ${JSON.stringify(v)}: use auto, light, dark or "#rrggbb"`);
  }
  if (typeof v !== 'string') throw new Error(`${where}: ${s.key} = ${JSON.stringify(v)}: use a string`);
  return v;
}

/**
 * The settings in effect. flags: command-line values by flag name. → {values: {key: v},
 * sources: {key: 'flag'|'$VAR'|file|'default'}, file, error}. Throws on a bad value, naming
 * where it came from.
 */
export function loadConfig({ flags = {}, env = process.env, dir = configDir(env) } = {}) {
  const { data, file, error } = readConfigFile(dir);
  if (error) throw new Error(`${file}: ${error}`);
  const values = {};
  const sources = {};
  const known = new Set(SETTINGS.map((s) => s.key));
  for (const [sec, v] of Object.entries(data))
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of Object.keys(v)) if (!known.has(`${sec}.${k}`)) throw new Error(`${file}: unknown setting ${sec}.${k} (fr config lists them)`);
    } else throw new Error(`${file}: unknown setting ${sec} (settings are in sections, e.g. [viewer])`);
  for (const s of SETTINGS) {
    const [sec, k] = s.key.split('.');
    const fromFile = data[sec]?.[k];
    const fromEnv = (s.env ?? []).find((e) => env[e] !== undefined && env[e] !== '');
    let v;
    let src;
    if (s.flag && flags[s.flag] !== undefined) (v = check(s, flags[s.flag], `--${s.flag}`)), (src = 'flag');
    // the editor: the file's choice is for fr, so it wins over the general $VISUAL / $EDITOR
    else if (s.envFirst === false && fromFile !== undefined && fromFile !== '') (v = check(s, fromFile, file)), (src = file);
    else if (fromEnv) (v = check(s, env[fromEnv], `$${fromEnv}`)), (src = `$${fromEnv}`);
    else if (fromFile !== undefined) (v = check(s, fromFile, file)), (src = file);
    else (v = s.default), (src = 'default');
    values[s.key] = v;
    sources[s.key] = src;
  }
  return { values, sources, file: file ?? path.join(dir, 'config.toml'), exists: Boolean(file) };
}

/** The file `fr config init` writes: every setting at its default, commented out. */
export function template() {
  const out = ['# feature-review (fr): your settings. Everything is optional: uncomment what you change.', '# fr config shows the settings in effect and where each comes from.', ''];
  let sec = null;
  for (const s of SETTINGS) {
    const [sc, k] = s.key.split('.');
    if (sc !== sec) {
      out.push(`[${sc}]`);
      sec = sc;
    }
    out.push(`# ${s.doc}`);
    if (s.env?.length && s.envFirst !== false) out.push(`# (overridden by $${s.env.join(', else $')})`);
    out.push(`# ${k} = ${JSON.stringify(s.default)}`, '');
  }
  return out.join('\n').trimEnd() + '\n';
}

/** Write the template unless the file exists. → {file, written}. */
export function initConfig(dir = configDir()) {
  const file = path.join(dir, 'config.toml');
  if (fs.existsSync(file)) return { file, written: false };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, template());
  return { file, written: true };
}
