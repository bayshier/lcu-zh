import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { FAULT_ENV, Unrecognized, decide, main, parseTomlValue, unshimmedEnv } from '../../lcu/sandbox_shim.mjs';
import { REPO, override, posixTests, temporary, write, mockWrite } from './fixtures.mjs';

const test = posixTests('the Linux/macOS sandbox shim, with POSIX modes and sh stand-ins');

const PROFILE = 'permissions.node_repl={filesystem = {":root" = "read", ":tmpdir" = "read"}, network = {enabled = false}}';
const PREFIX = ['sandbox', '-c', 'shell_environment_policy.inherit="all"', '-c', 'default_permissions="node_repl"'];

function fixture(t) {
  const base = temporary(t);
  const runtime = join(base, 'runtime');
  for (const name of ['bin/node', 'bin/node_repl']) write(join(runtime, name));
  for (const name of ['sky', 'browser-desktop']) write(join(runtime, `lib/node_modules/@oai/${name}/package.json`), '{}');
  const tmp = join(base, 'tmp');
  const folder = join(tmp, '.tmpAbC123');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  for (const name of ['kernel.js', 'trusted-worker.js']) write(join(folder, name), '', 0o600);
  const wrapper = write(join(base, 'lcu/linux_sky_service.mjs'));
  const node = join(runtime, 'bin/node');
  const parent = join(runtime, 'bin/node_repl');
  const env = { LCU_SANDBOX_SHIM: JSON.stringify({ codex: '/real/codex', runtime, wrapper }), TMPDIR: tmp,
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: '@oai/sky/service' }) };
  const argv = (command) => [...PREFIX, '-c', PROFILE, '--', ...command];
  const kernel = () => [node, '--experimental-vm-modules', join(folder, 'kernel.js'), '--session-id', 'abc', '--working-dir', '/work'];
  const worker = () => [node, '--experimental-vm-modules', join(folder, 'trusted-worker.js'), join(base, 'socket')];
  const run = ({ command, argv: raw, env: changed = env, parent: exe = parent } = {}) => decide(raw ?? argv(command), changed, exe);
  return { base, runtime, folder, wrapper, node, parent, env, argv, kernel, worker, run };
}

test('the kernel goes to the real sandbox unchanged', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.run({ command: f.kernel() }), { action: 'real', argv: f.argv(f.kernel()), note: '' });
});

test('the genuine Sky worker runs directly, also beside the browser service or LCU’s wrapper', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.run({ command: f.worker() }), { action: 'direct', argv: f.worker(), note: '' });
  for (const services of [{ sky: '@oai/sky/service', browser: '@oai/browser-desktop/service' }, { sky: f.wrapper },
    { sky: f.wrapper, browser: '@oai/browser-desktop/service' }]) {
    assert.equal(f.run({ command: f.worker(), env: { ...f.env, NODE_REPL_TRUSTED_SERVICES: JSON.stringify(services) } }).action, 'direct');
  }
});

function staysSandboxed(f, part, options = {}) {
  const { action, argv, note } = f.run({ command: f.worker(), ...options });
  assert.deepEqual([action, argv], ['real', f.argv(f.worker())]);
  assert.ok(note.includes(part), note);
}

test('a worker not started by the selected node_repl stays sandboxed', (t) => {
  const f = fixture(t);
  for (const parent of ['/usr/bin/node', null, f.node]) staysSandboxed(f, 'node_repl', { parent });
});

test('a worker run by another Node is refused', (t) => {
  const f = fixture(t);
  const other = write(join(f.base, 'other-node'));
  assert.throws(() => f.run({ command: [other, ...f.worker().slice(1)] }), Unrecognized);
  symlinkSync(other, join(f.runtime, 'bin/link'));
  assert.throws(() => f.run({ command: [join(f.runtime, 'bin/link'), ...f.worker().slice(1)] }), Unrecognized);
});

test('lookalike folders, other temporary directories, writable or linked scripts stay sandboxed', (t) => {
  const f = fixture(t);
  const elsewhere = join(f.base, 'other');
  for (const name of ['kernel.js', 'trusted-worker.js']) write(join(elsewhere, name), '', 0o600);
  chmodSync(elsewhere, 0o700);
  const command = f.worker();
  command[2] = join(elsewhere, 'trusted-worker.js');
  assert.match(f.run({ command }).note, /temporary folder/);
  staysSandboxed(f, 'temporary folder', { env: { ...f.env, TMPDIR: f.base } });
  chmodSync(f.folder, 0o777);
  staysSandboxed(f, 'temporary folder');
  chmodSync(f.folder, 0o700);
  const script = join(f.folder, 'trusted-worker.js');
  chmodSync(script, 0o666);
  staysSandboxed(f, 'temporary folder');
  unlinkSync(script);
  symlinkSync(write(join(f.base, 'real.js')), script);
  staysSandboxed(f, 'temporary folder');
  unlinkSync(script);
  write(script, '', 0o600);
  unlinkSync(join(f.folder, 'kernel.js'));
  staysSandboxed(f, 'temporary folder');
});

test('group write is allowed only for the account group', (t) => {
  const f = fixture(t);
  chmodSync(f.folder, 0o770);
  assert.equal(f.run({ command: f.worker() }).action, 'direct');
  const gid = statSync(f.folder).gid;
  override(t, process, 'getegid', () => gid + 1);
  staysSandboxed(f, 'temporary folder');
});

test('a service map that is not the selected runtime’s stays sandboxed', (t) => {
  const f = fixture(t);
  for (const services of [{ sky: '@oai/sky/service', extra: '@oai/sky/service' }, { sky: '/tmp/evil.mjs' },
    { sky: `${f.wrapper}x` }, { browser: '@oai/browser-desktop/service' }, { sky: '@oai/sky/service', browser: '/tmp/evil.mjs' },
    { sky: 5 }, [], 'not-json']) {
    const raw = typeof services === 'string' ? services : JSON.stringify(services);
    const { action, note } = f.run({ command: f.worker(), env: { ...f.env, NODE_REPL_TRUSTED_SERVICES: raw } });
    assert.equal(action, 'real');
    assert.ok(note);
  }
  const { NODE_REPL_TRUSTED_SERVICES, ...unset } = f.env;
  assert.ok(f.run({ command: f.worker(), env: unset }).note);
  unlinkSync(join(f.runtime, 'lib/node_modules/@oai/sky/package.json'));
  staysSandboxed(f, 'Sky service');
});

test('unrecognised sandbox invocations are refused', (t) => {
  const f = fixture(t);
  const kernel = f.kernel();
  const cases = [
    ['sandbox', '-c', 'x=1', '-c', PROFILE, '--', ...kernel],
    [...PREFIX, '--', ...kernel],
    f.argv(['/bin/echo', 'hi']),
    f.argv([f.node, join(f.folder, 'kernel.js'), '--session-id', 'a', '--working-dir', '/w']),
    f.argv(kernel.slice(0, -1)),
    f.argv(f.worker().slice(0, -1)),
    f.argv([f.node, '--experimental-vm-modules', 'kernel.js', '--session-id', 'a', '--working-dir', '/w']),
    f.argv([f.node, '--experimental-vm-modules', join(f.folder, 'x.js'), 'a']),
    [...PREFIX, '-c', 'permissions.node_repl={', '--', ...kernel],
    [...PREFIX, '-c', 'permissions.node_repl={filesystem = {}, network = {}, x = 1}', '--', ...kernel],
    [...PREFIX, '-c', 'permissions.node_repl={filesystem = {a = 1}, network = {}}', '--', ...kernel],
    ['sandbox', '--full-auto', ...PREFIX.slice(1), '-c', PROFILE, '--', ...kernel],
  ];
  for (const argv of cases) assert.throws(() => f.run({ argv }), Unrecognized, argv.join(' '));
});

test('a missing or malformed configuration refuses a sandbox invocation', (t) => {
  const f = fixture(t);
  for (const raw of [undefined, 'not json', '[]', JSON.stringify({ codex: 1, runtime: 'r' }), JSON.stringify({ codex: 'c' }),
    JSON.stringify({ codex: 'c', runtime: 'r', wrapper: 3 })]) {
    const { LCU_SANDBOX_SHIM, ...env } = f.env;
    if (raw !== undefined) env.LCU_SANDBOX_SHIM = raw;
    assert.throws(() => decide(f.argv(f.kernel()), env, f.parent), Unrecognized);
  }
});

test('the availability probe and other subcommands reach the real Codex', (t) => {
  const f = fixture(t);
  const probe = f.argv(['/bin/sh', '-c', 'exit 12', 'node-repl-sandbox-probe', '/x']);
  assert.deepEqual(f.run({ argv: probe }), { action: 'real', argv: probe, note: '' });
  for (const argv of [['--version'], ['mcp', 'list'], [], ['sandboxed']]) {
    assert.deepEqual(f.run({ argv }), { action: 'real', argv, note: '' });
  }
});

test('the fault hook only ever refuses', (t) => {
  const f = fixture(t);
  for (const [fault, command, refused] of [['unrecognized-kernel', f.kernel(), true], ['unrecognized-kernel', f.worker(), false],
    ['unrecognized-worker', f.worker(), true], ['unrecognized-worker', f.kernel(), false],
    ['unrecognized-format', f.kernel(), true], ['unrecognized-format', f.worker(), true], ['other', f.worker(), false]]) {
    const run = () => f.run({ command, env: { ...f.env, [FAULT_ENV]: fault } });
    if (refused) assert.throws(run, Unrecognized);
    else run();
  }
});

function runMain(t, f, { command, env = f.env, parent = f.parent }) {
  const calls = [];
  let message = '';
  t.mock.method(process, 'execve', (...args) => calls.push(args));
  const stderr = mockWrite(t, process.stderr, (text) => { message += text; return true; });
  const status = main(f.argv(command), env, { parentExe: () => parent });
  stderr.mock.restore();
  process.execve.mock.restore();
  return { status, calls, message };
}

test('main execs the real Codex for the kernel and the worker directly', (t) => {
  const f = fixture(t);
  assert.deepEqual(runMain(t, f, { command: f.kernel() }).calls, [['/real/codex', ['/real/codex', ...f.argv(f.kernel())]]]);
  assert.deepEqual(runMain(t, f, { command: f.worker() }).calls, [[f.node, f.worker()]]);
});

test('main refuses with a clear message and execs nothing', (t) => {
  const f = fixture(t);
  const { status, calls, message } = runMain(t, f, { command: f.kernel(), env: { ...f.env, [FAULT_ENV]: 'unrecognized-format' } });
  assert.deepEqual([status, calls], [70, []]);
  assert.match(message, /never left unsandboxed/);
  assert.match(message, /LCU_NODE_REPL_SANDBOX=off/);
});

test('main explains a worker that stays sandboxed', (t) => {
  const f = fixture(t);
  const { status, calls, message } = runMain(t, f, { command: f.worker(), parent: '/usr/bin/node' });
  assert.equal(status, 0);
  assert.deepEqual(calls, [['/real/codex', ['/real/codex', ...f.argv(f.worker())]]]);
  assert.match(message, /stays sandboxed/);
});

test('the environment helper restores the real Codex', (t) => {
  const f = fixture(t);
  assert.equal(unshimmedEnv({ ...f.env, CODEX_CLI_PATH: '/shim' }).CODEX_CLI_PATH, '/real/codex');
  assert.equal(unshimmedEnv({ CODEX_CLI_PATH: '/x' }).CODEX_CLI_PATH, '/x');
});

test('the inline profile reader takes what node_repl sends and refuses anything else', () => {
  assert.deepEqual(parseTomlValue('{filesystem = {":root" = "read", \':tmpdir\' = "x\\u00e9"}, network = {enabled = false}}'),
    { filesystem: { ':root': 'read', ':tmpdir': 'x\u00e9' }, network: { enabled: false } });
  assert.deepEqual(parseTomlValue('[1, "two", [true],]'), [1, 'two', [true]]);
  for (const text of ['{', '{a = 1,}', '{a = 1, a = 2}', '"open', '01', '1.5', '{a.b = 1}', '{a = 1} # comment', '{a = 1} x']) {
    assert.throws(() => parseTomlValue(text), Error, text);
  }
});

test('the launcher is executable', () => {
  assert.ok(statSync(join(REPO, 'bin/lcu-codex-sandbox')).mode & 0o100);
});
