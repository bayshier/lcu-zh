// The release inventory: version, architecture and integrity of an extracted LCU release.
// VERSION here is the single source of the release version; scripts/build_bundle.py reads it from this file.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { within } from '../lcu/fsutil.mjs';

export const VERSION = '0.11.4';

const PLATFORMS = { linux: 'linux', darwin: 'darwin', windows: 'win32' };

/** `arm64` or `x64` for this machine, when it runs `target`; otherwise throws. */
export function architecture(target = 'linux') {
  const arch = { arm64: 'arm64', x64: 'x64' }[process.arch];
  if (PLATFORMS[target] !== process.platform || !arch || (target === 'windows' && arch !== 'x64')) {
    throw new Error(`LCU requires ${target} ARM64 or x86-64.`);
  }
  return arch;
}


/** Every file and link under `root` except bundle.json: `{relative: {type, sha256, mode} | {type, target}}`. */
export function inventory(rootPath, target = 'linux') {
  const root = realpathSync(rootPath);
  const files = {};
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const key = relative(root, path).split(sep).join('/');
      if (key === 'bundle.json') continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        const link = readlinkSync(path);
        let resolved;
        try {
          resolved = realpathSync(path);
        } catch {
          resolved = resolve(directory, link); // dangling: judge the link text alone
        }
        if (isAbsolute(link) || !within(resolved, root)) throw new Error(`Unsafe bundle symlink: ${key}`);
        files[key] = { type: 'symlink', target: link };
      } else if (info.isFile()) {
        const entry = { type: 'file', sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
        if (target !== 'windows') entry.mode = info.mode & 0o777;
        files[key] = entry;
      } else if (info.isDirectory()) {
        walk(path);
      } else {
        throw new Error(`Unsupported bundle entry: ${key}`);
      }
    }
  };
  walk(root);
  return files;
}

const sameEntries = (left, right) => {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => {
    const [a, b] = [left[key], right?.[key]];
    return b && typeof b === 'object' && Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((field) => a[field] === b[field]);
  });
};

/** Check that `root` is an intact release for this platform and architecture; returns its manifest. */
export function verify(root, arch, target = 'linux') {
  const path = join(root, 'bundle.json');
  let manifest;
  try {
    if (!lstatSync(path).isFile()) throw new Error('not a file');
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Install from an extracted LCU release bundle. Source checkouts contain no runtime; ' +
      'build a release with scripts/build_bundle.py first.');
  }
  if (!manifest || typeof manifest !== 'object' || manifest.format !== 1 || manifest.platform !== target ||
      manifest.version !== VERSION) {
    throw new Error('Unsupported LCU bundle manifest');
  }
  if (manifest.architecture !== arch) {
    throw new Error(`Bundle architecture ${manifest.architecture} does not match this machine (${arch})`);
  }
  const expected = manifest.files;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || !sameEntries(inventory(root, target), expected)) {
    throw new Error('LCU bundle integrity check failed; extract a clean release archive.');
  }
  return manifest;
}
