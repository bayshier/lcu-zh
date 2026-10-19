// `lcu browser`: the private native-host copy, the relay launcher, refreshes and the status report (Linux layout).
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as browser from '../../lcu/browser.mjs';
import { REPO, output, override, posixTests, result, temporary, write } from './fixtures.mjs';

const test = posixTests('the relay launcher is an sh script with POSIX modes');

const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
// Stands in for the original plugin's installManifest.mjs: writes a manifest per browser under HOME.
const INSTALLER = `import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function install() {
  const plugin = dirname(dirname(fileURLToPath(import.meta.url)));
  const host = join(plugin, 'extension-host/linux/${ARCH}');
  writeFileSync(join(host, 'extension-host-config.json'), JSON.stringify({ nodePath: process.env.NODE_REPL_NODE_PATH }));
  for (const name of (process.env.FIXTURE_BROWSERS ?? 'google-chrome').split(',').filter((item) => item !== 'none')) {
    const directory = join(process.env.HOME, '.config', name, 'NativeMessagingHosts');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'com.openai.codexextension.json'), JSON.stringify({ name: 'com.openai.codexextension', path: join(host, 'extension-host') }));
  }
  if (process.env.FIXTURE_FAIL) { console.error(process.env.FIXTURE_FAIL); process.exit(3); }
}
`;

function fixture(t) {
  const base = temporary(t);
  const home = join(base, 'home');
  mkdirSync(home);
  const app = join(base, 'usr/lib/chatgpt');
  const resources = join(app, 'resources');
  const plugin = join(resources, 'plugins/openai-bundled/plugins/chrome');
  write(join(plugin, 'scripts/installManifest.mjs'), INSTALLER);
  write(join(plugin, `extension-host/linux/${ARCH}/extension-host`), '#!/bin/sh\n', 0o755);
  write(join(plugin, 'scripts/extension-ids.json'), JSON.stringify({ browserDiagnostics: [{ browserFamily: 'chrome', shortDisplayName: 'Chrome',
    extensionManagementUrl: 'chrome://extensions', storeUrl: 'https://store.example/chatgpt' }] }));
  const root = join(base, 'prefix/releases/release');
  mkdirSync(join(root, 'lcu'), { recursive: true });
  symlinkSync(app, join(root, 'app'));
  writeFileSync(join(root, 'lcu/native_host.mjs'), readFileSync(join(REPO, 'lcu/native_host.mjs')));
  writeFileSync(join(root, 'node-path'), `${process.execPath}\n`);
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    CHROME_CONFIG_HOME: process.env.CHROME_CONFIG_HOME };
  process.env.HOME = home;
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CHROME_CONFIG_HOME']) delete process.env[key];
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  override(t, browser.host, 'system', () => 'Linux');
  override(t, browser.host, 'euid', () => 1000);
  override(t, browser.host, 'paths', () => ({ app, resources }));
  override(t, browser.host, 'environment', (_root, _selected, env) => ({ ...env, NODE_REPL_NODE_PATH: process.execPath }));
  const manifest = (name = 'google-chrome') => join(home, '.config', name, 'NativeMessagingHosts/com.openai.codexextension.json');
  return { base, home, app, plugin, root, manifest, data: join(home, '.local/share/lcu/browser') };
}

test('install keeps a private plugin copy, a relay that runs the recorded Node, and points the manifests at it', async (t) => {
  const f = fixture(t);
  const destination = await browser.install(f.root);
  assert.equal(destination.startsWith(f.data), true);
  assert.equal(readFileSync(join(destination, '.lcu-browser-host'), 'utf8'), `${f.app}\n`);
  assert.equal(readFileSync(join(destination, '.lcu-browser-plugin'), 'utf8'), `${browser.pluginDigest(f.plugin)}\n`);
  assert.ok(readFileSync(join(destination, 'lcu-native-host.mjs')).equals(readFileSync(join(REPO, 'lcu/native_host.mjs'))));
  const relay = join(destination, 'lcu-native-host');
  const launcher = readFileSync(relay, 'utf8');
  assert.ok(browser.wrapperIsCurrent(launcher, join(destination, 'lcu-native-host.mjs')));
  assert.ok(launcher.includes(`node='${process.execPath}'`));
  assert.equal(lstatSync(relay).mode & 0o777, 0o700);
  assert.equal(JSON.parse(readFileSync(f.manifest(), 'utf8')).path, relay);
  assert.equal(lstatSync(f.manifest()).mode & 0o777, 0o644);
  // The relay launcher runs: a missing original host is reported by the relay on stderr, nothing on stdout.
  const run = process.getBuiltinModule('node:child_process').spawnSync(relay, [], { input: '', encoding: 'utf8' });
  assert.equal(run.stdout, '');
});

test('the launcher check accepts any recorded Node but only this script and this body', () => {
  const text = browser.posixWrapper("/it's/node", '/x/lcu-native-host.mjs');
  assert.ok(browser.wrapperIsCurrent(text, '/x/lcu-native-host.mjs'));
  assert.ok(!browser.wrapperIsCurrent(text, '/y/lcu-native-host.mjs'));
  assert.ok(!browser.wrapperIsCurrent(text.replace('exit 127', 'exit 1'), '/x/lcu-native-host.mjs'));
  assert.ok(!browser.wrapperIsCurrent('#!/bin/sh\nexec python3 x\n', '/x/lcu-native-host.mjs'));
});

test('an app upgraded in place refreshes the private plugin copy; another installation\'s directory is refused', async (t) => {
  const f = fixture(t);
  const destination = await browser.install(f.root);
  write(join(f.plugin, 'scripts/new.js'), 'new');
  await browser.install(f.root);
  assert.equal(readFileSync(join(destination, 'chrome/scripts/new.js'), 'utf8'), 'new');
  assert.equal(readFileSync(join(destination, '.lcu-browser-plugin'), 'utf8').trim(), browser.pluginDigest(f.plugin));
  const foreign = join(f.base, 'foreign');
  write(join(foreign, '.lcu-browser-host'), '/elsewhere\n');
  await assert.rejects(browser.install(f.root, foreign), /belongs to another installation/);
});

test('an installer failure surfaces its error; no manifest for the selected host fails', async (t) => {
  const f = fixture(t);
  process.env.FIXTURE_FAIL = 'original installer exploded';
  t.after(() => delete process.env.FIXTURE_FAIL);
  await assert.rejects(browser.install(f.root), /The original Chrome installer failed \(exit 3\)\. original installer exploded/);
  delete process.env.FIXTURE_FAIL;
  rmSync(join(f.home, '.config'), { recursive: true });
  process.env.FIXTURE_BROWSERS = 'none';
  t.after(() => delete process.env.FIXTURE_BROWSERS);
  await assert.rejects(browser.install(f.root), /produced no manifest for the selected host/);
});

test('plugin refresh recovers an interrupted swap and replaces a symlinked digest', (t) => {
  const f = fixture(t);
  const destination = join(f.base, 'host');
  mkdirSync(destination);
  browser.refreshPlugin(f.plugin, destination);
  renameSync(join(destination, 'chrome'), join(destination, '.chrome-previous'));
  browser.refreshPlugin(f.plugin, destination);
  assert.ok(existsSync(join(destination, 'chrome/scripts/installManifest.mjs')) && !existsSync(join(destination, '.chrome-previous')));
  const stamp = join(destination, '.lcu-browser-plugin');
  rmSync(stamp);
  const target = write(join(f.base, 'target'), 'keep');
  symlinkSync(target, stamp);
  browser.refreshPlugin(f.plugin, destination);
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  assert.ok(!lstatSync(stamp).isSymbolicLink());
  rmSync(join(destination, 'chrome'), { recursive: true });
  browser.refreshPlugin(f.plugin, destination);
  assert.ok(existsSync(join(destination, 'chrome/scripts/installManifest.mjs')));
});

test('refresh: absent when never set up, unchanged when current, changed after an update', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await browser.refresh(f.root), { status: 'absent', destination: null, displaced: [] });
  assert.equal(existsSync(f.data), false);
  const destination = await browser.install(f.root);
  assert.deepEqual(await browser.refresh(f.root), { status: 'unchanged', destination, displaced: [] });
  writeFileSync(join(destination, 'lcu-native-host'), '#!/bin/sh\n# an older launcher\n');
  assert.equal((await browser.refresh(f.root)).status, 'changed');
  assert.ok(browser.wrapperIsCurrent(readFileSync(join(destination, 'lcu-native-host'), 'utf8'), join(destination, 'lcu-native-host.mjs')));
  override(t, browser.host, 'euid', () => 0);
  assert.equal((await browser.refresh(f.root)).status, 'root');
});

test('refresh never registers other browsers, and leaves a manifest that points elsewhere alone', async (t) => {
  const f = fixture(t);
  await browser.install(f.root);
  process.env.FIXTURE_BROWSERS = 'google-chrome,chromium';
  t.after(() => delete process.env.FIXTURE_BROWSERS);
  assert.equal((await browser.refresh(f.root)).status, 'unchanged');
  assert.equal(existsSync(f.manifest('chromium')), false);
  const theirs = JSON.stringify({ path: '/opt/other/extension-host' });
  writeFileSync(f.manifest(), theirs);
  assert.equal((await browser.refresh(f.root)).status, 'elsewhere');
  assert.equal(readFileSync(f.manifest(), 'utf8'), theirs);
});

test('status reports the extension and the connector without claiming a live connection', async (t) => {
  const f = fixture(t);
  const destination = await browser.install(f.root);
  let extension = { enabled: true, installed: true, selectedProfileDirectory: 'Default' };
  override(t, browser.host, 'run', (command, args) => (args[0].endsWith('check-extension-installed.js')
    ? result(0, JSON.stringify(extension)) : result(0, JSON.stringify({ correct: true, manifestPath: f.manifest() }))));
  let seen = await output(t);
  assert.equal(await browser.status(f.root), true);
  assert.match(seen.out, /Chrome extension: enabled in Default\./);
  assert.match(seen.out, /Chrome connector: configured for this LCU installation\./);
  assert.match(seen.out, /Live browser connection: not checked/);
  writeFileSync(join(destination, 'lcu-native-host.mjs'), 'outdated');
  seen = await output(t);
  assert.equal(await browser.status(f.root), false);
  assert.match(seen.out, /connector: missing or outdated/);
  writeFileSync(f.manifest(), JSON.stringify({ path: '/opt/other/extension-host' }));
  seen = await output(t);
  await browser.status(f.root);
  assert.match(seen.out, /points to \/opt\/other\/extension-host, not this LCU installation's relay/);
  extension = { installed: true, enabled: false };
  seen = await output(t);
  await browser.status(f.root);
  assert.match(seen.out, /extension: disabled\. Enable it at chrome:\/\/extensions/);
  override(t, browser.host, 'run', () => result(1, 'not json', 'diagnostic broke'));
  seen = await output(t);
  await browser.status(f.root);
  assert.match(seen.out, /could not check\. diagnostic broke/);
});

test('removed and unknown subcommands are usage errors', async (t) => {
  const f = fixture(t);
  const seen = await output(t);
  assert.equal(await browser.main(f.root, ['serve']), 2);
  assert.match(seen.err, /were removed/);
  assert.equal(await browser.main(f.root, ['frob']), 2);
  assert.match(seen.err, /lcu browser: Unknown action 'frob'; use install or status\.\nRun 'lcu browser --help' for usage\./);
  assert.doesNotMatch(seen.err, /invalid choice|: error:|usage:/);
  assert.equal(await browser.main(f.root, []), 2);
  assert.equal(await browser.main(f.root, ['status', '--browser', 'firefox']), 2);
  assert.equal(await browser.main(f.root, ['install', '--help']), 0);
  assert.equal(await browser.main(f.root, ['status', '-h']), 0);
  assert.equal(await browser.main(f.root, ['install']), 0);
  assert.match(seen.out, /LCU browser native host configured/);
});
