// Exclusive locks between LCU processes, compatible with the locks earlier (Python) releases took.
//
// POSIX: a kernel flock on a lock file that stays in place, so a holder that exits or crashes releases it and
// releases before the Node port exclude this one and are excluded by it. Node has no flock(2): macOS takes it
// atomically with open(2) (O_EXLOCK); Linux has util-linux flock(1) lock the descriptor this process opened and
// passed down as fd 3, which locks the shared open file description, so the lock outlives flock(1) and lasts
// until this process closes it. Windows: a lock file created exclusively that names its holder; a file left by
// a process that is gone is taken over, one takeover at a time (see takeOver).
// Builtins come from process.getBuiltinModule: macos_host.mjs, on the macOS launch path, shares tryExclusiveOpen.
const fs = process.getBuiltinModule('node:fs');
const { join } = process.getBuiltinModule('node:path');

/** open(2) flag that takes flock(LOCK_EX) atomically with the open (macOS). */
export const O_EXLOCK = 0x20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * macOS: open `path` (created 0600) holding an exclusive flock, or return null while another descriptor holds
 * it. Closing the descriptor releases the lock.
 */
export function tryExclusiveOpen(path, flags = fs.constants.O_RDWR) {
  const { O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  try {
    return fs.openSync(path, flags | O_CREAT | O_NOFOLLOW | O_EXLOCK | O_NONBLOCK, 0o600);
  } catch (error) {
    if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') return null;
    throw error;
  }
}

/** Open the lock file for flock: read-write, else read-only (a root-owned install marker); never through a link. */
function openLockFile(path) {
  const { O_CREAT, O_NOFOLLOW, O_RDONLY, O_RDWR } = fs.constants;
  try {
    return fs.openSync(path, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
    return fs.openSync(path, O_RDONLY | O_NOFOLLOW);
  }
}

/** Linux: try to flock `fd` exclusively through flock(1); true when held. */
function tryFlock(fd, path) {
  const result = process.getBuiltinModule('node:child_process').spawnSync('flock', ['-xn', '3'],
    { stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8', timeout: 10_000 });
  if (result.error?.code === 'ENOENT') {
    throw new Error('LCU needs flock(1) to lock its files; install util-linux (it provides flock) and retry.');
  }
  if (result.status === 0) return true;
  if (result.status === 1 && !result.stderr.trim()) return false;
  throw new Error(`Cannot lock ${path}: ${(result.stderr || result.error?.message || `flock exited ${result.status}`).trim()}`);
}

/** One attempt to take the lock: a release function, or null while another process holds it. */
function attemptPosix(path) {
  if (process.platform === 'darwin') {
    const fd = tryExclusiveOpen(path);
    if (fd === null) return null;
    return () => fs.closeSync(fd);
  }
  const fd = openLockFile(path);
  try {
    if (!tryFlock(fd, path)) {
      fs.closeSync(fd);
      return null;
    }
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  return () => fs.closeSync(fd);
}

// Windows answers EPERM, EACCES or EBUSY while a file is pending deletion or open in another process: busy, retry.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const GUARD_STALE_MS = 30_000;
/** Tokens of the Windows locks this process holds now; a file naming this pid with another token is stale. */
const held = new Set();
let serial = 0;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};

/** Block for `ms` milliseconds (a short retry inside a synchronous release). */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Read `path`; null when it is gone, undefined while Windows reports it busy. */
function readLock(io, path) {
  try {
    return io.readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (TRANSIENT.has(error.code)) return undefined;
    throw error;
  }
}

/** Unlink `path` when `keep(content)` is false, retrying transient failures for about a second. */
function unlinkUnless(io, path, keep = () => false) {
  for (let tries = 0; ; tries += 1) {
    try {
      const content = readLock(io, path);
      if (content === null || (content !== undefined && keep(content))) return;
      if (content !== undefined) {
        io.unlinkSync(path);
        return;
      }
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (!TRANSIENT.has(error.code)) throw error;
    }
    if (tries >= 20) return;
    pause(50);
  }
}

/** Windows: true when the lock file names a process that is gone (or was never completely written long ago). */
function staleWindows(io, path, content) {
  let holder;
  try {
    holder = JSON.parse(content);
  } catch {
    try {
      return Date.now() - io.statSync(path).mtimeMs > 10_000;
    } catch {
      return false;
    }
  }
  if (!Number.isInteger(holder?.pid)) return true;
  if (holder.pid === process.pid) return !held.has(content);
  return !alive(holder.pid);
}

/** Remove a takeover guard left by a process that is gone, or one older than GUARD_STALE_MS. */
function clearStaleGuard(io, guard) {
  unlinkUnless(io, guard, (content) => {
    let owner;
    try {
      owner = JSON.parse(content);
    } catch {
      owner = null;
    }
    let age;
    try {
      age = Date.now() - io.statSync(guard).mtimeMs;
    } catch {
      return true;
    }
    if (age > GUARD_STALE_MS) return false;
    if (!Number.isInteger(owner?.pid)) return age <= 10_000;
    return owner.pid !== process.pid && alive(owner.pid);
  });
}

/**
 * Remove the stale lock `content` at `path`. Takeovers are serialized by an exclusively created guard file, and
 * under it the lock is removed only while it still holds exactly that stale content, so a live holder's lock
 * (whose token never matches) is never removed. True when the path is free now.
 */
function takeOver(io, path, content) {
  const guard = `${path}.takeover`;
  let fd;
  for (let tries = 0; fd === undefined; tries += 1) {
    try {
      fd = io.openSync(guard, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST' && !TRANSIENT.has(error.code)) throw error;
      if (error.code !== 'EEXIST' || tries) return false;
      clearStaleGuard(io, guard);
    }
  }
  try {
    try {
      io.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    } finally {
      io.closeSync(fd);
    }
    const current = readLock(io, path);
    if (current === null) return true;
    if (current !== content || !staleWindows(io, path, current)) return false;
    try {
      io.unlinkSync(path);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      if (TRANSIENT.has(error.code)) return false;
      throw error;
    }
  } finally {
    unlinkUnless(io, guard);
  }
}

function attemptWindows(path, io, retried = false) {
  const token = JSON.stringify({ pid: process.pid, at: Date.now(), n: serial++ });
  let fd;
  try {
    fd = io.openSync(path, 'wx', 0o600);
  } catch (error) {
    if (TRANSIENT.has(error.code)) return null;
    if (error.code !== 'EEXIST') throw error;
    const content = readLock(io, path);
    if (content === undefined) return null;
    // Gone again, or a stale lock just removed: try the free path once more.
    if (content === null || (staleWindows(io, path, content) && takeOver(io, path, content))) {
      return retried ? null : attemptWindows(path, io, true);
    }
    return null;
  }
  try {
    io.writeSync(fd, token);
  } finally {
    io.closeSync(fd);
  }
  held.add(token);
  return () => {
    held.delete(token);
    unlinkUnless(io, path, (content) => content !== token);
  };
}

/**
 * One attempt to take the lock at `path` without waiting: a function that releases it, or null while another
 * process holds it. For callers that cannot await (a launch's application checks).
 */
export const tryAcquire = (path, io = fs) => (process.platform === 'win32' ? attemptWindows(path, io) : attemptPosix(path));

const WINDOWS_WAIT = 60_000;

/**
 * Take the lock at `path`, waiting up to `wait` milliseconds (POSIX: until released; Windows: one minute by
 * default). `busy` builds the error thrown when it stays held; `waiting` is told once, after a second, that the
 * wait started. Resolves with a function that releases the lock. POSIX lock files are never removed. `io` is
 * the file system the Windows lock uses (tests inject failures through it).
 */
export async function acquire(path, {
  wait = process.platform === 'win32' ? WINDOWS_WAIT : Infinity,
  busy = () => new Error(`${path} stayed locked by another LCU process; retry when it has finished.`),
  waiting = () => process.stderr.write(`LCU: waiting for another LCU process to release ${path}...\n`),
  io = fs,
} = {}) {
  const started = Date.now();
  let told = false;
  for (;;) {
    const release = tryAcquire(path, io);
    if (release) return release;
    const elapsed = Date.now() - started;
    if (elapsed >= wait) throw busy();
    if (!told && elapsed >= 1000) {
      told = true;
      waiting();
    }
    // Poll every 50 ms for the first second, then every 200 ms (on Linux each poll runs flock(1)).
    await sleep(Math.min(elapsed < 1000 ? 50 : 200, Math.max(wait - elapsed, 0)));
  }
}

/** Run `fn` while holding the lock at `path`. */
export async function withLock(path, fn, options) {
  const release = await acquire(path, options);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * The lock installs, updates and `lcu prune` share for one prefix: the install marker itself on POSIX, as
 * earlier releases locked it, and a lock file beside it on Windows.
 */
export const installLockPath = (prefix) => join(prefix, process.platform === 'win32' ? '.lcu-install.lock' : '.lcu-install');
