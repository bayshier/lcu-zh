import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { host as doctorHost } from '../../lcu/doctor.mjs';
import { MAC_HELPER, MAC_REQUIRED_FILES, sealRecord } from '../../lcu/platforms.mjs';
import { configureMacosLifecycle, environment, main, paths } from '../../lcu/runtime.mjs';
import { deps } from '../../scripts/install.mjs';
import { output, override, posixTests, temporary, write, mockWrite } from './fixtures.mjs';

const test = posixTests('the macOS launch path, with sh stand-ins and POSIX modes');

const VERSION = '26.924.22138';
const RUNTIME = '0.0.24/20260924074400-f52ea85e2a98';
const CLIENT = 'lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient';
const plist = (values) => `<?xml version="1.0"?>\n<plist version="1.0"><dict>${Object.entries(values)
  .map(([key, value]) => `<key>${key}</key><string>${value}</string>`).join('')}</dict></plist>\n`;

function macRelease(t) {
  const base = temporary(t);
  const root = join(base, 'release');
  const app = join(base, 'ChatGPT.app');
  const contents = join(app, 'Contents');
  write(join(contents, 'Info.plist'), plist({ CFBundleIdentifier: 'com.openai.codex', CFBundleShortVersionString: VERSION }));
  write(join(contents, MAC_HELPER, 'Contents/Info.plist'), plist({ CFBundleIdentifier: 'com.openai.sky.CUAService' }));
  write(join(contents, 'Resources/cua_node/manifest.json'), JSON.stringify({ platform: 'darwin', arch: 'arm64', runtime_archive_version: RUNTIME }));
  for (const relative of MAC_REQUIRED_FILES) write(join(contents, relative), relative, 0o755);
  write(join(contents, '_CodeSignature/CodeResources'), 'app seal');
  write(join(contents, MAC_HELPER, 'Contents/_CodeSignature/CodeResources'), 'helper seal');
  // The original server stands in as a script that records how it was started.
  write(join(contents, 'Resources/cua_node/bin/node'), '#!/bin/sh\nprintf "%s\\n" "$0" "$@" > "$LCU_TEST_OUT.argv"\nenv > "$LCU_TEST_OUT.env"\n' +
    '[ -n "$LCU_TEST_SIGNAL" ] && kill -"$LCU_TEST_SIGNAL" $$\nexit "${LCU_TEST_STATUS:-0}"\n', 0o755);
  const codex = write(join(contents, 'Resources/codex-cli/bin/codex'), 'original codex', 0o755);
  write(join(contents, 'Resources/codex-cli/bin/codex-code-mode-host'), 'original host', 0o755);
  mkdirSync(root);
  symlinkSync(app, join(root, 'app'));
  write(join(root, 'runtime.lock.json'), JSON.stringify({ platforms: { darwin: { version: 'old-lock-version', runtime: 'old-lock-runtime',
    architectures: { arm64: { components: { fixture: 'ignored' } } } } } }));
  write(join(root, 'installation.json'), JSON.stringify({ platform: 'darwin', app, architecture: 'arm64',
    package_version: 'old-installed-version', runtime: 'old-installed-runtime' }));
  const runtime = join(contents, 'Resources/cua_node');
  const calls = [];
  override(t, process, 'platform', 'darwin');
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    calls.push([command, ...args]);
    if (args.includes('--verify')) return { status: 0, stdout: '', stderr: '' };
    const identifier = args.at(-1).endsWith('ChatGPT.app') ? 'com.openai.codex' : 'com.openai.sky.CUAService';
    return { status: 0, stdout: '', stderr: `Identifier=${identifier}\nTeamIdentifier=2DC432GLL2\n` };
  });
  return { base, root, app, runtime, codex, codesign: calls, out: join(base, 'child') };
}

const childEnv = (r) => Object.fromEntries(readFileSync(`${r.out}.env`, 'utf8').split('\n').filter(Boolean)
  .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

test('the original entry point is exec’d with the verified local app, each signature checked once', async (t) => {
  const r = macRelease(t);
  const calls = [];
  override(t, process, 'env', { HOME: '/fixture', CUA_REPL_ENABLED_SURFACES: 'browser' });
  t.mock.method(process, 'execve', (...args) => calls.push(args));
  await main(r.root, []);
  const node = join(r.runtime, 'bin/node');
  assert.deepEqual(calls[0].slice(0, 2), [node, [node, join(r.runtime, 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')]]);
  const env = calls[0][2];
  assert.equal(env.CODEX_CLI_PATH, r.codex);
  assert.equal(env.SKY_CUA_SERVICE_PATH, join(r.runtime, 'lib/node_modules/@oai/sky/Codex Computer Use.app'));
  assert.equal(env.BROWSER_USE_CODEX_APP_VERSION, VERSION);
  assert.ok(!('NODE_REPL_HOST_SERVICES_PIPE_PATH' in env));
  assert.equal(r.codesign.filter((call) => call.includes('--verify')).length, 2, 'one verification per signed bundle');
  assert.equal(r.codesign.length, 4);
});

const deepChecks = (r) => r.codesign.filter((call) => call.includes('--deep')).length;

test('a launch reuses the recorded deep check; --version, doctor, status and the installer check in full', async (t) => {
  const r = macRelease(t);
  override(t, sealRecord, 'path', () => join(r.base, 'cache/macos-signatures.json'));
  override(t, process, 'env', { HOME: '/fixture', CUA_REPL_ENABLED_SURFACES: 'browser' });
  t.mock.method(process, 'execve', () => {});
  await main(r.root, []);
  assert.equal(deepChecks(r), 2, 'the first launch checks both bundles');
  r.codesign.length = 0;
  await main(r.root, []);
  assert.equal(deepChecks(r), 0, 'a later launch reuses the record');
  assert.equal(r.codesign.length, 2, 'the signer is still read for both bundles');
  r.codesign.length = 0;
  mockWrite(t, process.stdout, () => {});
  await main(r.root, ['--version']);
  assert.equal(deepChecks(r), 2, 'lcu --version (run by lcu setup)');
  r.codesign.length = 0;
  paths(r.root);
  assert.equal(deepChecks(r), 2, 'status, browser and doctor without a resolved app');
  r.codesign.length = 0;
  deps.resolveMacApp(r.app, { arch: 'arm64' });
  assert.equal(deepChecks(r), 2, 'install and lcu update');
  // `lcu doctor` (also run by lcu setup) resolves the app in main; stop it at its first desktop probe.
  r.codesign.length = 0;
  override(t, doctorHost, 'probe', () => { throw new Error('fixture stops here'); });
  override(t, doctorHost, 'interactive', () => false);
  await output(t);
  await main(r.root, ['doctor', '--non-interactive']).catch(() => {});
  assert.equal(deepChecks(r), 2, 'lcu doctor');
});

async function supervised(t, r, settings) {
  write(join(r.runtime, CLIENT), '#!/bin/sh\nexit 0\n', 0o755);
  override(t, process, 'env', { PATH: process.env.PATH, LCU_TEST_OUT: r.out, ...settings });
  const status = await main(r.root, []);
  return { status, env: childEnv(r) };
}

test('macOS supervises the lifecycle host around the original server', async (t) => {
  const r = macRelease(t);
  const { status, env } = await supervised(t, r, { HOME: userInfo().homedir });
  assert.equal(status, 0);
  assert.deepEqual(readFileSync(`${r.out}.argv`, 'utf8').trim().split('\n'),
    [join(r.runtime, 'bin/node'), join(r.runtime, 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')]);
  assert.match(env.LCU_MAC_LIFETIME_SOCKET, /lcu-ml-.*\/lifetime\.sock$/);
  assert.ok(!existsSync(env.LCU_MAC_LIFETIME_SOCKET), 'the host is gone once the server exits');
  assert.ok(env.LCU_MAC_SERVICE_LOCK.endsWith('/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock.lock'));
  assert.equal(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES).sky, join(r.root, 'lcu/macos_sky_service.mjs'));
});

test('the original server’s exit status reaches the caller; a signal gives 128 + its number', async (t) => {
  const r = macRelease(t);
  assert.equal((await supervised(t, r, { HOME: userInfo().homedir, LCU_TEST_STATUS: '7' })).status, 7);
  assert.equal((await supervised(t, r, { HOME: userInfo().homedir, LCU_TEST_SIGNAL: 'TERM' })).status, 128 + 15);
});

test('a custom socket path or a HOME that is not the account’s leaves the service lock unknown', async (t) => {
  for (const settings of [{ HOME: userInfo().homedir, SKY_CUA_SERVICE_NATIVE_PIPE_PATH: '/tmp/custom.sock' },
    { HOME: userInfo().homedir, SKY_CUA_SERVICE_NATIVE_PIPE_PATH: '' }, { HOME: '/tmp/isolated-home' }, { HOME: '' }]) {
    await t.test(JSON.stringify(settings), async (t) => {
      const r = macRelease(t);
      const { env } = await supervised(t, r, { ...settings, LCU_MAC_SERVICE_LOCK: '/inherited.lock' });
      assert.ok(!('LCU_MAC_SERVICE_LOCK' in env));
    });
  }
});

test('metadata comes from the selected app, not the stale descriptor or lock', async (t) => {
  const r = macRelease(t);
  assert.deepEqual(paths(r.root).metadata, { version: VERSION, runtime: RUNTIME });
  assert.equal(environment(r.root, undefined, { env: {} }).BROWSER_USE_CODEX_APP_VERSION, VERSION);
  write(join(r.root, 'bundle.json'), JSON.stringify({ version: '0.3.0' }));
  let output = '';
  mockWrite(t, process.stdout, (text) => { output += text; return true; });
  await main(r.root, ['--version']);
  assert.match(output, new RegExp(`lcu 0\\.3\\.0 \\(ChatGPT darwin ${VERSION}; CUA ${RUNTIME}\\)`));
  unlinkSync(join(r.root, 'installation.json'));
  await main(r.root, ['--version']);
  assert.match(output, /app not selected/);
  assert.ok(!output.includes('old-lock-version'));
});

test('a descriptor pointing at another app is refused before any signature check', (t) => {
  const r = macRelease(t);
  const descriptor = JSON.parse(readFileSync(join(r.root, 'installation.json')));
  writeFileSync(join(r.root, 'installation.json'), JSON.stringify({ ...descriptor, app: join(r.root, 'other.app') }));
  assert.throws(() => paths(r.root), /does not match/);
  assert.equal(r.codesign.length, 0);
});

test('the caller’s helper and policy settings are kept', (t) => {
  const r = macRelease(t);
  const env = environment(r.root, undefined, { env: { SKY_CUA_SERVICE_PATH: '/chosen/helper.app', CUA_REPL_ENABLED_SURFACES: 'computer' } });
  assert.deepEqual([env.SKY_CUA_SERVICE_PATH, env.CUA_REPL_ENABLED_SURFACES], ['/chosen/helper.app', 'computer']);
});

test('the lifecycle wrapper replaces only the original Sky service; a custom Sky service is refused', (t) => {
  const r = macRelease(t);
  const env = environment(r.root, undefined, { env: { HOME: '/fixture', NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
    sky: '@oai/sky/service', browser: 'custom/browser/service', other: 'custom/other/service' }) } });
  const client = configureMacosLifecycle(r.root, r.runtime, env);
  assert.deepEqual(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES), { sky: join(r.root, 'lcu/macos_sky_service.mjs'),
    browser: 'custom/browser/service', other: 'custom/other/service' });
  assert.equal(env.LCU_MAC_SKY_SERVICE_PATH, join(r.runtime, 'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js'));
  assert.equal(client, join(env.SKY_CUA_SERVICE_PATH, 'Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient'));
  assert.throws(() => configureMacosLifecycle(r.root, r.runtime, { CUA_REPL_ENABLED_SURFACES: 'computer',
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: 'custom/sky/service' }) }), /custom Sky trusted-service/);
});
