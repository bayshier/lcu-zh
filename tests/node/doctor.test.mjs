// `lcu doctor` reports only checks the original runtime proves.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import * as doctor from '../../lcu/doctor.mjs';
import { MAC_HELPER } from '../../lcu/platforms.mjs';
import { output, override, result, temporary, write } from './fixtures.mjs';

const plist = (name) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleDisplayName</key><string>${name}</string></dict></plist>\n`;
const MAC = { target: 'mac', provider: { ok: true, methods: ['list_apps', 'get_app_state'] }, permissions: { ok: false, unverified: true } };
const READY = { target: 'linux', windows: { ok: true, count: 1 }, screenshot: { ok: true, count: 1 } };
const FAILED = { target: 'linux', windows: { ok: true, count: 1 }, screenshot: { ok: false, error: { message: 'capture unavailable' } } };

function fixture(t, platform = 'darwin') {
  const base = temporary(t);
  const root = join(base, 'release');
  const app = join(base, 'ChatGPT.app');
  const runtime = join(root, 'app/Contents/Resources/cua_node');
  mkdirSync(runtime, { recursive: true });
  write(join(app, 'Contents/Info.plist'), plist('Selected ChatGPT'));
  write(join(app, 'Contents', MAC_HELPER, 'Contents/Info.plist'), plist('Selected Computer Use'));
  const f = { base, root, app, runtime, resolved: { app, resources: join(app, 'Contents/Resources'), runtime, metadata: { version: 'fixture-app', runtime: 'fixture-cua' } },
    env: { NODE_REPL_NODE_PATH: '/fixture/node', DISPLAY: ':99', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture' }, opened: [], probes: 0 };
  f.platform = (name) => writeFileSync(join(root, 'installation.json'), JSON.stringify({ platform: name }));
  f.platform(platform);
  f.probe = (...reports) => override(t, doctor.host, 'probe', () => {
    f.probes += 1;
    const report = reports.length > 1 ? reports.shift() : reports[0];
    if (report instanceof Error) throw report;
    return report;
  });
  f.answers = (...answers) => {
    override(t, doctor.host, 'interactive', () => true);
    override(t, doctor.host, 'ask', () => answers.shift() ?? '');
  };
  override(t, doctor.host, 'interactive', () => false);
  override(t, doctor.host, 'openSettings', (url) => f.opened.push(url));
  override(t, doctor.host, 'sandboxWorks', () => [true, '']);
  f.run = async (...argv) => {
    const seen = await output(t);
    const code = await doctor.main(root, argv, { resolved: f.resolved, env: f.env });
    return { code, out: seen.out };
  };
  return f;
}

test('macOS permission names come from the selected app and its helper', (t) => {
  const f = fixture(t);
  const names = doctor.macPermissionTargets(f.app);
  assert.deepEqual(names.accessibility, ['Selected Computer Use', join(f.app, 'Contents', MAC_HELPER)]);
  assert.equal(names.screen_capture[0], 'Selected ChatGPT');
});

test('macOS: privacy stays unverified, Settings opens only on an explicit choice, and a strict check stays nonzero', async (t) => {
  const f = fixture(t);
  f.probe(MAC);
  f.answers('');
  let { code, out } = await f.run();
  assert.equal(code, 0);
  assert.match(out, /macOS privacy permissions: not verified by LCU/);
  assert.deepEqual(f.opened, []);
  f.answers('a', '');
  await f.run();
  assert.equal(f.opened.length, 1);
  f.answers('');
  assert.equal((await f.run('--require-ready')).code, 2);
  ({ code, out } = await f.run('--non-interactive'));
  assert.match(out, /Review these entries in System Settings/);
  assert.equal(f.opened.length, 1);
  f.probe({ target: 'mac', provider: { ok: false, error: { code: -10009 } } });
  ({ code, out } = await f.run('--non-interactive'));
  assert.equal(code, 2);
  assert.match(out, /required permission is not granted/);
});

test('Linux: a failed screenshot is never ready; an interactive retry can complete readiness; a cancel stays nonzero', async (t) => {
  const f = fixture(t, 'linux');
  f.probe(FAILED);
  let { code, out } = await f.run('--non-interactive');
  assert.equal(code, 2);
  assert.match(out, /Screenshot capture: could not verify\./);
  assert.doesNotMatch(out, /Computer use is ready/);
  assert.equal(out.match(/JavaScript sandbox:/g).length, 1);
  f.probe(FAILED, READY);
  f.answers('r');
  ({ code, out } = await f.run('--require-ready'));
  assert.equal(code, 0);
  assert.match(out, /Computer use is ready for the first agent call\./);
  assert.match(out, /returned image data was discarded by LCU/);
  f.probe(FAILED);
  f.answers('');
  assert.equal((await f.run('--require-ready')).code, 2);
});

test('Linux: no desktop session is reported before probing', async (t) => {
  const f = fixture(t, 'linux');
  f.probe(READY);
  f.env = {};
  const { code, out } = await f.run('--non-interactive');
  assert.equal(code, 2);
  assert.match(out, /A live X11 DISPLAY and DBUS_SESSION_BUS_ADDRESS are required/);
  assert.equal(f.probes, 0);
});

test('the sandbox status names each mode', async (t) => {
  const status = async (env, works) => {
    const seen = await output(t);
    doctor.printLinuxSandboxStatus(env, { works });
    return seen.out;
  };
  assert.match(await status({ LCU_SANDBOX_SHIM: '{}' }, () => [true, '']), /JavaScript sandbox: active.*no network/);
  const missing = await status({ LCU_SANDBOX_SHIM: '{}' }, () => [false, 'exit 1: bwrap denied']);
  assert.ok(missing.includes('NOT AVAILABLE') && missing.includes('bwrap denied') && missing.includes('not sandboxed'));
  assert.match(await status({}, () => [true, '']), /launcher shim is missing/);
  assert.match(await status({ LCU_NODE_REPL_SANDBOX: 'off' }, () => assert.fail('no probe')), /OFF/);
  assert.match(await status({ LCU_NODE_REPL_SANDBOX: 'host' }, () => assert.fail('no probe')), /LCU_NODE_REPL_SANDBOX=host/);
});

test('the sandbox probe runs the real Codex with the original probe shape', (t) => {
  const env = { CODEX_CLI_PATH: '/shim', LCU_SANDBOX_SHIM: JSON.stringify({ codex: '/real/codex', runtime: '/r', wrapper: null }) };
  for (const [status, expected] of [[12, true], [1, false]]) {
    let call;
    override(t, doctor.host, 'run', (command, args, options) => {
      call = { command, args, options };
      return result(status);
    });
    assert.equal(doctor.linuxSandboxWorks(env)[0], expected);
    assert.deepEqual([call.command, call.args[0]], ['/real/codex', 'sandbox']);
    assert.equal(call.args[call.args.indexOf('--') + 1], '/bin/sh');
    assert.match(call.options.cwd, /lcu-sandbox-probe-/);
  }
});

test('the provider probe rejects a failed process and a wrong target', (t) => {
  override(t, doctor.host, 'run', () => result(1, '', 'failed'));
  assert.throws(() => doctor.probe('/runtime', { NODE_REPL_NODE_PATH: '/node' }, 'darwin'), /failed/);
  override(t, doctor.host, 'run', () => result(0, '{"target":"windows"}\n'));
  assert.throws(() => doctor.probe('/runtime', { NODE_REPL_NODE_PATH: '/node' }, 'darwin'), /target mismatch/);
});

test('doctor reports the app, an untested pair, a changed app, and the diagnostic log', async (t) => {
  const f = fixture(t, 'linux');
  writeFileSync(join(f.root, 'installation.json'), JSON.stringify({ platform: 'linux', package_version: 'old', runtime: 'fixture-cua' }));
  writeFileSync(join(f.root, 'tested-versions.json'), JSON.stringify({ format: 1, entries: [] }));
  f.probe(READY);
  process.env.LCU_LOG_DIR = join(f.base, 'logs');
  t.after(() => delete process.env.LCU_LOG_DIR);
  const { code, out } = await f.run('--non-interactive');
  assert.equal(code, 0);
  assert.match(out, /Original app: ChatGPT fixture-app \(CUA fixture-cua\)\./);
  assert.match(out, /Tested pair: no\./);
  assert.match(out, /differs from the one recorded/);
  assert.ok(out.includes(`Diagnostic log: ${join(f.base, 'logs')} (metadata only; kept 7 days`));
});

test('a too-long macOS socket path fails doctor only on the Mac it runs on', async (t) => {
  const f = fixture(t);
  f.probe(MAC);
  process.env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH = `/${'a'.repeat(200)}`;
  t.after(() => delete process.env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH);
  override(t, process, 'platform', 'darwin');
  let { code, out } = await f.run('--non-interactive');
  assert.equal(code, 2);
  assert.match(out, /Computer Use cannot start for this macOS account/);
  assert.equal(f.probes, 0);
  override(t, process, 'platform', 'linux');
  ({ code, out } = await f.run('--non-interactive'));
  assert.equal(code, 0);
  assert.doesNotMatch(out, /socket path/);
});

test('help needs no app, and bad flags exit 2', async (t) => {
  const seen = await output(t);
  assert.equal(await doctor.main('/nonexistent', ['--help']), 0);
  assert.match(seen.out, /--require-ready/);
  assert.equal(await doctor.main('/nonexistent', ['--bogus']), 2);
});
