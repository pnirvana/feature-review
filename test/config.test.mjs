import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, template, initConfig } from '../src/config.mjs';
import { parseToml } from '../src/toml.mjs';
import { readManifest } from '../src/workspace.mjs';

const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-config-'));
  dirs.push(d);
  return d;
};
const withFile = (text) => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'config.toml'), text);
  return d;
};

test('settings: defaults without a file', () => {
  const c = loadConfig({ env: {}, dir: tmp() });
  assert.equal(c.exists, false);
  assert.equal(c.values['viewer.vi_mode'], false);
  assert.equal(c.values['viewer.layout'], 'auto');
  assert.equal(c.sources['viewer.layout'], 'default');
});

test('settings: a flag, then the environment, then the file, then the default', () => {
  const dir = withFile('[viewer]\nlayout = "unified"\nvi_mode = true\n\n[theme]\nbackground = "light"\n');
  let c = loadConfig({ env: {}, dir });
  assert.equal(c.values['viewer.layout'], 'unified');
  assert.equal(c.values['viewer.vi_mode'], true);
  assert.equal(c.sources['viewer.vi_mode'], path.join(dir, 'config.toml'));
  c = loadConfig({ env: { FR_BACKGROUND: 'dark', ATF_VI_MODE: '0' }, dir, flags: { layout: 'split' } });
  assert.equal(c.values['viewer.layout'], 'split');
  assert.equal(c.sources['viewer.layout'], 'flag');
  assert.equal(c.values['theme.background'], 'dark');
  assert.equal(c.values['viewer.vi_mode'], false); // $ATF_VI_MODE, as ATF's own setting
  assert.equal(c.sources['viewer.vi_mode'], '$ATF_VI_MODE');
  c = loadConfig({ env: { FR_VI_MODE: 'yes', ATF_VI_MODE: '0' }, dir });
  assert.equal(c.values['viewer.vi_mode'], true); // $FR_VI_MODE first
});

test("settings: the file's editor is fr's own choice and wins over $EDITOR", () => {
  assert.equal(loadConfig({ env: { EDITOR: 'nvim' }, dir: tmp() }).values['viewer.editor'], 'nvim');
  const dir = withFile('[viewer]\neditor = "code -w"\n');
  assert.equal(loadConfig({ env: { EDITOR: 'nvim', VISUAL: 'hx' }, dir }).values['viewer.editor'], 'code -w');
});

test('settings: wrong values and unknown keys are errors that say where', () => {
  assert.throws(() => loadConfig({ env: {}, dir: withFile('[viewer]\nlayout = "wide"\n') }), /config\.toml: viewer\.layout = "wide": use one of auto, split, unified/);
  assert.throws(() => loadConfig({ env: {}, dir: withFile('[viewer]\nvi = true\n') }), /unknown setting viewer\.vi/);
  assert.throws(() => loadConfig({ env: { FR_BACKGROUND: 'blue' }, dir: tmp() }), /\$FR_BACKGROUND: theme\.background = "blue"/);
  assert.throws(() => loadConfig({ env: {}, dir: tmp(), flags: { lens: 'files' } }), /--lens: viewer\.lens = "files"/);
});

test('fr config init: every setting, commented out; uncommented, it is valid', () => {
  const t = template();
  assert.deepEqual(parseToml(t), { viewer: {}, feedback: {}, agent: {}, theme: {} });
  const dir = withFile(t.replace(/^# (\w+ = .*)$/gm, '$1'));
  const c = loadConfig({ env: {}, dir });
  assert.equal(c.values['viewer.layout'], 'auto');
  assert.equal(c.sources['viewer.layout'], path.join(dir, 'config.toml'));
  const d2 = tmp();
  assert.equal(initConfig(d2).written, true);
  assert.equal(initConfig(d2).written, false); // an existing file is never overwritten
});

test("a feature's own settings: feature-review.toml, else the older feature-review.json", () => {
  const d = tmp();
  assert.deepEqual(readManifest(d), {});
  fs.writeFileSync(path.join(d, 'feature-review.json'), '{"base": "origin/release"}');
  assert.deepEqual(readManifest(d), { base: 'origin/release' });
  fs.writeFileSync(path.join(d, 'feature-review.toml'), '[base]\ngateway = "origin/x"\n');
  assert.deepEqual(readManifest(d), { base: { gateway: 'origin/x' } });
});
