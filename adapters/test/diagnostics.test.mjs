import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diagnosticLogDirectory, MAX_FILE_BYTES, MAX_TOTAL_BYTES, openDiagnosticLog, RETENTION_DAYS,
} from '../diagnostics.mjs';

const DAY = 24 * 60 * 60 * 1000;
const scratch = () => mkdtempSync(join(tmpdir(), 'lcu-diaglog-test-'));
const lines = path => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

function seed(directory, name, { size = 10, ageMs = 0 } = {}) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, 'x'.repeat(size));
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
  return path;
}

test('the constants are the documented retention policy', () => {
  assert.deepEqual([RETENTION_DAYS, MAX_TOTAL_BYTES, MAX_FILE_BYTES], [7, 20 * 1024 * 1024, 2 * 1024 * 1024]);
});

test('the log directory follows the platform, XDG_STATE_HOME and LCU_LOG_DIR', () => {
  // Paths are joined with the running host's separator, so expect the same join.
  assert.equal(diagnosticLogDirectory({ env: {}, platform: 'darwin', home: '/h' }), join('/h', 'Library', 'Logs', 'LCU'));
  assert.equal(diagnosticLogDirectory({ env: {}, platform: 'linux', home: '/h' }), join('/h', '.local', 'state', 'lcu', 'logs'));
  assert.equal(diagnosticLogDirectory({ env: { XDG_STATE_HOME: '/s' }, platform: 'linux', home: '/h' }), join('/s', 'lcu', 'logs'));
  assert.equal(diagnosticLogDirectory({ env: { LCU_LOG_DIR: '/o', XDG_STATE_HOME: '/s' }, platform: 'darwin', home: '/h' }), '/o');
});

test('LCU_DIAGNOSTIC_LOG=0 creates no directory and no file and prunes nothing', () => {
  const home = scratch();
  const directory = join(home, 'logs');
  const old = seed(directory, 'claude-20200101T000000Z-1.jsonl', { ageMs: 30 * DAY });
  const log = openDiagnosticLog({ adapter: 'claude', env: { LCU_LOG_DIR: directory, LCU_DIAGNOSTIC_LOG: '0' }, home });
  log.event('call_start', { call: 1 });
  assert.equal(log.path, undefined);
  assert.deepEqual(readdirSync(directory), ['claude-20200101T000000Z-1.jsonl']);
  assert.ok(existsSync(old));
  const missing = join(home, 'never');
  openDiagnosticLog({ adapter: 'claude', env: { LCU_LOG_DIR: missing, LCU_DIAGNOSTIC_LOG: '0' }, home });
  assert.equal(existsSync(missing), false);
  rmSync(home, { recursive: true, force: true });
});

test('a log is one JSONL file per process with a UTC name and valid event lines', () => {
  const home = scratch();
  const log = openDiagnosticLog({
    adapter: 'claude', env: { LCU_LOG_DIR: join(home, 'l') }, home,
    now: () => Date.UTC(2026, 9, 5, 12, 34, 56, 789), pid: 4242,
  });
  log.event('call_start', { call: 1, tool: 'js', timeout_ms: 5, ignored: { nested: true }, event: 'spoof', t: 'spoof' });
  assert.match(log.path, /claude-20261005T123456Z-4242\.jsonl$/);
  const records = lines(log.path);
  assert.equal(records[0].event, 'log_open');
  assert.equal(records[0].pid, 4242);
  assert.equal(records[0].retention_days, 7);
  assert.deepEqual(records[1], { t: '2026-10-05T12:34:56.789Z', event: 'call_start', call: 1, tool: 'js', timeout_ms: 5 });
  rmSync(home, { recursive: true, force: true });
});

test('opening prunes files older than seven days and leaves unrelated files alone', () => {
  const home = scratch();
  const directory = join(home, 'l');
  const stale = seed(directory, 'claude-20200101T000000Z-1.jsonl', { ageMs: 8 * DAY });
  const fresh = seed(directory, 'claude-20260101T000000Z-2.jsonl', { ageMs: 6 * DAY });
  const foreign = seed(directory, 'notes.jsonl', { ageMs: 90 * DAY });
  const upper = seed(directory, 'Claude-20200101T000000Z-9.jsonl', { ageMs: 90 * DAY });
  const log = openDiagnosticLog({ adapter: 'client', env: { LCU_LOG_DIR: directory }, home });
  assert.equal(existsSync(stale), false);
  assert.ok(existsSync(fresh) && existsSync(foreign) && existsSync(upper) && existsSync(log.path));
  rmSync(home, { recursive: true, force: true });
});

test('opening trims the oldest logs past the total budget and keeps the newest', () => {
  const home = scratch();
  const directory = join(home, 'l');
  const mib = 1024 * 1024;
  const oldest = seed(directory, 'claude-20260101T000000Z-1.jsonl', { size: 8 * mib, ageMs: 5 * DAY });
  const middle = seed(directory, 'claude-20260101T000000Z-2.jsonl', { size: 8 * mib, ageMs: 3 * DAY });
  const newest = seed(directory, 'claude-20260101T000000Z-3.jsonl', { size: 8 * mib, ageMs: 1 * DAY });
  const foreign = seed(directory, 'big.bin', { size: 30 * mib, ageMs: 6 * DAY });
  openDiagnosticLog({ adapter: 'client', env: { LCU_LOG_DIR: directory }, home });
  assert.equal(existsSync(oldest), false);
  assert.ok(existsSync(middle) && existsSync(newest) && existsSync(foreign));
  rmSync(home, { recursive: true, force: true });
});

test('a file stops at its size cap with one log_full line and drops later events', () => {
  const home = scratch();
  const log = openDiagnosticLog({ adapter: 'claude', env: { LCU_LOG_DIR: join(home, 'l') }, home });
  const filler = 'a'.repeat(190);
  for (let index = 0; index < 20_000; index++) log.event('call_start', { call: index, tool: filler });
  const size = statSync(log.path).size;
  const records = lines(log.path);
  assert.equal(records.filter(record => record.event === 'log_full').length, 1);
  assert.equal(records.at(-1).event, 'log_full');
  assert.ok(size >= MAX_FILE_BYTES && size < MAX_FILE_BYTES + 1024);
  log.event('call_end', { call: 1 });
  assert.equal(statSync(log.path).size, size);
  rmSync(home, { recursive: true, force: true });
});

test('the directory is private and the file readable by its owner only', { skip: process.platform === 'win32' }, () => {
  const home = scratch();
  const directory = join(home, 'new', 'l');
  chmodSync(home, 0o755);
  const log = openDiagnosticLog({ adapter: 'claude', env: { LCU_LOG_DIR: directory }, home });
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(log.path).mode & 0o777, 0o600);
  const existing = join(home, 'existing');
  mkdirSync(existing, { mode: 0o755 });
  chmodSync(existing, 0o755);
  openDiagnosticLog({ adapter: 'claude', env: { LCU_LOG_DIR: existing }, home });
  assert.equal(statSync(existing).mode & 0o777, 0o700);
  rmSync(home, { recursive: true, force: true });
});

test('an unwritable location disables the log without throwing', () => {
  const home = scratch();
  const blocker = join(home, 'file');
  writeFileSync(blocker, '');
  const log = openDiagnosticLog({ adapter: 'claude', env: { LCU_LOG_DIR: join(blocker, 'logs') }, home });
  assert.equal(log.path, undefined);
  assert.doesNotThrow(() => log.event('call_start', { call: 1 }));
  rmSync(home, { recursive: true, force: true });
});
