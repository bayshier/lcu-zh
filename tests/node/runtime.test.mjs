import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { environment, leaveUnusableWorkingDirectory, main, paths } from '../../lcu/runtime.mjs';
import { REPO, linuxApp, override, posixTests, temporary, write, mockWrite } from './fixtures.mjs';

const test = posixTests('the Linux launch path (process.execve, sh stand-ins, POSIX modes)');

const NODE_SCRIPT = '#!/bin/sh\nprintf "%s\\n" "$0" "$@" > "$LCU_TEST_OUT.argv"\nenv > "$LCU_TEST_OUT.env"\ncat > "$LCU_TEST_OUT.stdin"\n';

function release(t) {
  const base = temporary(t);
  const root = join(base, 'releases/release');
  mkdirSync(root, { recursive: true });
  const app = linuxApp(join(base, 'usr/lib/chatgpt'), { runtimeVersion: 'fixture-runtime-new' });
  write(join(app, 'resources/cua_node/bin/node'), NODE_SCRIPT, 0o755);
  symlinkSync(app, join(root, 'app'));
  write(join(root, 'runtime.lock.json'), JSON.stringify({ runtime: 'fixture-runtime', version: '26.915.31945',
    architectures: { arm64: { sha256: 'fixture-digest' } } }));
  write(join(root, 'installation.json'), JSON.stringify({ app, architecture: 'arm64', package_version: '26.924.22138', runtime: 'fixture-runtime-new' }));
  const runtime = join(root, 'app/resources/cua_node');
  return { base, root, app, runtime, modules: join(runtime, 'lib/node_modules'), plugins: join(root, 'app/resources/plugins') };
}

const env = (r, settings = {}, options = {}) => environment(r.root, undefined, { env: settings, ...options });
const shim = (r) => write(join(r.root, 'bin/lcu-codex-sandbox'), '#!/bin/sh\n', 0o755);
function inputWrapper(r, ...entries) {
  write(join(r.root, 'lcu/linux_sky_service.mjs'), 'export async function handleRpc() {}\n');
  write(join(r.root, 'tested-versions.json'), JSON.stringify({ format: 1, entries }));
}
const pair = (changes = {}) => ({ platform: 'linux', architecture: 'arm64', app_version: '26.924.22138',
  runtime: 'fixture-runtime-new', lcu_version: '0.8.3', ...changes });

test('the default enables the original computer surface and the original host defaults', (t) => {
  const r = release(t);
  const e = env(r);
  assert.equal(e.CUA_REPL_ENABLED_SURFACES, 'computer');
  assert.equal(e.CUA_REPL_BROWSER_ENV, 'codex-app');
  assert.equal(e.CODEX_CLI_PATH, join(r.root, 'app/resources/codex'));
  for (const [key, value] of Object.entries({ BROWSER_USE_AVAILABLE_BACKENDS: 'chrome', NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '1000',
    BROWSER_USE_TINYSKY_ENABLED: '1', BROWSER_USE_CODEX_APP_BUILD_FLAVOR: 'prod', BROWSER_USE_CODEX_APP_VERSION: '26.924.22138',
    BROWSER_USE_DISABLE_AMBIENT_NETWORK: '1', NODE_REPL_DISABLE_ANALYTICS: '1' })) assert.equal(e[key], value, key);
  assert.ok(!('SKY_ENABLE_AUDIO' in e) && !('NODE_REPL_ENABLE_AUDIO' in e));
  assert.equal(e.NODE_REPL_NODE_PATH, join(r.runtime, 'bin/node'));
  assert.equal(e.CUA_REPL_NODE_REPL_PATH, join(r.runtime, 'bin/node_repl'));
  assert.equal(e.PATH, `${join(r.runtime, 'bin')}:/usr/bin:/bin`);
});

test('audio: the opt-in sets both original flags; without it the caller’s policy stays', (t) => {
  const r = release(t);
  const on = env(r, { SKY_ENABLE_AUDIO: '0', NODE_REPL_ENABLE_AUDIO: '0' }, { audio: true });
  assert.deepEqual([on.SKY_ENABLE_AUDIO, on.NODE_REPL_ENABLE_AUDIO], ['1', '1']);
  const kept = env(r, { SKY_ENABLE_AUDIO: '1', NODE_REPL_ENABLE_AUDIO: '1' });
  assert.deepEqual([kept.SKY_ENABLE_AUDIO, kept.NODE_REPL_ENABLE_AUDIO], ['1', '1']);
});

test('caller configuration and policies survive', (t) => {
  const r = release(t);
  const settings = { CUA_REPL_BROWSER_ENV: 'orbit', CUA_REPL_ENABLED_SURFACES: 'browser', OAI_SKY_CONFIG_PATH: '/desktop/options.json',
    OAI_SKY_LINUX_BIN: '/engine/sky', NODE_REPL_JS_BANNER: 'configured startup', NODE_REPL_TRUSTED_SERVICES: '{"custom":"service"}',
    NODE_REPL_REQUEST_META: '{"test":"context"}', NODE_REPL_FORCE_STRICT_AUTO_REVIEW: '1', NODE_REPL_ENFORCE_MODEL_CHECK: '1',
    CODEX_CLI_PATH: '/host/codex', BROWSER_USE_AVAILABLE_BACKENDS: 'chrome,cdp,iab', BROWSER_USE_CONFIG_PATH: '/browser.json',
    NODE_REPL_ENABLE_NETWORK_ISOLATION: '1', NODE_REPL_DISABLE_ANALYTICS: '0', BROWSER_USE_TINYSKY_ENABLED: '0',
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '2300', BROWSER_USE_DISABLE_AMBIENT_NETWORK: '0',
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: 'alpha', BROWSER_USE_CODEX_APP_VERSION: 'fixture' };
  const e = env(r, settings);
  for (const [key, value] of Object.entries(settings)) assert.equal(e[key], value, key);
});

test('a generic connection identity names the connection only, freshly each time', (t) => {
  const r = release(t);
  const first = JSON.parse(env(r).NODE_REPL_REQUEST_META);
  assert.deepEqual(Object.keys(first), ['x-codex-turn-metadata']);
  assert.deepEqual(Object.keys(first['x-codex-turn-metadata']).sort(), ['session_id', 'turn_id']);
  assert.notDeepEqual(first, JSON.parse(env(r).NODE_REPL_REQUEST_META));
});

test('an unusable launch directory is left for the filesystem root', (t) => {
  const blocked = join(temporary(t), 'blocked');
  mkdirSync(blocked);
  const previous = process.cwd();
  t.after(() => process.chdir(previous));
  process.chdir(blocked);
  leaveUnusableWorkingDirectory();
  assert.equal(process.cwd(), blocked);
  chmodSync(blocked, 0);
  if (process.getuid() !== 0) {
    leaveUnusableWorkingDirectory();
    assert.equal(process.cwd(), '/');
  }
  chmodSync(blocked, 0o755);
});

test('the Linux default points node_repl at the sandbox shim, keeping a caller allowlist and Codex path', (t) => {
  const r = release(t);
  const path = shim(r);
  const e = env(r);
  const config = JSON.parse(e.LCU_SANDBOX_SHIM);
  assert.equal(e.CODEX_CLI_PATH, path);
  assert.equal(config.codex, join(r.root, 'app/resources/codex'));
  assert.equal(config.runtime, e.NODE_REPL_NODE_PATH.replace(/\/bin\/node$/, ''));
  assert.equal(config.wrapper, null);
  assert.deepEqual(e.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST.split(','), ['LCU_SANDBOX_SHIM']);
  assert.deepEqual(Object.keys(JSON.parse(e.NODE_REPL_REQUEST_META)), ['x-codex-turn-metadata']);
  const caller = env(r, { CODEX_CLI_PATH: '/host/codex', NODE_REPL_UNTRUSTED_ENV_ALLOWLIST: 'FIRST,SECOND' });
  assert.equal(JSON.parse(caller.LCU_SANDBOX_SHIM).codex, '/host/codex');
  assert.equal(caller.CODEX_CLI_PATH, path);
  assert.equal(caller.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST, 'FIRST,SECOND,LCU_SANDBOX_SHIM');
  assert.deepEqual(env(r, { LCU_TEST_SANDBOX_SHIM_FAULT: 'unrecognized-kernel' }).NODE_REPL_UNTRUSTED_ENV_ALLOWLIST.split(','),
    ['LCU_SANDBOX_SHIM', 'LCU_TEST_SANDBOX_SHIM_FAULT']);
});

test('the shim is told about LCU’s own Sky wrapper', (t) => {
  const r = release(t);
  shim(r);
  inputWrapper(r);
  const e = env(r);
  const wrapper = join(r.root, 'lcu/linux_sky_service.mjs');
  assert.equal(JSON.parse(e.NODE_REPL_TRUSTED_SERVICES).sky, wrapper);
  assert.equal(JSON.parse(e.LCU_SANDBOX_SHIM).wrapper, wrapper);
});

test('without the shim file the original behavior stays, which fails closed', (t) => {
  const r = release(t);
  const e = env(r);
  assert.ok(!('LCU_SANDBOX_SHIM' in e) && !(e.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST ?? '').includes('LCU_SANDBOX_SHIM'));
  assert.ok(!e.CODEX_CLI_PATH.endsWith('lcu-codex-sandbox'));
});

test('off gives node_repl a disabled sandbox state, adding only what is missing; host mode changes nothing', (t) => {
  const r = release(t);
  const path = shim(r);
  const off = env(r, { LCU_NODE_REPL_SANDBOX: 'off' });
  const state = JSON.parse(off.NODE_REPL_REQUEST_META)['codex/sandbox-state-meta'];
  assert.deepEqual(state.permissionProfile, { type: 'disabled' });
  assert.equal(state.sandboxCwd, pathToFileURL(process.cwd()).href);
  assert.ok(!('LCU_SANDBOX_SHIM' in off) && off.CODEX_CLI_PATH !== path);
  const supplied = { 'x-codex-turn-metadata': { session_id: 'host-session', turn_id: 'host-turn' } };
  const actual = JSON.parse(env(r, { LCU_NODE_REPL_SANDBOX: 'off', NODE_REPL_REQUEST_META: JSON.stringify(supplied) }).NODE_REPL_REQUEST_META);
  assert.deepEqual(actual['codex/sandbox-state-meta'].permissionProfile, { type: 'disabled' });
  delete actual['codex/sandbox-state-meta'];
  assert.deepEqual(actual, supplied);
  const host = env(r, { LCU_NODE_REPL_SANDBOX: 'host' });
  assert.ok(!('LCU_SANDBOX_SHIM' in host) && host.CODEX_CLI_PATH !== path);
  assert.deepEqual(Object.keys(JSON.parse(host.NODE_REPL_REQUEST_META)), ['x-codex-turn-metadata']);
});

test('host-supplied sandbox state and unreadable host metadata are never replaced', (t) => {
  const r = release(t);
  shim(r);
  const supplied = JSON.stringify({ 'codex/sandbox-state-meta': { permissionProfile: { type: 'managed' }, sandboxCwd: 'file:///work' },
    'x-codex-turn-metadata': { session_id: 's' } });
  for (const mode of ['', 'off', 'host']) assert.equal(env(r, { NODE_REPL_REQUEST_META: supplied, LCU_NODE_REPL_SANDBOX: mode }).NODE_REPL_REQUEST_META, supplied);
  for (const mode of ['', 'off']) {
    for (const raw of ['not json', '[1]', '', '"text"']) assert.equal(env(r, { NODE_REPL_REQUEST_META: raw, LCU_NODE_REPL_SANDBOX: mode }).NODE_REPL_REQUEST_META, raw);
  }
  assert.deepEqual(Object.keys(JSON.parse(env(r, {}, { platform: 'darwin' }).NODE_REPL_REQUEST_META)), ['x-codex-turn-metadata']);
});

test('Linux input translation wraps only the Sky service, keeps the browser service, and can be turned off', (t) => {
  const r = release(t);
  inputWrapper(r);
  const wrapper = join(r.root, 'lcu/linux_sky_service.mjs');
  const e = env(r);
  assert.deepEqual(JSON.parse(e.NODE_REPL_TRUSTED_SERVICES), { sky: wrapper });
  assert.equal(e.LCU_LINUX_SKY_SERVICE_PATH, join(r.modules, '@oai/sky/dist/project/cua/sky_js/src/service.js'));
  assert.equal(e.LCU_LINUX_INPUT_TOOLKITS, 'gtk4,qt-scroll');
  assert.ok(e.NODE_REPL_TRUSTED_CODE_PATHS.split(':').includes(join(r.root, 'lcu')));
  assert.deepEqual(JSON.parse(env(r, {}, { chrome: true }).NODE_REPL_TRUSTED_SERVICES), { browser: '@oai/browser-desktop/service', sky: wrapper });
  for (const value of ['off', 'OFF', ' off ', '0', 'false', 'no']) {
    const off = env(r, { LCU_LINUX_INPUT_TRANSLATION: value });
    assert.ok(!('NODE_REPL_TRUSTED_SERVICES' in off) && !('LCU_LINUX_SKY_SERVICE_PATH' in off), value);
  }
  assert.ok('NODE_REPL_TRUSTED_SERVICES' in env(r, { LCU_LINUX_INPUT_TRANSLATION: 'on' }));
  const mac = env(r, {}, { platform: 'darwin' });
  assert.ok(!('LCU_LINUX_SKY_SERVICE_PATH' in mac) && !('NODE_REPL_TRUSTED_SERVICES' in mac));
});

test('caller-supplied service maps are kept verbatim; an explicit original Sky entry is replaced', (t) => {
  const r = release(t);
  inputWrapper(r);
  for (const supplied of ['{"sky":"/custom/sky.mjs"}', '{}', '{"custom": "/custom/service.mjs"}', '{"browser": "@oai/browser-desktop/service"}',
    '{"sky": "/custom/sky.mjs", "other": "x"}', '[]', 'not json']) {
    const e = env(r, { NODE_REPL_TRUSTED_SERVICES: supplied });
    assert.equal(e.NODE_REPL_TRUSTED_SERVICES, supplied);
    assert.ok(!('LCU_LINUX_SKY_SERVICE_PATH' in e));
  }
  const e = env(r, { NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: '@oai/sky/service', other: '/custom/service.mjs' }) });
  assert.deepEqual(JSON.parse(e.NODE_REPL_TRUSTED_SERVICES), { sky: join(r.root, 'lcu/linux_sky_service.mjs'), other: '/custom/service.mjs' });
  assert.ok('LCU_LINUX_SKY_SERVICE_PATH' in e);
});

test('a tested pair that handles a toolkit natively is not translated for it', (t) => {
  const r = release(t);
  inputWrapper(r, pair({ native_input: ['gtk4'] }));
  assert.equal(env(r).LCU_LINUX_INPUT_TOOLKITS, 'qt-scroll');
  inputWrapper(r, pair({ native_input: ['gtk4', 'qt-scroll'] }));
  assert.ok(!('NODE_REPL_TRUSTED_SERVICES' in env(r)) && !('LCU_LINUX_INPUT_TOOLKITS' in env(r)));
  inputWrapper(r, pair({ app_version: '26.999.1', native_input: ['gtk4', 'qt-scroll'] }));
  assert.equal(env(r).LCU_LINUX_INPUT_TOOLKITS, 'gtk4,qt-scroll');
});

test('an unreadable tested record keeps the translation on', (t) => {
  const r = release(t);
  inputWrapper(r);
  writeFileSync(join(r.root, 'tested-versions.json'), '{broken');
  assert.equal(env(r).LCU_LINUX_INPUT_TOOLKITS, 'gtk4,qt-scroll');
});

test('module and trust roots: defaults first, the caller’s kept; CODEX_HOME defaults like Node and is never normalized', (t) => {
  const r = release(t);
  const e = env(r, { NODE_REPL_NODE_MODULE_DIRS: '/extra/modules', NODE_REPL_TRUSTED_CODE_PATHS: '/trusted', PATH: '/usr/bin', HOME: '/fixture' });
  assert.equal(e.NODE_REPL_NODE_MODULE_DIRS, `${r.modules}:/extra/modules`);
  assert.equal(e.NODE_REPL_TRUSTED_CODE_PATHS, `/fixture/.codex:${r.modules}:${r.plugins}:/trusted`);
  assert.equal(e.CODEX_HOME, '/fixture/.codex');
  for (const [home, expected] of [['', '.codex'], ['relative/home', 'relative/home/.codex'], ['relative/../home', 'home/.codex'],
    ['//fixture/home', '/fixture/home/.codex']]) {
    const homed = env(r, { HOME: home });
    assert.equal(homed.CODEX_HOME, expected);
    assert.equal(homed.NODE_REPL_TRUSTED_CODE_PATHS.split(':')[0], expected);
  }
  for (const selected of ['/fixture/custom', 'relative/../home', '  /fixture/spaces  ', '']) {
    const chosen = env(r, { CODEX_HOME: selected });
    assert.equal(chosen.CODEX_HOME, selected);
    assert.equal(chosen.NODE_REPL_TRUSTED_CODE_PATHS, `${selected ? `${selected}:` : ''}${r.modules}:${r.plugins}`);
  }
});

function launch(t, r, argv, settings = {}) {
  const calls = [];
  override(t, process, 'env', { ...settings });
  t.mock.method(process, 'execve', (...args) => calls.push(args));
  return main(r.root, argv).then((status) => ({ status, calls }));
}

test('the original entry point is exec’d with the verified local app', async (t) => {
  const r = release(t);
  const { calls } = await launch(t, r, [], { CUA_REPL_ENABLED_SURFACES: 'computer' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], join(r.runtime, 'bin/node'));
  assert.deepEqual(calls[0][1], [join(r.runtime, 'bin/node'), join(r.modules, '@oai/cua-repl/bin/cua-repl.mjs')]);
});

test('--chrome and --audio reach the original child; an explicit surface wins', async (t) => {
  const r = release(t);
  assert.equal((await launch(t, r, ['--chrome'])).calls[0][2].CUA_REPL_ENABLED_SURFACES, 'browser,computer');
  t.mock.restoreAll();
  const audio = (await launch(t, r, ['--audio'], { SKY_ENABLE_AUDIO: '0' })).calls[0][2];
  assert.deepEqual([audio.SKY_ENABLE_AUDIO, audio.NODE_REPL_ENABLE_AUDIO], ['1', '1']);
  t.mock.restoreAll();
  assert.equal((await launch(t, r, ['--chrome'], { CUA_REPL_ENABLED_SURFACES: 'computer' })).calls[0][2].CUA_REPL_ENABLED_SURFACES, 'computer');
});

function captureStdout(t) {
  let output = '';
  mockWrite(t, process.stdout, (text) => { output += text; return true; });
  return () => output;
}

test('registration probes keep --version and --help; duplicates fail with the usage', async (t) => {
  const r = release(t);
  const output = captureStdout(t);
  assert.equal((await launch(t, r, ['--chrome', '--audio', '--version'])).status, 0);
  assert.match(output(), /lcu source-checkout \(ChatGPT linux 26\.924\.22138; CUA fixture-runtime-new\)/);
  assert.equal((await main(r.root, ['--chrome', '--help'])), 0);
  assert.match(output(), /Usage: lcu/);
  for (const argv of [['--audio', '--audio'], ['--audio', '--audio', '--help'], ['--chrome', '--chrome', '--version']]) {
    await assert.rejects(main(r.root, argv), /Usage: lcu/);
  }
  assert.equal(process.execve.mock.callCount(), 0);
});

test('--version reports an invalid selected app and exits 1; a source checkout reports none', async (t) => {
  const r = release(t);
  const output = captureStdout(t);
  const descriptor = JSON.parse(readFileSync(join(r.root, 'installation.json')));
  writeFileSync(join(r.root, 'installation.json'), JSON.stringify({ ...descriptor, app: 'mismatched-generation' }));
  assert.equal(await main(r.root, ['--version']), 1);
  assert.match(output(), /app invalid:/);
  unlinkSync(join(r.root, 'installation.json'));
  write(join(r.root, 'bundle.json'), JSON.stringify({ version: '0.3.0' }));
  assert.equal(await main(r.root, ['--version']), 0);
  assert.match(output(), /lcu 0\.3\.0 \(ChatGPT linux app not selected\)/);
});

test('a retargeted app link or another architecture is refused before launch', async (t) => {
  const r = release(t);
  const manifest = join(r.app, 'resources/cua_node/manifest.json');
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest)), runtime_archive_version: 'upgraded-runtime' }));
  assert.equal(paths(r.root).app, join(r.root, 'app'));
  assert.deepEqual(paths(r.root).metadata, { version: '26.924.22138', runtime: 'upgraded-runtime' });
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest)), arch: 'x64' }));
  assert.throws(() => env(r), /unsupported platform, architecture.*Rerun/);
  const descriptor = JSON.parse(readFileSync(join(r.root, 'installation.json')));
  writeFileSync(join(r.root, 'installation.json'), JSON.stringify({ ...descriptor, app: 'another-generation' }));
  await assert.rejects(launch(t, r, []), /descriptor does not match/);
  assert.equal(process.execve.mock.callCount(), 0);
});

test('the removed embedded browser flag explains its replacement', async (t) => {
  await assert.rejects(main(release(t).root, ['--with-browser-host']), /lcu browser install/);
});

test('later-phase commands are dispatched to their modules without resolving the app', async (t) => {
  const r = release(t);
  unlinkSync(join(r.root, 'installation.json')); // nothing here may need the selected app
  // A private copy of the runtime, whose command modules record their calls.
  const copy = join(r.base, 'copy/lcu');
  cpSync(join(REPO, 'lcu'), copy, { recursive: true });
  const names = ['maintenance', 'setup', 'browser', 'status', 'apps', 'origins', 'update', 'doctor'];
  for (const name of names) write(join(copy, `${name}.mjs`), 'export const calls = []; export function main(...args) { calls.push(args); return 3; }\n');
  const { main: copied } = await import(pathToFileURL(join(copy, 'runtime.mjs')).href);
  const prefix = join(r.root, '../..');
  for (const [name, argv, expected] of [['maintenance', ['prune', '--keep', '3', '--yes'], [r.root, ['--keep', '3', '--yes']]],
    ['setup', ['setup', '--list-agents'], [['--list-agents', '--prefix', prefix]]], ['setup', ['setup', '--prefix', '/chosen'], [['--prefix', '/chosen']]],
    ['browser', ['browser', 'install'], [r.root, ['install']]], ['status', ['status', '--json'], [r.root, ['--json']]],
    ['apps', ['apps', 'list'], [r.root, ['list']]], ['origins', ['origins', 'list'], [['list']]],
    ['update', ['update', '--check'], [r.root, ['--check']]], ['doctor', ['doctor', '--help'], [r.root, ['--help']]]]) {
    const { calls } = await import(pathToFileURL(join(copy, `${name}.mjs`)).href);
    calls.length = 0;
    assert.equal(await copied(r.root, argv), 3, name);
    assert.deepEqual(calls, [expected], name);
  }
});

function runLcu(r, argv, input, extra = {}) {
  const script = `import { cli } from ${JSON.stringify(pathToFileURL(join(REPO, 'lcu/runtime.mjs')).href)};
    await cli(${JSON.stringify(r.root)}, ${JSON.stringify(argv)});`;
  const out = join(r.base, 'child');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { input,
    env: { PATH: process.env.PATH, HOME: '/fixture-home', LCU_TEST_OUT: out, ...extra }, encoding: 'utf8' });
  const read = (suffix) => (existsSync(out + suffix) ? readFileSync(out + suffix, 'utf8') : null);
  return { ...result, argv: read('.argv'), env: read('.env'), stdin: read('.stdin') };
}

test('--mcp-discovery-compat answers the probe, then hands the rest of stdin to the original server', (t) => {
  const r = release(t);
  const following = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n';
  const result = runLcu(r, ['--chrome', '--mcp-discovery-compat'], `{"jsonrpc":"2.0","id":0,"method":"server/discover"}\n${following}`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { jsonrpc: '2.0', id: 0, error: { code: -32601, message: 'Method not found' } });
  assert.equal(result.stdin, following);
  assert.deepEqual(result.argv.trim().split('\n'), [join(r.runtime, 'bin/node'), join(r.modules, '@oai/cua-repl/bin/cua-repl.mjs')]);
  assert.match(result.env, /^CUA_REPL_ENABLED_SURFACES=browser,computer$/m);
  assert.match(result.env, /^CODEX_HOME=\/fixture-home\/\.codex$/m);
  const refused = runLcu(r, ['--mcp-discovery-compat'], '{"jsonrpc":"2.0","id":0,"method":"tools/list"}\n');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^LCU: Expected an initial JSON-RPC server\/discover request/);
  assert.equal(refused.stdout, '');
});

test('a bare server in an interactive terminal reports the usage and exits 2', async (t) => {
  const r = release(t);
  const tty = await import('node:tty');
  t.mock.method(tty.default, 'isatty', () => true);
  let message = '';
  mockWrite(t, process.stderr, (text) => { message += text; return true; });
  const { status, calls } = await launch(t, r, []);
  assert.deepEqual([status, calls], [2, []]);
  assert.match(message, /stdio MCP server/);
  assert.match(message, /Usage: lcu/);
});
