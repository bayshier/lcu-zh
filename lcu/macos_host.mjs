// Supervise the original macOS client turn-ended command for one MCP process.
//
// The host runs inside the `lcu` process for as long as the original server it launched: a private Unix
// socket takes turn-ended IDs from LCU's Sky wrapper and runs the original client's `turn-ended` command, can
// recover from a provably stale Computer Use service, and optionally routes human control through the
// trusted Sky service.
// Builtins come from process.getBuiltinModule, like the rest of the launch path.
const { spawn, spawnSync } = process.getBuiltinModule('node:child_process');
const { randomUUID } = process.getBuiltinModule('node:crypto');
const fs = process.getBuiltinModule('node:fs');
const net = process.getBuiltinModule('node:net');
const { tmpdir } = process.getBuiltinModule('node:os');
const { basename, dirname, isAbsolute, join, sep } = process.getBuiltinModule('node:path');

import { tryExclusiveOpen } from './lock.mjs';

// Every system tool and turn-ended command this host starts, so stopping the host ends them too.
const running = new Set();
function track(child) {
  running.add(child);
  child.once('close', () => running.delete(child));
  return child;
}

export const SKY_SERVICE_NAME = 'SkyComputerUseService';
// The system tools by absolute path, so a caller's PATH cannot stand in for them.
export const PS = '/bin/ps';
export const LSOF = '/usr/sbin/lsof';
export const CODESIGN = '/usr/bin/codesign';
// `ps` reports the start time in whole seconds and the file time has sub-second precision, so a change this
// close to the start is never read as an update.
const STALE_MARGIN_SECONDS = 2;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** UTC epoch seconds from the five `ps lstart` fields, or null when malformed. */
export function parseProcessStart(fields) {
  if (fields.length !== 5) return null;
  const [, monthName, dayText, clock, yearText] = fields;
  const month = MONTHS.indexOf(monthName);
  const parts = /^(\d+):(\d+):(\d+)$/.exec(clock);
  if (month < 0 || !parts || !/^\d+$/.test(dayText) || !/^\d+$/.test(yearText)) return null;
  const [hour, minute, second] = parts.slice(1).map(Number);
  const [day, year] = [Number(dayText), Number(yearText)];
  if (!(day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 60 && year >= 1970 && year <= 9999)) return null;
  // `ps` is run with TZ=UTC, so there is no local-time ambiguity at DST changes.
  return Date.UTC(year, month, day, hour, minute, second) / 1000;
}

const PROCESS_ROW = /^[ \t]*(\d+)[ \t]+(\d+)[ \t]+([A-Za-z]{3})[ \t]+([A-Za-z]{3})[ \t]+(\d{1,2})[ \t]+(\d{2}:\d{2}:\d{2})[ \t]+(\d{4})[ \t]+(\/.*)$/s;
// Characters that could make a path look like several rows or fields.
const UNSAFE_PATH = /[\x00-\x1f\x7f\x85\u2028\u2029]/;

/**
 * `{services, unparsed}`: running Sky services from `ps -axo pid=,uid=,lstart=,comm=` output. Rows are split on
 * newlines only, and lines that name the service but cannot be parsed are counted, not guessed at.
 */
export function parseProcessTable(text) {
  const services = [];
  let unparsed = 0;
  for (const line of text.split('\n')) {
    if (!line.includes(SKY_SERVICE_NAME)) continue;
    // pid, uid, then lstart as `Wed Oct  7 00:34:53 2026`, then the executable path (which may contain spaces).
    const match = PROCESS_ROW.exec(line.replace(/\r$/, ''));
    const started = match ? parseProcessStart(match.slice(3, 8)) : null;
    const raw = match ? match[8] : ''; // checked before trimming: only trailing spaces are padding
    const path = raw.replace(/ +$/, '');
    if (started === null || UNSAFE_PATH.test(raw) || !isAbsolute(path) || basename(path) !== SKY_SERVICE_NAME) {
      unparsed += 1;
      continue;
    }
    services.push({ pid: Number(match[1]), uid: Number(match[2]), path, started });
  }
  return { services, unparsed };
}

/**
 * The change times (seconds) of the executable, Info.plist and code-signature seal, or null. An app update
 * replaces the whole bundle: observed live, every file had the update time as ctime while mtimes and
 * creation times were older. The bundle counts as replaced at the oldest of the three, so one metadata change
 * on a single file does not read as an update; a missing file gives null, not a guess.
 */
export function bundleChangeTimes(executable, stat = fs.statSync) {
  const contents = dirname(dirname(executable));
  if (contents === dirname(contents)) return null;
  try {
    return [executable, join(contents, 'Info.plist'), join(contents, '_CodeSignature/CodeResources')]
      .map((path) => stat(path).ctimeMs / 1000);
  } catch {
    return null;
  }
}

/** English month names and UTC times; UTF-8 so `ps` does not escape non-ASCII paths; no COLUMNS, which cuts paths. */
function toolEnvironment(env = process.env) {
  const result = { ...env, LC_TIME: 'C', LC_CTYPE: 'UTF-8', TZ: 'UTC' };
  delete result.LC_ALL;
  delete result.COLUMNS;
  return result;
}

/**
 * Run a system tool and resolve with `{status, stdout, stderr}`, never waiting much past `timeout` seconds:
 * a tool blocked in the kernel can outlive SIGKILL, so one second after the kill it is abandoned and the
 * promise rejects with a timeout error.
 */
export function boundedRun(argv, { timeout, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = track(spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env }));
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const expire = () => {
      const error = new Error(`${argv[0]} timed out after ${timeout} seconds`);
      error.code = 'ETIMEDOUT';
      return error;
    };
    let abandon;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      abandon = setTimeout(() => reject(expire()), 1000);
    }, timeout * 1000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      clearTimeout(abandon);
      if (abandon) reject(expire());
      else resolve({ status, stdout, stderr });
    });
  });
}

/** `{services, unparsed}`: running Sky services (or just `pid`) from `ps`. */
export async function listSkyServices({ run = boundedRun, pid } = {}) {
  const selection = pid === undefined ? ['-axo'] : ['-p', String(pid), '-o'];
  // -ww: unlimited width; without a terminal `ps` would cut long paths and hide services.
  const result = await run([PS, '-ww', ...selection, 'pid=,uid=,lstart=,comm='], { timeout: 2, env: toolEnvironment() });
  // `ps -p` exits 1 with no output when that process is gone.
  if (result.status !== 0 && !(pid !== undefined && result.status === 1 && !result.stdout.trim())) {
    throw new Error(`ps exited with status ${result.status}.`);
  }
  return parseProcessTable(result.stdout);
}

/** List running Sky services and flag those started before their bundle was replaced. Kills nothing. */
export async function diagnoseSkyServices({ run = boundedRun, stat = fs.statSync } = {}) {
  const { services, unparsed } = await listSkyServices({ run });
  return {
    unparsed,
    services: services.map((service) => {
      const times = bundleChangeTimes(service.path, stat);
      return { ...service, bundleTimes: times, stale: times !== null && Math.min(...times) > service.started + STALE_MARGIN_SECONDS };
    }),
  };
}

/** Run `work` once at a time; callers arriving meanwhile share the running call's result (bounded wait). */
export function singleFlight(work, { waitSeconds = 5, unfinished = 'The Computer Use service recovery did not finish.' } = {}) {
  let current = null;
  return async (...args) => {
    let result;
    if (current) {
      result = await Promise.race([current.catch(() => null), new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000).unref())]);
    } else {
      current = Promise.resolve().then(() => work(...args));
      try {
        result = await current;
      } finally {
        current = null;
      }
    }
    return result || { ok: false, error: unfinished };
  };
}

// Recovery. A Computer Use service whose bundle was replaced while it ran keeps the socket lock and rejects
// every client. When, and only when, every check below agrees that one service is that stale holder, it is
// asked to quit (SIGTERM) so the original client can start a current one. Every step is bounded; any doubt
// means no action.
const CODESIGN_TIMEOUT_SECONDS = 4;
const LSOF_TIMEOUT_SECONDS = 3;
// The signal must follow the start of the recovery within this many seconds of the monotonic clock (the
// requester waits 15 s for the answer, including the exit wait below).
export const SIGNAL_BUDGET_SECONDS = 9;
const PEER_LOCK_WAIT_SECONDS = 4;
const TERMINATE_WAIT_SECONDS = 3;
const TERMINATE_POLL_SECONDS = 0.1;
const RECOVERY_WAIT_SECONDS = 16;
// What `codesign --verify <pid>` prints when the code that is running is not the code now on disk
// (errSecCSStaticCodeChanged). Any other failure does not prove that the running service is stale.
export const SIGNATURE_MISMATCH_MARKERS = ['the code on disk does not match what is running'];
const SERVICE_EXECUTABLE = `Contents/MacOS/${SKY_SERVICE_NAME}`;

/** 'valid', 'invalid' (the running code differs from the code on disk) or 'unknown'. */
export async function verifyServiceSignature(pid, { run = boundedRun } = {}) {
  let result;
  try {
    result = await run([CODESIGN, '--verify', '--strict', String(pid)], { timeout: CODESIGN_TIMEOUT_SECONDS, env: toolEnvironment() });
  } catch {
    return 'unknown';
  }
  if (result.status === 0) return 'valid';
  const detail = `${result.stderr ?? ''} ${result.stdout ?? ''}`.toLowerCase();
  return result.status === 1 && SIGNATURE_MISMATCH_MARKERS.some((marker) => detail.includes(marker)) ? 'invalid' : 'unknown';
}

/**
 * The complete set of pids with the service's socket lock file open, or null when unsure. Only a clean answer
 * counts: pids and no diagnostics, or no pids, no diagnostics and lsof's "nothing found" status.
 */
export async function lockHolders(lockPath, { run = boundedRun } = {}) {
  if (!lockPath || !isAbsolute(lockPath)) return null;
  let result;
  try {
    result = await run([LSOF, '-t', '--', lockPath], { timeout: LSOF_TIMEOUT_SECONDS });
  } catch {
    return null;
  }
  const lines = (result.stdout ?? '').split(/\s+/).filter(Boolean);
  const clean = !(result.stderr ?? '').trim() && lines.every((line) => /^\d+$/.test(line)) &&
    ((result.status === 0 && lines.length > 0) || (result.status === 1 && !lines.length));
  return clean ? new Set(lines.map(Number)) : null;
}

const isPid = (pid) => Number.isInteger(pid) && pid > 1;

/**
 * The Sky service executable the kernel reports for a pid, or null. `ps` shows argv[0], which a process can
 * choose; this is the file actually running. Node cannot call proc_pidpath, so this asks `lsof` for the
 * process's text mappings (from the same kernel vnode information) and takes the one entry that is a
 * SkyComputerUseService executable, not a library the process also maps. Anything else is null.
 */
export async function executablePath(pid, { run = boundedRun } = {}) {
  if (process.platform !== 'darwin' || !isPid(pid)) return null;
  try {
    const result = await run([LSOF, '-a', '-p', String(pid), '-d', 'txt', '-Fn'], { timeout: LSOF_TIMEOUT_SECONDS });
    if (result.status !== 0 || (result.stderr ?? '').trim()) return null;
    const lines = result.stdout.split('\n');
    if (lines[0] !== `p${pid}`) return null;
    const names = lines.slice(1).filter((line) => line.startsWith('n')).map((line) => line.slice(1))
      .filter((name) => isAbsolute(name) && basename(name) === SKY_SERVICE_NAME);
    return names.length === 1 ? names[0] : null;
  } catch {
    return null;
  }
}

// Unreferenced: a recovery that is still waiting never keeps a finished `lcu` alive.
const sleepSeconds = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000).unref());
const monotonicSeconds = () => performance.now() / 1000;

/**
 * Exclusion between the LCU hosts of this account (one per MCP connection), held for the whole recovery
 * including the wait for the service to exit: an flock on a file in the account's private temporary directory,
 * the same lock Python LCU hosts take, released by the kernel when its holder exits. The file names the last
 * service instance that was asked to quit, so no host asks the same instance twice. Another host recovering
 * at the same time makes this one wait (bounded). macOS only: elsewhere the lock is never acquired.
 */
export class PeerLock {
  constructor(path = PeerLock.defaultPath(), { waitSeconds = PEER_LOCK_WAIT_SECONDS, sleep = sleepSeconds, monotonic = monotonicSeconds } = {}) {
    Object.assign(this, { path, waitSeconds, sleep, monotonic, descriptor: null, acquired: false, previous: null });
  }

  /** The account's private temporary directory by the system's own answer, not $TMPDIR; null off macOS. */
  static defaultPath() {
    if (process.platform !== 'darwin') return null;
    const result = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 5000 });
    const directory = result.status === 0 ? result.stdout.trim() : '';
    return isAbsolute(directory) ? join(directory, `lcu-stale-service-recovery-${process.getuid()}.lock`) : null;
  }

  async acquire() {
    if (!this.path || process.platform !== 'darwin') return this;
    const deadline = this.monotonic() + this.waitSeconds;
    for (;;) {
      let descriptor;
      try {
        descriptor = tryExclusiveOpen(this.path);
      } catch {
        return this;
      }
      if (descriptor === null) {
        if (this.monotonic() >= deadline) return this;
        await this.sleep(0.05);
        continue;
      }
      this.descriptor = descriptor;
      this.acquired = true;
      this.previous = this.read();
      return this;
    }
  }

  read() {
    try {
      const buffer = Buffer.alloc(1024);
      const record = JSON.parse(buffer.subarray(0, fs.readSync(this.descriptor, buffer, 0, 1024, 0)).toString('utf8'));
      return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
    } catch {
      return null;
    }
  }

  /** Keep `outcome` for the next holder of the lock; true only when it is on disk whole. */
  record(outcome) {
    try {
      const data = Buffer.from(JSON.stringify(outcome));
      fs.ftruncateSync(this.descriptor, 0);
      // A short write (a file size limit) would leave a record nobody can read.
      if (fs.writeSync(this.descriptor, data, 0, data.length, 0) !== data.length) return false;
      const back = Buffer.alloc(data.length + 1);
      return back.subarray(0, fs.readSync(this.descriptor, back, 0, back.length, 0)).equals(data);
    } catch {
      return false;
    }
  }

  /** Closing the descriptor releases the lock. */
  release() {
    if (this.descriptor === null) return;
    fs.closeSync(this.descriptor);
    this.descriptor = null;
  }
}

/**
 * Executables of the two bundles LCU may stop a service from: the one it launches and the app's copy. A bundle
 * whose service executable resolves outside the bundle contributes nothing.
 */
export function knownServiceExecutables(env = process.env, realpath = (path) => { try { return fs.realpathSync(path); } catch { return path; } }) {
  const bundles = [env.SKY_CUA_SERVICE_PATH];
  if (env.CODEX_HOME) bundles.push(join(env.CODEX_HOME, 'computer-use', 'Codex Computer Use.app'));
  const executables = new Set();
  for (const bundle of bundles) {
    if (!bundle || !isAbsolute(bundle)) continue;
    const root = realpath(bundle);
    const executable = realpath(join(bundle, SERVICE_EXECUTABLE));
    if (basename(executable) === SKY_SERVICE_NAME && executable !== root && executable.startsWith(root.endsWith(sep) ? root : root + sep)) {
      executables.add(executable);
    }
  }
  return executables;
}

/** Existence probe with signal 0 (never delivers anything); pid must be a single process. */
export function processExists(pid) {
  if (!isPid(pid)) throw new Error('refusing to probe a non-process id');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

const sameSet = (set, value) => set instanceof Set && set.size === 1 && set.has(value);
const sameTimes = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Quit the one Computer Use service that is provably stale and holds the connection. In this order, and any
 * failed or inconclusive step means nothing is signaled:
 * 1. only this LCU host of the account is recovering (the peer lock, held through the exit wait);
 * 2. the process listing is complete and exactly one service started before its bundle was replaced;
 * 3. it is a single process (pid > 1, not this one) of the current user, named exactly SkyComputerUseService,
 *    whose path and kernel-reported executable are the one in a known bundle;
 * 4. this instance (pid and start time) was never asked to quit before;
 * 5. it is the only process holding the socket lock, and `codesign --verify` rejects its running code;
 * 6. the instance is recorded as asked (no record, no signal; the previous record is put back if no signal
 *    follows);
 * 7. last: the lock holders, the bundle's change times, then the process itself and its kernel executable all
 *    match what was checked, the recovery is within its time budget, and the requester is still waiting.
 * Then that one pid gets SIGTERM (never a group, never SIGKILL), it is given at most 3 seconds to exit, and one
 * line is logged. A pid can still be recycled in the instants between the last read and the signal; macOS has
 * no process handle that closes that gap.
 */
export async function recoverStaleService({
  lockPath, executables, uid = process.getuid(), diagnose = diagnoseSkyServices, readProcess = listSkyServices,
  changeTimes = bundleChangeTimes, verify = verifyServiceSignature, holders = lockHolders, kernelPath = executablePath,
  kill = (pid, signal) => process.kill(pid, signal), exists = processExists, realpath = knownRealpath,
  sleep = sleepSeconds, monotonic = monotonicSeconds, exclusive = () => new PeerLock(), waiting = () => false, log,
} = {}) {
  const nothing = (reason) => ({ ok: true, recovered: false, reason });
  const started = monotonic();
  let peer;
  let pid;
  let path;
  let exited = false;
  let elapsedMs;
  try {
    peer = await exclusive().acquire();
    if (!peer.acquired) return nothing('another LCU process is recovering');
    const diagnosis = await diagnose();
    if (diagnosis.unparsed) return nothing('the process listing was incomplete');
    // Only this account's services: another user's cannot hold this account's lock.
    const stale = diagnosis.services.filter((item) => item.stale && item.uid === uid);
    if (!stale.length) return nothing('no stale service');
    if (stale.length !== 1) return nothing('more than one stale service');
    const [service] = stale;
    ({ pid, path } = service);
    const start = service.started;
    if (!isPid(pid) || pid === process.pid) return nothing('not a single service process');
    if (basename(path) !== SKY_SERVICE_NAME || !executables.has(realpath(path))) {
      return nothing('the stale service is not in a known Computer Use bundle');
    }
    const kernel = await kernelPath(pid);
    if (!(kernel && basename(kernel) === SKY_SERVICE_NAME && realpath(kernel) === realpath(path))) {
      return nothing('the kernel does not report the known executable for the stale service');
    }
    const previous = peer.previous ?? {};
    // Never twice for one instance: a service that outlived SIGTERM is left alone.
    if (previous.pid === pid && previous.started === start) return nothing('this service was already asked to quit');
    if (!sameSet(await holders(lockPath), pid)) return nothing('the stale service is not the only holder of the socket lock');
    if (await verify(pid) !== 'invalid') {
      return nothing('the running service passes signature verification, or it could not be checked');
    }
    if (!peer.record({ pid, started: start })) return nothing('the attempt could not be recorded');
    let reason = null;
    try {
      if (!sameSet(await holders(lockPath), pid)) reason = 'the socket lock changed hands while it was being checked';
      else if (!sameTimes(changeTimes(path), service.bundleTimes)) reason = 'the service bundle changed while it was being checked';
      else {
        const { services: rows, unparsed } = await readProcess({ pid }); // the process itself, read last
        if (unparsed || rows.length !== 1 || rows[0].pid !== pid || rows[0].uid !== service.uid ||
            rows[0].started !== start || rows[0].path !== path || await kernelPath(pid) !== kernel) {
          reason = 'the service changed while it was being checked';
        } else if (monotonic() - started > SIGNAL_BUDGET_SECONDS) reason = 'the checks took too long to act on';
        else if (!waiting()) reason = 'the request stopped waiting for the recovery';
      }
    } catch (error) {
      reason = `check failed: ${String(error?.message ?? error).slice(0, 200)}`;
    }
    if (reason) {
      // Back to the previous record, so an instance asked earlier stays recorded.
      peer.record(peer.previous ?? {});
      return nothing(reason);
    }
    kill(pid, 'SIGTERM');
    try {
      const deadline = monotonic() + TERMINATE_WAIT_SECONDS;
      while (!exited && monotonic() < deadline) {
        exited = !exists(pid);
        if (!exited) await sleep(TERMINATE_POLL_SECONDS);
      }
    } finally {
      elapsedMs = Math.trunc((monotonic() - started) * 1000);
      log?.(`LCU macOS sent SIGTERM to stale Computer Use service pid ${pid} (${path}); ` +
        (exited ? `it exited after ${elapsedMs} ms` : `it did not exit within ${TERMINATE_WAIT_SECONDS} seconds`));
    }
  } catch (error) {
    return nothing(`check failed: ${String(error?.message ?? error).slice(0, 200)}`);
  } finally {
    peer?.release?.();
  }
  if (!exited) return nothing(`pid ${pid} did not exit within ${TERMINATE_WAIT_SECONDS} seconds of SIGTERM`);
  return { ok: true, recovered: true, pid, path, elapsed_ms: elapsedMs };
}

function knownRealpath(path) {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
}

/** The recovery for one requester, with this host's environment; never anything off macOS. */
export function recoverResponse(waiting = () => false, env = process.env) {
  if (process.platform !== 'darwin') return Promise.resolve({ ok: true, recovered: false, reason: 'not macOS' });
  return recoverStaleService({ lockPath: env.LCU_MAC_SERVICE_LOCK, executables: knownServiceExecutables(env), waiting,
    log: (line) => process.stderr.write(`${line}\n`) });
}

// The original helper starts the CUAService app and its XPC transport waits up to 5 s to connect, so a healthy
// run takes about 5.2 s. Allow for a slower launch. lcu/macos_sky_service.mjs derives its own wait from this value.
export const TURN_ENDED_CLI_TIMEOUT_SECONDS = 10;
// Turns still open when the host stops get this long, together, for their turn-ended commands.
export const STOP_TURN_ENDED_TIMEOUT_SECONDS = 8;
// Open turns the host remembers, oldest dropped first: as many as the Sky wrapper keeps turn metadata for.
const OPEN_TURN_LIMIT = 128;
// Log successful runs only when they are close to the helper's own 5 s deadline.
const TURN_ENDED_CLI_SLOW_SECONDS = 4.5;
const STDERR_LOG_BYTES = 512;

const turnEndedPayload = (sessionId, turnId) =>
  JSON.stringify({ type: 'agent-turn-complete', 'thread-id': sessionId, 'turn-id': turnId });

/**
 * Run the original turn-ended command; report slow or failed runs on stderr. The helper exits 0 even when it
 * cannot reach the service (it only writes to os_log), so a zero status does not prove delivery.
 */
export async function runTurnEnded(client, payload, { timeout = TURN_ENDED_CLI_TIMEOUT_SECONDS, slowSeconds = TURN_ENDED_CLI_SLOW_SECONDS } = {}) {
  const started = performance.now();
  const { status, stderr, failure } = await new Promise((resolve) => {
    const output = [];
    let child;
    try {
      child = track(spawn(client, ['turn-ended', payload], { stdio: ['ignore', 'ignore', 'pipe'] }));
    } catch (error) {
      resolve({ status: 'launch-failed', stderr: Buffer.from(error.message), failure: `could not start: ${error.code ?? error.message}` });
      return;
    }
    child.stderr.on('data', (chunk) => output.push(chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: 'timeout', stderr: Buffer.concat(output), failure: `timed out after ${timeout} seconds` });
    }, timeout * 1000);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ status: 'launch-failed', stderr: Buffer.from(error.message), failure: `could not start: ${error.code ?? error.message}` });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const exit = code ?? signal;
      resolve({ status: exit, stderr: Buffer.concat(output), failure: exit === 0 ? null : `exited with status ${exit}` });
    });
  });
  const elapsed = (performance.now() - started) / 1000;
  if (failure || elapsed >= slowSeconds) {
    const text = new TextDecoder().decode(stderr.subarray(0, STDERR_LOG_BYTES)).trim();
    process.stderr.write(`LCU macOS turn-ended command: exit=${status} elapsed=${Math.round(elapsed * 1000)} ms` +
      `${text ? ` stderr=${JSON.stringify(text)}` : ''}\n`);
  }
  if (failure) throw new Error(`Original turn-ended command ${failure}.`);
}

/** Read newline-delimited JSON requests from a socket; `next(limit)` resolves with the next parsed line. */
function lineReader(socket) {
  let buffered = Buffer.alloc(0);
  let waiter = null;
  let ended = null;
  const settle = () => {
    if (!waiter) return;
    const newline = buffered.indexOf(0x0a);
    if (newline > waiter.limit || (newline < 0 && buffered.length > waiter.limit)) {
      waiter.reject(new Error('Invalid macOS control request size or framing.'));
    } else if (newline >= 0) {
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      try {
        waiter.resolve(JSON.parse(line.toString('utf8')));
      } catch (error) {
        waiter.reject(error);
      }
    } else if (ended) {
      waiter.reject(ended);
    } else return;
    waiter = null;
  };
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    settle();
  });
  socket.on('end', () => {
    ended = new Error('macOS control connection closed before a complete request.');
    settle();
  });
  socket.on('error', (error) => {
    ended = error;
    settle();
  });
  return (limit = 4096) => new Promise((resolve, reject) => {
    waiter = { resolve, reject, limit };
    settle();
  });
}

const send = (socket, value) => new Promise((resolve) => {
  if (socket.destroyed || !socket.writable) {
    resolve(false);
    return;
  }
  socket.write(`${JSON.stringify(value)}\n`, (error) => resolve(!error));
});

function listen(address) {
  return new Promise((resolve, reject) => {
    // Half-open, so a requester that stops sending (or stops waiting) still gets its answer.
    const server = net.createServer({ allowHalfOpen: true });
    server.sockets = new Set();
    server.on('connection', (socket) => {
      server.sockets.add(socket);
      socket.on('close', () => server.sockets.delete(socket));
    });
    server.once('error', reject);
    server.listen(address, () => {
      server.off('error', reject);
      try {
        fs.chmodSync(address, 0o600);
      } catch (error) {
        server.close();
        reject(error);
        return;
      }
      // An accept error (EMFILE, for one) is reported; it must never end the `lcu` process.
      server.on('error', (error) => process.stderr.write(`LCU macOS host socket error: ${error.message}\n`));
      resolve(server);
    });
  });
}

const closeServer = (server, address) => new Promise((resolve) => {
  server.close(() => resolve());
  for (const socket of server.sockets) socket.destroy();
}).finally(() => fs.rmSync(address, { force: true }));

/** Route human control through the original trusted Sky service. */
class TrustedControlBridge {
  service = null;
  active = new Map();
  pending = new Map();
  serviceWaiters = new Set();

  async serve(address) {
    this.address = address;
    this.server = await listen(address);
    this.server.on('connection', (socket) => this.handle(socket));
  }

  /** Answer every waiting request at once, so nothing outlives the host. */
  async close() {
    this.closed = true;
    for (const wake of [...this.serviceWaiters]) wake();
    for (const answer of [...this.pending.values()]) answer({ ok: false, error: 'The LCU macOS host stopped.' });
    if (this.server) await closeServer(this.server, this.address);
  }

  async handle(socket) {
    socket.on('error', () => {});
    const next = lineReader(socket);
    let response;
    try {
      socket.setTimeout(3000, () => socket.destroy());
      const request = await next();
      if (request?.type === 'service') {
        socket.setTimeout(0);
        await this.serveService(socket, next);
        return;
      }
      socket.setTimeout(43_000, () => socket.destroy());
      response = await this.request(request);
    } catch (error) {
      response = { ok: false, error: String(error?.message ?? error).slice(0, 512) };
    }
    await send(socket, response);
    socket.end();
  }

  notifyService() {
    for (const wake of this.serviceWaiters) wake();
  }

  async serveService(socket, next) {
    if (this.service) {
      socket.destroy();
      return;
    }
    this.service = socket;
    this.notifyService();
    try {
      for (;;) {
        const message = await next(65536);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid trusted macOS control message.');
        if (message.type === 'context') {
          const { token, session_id: sessionId, turn_id: turnId, app } = message;
          if (typeof token !== 'string' || !token || typeof sessionId !== 'string' || !sessionId.trim() ||
              typeof turnId !== 'string' || !turnId.trim()) {
            throw new Error('Trusted macOS control context is missing IDs.');
          }
          if (app !== undefined && app !== null && (typeof app !== 'string' || !app.trim())) {
            throw new Error('Trusted macOS control context has an invalid app ID.');
          }
          this.active.set(token, { sessionId, turnId, app });
        } else if (message.type === 'context-ended') {
          this.active.delete(message.token);
        } else if (message.type === 'result') {
          this.pending.get(message.request_id)?.(message.response);
        } else {
          throw new Error('Unknown trusted macOS control message.');
        }
      }
    } catch {
      // the service disconnected or sent something invalid
    } finally {
      if (this.service === socket) {
        this.service = null;
        this.active.clear();
        for (const answer of this.pending.values()) answer({ ok: false, error: 'Trusted macOS control service disconnected.' });
      }
      socket.destroy();
    }
  }

  async request(request) {
    if (!request || typeof request !== 'object' || !['status', 'stop'].includes(request.type)) {
      throw new Error('Unsupported macOS control request.');
    }
    const { session_id: sessionId, turn_id: turnId, app } = request;
    if (typeof sessionId !== 'string' || !sessionId.trim() || typeof turnId !== 'string' || !turnId.trim()) {
      throw new Error('Real macOS control session and turn IDs are required.');
    }
    if (request.type === 'stop' && (typeof app !== 'string' || !app.trim())) {
      throw new Error('An application bundle ID is required to stop computer use.');
    }
    const deadline = Date.now() + 40_000;
    if (!this.service) {
      await new Promise((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.serviceWaiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, deadline - Date.now());
        this.serviceWaiters.add(wake);
      });
    }
    if (this.closed) throw new Error('The LCU macOS host stopped.');
    if (!this.service) throw new Error('Trusted macOS control service is not connected.');
    if (![...this.active.values()].some((context) => context.sessionId === sessionId && context.turnId === turnId)) {
      throw new Error('The requested session and turn are not active in the trusted runtime.');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Original macOS control request timed out.');
    const requestId = randomUUID();
    const message = { type: request.type, request_id: requestId, session_id: sessionId, turn_id: turnId,
      deadline_unix_ms: Date.now() + remaining };
    if (app !== undefined && app !== null) message.app = app;
    const answered = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), remaining);
      this.pending.set(requestId, (response) => {
        clearTimeout(timer);
        resolve({ response });
      });
    });
    try {
      if (!await send(this.service, message)) throw new Error('Trusted macOS control service is unavailable.');
      const answer = await answered;
      if (!answer) throw new Error('Original macOS control request timed out.');
      if (!answer.response || typeof answer.response !== 'object' || Array.isArray(answer.response)) {
        throw new Error('Trusted macOS control service returned an invalid response.');
      }
      return answer.response;
    } finally {
      this.pending.delete(requestId);
    }
  }
}

/**
 * Serve the private lifetime socket for one MCP connection: turn-ended IDs run the original client, a `turn`
 * request records a turn as open until then (see stop()), a `recover` request runs (or joins) the stale-service recovery off the request path. With `controlAddress`,
 * human control is routed through the trusted Sky service; a control socket that cannot start is reported and
 * the lifetime host keeps working. Resolves with `{address, stop()}` once the socket accepts connections.
 */
export async function startOriginalHost({ client, env = process.env, controlAddress, recover = recoverResponse }) {
  try {
    fs.accessSync(client, fs.constants.X_OK);
    if (!fs.statSync(client).isFile()) throw new Error('not a file');
  } catch {
    throw new Error('The selected original macOS computer-use client is incomplete.');
  }
  const base = fs.existsSync('/private/tmp') ? '/private/tmp' : tmpdir();
  const folder = fs.mkdtempSync(join(base, 'lcu-ml-'));
  const address = join(folder, 'lifetime.sock');
  const recovery = singleFlight((waiting) => recover(waiting, env), { waitSeconds: RECOVERY_WAIT_SECONDS });
  // Turns the Sky wrapper reported and no turn-ended request has named since. The wrapper's worker does not
  // survive js_reset or the server's exit, so a turn it held can end with no hook left to signal Sky, which then
  // keeps that turn's event taps; stop() runs the original command for each.
  const openTurns = new Map();
  let server;
  let bridge = null;
  try {
    server = await listen(address);
    if (controlAddress) {
      bridge = new TrustedControlBridge();
      try {
        await bridge.serve(controlAddress);
      } catch (error) {
        process.stderr.write(`LCU macOS user control unavailable: ${String(error?.message ?? error).slice(0, 256)}\n`);
        bridge = null;
      }
    }
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw new Error(`Original macOS lifecycle host failed to become ready: ${error.message}`);
  }
  server.on('connection', async (socket) => {
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => {});
    const next = lineReader(socket);
    let response;
    try {
      const request = await next();
      if (request?.type === 'recover') {
        // Off the request path: it waits on codesign, lsof and the service's exit.
        socket.setTimeout(0);
        let waiting = true;
        const stop = () => { waiting = false; };
        socket.on('data', stop).on('end', stop).on('close', stop).on('error', stop);
        const result = await recovery(() => waiting && !socket.destroyed);
        socket.setTimeout(3000, () => socket.destroy());
        await send(socket, result);
        socket.end();
        return;
      }
      const sessionId = request?.session_id;
      const turnId = request?.turn_id;
      if (typeof sessionId !== 'string' || !sessionId.trim() || typeof turnId !== 'string' || !turnId.trim()) {
        throw new Error('Original macOS turn IDs are missing.');
      }
      const key = JSON.stringify([sessionId, turnId]);
      if (request.type === 'turn') {
        openTurns.delete(key);
        openTurns.set(key, { sessionId, turnId });
        if (openTurns.size > OPEN_TURN_LIMIT) openTurns.delete(openTurns.keys().next().value);
        await send(socket, { ok: true });
        socket.end();
        return;
      }
      openTurns.delete(key);
      socket.setTimeout(0);
      await runTurnEnded(client, turnEndedPayload(sessionId, turnId));
      response = { notified: true };
    } catch (error) {
      response = { notified: false, error: String(error?.message ?? error).slice(0, 512) };
      process.stderr.write(`LCU macOS turn cleanup failed: ${response.error}\n`);
    }
    // A disconnected hook client must not stop the host.
    await send(socket, response);
    socket.end();
  });
  return {
    address,
    /**
     * End everything this host started: turns still open get their turn-ended command, bounded by
     * STOP_TURN_ENDED_TIMEOUT_SECONDS, then turn-ended commands and system tools are killed, waiting control
     * requests are answered, and recovery waits hold no timer, so `lcu` exits promptly after its server.
     */
    async stop() {
      const open = [...openTurns.values()];
      openTurns.clear();
      if (open.length) {
        process.stderr.write(`LCU macOS host: ending ${open.length} turn(s) still open at exit\n`);
        await Promise.allSettled(open.map(({ sessionId, turnId }) => runTurnEnded(client,
          turnEndedPayload(sessionId, turnId), { timeout: STOP_TURN_ENDED_TIMEOUT_SECONDS })));
      }
      for (const child of running) child.kill('SIGKILL');
      await Promise.all([closeServer(server, address), bridge?.close()]);
      fs.rmSync(folder, { recursive: true, force: true });
    },
  };
}
