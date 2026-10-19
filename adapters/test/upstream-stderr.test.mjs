import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyUpstreamStderr, drainUpstreamStderr, UPSTREAM_STDERR_EVENT_LIMIT } from '../client.mjs';
import { MAX_FILE_BYTES } from '../diagnostics.mjs';

const clientUrl = pathToFileURL(fileURLToPath(new URL('../client.mjs', import.meta.url))).href;
const fixture = fileURLToPath(new URL('./stderr-fixture.mjs', import.meta.url));
const MARKER = 'RAW-STDERR-TEXT-5f1c';

// Pi, OMP and Hermes load createCuaClient in-process; this child stands in for such a harness.
const harness = `
const { createCuaClient } = await import(${JSON.stringify(clientUrl)});
const bridge = createCuaClient({ command: [process.execPath, ${JSON.stringify(fixture)}], adapter: 'pi' });
await bridge.connect();
const host = await bridge.call('js', { code: 'approval-native-host' }, { sessionId: 's', turnId: 't' });
await bridge.turnEnded({ sessionId: 's', turnId: 't' });
await bridge.close();
process.stdout.write(JSON.stringify({ host: JSON.parse(host.content[0].text) }));
`;

function runHarness(env, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', harness], {
      env: { ...process.env, LCU_STDERR_MARKER: MARKER, LCU_ALLOW_AGENT_HOST_APPROVAL: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`harness did not finish within ${timeout} ms (stderr pipe not drained?)`));
    }, timeout);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const events = directory => readdirSync(directory).flatMap(name =>
  readFileSync(join(directory, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));

test('known stderr lines are classified by prefix, with numbers only', () => {
  assert.deepEqual(classifyUpstreamStderr('LCU macOS turn-ended command: exit=0 elapsed=5382 ms'),
    { kind: 'turn_ended_slow', exit_code: 0, elapsed_ms: 5382, has_stderr: false });
  assert.deepEqual(classifyUpstreamStderr("LCU macOS turn-ended command: exit=2 elapsed=40 ms stderr='boom'"),
    { kind: 'turn_ended_failed', exit_code: 2, elapsed_ms: 40, has_stderr: true });
  assert.deepEqual(classifyUpstreamStderr('LCU macOS turn-ended command: exit=timeout elapsed=10004 ms'),
    { kind: 'turn_ended_failed', exit_code: undefined, timed_out: true, elapsed_ms: 10004, has_stderr: false });
  assert.equal(classifyUpstreamStderr('LCU macOS turn-ended command: exit=launch-failed elapsed=1 ms').launch_failed, true);
  assert.deepEqual(classifyUpstreamStderr('LCU macOS turn cleanup failed: x'), { kind: 'turn_cleanup_failed' });
  assert.deepEqual(classifyUpstreamStderr('LCU macOS user control unavailable: x'), { kind: 'user_control_unavailable' });
  assert.deepEqual(classifyUpstreamStderr('LCU macOS control channel unavailable: x'), { kind: 'user_control_unavailable' });
  assert.deepEqual(classifyUpstreamStderr('LCU macOS control request failed: x'), { kind: 'control_request_failed' });
  assert.deepEqual(classifyUpstreamStderr(
    'LCU macOS sent SIGTERM to stale Computer Use service pid 9 (/A (b); c); it exited after 37 ms'),
  { kind: 'stale_service_recovery', exited: true, elapsed_ms: 37 });
  assert.deepEqual(classifyUpstreamStderr(
    'LCU macOS sent SIGTERM to stale Computer Use service pid 9 (/A); it did not exit within 5 seconds'),
  { kind: 'stale_service_recovery', exited: false, elapsed_ms: undefined });
  assert.deepEqual(classifyUpstreamStderr('LCU macOS turn cleanup step "CLI turn-ended" took 1200 ms'),
    { kind: 'cleanup_step_slow', elapsed_ms: 1200, still_running: false });
  assert.deepEqual(classifyUpstreamStderr(
    'LCU macOS turn cleanup step "native IPC turn-ended" is still running after 5001 ms'),
  { kind: 'cleanup_step_slow', elapsed_ms: 5001, still_running: true });
  assert.deepEqual(classifyUpstreamStderr(
    'LCU macOS turn cleanup: original turn-ended command failed for s/t after 90 ms (x); retrying once at the next Sky request'),
  { kind: 'turn_ended_failed', elapsed_ms: 90, retry: true });
  assert.equal(classifyUpstreamStderr('LCU: the original node_repl started its sandbox in a way ...').kind, 'sandbox_refused');
  assert.equal(classifyUpstreamStderr('LCU: sandbox note').kind, 'sandbox_note');
  assert.deepEqual(classifyUpstreamStderr('anything'), { kind: 'other' });
});

test('in-process harness: upstream stderr stays off the terminal and is logged as classified events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-stderr-log-'));
  try {
    const run = await runHarness({ LCU_LOG_DIR: directory, LCU_DIAGNOSTIC_LOG: '' });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.deepEqual(JSON.parse(run.stdout), { host: { action: 'decline' } });
    const [name] = readdirSync(directory);
    assert.match(name, /^pi-.*\.jsonl$/);
    assert.equal(readFileSync(join(directory, name), 'utf8').includes(MARKER), false);
    const stderrEvents = events(directory).filter(entry => entry.event === 'upstream_stderr')
      .map(({ t, event, ...fields }) => fields);
    assert.deepEqual(stderrEvents, [
      { kind: 'turn_ended_slow', exit_code: 0, elapsed_ms: 5382, has_stderr: false },
      { kind: 'turn_ended_failed', exit_code: 1, elapsed_ms: 812, has_stderr: true },
      { kind: 'turn_ended_failed', timed_out: true, elapsed_ms: 10004, has_stderr: false },
      { kind: 'turn_cleanup_failed' },
      { kind: 'user_control_unavailable' },
      { kind: 'stale_service_recovery', exited: true, elapsed_ms: 37 },
      { kind: 'cleanup_step_slow', elapsed_ms: 5120, still_running: false },
      { kind: 'other' },
    ]);
    assert.equal(events(directory).find(entry => entry.event === 'approval_open').kind, 'agent_host_refused');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('LCU_DIAGNOSTIC_LOG=0: upstream stderr is neither logged nor shown', async () => {
  const directory = join(mkdtempSync(join(tmpdir(), 'lcu-stderr-off-')), 'logs');
  try {
    const run = await runHarness({ LCU_LOG_DIR: directory, LCU_DIAGNOSTIC_LOG: '0' });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.equal(existsSync(directory), false);
  } finally {
    rmSync(join(directory, '..'), { recursive: true, force: true });
  }
});

test('a flood of upstream stderr is drained without blocking and logged within a bound', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-stderr-flood-'));
  try {
    const run = await runHarness({ LCU_LOG_DIR: directory, LCU_DIAGNOSTIC_LOG: '', LCU_STDERR_FLOOD_BYTES: String(4 * 1024 * 1024) });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stderr, '');
    const [name] = readdirSync(directory);
    const path = join(directory, name);
    assert.ok(statSync(path).size < MAX_FILE_BYTES / 4, `log is ${statSync(path).size} bytes`);
    assert.equal(readFileSync(path, 'utf8').includes(MARKER), false);
    const all = events(directory);
    assert.equal(all.filter(entry => entry.event === 'upstream_stderr').length, UPSTREAM_STDERR_EVENT_LIMIT);
    assert.deepEqual(all.filter(entry => entry.event === 'upstream_stderr_limit').map(entry => entry.limit),
      [UPSTREAM_STDERR_EVENT_LIMIT]);
    const dropped = all.find(entry => entry.event === 'upstream_stderr_dropped');
    assert.ok(dropped?.lines > 10_000, JSON.stringify(dropped));
    // Calls after the flood are still recorded.
    assert.ok(all.some(entry => entry.event === 'turn_end'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('drainUpstreamStderr splits chunks into lines, bounds long lines and keeps a short tail', () => {
  const recorded = [];
  const stream = new PassThrough();
  const drain = drainUpstreamStderr(stream, { event: (type, fields) => recorded.push([type, fields]) }, { limit: 3 });
  stream.write('LCU macOS turn-ended command: exit=0 ela');
  stream.write('psed=4600 ms\r\n\nsecond\n');
  stream.write(`${'z'.repeat(20_000)}`);
  stream.write(`${'z'.repeat(20_000)}\nthird\nfourth\n`);
  stream.end('fifth');
  return new Promise(resolve => stream.on('end', resolve)).then(() => {
    assert.deepEqual(recorded, [
      ['upstream_stderr', { kind: 'turn_ended_slow', exit_code: 0, elapsed_ms: 4600, has_stderr: false }],
      ['upstream_stderr', { kind: 'other' }],
      ['upstream_stderr', { kind: 'other' }],
      ['upstream_stderr_limit', { limit: 3 }],
      ['upstream_stderr_dropped', { lines: 3 }],
    ]);
    assert.ok(drain.tail().length <= 1000);
    assert.match(drain.tail(), /third\nfourth\nfifth$/);
  });
});
