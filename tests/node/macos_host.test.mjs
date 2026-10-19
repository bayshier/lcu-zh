import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  CODESIGN, LSOF, PS, PeerLock, SIGNAL_BUDGET_SECONDS, SIGNATURE_MISMATCH_MARKERS, SKY_SERVICE_NAME, TURN_ENDED_CLI_TIMEOUT_SECONDS,
  boundedRun, bundleChangeTimes, diagnoseSkyServices, executablePath, knownServiceExecutables, listSkyServices, lockHolders,
  parseProcessStart, parseProcessTable, processExists, recoverResponse, recoverStaleService, runTurnEnded, singleFlight,
  startOriginalHost, verifyServiceSignature,
} from '../../lcu/macos_host.mjs';
import { override, posixTests, temporary, write, mockWrite } from './fixtures.mjs';

const test = posixTests('the macOS lifetime host uses Unix sockets and sh stand-ins for ps, lsof and codesign');

// ---- the private lifetime host --------------------------------------------------------------------------

function request(address, value, { timeout = 8000, raw } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    let data = '';
    socket.setTimeout(timeout, () => { socket.destroy(); reject(new Error('timeout')); });
    socket.on('connect', () => socket.write(raw ?? `${JSON.stringify(value)}\n`));
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n')) {
        socket.end();
        resolve(JSON.parse(data.slice(0, data.indexOf('\n'))));
      }
    });
    socket.on('error', reject);
    socket.on('close', () => reject(new Error('closed without an answer')));
  });
}

const client = (t, body) => write(join(temporary(t), 'client'), `#!/bin/sh\n${body}\n`, 0o755);

test('the lifecycle host passes exact IDs to the original client and rejects missing ones', async (t) => {
  const base = temporary(t);
  const capture = join(base, 'argv');
  const host = await startOriginalHost({ client: client(t, `printf '%s\\n' "$@" > "${capture}"`) });
  t.after(() => host.stop());
  let logged = '';
  mockWrite(t, process.stderr, (text) => { logged += text; return true; });
  const malformed = await request(host.address, { session_id: '', turn_id: 'turn-exact' });
  assert.equal(malformed.notified, false);
  assert.match(malformed.error, /turn IDs are missing/);
  assert.match(logged, /turn cleanup failed/);
  assert.deepEqual(await request(host.address, { session_id: 'session-exact', turn_id: 'turn-exact' }), { notified: true });
  const [command, payload] = readFileSync(capture, 'utf8').trim().split('\n');
  assert.equal(command, 'turn-ended');
  assert.deepEqual(JSON.parse(payload), { type: 'agent-turn-complete', 'thread-id': 'session-exact', 'turn-id': 'turn-exact' });
});

test('the lifecycle host reports the original client’s failure, and waits for a helper as slow as the real one', async (t) => {
  mockWrite(t, process.stderr, () => true);
  const failing = await startOriginalHost({ client: client(t, 'exit 23') });
  t.after(() => failing.stop());
  const result = await request(failing.address, { session_id: 'session', turn_id: 'turn' });
  assert.equal(result.notified, false);
  assert.match(result.error, /status 23/);
  assert.ok(TURN_ENDED_CLI_TIMEOUT_SECONDS > 6);
  const slow = await startOriginalHost({ client: client(t, 'sleep 5.2') });
  t.after(() => slow.stop());
  const started = performance.now();
  assert.deepEqual(await request(slow.address, { session_id: 'session', turn_id: 'turn' }, { timeout: 13_000 }), { notified: true });
  assert.ok(performance.now() - started >= 5200);
});

test('an incomplete client is refused before anything listens', async (t) => {
  await assert.rejects(startOriginalHost({ client: join(temporary(t), 'missing') }), /client is incomplete/);
});

test('stopping the host ends its turn-ended commands and waiting control requests at once', async (t) => {
  const base = temporary(t);
  const control = join(base, 'control.sock');
  const started = join(base, 'started');
  mockWrite(t, process.stderr, () => true);
  const host = await startOriginalHost({ client: client(t, `echo $$ > "${started}"\nexec sleep 30`), controlAddress: control });
  const turn = request(host.address, { session_id: 's', turn_id: 't' }, { timeout: 20_000 }).catch((error) => error);
  // No trusted service is connected: this request would wait 40 s for one.
  const waiting = request(control, { type: 'status', session_id: 's', turn_id: 't' }, { timeout: 20_000 }).catch((error) => error);
  for (let i = 0; i < 100 && !existsSync(started); i += 1) await delay(20);
  assert.ok(existsSync(started), 'the turn-ended command is running');
  const stopping = performance.now();
  await host.stop();
  const [turnResult, waitingResult] = await Promise.all([turn, waiting]);
  assert.ok(performance.now() - stopping < 1000, 'stop() does not wait for the command or the request');
  assert.ok(turnResult instanceof Error || turnResult.notified === false);
  assert.ok(waitingResult instanceof Error || waitingResult.ok === false);
  assert.equal(existsSync(host.address), false);
  assert.equal(existsSync(control), false);
  const pid = Number(readFileSync(started, 'utf8'));
  await delay(100);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the turn-ended command was killed');
});

test('stopping the host first ends the turns the Sky wrapper reported and no turn-ended request named', async (t) => {
  const capture = join(temporary(t), 'ended');
  mockWrite(t, process.stderr, () => true);
  const host = await startOriginalHost({ client: client(t, `printf '%s\\n' "$2" >> "${capture}"`) });
  t.after(() => host.stop());
  for (const turn of ['open', 'ended', 'open']) {
    assert.deepEqual(await request(host.address, { type: 'turn', session_id: 'session', turn_id: turn }), { ok: true });
  }
  const malformed = await request(host.address, { type: 'turn', session_id: 'session' });
  assert.match(malformed.error, /turn IDs are missing/);
  assert.deepEqual(await request(host.address, { session_id: 'session', turn_id: 'ended' }), { notified: true });
  await host.stop();
  const ended = readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line)['turn-id']);
  assert.deepEqual(ended, ['ended', 'open'], 'the open turn ended once at stop, the ended one was not repeated');
});

async function turnEnded(t, path, options) {
  let log = '';
  const stderr = mockWrite(t, process.stderr, (text) => { log += text; return true; });
  const started = performance.now();
  let error = null;
  try {
    await runTurnEnded(path, '{}', options);
  } catch (caught) {
    error = caught;
  }
  stderr.mock.restore();
  return { error, log, elapsed: performance.now() - started };
}

test('a turn-ended command past its timeout fails within bounds and logs what it wrote', async (t) => {
  const { error, log, elapsed } = await turnEnded(t, client(t, 'printf "connect pending" >&2\nexec sleep 30'), { timeout: 1 });
  assert.match(error.message, /timed out after 1 seconds/);
  assert.ok(elapsed < 5000);
  assert.match(log, /exit=timeout elapsed=\d{4} ms/);
  assert.match(log, /connect pending/);
});

test('a failing turn-ended command logs its status and bounded stderr; one that cannot start is logged too', async (t) => {
  const noisy = await turnEnded(t, client(t, 'printf "%2000s" "" | tr " " e >&2\nexit 7'));
  assert.match(noisy.error.message, /status 7/);
  assert.match(noisy.log, /exit=7/);
  assert.ok(noisy.log.includes('e'.repeat(512)) && !noisy.log.includes('e'.repeat(513)));
  const missing = await turnEnded(t, join(temporary(t), 'missing-client'));
  assert.match(missing.error.message, /could not start/);
  assert.match(missing.log, /exit=launch-failed/);
});

test('a slow success is logged, a fast one is not', async (t) => {
  const slow = await turnEnded(t, client(t, 'sleep 0.4'), { slowSeconds: 0.2 });
  assert.equal(slow.error, null);
  assert.match(slow.log, /exit=0 elapsed=\d+ ms/);
  const fast = await turnEnded(t, client(t, 'exit 0'));
  assert.deepEqual([fast.error, fast.log], [null, '']);
});

function lineSocket(path) {
  const socket = net.createConnection(path);
  let buffered = '';
  const waiters = [];
  socket.on('data', (chunk) => {
    buffered += chunk;
    let at;
    while (waiters.length && (at = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      waiters.shift()(JSON.parse(line));
    }
  });
  socket.next = () => new Promise((resolve) => { waiters.push(resolve); socket.emit('data', ''); });
  return socket;
}

test('the control socket routes only to an active trusted session and turn', async (t) => {
  const control = join(temporary(t), 'control.sock');
  const host = await startOriginalHost({ client: client(t, 'exit 99'), controlAddress: control });
  t.after(() => host.stop());
  const service = lineSocket(control);
  t.after(() => service.destroy());
  service.write('{"type":"service"}\n{"type":"context","token":"tool-1","session_id":"session-exact","turn_id":"turn-exact","app":"Fixture App"}\n');
  await delay(50);
  const wrongTurn = await request(control, { type: 'status', session_id: 'session-exact', turn_id: 'other-turn' });
  assert.equal(wrongTurn.ok, false);
  assert.match(wrongTurn.error, /not active/);
  const wrongApp = request(control, { type: 'stop', session_id: 'session-exact', turn_id: 'turn-exact', app: 'com.other.App' });
  const forwarded = await service.next();
  assert.equal(forwarded.app, 'com.other.App');
  service.write(`${JSON.stringify({ type: 'result', request_id: forwarded.request_id, response: { ok: false, error: 'selected app is not targeted' } })}\n`);
  assert.match((await wrongApp).error, /not targeted/);
  const started = Date.now();
  const stop = request(control, { type: 'stop', session_id: 'session-exact', turn_id: 'turn-exact', app: 'com.fixture.App' });
  const command = await service.next();
  assert.deepEqual([command.type, command.session_id, command.turn_id, command.app], ['stop', 'session-exact', 'turn-exact', 'com.fixture.App']);
  assert.ok(command.deadline_unix_ms - started >= 39_000 && command.deadline_unix_ms - started <= 41_000);
  service.write(`${JSON.stringify({ type: 'result', request_id: command.request_id, response: { ok: true, result: { accepted: true } } })}\n`);
  assert.deepEqual(await stop, { ok: true, result: { accepted: true } });
});

test('an unusable control socket keeps the lifecycle host working and leaves the occupied path alone', async (t) => {
  const occupied = write(join(temporary(t), 'occupied-control.sock'), 'owned by another process');
  let logged = '';
  mockWrite(t, process.stderr, (text) => { logged += text; return true; });
  const host = await startOriginalHost({ client: client(t, 'exit 0'), controlAddress: occupied });
  t.after(() => host.stop());
  assert.match(logged, /user control unavailable/);
  assert.deepEqual(await request(host.address, { session_id: 'session', turn_id: 'turn' }), { notified: true });
  assert.equal(readFileSync(occupied, 'utf8'), 'owned by another process');
});

test('a slow recovery does not delay turn cleanup and sees whether its requester still waits', async (t) => {
  const releases = [];
  const recover = async (waiting) => {
    await new Promise((resolve) => releases.push(resolve));
    return { ok: true, recovered: false, reason: 'fixture', waiting: waiting() };
  };
  const host = await startOriginalHost({ client: client(t, 'exit 0'), recover });
  t.after(() => host.stop());
  const slow = request(host.address, { type: 'recover' });
  await delay(50);
  assert.deepEqual(await request(host.address, { session_id: 's', turn_id: 't' }), { notified: true });
  releases.shift()();
  assert.deepEqual(await slow, { ok: true, recovered: false, reason: 'fixture', waiting: true });
  const gone = await new Promise((resolve) => {
    const socket = net.createConnection(host.address, () => socket.end('{"type":"recover"}\n'));
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('close', () => resolve(data));
    setTimeout(() => releases.shift()(), 100);
  });
  assert.equal(JSON.parse(gone).waiting, false, 'a requester that closed its end is not waiting');
  mockWrite(t, process.stderr, () => true);
  assert.equal((await request(host.address, { type: 'diagnose' })).notified, false);
});

// ---- the stale service recovery -------------------------------------------------------------------------

const BUNDLE = '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app';
const EXECUTABLE = `${BUNDLE}/Contents/MacOS/${SKY_SERVICE_NAME}`;
const PLIST = `${BUNDLE}/Contents/Info.plist`;
const SEAL = `${BUNDLE}/Contents/_CodeSignature/CodeResources`;
const HOME_BUNDLE = '/Users/x/.codex/computer-use/Codex Computer Use.app';
const HOME_EXECUTABLE = `${HOME_BUNDLE}/Contents/MacOS/${SKY_SERVICE_NAME}`;
const LOCK = '/Users/x/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock.lock';
const EXECUTABLES = new Set([EXECUTABLE, HOME_EXECUTABLE]);
const STALE_START = 'Tue Oct  6 11:00:00 2026';
const REPLACED = 'Wed Oct 7 00:21:00 2026';

const epoch = (text) => parseProcessStart(text.split(/\s+/));
const ps = (...lines) => {
  const calls = [];
  const run = async (argv, options) => { calls.push({ argv, options }); return { status: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }; };
  run.calls = calls;
  return run;
};
const statWith = (times) => (path) => {
  if (!(path in times)) throw Object.assign(new Error(path), { code: 'ENOENT' });
  return { ctimeMs: (typeof times[path] === 'string' ? epoch(times[path]) : times[path]) * 1000 };
};
const wholeBundle = (executable, when) => {
  const contents = executable.replace(/\/MacOS\/[^/]+$/, '');
  return { [executable]: when, [`${contents}/Info.plist`]: when, [`${contents}/_CodeSignature/CodeResources`]: when };
};
const stalePids = (diagnosis) => diagnosis.services.filter((service) => service.stale).map((service) => service.pid).sort();
const replacedAt = (executable, stat) => { const times = bundleChangeTimes(executable, stat); return times && Math.min(...times); };

test('the process table: pid, start and a path with spaces; forged rows and fields are refused', () => {
  const { services, unparsed } = parseProcessTable(['    1 501 Tue Oct  6 08:00:00 2026     /sbin/launchd',
    `45404 501 Wed Oct  7 00:34:53 2026     ${EXECUTABLE}`, '  999 501 Wed Oct  7 01:00:00 2026     /usr/bin/ssh'].join('\n'));
  assert.deepEqual([services, unparsed], [[{ pid: 45404, uid: 501, path: EXECUTABLE, started: epoch('Wed Oct 7 00:34:53 2026') }], 0]);
  const fake = `999 501 Mon Jan  1 00:00:00 2026 ${EXECUTABLE}`;
  for (const separator of ['\u2028', '\u2029', '\x85', '\x0b', '\x0c', '\x1c', '\r']) {
    assert.deepEqual(parseProcessTable(`4242 501 Wed Oct  7 00:34:53 2026 /tmp/x${separator}${fake}`), { services: [], unparsed: 1 });
  }
  assert.deepEqual(parseProcessTable(`4242 501 Wed Oct\u2002 7 00:34:53 2026 ${EXECUTABLE}`), { services: [], unparsed: 1 });
  assert.deepEqual(parseProcessTable(`4242 501 Wed Oct  7 00:34:53 2026 ${EXECUTABLE}\r`).services.map((s) => s.pid), [4242]);
  for (const character of ['\x0b', '\x0c', '\x1c', '\x1f', '\x85', '\u2028', '\u2029', '\x00']) {
    assert.deepEqual(parseProcessTable(`4242 501 Wed Oct  7 00:34:53 2026 ${EXECUTABLE}${character}`), { services: [], unparsed: 1 });
  }
  assert.deepEqual(parseProcessTable(`4242 501 Wed Oct  7 00:34:53 2026 ${EXECUTABLE}  `).services.map((s) => s.path), [EXECUTABLE]);
  const accented = `/Users/Jos\u00e9/ChatGPT.app/Contents/MacOS/${SKY_SERVICE_NAME}`;
  assert.equal(parseProcessTable(`7 501 Wed Oct  7 00:34:53 2026 ${accented}`).services[0].path, accented);
  assert.deepEqual(parseProcessTable([`oops Wed Oct  7 00:34:53 2026 ${EXECUTABLE}`, `45404 501 Wed Smarch  7 00:34:53 2026 ${EXECUTABLE}`,
    `45405 501 Wed Oct  7 25:34:53 2026 ${EXECUTABLE}`, `45406 501 Wed Oct  7 00:34:53 2026 relative/${SKY_SERVICE_NAME}`,
    `45407 501 Wed Oct  7 00:34:53 2026 /x/${SKY_SERVICE_NAME}Helper`, `45408 ${SKY_SERVICE_NAME}`,
    `45409 x Wed Oct  7 00:34:53 2026 ${EXECUTABLE}`, 'garbage with no service name'].join('\n')), { services: [], unparsed: 7 });
  assert.equal(parseProcessStart('Sun Oct 25 02:30:00 2026'.split(' ')), 1792895400);
});

test('bundle times: the oldest of executable, plist and seal; anything missing is unknown', async () => {
  assert.equal(replacedAt(EXECUTABLE, statWith({ [EXECUTABLE]: 300, [PLIST]: 250, [SEAL]: 280 })), 250);
  const metadataOnly = statWith({ [EXECUTABLE]: 900, [PLIST]: 100, [SEAL]: 100 });
  assert.equal(replacedAt(EXECUTABLE, metadataOnly), 100);
  assert.deepEqual(stalePids(await diagnoseSkyServices({ run: ps(`45404 501 Thu Jan  1 00:10:00 1970 ${EXECUTABLE}`), stat: metadataOnly })), []);
  for (const present of [{ [EXECUTABLE]: 900 }, { [EXECUTABLE]: 900, [PLIST]: 900 }, { [EXECUTABLE]: 900, [SEAL]: 900 }, { [PLIST]: 250, [SEAL]: 250 }]) {
    assert.equal(replacedAt(EXECUTABLE, statWith(present)), null);
  }
  const diagnosis = await diagnoseSkyServices({ run: ps(`45404 501 Thu Jan  1 00:10:00 1970 ${EXECUTABLE}`), stat: statWith({ [EXECUTABLE]: 900 }) });
  assert.deepEqual([stalePids(diagnosis), diagnosis.services[0].bundleTimes], [[], null]);
  assert.equal(replacedAt(`/${SKY_SERVICE_NAME}`, statWith({ [`/${SKY_SERVICE_NAME}`]: 5 })), null);
});

test('ps is asked for one pid or all, in UTC, without a column limit, and a failure is an error', async (t) => {
  const run = ps(`4242 501 Tue Oct  6 11:00:00 2026 ${EXECUTABLE}`);
  override(t, process, 'env', { ...process.env, COLUMNS: '80', LC_ALL: 'fr_FR' });
  const { services } = await listSkyServices({ run, pid: 4242 });
  assert.deepEqual(run.calls[0].argv, ['/bin/ps', '-ww', '-p', '4242', '-o', 'pid=,uid=,lstart=,comm=']);
  assert.deepEqual(services.map((service) => service.pid), [4242]);
  const env = run.calls[0].options.env;
  assert.deepEqual([env.LC_TIME, env.LC_CTYPE, env.TZ, 'COLUMNS' in env, 'LC_ALL' in env], ['C', 'UTF-8', 'UTC', false, false]);
  const gone = async () => ({ status: 1, stdout: '', stderr: '' });
  assert.deepEqual(await listSkyServices({ run: gone, pid: 4242 }), { services: [], unparsed: 0 });
  await assert.rejects(diagnoseSkyServices({ run: gone, stat: statWith({}) }));
  await assert.rejects(listSkyServices({ run: async () => ({ status: 2, stdout: '', stderr: '' }), pid: 4242 }));
  const all = ps();
  await diagnoseSkyServices({ run: all, stat: statWith({}) });
  assert.deepEqual(all.calls[0].argv, ['/bin/ps', '-ww', '-axo', 'pid=,uid=,lstart=,comm=']);
});

test('diagnosis flags only services started before their bundle was replaced', async () => {
  const stat = statWith(wholeBundle(EXECUTABLE, REPLACED));
  assert.deepEqual(stalePids(await diagnoseSkyServices({ run: ps(`45404 501 ${STALE_START}   ${EXECUTABLE}`), stat })), [45404]);
  assert.deepEqual(stalePids(await diagnoseSkyServices({ run: ps(`45404 501 Wed Oct  7 00:34:53 2026 ${EXECUTABLE}`), stat })), []);
  assert.deepEqual(stalePids(await diagnoseSkyServices({ run: ps(`45404 501 Wed Oct  7 00:20:59 2026 ${EXECUTABLE}`), stat })), [],
    'a change within the start time resolution is not stale');
});

class FakeWorld {
  constructor({ pid = 4242, uid = 501, path = EXECUTABLE, start = STALE_START, holders, verdict = 'invalid', exitsAfter = 1 } = {}) {
    Object.assign(this, { pid, uid, path, start, verdict, exitsAfter, holderSet: holders ?? new Set([pid]), kills: [], polls: 0,
      clock: 0, logs: [], verified: [], kernel: path, events: [], order: [], lockPaths: [], selections: [],
      table: [FakeWorld.line(pid, uid, start, path)], afterCheck: null, onHolders: null, onTimes: null,
      stat: statWith(wholeBundle(path, REPLACED)) });
  }

  static line(pid, uid, start, path) {
    return `${pid} ${uid} ${start} ${path}`;
  }

  run(overrides = {}) {
    return recoverStaleService({
      lockPath: LOCK, executables: EXECUTABLES, uid: 501,
      diagnose: () => { this.order.push('ps'); this.selections.push(null); return diagnoseSkyServices({ run: ps(...this.table), stat: this.stat }); },
      readProcess: ({ pid }) => {
        this.order.push('ps-pid');
        this.selections.push(pid);
        return listSkyServices({ run: ps(...this.table.filter((line) => line.split(' ')[0] === String(pid))), pid });
      },
      changeTimes: (path) => { this.order.push('times'); this.onTimes?.(); return bundleChangeTimes(path, this.stat); },
      verify: async (pid) => {
        this.order.push('verify');
        this.verified.push(pid);
        this.afterCheck?.();
        if (this.verdict instanceof Error) throw this.verdict;
        return this.verdict;
      },
      holders: async (lockPath) => {
        this.order.push(`holders${this.lockPaths.length + 1}`);
        this.lockPaths.push(lockPath);
        this.onHolders?.(this.lockPaths.length);
        return this.holderSet === null ? null : new Set(this.holderSet);
      },
      kernelPath: async () => { this.order.push('kernel'); return this.kernel; },
      kill: (pid, signal) => { this.order.push('kill'); this.events.push('kill'); this.kills.push([pid, signal]); },
      exists: () => { this.events.push('poll'); this.polls += 1; return this.polls <= this.exitsAfter; },
      realpath: (path) => path, sleep: async (seconds) => { this.clock += seconds; }, monotonic: () => this.clock,
      waiting: () => true, exclusive: () => new Peer(), log: (line) => this.logs.push(line), ...overrides,
    });
  }
}

class Peer {
  constructor(acquired = true, previous = null, events = []) {
    Object.assign(this, { acquired, previous, events, recorded: [] });
  }

  async acquire() { this.events.push('enter'); return this; }
  release() { this.events.push('exit'); }
  record(outcome) { this.events.push('record'); this.recorded.push(outcome); return true; }
}

function nothingSignaled(world, result, reason) {
  assert.equal(result.recovered, false, JSON.stringify(result));
  assert.deepEqual(world.kills, [], 'no process may be signaled');
  assert.deepEqual(world.logs, []);
  if (reason) assert.ok(result.reason.includes(reason), `${result.reason} lacks ${reason}`);
}

test('a provably stale lock holder gets one SIGTERM and is waited for', async () => {
  const world = new FakeWorld({ exitsAfter: 3 });
  const result = await world.run();
  assert.deepEqual(world.kills, [[4242, 'SIGTERM']]);
  assert.deepEqual([result.recovered, result.pid, result.path], [true, 4242, EXECUTABLE]);
  assert.deepEqual(world.verified, [4242]);
  assert.deepEqual(world.selections, [null, 4242], 'the last process read is for that one pid');
  assert.deepEqual(world.lockPaths, [LOCK, LOCK]);
  assert.equal(world.logs.length, 1);
  assert.match(world.logs[0], new RegExp(`pid 4242 \\(${EXECUTABLE.replace(/[.()]/g, '\\$&')}\\); it exited after \\d+ ms`));
  assert.equal((await new FakeWorld({ path: HOME_EXECUTABLE }).run()).recovered, true, 'the app’s own copy is a known bundle too');
});

test('healthy, unverifiable, fresh, missing, foreign or unknown services are never signaled', async () => {
  for (const verdict of ['valid', 'unknown', new Error('codesign missing')]) {
    const world = new FakeWorld({ verdict });
    nothingSignaled(world, await world.run());
  }
  const fresh = new FakeWorld({ start: 'Wed Oct  7 00:34:53 2026' });
  nothingSignaled(fresh, await fresh.run(), 'no stale service');
  assert.deepEqual(fresh.verified, []);
  const none = new FakeWorld();
  none.table = [];
  nothingSignaled(none, await none.run(), 'no stale service');
  const broken = new FakeWorld();
  nothingSignaled(broken, await broken.run({ diagnose: async () => { throw new Error('ps timed out'); } }), 'check failed');
  for (const pid of [1, 0, process.pid]) {
    const world = new FakeWorld({ pid });
    nothingSignaled(world, await world.run());
  }
  for (const uid of [0, 502]) {
    const world = new FakeWorld({ uid });
    nothingSignaled(world, await world.run(), 'no stale service');
  }
  const renamed = new FakeWorld({ path: EXECUTABLE.replace(SKY_SERVICE_NAME, 'ChatGPT') });
  nothingSignaled(renamed, await renamed.run(), 'no stale service');
  const crafted = { unparsed: 0, services: [{ pid: 4242, uid: 501, path: EXECUTABLE.replace(SKY_SERVICE_NAME, 'ChatGPT'), started: 1, stale: true }] };
  const world = new FakeWorld();
  nothingSignaled(world, await world.run({ diagnose: async () => crafted }), 'known Computer Use bundle');
  for (const path of [`/Applications/Other.app/Contents/MacOS/${SKY_SERVICE_NAME}`, `/tmp/Codex Computer Use.app/Contents/MacOS/${SKY_SERVICE_NAME}`]) {
    const outside = new FakeWorld({ path });
    nothingSignaled(outside, await outside.run(), 'known Computer Use bundle');
  }
  const unknown = new FakeWorld();
  nothingSignaled(unknown, await unknown.run({ executables: new Set() }), 'known Computer Use bundle');
  const linked = new FakeWorld({ path: `/tmp/link/Contents/MacOS/${SKY_SERVICE_NAME}` });
  assert.equal((await linked.run({ realpath: (path) => (path.startsWith('/tmp/link') ? EXECUTABLE : path) })).recovered, true);
});

test('only one of this account’s stale services, holding the lock alone, is signaled', async () => {
  const other = new FakeWorld();
  other.table.push(FakeWorld.line(5151, 502, STALE_START, EXECUTABLE));
  assert.equal((await other.run()).recovered, true);
  assert.deepEqual(other.kills.map(([pid]) => pid), [4242]);
  const two = new FakeWorld();
  two.table.push(FakeWorld.line(5151, 501, STALE_START, EXECUTABLE));
  nothingSignaled(two, await two.run(), 'more than one');
  const healthy = new FakeWorld();
  healthy.table.push(FakeWorld.line(5151, 501, 'Wed Oct  7 00:34:53 2026', HOME_EXECUTABLE));
  healthy.stat = statWith({ ...wholeBundle(EXECUTABLE, REPLACED), ...wholeBundle(HOME_EXECUTABLE, 'Wed Oct 7 00:34:50 2026') });
  assert.equal((await healthy.run()).recovered, true);
  for (const holders of [new Set(), new Set([4242, 9999]), new Set([9999]), null]) {
    const world = new FakeWorld({ holders });
    if (holders === null) world.holderSet = null;
    nothingSignaled(world, await world.run(), 'only holder');
    assert.deepEqual(world.verified, [], 'the signature is not even checked without the lock');
  }
  const noLock = new FakeWorld();
  nothingSignaled(noLock, await noLock.run({ lockPath: undefined, holders: lockHolders }), 'only holder');
  const incomplete = new FakeWorld();
  incomplete.table.push(`5151 501 not-a-date ${HOME_EXECUTABLE}`);
  nothingSignaled(incomplete, await incomplete.run(), 'incomplete');
});

test('anything that changes between the checks and the signal stops it', async () => {
  for (const change of [
    (w) => { w.table = [FakeWorld.line(4242, 501, 'Wed Oct  7 00:40:00 2026', EXECUTABLE)]; },
    (w) => { w.table = [FakeWorld.line(4242, 501, STALE_START, HOME_EXECUTABLE)]; },
    (w) => { w.table = [FakeWorld.line(4242, 502, STALE_START, EXECUTABLE)]; },
    (w) => { w.table = []; },
    (w) => { w.table = [FakeWorld.line(7777, 501, STALE_START, EXECUTABLE)]; },
    (w) => { w.table = [FakeWorld.line(4242, 501, STALE_START, EXECUTABLE), FakeWorld.line(4242, 501, STALE_START, EXECUTABLE)]; },
    (w) => { w.table.push(`4242 501 not-a-date ${EXECUTABLE}`); },
    (w) => { w.kernel = '/bin/sleep'; },
  ]) {
    const world = new FakeWorld();
    world.stat = statWith({ ...wholeBundle(EXECUTABLE, REPLACED), ...wholeBundle(HOME_EXECUTABLE, REPLACED) });
    world.afterCheck = () => change(world);
    nothingSignaled(world, await world.run(), 'changed while');
  }
  for (const kernel of [null, '/bin/sleep', `/tmp/evil/Contents/MacOS/${SKY_SERVICE_NAME}`, `${HOME_EXECUTABLE}x`]) {
    const world = new FakeWorld();
    world.kernel = kernel;
    nothingSignaled(world, await world.run(), 'kernel');
  }
  for (const holders of [new Set([9999]), new Set([4242, 9999]), new Set()]) {
    const world = new FakeWorld();
    world.afterCheck = () => { world.holderSet = holders; };
    nothingSignaled(world, await world.run(), 'lock changed hands');
  }
  for (const hook of ['afterCheck', 'onTimes']) {
    const world = new FakeWorld();
    world[hook] = () => { world.clock += SIGNAL_BUDGET_SECONDS + 0.5; };
    nothingSignaled(world, await world.run(), 'too long');
  }
  const reused = new FakeWorld();
  reused.onHolders = (call) => {
    if (call === 2) {
      reused.table = [FakeWorld.line(4242, 501, 'Wed Oct  7 00:40:00 2026', '/usr/bin/other')];
      reused.kernel = '/usr/bin/other';
    }
  };
  nothingSignaled(reused, await reused.run(), 'changed while');
  for (const start of ['Wed Oct  7 00:40:00 2026', 'Tue Oct  6 12:00:00 2026']) {
    const world = new FakeWorld();
    world.onHolders = (call) => { if (call === 2) world.table = [FakeWorld.line(4242, 501, start, EXECUTABLE)]; };
    nothingSignaled(world, await world.run(), 'changed while');
  }
  const restored = new FakeWorld();
  restored.afterCheck = () => { restored.stat = statWith(wholeBundle(restored.path, 'Wed Oct 7 00:30:00 2026')); };
  nothingSignaled(restored, await restored.run(), 'bundle changed');
  const partly = new FakeWorld();
  partly.afterCheck = () => {
    partly.stat = statWith({ ...wholeBundle(partly.path, REPLACED), [partly.path]: 'Wed Oct 7 00:25:00 2026', [PLIST]: 'Wed Oct 7 00:26:00 2026' });
  };
  nothingSignaled(partly, await partly.run(), 'bundle changed');
  const vanished = new FakeWorld();
  vanished.afterCheck = () => { vanished.stat = statWith({}); };
  nothingSignaled(vanished, await vanished.run(), 'bundle changed');
});

test('the requester must still wait, asked once right before the signal; with none nothing is signaled', async () => {
  const world = new FakeWorld();
  nothingSignaled(world, await world.run({ waiting: () => false }), 'stopped waiting');
  const asked = [];
  const ok = new FakeWorld();
  await ok.run({ waiting: () => { asked.push([...ok.order]); return true; } });
  assert.deepEqual(asked, [ok.order.slice(0, ok.order.indexOf('kill'))]);
  const closed = new FakeWorld();
  nothingSignaled(closed, await closed.run({ waiting: () => { throw new Error('closed'); } }), 'check failed');
  const lone = new FakeWorld();
  nothingSignaled(lone, await lone.run({ waiting: undefined }), 'stopped waiting');
});

test('the final reads follow every slow step and the process is read last', async () => {
  const world = new FakeWorld();
  const peer = new Peer(true, null, world.order);
  assert.equal((await world.run({ exclusive: () => peer })).recovered, true);
  assert.deepEqual(world.order.slice(0, world.order.indexOf('kill') + 1),
    ['enter', 'ps', 'kernel', 'holders1', 'verify', 'record', 'holders2', 'times', 'ps-pid', 'kernel', 'kill']);
});

test('the peer lock: held until the service exits, recorded before the signal, cleared without one, never twice', async () => {
  const exiting = new FakeWorld({ exitsAfter: 3 });
  const held = new Peer(true, null, exiting.events);
  assert.equal((await exiting.run({ exclusive: () => held })).recovered, true);
  assert.deepEqual(exiting.events, ['enter', 'record', 'kill', 'poll', 'poll', 'poll', 'poll', 'exit']);
  const refused = new FakeWorld();
  nothingSignaled(refused, await refused.run({ exclusive: () => new Peer(false) }), 'another LCU');
  const asked = { pid: 4242, started: epoch(STALE_START) };
  const recorded = new Peer();
  await new FakeWorld().run({ exclusive: () => recorded });
  assert.deepEqual(recorded.recorded, [asked]);
  const stuck = new Peer();
  await new FakeWorld({ exitsAfter: 1e9 }).run({ exclusive: () => stuck });
  assert.deepEqual(stuck.recorded, [asked], 'a service that did not exit stays recorded as asked');
  for (const hook of ['onHolders', 'onTimes']) {
    const world = new FakeWorld();
    world[hook] = (call) => { if (call === undefined || call === 2) world.table = []; };
    const peer = new Peer();
    nothingSignaled(world, await world.run({ exclusive: () => peer }), 'changed while');
    assert.deepEqual(peer.recorded, [asked, {}]);
  }
  const earlier = { pid: 777, started: 5 };
  const kept = new Peer(true, earlier);
  nothingSignaled(new FakeWorld(), await new FakeWorld().run({ exclusive: () => kept, waiting: () => false }), 'stopped waiting');
  assert.deepEqual(kept.recorded.at(-1), earlier);
  const unwritable = new Peer();
  unwritable.record = () => false;
  const world = new FakeWorld();
  nothingSignaled(world, await world.run({ exclusive: () => unwritable }), 'could not be recorded');
  for (const wallclock of [0, 1e12, -1e12]) {
    const again = new FakeWorld();
    again.clock = wallclock;
    nothingSignaled(again, await again.run({ exclusive: () => new Peer(true, asked) }), 'already asked');
  }
  for (const other of [{ ...asked, pid: 9999 }, { ...asked, started: 1 }, {}, { pid: 4242 }]) {
    assert.equal((await new FakeWorld().run({ exclusive: () => new Peer(true, other) })).recovered, true);
  }
});

test('a host that stops mid-wait still logs the signal and leaves the attempt on record', async () => {
  const peer = new Peer();
  const world = new FakeWorld({ exitsAfter: 1e9 });
  const result = await world.run({ exclusive: () => peer, sleep: async () => { throw new Error('the host is going away'); } });
  assert.equal(result.recovered, false);
  assert.deepEqual([world.kills.length, world.logs.length], [1, 1]);
  assert.deepEqual(peer.recorded, [{ pid: 4242, started: epoch(STALE_START) }]);
});

test('a service that does not exit is waited for a bounded time and never force-killed; a failing probe is no recovery', async () => {
  const world = new FakeWorld({ exitsAfter: 1e9 });
  const result = await world.run();
  assert.deepEqual(world.kills, [[4242, 'SIGTERM']]);
  assert.match(result.reason, /did not exit/);
  assert.ok(world.clock <= 3.2 && world.polls <= 40);
  assert.match(world.logs[0], /did not exit/);
  const probe = new FakeWorld();
  const failed = await probe.run({ exists: () => { throw new Error('probe'); } });
  assert.deepEqual([failed.recovered, probe.kills.length, probe.logs.length], [false, 1, 1]);
  for (const pid of [0, 1, -1, -4242, true, '4242', null]) assert.throws(() => processExists(pid), /non-process id/);
});

test('off macOS nothing is looked for; on macOS the response passes the lock path and the requester', async (t) => {
  const run = t.mock.method(process, 'kill');
  override(t, process, 'platform', 'linux');
  assert.deepEqual(await recoverResponse(), { ok: true, recovered: false, reason: 'not macOS' });
  assert.equal(run.mock.callCount(), 0);
  assert.equal(await executablePath(process.pid), null);
  for (const pid of [0, 1, -1, true, '1', null]) assert.equal(await executablePath(pid), null);
  assert.deepEqual([PS, LSOF, CODESIGN], ['/bin/ps', '/usr/sbin/lsof', '/usr/bin/codesign']);
});

test('the kernel-reported executable is the Sky service among the process’s text mappings, not a library', async (t) => {
  override(t, process, 'platform', 'darwin');
  const lsof = (stdout) => async (argv) => {
    assert.deepEqual(argv, ['/usr/sbin/lsof', '-a', '-p', '4242', '-d', 'txt', '-Fn']);
    return { status: 0, stdout, stderr: '' };
  };
  const listing = `p4242\nftxt\nn/usr/lib/dyld\nftxt\nn${EXECUTABLE}\nftxt\nn/usr/lib/libSystem.B.dylib\n`;
  assert.equal(await executablePath(4242, { run: lsof(listing) }), EXECUTABLE);
  assert.equal(await executablePath(4242, { run: lsof('p4242\nftxt\nn/usr/lib/dyld\nftxt\nn/bin/sleep\n') }), null);
  assert.equal(await executablePath(4242, { run: lsof(`p4242\nn${EXECUTABLE}\nn${HOME_EXECUTABLE}\n`) }), null, 'two candidates is no answer');
  assert.equal(await executablePath(4242, { run: lsof(`p999\nn${EXECUTABLE}\n`) }), null);
});

const runWith = (status = 0, stdout = '', stderr = '') => {
  const calls = [];
  const run = async (argv, options) => { calls.push({ argv, options }); return { status, stdout, stderr }; };
  run.calls = calls;
  return run;
};
const failing = (message) => async () => { throw Object.assign(new Error(message), { code: 'ETIMEDOUT' }); };

test('codesign: only a running-versus-disk mismatch is invalid, with English messages', async () => {
  const healthy = runWith(0, '', '4242: valid on disk\n');
  assert.equal(await verifyServiceSignature(4242, { run: healthy }), 'valid');
  assert.deepEqual(healthy.calls[0].argv, ['/usr/bin/codesign', '--verify', '--strict', '4242']);
  assert.equal(healthy.calls[0].options.env.LC_TIME, 'C');
  assert.ok(Number.isInteger(healthy.calls[0].options.timeout));
  const mismatch = '4242: the code on disk does not match what is running';
  assert.equal(await verifyServiceSignature(4242, { run: runWith(1, '', mismatch) }), 'invalid');
  for (const run of [runWith(1, '', '4242: no such process'), runWith(1), runWith(1, '', '4242: invalid signature (code or signature have been modified)'),
    runWith(2, '', mismatch), runWith(3, '', mismatch), failing('timeout'), failing('missing')]) {
    assert.equal(await verifyServiceSignature(4242, { run }), 'unknown');
  }
  assert.deepEqual(SIGNATURE_MISMATCH_MARKERS, ['the code on disk does not match what is running']);
});

test('lsof: the lock holders only from a clean answer', async () => {
  assert.deepEqual(await lockHolders(LOCK, { run: runWith(0, '4242\n') }), new Set([4242]));
  assert.deepEqual(await lockHolders(LOCK, { run: runWith(0, '4242\n7\n') }), new Set([4242, 7]));
  assert.deepEqual(await lockHolders(LOCK, { run: runWith(1, '') }), new Set());
  const run = runWith(0, '4242\n');
  await lockHolders(LOCK, { run });
  assert.deepEqual(run.calls[0].argv, ['/usr/sbin/lsof', '-t', '--', LOCK]);
  for (const unclean of [runWith(2), runWith(0, 'lsof: WARNING\n'), runWith(1, '4242\n'), runWith(0, '4242\n', 'lsof: WARNING: can not stat()\n'),
    runWith(1, '', 'lsof: status error\n'), runWith(0, ''), failing('timeout')]) {
    assert.equal(await lockHolders(LOCK, { run: unclean }), null);
  }
  for (const path of [null, '', 'relative/computeruse.sock.lock']) assert.equal(await lockHolders(path, { run: runWith(0, '1\n') }), null);
});

test('system tools run with a bound even when the child cannot be killed in time', async () => {
  const result = await boundedRun(['/bin/sh', '-c', 'printf out; printf err >&2; exit 1'], { timeout: 2 });
  assert.deepEqual(result, { status: 1, stdout: 'out', stderr: 'err' });
  const started = performance.now();
  await assert.rejects(boundedRun(['/bin/sh', '-c', 'trap "" TERM; sleep 5'], { timeout: 0.2 }), (error) => error.code === 'ETIMEDOUT');
  assert.ok(performance.now() - started < 2500);
});

test('known executables: the configured service and the app’s copy, never one escaping its bundle', () => {
  const environment = { SKY_CUA_SERVICE_PATH: BUNDLE, CODEX_HOME: '/Users/x/.codex' };
  assert.deepEqual(knownServiceExecutables(environment, (path) => path), new Set([EXECUTABLE, HOME_EXECUTABLE]));
  assert.deepEqual(knownServiceExecutables({ SKY_CUA_SERVICE_PATH: 'relative.app' }), new Set());
  assert.deepEqual(knownServiceExecutables({}), new Set());
  const realBundle = '/real/ChatGPT/Codex Computer Use.app';
  const realpath = (path) => ({ [BUNDLE]: realBundle, [EXECUTABLE]: `${realBundle}/Contents/MacOS/${SKY_SERVICE_NAME}`,
    [HOME_EXECUTABLE]: `/Applications/Other.app/Contents/MacOS/${SKY_SERVICE_NAME}` })[path] ?? path;
  assert.deepEqual(knownServiceExecutables(environment, realpath), new Set([`${realBundle}/Contents/MacOS/${SKY_SERVICE_NAME}`]));
  for (const resolved of [`${realBundle}/Contents/MacOS/other`, realBundle]) {
    assert.deepEqual(knownServiceExecutables({ SKY_CUA_SERVICE_PATH: BUNDLE }, (path) => (path === BUNDLE ? realBundle : resolved)), new Set());
  }
});

/**
 * flock as macOS takes it through open(O_EXLOCK | O_NONBLOCK). Off macOS the kernel has no O_EXLOCK, so the
 * lock is simulated: a second open of a held path fails with EAGAIN until the holder's descriptor closes.
 */
function macLocks(t) {
  const flags = [];
  if (process.platform === 'darwin') return flags;
  override(t, process, 'platform', 'darwin');
  const held = new Map();
  const { openSync, closeSync } = fs;
  t.mock.method(fs, 'openSync', (path, flag, mode) => {
    if (typeof flag !== 'number' || !(flag & 0x20)) return openSync(path, flag, mode);
    flags.push(flag);
    if ([...held.values()].includes(path)) throw Object.assign(new Error('EAGAIN: resource temporarily unavailable'), { code: 'EAGAIN' });
    const descriptor = openSync(path, flag & ~0x20, mode);
    held.set(descriptor, path);
    return descriptor;
  });
  t.mock.method(fs, 'closeSync', (descriptor) => { held.delete(descriptor); return closeSync(descriptor); });
  return flags;
}

test('the peer lock is an flock taken with the open: a second holder waits a bounded time, the last outcome is handed on', async (t) => {
  const flags = macLocks(t);
  const path = join(temporary(t), 'recovery.lock');
  const first = await new PeerLock(path).acquire();
  assert.deepEqual([first.acquired, first.previous], [true, null]);
  if (flags.length) {
    const { O_RDWR, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    assert.equal(flags[0], O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | 0x20, 'O_EXLOCK | O_NONBLOCK, the lock Python hosts take');
  }
  let clock = 0;
  const second = await new PeerLock(path, { waitSeconds: 1, sleep: async (seconds) => { clock += seconds; }, monotonic: () => clock }).acquire();
  assert.equal(second.acquired, false);
  assert.ok(clock >= 1 && clock <= 1.1);
  assert.equal(first.record({ recovered: true, pid: 7, at: 5 }), true);
  first.release();
  const third = await new PeerLock(path).acquire();
  assert.deepEqual(third.previous, { recovered: true, pid: 7, at: 5 });
  third.record({ recovered: false, at: 9 });
  third.release();
  writeFileSync(path, 'not json');
  const fourth = await new PeerLock(path).acquire();
  assert.equal(fourth.previous, null);
  fourth.release();
  assert.deepEqual(readdirSync(join(path, '..')), ['recovery.lock'], 'no side files');
});

test('the peer lock never follows a link, needs its directory, and is never taken off macOS', async (t) => {
  const base = temporary(t);
  write(join(base, 'real'));
  symlinkSync(join(base, 'real'), join(base, 'link'));
  override(t, process, 'platform', 'linux');
  assert.equal(PeerLock.defaultPath(), null);
  assert.equal((await new PeerLock(join(base, 'linux.lock')).acquire()).acquired, false);
  macLocks(t);
  assert.equal((await new PeerLock(join(base, 'link'), { waitSeconds: 0 }).acquire()).acquired, false, 'a symlink is never followed');
  assert.equal((await new PeerLock(join(base, 'missing-dir/x.lock'), { waitSeconds: 0 }).acquire()).acquired, false);
  mkdirSync(join(base, 'short'));
  const lock = await new PeerLock(join(base, 'short/recovery.lock')).acquire();
  const real = fs.writeSync;
  const short = t.mock.method(fs, 'writeSync', (fd, data, offset, length, position) => real(fd, data, offset, Math.min(length, 5), position));
  assert.equal(lock.record({ signaled: true, recovered: false, pid: 4242 }), false, 'a short write is not a record');
  short.mock.restore();
  assert.equal(lock.record({ signaled: true }), true);
  lock.release();
});

test('single flight: a burst shares one run, the next burst runs again, a failure frees the flight', async () => {
  let runs = 0;
  let release;
  const flight = singleFlight(() => { runs += 1; return new Promise((resolve) => { release = () => resolve({ ok: true, run: runs }); }); });
  const burst = Array.from({ length: 8 }, () => flight());
  await delay(10);
  release();
  assert.deepEqual(await Promise.all(burst), Array(8).fill({ ok: true, run: 1 }));
  const next = flight();
  await delay(10);
  release();
  assert.equal((await next).run, 2);
  const seen = [];
  assert.deepEqual(await singleFlight((...args) => { seen.push(args); return { ok: true }; })('leader'), { ok: true });
  assert.deepEqual(seen, [['leader']]);
  let calls = 0;
  const flaky = singleFlight(() => { calls += 1; if (calls === 1) throw new Error('boom'); return { ok: true }; }, { waitSeconds: 0.1 });
  await assert.rejects(flaky(), /boom/);
  assert.deepEqual(await flaky(), { ok: true });
});
