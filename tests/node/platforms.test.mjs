import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync,
  utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';

import {
  MAC_HELPER, MAC_REQUIRED_FILES, MAC_SOCKET_ENV, MAC_SOCKET_SUFFIX, aclWritersUntrusted, macSocketPath, readAcls,
  macSocketPathProblem, plistStrings, resolveInstalledLinuxApp, resolveInstalledMacApp, sealRecord, untrustedEntry,
} from '../../lcu/platforms.mjs';
import { linuxApp, override, posixTests, temporary, write } from './fixtures.mjs';

const test = posixTests('the Linux and macOS app checks test POSIX modes, ownership and symlinks');

const VERSION = '26.924.22138';
const RUNTIME = '0.0.24/20260924074400-f52ea85e2a98';

const plist = (values) => '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
  '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n' +
  Object.entries(values).map(([key, value]) => `\t<key>${key}</key>\n\t<string>${value}</string>\n`).join('') + '</dict>\n</plist>\n';

function macApp(t) {
  const app = join(temporary(t), 'ChatGPT.app');
  const contents = join(app, 'Contents');
  write(join(contents, 'Info.plist'), plist({ CFBundleIdentifier: 'com.openai.codex', CFBundleShortVersionString: VERSION }));
  write(join(contents, MAC_HELPER, 'Contents/Info.plist'), plist({ CFBundleIdentifier: 'com.openai.sky.CUAService' }));
  write(join(contents, 'Resources/cua_node/manifest.json'), JSON.stringify({ platform: 'darwin', arch: 'arm64', runtime_archive_version: RUNTIME }));
  for (const relative of MAC_REQUIRED_FILES) write(join(contents, relative), relative, 0o755);
  const cli = write(join(contents, 'Resources/codex-cli/bin/codex'), 'original cli', 0o755);
  const host = write(join(contents, 'Resources/codex-cli/bin/codex-code-mode-host'), 'original code-mode host', 0o755);
  return { app, contents, cli, host };
}

function codesign({ verify = 0, team = '2DC432GLL2' } = {}) {
  const calls = [];
  const fake = (command, args) => {
    calls.push([command, ...args]);
    if (args.includes('--verify')) return { status: verify, stdout: '', stderr: verify ? 'invalid' : '' };
    const identifier = args.at(-1).endsWith('ChatGPT.app') ? 'com.openai.codex' : 'com.openai.sky.CUAService';
    return { status: 0, stdout: '', stderr: `Identifier=${identifier}\nTeamIdentifier=${team}\n` };
  };
  fake.calls = calls;
  return fake;
}

function onMac(t, fake = codesign()) {
  override(t, process, 'platform', 'darwin');
  t.mock.method(childProcess, 'spawnSync', fake);
  return fake;
}

test('a macOS app is accepted in place with its version, runtime and relocated original CLI, each signature checked once', (t) => {
  const { app, cli, host } = macApp(t);
  const fake = onMac(t);
  const result = resolveInstalledMacApp(app, { arch: 'arm64' });
  assert.deepEqual([result.app, result.version, result.runtimeVersion, result.arch, result.codexCli, result.codeModeHost],
    [app, VERSION, RUNTIME, 'arm64', cli, host]);
  assert.deepEqual(fake.calls.map((call) => call.slice(1, -1).join(' ')),
    ['--verify --deep --strict', '-dv --verbose=2', '--verify --deep --strict', '-dv --verbose=2']);
  assert.ok(fake.calls.every(([command]) => command === '/usr/bin/codesign'));
});

test('a compatible update is accepted without version, runtime or hash pins', (t) => {
  const { app, contents, cli } = macApp(t);
  write(join(contents, 'Info.plist'), plist({ CFBundleIdentifier: 'com.openai.codex', CFBundleShortVersionString: '26.999.12345' }));
  write(join(contents, 'Resources/cua_node/manifest.json'), JSON.stringify({ platform: 'darwin', arch: 'arm64', runtime_archive_version: '0.0.99/new' }));
  writeFileSync(cli, 'updated signed app CLI');
  onMac(t);
  const result = resolveInstalledMacApp(app, { arch: 'arm64' });
  assert.deepEqual([result.version, result.runtimeVersion], ['26.999.12345', '0.0.99/new']);
});

test('missing files, partial CLI layouts, wrong identity, architecture or host are refused', (t) => {
  const { app, contents, cli } = macApp(t);
  override(t, process, 'platform', 'linux');
  assert.throws(() => resolveInstalledMacApp(app, { arch: 'arm64' }), /only be validated on macOS/);
  onMac(t);
  assert.throws(() => resolveInstalledMacApp(app, { arch: 'x86' }), /Unsupported macOS architecture/);
  unlinkSync(join(contents, MAC_REQUIRED_FILES[0]));
  assert.throws(() => resolveInstalledMacApp(app, { arch: 'arm64' }), /Required application file is missing/);
  write(join(contents, MAC_REQUIRED_FILES[0]), 'node', 0o755);
  unlinkSync(cli);
  assert.throws(() => resolveInstalledMacApp(app, { arch: 'arm64' }), /complete original Codex CLI layout/);
  write(cli, 'cli', 0o755);
  write(join(contents, 'Info.plist'), plist({ CFBundleIdentifier: 'wrong.identifier', CFBundleShortVersionString: VERSION }));
  assert.throws(() => resolveInstalledMacApp(app, { arch: 'arm64' }), /Unexpected application bundle identifier/);
});

test('an invalid signature or another signer is refused', (t) => {
  const { app } = macApp(t);
  onMac(t, codesign({ verify: 1 }));
  assert.throws(() => resolveInstalledMacApp(app, { arch: 'arm64' }), /signature verification failed/);
  childProcess.spawnSync.mock.mockImplementation(codesign({ team: 'another-team' }));
  assert.throws(() => resolveInstalledMacApp(app, { arch: 'arm64' }), /signer does not match/);
});

const deepChecks = (fake) => fake.calls.filter((call) => call.includes('--deep')).map((call) => call.at(-1));
const identityChecks = (fake) => fake.calls.filter((call) => call.includes('-dv')).length;

/** A fixture app with signature seals, the codesign stand-in, and the record in a scratch directory. */
function recordedMacApp(t) {
  const fixture = macApp(t);
  write(join(fixture.contents, '_CodeSignature/CodeResources'), 'app seal');
  write(join(fixture.contents, MAC_HELPER, 'Contents/_CodeSignature/CodeResources'), 'helper seal');
  const record = join(temporary(t), 'cache/macos-signatures.json');
  override(t, sealRecord, 'path', () => record);
  const fake = onMac(t);
  return { ...fixture, helper: join(fixture.contents, MAC_HELPER), record, fake };
}

test('a launch reuses a recorded deep check of the same build; the signer is still read every time', (t) => {
  const { app, helper, record, fake } = recordedMacApp(t);
  resolveInstalledMacApp(app, { arch: 'arm64', reuseRecordedSeal: true });
  assert.deepEqual(deepChecks(fake), [app, helper]);
  assert.equal(statSync(record).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(record)).mode & 0o777, 0o700);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(record, 'utf8'))), [app, helper]);
  fake.calls.length = 0;
  resolveInstalledMacApp(app, { arch: 'arm64', reuseRecordedSeal: true });
  assert.deepEqual(deepChecks(fake), [], 'no deep check for a recorded build');
  assert.equal(identityChecks(fake), 2);
});

test('installs, updates, doctor and the other commands check in full, and refresh the record', (t) => {
  const { app, helper, record, fake } = recordedMacApp(t);
  resolveInstalledMacApp(app, { arch: 'arm64', reuseRecordedSeal: true });
  rmSync(record);
  fake.calls.length = 0;
  resolveInstalledMacApp(app, { arch: 'arm64' });
  assert.deepEqual(deepChecks(fake), [app, helper]);
  assert.ok(existsSync(record), 'a full check records the build for the next launch');
  fake.calls.length = 0;
  resolveInstalledMacApp(app, { arch: 'arm64' });
  assert.deepEqual(deepChecks(fake), [app, helper], 'a recorded build is checked in full again');
});

test('any change to the bundle path, version, build, Info.plist file or seal checks that bundle in full', (t) => {
  const { app, contents, helper, fake } = recordedMacApp(t);
  const launch = (path = app) => {
    fake.calls.length = 0;
    resolveInstalledMacApp(path, { arch: 'arm64', reuseRecordedSeal: true });
    return deepChecks(fake);
  };
  const info = (values) => write(join(contents, 'Info.plist'), plist({ CFBundleIdentifier: 'com.openai.codex', ...values }));
  launch();
  assert.deepEqual(launch(), []);
  info({ CFBundleShortVersionString: '26.999.1' });
  assert.deepEqual(launch(), [app], 'version');
  info({ CFBundleShortVersionString: '26.999.1', CFBundleVersion: '2' });
  assert.deepEqual(launch(), [app], 'build');
  utimesSync(join(contents, 'Info.plist'), new Date(0), new Date(1_000));
  assert.deepEqual(launch(), [app], 'Info.plist rewritten with the same strings');
  write(join(contents, '_CodeSignature/CodeResources'), 'app seal of another build');
  assert.deepEqual(launch(), [app], 'app seal');
  write(join(helper, 'Contents/_CodeSignature/CodeResources'), 'helper seal of another build');
  assert.deepEqual(launch(), [helper], 'helper seal');
  assert.deepEqual(launch(), []);
  const moved = join(temporary(t), 'ChatGPT.app');
  renameSync(app, moved);
  assert.deepEqual(launch(moved), [moved, join(moved, 'Contents', MAC_HELPER)], 'another path');
});

test('a failed deep check is never recorded and fails as before', (t) => {
  const { app, record, fake } = recordedMacApp(t);
  childProcess.spawnSync.mock.mockImplementation(codesign({ verify: 1 }));
  assert.throws(() => resolveInstalledMacApp(app, { arch: 'arm64', reuseRecordedSeal: true }), /signature verification failed/);
  assert.ok(!existsSync(record));
  childProcess.spawnSync.mock.mockImplementation(fake);
  resolveInstalledMacApp(app, { arch: 'arm64', reuseRecordedSeal: true });
  assert.ok(existsSync(record));
  childProcess.spawnSync.mock.mockImplementation(codesign({ team: 'another-team' }));
  assert.throws(() => resolveInstalledMacApp(app, { arch: 'arm64', reuseRecordedSeal: true }), /signer does not match/,
    'a recorded seal never skips the signer check');
});

test('a missing, corrupt or unusable record, or an unsealed bundle, means a full check', (t) => {
  const { app, contents, helper, record, fake } = recordedMacApp(t);
  const launch = () => {
    fake.calls.length = 0;
    resolveInstalledMacApp(app, { arch: 'arm64', reuseRecordedSeal: true });
    return deepChecks(fake);
  };
  for (const corrupt of ['{not json', '[]', 'null', JSON.stringify({ [app]: { seal: 'forged' } })]) {
    write(record, corrupt);
    assert.deepEqual(launch(), [app, helper], corrupt);
    assert.deepEqual(launch(), [], `rewritten after ${corrupt}`);
  }
  override(t, sealRecord, 'path', () => { throw new Error('no home'); });
  assert.deepEqual(launch(), [app, helper]);
  override(t, sealRecord, 'path', () => record);
  rmSync(join(contents, '_CodeSignature'), { recursive: true });
  assert.deepEqual(launch(), [app]);
  assert.deepEqual(launch(), [app], 'nothing to record without a seal');
});

test('concurrent launches wait for the one checking and reuse its record, or check themselves after a bounded wait', (t) => {
  const { app, contents, helper, record, fake } = recordedMacApp(t);
  resolveInstalledMacApp(app, { arch: 'arm64', reuseRecordedSeal: true });
  const finished = readFileSync(record, 'utf8');
  rmSync(record);
  // Another process holds the lock and records its check while this one polls.
  let polls = 0;
  override(t, sealRecord, 'lock', () => {
    polls += 1;
    if (polls === 3) writeFileSync(record, finished);
    return null;
  });
  fake.calls.length = 0;
  resolveInstalledMacApp(app, { arch: 'arm64', reuseRecordedSeal: true });
  assert.deepEqual(deepChecks(fake), []);
  assert.equal(polls, 3);
  // The app changes while this launch waits: the record found after the wait is compared with the bundle as it
  // is then, so the app is checked in full once the holder is done.
  rmSync(record);
  polls = 0;
  override(t, sealRecord, 'lock', (path) => {
    polls += 1;
    if (polls === 3) {
      writeFileSync(record, finished);
      write(join(contents, '_CodeSignature/CodeResources'), 'app seal of another build');
    }
    if (polls < 5) return null;
    const fd = openSync(path, 'w');
    return () => closeSync(fd);
  });
  fake.calls.length = 0;
  resolveInstalledMacApp(app, { arch: 'arm64', reuseRecordedSeal: true });
  assert.deepEqual(deepChecks(fake), [app]);
  assert.equal(polls, 5);
  // A holder that never finishes: each bundle is checked after the wait, then recorded.
  rmSync(record);
  override(t, sealRecord, 'lock', () => null);
  override(t, sealRecord, 'wait', 120);
  fake.calls.length = 0;
  const started = Date.now();
  resolveInstalledMacApp(app, { arch: 'arm64', reuseRecordedSeal: true });
  assert.ok(Date.now() - started >= 240);
  assert.deepEqual(deepChecks(fake), [app, helper]);
  assert.ok(existsSync(record));
  // A lock that cannot be opened does not hold the launch up.
  override(t, sealRecord, 'lock', () => { throw new Error('EACCES'); });
  rmSync(record);
  fake.calls.length = 0;
  resolveInstalledMacApp(app, { arch: 'arm64', reuseRecordedSeal: true });
  assert.deepEqual(deepChecks(fake), [app, helper]);
});

test('the lock beside the record is released after each check, also a failed one', (t) => {
  const { app, record } = recordedMacApp(t);
  const held = [];
  override(t, sealRecord, 'lock', (path) => {
    assert.equal(path, `${record}.lock`);
    const fd = openSync(path, 'w');
    held.push(fd);
    return () => closeSync(fd);
  });
  resolveInstalledMacApp(app, { arch: 'arm64', reuseRecordedSeal: true });
  childProcess.spawnSync.mock.mockImplementation(codesign({ verify: 1 }));
  rmSync(record);
  assert.throws(() => resolveInstalledMacApp(app, { arch: 'arm64', reuseRecordedSeal: true }), /verification failed/);
  assert.equal(held.length, 3);
  for (const fd of held) assert.throws(() => fstatSync(fd), { code: 'EBADF' });
});

test('binary property lists are read too, and nested keys never count', () => {
  const binary = Buffer.from('YnBsaXN0MDDUAQIDBAUGBwlfEBJDRkJ1bmRsZUlkZW50aWZpZXJfEBpDRkJ1bmRsZVNob3J0VmVyc2lvblN0cmluZ1ZOZXN0ZWRTVW5pXxAZY29tLm9wZW5haS5za3kuQ1VBU2VydmljZVQyNi4x0QEIUXhiAOkmAwgRJkNKTmpvcnQAAAAAAAABAQAAAAAAAAAKAAAAAAAAAAAAAAAAAAAAeQ==', 'base64');
  assert.deepEqual(plistStrings(binary), { CFBundleIdentifier: 'com.openai.sky.CUAService', CFBundleShortVersionString: '26.1', Uni: 'é☃' });
  const nested = '<plist><dict><key>Types</key><array><dict><key>CFBundleIdentifier</key><string>evil</string></dict></array>' +
    '<key>CFBundleIdentifier</key><string>com.openai.codex</string><key>E</key><string/><key>A&amp;B</key><string>x&lt;y</string></dict></plist>';
  assert.deepEqual(plistStrings(Buffer.from(nested)), { CFBundleIdentifier: 'com.openai.codex', E: '', 'A&B': 'x<y' });
});

const SUFFIX = `/${MAC_SOCKET_SUFFIX}`;
const homeOfLength = (size) => `/Users/${'a'.repeat(size - SUFFIX.length - '/Users/'.length)}`;
const realHome = (t, homedir) => t.mock.method(os, 'userInfo', () => ({ homedir, username: 'fixture' }));

test('the helper socket path: 103 bytes pass, 104 do not, bytes not characters count', (t) => {
  assert.equal(Buffer.byteLength(SUFFIX), 83);
  realHome(t, homeOfLength(103));
  assert.deepEqual(macSocketPath({}), { path: homeOfLength(103) + SUFFIX, overridden: false });
  assert.equal(macSocketPathProblem({}), null);
  os.userInfo.mock.mockImplementation(() => ({ homedir: homeOfLength(104) }));
  const message = macSocketPathProblem({});
  for (const part of ['is 104 bytes (macOS limit 103)', homeOfLength(104) + SUFFIX, 'home folder', 'LCU cannot change the signed helper']) {
    assert.ok(message.includes(part), part);
  }
  for (const [name, fails] of [['a'.repeat(13), false], ['a'.repeat(14), true]]) {
    os.userInfo.mock.mockImplementation(() => ({ homedir: `/Users/${name}` }));
    assert.equal(Boolean(macSocketPathProblem({})), fails);
  }
  os.userInfo.mock.mockImplementation(() => ({ homedir: `/Users/${'é'.repeat(13)}` }));
  assert.match(macSocketPathProblem({}), /is 116 bytes/);
});

test('the default socket path uses the real home, an override replaces it, an empty one is ignored', (t) => {
  realHome(t, '/Users/real');
  assert.deepEqual(macSocketPath({ HOME: `/tmp/${'x'.repeat(200)}` }), { path: `/Users/real${SUFFIX}`, overridden: false });
  assert.deepEqual(macSocketPath({ [MAC_SOCKET_ENV]: '' }), { path: `/Users/real${SUFFIX}`, overridden: false });
  assert.deepEqual(macSocketPath({ [MAC_SOCKET_ENV]: '/tmp/s.sock' }), { path: '/tmp/s.sock', overridden: true });
  const message = macSocketPathProblem({ [MAC_SOCKET_ENV]: `/tmp/${'b'.repeat(99)}` });
  assert.match(message, /104 bytes/);
  assert.ok(message.includes(MAC_SOCKET_ENV));
  assert.ok(!message.includes('home folder, so'));
});

test('an installed Linux app is selected in place with its actual versions', (t) => {
  const app = linuxApp(join(temporary(t), 'chatgpt'), { relocated: true });
  const result = resolveInstalledLinuxApp(app, { arch: 'arm64' });
  assert.deepEqual([result.app, result.version, result.runtimeVersion, result.codexCli],
    [app, VERSION, 'runtime-new', join(app, 'resources/codex-cli/bin/codex')]);
});

test('a Linux app missing a required file or built for another architecture is refused', (t) => {
  const base = temporary(t);
  const app = linuxApp(join(base, 'chatgpt'));
  unlinkSync(join(app, 'resources/cua_node/bin/node_repl'));
  assert.throws(() => resolveInstalledLinuxApp(app, { arch: 'arm64' }), /Application payload is incomplete/);
  const other = linuxApp(join(base, 'other'), { arch: 'x64' });
  assert.throws(() => resolveInstalledLinuxApp(other, { arch: 'arm64' }), /unsupported platform, architecture/);
});

test('the version falls back to the dpkg package that owns the exact executable path', (t) => {
  const app = linuxApp(join(temporary(t), 'chatgpt'));
  writeFileSync(join(app, 'resources/app.asar'), 'not an archive');
  const queries = [];
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    queries.push([command, ...args]);
    if (args[0] === '-S') return { status: 0, stdout: `chatgpt:arm64: ${join(app, 'ChatGPT')}\nother: ${join(app, 'ChatGPT')}x\n` };
    return { status: 0, stdout: '26.1.2 arm64' };
  });
  assert.equal(resolveInstalledLinuxApp(app, { arch: 'arm64' }).version, '26.1.2');
  assert.deepEqual(queries.map((query) => query.slice(0, 2)), [['dpkg-query', '-S'], ['dpkg-query', '-W']]);
  childProcess.spawnSync.mock.mockImplementation((command, args) => (args[0] === '-S'
    ? { status: 0, stdout: `chatgpt:arm64: ${join(app, 'ChatGPT')}\n` } : { status: 0, stdout: '26.1.2 amd64' }));
  assert.throws(() => resolveInstalledLinuxApp(app, { arch: 'arm64' }), /wrong architecture/);
});

test('an app tree writable by other accounts is refused, including writable ancestors; a sticky directory is fine', (t) => {
  const base = temporary(t);
  const app = linuxApp(join(base, 'shared/chatgpt'));
  resolveInstalledLinuxApp(app, { arch: 'arm64' });
  chmodSync(join(app, 'resources/cua_node/bin'), 0o777);
  assert.throws(() => resolveInstalledLinuxApp(app, { arch: 'arm64' }), /not in a location only root and this account/);
  chmodSync(join(app, 'resources/cua_node/bin'), 0o755);
  chmodSync(join(app, 'resources/cua_node/bin/node'), 0o757);
  assert.throws(() => resolveInstalledLinuxApp(app, { arch: 'arm64' }), /writable by group or other/);
  chmodSync(join(app, 'resources/cua_node/bin/node'), 0o755);
  chmodSync(join(base, 'shared'), 0o777);
  assert.throws(() => resolveInstalledLinuxApp(app, { arch: 'arm64' }), /shared is writable/);
  chmodSync(join(base, 'shared'), 0o1777);
  resolveInstalledLinuxApp(app, { arch: 'arm64' });
});

test('an app tree owned by another account is refused unless trusted', { skip: process.getuid?.() === 0 && 'root-owned files are always trusted' }, (t) => {
  const app = linuxApp(join(temporary(t), 'chatgpt'));
  const owner = process.getuid();
  override(t, process, 'getuid', () => owner + 1);
  override(t, process, 'geteuid', () => owner + 1);
  assert.throws(() => resolveInstalledLinuxApp(app, { arch: 'arm64' }), new RegExp(`owned by uid ${owner}`));
  assert.equal(resolveInstalledLinuxApp(app, { arch: 'arm64', trustedUids: [owner] }).app, app);
});

test('links: escaping the app is refused, links inside it are followed and validated, cycles end', (t) => {
  const base = temporary(t);
  const app = linuxApp(join(base, 'chatgpt'));
  const modules = join(app, 'resources/cua_node/lib/node_modules');
  const payload = write(join(app, 'resources/shared/dependency.js'), 'export {};\n');
  symlinkSync(join(app, 'resources/shared'), join(modules, 'linked'));
  const helper = write(join(app, 'resources/helper.mjs'), 'export {};\n');
  symlinkSync(helper, join(modules, 'helper.mjs'));
  symlinkSync(modules, join(modules, 'loop'));
  symlinkSync(join(modules, 'loop'), join(modules, 'again'));
  resolveInstalledLinuxApp(app, { arch: 'arm64' });
  chmodSync(payload, 0o666);
  assert.throws(() => resolveInstalledLinuxApp(app, { arch: 'arm64' }), /dependency\.js is writable by group or other/);
  chmodSync(payload, 0o644);
  chmodSync(helper, 0o666);
  assert.throws(() => resolveInstalledLinuxApp(app, { arch: 'arm64' }), /helper\.mjs is writable by group or other/);
  chmodSync(helper, 0o644);
  mkdirSync(join(base, 'outside'));
  symlinkSync(join(base, 'outside'), join(app, 'resources/plugins/openai-bundled/plugins/chrome/escape'));
  assert.throws(() => resolveInstalledLinuxApp(app, { arch: 'arm64' }), /escape links outside the application/);
  unlinkSync(join(app, 'resources/plugins/openai-bundled/plugins/chrome/escape'));
  const outside = linuxApp(join(base, 'elsewhere'));
  rmSync(join(app, 'resources/cua_node/bin'), { recursive: true });
  symlinkSync(join(outside, 'resources/cua_node/bin'), join(app, 'resources/cua_node/bin'));
  assert.throws(() => resolveInstalledLinuxApp(app, { arch: 'arm64' }), /outside the application/);
});

test('executed plugin trees are covered', (t) => {
  const app = linuxApp(join(temporary(t), 'chatgpt'));
  const script = write(join(app, 'resources/plugins/openai-bundled/plugins/browser/scripts/run.mjs'), 'export {};\n', 0o666);
  assert.throws(() => resolveInstalledLinuxApp(app, { arch: 'arm64' }), /writable by group or other/);
  chmodSync(script, 0o644);
  const diagnostic = write(join(app, 'resources/plugins/openai-bundled/plugins/chrome/scripts/diagnostics/status.mjs'), '', 0o646);
  assert.throws(() => resolveInstalledLinuxApp(app, { arch: 'arm64' }), /writable by group or other/);
  chmodSync(diagnostic, 0o644);
  resolveInstalledLinuxApp(app, { arch: 'arm64' });
});

test('group write needs every group member trusted, and then the ACL decides', (t) => {
  const app = linuxApp(join(temporary(t), 'chatgpt'));
  const node = join(app, 'resources/cua_node/bin/node');
  chmodSync(node, 0o775);
  const stranger = process.getuid() + 1000;
  const calls = [];
  let members = () => new Set([stranger]);
  let acls = (paths) => new Map(paths.map((path) => [path, []]));
  const resolve = () => resolveInstalledLinuxApp(app, { arch: 'arm64',
    accounts: { groupMembers: (gid) => members(gid), readAcls: (paths) => { calls.push(paths); return acls(paths); } } });
  assert.throws(resolve, /writable by group or other/);
  members = () => null;
  assert.throws(resolve, /writable by group or other/);
  members = () => new Set([0, process.getuid()]);
  resolve();
  assert.deepEqual(calls, [[node]], 'one ACL read, only for the group-writable entry');
  acls = () => new Map([[node, [{ tag: 'user', id: stranger, perm: 'rw-' }, { tag: 'mask', id: null, perm: 'rwx' }]]]);
  assert.throws(resolve, new RegExp(`node is writable by uid ${stranger} through a POSIX ACL`));
  acls = () => new Map([[node, null]]);
  assert.throws(resolve, /POSIX ACL cannot be read/);
});

test('group zero is not trusted by its number alone, and named ACL entries count only through the mask', () => {
  const info = { uid: 0, gid: 0, mode: 0o100664, isSymbolicLink: () => false, isDirectory: () => false };
  assert.ok(untrustedEntry(info, new Set([0]), () => new Set([0, 1234])));
  assert.equal(untrustedEntry(info, new Set([0]), () => new Set([0])), 'acl');
  assert.equal(untrustedEntry({ ...info, mode: 0o100644 }, new Set([0]), () => null), null);
  const none = () => new Set();
  const mask = (perm) => ({ tag: 'mask', id: null, perm });
  assert.match(aclWritersUntrusted([{ tag: 'user', id: 4242, perm: 'rw-' }, mask('rwx')], new Set([0]), none), /uid 4242 through a POSIX ACL/);
  assert.equal(aclWritersUntrusted([{ tag: 'user', id: 4242, perm: 'rw-' }, mask('r-x')], new Set([0]), none), null);
  assert.equal(aclWritersUntrusted([{ tag: 'user', id: 4242, perm: 'r--' }, mask('rwx')], new Set([0]), none), null);
  assert.equal(aclWritersUntrusted([{ tag: 'user', id: 4242, perm: 'rw-' }, mask('rwx')], new Set([0, 4242]), none), null);
  assert.match(aclWritersUntrusted([{ tag: 'group', id: 50, perm: 'rw-' }, mask('rwx')], new Set([0]), () => new Set([4242])), /group 50/);
});

test('getfacl output is read per file, with escaped names', (t) => {
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    assert.equal(command, 'getfacl');
    assert.ok(args.includes('--skip-base'));
    return { status: 0, stdout: '# file: /a\\040b\n# owner: 0\n# group: 0\nuser::rwx\nuser:4242:rw-\ngroup::r-x\nmask::rwx\nother::r-x\n\n' };
  });
  assert.deepEqual(readAcls(['/a b', '/plain']), new Map([['/a b',
    [{ tag: 'user', id: null, perm: 'rwx' }, { tag: 'user', id: 4242, perm: 'rw-' }, { tag: 'group', id: null, perm: 'r-x' }, { tag: 'mask', id: null, perm: 'rwx' }]],
  ['/plain', []]]));
});

test('without getfacl, ls -ld tells an entry with an ACL (refused) from one without (safe)', (t) => {
  const listed = [];
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    if (command === 'getfacl') return { status: null, error: Object.assign(new Error('spawn getfacl ENOENT'), { code: 'ENOENT' }) };
    listed.push(args.at(-1));
    const mode = { '/acl': 'drwxrwxr-x+', '/plain': 'drwxrwxr-x', '/selinux': 'drwxrwxr-x.' }[args.at(-1)];
    return mode ? { status: 0, stdout: `${mode} 2 root root 4096 Oct  8 12:00 ${args.at(-1)}\n` } : { status: 2, stdout: '' };
  });
  assert.deepEqual(readAcls(['/acl', '/plain', '/selinux', '/gone']), new Map([['/acl', null], ['/plain', []], ['/selinux', []], ['/gone', null]]));
  assert.deepEqual(listed, ['/acl', '/plain', '/selinux', '/gone']);
  t.mock.method(childProcess, 'spawnSync', () => ({ status: 1, stdout: '' }));
  assert.deepEqual(readAcls(['/x']), new Map([['/x', null]]), 'a getfacl that fails is no answer');
});
