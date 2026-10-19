// Per-account records of application checks a launch may reuse until the checked files change: the macOS deep
// signature check (platforms.mjs) and the Windows private copy's inventory (windows.mjs). A record is a cache:
// losing it costs one full check, and a missing, corrupt or unreadable record means a full check.
// Builtins come from process.getBuiltinModule: these run on the launch path.
const { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } = process.getBuiltinModule('node:fs');
const { dirname, join } = process.getBuiltinModule('node:path');

import { accountHome } from './fsutil.mjs';

/** LCU's per-account cache directory (the one `update.json` is in); the install prefix may be root-owned. */
export function cacheDirectory(env = process.env) {
  const home = accountHome(env);
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData/Local'), 'LCU/cache');
  if (process.platform === 'darwin') return join(home, 'Library/Caches/lcu');
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'lcu');
}

/** The record at `path` as an object, or `{}` when it is missing or unusable. */
export function readRecord(path) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    return record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  } catch {
    return {};
  }
}

/** True when the record at `path` holds `value` (a JSON string) under `name`. */
export const recorded = (path, name, value) => {
  const record = readRecord(path);
  return Object.hasOwn(record, name) && JSON.stringify(record[name]) === value;
};

/**
 * Set `name` to `value` (a JSON string) in the record at `path`, keeping the other entries for which
 * `keep(name)` is true. Atomic, mode 0600 (on Windows the per-account cache directory's inherited ACL applies);
 * a failure is ignored (the next launch checks again).
 */
export function writeRecord(path, name, value, keep = () => true) {
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const others = Object.entries(readRecord(path)).filter(([other]) => other !== name && keep(other));
    writeFileSync(temporary, JSON.stringify({ ...Object.fromEntries(others), [name]: JSON.parse(value) }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch {
    try { unlinkSync(temporary); } catch { /* not created */ }
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run `check(path)` unless `hit(path)` says the record at `record.path()` already holds its result. Concurrent
 * launches share one check through `<path>.lock`: `record.lock` returns a function that releases it, or null
 * while another process holds it. A launch waits at most `record.wait` milliseconds for the holder and reuses its
 * record, then checks itself. Without a usable record directory or lock, it checks without them. `check` writes
 * the record (or `check(null)`, which has none to write).
 */
export function checkOnce(record, { hit, check }) {
  let path;
  try {
    path = record.path();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    check(null); // no usable cache: check every time
    return;
  }
  if (hit(path)) return;
  let release = null;
  for (const deadline = Date.now() + record.wait; ;) {
    try {
      release = record.lock(`${path}.lock`);
    } catch {
      break; // cannot lock: check without it
    }
    if (release !== null || Date.now() >= deadline) break;
    if (hit(path)) return;
    sleep(50);
  }
  try {
    if (hit(path)) return; // checked by the process that held the lock
    check(path);
  } finally {
    release?.();
  }
}
