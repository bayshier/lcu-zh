// Validate an official Windows Store package and its intact private copy.
// Builtins come from process.getBuiltinModule: an ESM import of a builtin builds its export facade, which
// costs milliseconds on every launch; child_process, crypto and tty are loaded only where they are used.
const { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync} = process.getBuiltinModule('node:fs');
const { dirname, join, relative, sep } = process.getBuiltinModule('node:path');
const createHash = (algorithm) => process.getBuiltinModule('node:crypto').createHash(algorithm);
import { cacheDirectory, checkOnce, recorded, writeRecord } from './check_record.mjs';
import { isDirectory, isFile, within } from './fsutil.mjs';
import { tryAcquire } from './lock.mjs';

export const PACKAGE_NAME = 'OpenAI.Codex';
export const PACKAGE_PUBLISHER = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B';
const NODE_MODULES = 'app/resources/cua_node/bin/node_modules';
export const WINDOWS_REQUIRED_FILES = [
  'app/ChatGPT.exe',
  'app/resources/app.asar',
  'app/resources/cua_node/bin/node.exe',
  'app/resources/cua_node/bin/node_repl.exe',
  'app/resources/cua_node/manifest.json',
  `${NODE_MODULES}/@oai/cua-repl/bin/cua-repl.mjs`,
  `${NODE_MODULES}/@oai/sky/bin/windows/codex-computer-use.exe`,
  `${NODE_MODULES}/@oai/sky/bin/windows/swift/x64/codex-computer-use-swift.exe`,
  `${NODE_MODULES}/@oai/sky/dist/project/cua/sky_js/src/service.js`,
  `${NODE_MODULES}/@oai/sky/dist/project/cua/sky_js/src/targets/windows/internal/helper_transport.js`,
  `${NODE_MODULES}/@oai/sky/dist/project/cua/sky_js/src/targets/windows/internal/computer_use_client.js`,
  'app/resources/codex.exe',
  'app/resources/codex-code-mode-host.exe',
  'app/resources/plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json',
  'app/resources/plugins/openai-bundled/plugins/chrome/extension-host/windows/x64/extension-host.exe',
  'app/resources/plugins/openai-bundled/plugins/unified-computer-use/.mcp.json',
];


/** A symbolic link or (on Windows, where Node reports them as links) a junction. */
export function isRedirected(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function sha256File(path) {
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (let count; (count = readSync(fd, buffer, 0, buffer.length, null));) digest.update(buffer.subarray(0, count));
  } finally {
    closeSync(fd);
  }
  return digest.digest('hex');
}

/**
 * Walk the package tree: `{inventory, stamps}`. The inventory hashes every file when `hash` is set (else it has
 * the directories only); the stamps are each entry's `[path, type, size, mtime (ns), file id, volume]` as
 * `lstat` reports them, root first. A link, junction or other unsupported file is refused either way.
 */
function scanTree(app, hash) {
  const stamp = (key, info) => [key, info.isDirectory() ? 'directory' : 'file', `${info.size}`, `${info.mtimeNs}`, `${info.ino}`, `${info.dev}`];
  const root = lstatSync(app, { bigint: true });
  if (!root.isDirectory()) throw new Error(`Windows application directory is missing or redirected: ${app}`);
  const inventory = { '.': { type: 'directory' } };
  const stamps = [stamp('.', root)];
  const walk = (parent) => {
    let names;
    try {
      names = readdirSync(parent).sort();
    } catch {
      throw new Error(`Windows application tree cannot be read: ${parent}`);
    }
    for (const name of names) {
      const path = join(parent, name);
      const key = relative(app, path).split(sep).join('/');
      const info = lstatSync(path, { bigint: true });
      if (info.isSymbolicLink()) throw new Error(`Windows application contains a redirected path: ${path}`);
      if (info.isDirectory()) {
        inventory[key] = { type: 'directory' };
        stamps.push(stamp(key, info));
        walk(path);
      } else if (info.isFile()) {
        if (hash) inventory[key] = { type: 'file', sha256: sha256File(path) };
        stamps.push(stamp(key, info));
      } else {
        throw new Error(`Windows application contains an unsupported file: ${path}`);
      }
    }
  };
  walk(app);
  return { inventory, stamps };
}

/** Hash the selected Store package tree for managed-copy integrity checks. */
export const applicationInventory = (app) => scanTree(app, true).inventory;

/** The tree's per-entry stamps (scanTree), read with `lstat` only. */
export const applicationStamps = (app) => scanTree(app, false).stamps;

/**
 * Where LCU remembers, per account, the stamps of each private copy whose full inventory matched, so that a
 * launch hashes the copy only when a stamp, the expected inventory, version or runtime changed. A launch waits at
 * most `wait` milliseconds for another process that is validating, then validates itself. `lock` returns a
 * function that releases it, or null while another process holds it. Tests replace all three.
 */
export const inventoryRecord = {
  path: () => join(cacheDirectory(), 'windows-inventory.json'),
  wait: 30_000,
  lock: (path) => tryAcquire(path),
};

/** Canonical JSON (sorted keys, no spaces, non-ASCII escaped), as recorded digests of earlier releases were computed. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export const inventorySha256 = (inventory) => createHash('sha256').update(canonicalJson(inventory)).digest('hex');

/** `{name, publisher, version, architecture}` from the package's AppxManifest.xml Identity element. */
function appxIdentity(app) {
  if (isRedirected(app) || !isDirectory(app)) throw new Error('Windows package application directory is missing or redirected.');
  const manifest = join(app, 'AppxManifest.xml');
  if (isRedirected(manifest) || !isFile(manifest)) throw new Error('Windows package identity manifest is missing or redirected.');
  const text = readFileSync(manifest, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const element = /<(?:[\w.-]+:)?Identity(\s[^>]*?)?\/?>/.exec(text);
  if (!element) throw new Error('Windows package identity is missing.');
  const attributes = {};
  for (const [, name, double, single] of (element[1] ?? '').matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[name] = (double ?? single).replace(/&(quot|apos|lt|gt|amp);/g, (_, entity) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[entity]);
  }
  const { Name: name, Publisher: publisher, Version: version, ProcessorArchitecture: architecture } = attributes;
  if (name !== PACKAGE_NAME || publisher !== PACKAGE_PUBLISHER || !/^\d+\.\d+\.\d+\.\d+$/.test(version ?? '') ||
      !['x64', 'X64'].includes(architecture)) {
    throw new Error('Windows package identity, version, or architecture is invalid.');
  }
  return { name, publisher, version, architecture: 'x64' };
}

/** The current account's registered OpenAI.Codex package, from Get-AppxPackage. */
export function registeredPackage() {
  // Get-AppxPackage only sees packages registered for this account. Use its InstallLocation rather than
  // guessing the WindowsApps package volume.
  const command = "$ErrorActionPreference='Stop'; $packages=@(Get-AppxPackage -Name 'OpenAI.Codex'); " +
    "$packages | Select-Object Name,Publisher,@{Name='Version';Expression={$_.Version.ToString()}}," +
    "@{Name='Architecture';Expression={$_.Architecture.ToString()}}," +
    "@{Name='SignatureKind';Expression={$_.SignatureKind.ToString()}},InstallLocation | ConvertTo-Json -Compress";
  const result = process.getBuiltinModule('node:child_process').spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) {
    throw new Error(`The Windows package query failed: ${`${result.stderr || result.error?.message || ''}`.trim().slice(0, 300)}`);
  }
  if (!result.stdout.trim()) throw new Error('Install the official ChatGPT MSIX for this Windows account first.');
  const parsed = JSON.parse(result.stdout);
  const packages = Array.isArray(parsed) ? parsed : [parsed];
  if (packages.length !== 1 || !packages[0] || typeof packages[0] !== 'object') {
    throw new Error('Expected exactly one registered OpenAI.Codex package for this account.');
  }
  if (['Version', 'Architecture', 'SignatureKind'].some((key) => typeof packages[0][key] !== 'string')) {
    throw new Error('Windows package query did not return string version, architecture and signature kind.');
  }
  return packages[0];
}

/** A package file; MSIX stores `@` as `%40` in its archive, so either spelling is accepted, but no other fallback. */
export function component(app, relativePath) {
  const expected = join(app, relativePath);
  if (isFile(expected)) return expected;
  const encoded = join(app, relativePath.replace('@oai/', '%40oai/'));
  return isFile(encoded) ? encoded : expected;
}

function validateHost() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The Windows application can only be validated on Windows x64.');
  }
}

function runtimeManifest(app) {
  const path = component(app, 'app/resources/cua_node/manifest.json');
  if (isRedirected(path) || !isFile(path)) throw new Error('Windows CUA runtime manifest is missing or redirected.');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Windows CUA runtime manifest is invalid.');
  }
  const version = manifest?.runtime_archive_version;
  if (manifest?.platform !== 'windows' || manifest?.arch !== 'x64' || typeof version !== 'string' || !version.trim()) {
    throw new Error('Windows CUA runtime manifest has an unsupported platform or architecture.');
  }
  return version;
}

/** Select and structurally validate the current user's official Store app. */
export function resolveInstalledWindowsApp() {
  validateHost();
  const registered = registeredPackage();
  if (registered.Name !== PACKAGE_NAME || registered.Publisher !== PACKAGE_PUBLISHER ||
      !['x64', 'amd64'].includes(registered.Architecture.toLowerCase()) || registered.SignatureKind !== 'Store') {
    throw new Error('Registered ChatGPT package is not the official Windows x64 Store app.');
  }
  const app = registered.InstallLocation;
  if (typeof app !== 'string' || !app) throw new Error('Registered ChatGPT package has no install location.');
  const { version } = appxIdentity(app);
  if (registered.Version !== version) throw new Error('Registered ChatGPT package version does not match its identity manifest.');
  // Capture the registered source's exact tree as the baseline for its managed copy. The validator
  // recomputes it before returning the selection.
  return validateWindowsAppTree(app, { expectedVersion: version, expectedRuntime: runtimeManifest(app),
    expectedInventory: applicationInventory(app), recordInventory: false });
}

/**
 * Validate host layout and exact equality with a source-derived inventory. Identity, required files, runtime and
 * the tree walk (links, junctions, unsupported files) are checked on every call. The inventory is hashed in full
 * unless `reuseRecordedInventory` is set (launches) and this account recorded a match of the same stamps,
 * inventory, version and runtime (inventoryRecord). A full match is recorded unless `recordInventory` is false
 * (the registered source, which LCU never launches), and only when no stamp changed during it.
 */
export function validateWindowsAppTree(appPath, { expectedVersion, expectedRuntime, expectedInventory, reuseRecordedInventory = false,
  recordInventory = true }) {
  validateHost();
  if (!expectedVersion || !expectedRuntime || !expectedInventory || typeof expectedInventory !== 'object') {
    throw new Error('A selected Windows version, runtime and source inventory are required.');
  }
  if (isRedirected(appPath) || !isDirectory(appPath)) throw new Error('Windows application directory is missing or redirected.');
  const app = realpathSync(appPath);
  if (appxIdentity(app).version !== expectedVersion) throw new Error('Windows application identity version changed after selection.');
  for (const relativePath of WINDOWS_REQUIRED_FILES) {
    const file = component(app, relativePath);
    let redirected = isRedirected(file);
    for (let parent = dirname(file); !redirected && parent !== app && within(parent, app); parent = dirname(parent)) {
      redirected = isRedirected(parent);
    }
    let resolved = '';
    try {
      resolved = realpathSync(file);
    } catch {
      // missing
    }
    if (!isFile(file) || redirected || !within(resolved, app)) {
      throw new Error(`Required Windows application file is missing or outside the app: ${relativePath}`);
    }
  }
  const runtimeVersion = runtimeManifest(app);
  if (runtimeVersion !== expectedRuntime) throw new Error('Windows CUA runtime changed after selection.');
  const inventoryDigest = inventorySha256(expectedInventory);
  const compare = () => {
    const { inventory: actual, stamps } = scanTree(app, true);
    if (canonicalJson(actual) !== canonicalJson(expectedInventory)) {
      const first = [...new Set([...Object.keys(actual), ...Object.keys(expectedInventory)])].sort()
        .find((key) => canonicalJson(actual[key] ?? null) !== canonicalJson(expectedInventory[key] ?? null)) ?? '<tree>';
      throw new Error(`Windows application differs from selected source inventory: ${first}`);
    }
    return stamps;
  };
  if (!recordInventory) {
    compare();
  } else {
    const entry = (stamps) => JSON.stringify({ version: expectedVersion, runtime: runtimeVersion, inventory: inventoryDigest, stamps });
    let current;
    let waited = false;
    checkOnce(inventoryRecord, {
      hit: (path) => {
        if (!reuseRecordedInventory) return false;
        const initial = !waited;
        waited = true;
        if (!recorded(path, app, entry(current ??= applicationStamps(app)))) return false;
        if (initial) return true;
        // A record another launch wrote while this one waited: the tree may have changed during the wait.
        current = applicationStamps(app);
        return recorded(path, app, entry(current));
      },
      check: (path) => {
        const stamps = compare();
        if (path !== null && JSON.stringify(applicationStamps(app)) === JSON.stringify(stamps)) {
          // Entries of generations that are gone (pruned) are dropped.
          writeRecord(path, app, entry(stamps), isDirectory);
        }
      },
    });
  }
  return { app, resources: join(app, 'app/resources'), runtime: join(app, 'app/resources/cua_node'),
    launcher: component(app, `${NODE_MODULES}/@oai/cua-repl/bin/cua-repl.mjs`), backend: 'windows',
    version: expectedVersion, arch: 'x64', runtimeVersion, inventory: expectedInventory,
    inventoryDigest };
}
