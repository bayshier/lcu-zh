// `lcu browser`: connect installed Chromium browsers through OpenAI's original native host.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import * as capture from './capture.mjs';
import { isDirectory, isFile, isLink, lstat, quoteAlways, real, within } from './fsutil.mjs';
import { environment, paths } from './runtime.mjs';
import { unshimmedEnv } from './sandbox_shim.mjs';
import { say, warn } from './terminal.mjs';

const MANIFEST_NAME = 'com.openai.codexextension.json';
const MACOS_NATIVE_HOST_DIRS = ['Google/Chrome', 'Chromium', 'Google/ChromeForTesting', 'Google/Chrome for Testing', 'Microsoft Edge',
  'BraveSoftware/Brave-Browser', 'com.operasoftware.Opera', 'Vivaldi'];
const PLUGIN_DIGEST = '.lcu-browser-plugin';
const MARKER = '.lcu-browser-host';
const RELAY_SCRIPT = 'lcu-native-host.mjs';
const HOST_BINARY = { Linux: 'extension-host', Darwin: 'ChatGPT for Chrome', Windows: 'extension-host.exe' };

/** The host this runs on and the selected release's runtime, replaceable in tests. */
export const host = {
  system: () => ({ linux: 'Linux', darwin: 'Darwin', win32: 'Windows' })[process.platform] ?? process.platform,
  arch: () => process.arch,
  euid: () => process.geteuid?.() ?? null,
  run: (command, args, options) => capture.run(command, args, options),
  paths: (root) => paths(root),
  environment: (root, selected, env) => environment(root, selected, { env }),
  /** The account home of `name`, for `sudo lcu update`. */
  home(name) {
    if (process.platform === 'darwin') {
      const result = spawnSync('/usr/bin/dscl', ['.', '-read', `/Users/${name}`, 'NFSHomeDirectory'], { encoding: 'utf8', timeout: 20_000 });
      const match = /^NFSHomeDirectory:\s*(\S.*)$/m.exec(result.status === 0 ? result.stdout : '');
      return match ? match[1].trim() : null;
    }
    const result = spawnSync('getent', ['passwd', name], { encoding: 'utf8', timeout: 20_000 });
    return result.status === 0 ? result.stdout.split(':')[5] ?? null : null;
  },
};

const readOrNull = (path) => { try { return readFileSync(path); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; } };
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Content identity of the upstream Chrome plugin directory (paths, modes, bytes, links). */
export function pluginDigest(plugin) {
  const digest = createHash('sha256');
  const names = readdirSync(plugin, { recursive: true }).map((name) => name.split(sep))
    .sort((a, b) => {
      for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
      return a.length - b.length;
    });
  for (const parts of names) {
    const path = join(plugin, ...parts);
    const name = parts.join('/');
    const info = lstatSync(path);
    if (info.isSymbolicLink()) digest.update(`L ${name} ${readlinkSync(path)}\0`);
    else if (info.isFile()) digest.update(`F ${name} ${info.mode & 0o111} ${sha256(readFileSync(path))}\0`);
    else if (info.isDirectory()) digest.update(`D ${name}\0`);
  }
  return digest.digest('hex');
}

const homeOf = (env, system) => (system === 'Windows' ? env.USERPROFILE || homedir() : env.HOME || homedir());

/** The per-user native-host manifest locations the original installer writes. */
function manifestPaths(env, system) {
  const home = homeOf(env, system);
  // macOS: the per-user destinations in the original plugin's installManifest.mjs; never system-wide ones.
  if (system === 'Darwin') return MACOS_NATIVE_HOST_DIRS.map((browser) => join(home, 'Library/Application Support', browser, 'NativeMessagingHosts', MANIFEST_NAME));
  // Windows: the original installer writes here and registers this exact path in the account's Chrome key.
  if (system === 'Windows') return [join(home, 'AppData/Local/OpenAI/extension', MANIFEST_NAME)];
  const roots = new Set([join(home, '.config'), ...['XDG_CONFIG_HOME', 'CHROME_CONFIG_HOME'].filter((key) => env[key]).map((key) => env[key])]);
  const found = new Set();
  const children = (directory) => { try { return readdirSync(directory).map((name) => join(directory, name)); } catch { return []; } };
  for (const root of roots) {
    for (const first of children(root)) {
      if (isFile(join(first, 'NativeMessagingHosts', MANIFEST_NAME)) || isLink(join(first, 'NativeMessagingHosts', MANIFEST_NAME))) found.add(join(first, 'NativeMessagingHosts', MANIFEST_NAME));
      for (const second of children(first)) {
        const path = join(second, 'NativeMessagingHosts', MANIFEST_NAME);
        if (isFile(path) || isLink(path)) found.add(path);
      }
    }
  }
  return [...found];
}

/** Where this account keeps LCU's private browser host copies. */
function dataRoot(system, env = process.env) {
  const home = homeOf(env, system);
  const data = system === 'Darwin' ? join(home, 'Library/Application Support')
    : system === 'Windows' ? env.LOCALAPPDATA || join(home, 'AppData/Local') : env.XDG_DATA_HOME || join(home, '.local/share');
  return join(data, 'lcu/browser');
}

/** `{system, destination, selectedApp}` of the private host copy `lcu browser install` keeps for `root`. */
function hostLocation(root, directory, env = process.env) {
  const system = host.system();
  if (!HOST_BINARY[system]) throw new Error('The original Chrome native host is supported on Linux, macOS, and Windows only.');
  // The upstream installer writes its host configuration beside the executable. Keep the sealed release
  // immutable; give this account a private host copy.
  const selectedApp = system === 'Windows' ? host.paths(root).app : real(join(root, 'app'));
  const destination = directory ? resolve(directory.replace(/^~(?=[\\/]|$)/, homedir()))
    : join(dataRoot(system, env), sha256(selectedApp).slice(0, 16));
  return { system, destination, selectedApp };
}

/** Run `fn` while holding the lock that serializes everything changing one private host copy. */
async function destinationLock(destination, fn) {
  const { withLock } = await import('./lock.mjs');
  mkdirSync(dirname(destination), { recursive: true });
  return withLock(join(dirname(destination), `.${basename(destination)}.lock`), fn);
}

/** Publish `data` at `path` through a staged file in `directory` with `mode`; a symlink at the name is replaced. */
function publish(directory, path, data, mode) {
  const staged = mkdtempSync(join(directory, '.lcu-native-host-'));
  try {
    writeFileSync(join(staged, 'file'), data);
    chmodSync(join(staged, 'file'), mode);
    renameSync(join(staged, 'file'), path);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

/**
 * Publish the private plugin copy for `source` and its digest; recover interrupted updates. Runs under the
 * destination lock. The new copy is staged completely first and moved into place by rename. An interruption
 * between the two renames leaves `chrome` missing and `.chrome-previous` present, which the next run restores.
 * The digest is written last, so a copy and digest that disagree only cause one more refresh.
 */
export function refreshPlugin(source, destination) {
  const plugin = join(destination, 'chrome');
  const retired = join(destination, '.chrome-previous');
  if (!lstat(plugin) && lstat(retired)) renameSync(retired, plugin);
  else if (lstat(plugin)) rmSync(retired, { recursive: true, force: true });
  for (const name of readdirSync(destination)) {
    // Scratch from an interrupted refresh.
    if (name.startsWith('.lcu-browser-') && ![MARKER, PLUGIN_DIGEST].includes(name)) rmSync(join(destination, name), { recursive: true, force: true });
  }
  const digest = pluginDigest(source);
  const stamp = join(destination, PLUGIN_DIGEST);
  const current = isDirectory(plugin) && !isLink(plugin) && isFile(join(plugin, 'scripts/installManifest.mjs')) &&
    isFile(stamp) && !isLink(stamp) && readFileSync(stamp, 'utf8').trim() === digest;
  if (current) return;
  const scratch = mkdtempSync(join(destination, '.lcu-browser-'));
  try {
    cpSync(source, join(scratch, 'chrome'), { recursive: true, verbatimSymlinks: true });
    if (isLink(plugin)) unlinkSync(plugin);
    else if (lstat(plugin)) renameSync(plugin, retired);
    renameSync(join(scratch, 'chrome'), plugin);
    rmSync(retired, { recursive: true, force: true });
    publish(destination, stamp, `${digest}\n`, 0o644);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The app's Node the installer recorded for this release (`node-path`), else the Node running LCU. */
function recordedNode(root) {
  try {
    const recorded = readFileSync(join(root, 'node-path'), 'utf8').split('\n')[0].trim();
    if (recorded) return recorded;
  } catch {
    // a source checkout
  }
  return process.execPath;
}

/** The launcher Chrome runs: the recorded Node on the copied relay. It prints nothing to stdout (Chrome's frames). */
export function posixWrapper(node, script) {
  return `#!/bin/sh
# Written by \`lcu browser install\`. Chrome starts native hosts with a minimal PATH.
node=${quoteAlways(node)}
if [ ! -x "$node" ]; then
  echo 'LCU Chrome native-host relay failed: the ChatGPT app'"'"'s Node is missing; repair the app, then run lcu browser install.' >&2
  exit 127
fi
exec "$node" ${quoteAlways(script)} "$@"
`;
}

/** True when `text` is exactly the launcher this release writes for `script`, whatever Node it names. */
export function wrapperIsCurrent(text, script) {
  const line = text.split('\n').find((item) => item.startsWith('node='));
  const quoted = /^node='((?:[^']|'"'"')*)'$/.exec(line ?? '');
  return Boolean(quoted) && text === posixWrapper(quoted[1].replaceAll("'\"'\"'", "'"), script);
}

/** Install the original native host for the current desktop account; resolves with the host directory. */
export async function install(root, directory) {
  const { system, destination, selectedApp } = hostLocation(root, directory);
  return destinationLock(destination, () => installLocked(root, system, destination, selectedApp));
}

function installLocked(root, system, destination, selectedApp, overrides = {}) {
  const marker = join(destination, MARKER);
  const expected = `${selectedApp}\n`;
  if (isLink(destination)) throw new Error('The browser host directory must not be a symlink.');
  if (lstat(destination) && (!isFile(marker) || isLink(marker) || readFileSync(marker, 'utf8') !== expected)) {
    throw new Error('The browser host directory belongs to another installation; select an empty directory.');
  }
  const selected = host.paths(root);
  const base = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete base[key];
    else base[key] = value;
  }
  // The persisted Codex path is the real executable, not the sandbox shim.
  const env = unshimmedEnv(host.environment(root, selected, base));
  const source = join(selected.resources, 'plugins/openai-bundled/plugins/chrome');
  if (!isFile(join(source, 'scripts/installManifest.mjs'))) throw new Error('The complete upstream Chrome plugin is missing from this bundle.');
  // The app can be upgraded in place at the same path, so the private copy follows the content of the selected
  // plugin, not only the app path.
  if (!lstat(destination)) {
    const scratch = mkdtempSync(join(dirname(destination), '.lcu-browser-'));
    try {
      cpSync(source, join(scratch, 'chrome'), { recursive: true, verbatimSymlinks: true });
      writeFileSync(join(scratch, MARKER), expected);
      writeFileSync(join(scratch, PLUGIN_DIGEST), `${pluginDigest(source)}\n`);
      renameSync(scratch, destination);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } else refreshPlugin(source, destination);
  const relaySource = join(root, 'lcu/native_host.mjs');
  if (!isFile(relaySource)) throw new Error('The LCU Chrome native-host relay is missing from this release.');
  const script = join(destination, RELAY_SCRIPT);
  publish(destination, script, readFileSync(relaySource), 0o700);
  rmSync(join(destination, 'lcu-native-host.py'), { force: true }); // the relay of releases before the Node port
  const node = recordedNode(root);
  let relay;
  if (system === 'Windows') {
    // Chromium uses cmd.exe for a non-.exe native host. The wrapper emits no text before the relay's frames.
    relay = join(destination, 'lcu-native-host.cmd');
    writeFileSync(relay, `@echo off\r\n"${node}" "%~dp0${RELAY_SCRIPT}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  } else {
    // Chrome starts native hosts with launchd's short PATH, so pin the app's Node.
    relay = join(destination, 'lcu-native-host');
    publish(destination, relay, posixWrapper(node, script), 0o700);
  }
  const installer = 'const {install} = await import(process.argv[1]); ' +
    'await install({appServerRuntimePaths:{codexCliPath:process.env.CODEX_CLI_PATH,' +
    'nodePath:process.env.NODE_REPL_NODE_PATH,nodeReplPath:process.env.CUA_REPL_NODE_REPL_PATH}});';
  const installed = host.run(env.NODE_REPL_NODE_PATH, ['--input-type=module', '-e', installer,
    pathToFileURL(join(destination, 'chrome/scripts/installManifest.mjs')).href], { env, timeout: 120_000 });
  if (installed.status !== 0) {
    const detail = (installed.stderr ?? '').trim().slice(-2000) || (installed.stdout ?? '').trim().slice(-2000) || installed.error?.message;
    throw new Error(`The original Chrome installer failed (exit ${installed.status ?? installed.signal}).${detail ? ` ${detail}` : ''}`);
  }
  // The pinned original installer returns no manifest list. Locate only its native-host manifest name at the
  // documented config depths, then require each candidate to point at this selected private copy before changing it.
  const manifests = manifestPaths(env, system);
  const hosts = real(join(destination, 'chrome/extension-host'));
  let changed = 0;
  for (const path of [...manifests].sort()) {
    if (isLink(path)) throw new Error(`Native-host manifest must be a regular file: ${path}`);
    if (!isFile(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const original = String(manifest.path ?? '');
    if (basename(original) !== HOST_BINARY[system] || !within(real(original), hosts)) continue;
    manifest.path = relay;
    publish(dirname(path), path, `${JSON.stringify(manifest, null, 2)}\n`, 0o644);
    changed += 1;
  }
  if (!changed) throw new Error('The original Chrome installer produced no manifest for the selected host.');
  if (system === 'Windows' && !windowsRegistered(manifests[0])) {
    throw new Error('The original Chrome installer did not register the selected manifest for this account.');
  }
  return destination;
}

/** The directory of the launcher a regular manifest file names, else null. */
function launcherDirectory(path) {
  try {
    if (isLink(path) || !isFile(path)) return null;
    return dirname(String(JSON.parse(readFileSync(path, 'utf8')).path ?? ''));
  } catch {
    return null;
  }
}

/** `[bytes, permission bits]` of `path`, or null when it does not exist. */
function fileState(path) {
  const data = readOrNull(path);
  return data === null ? null : [data, statSync(path).mode & 0o777];
}
const sameState = (left, right) => (left === null || right === null ? left === right : left[1] === right[1] && left[0].equals(right[0]));

/** Put back what `path` held before (nothing, when `saved` is null). */
function restore(path, saved) {
  if (isLink(path) || sameState(fileState(path), saved)) return;
  if (saved === null) rmSync(path, { force: true });
  else publish(dirname(path), path, saved[0], saved[1]);
}

/** The bytes Chrome and the extension depend on, to tell whether a refresh changed anything. */
function relaySnapshot(destination, system, manifests) {
  const configs = [];
  const hosts = join(destination, 'chrome/extension-host');
  for (const platform of isDirectory(hosts) ? readdirSync(hosts).sort() : []) {
    for (const arch of isDirectory(join(hosts, platform)) ? readdirSync(join(hosts, platform)).sort() : []) {
      const config = join(hosts, platform, arch, 'extension-host-config.json');
      if (lstat(config)) configs.push(config);
    }
  }
  const launcher = system === 'Windows' ? 'lcu-native-host.cmd' : 'lcu-native-host';
  return [launcher, RELAY_SCRIPT, PLUGIN_DIGEST].map((name) => join(destination, name)).concat(configs, [...manifests].sort())
    .map((path) => [path, fileState(path)]);
}
const sameSnapshot = (left, right) => left.length === right.length && left.every(([path, state], index) => path === right[index][0] && sameState(state, right[index][1]));

const normalCase = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);

/**
 * The app a relay directory's marker records when this installation made it, else null: the marker names the
 * selected app, or (Windows) a private app generation under this prefix, the Store app having changed since.
 */
function ownedMarker(directory, expectedApp, apps) {
  const marker = join(directory, MARKER);
  try {
    if (isLink(directory) || isLink(marker) || !isFile(marker)) return null;
    const recorded = readFileSync(marker, 'utf8');
    if (recorded === expectedApp || (apps && normalCase(recorded.trim()).startsWith(normalCase(apps) + sep))) return recorded;
  } catch {
    // not ours
  }
  return null;
}

/** `Map(directory -> recorded app)` of this installation's relays: those the manifests name and those under `root`. */
function ownedRelayDirectories(manifests, root, expectedApp, apps) {
  const directories = new Set(manifests.map(launcherDirectory).filter(Boolean));
  try {
    for (const name of readdirSync(root)) if (isDirectory(join(root, name))) directories.add(join(root, name));
  } catch {
    // none kept
  }
  const owned = new Map();
  for (const directory of directories) {
    const recorded = ownedMarker(directory, expectedApp, apps);
    if (recorded !== null) owned.set(directory, recorded);
  }
  return owned;
}

/** True when the account's Chrome native-host registration names `manifest`. */
function windowsRegistered(manifest) {
  const key = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.openai.codexextension';
  const registered = host.run('reg.exe', ['query', key, '/ve'], { timeout: 20_000 });
  if (registered.status !== 0) return false;
  // `reg query` prints `    <value name>    REG_SZ    <data>`; the name is localized, so match the type.
  const values = [...registered.stdout.matchAll(/REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/gm)].map((match) => match[1]);
  return values.some((value) => resolve(value).toLowerCase() === resolve(manifest).toLowerCase());
}

/**
 * Run the install with the original installer's manifests going to a scratch home, then publish ours. The
 * original installer writes a manifest for every browser; run against the real ones it would, for a moment or
 * after a failure, point other owners' (or never set up) browsers at LCU's host and could overwrite what another
 * installer wrote meanwhile. Only the manifests that already named this relay are replaced, once the whole
 * install path has succeeded.
 */
function refreshInScratch(root, system, destination, selectedApp, ours, env, saved) {
  const scratch = real(mkdtempSync(join(tmpdir(), 'lcu-browser-refresh-')));
  try {
    const roots = [[homeOf(env, system), join(scratch, 'home')]];
    const overrides = { HOME: join(scratch, 'home'), XDG_CONFIG_HOME: null, CHROME_CONFIG_HOME: null };
    for (const [key, name] of [['XDG_CONFIG_HOME', 'xdg'], ['CHROME_CONFIG_HOME', 'chrome']]) {
      if (env[key]) {
        roots.push([env[key], join(scratch, name)]);
        overrides[key] = join(scratch, name);
      }
    }
    roots.sort(([a], [b]) => b.split(sep).length - a.split(sep).length);
    mkdirSync(join(scratch, 'home'));
    installLocked(root, system, destination, selectedApp, overrides);
    const staged = new Map();
    for (const path of ours) {
      const pair = roots.find(([original]) => within(path, original));
      const twin = pair && join(pair[1], relative(pair[0], path));
      if (!twin || !isFile(twin)) throw new Error(`The original Chrome installer produced no manifest for ${path}.`);
      staged.set(path, readFileSync(twin));
    }
    // A manifest changed or removed meanwhile by someone else is theirs now.
    for (const [path, data] of staged) if (sameState(fileState(path), saved.get(path))) publish(dirname(path), path, data, 0o644);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Refresh the relay a previous `lcu browser install` made for this installation; never enables Chrome. Resolves
 * with `{status, destination, displaced}`. `status` is
 *   `absent`     no relay was installed for this installation, or its manifests were removed (nothing is touched),
 *   `elsewhere`  one is, but no native-host manifest (or Windows registry entry) points at it any more (nothing is touched),
 *   `root`       one is installed but this process runs as root (nothing is touched),
 *   `unchanged`  reinstalled; every relay file and manifest came out byte for byte the same,
 *   `changed`    reinstalled; the relay, its host configuration or its manifest differs, so Chrome must reconnect.
 * `displaced` lists Chrome manifests that point somewhere other than a relay of this installation and were left alone.
 */
export async function refresh(root) {
  const system = host.system();
  const absent = { status: 'absent', destination: null, displaced: [] };
  if (!HOST_BINARY[system]) return absent;
  let env = { ...process.env };
  const asRoot = host.euid() === 0;
  if (asRoot && env.SUDO_USER) {
    // `sudo lcu update` runs with root's home; look where the desktop account keeps its relay.
    const home = host.home(env.SUDO_USER);
    if (home) {
      for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CHROME_CONFIG_HOME']) delete env[key];
      env = { ...env, HOME: home };
    }
  }
  const existing = manifestPaths(env, system).filter((path) => isFile(path) || isLink(path)).sort();
  const markerBeside = (path) => {
    const directory = launcherDirectory(path);
    return directory !== null && isFile(join(directory, MARKER));
  };
  // Never set up: do not even resolve the app.
  if (!existing.some(markerBeside) && !isDirectory(dataRoot(system, env))) return absent;
  const { destination: fallback, selectedApp } = hostLocation(root, undefined, env);
  const expected = `${selectedApp}\n`;
  const prefix = dirname(dirname(real(root)));
  const owned = ownedRelayDirectories(existing, dataRoot(system, env), expected, system === 'Windows' ? join(prefix, 'apps') : null);
  if (!owned.size) return absent;
  const ours = existing.filter((path) => owned.has(launcherDirectory(path)));
  if (!ours.length) {
    if (!existing.length) return absent;
    // The ChatGPT app (or the user) took the manifest back. Re-pointing it is what the explicit `lcu browser
    // install` is for; an update must not take the connector from another owner.
    return { status: 'elsewhere', destination: fallback, displaced: [] };
  }
  // Reinstall where the relay is. A replaced app generation moves to the directory of the selected one.
  const active = new Set(ours.map(launcherDirectory));
  const current = [...active].filter((directory) => owned.get(directory) === expected).sort();
  const destination = active.has(fallback) ? fallback : current[0] ?? fallback;
  // The original installer would replace the registration; another owner holds it, so only report.
  if (system === 'Windows' && !windowsRegistered(ours[0])) return { status: 'elsewhere', destination: fallback, displaced: [] };
  // `sudo lcu update` must not write root-owned files into the desktop account's browser setup.
  if (asRoot) return { status: 'root', destination, displaced: [] };
  const displaced = existing.filter((path) => !ours.includes(path) && path.toLowerCase().includes('chrome'));
  return destinationLock(destination, () => {
    const before = relaySnapshot(destination, system, ours);
    const saved = new Map(ours.map((path) => [path, fileState(path)]));
    try {
      // Windows: one manifest, already ours, and the registry entry is checked above; the installer records the
      // manifest path in HKCU, so it has to write the real one.
      if (system === 'Windows') installLocked(root, system, destination, selectedApp);
      else refreshInScratch(root, system, destination, selectedApp, ours, env, saved);
    } catch (error) {
      if (system === 'Windows') {
        // Only the real manifest was written, and it may now name the original host instead of the relay. Put it
        // back only in that state; a later change by someone else stays theirs.
        for (const [path, state] of saved) {
          const directory = launcherDirectory(path);
          if (directory !== null && within(directory, join(destination, 'chrome/extension-host'))) restore(path, state);
        }
      }
      throw error;
    }
    const after = relaySnapshot(destination, system, ours);
    return { status: sameSnapshot(before, after) ? 'unchanged' : 'changed', destination, displaced };
  });
}

const reconnectStep = (browser) => `restart ${browser.shortDisplayName}, or turn the ChatGPT extension off and on at ` +
  `${browser.extensionManagementUrl}, so an already-connected extension reconnects through LCU's relay.`;

/** Report setup from the original diagnostics (not a connection test); resolves true when ready. */
export async function status(root, family = 'chrome') {
  const selected = host.paths(root);
  const env = host.environment(root, selected, process.env);
  const plugin = join(selected.resources, 'plugins/openai-bundled/plugins/chrome');
  const browser = JSON.parse(readFileSync(join(plugin, 'scripts/extension-ids.json'), 'utf8')).browserDiagnostics
    .find((item) => item.browserFamily === family);
  const check = (script) => {
    const result = host.run(env.NODE_REPL_NODE_PATH, [join(plugin, 'scripts', script), '--browser', family, '--json'], { env, timeout: 20_000 });
    try {
      const parsed = JSON.parse(result.stdout);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // reported below
    }
    if ((result.stderr ?? '').trim()) return { problem: result.stderr.trim() };
    const size = Buffer.byteLength(result.stdout ?? '');
    return { problem: size ? `The original diagnostic output could not be parsed (${size} bytes).` : 'The original diagnostic returned no result.' };
  };
  const extension = check('check-extension-installed.js');
  const manifest = check('check-native-host-manifest.js');
  const label = browser.shortDisplayName;
  const profile = extension.selectedProfileDirectory;
  const suffix = profile ? ` in ${profile}` : '';
  const enabled = extension.enabled === true;
  if (enabled) say(`${label} extension: enabled${suffix}.`);
  else if (extension.installed) say(`${label} extension: disabled${suffix}. Enable it at ${browser.extensionManagementUrl}.`);
  else if (extension.problem) {
    say(`${label} extension: could not check. ${extension.problem}`,
      `  Open ${label} once and install or enable the official extension: ${browser.storeUrl}`);
  } else {
    say(`${label} extension: not found${suffix}.`, `  Install the official extension in the profile you want to use: ${browser.storeUrl}`);
  }
  let connected = false;
  let foreign = null;
  if (manifest.correct && manifest.manifestPath) {
    try {
      const relay = String(JSON.parse(readFileSync(manifest.manifestPath, 'utf8')).path);
      const directory = dirname(relay);
      const system = host.system();
      const folder = { Darwin: 'macos', Linux: 'linux', Windows: 'windows' }[system];
      const binary = join(directory, 'chrome/extension-host', folder, host.arch(), HOST_BINARY[system]);
      const relayName = system === 'Windows' ? 'lcu-native-host.cmd' : 'lcu-native-host';
      const expectedApp = `${system === 'Windows' ? selected.app : real(join(root, 'app'))}\n`;
      let ownRelay = false;
      try {
        ownRelay = basename(relay) === relayName && readFileSync(join(directory, MARKER), 'utf8') === expectedApp;
      } catch {
        // not ours
      }
      if (!ownRelay) foreign = relay;
      const script = join(directory, RELAY_SCRIPT);
      let sourceMatches = readFileSync(script).equals(readFileSync(join(root, 'lcu/native_host.mjs')));
      // The launcher Chrome runs must be ours and must point at this script.
      if (system !== 'Windows') sourceMatches &&= wrapperIsCurrent(readFileSync(relay, 'utf8'), script);
      const executable = (path) => { try { accessSync(path, constants.X_OK); return isFile(path); } catch { return false; } };
      connected = basename(relay) === relayName && executable(relay) && sourceMatches && ownRelay &&
        readFileSync(join(directory, PLUGIN_DIGEST), 'utf8').trim() === pluginDigest(plugin) && executable(binary);
    } catch {
      // not connected
    }
  }
  if (connected) say(`${label} connector: configured for this LCU installation.`);
  else if (foreign) {
    say(`${label} connector: the native-host manifest points to ${foreign}, not this LCU installation's relay. ` +
      `Run \`lcu browser install\`, then ${reconnectStep(browser)}`);
  } else say(`${label} connector: missing or outdated. Run \`lcu browser install\`.`);
  say(`Live browser connection: not checked. After setup, ${reconnectStep(browser)} Then ask your agent to use LCU to list ${label} tabs.`);
  return enabled && connected;
}

const USAGE = 'Usage: lcu browser {install [--directory DIR] | status [--browser chrome|edge]}';

/** `lcu browser ARGV`; returns the exit status. */
export async function main(root, argv) {
  const [action, ...rest] = argv;
  if (action === 'serve' || action === 'protocol') {
    warn('lcu browser: the in-app browser host and codex:// protocol commands were removed; use the ' +
      'installed app browser. For external Chrome, run `lcu browser install` and enable the official ChatGPT extension.');
    return 2;
  }
  if (action === '-h' || action === '--help' || (['install', 'status'].includes(action) && rest.some((arg) => arg === '-h' || arg === '--help'))) {
    say(USAGE, '', 'Connect installed Chromium browsers using OpenAI\'s original native host.', '',
      '  install [--directory DIR]           Install the original native host for the current desktop account',
      '  status [--browser chrome|edge]      Check extension and connector setup without changing the browser');
    return 0;
  }
  let values;
  try {
    if (!['install', 'status'].includes(action)) {
      throw new Error(action === undefined ? 'Name an action: install or status.' : `Unknown action '${action}'; use install or status.`);
    }
    const options = action === 'install' ? { directory: { type: 'string' } } : { browser: { type: 'string', default: 'chrome' } };
    ({ values } = parseArgs({ args: rest, options }));
    if (action === 'status' && !['chrome', 'edge'].includes(values.browser)) {
      throw new Error(`Unknown browser '${values.browser}'; use chrome or edge.`);
    }
  } catch (error) {
    warn(`lcu browser: ${error.message}`, "Run 'lcu browser --help' for usage.");
    return 2;
  }
  if (action === 'status') return (await status(root, values.browser)) ? 0 : 1;
  const destination = await install(root, values.directory && !isAbsolute(values.directory) ? resolve(values.directory) : values.directory);
  say(`LCU browser native host configured: ${destination}`,
    'Install or enable the official ChatGPT browser extension in the browser you want to use.',
    'The extension and browser must run under this same desktop account. See docs/INSTALLATION.md.',
    'If the extension was already connected, restart the browser or turn the extension off and on in its extensions page so it reconnects through LCU\'s relay.',
    'Check extension and connector setup with: lcu browser status');
  return 0;
}
