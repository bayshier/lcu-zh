// `lcu cross-turn`: the setting file, owner authentication (injected), and the command, against a temporary home.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppsError } from '../../lcu/apps.mjs';
import * as crossTurn from '../../lcu/cross_turn.mjs';
import { REPO, asNonRoot, output, posixTests, temporary, write } from './fixtures.mjs';

const test = posixTests('the state directory is under ~/.local/state and the file keeps POSIX modes');

function fixture(t) {
  const home = temporary(t);
  const f = { home, path: join(home, '.local/state/lcu/cross-turn.json'), calls: [] };
  f.run = async (argv, { approve = true, platform = 'darwin', fail = null, write } = {}) => {
    const seen = await output(t);
    const auth = (root, reason) => {
      f.calls.push([root, reason]);
      if (fail) throw fail;
      if (!approve) throw new AppsError('authentication was cancelled or failed. Nothing was changed.');
    };
    const code = await crossTurn.main(REPO, argv, { platform, home, auth, write });
    return { code, out: seen.out, err: seen.err };
  };
  f.read = () => JSON.parse(readFileSync(f.path, 'utf8'));
  return f;
}

test('status is off without a file, needs no authentication, and has a JSON form', async (t) => {
  const f = fixture(t);
  const text = await f.run([]);
  assert.equal(text.code, 0);
  assert.match(text.out, /Cross-turn Computer Use is off\./);
  assert.ok(text.out.includes(f.path));
  const json = JSON.parse((await f.run(['status', '--json'])).out);
  assert.deepEqual(json, { enabled: false, source: null, configured: false, file: f.path });
  assert.deepEqual(f.calls, []);
  assert.equal(existsSync(f.path), false);
});

test('on authenticates once on macOS with the release root and a clear reason, writes the file, and is idempotent', async (t) => {
  const f = fixture(t);
  const first = await f.run(['on']);
  assert.equal(first.code, 0);
  assert.match(first.out, /now on/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], REPO);
  assert.match(f.calls[0][1], /across turns/);
  const saved = f.read();
  assert.deepEqual([saved.enabled, saved.source], [true, 'owner']);
  assert.ok(!Number.isNaN(Date.parse(saved.changed_at)));
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  const again = await f.run(['on']);
  assert.match(again.out, /already on/);
  assert.equal(f.calls.length, 1);
  assert.match((await f.run([])).out, /is on \(set by owner\)/);
  const json = JSON.parse((await f.run(['on', '--json'])).out);
  assert.deepEqual([json.enabled, json.source, json.changed], [true, 'owner', false]);
});

test('off needs no authentication, is idempotent, and records an explicit off when nothing was stored', async (t) => {
  const f = fixture(t);
  assert.equal((await f.run(['off'])).code, 0);
  assert.deepEqual([f.read().enabled, f.calls.length], [false, 0]);
  await f.run(['on']);
  assert.equal(f.calls.length, 1);
  assert.match((await f.run(['off'])).out, /now off/);
  assert.equal(f.read().enabled, false);
  assert.match((await f.run(['off'])).out, /already off/);
  assert.equal(f.calls.length, 1);
  const json = JSON.parse((await f.run(['off', '--json'])).out);
  assert.deepEqual([json.enabled, json.configured, json.changed], [false, true, false]);
});

test('a cancelled, failed or unavailable authentication changes nothing and exits 1', async (t) => {
  const f = fixture(t);
  const cancelled = await f.run(['on'], { approve: false });
  assert.equal(cancelled.code, 1);
  assert.match(cancelled.err, /authentication was cancelled/);
  const unavailable = await f.run(['on'], { fail: new AppsError('the owner-authentication helper is missing (/x). Nothing was changed.') });
  assert.equal(unavailable.code, 1);
  assert.match(unavailable.err, /helper is missing/);
  assert.equal(existsSync(f.path), false);
  await f.run(['on']);
  const before = readFileSync(f.path, 'utf8');
  await f.run(['off']);
  await f.run(['on'], { approve: false });
  assert.equal(f.read().enabled, false);
  assert.notEqual(readFileSync(f.path, 'utf8'), before);
});

test('--unattended skips the prompt, records unattended, and warns about sandbox machines', async (t) => {
  const f = fixture(t);
  const { code, err } = await f.run(['on', '--unattended']);
  assert.equal(code, 0);
  assert.match(err, /disposable sandbox machines/);
  assert.deepEqual([f.read().source, f.calls.length], ['unattended', 0]);
  assert.match((await f.run([])).out, /on \(set by unattended\)/);
});

test('Linux and Windows have no owner prompt: on turns it on directly and records cli', async (t) => {
  for (const platform of ['linux', 'win32']) {
    const f = fixture(t);
    const { code, err } = await f.run(['on'], { platform });
    assert.equal(code, 0);
    assert.match(err, /no owner prompt/);
    assert.deepEqual([f.read().enabled, f.read().source, f.calls.length], [true, 'cli', 0]);
    await f.run(['off'], { platform });
    assert.deepEqual([f.read().enabled, f.read().source], [false, 'cli']);
  }
});

test('a file with a UTF-8 BOM reads as set; invalid UTF-8 reads as off', async (t) => {
  const f = fixture(t);
  write(f.path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"enabled":true,"source":"owner"}')]));
  const json = JSON.parse((await f.run(['--json'])).out);
  assert.deepEqual([json.enabled, json.source], [true, 'owner']);
  write(f.path, Buffer.concat([Buffer.from('{"enabled":true,"source":"'), Buffer.from([0xff]), Buffer.from('"}')]));
  assert.equal(JSON.parse((await f.run(['--json'])).out).enabled, false);
});

test('a malformed file reads as off with a clear message and is only replaced when the user changes the setting', async (t) => {
  for (const content of ['{not json', '[]', '{"enabled": "yes"}', '{}', '']) {
    const f = fixture(t);
    write(f.path, content);
    const status = await f.run([]);
    assert.equal(status.code, 0, content);
    assert.match(status.out, /is off\./);
    assert.match(status.err, /not a valid cross-turn setting/);
    const json = JSON.parse((await f.run(['--json'])).out);
    assert.deepEqual([json.enabled, json.configured], [false, true]);
    assert.match(json.problem, /not a valid cross-turn setting/);
    assert.equal(readFileSync(f.path, 'utf8'), content);
    assert.equal((await f.run(['on'])).code, 0);
    assert.equal(f.read().enabled, true);
  }
  const f = fixture(t);
  write(f.path, '{bad');
  await f.run(['off']);
  assert.equal(f.read().enabled, false);
  assert.equal(f.calls.length, 0);
});

test('usage errors exit 2 and help exits 0', async (t) => {
  const f = fixture(t);
  for (const argv of [['bogus'], ['on', 'off'], ['status', '--unattended'], ['off', '--unattended'], ['--nope']]) {
    assert.equal((await f.run(argv)).code, 2, argv.join(' '));
  }
  const help = await f.run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /lcu cross-turn \[status\|on\|off\] \[--json\] \[--unattended\]/);
  assert.equal(existsSync(f.path), false);
});

test('enabling over an unreadable file replaces it with a private readable one', { skip: process.getuid?.() === 0 && 'root reads mode 000 files' }, async (t) => {
  const f = fixture(t);
  asNonRoot(t, f.home);
  write(f.path, '{"enabled": false}', 0o600);
  chmodSync(f.path, 0o000);
  assert.equal((await f.run([])).code, 0);
  assert.equal((await f.run(['on'])).code, 0);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse((await f.run(['--json'])).out).enabled, true);
});

test('a failed write leaves the original file byte for byte and no stray temporary file', async (t) => {
  const f = fixture(t);
  write(f.path, '{broken', 0o600);
  const failing = () => { throw new Error('ENOSPC: no space left on device'); };
  const { code, err } = await f.run(['on'], { write: failing });
  assert.equal(code, 1);
  assert.match(err, /cannot write .*Nothing was changed/);
  assert.equal(readFileSync(f.path, 'utf8'), '{broken');
  // the real writer too: a rename onto a directory fails and cleans up its temporary file
  const dir = fixture(t);
  write(join(dir.path, 'x'), '');
  assert.throws(() => crossTurn.writePrivate(dir.path, 'data'));
  assert.deepEqual(readdirSync(join(dir.home, '.local/state/lcu')), ['cross-turn.json']);
});

test('per-app approval wording covers macOS and Windows, not Linux', () => {
  for (const platform of ['darwin', 'win32']) assert.match(crossTurn.approvalNote(platform), /^Per-app approvals still apply/);
  assert.match(crossTurn.approvalNote('linux'), /no per-app approval/);
});

test('a short write is detected: the original is kept and the command fails', async (t) => {
  const f = fixture(t);
  await f.run(['on']);
  const original = readFileSync(f.path, 'utf8');
  const { code, err } = await f.run(['off'], { write: (path, data) => crossTurn.writePrivate(path, data,
    { writeAll: (fd, bytes) => writeFileSync(fd, bytes.subarray(0, 10)) }) });
  assert.equal(code, 1);
  assert.match(err, /written incompletely/);
  assert.equal(readFileSync(f.path, 'utf8'), original);
  assert.deepEqual(readdirSync(join(f.home, '.local/state/lcu')), ['cross-turn.json']);
});
