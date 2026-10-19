import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { discover, main, which } from '../../lcu/session.mjs';
import { override, posixTests, temporary, write, mockWrite } from './fixtures.mjs';

const test = posixTests('Linux desktop sessions (POSIX accounts and sh stand-ins)');

function session(proc, pid, display = ':1') {
  write(join(proc, String(pid), 'comm'), 'xfce4-session\n');
  write(join(proc, String(pid), 'environ'),
    `DISPLAY=${display}\0DBUS_SESSION_BUS_ADDRESS=unix:path=/run/test\0TOKEN=never-copy\0`);
}

test('discovery copies only the GUI environment', (t) => {
  const proc = temporary(t);
  session(proc, 123);
  write(join(proc, 'self/comm'), 'xfce4-session\n');
  assert.deepEqual(discover(proc), { DISPLAY: ':1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/test' });
});

test('an ambiguous desktop or another account’s desktop is refused', (t) => {
  const proc = temporary(t);
  session(proc, 123);
  assert.throws(() => discover(proc, process.getuid() + 1), /found 0/);
  session(proc, 124, ':2');
  assert.throws(() => discover(proc), /found 2/);
});

test('the launcher runs the command in the discovered session as the calling account only', (t) => {
  const calls = [];
  override(t, process, 'execve', (...args) => calls.push(args));
  assert.throws(() => main(['--user', 'lcu-no-such-account', '--', 'true']), /Unknown account: lcu-no-such-account/);
  const other = process.getuid() === 0 ? 'daemon' : 'root';
  assert.throws(() => main(['--user', other, '--', 'true']), /selected desktop account/);
  assert.equal(calls.length, 0);
  mockWrite(t, process.stderr, () => true);
  assert.equal(main(['--user', userInfo().username]), 2);
});

test('the command is found like execvp: past files that are not executable, on a default path without PATH', (t) => {
  const base = temporary(t);
  write(join(base, 'first/tool'), 'not executable', 0o644);
  const second = write(join(base, 'second/tool'), '#!/bin/sh\n', 0o755);
  assert.equal(which('tool', `${join(base, 'first')}:${join(base, 'second')}`), second);
  assert.equal(which('sh'), '/bin/sh');
  assert.equal(which('./relative'), './relative');
  assert.throws(() => which('tool', join(base, 'first')), /Command not found/);
});
