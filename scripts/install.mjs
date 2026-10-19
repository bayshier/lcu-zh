// Install a versioned LCU release beside the locally installed ChatGPT app (Linux and macOS), and optionally
// register agents. scripts/install.sh runs this on the app's own Node. The app is never downloaded, copied or
// modified: the release links to it and records its Node in `<release>/node-path`.
import { spawnSync } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isMain, run } from '../lcu/entry.mjs';
import { isDirectory, isLink, isRegular, real, within } from '../lcu/fsutil.mjs';
import { installLockPath, withLock } from '../lcu/lock.mjs';
import { LINUX_APP_PATH, resolveInstalledLinuxApp, resolveInstalledMacApp } from '../lcu/platforms.mjs';
import {
  UsageError, appPrerequisiteMessage as prerequisite, installerEnvironment, main as setupMain, parse, regularPath, validate,
} from '../lcu/setup.mjs';
import { VERSION, architecture, verify } from './bundle.mjs';

export const SOURCE = dirname(dirname(fileURLToPath(import.meta.url)));
const MAC_APP_PATH = '/Applications/ChatGPT.app';

// Ubuntu 24.04 names for the official application's Depends, plus LCU's X11/audio/session prerequisites.
// See docs/INSTALLATION.md for source mappings.
export const SYSTEM_PACKAGES = [
  'at-spi2-core', 'bubblewrap', 'ca-certificates', 'dbus-x11', 'ffmpeg',
  'libasound2t64', 'libatk-bridge2.0-0t64', 'libatk1.0-0t64', 'libatspi2.0-0t64',
  'libc6', 'libcairo2', 'libcups2t64', 'libdbus-1-3', 'libdrm2', 'libexpat1',
  'libgbm1', 'libgcc-s1', 'libgdk-pixbuf-2.0-0', 'libgl1', 'libglib2.0-bin',
  'libglib2.0-0t64', 'libgtk-3-0t64', 'libnotify4', 'libnspr4', 'libnss3',
  'libpango-1.0-0', 'libssl3t64', 'libstdc++6', 'libtss2-esys-3.0.2-0t64',
  'libtss2-mu-4.0.1-0t64', 'libtss2-tcti-device0t64', 'libudev1', 'libusb-1.0-0',
  'libx11-6', 'libx11-xcb1', 'libxcb-dri3-0', 'libxcb1', 'libxcomposite1',
  'libxdamage1', 'libxext6', 'libxfixes3', 'libxi6', 'libxkbcommon0', 'libxrandr2',
  'libxtst6', 'mesa-vulkan-drivers', 'pulseaudio', 'pulseaudio-utils',
  'x11-utils', 'xdg-utils', 'xz-utils',
];

/** What tests replace: the source tree, module loading, child processes and the release check. */
export const deps = {
  source: SOURCE,
  module: (root, name) => import(pathToFileURL(join(root, 'lcu', `${name}.mjs`)).href),
  spawn: (command, args, options) => spawnSync(command, args, options),
  validateRelease: (release, account) => validateRelease(release, account),
  resolveMacApp: (app, options) => resolveInstalledMacApp(app, options),
};

const touch = (path) => closeSync(openSync(path, 'a'));
const expandHome = (path) => (path === '~' || path?.startsWith('~/') ? homedir() + path.slice(1) : path);

const appPrerequisiteMessage = (location) => prerequisite(location, { alternateLocation: true });

// Root drops to the account in a child Node, with its supplementary groups, before running `command`.
const DROP = 'const [uid, gid, name, ...command] = process.argv.slice(1); process.initgroups(name, +gid); ' +
  'process.setgid(+gid); process.setuid(+uid); process.execve(command[0], command, process.env);';

/** Run `command` as `account` (or as this process when null); throws unless it exits 0. */
export function runAs(command, owner, { quiet = false, env = {} } = {}) {
  let argv = command;
  const options = { stdio: ['ignore', quiet ? 'ignore' : 'inherit', 'inherit'], timeout: 20_000, env: { ...process.env, ...env } };
  if (owner) {
    Object.assign(options.env, { HOME: owner.home, USER: owner.name, LOGNAME: owner.name });
    options.cwd = owner.home;
    if (process.getuid() === 0 && owner.uid !== 0) {
      argv = [process.execPath, '-e', DROP, String(owner.uid), String(owner.gid), owner.name, ...command];
    } else if (process.getuid() !== owner.uid) {
      throw new Error(`Cannot validate the installation as ${owner.name} from this account`);
    }
  }
  const result = deps.spawn(argv[0], argv.slice(1), options);
  if (result.status !== 0) {
    const reason = result.error ? result.error.message : `exit status ${result.status ?? result.signal}`;
    throw new Error(`${command.join(' ')} failed: ${reason}`);
  }
}

/** A dedicated absolute prefix outside the release, empty or already LCU's, with no linked components. */
export function checkedPrefix(path, source = deps.source) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('The installation prefix must be absolute');
  const prefix = regularPath(path);
  if (within(real(prefix), real(source))) throw new Error('Choose an installation prefix outside the extracted release bundle.');
  if (prefix.split(sep).filter(Boolean).length < 2 || prefix === '/usr/local') {
    throw new Error('Choose a dedicated absolute prefix, such as /opt/lcu.');
  }
  const marker = join(prefix, '.lcu-install');
  if (existsSync(marker) && !isRegular(marker)) throw new Error(`Refusing a non-regular file at ${marker}`);
  if (isDirectory(prefix) && readdirSync(prefix).length && !isRegular(marker)) {
    throw new Error('Installation prefix is not an existing LCU installation or an empty directory.');
  }
  for (const name of ['.lcu-install', 'releases']) {
    if (isLink(join(prefix, name))) throw new Error(`Refusing a symlink at ${join(prefix, name)}`);
  }
  return prefix;
}

/** Validate the installed Linux app in place: `[app, descriptor, node]` with the observed version and runtime. */
export function selectLinuxApp(arch, { existingApp, owner, execute = true } = {}) {
  const location = expandHome(existingApp) ?? LINUX_APP_PATH;
  if (!isDirectory(location)) throw new Error(appPrerequisiteMessage(location));
  const selected = resolveInstalledLinuxApp(location, { arch, trustedUids: owner ? [owner.uid] : [] });
  const node = join(selected.runtime, 'bin/node');
  if (execute) {
    for (const command of [[node, '--version'], [join(selected.runtime, 'bin/node_repl'), '--help'], [selected.codexCli, '--version']]) {
      runAs(command, owner, { quiet: true });
    }
  }
  return [selected.app, { package_version: selected.version, runtime: selected.runtimeVersion, architecture: arch }, node];
}

/** The installed release runs: its launcher, the original REPL, and the original service for this platform. */
export function validateRelease(release, owner) {
  runAs([join(release, 'bin/lcu'), '--version'], owner);
  const target = JSON.parse(readFileSync(join(release, 'installation.json'), 'utf8')).platform ?? 'linux';
  const runtime = join(realpathSync(join(release, 'app')), target === 'darwin' ? 'Contents/Resources/cua_node' : 'resources/cua_node');
  runAs([join(runtime, 'bin/node_repl'), '--help'], owner, { quiet: true });
  runAs([join(runtime, 'bin/node'), '--input-type=module', '-e',
    'const s = await import(process.argv[1]); const r = await s.handleRpc({type:"setup"}); ' +
    'if (r.target !== process.argv[2]) throw Error("Wrong platform");',
  pathToFileURL(join(runtime, 'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js')).href,
  target === 'darwin' ? 'mac' : 'linux'], owner, { env: { NODE_REPL_DISABLE_ANALYTICS: '1' } });
}

/** Publish one validated thin release under `prefix` and point `current` at it; installed app files stay put. */
export function selectRelease(prefix, arch, app, descriptor, node, { owner, target = 'linux', source = deps.source } = {}) {
  // The lock installs, updates and `lcu prune` share for one prefix.
  return withLock(installLockPath(prefix), async () => {
    const releases = join(prefix, 'releases');
    mkdirSync(releases, { recursive: true });
    const release = join(releases, `${VERSION}-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`);
    mkdirSync(release, { mode: 0o755 });
    try {
      cpSync(source, release, { recursive: true, verbatimSymlinks: true });
      verify(release, arch, target);
      // The release links to the installed app; no app files are copied.
      symlinkSync(app, join(release, 'app'), 'dir');
      writeFileSync(join(release, 'installation.json'), `${JSON.stringify({ ...descriptor, app }, null, 2)}\n`);
      writeFileSync(join(release, 'node-path'), `${node}\n`);
      await deps.validateRelease(release, owner);
      const current = join(prefix, 'current');
      if (existsSync(current) && !isLink(current)) throw new Error('Refusing to replace a non-symlink current path');
      const next = join(prefix, '.next');
      if (existsSync(next) || isLink(next)) throw new Error('Unexpected .next path; inspect the installation before retrying');
      symlinkSync(relative(prefix, release), next);
      renameSync(next, current);
    } catch (error) {
      rmSync(release, { recursive: true, force: true });
      throw error;
    }
    return release;
  });
}

/** Linux: check the source and the app, then publish a release that links to it. */
function installLinux(prefixPath, { existingApp, owner } = {}) {
  const prefix = checkedPrefix(prefixPath);
  const arch = architecture();
  verify(deps.source, arch);
  const [app, descriptor, node] = selectLinuxApp(arch, { existingApp, owner });
  mkdirSync(prefix, { recursive: true });
  touch(join(prefix, '.lcu-install'));
  return selectRelease(prefix, arch, app, descriptor, node, { owner });
}

/** macOS: reuse the compatible signed app in place; it is never copied, modified or re-signed. */
export function installMac(prefixPath, appPath, { owner } = {}) {
  const prefix = checkedPrefix(prefixPath);
  const arch = architecture('darwin');
  verify(deps.source, arch, 'darwin');
  const policy = JSON.parse(readFileSync(join(deps.source, 'runtime.lock.json'), 'utf8')).platforms.darwin;
  if (!policy.architectures?.[arch]) throw new Error(`This LCU release does not support macOS ${arch}`);
  const location = expandHome(appPath);
  if (!isDirectory(location)) throw new Error(appPrerequisiteMessage(location));
  const selected = deps.resolveMacApp(location, { arch });
  // Validated before creating the prefix or changing the selected release.
  mkdirSync(prefix, { recursive: true });
  touch(join(prefix, '.lcu-install'));
  return selectRelease(prefix, arch, selected.app, {
    platform: 'darwin', architecture: arch, package_version: selected.version, runtime: selected.runtimeVersion,
  }, join(selected.runtime, 'bin/node'), { owner, target: 'darwin' });
}

// The installer's own options, beside every `lcu setup` option.
const OPTIONS = {
  'runtime-only': { type: 'boolean', default: false }, 'skip-system': { type: 'boolean', default: false },
  'app-package': { type: 'string' }, 'existing-app': { type: 'string' }, offline: { type: 'boolean', default: false },
};

// One help text for install.sh, which prints it when no app Node is found, and for this installer.
const USAGE = readFileSync(join(SOURCE, 'scripts/install-usage.txt'), 'utf8');

/** `lcu setup` arguments for the options given, in the order `lcu setup` documents them. */
function setupArguments(values, user) {
  const args = ['--prefix', values.prefix, ...(user ? ['--user', user] : []), '--scope', values.scope, '--session', values.session];
  for (const name of values.agent) args.push('--agent', name);
  for (const option of ['project', 'export']) if (values[option]) args.push(`--${option}`, values[option]);
  for (const flag of ['yes', 'check-desktop', 'chrome', 'audio', 'no-chrome', 'no-audio', 'allow-missing', 'unattended']) {
    if (values[flag]) args.push(`--${flag}`);
  }
  if (values.approval) args.push('--approval', values.approval);
  if (values['cross-turn']) args.push('--cross-turn', values['cross-turn']);
  return args;
}

const which = (name) => (process.env.PATH ?? '').split(delimiter).map((directory) => join(directory, name))
  .find((path) => { try { return statSync(path).isFile(); } catch { return false; } });

/** Run the installer with `argv`; returns the exit status. */
export async function main(argv) {
  const mac = process.platform === 'darwin';
  if (!mac && process.platform !== 'linux') throw new Error('LCU installation currently supports Linux and macOS.');
  // A first positional argument is the prefix, as in the earliest installers.
  const legacy = Boolean(argv[0] && !argv[0].startsWith('-'));
  if (legacy) argv = ['--prefix', ...argv];
  let values;
  try {
    values = parse(argv, OPTIONS);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    // A usage error, as with every LCU command: exit status 2.
    process.stderr.write(`LCU installer: ${error.message}\nRun 'scripts/install.sh --help' for usage.\n`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values['list-agents']) return setupMain(['--list-agents']);
  if (values['app-package'] !== undefined) {
    throw new Error(`--app-package cannot install an app for you. ${appPrerequisiteMessage()}`);
  }
  if (!mac && values.offline && !values['skip-system']) {
    throw new Error('--offline requires --skip-system; provision system libraries before an offline install');
  }
  if (legacy && !values.agent.length && !values.export) values['runtime-only'] = true;
  const existingApp = expandHome(values['existing-app']) ?? (mac ? MAC_APP_PATH : LINUX_APP_PATH);
  if (!mac && !isDirectory(existingApp)) throw new Error(appPrerequisiteMessage(existingApp));
  if (values.reconcile) {
    throw new Error('--reconcile runs after installation: use `lcu setup --reconcile` from the installed release.');
  }
  // Setup's own checks (account, scope, agents, export) run before anything is written.
  const { account: owner, names } = validate(values);
  if (mac && values.session !== 'direct') throw new Error('macOS uses --session direct; XFCE session discovery is Linux-only');
  const runtimeOnly = values['runtime-only'];
  if (runtimeOnly) {
    const setupOptions = ['export', 'project', 'check-desktop', 'chrome', 'audio', 'no-chrome', 'no-audio', 'approval', 'allow-missing',
      'cross-turn', 'unattended', ...(mac ? [] : ['browser-host'])];
    if (values.agent.length || values.scope !== 'user' || setupOptions.some((name) => values[name]) ||
        (!mac && values.session !== 'discover')) {
      throw new Error('--runtime-only cannot include agent setup options');
    }
  } else if (!names.length && !values.export && (values.yes || !process.stdin.isTTY)) {
    throw new Error(mac ? 'Select --agent NAME, --export PATH, or --runtime-only'
      : 'Select --agent NAME, --agent all, --agent auto, --export PATH, or --runtime-only');
  } else if (!values.export) {
    // Another account must never inherit the caller's profile overrides.
    installerEnvironment(owner.home, names, process.getuid() === 0 && owner.uid !== 0 ? {} : process.env);
  }
  const prefix = checkedPrefix(values.prefix);
  if (mac) {
    await installMac(prefix, existingApp, { owner });
  } else {
    // Refuse absent, corrupt or wrong-architecture payloads and apps before apt or any writes.
    const arch = architecture();
    verify(deps.source, arch);
    selectLinuxApp(arch, { existingApp, owner, execute: false });
    if (!values['skip-system']) {
      if (process.getuid() !== 0 || !which('apt-get')) {
        throw new Error('Automatic system provisioning requires root and apt-get; otherwise provision dependencies and use --skip-system');
      }
      for (const args of [['update'], ['install', '-y', ...SYSTEM_PACKAGES]]) {
        const result = deps.spawn('apt-get', args, { stdio: 'inherit' });
        if (result.status !== 0) throw new Error(`apt-get ${args[0]} failed (${result.error?.message ?? `exit status ${result.status}`})`);
      }
    }
    await installLinux(prefix, { existingApp, owner });
  }
  const current = join(prefix, 'current');
  const lcu = join(current, 'bin/lcu');
  process.stdout.write(`LCU installed: ${lcu}\n`);
  if (mac) process.stdout.write('The signed application is reused in place. Compatible updates are detected automatically.\n');
  if (runtimeOnly) {
    // Agent setup reports this itself, before applying anything.
    await (await deps.module(current, 'tested')).report(current);
    if (mac) {
      process.stdout.write('When you configure an agent interactively, LCU guides you through macOS privacy settings.\n' +
        `You can review the guidance now with: ${lcu} doctor\n`);
    }
    return 0;
  }
  // Setup runs from the selected release, and drops privileges itself before account writes.
  // --user only when given: without it, setup targets this account's $HOME, as validate() did above.
  const forwarded = setupArguments({ ...values, prefix }, values.user);
  let status;
  try {
    status = (await (await deps.module(current, 'setup')).main(forwarded)) ?? 0;
  } catch (error) {
    process.stderr.write(`LCU setup: ${error?.message ?? error}\n`);
    status = 1;
  }
  if (status) {
    process.stderr.write(`LCU runtime installed at ${lcu}, but setup failed; see the errors above. ` +
      `After resolving the errors, retry: ${lcu} setup ${forwarded.join(' ')}\n`);
  }
  return status;
}

if (isMain(import.meta)) run('LCU installer', () => main(process.argv.slice(2)));
