// Install thin LCU beside the current account's official Windows Store app. scripts/install.ps1 runs this on
// the app's own node.exe after checking the registered package. The registered MSIX stays intact; its
// protected WindowsApps directory does not permit direct execution, so LCU runs an unchanged private copy
// (`<prefix>\apps\<inventory digest>\app`) whose source-derived inventory it records and checks.
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { isMain, run } from '../lcu/entry.mjs';
import { acquire, installLockPath } from '../lcu/lock.mjs';
import { ALIASES, CLIENTS } from '../lcu/setup.mjs';
import { canonicalJson, component, inventorySha256, isRedirected, resolveInstalledWindowsApp, validateWindowsAppTree } from '../lcu/windows.mjs';
import { materializeOriginalHost, planOriginalHost } from '../lcu/windows_host.mjs';
import { VERSION, architecture, verify } from './bundle.mjs';

const NODE_MEMBER = 'app/resources/cua_node/bin/node.exe';
const AGENTS = [...Object.keys(CLIENTS), ...Object.keys(ALIASES)];

/** What tests replace. */
export const deps = {
  source: dirname(dirname(fileURLToPath(import.meta.url))),
  resolveInstalledWindowsApp, validateWindowsAppTree, planOriginalHost, materializeOriginalHost,
  verify, architecture, isRedirected,
  paths: async (release) => (await import('../lcu/runtime.mjs')).paths(release),
  setup: (release) => import(pathToFileURL(join(release, 'lcu/setup.mjs')).href),
  write: (path, data) => atomicWrite(path, data),
  rename: (from, to) => renameSync(from, to),
  platform: () => process.platform,
};

const redirected = (path) => deps.isRedirected(path);
const isUnlinkedDirectory = (path) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
const newId = (length) => crypto.randomUUID().replaceAll('-', '').slice(0, length);

/** Copy a directory tree, refusing any link or junction in it (Node's fs adds the long-path prefix itself). */
function copyTree(from, to) {
  mkdirSync(to);
  for (const name of readdirSync(from)) {
    const [source, target] = [join(from, name), join(to, name)];
    const info = lstatSync(source);
    if (info.isSymbolicLink()) throw new Error(`Windows application contains a redirected path: ${source}`);
    if (info.isDirectory()) copyTree(source, target);
    else copyFileSync(source, target);
  }
}

function validatedCopy(app, selected) {
  return deps.validateWindowsAppTree(app, { expectedVersion: selected.version, expectedRuntime: selected.runtimeVersion,
    expectedInventory: selected.inventory });
}

/** True when any release under the prefix records this app generation (or a record cannot be read). */
export function generationInUse(prefix, generation) {
  const releases = join(prefix, 'releases');
  if (!isUnlinkedDirectory(releases)) return false;
  for (const name of readdirSync(releases)) {
    const descriptor = join(releases, name, 'installation.json');
    if (!existsSync(descriptor)) continue;
    try {
      const recorded = JSON.parse(readFileSync(descriptor, 'utf8')).app;
      if (typeof recorded !== 'string') return true;
      if (resolve(dirname(recorded)) === resolve(generation)) return true;
    } catch {
      return true; // an unreadable or malformed record may use the generation
    }
  }
  return false;
}

/**
 * Check the selected app's native-pipe host layout read-only, before anything is copied. The structural
 * analyzer runs on a temporary copy of the app's own node.exe; the selected app itself is only read.
 */
export function preflightHost(selected) {
  const node = component(selected.app, NODE_MEMBER);
  if (redirected(node) || !existsSync(node)) {
    throw new Error('The selected ChatGPT app has no usable app/resources/cua_node/bin/node.exe.');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'lcu-host-check-'));
  try {
    const staged = join(scratch, 'node.exe');
    copyFileSync(node, staged);
    deps.planOriginalHost(selected.app, { node: staged });
  } catch (error) {
    if (error?.message?.startsWith('Required Windows host layout')) {
      throw new Error(`${error.message} (observed ChatGPT app ${selected.version}, runtime ${selected.runtimeVersion}; nothing was installed)`);
    }
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function atomicWrite(path, data) {
  if (redirected(path)) throw new Error(`Refusing a redirected Windows launcher file: ${path}`);
  const temporary = join(dirname(path), `.${path.split(/[\\/]/).at(-1)}-${newId(32)}.tmp`);
  try {
    writeFileSync(temporary, data);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * `<prefix>\lcu.cmd`. cmd.exe reads a running batch file by byte offset, so when an update rewrites the lcu.cmd
 * that started it (LCU 0.9.7's `lcu update`), cmd resumes in the new file at the old file's offset. The first line
 * jumps over a line of colons at least as long as the old file: resuming anywhere in it reads a label, which does
 * nothing, and the next line exits with the status of the command that was running.
 */
export function launcherCommand(node, previousLength = 0) {
  return `@echo off & goto run\r\n${':'.repeat(Math.max(previousLength, 512))}\r\nexit /b %ERRORLEVEL%\r\n` +
    `:run\r\n"${node}" "%~dp0windows_launcher.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`;
}

/** A dedicated absolute directory with no linked component, outside the archive, empty or already LCU's. */
export function checkedPrefix(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.split(/[\\/]/).includes('..') ||
      1 + relative(parse(resolve(path)).root, resolve(path)).split(/[\\/]/).filter(Boolean).length < 3) {
    throw new Error('Choose a dedicated absolute Windows installation directory.');
  }
  for (let item = resolve(path); ; item = dirname(item)) {
    if (redirected(item)) throw new Error(`Refusing a linked Windows installation path: ${item}`);
    if (item === dirname(item)) break;
  }
  const prefix = resolve(path);
  const source = realpathSync(deps.source);
  if (prefix === source || source.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep)) {
    throw new Error('Install outside the extracted release archive.');
  }
  if (isUnlinkedDirectory(prefix) && readdirSync(prefix).length && !existsSync(join(prefix, '.lcu-install'))) {
    throw new Error('Installation directory is occupied by another application.');
  }
  if (redirected(join(prefix, '.lcu-install'))) throw new Error('Refusing a redirected Windows installation marker.');
  return prefix;
}

/** Select, check, copy and publish; returns the new release directory. */
export async function install(prefixPath) {
  if (deps.platform() !== 'win32') throw new Error('The Windows installer must run in Windows 11 x64.');
  const arch = deps.architecture('windows');
  deps.verify(deps.source, arch, 'windows');
  const prefix = checkedPrefix(prefixPath);
  const lock = JSON.parse(readFileSync(join(deps.source, 'runtime.lock.json'), 'utf8')).platforms.windows;
  if (!lock.architectures?.x64) throw new Error('This LCU archive does not include the Windows x64 runtime.');
  process.stderr.write('LCU: Verifying the registered official Windows application...\n');
  let selected;
  try {
    selected = deps.resolveInstalledWindowsApp();
  } catch (error) {
    if (error.message === 'Install the official ChatGPT MSIX for this Windows account first.') {
      throw new Error('LCU requires the official ChatGPT desktop app, which includes Codex, to be installed first. ' +
        'LCU does not download or install the app. Install it from https://chatgpt.com/download/ and rerun LCU. ' +
        'The app must be installed for the currently signed-in account.');
    }
    throw error;
  }
  const inventory = { ...selected.inventory };
  const digest = inventorySha256(inventory);
  if (digest !== selected.inventoryDigest) throw new Error('Selected Windows application inventory changed after validation.');
  // Fail on an unrecognised host layout before the 2 GB copy or any prefix write.
  process.stderr.write('LCU: Checking the original Windows native host layout...\n');
  preflightHost(selected);
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, '.lcu-install'), '', { flag: 'a' });
  // One install at a time per prefix: a generation another run creates or reuses is never removed by this one.
  const lockPath = installLockPath(prefix);
  if (redirected(lockPath)) throw new Error(`Refusing a redirected Windows install lock: ${lockPath}`);
  const release = await acquire(lockPath, { wait: 0, busy: () => new Error('Another LCU install is already running for this ' +
    'prefix; wait for it to finish and run this install again.') });
  try {
    return await publish(prefix, arch, selected, inventory, digest);
  } finally {
    release();
  }
}

async function publish(prefix, arch, selected, inventory, digest) {
  const apps = join(prefix, 'apps');
  if (redirected(apps)) throw new Error(`Refusing a redirected Windows app generation directory: ${apps}`);
  mkdirSync(apps, { recursive: true });
  const generation = join(apps, digest);
  if (redirected(generation)) throw new Error(`Refusing a redirected Windows app generation: ${generation}`);
  let createdGeneration = false;
  if (existsSync(generation)) {
    const inventoryPath = join(generation, 'inventory.json');
    if (redirected(inventoryPath) || !existsSync(inventoryPath)) throw new Error('Managed Windows application inventory is missing or redirected.');
    let recorded;
    try {
      recorded = JSON.parse(readFileSync(inventoryPath, 'utf8'));
    } catch {
      throw new Error('Managed Windows application inventory is missing or invalid.');
    }
    if (inventorySha256(recorded) !== digest) throw new Error('Managed Windows application inventory differs from the selected Store app.');
    validatedCopy(join(generation, 'app'), selected);
  } else {
    const stage = join(apps, `.${newId(8)}`);
    try {
      mkdirSync(stage);
      if (redirected(selected.app) || !isUnlinkedDirectory(selected.app)) {
        throw new Error(`Windows application directory is missing or redirected: ${selected.app}`);
      }
      process.stderr.write('LCU: Copying the original application into the private runtime; this can take several minutes...\n');
      copyTree(selected.app, join(stage, 'app'));
      validatedCopy(join(stage, 'app'), selected);
      writeFileSync(join(stage, 'inventory.json'), `${canonicalJson(inventory)}\n`);
      renameSync(stage, generation);
      createdGeneration = true;
    } catch (error) {
      rmSync(stage, { recursive: true, force: true });
      throw error;
    }
  }
  const app = join(generation, 'app');
  let release = null;
  const previous = new Map();
  const replaced = [];
  let pointer = null;
  // Everything from here on is inside the cleanup boundary, so a failure never leaves a new app copy behind.
  try {
    const releases = join(prefix, 'releases');
    if (redirected(releases)) throw new Error(`Refusing a redirected Windows release directory: ${releases}`);
    mkdirSync(releases, { recursive: true });
    release = join(releases, `${VERSION}-${newId(12)}`);
    copyTree(deps.source, release);
    deps.verify(release, arch, 'windows');
    deps.materializeOriginalHost(app, join(release, 'lcu-host'));
    writeFileSync(join(release, 'installation.json'), `${JSON.stringify({
      platform: 'windows', architecture: 'x64', app, package_version: selected.version, runtime: selected.runtimeVersion,
      sha256: digest,
    }, null, 2)}\n`);
    // The managed copy's Node runs LCU: the registered package's own directory does not allow execution.
    const node = component(app, NODE_MEMBER);
    writeFileSync(join(release, 'node-path'), `${node}\r\n`);
    await deps.paths(release);
    const stable = join(prefix, 'windows_launcher.mjs');
    const command = join(prefix, 'lcu.cmd');
    if (redirected(stable) || redirected(command)) throw new Error('Refusing a redirected Windows launcher file.');
    for (const path of [stable, command]) previous.set(path, existsSync(path) ? readFileSync(path) : null);
    deps.write(stable, readFileSync(join(release, 'scripts/windows_launcher.mjs')));
    replaced.push(stable);
    deps.write(command, Buffer.from(launcherCommand(node, previous.get(command)?.length ?? 0)));
    replaced.push(command);
    pointer = join(prefix, `.current-${newId(32)}.json`);
    writeFileSync(pointer, `${JSON.stringify({ release: release.split(/[\\/]/).at(-1) })}\n`);
    deps.rename(pointer, join(prefix, 'current.json'));
    return release;
  } catch (error) {
    try {
      if (pointer) rmSync(pointer, { force: true });
      for (const path of replaced.reverse()) {
        const content = previous.get(path);
        if (content === null) rmSync(path, { force: true });
        else deps.write(path, content);
      }
    } finally {
      if (release) rmSync(release, { recursive: true, force: true });
      // Remove only a copy this run created; a generation that already existed, or that a release records, stays.
      if (createdGeneration && !generationInUse(prefix, generation)) rmSync(generation, { recursive: true, force: true });
    }
    throw error;
  }
}

/** Run the Windows installer with `argv`; returns the exit status. */
export async function main(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    prefix: { type: 'string', default: join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'LCU') },
    'runtime-only': { type: 'boolean' }, agent: { type: 'string', multiple: true, default: [] },
    chrome: { type: 'boolean' }, 'no-chrome': { type: 'boolean' }, audio: { type: 'boolean' }, 'no-audio': { type: 'boolean' },
    yes: { type: 'boolean' }, scope: { type: 'string', default: 'user' }, project: { type: 'string' },
  } });
  const unknown = values.agent.filter((name) => !AGENTS.includes(name));
  if (unknown.length || !['user', 'project'].includes(values.scope)) {
    throw Object.assign(new Error(`Unknown agent or scope: ${[...unknown, values.scope].join(', ')}`), { usage: true });
  }
  const setupOptions = ['chrome', 'audio', 'no-chrome', 'no-audio', 'project'];
  if (values['runtime-only'] && (values.agent.length || setupOptions.some((name) => values[name]) || values.scope !== 'user')) {
    throw Object.assign(new Error('--runtime-only cannot include agent setup options'), { usage: true });
  }
  if (!values['runtime-only'] && !values.agent.length) {
    throw Object.assign(new Error(`Choose --agent NAME or --runtime-only. Agents: ${AGENTS.join(', ')}`), { usage: true });
  }
  const release = await install(values.prefix);
  process.stdout.write(`LCU installed: ${join(values.prefix, 'lcu.cmd')}\n`);
  if (values['runtime-only']) return 0;
  const args = ['--prefix', values.prefix, '--session', 'direct', '--scope', values.scope];
  for (const agent of values.agent) args.push('--agent', agent);
  if (values.project) args.push('--project', values.project);
  for (const flag of ['chrome', 'no-chrome', 'audio', 'no-audio', 'yes']) if (values[flag]) args.push(`--${flag}`);
  return (await (await deps.setup(release)).main(args)) ?? 0;
}

if (isMain(import.meta)) {
  run('LCU Windows installer', async () => {
    try {
      return await main(process.argv.slice(2));
    } catch (error) {
      if (!error.usage && !error.code?.startsWith('ERR_PARSE_ARGS')) throw error;
      process.stderr.write(`LCU Windows installer: ${error.message}\n`);
      return 2;
    }
  });
}
