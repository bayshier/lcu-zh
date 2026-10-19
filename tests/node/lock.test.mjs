// Locks between LCU processes (lock.mjs): kernel flocks on POSIX, compatible with earlier releases' fcntl.flock.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { acquire, installLockPath, withLock } from '../../lcu/lock.mjs';
import { REPO, override, temporary } from './fixtures.mjs';

const LOCK = pathToFileURL(join(REPO, 'lcu/lock.mjs')).href;
const WINDOWS = process.platform === 'win32';
/** POSIX flock files stay in place; the Windows lock is an exclusively created file that its release removes. */
const WINDOWS_LOCK = 'the lock file stays on POSIX and is removed on release on Windows';
const python = spawnSync('python3', ['-c', 'import fcntl'], { stdio: 'ignore' }).status === 0;

/** A Node process holding the lock at `path` until its stdin closes (or it is killed). */
async function holder(t, path) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquire } from ${JSON.stringify(LOCK)};
    await acquire(${JSON.stringify(path)}); console.log('held'); process.stdin.resume();`], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((done) => child.stdout.once('data', done));
  return child;
}

async function contention(t, windows) {
  const base = temporary(t);
  const path = join(base, 'setup.lock');
  const log = join(base, 'log');
  writeFileSync(log, '');
  const platform = windows && !WINDOWS ? "Object.defineProperty(process, 'platform', { value: 'win32' });" : '';
  const worker = `${platform} import { appendFileSync } from 'node:fs'; const { withLock } = await import(${JSON.stringify(LOCK)});
    for (let i = 0; i < 8; i += 1) await withLock(${JSON.stringify(path)}, async () => {
      appendFileSync(${JSON.stringify(log)}, 'in\\n'); await new Promise((r) => setTimeout(r, 5)); appendFileSync(${JSON.stringify(log)}, 'out\\n');
    });`;
  const runs = Array.from({ length: 4 }, () => new Promise((done) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker], { stdio: ['ignore', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('close', (code, signal) => done({ code, signal, stderr }));
  }));
  const results = await Promise.all(runs);
  assert.deepEqual(results.map((run) => run.code), [0, 0, 0, 0], JSON.stringify(results, null, 2));
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 64);
  for (let index = 0; index < lines.length; index += 2) assert.deepEqual(lines.slice(index, index + 2), ['in', 'out'], `overlap at ${index}`);
  assert.equal(existsSync(path), !windows, WINDOWS_LOCK);
  assert.equal(existsSync(`${path}.takeover`), false);
}

test('processes take the lock one at a time and the lock file stays in place', (t) => contention(t, WINDOWS));
test('Windows lock files: processes take the lock one at a time', { skip: WINDOWS && 'the test above runs it' }, (t) => contention(t, true));

test('a holder that is killed releases the lock', async (t) => {
  const path = join(temporary(t), 'setup.lock');
  const child = await holder(t, path);
  await assert.rejects(acquire(path, { wait: 200, waiting: () => {} }), /stayed locked/);
  child.kill('SIGKILL');
  await new Promise((done) => child.once('close', done));
  const release = await acquire(path, { wait: 2000 });
  release();
  assert.equal(existsSync(path), !WINDOWS, WINDOWS_LOCK);
});

test('a bounded wait says once that it is waiting, then gives up with the caller\'s error', async (t) => {
  const path = join(temporary(t), 'origins.lock');
  const child = await holder(t, path);
  let told = 0;
  await assert.rejects(acquire(path, { wait: 1300, waiting: () => { told += 1; }, busy: () => new Error('busy now') }), /busy now/);
  assert.equal(told, 1);
  child.stdin.end();
  await new Promise((done) => child.once('close', done));
  assert.equal(await withLock(path, async () => 'ran'), 'ran');
});

test('the lock excludes, and is excluded by, an earlier release\'s fcntl.flock', { skip: !python && 'python3 is not available' }, async (t) => {
  const path = join(temporary(t), '.lcu-install');
  writeFileSync(path, '');
  const child = spawn('python3', ['-c', 'import fcntl, sys\nf = open(sys.argv[1], "a")\nfcntl.flock(f, fcntl.LOCK_EX)\nprint("held", flush=True)\nsys.stdin.read()', path],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((done) => child.stdout.once('data', done));
  await assert.rejects(acquire(path, { wait: 300, waiting: () => {} }), /stayed locked/);
  child.stdin.end();
  await new Promise((done) => child.once('close', done));
  const release = await acquire(path, { wait: 2000 });
  const probe = spawnSync('python3', ['-c', 'import fcntl, sys\nf = open(sys.argv[1], "a")\ntry:\n    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept OSError:\n    sys.exit(3)', path]);
  assert.equal(probe.status, 3, 'python could take the lock Node holds');
  release();
  assert.equal(spawnSync('python3', ['-c', 'import fcntl, sys\nfcntl.flock(open(sys.argv[1], "a"), fcntl.LOCK_EX | fcntl.LOCK_NB)', path]).status, 0);
});

test('install, update and prune lock the install marker itself on POSIX', () => {
  assert.equal(installLockPath('/opt/lcu'), process.platform === 'win32' ? join('/opt/lcu', '.lcu-install.lock') : '/opt/lcu/.lcu-install');
});

test('Windows: an exclusive lock file; one left by a process that is gone is taken over', async (t) => {
  override(t, process, 'platform', 'win32');
  const path = join(temporary(t), '.lcu-install.lock');
  const release = await acquire(path, { wait: 0 });
  await assert.rejects(acquire(path, { wait: 100, waiting: () => {} }), /stayed locked/);
  release();
  assert.equal(existsSync(path), false);
  const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path, JSON.stringify({ pid: Number(gone), at: 0 }));
  const again = await acquire(path, { wait: 2000 });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid);
  again();
  writeFileSync(path, JSON.stringify({ pid: process.ppid, at: 0 }));
  await assert.rejects(acquire(path, { wait: 100, waiting: () => {} }), /stayed locked/, 'a live holder is never taken over');
});

const goneProcess = () => Number(spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim());
/** `fs` with `fail(name, args)` able to throw before each call. */
const faulty = (fail) => new Proxy(fs, { get: (target, name) => (typeof target[name] === 'function'
  ? (...args) => { fail(name, args); return target[name](...args); } : target[name]) });
const transient = (code) => Object.assign(new Error(code), { code });

test('Windows: a stale lock is taken over at once, also with no wait, and so is one naming this process', async (t) => {
  override(t, process, 'platform', 'win32');
  const path = join(temporary(t), '.lcu-install.lock');
  writeFileSync(path, JSON.stringify({ pid: goneProcess(), at: 0 }));
  (await acquire(path, { wait: 0 }))();
  writeFileSync(path, JSON.stringify({ pid: process.pid, at: 0 }));
  const release = await acquire(path, { wait: 0 });
  assert.equal(existsSync(`${path}.takeover`), false);
  release();
  assert.equal(existsSync(path), false);
});

test('Windows: busy answers while a file is being deleted or read are retried, also on release', async (t) => {
  override(t, process, 'platform', 'win32');
  const path = join(temporary(t), '.lcu-install.lock');
  const left = { openSync: 2, readFileSync: 1, unlinkSync: 2 };
  const io = faulty((name, [file]) => {
    if (file === path && left[name] > 0) {
      left[name] -= 1;
      throw transient(name === 'openSync' ? 'EPERM' : 'EBUSY');
    }
  });
  const release = await acquire(path, { wait: 2000, io });
  assert.equal(left.openSync, 0);
  release();
  assert.deepEqual(left, { openSync: 0, readFileSync: 0, unlinkSync: 0 });
  assert.equal(existsSync(path), false);
});

test('Windows: a takeover never removes a lock a live process took after the stale one was read', async (t) => {
  override(t, process, 'platform', 'win32');
  const path = join(temporary(t), '.lcu-install.lock');
  const stale = JSON.stringify({ pid: goneProcess(), at: 0 });
  const live = JSON.stringify({ pid: process.ppid, at: 1 });
  writeFileSync(path, stale);
  let first = true;
  // Another contender removes the stale lock and a live process takes the path, right after this one read it.
  const io = faulty((name, [file]) => {
    if (name === 'openSync' && file === `${path}.takeover` && first) {
      first = false;
      fs.unlinkSync(path);
      writeFileSync(path, live);
    }
  });
  await assert.rejects(acquire(path, { wait: 0, io }), /stayed locked/);
  assert.equal(readFileSync(path, 'utf8'), live);
  assert.equal(existsSync(`${path}.takeover`), false);
});

test('Windows: a takeover guard left by a process that is gone, or an old one, is removed', async (t) => {
  override(t, process, 'platform', 'win32');
  const path = join(temporary(t), '.lcu-install.lock');
  const guard = `${path}.takeover`;
  writeFileSync(path, JSON.stringify({ pid: goneProcess(), at: 0 }));
  writeFileSync(guard, JSON.stringify({ pid: process.ppid, at: Date.now() }));
  await assert.rejects(acquire(path, { wait: 0 }), /stayed locked/, 'a live takeover is waited for');
  const old = new Date(Date.now() - 60_000);
  utimesSync(guard, old, old);
  (await acquire(path, { wait: 0 }))();
  writeFileSync(path, JSON.stringify({ pid: goneProcess(), at: 0 }));
  writeFileSync(guard, JSON.stringify({ pid: goneProcess(), at: Date.now() }));
  (await acquire(path, { wait: 0 }))();
  assert.equal(existsSync(guard), false);
});
