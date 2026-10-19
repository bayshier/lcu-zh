// `lcu prune`: drop superseded release and app generations to reclaim space.
//
// Each install publishes a new `<prefix>/releases/<name>`. Windows also keeps a private app generation under
// `<prefix>/apps/`; LCU 0.7.0 and earlier did the same on Linux, which now uses the installed app in place.
// Nothing removes old generations automatically. Pruning keeps the current release plus the most recent others
// and every app generation a kept release still references, so it also reclaims Linux app copies left by earlier
// versions. It refuses to touch anything that does not match the layout the installers create.
import { lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { isDirectory, readJson, real } from './fsutil.mjs';
import { installLockPath, withLock } from './lock.mjs';
import { say, warn } from './terminal.mjs';

// Release dirs are `<version>-<uuid[:12]>`; Linux app generations are `<version>-<arch>-<digest[:16]>`; Windows
// app generations are a bare sha256.
const RELEASE = /^.+-[0-9a-f]{12}$/;
const LINUX_APP = /^.+-(?:arm64|x64)-[0-9a-f]{16}$/;
const WINDOWS_APP = /^[0-9a-f]{64}$/;

const lstat = (path) => { try { return lstatSync(path); } catch { return null; } };

export function human(size) {
  let value = size;
  for (const unit of ['B', 'KiB', 'MiB', 'GiB', 'TiB']) {
    if (value < 1024 || unit === 'TiB') return unit === 'B' ? `${value.toFixed(0)} B` : `${value.toFixed(1)} ${unit}`;
    value /= 1024;
  }
  return '';
}

function treeSize(path) {
  let total = lstatSync(path).size;
  for (const name of readdirSync(path, { recursive: true })) total += lstat(join(path, name))?.size ?? 0;
  return total;
}

/** The current release, confirmed to be inside `releases`. */
function releaseCurrent(prefix, releases, windows) {
  if (windows) {
    const pointer = join(prefix, 'current.json');
    if (lstat(pointer)?.isSymbolicLink() || !lstat(pointer)?.isFile()) throw new Error(`Not an LCU installation: missing ${pointer}`);
    const name = readJson(pointer).release;
    if (typeof name !== 'string' || /[\\/]/.test(name) || ['', '.', '..'].includes(name)) throw new Error('Invalid current.json release pointer.');
    const current = join(releases, name);
    if (lstat(current)?.isSymbolicLink() || !isDirectory(current)) throw new Error('current.json does not point at a release directory.');
    return current;
  }
  const pointer = join(prefix, 'current');
  if (!lstat(pointer)?.isSymbolicLink()) throw new Error(`Not an LCU installation: ${pointer} is not a symlink`);
  const current = real(pointer);
  if (dirname(current) !== real(releases) || !isDirectory(current)) throw new Error('current does not resolve into <prefix>/releases.');
  return join(releases, basename(current));
}

/** Matching child directories, refusing unexpected entries; dot entries are transient install staging. */
function entries(directory, pattern) {
  return readdirSync(directory).sort().filter((name) => !name.startsWith('.')).map((name) => {
    const child = join(directory, name);
    const info = lstat(child);
    if (!info || info.isSymbolicLink() || !info.isDirectory() || !pattern.test(name)) throw new Error(`Refusing to prune: unexpected entry ${child}`);
    return child;
  });
}

/** The app generation directory (under `apps`) a release uses, or null when it uses none. */
function generationDirectory(release, apps, windows) {
  const descriptor = readJson(join(release, 'installation.json'));
  if ((descriptor.platform ?? 'linux') === 'darwin') return null;
  const { app } = descriptor;
  if (typeof app !== 'string' || !app) throw new Error(`Release ${basename(release)} has no app descriptor.`);
  const resolved = real(windows ? app : resolve(release, app));
  const appsReal = real(apps);
  for (let candidate = resolved; candidate !== dirname(candidate); candidate = dirname(candidate)) {
    if (dirname(candidate) === appsReal) return join(apps, basename(candidate));
  }
  // A Linux release using an installed app in place, outside <prefix>/apps. An absolute path that resolves under
  // <prefix>/apps (for example an app copy left by 0.7.0 and passed to --existing-app) is a generation to keep.
  if (!windows && isAbsolute(app) && !('sha256' in descriptor)) return null;
  throw new Error(`Release ${basename(release)} references an app outside ${appsReal}.`);
}

const USAGE = 'Usage: lcu prune [--keep N] [--yes]';

/** `lcu prune ARGV` from the release `root`; returns the exit status. */
export async function main(root, argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { keep: { type: 'string', default: '2' }, yes: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false } } }));
    if (!/^[+-]?\d+$/.test(values.keep.trim())) throw new Error(`--keep takes a whole number, not '${values.keep}'.`);
  } catch (error) {
    warn(`lcu prune: ${error.message}`, "Run 'lcu prune --help' for usage.");
    return 2;
  }
  if (values.help) {
    say(USAGE, '', 'Remove superseded LCU release and app generations.', '',
      '  --keep N  Number of releases to keep, including current (minimum 1; default 2).',
      '  --yes     Delete instead of a dry run.');
    return 0;
  }
  const keep = Math.max(Number(values.keep), 1);
  root = real(root);
  if (basename(dirname(root)) !== 'releases') throw new Error('lcu prune must run from an installed <prefix>/releases/<name> release.');
  const prefix = dirname(dirname(root));
  const releases = join(prefix, 'releases');
  const windows = readJson(join(root, 'installation.json')).platform === 'windows';
  const marker = join(prefix, '.lcu-install');
  if (lstat(marker)?.isSymbolicLink() || !lstat(marker)?.isFile()) throw new Error(`Not an LCU installation: missing ${marker}`);
  if (lstat(releases)?.isSymbolicLink() || !isDirectory(releases)) throw new Error(`Not an LCU installation: ${releases} is missing or a symlink`);
  return withLock(installLockPath(prefix), () => prune(prefix, releases, root, keep, values.yes, windows));
}

function prune(prefix, releases, root, keep, yes, windows) {
  const current = releaseCurrent(prefix, releases, windows);
  const all = entries(releases, RELEASE);
  const others = all.filter((release) => release !== current && release !== root)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  const kept = new Set([current, root, ...others.slice(0, Math.max(keep - 1, 0))]);
  const removals = all.filter((release) => !kept.has(release));
  const apps = join(prefix, 'apps');
  if (lstat(apps)) {
    if (lstat(apps).isSymbolicLink() || !isDirectory(apps)) throw new Error(`Refusing to prune: ${apps} is not a directory`);
    const generations = entries(apps, windows ? WINDOWS_APP : LINUX_APP);
    const referenced = new Set([...kept].map((release) => generationDirectory(release, apps, windows)));
    removals.push(...generations.filter((generation) => !referenced.has(generation)));
  }
  if (!removals.length) {
    say('Nothing to prune; current and recent generations are already the only ones.');
    return 0;
  }
  // Guard: only ever delete real directories directly under releases or apps.
  for (const path of removals) {
    if (lstat(path)?.isSymbolicLink() || !isDirectory(path) || ![releases, apps].includes(dirname(path))) {
      throw new Error(`Refusing to remove unexpected path: ${path}`);
    }
  }
  let total = 0;
  for (const path of removals) {
    const size = treeSize(path);
    total += size;
    if (yes) rmSync(path, { recursive: true });
    say(`${yes ? 'Removed' : 'Would remove'} ${path} (${human(size)})`);
  }
  say(`Total: ${human(total)} across ${removals.length} generation(s).`);
  if (!yes) say('Rerun with --yes to delete. Restart or stop agents using older LCU releases first.');
  return 0;
}
