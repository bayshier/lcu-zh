// Validate an installed official application for the original CUA runtime.
// Builtins come from process.getBuiltinModule: an ESM import of a builtin builds its export facade, which
// costs milliseconds on every launch; child_process, crypto and tty are loaded only where they are used.
const { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } = process.getBuiltinModule('node:fs');
const os = process.getBuiltinModule('node:os');
const { basename, dirname, join, relative, resolve } = process.getBuiltinModule('node:path');
const childProcess = () => process.getBuiltinModule('node:child_process');

import { locateCodexTools } from './app_layout.mjs';
import { readAsarMembers } from './asar.mjs';
import { cacheDirectory, checkOnce, recorded, writeRecord } from './check_record.mjs';
import { isDirectory, isLink, isRegular, within } from './fsutil.mjs';
import { tryAcquire } from './lock.mjs';

const MAC_BUNDLE_ID = 'com.openai.codex';
const MAC_HELPER_ID = 'com.openai.sky.CUAService';
const OPENAI_TEAM_ID = '2DC432GLL2';
export const MAC_HELPER = 'Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app';
export const MAC_REQUIRED_FILES = [
  'Resources/cua_node/bin/node',
  'Resources/cua_node/bin/node_repl',
  'Resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs',
  'Resources/plugins/openai-bundled/plugins/unified-computer-use/.mcp.json',
  'Resources/plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json',
];
const MAC_EXECUTABLES = new Set(MAC_REQUIRED_FILES.slice(0, 2));

// The signed helper binds its socket here (or at the path in this variable) and refuses a path
// longer than the AF_UNIX sun_path limit. LCU cannot change that in the helper; it can only detect it.
export const MAC_SOCKET_ENV = 'SKY_CUA_SERVICE_NATIVE_PIPE_PATH';
export const MAC_SOCKET_SUFFIX = `Library/Group Containers/${OPENAI_TEAM_ID}.${MAC_HELPER_ID}/IPC/computeruse.sock`;
const MAC_SOCKET_MAX_BYTES = 103;

/** `{path, overridden}`: the helper's socket path; the override wins, else the account's real home (not $HOME). */
export function macSocketPath(env = process.env) {
  const override = env[MAC_SOCKET_ENV];
  if (override) return { path: override, overridden: true };
  return { path: join(os.userInfo().homedir, MAC_SOCKET_SUFFIX), overridden: false };
}

/** A message when the helper's socket path is too long to bind, else null. */
export function macSocketPathProblem(env = process.env) {
  const { path, overridden } = macSocketPath(env);
  const size = Buffer.byteLength(path);
  if (size <= MAC_SOCKET_MAX_BYTES) return null;
  const source = overridden ? `The path comes from ${MAC_SOCKET_ENV}.`
    : 'The path comes from your home folder, so the ChatGPT app is affected too.';
  return `Computer Use cannot start for this macOS account: the ChatGPT helper's socket path is ${size} bytes ` +
    `(macOS limit ${MAC_SOCKET_MAX_BYTES}): ${path}. ${source} LCU cannot change the signed helper. Use an account ` +
    'whose home folder path is short enough (13 ASCII characters or fewer after /Users/).';
}

const executable = (path) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };

/** Top-level string values of an XML or binary property list. */
export function plistStrings(data) {
  if (data.subarray(0, 8).toString('latin1') === 'bplist00') return binaryPlistStrings(data);
  // XML: track nesting so only direct children of the top-level dict (<plist><dict>) count.
  const result = {};
  let depth = 0;
  let key = null;
  let text = '';
  for (const [, close, name, empty, content] of data.toString('utf8').matchAll(/<([/]?)([A-Za-z]+)[^>]*?([/]?)>|([^<]+)/g)) {
    if (content !== undefined) {
      text += content;
      continue;
    }
    if (!close && !empty) {
      depth += 1;
      text = '';
      continue;
    }
    if ((empty ? depth + 1 : depth) === 3) {
      if (name === 'key') key = unescapeXml(text);
      else {
        if (name === 'string' && key !== null) result[key] = empty ? '' : unescapeXml(text);
        key = null;
      }
    }
    if (!empty) depth -= 1;
    text = '';
  }
  return result;
}

const unescapeXml = (text) => text.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#\d+);/gi, (_, name) => (
  { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[name.toLowerCase()] ??
  String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10))));

function binaryPlistStrings(data) {
  const trailer = data.subarray(data.length - 32);
  const offsetSize = trailer[6];
  const refSize = trailer[7];
  const count = Number(trailer.readBigUInt64BE(8));
  const top = Number(trailer.readBigUInt64BE(16));
  const table = Number(trailer.readBigUInt64BE(24));
  const uint = (at, size) => data.readUIntBE(at, size);
  const offset = (index) => {
    if (index >= count) throw new Error('Application bundle metadata is not a property list');
    return uint(table + index * offsetSize, offsetSize);
  };
  const length = (at) => {
    const low = data[at] & 0x0f;
    if (low !== 0x0f) return [low, at + 1];
    const size = 1 << (data[at + 1] & 0x0f);
    return [uint(at + 2, size), at + 2 + size];
  };
  const string = (index) => {
    const at = offset(index);
    const kind = data[at] >> 4;
    const [size, start] = length(at);
    if (kind === 0x5) return data.toString('latin1', start, start + size);
    if (kind === 0x6) return Buffer.from(data.subarray(start, start + 2 * size)).swap16().toString('utf16le');
    return undefined;
  };
  const at = offset(top);
  if (data[at] >> 4 !== 0xd) throw new Error('Application bundle metadata is not a property list');
  const [entries, start] = length(at);
  const result = {};
  for (let i = 0; i < entries; i += 1) {
    const key = string(uint(start + i * refSize, refSize));
    const value = string(uint(start + (entries + i) * refSize, refSize));
    if (typeof key === 'string' && typeof value === 'string') result[key] = value;
  }
  return result;
}

function bundleIdentity(bundle, identifier) {
  const info = join(bundle, 'Contents/Info.plist');
  if (!isRegular(info)) throw new Error(`Application bundle metadata is missing: ${info}`);
  const details = plistStrings(readFileSync(info));
  if (details.CFBundleIdentifier !== identifier) throw new Error(`Unexpected application bundle identifier: ${bundle}`);
  return details;
}

/**
 * Where LCU remembers each bundle `codesign --verify --deep --strict` accepted, so that a launch skips that check
 * (over a second for the app, and several when launches run at once) until the bundle changes. A per-account
 * cache: losing it costs one deep check. A launch waits at most `wait` milliseconds for another process that is
 * checking the same app, then checks it itself. `lock` returns a function that releases it, or null while another
 * process holds it. Tests replace all three.
 */
export const sealRecord = {
  path: () => join(cacheDirectory(), 'macos-signatures.json'),
  wait: 15_000,
  lock: (path) => tryAcquire(path),
};

/**
 * One signed build of `bundle`: its identifier, version and build, its Info.plist file, and the hash of its
 * sealed-resource manifest. An app update changes these; null when they cannot be read.
 */
function sealKey(bundle, details) {
  try {
    const info = statSync(join(bundle, 'Contents/Info.plist'));
    const seal = readFileSync(join(bundle, 'Contents/_CodeSignature/CodeResources'));
    return JSON.stringify({ identifier: details.CFBundleIdentifier, version: details.CFBundleShortVersionString ?? null,
      build: details.CFBundleVersion ?? null, info: [info.ino, info.size, info.mtimeMs],
      seal: process.getBuiltinModule('node:crypto').createHash('sha256').update(seal).digest('hex') });
  } catch {
    return null;
  }
}

/** The bundle's sealKey as it is now, its Info.plist read again; null when it cannot be read. */
function currentKey(bundle) {
  try {
    return sealKey(bundle, plistStrings(readFileSync(join(bundle, 'Contents/Info.plist'))));
  } catch {
    return null;
  }
}

function deepVerify(bundle) {
  const verified = childProcess().spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle],
    { encoding: 'utf8', timeout: 120_000 });
  if (verified.status !== 0) {
    const detail = `${verified.stderr || verified.stdout || verified.error?.message || ''}`.trim().replaceAll('\n', ' ').slice(0, 300);
    throw new Error(`Installed application signature verification failed: ${bundle}: ${detail}`);
  }
}

/**
 * Verify the bundle's seal with `codesign --verify --deep --strict`, unless `reuse` is set and this account
 * recorded a successful check of the same build (sealKey). Concurrent launches share one check through a lock
 * beside the record. Only a successful check whose key did not change meanwhile is recorded.
 */
function verifySeal(bundle, details, reuse) {
  const key = sealKey(bundle, details);
  if (key === null) {
    deepVerify(bundle);
    return;
  }
  let waited = false;
  checkOnce(sealRecord, {
    hit: (path) => {
      if (!reuse) return false;
      const initial = !waited;
      waited = true;
      if (!recorded(path, bundle, key)) return false;
      // A record another launch wrote while this one waited: the bundle may have changed during the wait.
      return initial || currentKey(bundle) === key;
    },
    check: (path) => {
      deepVerify(bundle);
      if (path !== null && sealKey(bundle, details) === key) writeRecord(path, bundle, key);
    },
  });
}

/**
 * The installed app and signed helper are checked in place; LCU never copies or modifies them. The signer's
 * identity and team are read on every call.
 */
function verifySignature(bundle, identifier, details, reuse) {
  verifySeal(bundle, details, reuse);
  const identity = childProcess().spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', bundle],
    { encoding: 'utf8', timeout: 30_000 });
  const lines = `${identity.stderr ?? ''}`.split('\n');
  if (identity.status !== 0 || !lines.includes(`Identifier=${identifier}`) ||
      !lines.includes(`TeamIdentifier=${OPENAI_TEAM_ID}`)) {
    throw new Error(`Installed application signer does not match OpenAI: ${bundle}`);
  }
}

function runtimeManifest(path, platform, arch, message) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const version = manifest?.runtime_archive_version;
  if (manifest?.platform !== platform || manifest?.arch !== arch || typeof version !== 'string' || !version.trim()) {
    throw new Error(message);
  }
  return version;
}

/**
 * Validate a local ChatGPT.app without relocating or modifying signed files. Each signature is checked at most
 * once; with `reuseRecordedSeal` (launches), the deep check is skipped for a build this account already verified,
 * while installs, updates, `lcu doctor` and the other commands check in full. Returns
 * `{app, resources, runtime, backend, version, arch, codexCli, codeModeHost, runtimeVersion}`.
 */
export function resolveInstalledMacApp(appPath, { arch, reuseRecordedSeal = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('The macOS application can only be validated on macOS');
  if (isLink(appPath) || !isDirectory(appPath) || basename(appPath) !== 'ChatGPT.app') {
    throw new Error(`Expected a local ChatGPT.app directory: ${appPath}`);
  }
  const app = realpathSync(appPath);
  const architecture = arch || { arm64: 'arm64', x64: 'x64' }[process.arch];
  if (!['arm64', 'x64'].includes(architecture)) throw new Error(`Unsupported macOS architecture: ${architecture}`);
  const contents = join(app, 'Contents');
  const resources = join(contents, 'Resources');
  const runtime = join(resources, 'cua_node');
  const appDetails = bundleIdentity(app, MAC_BUNDLE_ID);
  const version = appDetails.CFBundleShortVersionString;
  if (typeof version !== 'string' || !version.trim()) throw new Error(`Installed application version is missing: ${app}`);
  const helper = join(contents, MAC_HELPER);
  const helperDetails = bundleIdentity(helper, MAC_HELPER_ID);
  const manifest = join(runtime, 'manifest.json');
  if (!isRegular(manifest)) throw new Error('Installed application CUA manifest is missing');
  const runtimeVersion = runtimeManifest(manifest, 'darwin', architecture,
    'Installed application CUA runtime has an incompatible platform or architecture');
  for (const relativePath of MAC_REQUIRED_FILES) {
    const file = join(contents, relativePath);
    if (!isRegular(file)) throw new Error(`Required application file is missing or invalid: ${relativePath}`);
    if (MAC_EXECUTABLES.has(relativePath) && !executable(file)) {
      throw new Error(`Installed application executable is not executable: ${relativePath}`);
    }
  }
  const tools = locateCodexTools(resources);
  for (const file of [tools.cli, tools.codeModeHost]) {
    if (!executable(file)) throw new Error(`Installed application executable is not executable: ${relative(contents, file)}`);
  }
  verifySignature(app, MAC_BUNDLE_ID, appDetails, reuseRecordedSeal);
  verifySignature(helper, MAC_HELPER_ID, helperDetails, reuseRecordedSeal);
  return { app, resources, runtime, backend: 'mac', version, arch: architecture,
    codexCli: tools.cli, codeModeHost: tools.codeModeHost, runtimeVersion };
}

export const LINUX_APP_PATH = '/usr/lib/chatgpt';
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+:~_-]*$/;
const VERSION_UNKNOWN = 'Cannot determine the selected app version from app.asar or its dpkg-owned path';

/** The selected app's version from app.asar, or from the dpkg package that owns its exact path. */
function linuxVersion(app, arch) {
  try {
    const { version } = JSON.parse(readAsarMembers(join(app, 'resources/app.asar'), ['package.json'])['package.json']);
    if (typeof version === 'string' && VERSION.test(version)) return version;
  } catch {
    // fall back to the package database
  }
  const program = join(app, 'ChatGPT');
  const query = (args) => {
    const result = childProcess().spawnSync('dpkg-query', args, { encoding: 'utf8', timeout: 20_000 });
    if (result.status !== 0) throw new Error(VERSION_UNKNOWN);
    return result.stdout;
  };
  const owners = query(['-S', '--', program]).split('\n').flatMap((line) => {
    const at = line.indexOf(': ');
    return at > 0 && resolve(line.slice(at + 2)) === program && line.slice(0, at).split(':')[0] === 'chatgpt'
      ? [line.slice(0, at)] : [];
  });
  if (owners.length !== 1) throw new Error('No unique chatgpt package owns the selected executable path');
  const fields = query(['-W', '--showformat=%v %a', owners[0]]).split(/\s+/).filter(Boolean);
  if (fields.length !== 2 || fields[1] !== (arch === 'arm64' ? 'arm64' : 'amd64')) {
    throw new Error('The selected dpkg-owned ChatGPT path has the wrong architecture');
  }
  if (VERSION.test(fields[0])) return fields[0];
  throw new Error(VERSION_UNKNOWN);
}

/** Every uid holding `gid` as primary or supplementary group (the account databases getent reads), or null when unknown. */
export function groupMembers(gid) {
    const run = (...args) => childProcess().spawnSync('getent', args, { encoding: 'utf8', timeout: 20_000 });
    const group = run('group', String(gid));
    const passwd = run('passwd');
    if (passwd.status !== 0 || ![0, 2].includes(group.status)) return null;
    const users = passwd.stdout.split('\n').map((line) => line.split(':')).filter((fields) => fields.length >= 4);
    const names = new Set((group.stdout.split('\n')[0].split(':')[3] ?? '').split(',').filter(Boolean));
    return new Set(users.filter(([name, , , primary]) => names.has(name) || Number(primary) === gid)
      .map(([, , uid]) => Number(uid)));
}

/**
 * The POSIX access ACL of each path: its named entries `{tag, id, perm}` (one getfacl run), `[]` when it has
 * none, or null when it has one LCU cannot read. Without getfacl, `ls -ld` shows whether an ACL exists (the `+`
 * after the mode; `.` is an SELinux context); an entry without one has no named entries and is safe.
 */
export function readAcls(paths) {
  const run = (command, args) => childProcess().spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  const result = run('getfacl', ['--absolute-names', '--numeric', '--skip-base', '--access', '--', ...paths]);
  if (result.error?.code === 'ENOENT') {
    return new Map(paths.map((path) => {
      const listed = run('ls', ['-ld', '--', path]);
      return [path, listed.status === 0 && /^\S{10}[.\s]/.test(listed.stdout) ? [] : null];
    }));
  }
  const acls = new Map(paths.map((path) => [path, result.status === 0 ? [] : null]));
  if (result.status !== 0) return acls;
  let entries;
  for (const line of result.stdout.split('\n')) {
    const file = /^# file: (.*)$/.exec(line);
    if (file) {
      entries = [];
      acls.set(file[1].replace(/\\(\\|[0-7]{3})/g, (_, code) => (code === '\\' ? '\\' : String.fromCharCode(parseInt(code, 8)))), entries);
      continue;
    }
    const entry = /^(user|group|mask)::?(\d*):([rwx-]{3})/.exec(line);
    if (entries && entry) entries.push({ tag: entry[1], id: entry[2] === '' ? null : Number(entry[2]), perm: entry[3] });
  }
  return acls;
}

/** Why named-user or named-group ACL entries let an untrusted account write, or null. Only the mask-limited write counts. */
export function aclWritersUntrusted(entries, trusted, groupMembers) {
  const mask = entries.find((entry) => entry.tag === 'mask');
  if (mask && mask.perm[1] !== 'w') return null;
  for (const { tag, id, perm } of entries) {
    if (id === null || perm[1] !== 'w') continue;
    if (tag === 'user' && !trusted.has(id)) return `writable by uid ${id} through a POSIX ACL`;
    if (tag === 'group') {
      const members = groupMembers(id);
      if (!members || [...members].some((uid) => !trusted.has(uid))) return `writable by group ${id} through a POSIX ACL`;
    }
  }
  return null;
}

/**
 * Why this entry lets another account change what the desktop account executes, null when it does not,
 * or `'acl'` when only a POSIX ACL could still allow it. A symlink's own mode is meaningless; only its owner
 * counts. Group write is accepted only when every account in that group is trusted. On Linux the group mode
 * bits of an entry with an extended ACL are its mask, so a named ACL entry can only grant write when group
 * write is set: only such entries need their ACL read.
 */
export function untrustedEntry(info, trusted, groupMembers) {
  if (!trusted.has(info.uid)) return `owned by uid ${info.uid}`;
  if (info.isSymbolicLink()) return null;
  const stickyDirectory = info.isDirectory() && info.mode & 0o1000;
  if (stickyDirectory || !(info.mode & 0o022)) return null;
  // A sticky directory (like /tmp) only lets accounts add entries; they cannot replace ones owned by someone else.
  if (info.mode & 0o002) return 'writable by group or other accounts';
  const members = groupMembers(info.gid);
  if (!members || [...members].some((uid) => !trusted.has(uid))) return 'writable by group or other accounts';
  return 'acl';
}

/**
 * Refuse a tree where accounts other than root and the desktop account could replace code: the executables
 * the runtime launches and every directory above them up to `/`, plus the complete trees the desktop account
 * executes from. Symlinks may only point inside the app; each target and its ancestors are validated, and a
 * linked directory is walked once. Read-only mounts are checked like any other. Limits: group membership
 * comes from the account databases getent reads, and ACLs are read with getfacl.
 */
function checkTrustedTree(app, files, trees, trusted, { groupMembers: lookup, readAcls: aclsOf }) {
  const problems = [];
  const aclCandidates = [];
  const groups = new Map();
  const members = (gid) => {
    if (!groups.has(gid)) groups.set(gid, lookup(gid));
    return groups.get(gid);
  };
  const inspected = new Map();
  const walked = new Set();
  const pending = [];

  const check = (path, walk = false) => {
    if (!inspected.has(path)) {
      let info = null;
      try {
        info = lstatSync(path);
        const reason = untrustedEntry(info, trusted, members);
        if (reason === 'acl') aclCandidates.push(path);
        else if (reason) problems.push(`${path} is ${reason}`);
      } catch (error) {
        problems.push(`${path} cannot be inspected (${error.code ?? error.message})`);
      }
      inspected.set(path, info);
    }
    const info = inspected.get(path);
    if (!info) return;
    if (info.isSymbolicLink()) {
      if (walked.has(path)) return;
      walked.add(path);
      let real;
      try {
        real = realpathSync(path);
      } catch {
        problems.push(`${path} is a broken or looping link`);
        return;
      }
      if (!within(real, app)) problems.push(`${path} links outside the application (${real})`);
      else pending.push(real); // the target is validated and, if a directory, walked
    } else if (walk && info.isDirectory() && !walked.has(path)) {
      walked.add(path);
      try {
        for (const name of readdirSync(path)) pending.push(join(path, name));
      } catch (error) {
        problems.push(`${path} cannot be read (${error.code ?? error.message})`);
      }
    }
  };
  const ancestors = (path) => {
    for (let current = path; ; current = dirname(current)) {
      check(current);
      if (current === dirname(current)) break;
    }
  };

  for (const path of files) {
    const real = realpathSync(path);
    if (!within(real, app)) {
      problems.push(`${path} resolves outside the application (${real})`);
      continue;
    }
    // Links on the unresolved path count too.
    for (let current = dirname(path); within(current, app); current = dirname(current)) check(current);
    check(path);
    ancestors(real);
  }
  for (const tree of trees) {
    const real = realpathSync(tree);
    if (!within(real, app)) {
      problems.push(`${tree} resolves outside the application (${real})`);
      continue;
    }
    ancestors(real);
    pending.push(real);
  }
  while (pending.length) {
    const path = pending.pop();
    check(path, true);
    if (!inspected.get(path)?.isSymbolicLink()) ancestors(path);
  }
  if (aclCandidates.length) {
    const acls = aclsOf(aclCandidates);
    for (const path of aclCandidates) {
      const entries = acls.get(path);
      if (entries === null) problems.push(`${path} is group-writable and its POSIX ACL cannot be read (install getfacl, or remove group write)`);
      else if (entries) {
        const reason = aclWritersUntrusted(entries, trusted, members);
        if (reason) problems.push(`${path} is ${reason}`);
      }
    }
  }
  if (problems.length) {
    const shown = problems.slice(0, 3).join('; ') + (problems.length > 3 ? `; and ${problems.length - 3} more` : '');
    throw new Error(`The application is not in a location only root and this account can change: ${shown}. ` +
      'Install the app with a package manager or make it root-owned and not writable by other accounts');
  }
}

/**
 * Validate an installed ChatGPT Linux app in place, without copying or modifying it. `accounts` supplies the
 * group-membership and ACL lookups (`{groupMembers, readAcls}`).
 */
export function resolveInstalledLinuxApp(appPath, { arch, trustedUids = [], accounts = { groupMembers, readAcls } }) {
  if (!isDirectory(appPath)) throw new Error(`Expected an installed ChatGPT application directory: ${appPath}`);
  const app = realpathSync(appPath);
  const resources = join(app, 'resources');
  const runtime = join(resources, 'cua_node');
  const manifest = join(runtime, 'manifest.json');
  if (!isRegular(manifest)) throw new Error(`Application runtime manifest is missing: ${manifest}`);
  const runtimeVersion = runtimeManifest(manifest, 'linux', arch,
    'Application runtime manifest has an unsupported platform, architecture, or version');
  const tools = locateCodexTools(resources);
  const plugins = join(resources, 'plugins/openai-bundled/plugins');
  const extensionHost = join(plugins, `chrome/extension-host/linux/${arch}/extension-host`);
  const programs = [join(app, 'ChatGPT'), join(runtime, 'bin/node'), join(runtime, 'bin/node_repl'),
    tools.cli, tools.codeModeHost, extensionHost];
  const required = [...programs, join(runtime, 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs'),
    join(resources, 'app.asar'), join(plugins, 'chrome/.codex-plugin/plugin.json'),
    join(plugins, 'unified-computer-use/.mcp.json')];
  const missing = required.filter((path) => !isRegular(path));
  const browserPlugin = join(plugins, 'browser');
  if (isLink(browserPlugin) || !isDirectory(browserPlugin)) missing.push(browserPlugin);
  if (missing.length) throw new Error(`Application payload is incomplete: ${missing.join(', ')}`);
  for (const path of programs) {
    if (!executable(path)) throw new Error(`Application executable is not executable: ${path}`);
  }
  const trusted = new Set([0, process.getuid(), process.geteuid(), ...trustedUids]);
  const modules = join(runtime, 'lib/node_modules');
  checkTrustedTree(app, [...required, ...(existsSync(modules) ? [modules] : [])],
    [runtime, join(plugins, 'chrome'), browserPlugin, join(plugins, 'unified-computer-use')], trusted, accounts);
  return { app, resources, runtime, backend: 'linux', version: linuxVersion(app, arch), arch,
    codexCli: tools.cli, codeModeHost: tools.codeModeHost, runtimeVersion };
}

