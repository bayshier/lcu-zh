// `lcu update` apply step: fetch the release archive, verify it, and run its installer on this release's Node.
//
// Downloads only LCU's own release archive. The official app is never fetched or touched; the new installer
// reuses the app the installation already points at. Agent registrations point at `<prefix>/current` (or
// `<prefix>\lcu.cmd`), so a runtime-only reinstall keeps them working; setup is not re-run.
import { spawnSync } from 'node:child_process';
import {
  accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { batchCommand } from './capture.mjs';
import { isRegular } from './fsutil.mjs';
import { downloadTo, getText } from './update.mjs';

const DOWNLOAD = 'https://github.com/amontlabs/lcu/releases/download';
const TIMEOUT = 60;

/** What tests replace. */
export const deps = {
  run(command) {
    // A .cmd launcher runs through cmd.exe: Node does not start batch files directly.
    return spawnSync(...batchCommand(command[0], command.slice(1), { stdio: 'inherit' })).status ?? 1;
  },
  /** Download `url` into `file`; returns its SHA-256. */
  download: (url, file) => downloadTo(url, file, { timeout: TIMEOUT * 30 }),
  /** A small text file (the checksum). */
  text: (url) => getText(url, { timeout: TIMEOUT }),
  /** The system tar (Windows: its own bsdtar, which also reads zip): `{status, stdout, stderr, error}`. */
  tar: (args) => spawnSync(process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar',
    args, { encoding: 'utf8', maxBuffer: 256 << 20, env: process.platform === 'win32' ? process.env : { ...process.env, PATH: '/usr/bin:/bin' } }),
  interactive: () => process.stdin.isTTY,
  writable: (path) => { try { accessSync(path, constants.W_OK); return true; } catch { return false; } },
  uid: () => process.getuid?.() ?? null,
  print: (text) => process.stdout.write(text),
  report: (text) => process.stderr.write(text),
};


function readJsonObject(path) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Malformed ${path}`);
  return data;
}

/** Release archive name for one platform and architecture. */
export function assetName(version, platform, arch) {
  if (!['darwin', 'linux', 'windows'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new Error(`No LCU release archive for ${platform} ${arch}.`);
  }
  return `lcu-${version}-${platform}-${arch}${platform === 'windows' ? '.zip' : '.tar.gz'}`;
}

/** `[prefix, bundle, installation]` for a release directory, or throws. */
function layout(rootPath) {
  if (!existsSync(join(rootPath, 'bundle.json'))) {
    throw new Error('This LCU is a source checkout; `lcu update` only updates an installed release. ' +
      'Rebuild from source or install a release archive.');
  }
  const root = realpathSync(rootPath);
  const prefix = dirname(dirname(root));
  if (basename(dirname(root)) !== 'releases' || !isRegular(join(prefix, '.lcu-install'))) {
    throw new Error(`${root} is not inside an LCU installation prefix (<prefix>/releases/<name>); update refused.`);
  }
  return [prefix, readJsonObject(join(root, 'bundle.json')), readJsonObject(join(root, 'installation.json'))];
}

/** The new release's installer, run on this release's Node, reproducing the existing install (runtime only). */
export function installerCommand(platform, prefix, installation, source, node = process.execPath) {
  if (platform === 'windows') return [node, join(source, 'scripts/install_windows.mjs'), '--prefix', prefix, '--runtime-only'];
  const command = [node, join(source, 'scripts/install.mjs'), '--prefix', prefix, '--runtime-only'];
  const app = installation.app;
  if (typeof app === 'string' && posix.isAbsolute(app) && existsSync(app)) command.push('--existing-app', app);
  // apt cannot run unattended; system libraries stay as installed.
  if (platform === 'linux') command.push('--skip-system');
  return command;
}

/** The digest a `.sha256` file gives for `name`. */
export function expectedSha256(text, name) {
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (/^[0-9a-fA-F]{64}$/.test(parts[0]) && (parts.length === 1 || parts.at(-1).replace(/^\*/, '') === name)) {
      return parts[0].toLowerCase();
    }
  }
  throw new Error(`Malformed checksum file for ${name}.`);
}

const absolute = (path) => posix.isAbsolute(path) || win32.isAbsolute(path) || /^[A-Za-z]:/.test(path);
const unsafe = (name) => !name || absolute(name) || name.split(/[\\/]/).includes('..');

function tar(args) {
  const result = deps.tar(args);
  if (result.error || result.status !== 0) {
    throw new Error(`tar ${args[0]} failed: ${`${result.stderr ?? ''}`.trim() || result.error?.message || `exit status ${result.status}`}`);
  }
  return result.stdout;
}

/**
 * True when `path` (relative to the extraction root) leaves it once the archive's own symlinks (`links`, name to
 * target) are followed as the kernel would: a link to `.` followed by `..` goes up for real.
 */
export function escapes(path, links) {
  const pending = path.split('/').filter(Boolean);
  const stack = [];
  for (let hops = 0; pending.length;) {
    const part = pending.shift();
    if (part === '.') continue;
    if (part === '..') {
      if (!stack.length) return true;
      stack.pop();
      continue;
    }
    const target = links.get([...stack, part].join('/'));
    if (target === undefined) {
      stack.push(part);
      continue;
    }
    if (++hops > 40 || absolute(target)) return true; // a loop, or an absolute target
    pending.unshift(...target.split('/').filter(Boolean));
  }
  return false;
}

/**
 * The archive's members from the system tar's listings: `{name, type, target}` with type `file`, `directory`,
 * `symlink` or `hardlink`. Anything else (devices, FIFOs, ...) is refused.
 */
export function members(archive) {
  const names = tar(['-tf', archive]).split('\n').filter(Boolean);
  const lines = tar(['-tvf', archive]).split('\n').filter(Boolean);
  if (names.length !== lines.length) throw new Error('The archive listing is inconsistent; refusing to extract it.');
  return names.map((listed, index) => {
    const line = lines[index];
    const name = listed.replace(/\/+$/, '');
    const link = (marker) => {
      const at = line.lastIndexOf(` ${listed}${marker}`);
      return at < 0 ? null : line.slice(at + listed.length + 1 + marker.length);
    };
    const hard = link(' link to ');
    if (hard !== null) return { name, type: 'hardlink', target: hard };
    const type = { '-': 'file', d: 'directory', l: 'symlink' }[line[0]];
    if (!type) throw new Error(`Unsupported entry in archive: ${listed}`);
    if (type !== 'symlink') return { name, type };
    const target = link(' -> ');
    if (target === null) throw new Error(`Unreadable link in archive: ${listed}`);
    return { name, type, target };
  });
}

/** Refuse what Python's tarfile 'data' filter refused: paths and links that leave the release, odd entries. */
export function check(entries, { links: allowLinks = true } = {}) {
  const links = new Map(entries.filter((entry) => entry.type === 'symlink').map((entry) => [entry.name, entry.target]));
  const files = new Set();
  for (const { name, type, target } of entries) {
    if (unsafe(name) || escapes(posix.dirname(name), links)) throw new Error(`Unsafe path in archive: ${name}`);
    if (type === 'symlink' && (!allowLinks || absolute(target) ||
        escapes(posix.join(posix.dirname(name), target), links))) {
      throw new Error(`Archive link escapes the release: ${name}`);
    }
    if (type === 'hardlink' && (unsafe(target) || !files.has(target))) throw new Error(`Archive link escapes the release: ${name}`);
    if (type === 'file') files.add(name);
  }
}

/** After extraction: only files, directories and links that stay inside; modes as the 'data' filter left them. */
function settle(root) {
  const real = realpathSync(root);
  const inside = (path) => path === real || path.startsWith(real + sep);
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        let resolved;
        try {
          resolved = realpathSync(path);
        } catch {
          resolved = resolve(dirname(path), readlinkSync(path)); // dangling: judge the link text
        }
        if (!inside(resolved)) throw new Error(`Archive link escapes the release: ${relative(real, path)}`);
      } else if (info.isDirectory()) {
        chmodSync(path, (info.mode & 0o755) | 0o700);
        walk(path);
      } else if (info.isFile()) {
        chmodSync(path, (info.mode & 0o755) | 0o600);
      } else {
        throw new Error(`Unsupported entry in archive: ${relative(real, path)}`);
      }
    }
  };
  walk(real);
}

/** Check the archive's listing, extract it with the system tar into the empty `destination`, then check the result. */
export function extract(archive, destination) {
  check(members(archive), { links: !archive.endsWith('.zip') });
  tar(['-xf', archive, '-C', destination, '--no-same-owner', '--no-same-permissions']);
  settle(destination);
}

/** Download, verify and extract the archive; returns the extracted release directory. */
export async function download(info, name, directory) {
  const base = `${DOWNLOAD}/${info.tag}/${name}`;
  deps.report(`Downloading ${base}\n`);
  const archive = join(directory, name);
  const actual = await deps.download(base, archive);
  const expected = expectedSha256(await deps.text(`${base}.sha256`), name);
  if (actual !== expected) {
    rmSync(archive, { force: true });
    throw new Error(`Checksum mismatch for ${name}; refusing to install it.`);
  }
  const extracted = join(directory, 'extract');
  mkdirSync(extracted);
  extract(archive, extracted);
  const source = join(extracted, name.replace(/\.(zip|tar\.gz)$/, ''));
  if (!existsSync(join(source, 'bundle.json'))) throw new Error('The archive does not contain an LCU release bundle.');
  return source;
}

const quote = (value) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

/** Update the installation containing `root`; returns an exit status. */
export async function apply(root, info, { yes = false } = {}) {
  let prefix, bundle, installation, platform, name;
  try {
    [prefix, bundle, installation] = layout(root);
    platform = installation.platform ?? 'linux';
    name = assetName(info.version, platform, installation.architecture ?? bundle.architecture);
  } catch (error) {
    deps.report(`lcu update: ${error.message}\n`);
    return 1;
  }
  const lcu = join(prefix, platform === 'windows' ? 'lcu.cmd' : 'current/bin/lcu');
  deps.print(`LCU update: ${bundle.version} -> ${info.version}\n  prefix:  ${prefix}\n  archive: ${name}\n` +
    `  release: ${info.release_url ?? ''}\n`);
  if (!yes) {
    if (!deps.interactive()) {
      deps.report(`Not interactive; nothing changed. To apply, run:\n  ${quote(lcu)} update --yes\n`);
      return 2;
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question('Proceed? [y/N] ');
    prompt.close();
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
      deps.print('Cancelled.\n');
      return 1;
    }
  }
  const temporary = mkdtempSync(join(tmpdir(), 'lcu-update-'));
  let keep = false;
  try {
    const source = await download(info, name, temporary);
    const command = installerCommand(platform, prefix, installation, source);
    if (platform === 'linux') {
      const uid = deps.uid();
      const user = uid === 0 ? process.env.SUDO_USER : null;
      if (uid === 0 && !user) {
        deps.report('lcu update: running as root without SUDO_USER; run it as the desktop account through sudo or as that account.\n');
        return 1;
      }
      if (uid !== 0 && ![prefix, join(prefix, '.lcu-install'), join(prefix, 'releases')].every(deps.writable)) {
        keep = true;
        deps.report(`${prefix} is not writable by this account. The verified release is at ${source}; install it with:\n` +
          `  sudo ${[...command, '--user', userInfo().username].map(quote).join(' ')}\nThen delete ${temporary}.\n`);
        return 1;
      }
      if (user) command.push('--user', user);
    }
    const status = deps.run(command);
    if (status) {
      deps.report(`lcu update: the installer failed (exit ${status}); the previous release stays current.\n`);
      return status;
    }
    // The new release refreshes what setup copied out of the old one (the Claude mod, the Chrome relay).
    if (deps.run([lcu, 'update', '--post-install'])) {
      deps.report(`lcu update: could not refresh harness integrations; rerun \`${lcu} setup\` for your agents.\n`);
    }
    deps.print(`LCU ${info.version} installed. Restart agents that use LCU so they load the new release.\n` +
      `To reclaim space from superseded releases, run: ${quote(lcu)} prune\n`);
    return 0;
  } catch (error) {
    deps.report(`lcu update: ${error.message}\n`);
    return 1;
  } finally {
    if (!keep) rmSync(temporary, { recursive: true, force: true });
  }
}
