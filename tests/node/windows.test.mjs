import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { host as doctorHost } from '../../lcu/doctor.mjs';
import { environment, main, paths } from '../../lcu/runtime.mjs';
import {
  PACKAGE_NAME, PACKAGE_PUBLISHER, WINDOWS_REQUIRED_FILES, applicationInventory, applicationStamps, canonicalJson, inventoryRecord,
  inventorySha256, registeredPackage, resolveInstalledWindowsApp, validateWindowsAppTree,
} from '../../lcu/windows.mjs';
import { mockWrite, output, override, posixOnly, temporary, write } from './fixtures.mjs';

// The real host platform; the Windows fixtures simulate win32 on every host.
const HOST = process.platform;
const VERSION = '26.917.9434.0';
const RUNTIME = '0.0.16/20260915001755-492f19756c31';
const identity = (version) => `<?xml version="1.0"?><!-- <Identity Name="decoy"/> --><Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">` +
  `<Identity Name="${PACKAGE_NAME}" Publisher="${PACKAGE_PUBLISHER}" Version="${version}" ProcessorArchitecture="x64"/></Package>`;

function storeApp(t) {
  const app = join(temporary(t), `OpenAI.Codex_${VERSION}_x64`);
  write(join(app, 'AppxManifest.xml'), identity(VERSION));
  for (const relative of WINDOWS_REQUIRED_FILES) {
    write(join(app, relative), relative.endsWith('cua_node/manifest.json')
      ? JSON.stringify({ platform: 'windows', arch: 'x64', runtime_archive_version: RUNTIME }) : relative);
  }
  const registered = { Name: PACKAGE_NAME, Publisher: PACKAGE_PUBLISHER, Version: VERSION, Architecture: 'X64', SignatureKind: 'Store', InstallLocation: app };
  return { app, registered };
}

function onWindows(t, registered) {
  override(t, process, 'platform', 'win32');
  override(t, process, 'arch', 'x64');
  return t.mock.method(childProcess, 'spawnSync', (command, args) => {
    assert.equal(command, 'powershell.exe');
    assert.match(args.at(-1), /Get-AppxPackage/);
    return { status: 0, stdout: JSON.stringify(registered), stderr: '' };
  });
}

test('the registered official package is selected in place, with its tree inventory', (t) => {
  const { app, registered } = storeApp(t);
  const query = onWindows(t, registered);
  const selected = resolveInstalledWindowsApp();
  assert.equal(query.mock.callCount(), 1);
  assert.deepEqual([selected.app, selected.resources, selected.runtime, selected.launcher],
    [app, join(app, 'app/resources'), join(app, 'app/resources/cua_node'), join(app, WINDOWS_REQUIRED_FILES[5])]);
  assert.deepEqual([selected.backend, selected.version, selected.arch, selected.runtimeVersion], ['windows', VERSION, 'x64', RUNTIME]);
  assert.equal(selected.inventoryDigest, inventorySha256(selected.inventory));
});

test('the inventory digest matches the one earlier releases recorded (sorted, compact, ASCII-escaped JSON)', () => {
  const inventory = { 'b\u00e9': { type: 'file', sha256: 'x' }, '.': { type: 'directory' } };
  assert.equal(canonicalJson(inventory), '{".":{"type":"directory"},"b\\u00e9":{"sha256":"x","type":"file"}}');
  // The digest Python's json.dumps(sort_keys=True, separators=(',', ':')) gave for the same inventory.
  assert.equal(inventorySha256(inventory), 'dcceeac341d6392bccdefdc08269f4d7cd019483335c24a1984b3cb500f5a6ef');
});

test('a private copy is validated without querying registration, and must equal the source inventory', (t) => {
  const { app } = storeApp(t);
  const query = onWindows(t, {});
  const privateCopy = join(app, '../managed/app');
  cpSync(app, privateCopy, { recursive: true });
  const options = { expectedVersion: VERSION, expectedRuntime: RUNTIME, expectedInventory: applicationInventory(app) };
  assert.equal(validateWindowsAppTree(privateCopy, options).app, privateCopy);
  assert.equal(query.mock.callCount(), 0);
  writeFileSync(join(privateCopy, WINDOWS_REQUIRED_FILES[2]), 'changed');
  assert.throws(() => validateWindowsAppTree(privateCopy, options), new RegExp(`differs from selected source inventory: ${WINDOWS_REQUIRED_FILES[2]}`));
  assert.throws(() => validateWindowsAppTree(app, { ...options, expectedRuntime: 'wrong' }), /runtime changed after selection/);
});

test('a registration that is not the official x64 Store package is refused before use', (t) => {
  const { registered } = storeApp(t);
  const query = onWindows(t, registered);
  for (const [changes, pattern] of [[{ Publisher: 'CN=other' }, /official Windows x64 Store app/],
    [{ Version: '27.100.1.0' }, /version does not match its identity manifest/], [{ Architecture: 'ARM64' }, /official Windows x64 Store app/],
    [{ SignatureKind: 'Developer' }, /official Windows x64 Store app/]]) {
    query.mock.mockImplementation(() => ({ status: 0, stdout: JSON.stringify({ ...registered, ...changes }) }));
    assert.throws(() => resolveInstalledWindowsApp(), pattern);
  }
});

test('a new official version is accepted', (t) => {
  const { app, registered } = storeApp(t);
  writeFileSync(join(app, 'AppxManifest.xml'), identity('27.100.1.0'));
  onWindows(t, { ...registered, Version: '27.100.1.0' });
  assert.equal(resolveInstalledWindowsApp().version, '27.100.1.0');
});

test('the query projects typed PowerShell properties to strings', (t) => {
  const { registered } = storeApp(t);
  const query = onWindows(t, registered);
  assert.deepEqual(registeredPackage(), registered);
  const command = query.mock.calls[0].arguments[1].at(-1);
  for (const part of ['$_.Version.ToString()', '$_.Architecture.ToString()', '$_.SignatureKind.ToString()']) assert.ok(command.includes(part));
  for (const changes of [{ Version: { Major: 26 } }, { Architecture: 9 }, { SignatureKind: 0 }]) {
    query.mock.mockImplementation(() => ({ status: 0, stdout: JSON.stringify({ ...registered, ...changes }) }));
    assert.throws(() => registeredPackage(), /string version, architecture and signature kind/);
  }
});

test('an MSIX-encoded scoped module segment is accepted; a redirected file is refused; only Windows x64 validates', (t) => {
  const { app, registered } = storeApp(t);
  // Any host but Windows x64 is refused before the package query (simulated, so this holds on every test host).
  const query = onWindows(t, registered);
  for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'arm64'], ['win32', 'arm64']]) {
    override(t, process, 'platform', platform);
    override(t, process, 'arch', arch);
    assert.throws(() => resolveInstalledWindowsApp(), /only be validated on Windows x64/);
  }
  assert.equal(query.mock.callCount(), 0);
  override(t, process, 'platform', 'win32');
  override(t, process, 'arch', 'x64');
  const original = join(app, WINDOWS_REQUIRED_FILES[5]);
  const encoded = join(app, WINDOWS_REQUIRED_FILES[5].replace('@oai/', '%40oai/'));
  mkdirSync(join(encoded, '..'), { recursive: true });
  renameSync(original, encoded);
  assert.equal(resolveInstalledWindowsApp().launcher, encoded);
  const runtime = join(app, 'app/resources/cua_node');
  renameSync(runtime, join(app, '../external-cua-node'));
  symlinkSync(join(app, '../external-cua-node'), runtime);
  assert.throws(() => resolveInstalledWindowsApp(), /redirected path|missing or outside the app/);
});

// ---- launching the managed private copy --------------------------------------------------------------

function windowsRelease(t) {
  const base = temporary(t);
  const prefix = join(base, 'prefix');
  const root = join(prefix, 'releases/release');
  const { app: source } = storeApp(t);
  // The original server and host stand in as scripts on this POSIX test host.
  const runtime = 'app/resources/cua_node';
  write(join(source, runtime, 'bin/node.exe'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, 0o755);
  write(join(source, runtime, 'bin/node_modules/@oai/cua-repl/bin/cua-repl.mjs'),
    "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.LCU_TEST_OUT, JSON.stringify({ argv: process.argv, env: process.env }));\n" +
    "if (process.env.LCU_TEST_SIGNAL) process.kill(process.pid, process.env.LCU_TEST_SIGNAL);\n" +
    'process.exitCode = Number(process.env.LCU_TEST_STATUS ?? 0);\n');
  const inventory = applicationInventory(source);
  const digest = inventorySha256(inventory);
  const generation = join(prefix, 'apps', digest);
  mkdirSync(generation, { recursive: true });
  const app = join(generation, 'app');
  renameSync(source, app);
  write(join(generation, 'inventory.json'), JSON.stringify(inventory));
  write(join(root, 'runtime.lock.json'), JSON.stringify({ platforms: { windows: { version: VERSION, runtime: RUNTIME, architectures: { x64: { sha256: '0'.repeat(64) } } } } }));
  write(join(root, 'installation.json'), JSON.stringify({ platform: 'windows', app, architecture: 'x64', package_version: VERSION, runtime: RUNTIME, sha256: digest }));
  write(join(root, 'lcu-host/windows-pipe-host.cjs'), `const fs = require('node:fs');
    // The fault hook: the original server's Node cannot start once the host is up.
    if (process.env.LCU_TEST_BREAK) fs.chmodSync(process.env.NODE_REPL_NODE_PATH, 0o644);
    process.stdout.write(JSON.stringify({ ready: true,
    pipePath: '\\\\\\\\.\\\\pipe\\\\lcu-wre-fixture', lifetimePath: '\\\\\\\\.\\\\pipe\\\\lcu-lifetime-fixture' }) + '\\n');
    fs.writeFileSync(process.env.LCU_TEST_OUT + '.host', JSON.stringify({ helper: process.env.LCU_WRE_HELPER_PATH, transport: process.env.LCU_WRE_TRANSPORT_PATH }));
    process.stdin.resume(); process.stdin.on('end', () => { fs.writeFileSync(process.env.LCU_TEST_OUT + '.stopped', ''); process.exit(0); });\n`);
  override(t, process, 'platform', 'win32');
  override(t, process, 'arch', 'x64');
  return { base, prefix, root, app, runtime: join(app, runtime), resources: join(app, 'app/resources'), digest, out: join(base, 'child.json') };
}

test('the managed app supplies the original Windows paths and environment', { skip: posixOnly('the managed-copy fixture stands in sh scripts for node.exe') }, (t) => {
  const r = windowsRelease(t);
  const selected = paths(r.root);
  assert.deepEqual([selected.app, selected.resources, selected.runtime], [r.app, r.resources, r.runtime]);
  const env = environment(r.root, selected, { env: { USERPROFILE: 'C:\\fixture', Path: 'C:\\Windows' } });
  assert.equal(env.CODEX_HOME, 'C:\\fixture\\.codex');
  assert.equal(env.NODE_REPL_NODE_PATH, join(r.runtime, 'bin/node.exe'));
  assert.equal(env.CUA_REPL_NODE_REPL_PATH, join(r.runtime, 'bin/node_repl.exe'));
  assert.equal(env.CODEX_CLI_PATH, join(r.resources, 'codex.exe'));
  assert.equal(env.NODE_REPL_NODE_MODULE_DIRS, join(r.runtime, 'bin/node_modules'));
  assert.equal(env.PATH, `${join(r.runtime, 'bin')};C:\\Windows`);
  assert.ok(!('Path' in env));
  assert.equal(env.BROWSER_USE_CODEX_APP_VERSION, VERSION);
});

async function launchWindows(t, r, argv, settings = {}) {
  override(t, process, 'env', { PATH: process.env.PATH, USERPROFILE: 'C:\\fixture', LCU_TEST_OUT: r.out, ...settings });
  const status = await main(r.root, argv);
  return { status, child: JSON.parse(readFileSync(r.out, 'utf8')), host: JSON.parse(readFileSync(`${r.out}.host`, 'utf8')) };
}

test('the original launcher runs with the original pipe host around it', { skip: posixOnly('the managed-copy fixture stands in sh scripts for node.exe') }, async (t) => {
  const r = windowsRelease(t);
  const { status, child, host } = await launchWindows(t, r, []);
  assert.equal(status, 0);
  assert.equal(child.argv[1], join(r.runtime, 'bin/node_modules/@oai/cua-repl/bin/cua-repl.mjs'));
  assert.equal(child.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  assert.equal(child.env.SKY_CUA_NATIVE_PIPE, '1');
  assert.equal(child.env.SKY_CUA_NATIVE_PIPE_DIRECTORY, '\\\\.\\pipe\\lcu-wre-fixture');
  assert.equal(child.env.LCU_WRE_LIFETIME_PIPE, '\\\\.\\pipe\\lcu-lifetime-fixture');
  assert.equal(JSON.parse(child.env.NODE_REPL_TRUSTED_SERVICES).sky, join(r.root, 'lcu-host/windows-sky-service.mjs'));
  assert.equal(host.helper, join(r.runtime, 'bin/node_modules/@oai/sky/bin/windows/codex-computer-use.exe'));
  assert.equal(child.env.LCU_WRE_SKY_SERVICE_PATH, join(r.runtime, 'bin/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js'));
});

test('other trusted services are kept, the browser one with --chrome; a custom Sky service or a bad map is refused', { skip: posixOnly('the managed-copy fixture stands in sh scripts for node.exe') }, async (t) => {
  const r = windowsRelease(t);
  assert.equal(JSON.parse((await launchWindows(t, r, [], { NODE_REPL_TRUSTED_SERVICES: '{"browser":"fixture"}' })).child.env.NODE_REPL_TRUSTED_SERVICES).browser, 'fixture');
  const chrome = JSON.parse((await launchWindows(t, r, ['--chrome'])).child.env.NODE_REPL_TRUSTED_SERVICES);
  assert.deepEqual(chrome, { browser: '@oai/browser-desktop/service', sky: join(r.root, 'lcu-host/windows-sky-service.mjs') });
  const custom = JSON.parse((await launchWindows(t, r, ['--chrome'], { NODE_REPL_TRUSTED_SERVICES: '{"fixture":"service"}' })).child.env.NODE_REPL_TRUSTED_SERVICES);
  assert.ok(!('browser' in custom) && custom.fixture === 'service');
  unlinkSync(r.out);
  for (const [services, pattern] of [['{"sky":"custom"}', /conflicts/], ['null', /JSON string map/]]) {
    override(t, process, 'env', { PATH: process.env.PATH, USERPROFILE: 'C:\\fixture', LCU_TEST_OUT: r.out, NODE_REPL_TRUSTED_SERVICES: services });
    await assert.rejects(main(r.root, []), pattern);
  }
  assert.throws(() => readFileSync(r.out), /ENOENT/, 'the original server never started');
});

test('the descriptor must name the managed generation and its intact inventory', { skip: posixOnly('the managed-copy fixture stands in sh scripts for node.exe') }, (t) => {
  const r = windowsRelease(t);
  const descriptorPath = join(r.root, 'installation.json');
  const descriptor = JSON.parse(readFileSync(descriptorPath));
  writeFileSync(descriptorPath, JSON.stringify({ ...descriptor, app: join(r.root, 'other') }));
  assert.throws(() => paths(r.root), /not the managed private generation/);
  for (const [key, value] of [['package_version', ''], ['runtime', ''], ['sha256', 'not-a-64-hex-digest']]) {
    writeFileSync(descriptorPath, JSON.stringify({ ...descriptor, [key]: value }));
    assert.throws(() => paths(r.root), /incomplete or unsupported/);
  }
  writeFileSync(descriptorPath, JSON.stringify(descriptor));
  const inventoryPath = join(r.app, '../inventory.json');
  unlinkSync(inventoryPath);
  assert.throws(() => paths(r.root), /not the managed private generation/);
  writeFileSync(inventoryPath, JSON.stringify({ '.': { type: 'directory' } }));
  assert.throws(() => paths(r.root), /inventory does not match its descriptor/);
});

test('the original server’s exit status reaches the caller; a signal gives 128 + its number', { skip: posixOnly('the managed-copy fixture stands in sh scripts for node.exe') }, async (t) => {
  const r = windowsRelease(t);
  assert.equal((await launchWindows(t, r, [], { LCU_TEST_STATUS: '7' })).status, 7);
  assert.equal((await launchWindows(t, r, [], { LCU_TEST_SIGNAL: 'SIGTERM' })).status, 128 + 15);
});

test('the owned host is disposed of when the original server cannot start', { skip: posixOnly('the managed-copy fixture stands in sh scripts for node.exe') }, async (t) => {
  const r = windowsRelease(t);
  override(t, process, 'env', { PATH: process.env.PATH, USERPROFILE: 'C:\\fixture', LCU_TEST_OUT: r.out, LCU_TEST_BREAK: '1' });
  await assert.rejects(main(r.root, []), { code: 'EACCES' });
  assert.ok(existsSync(`${r.out}.stopped`), 'the host saw its stdin close and exited');
});

// ---- reusing a recorded inventory match at launch ------------------------------------------------------

/** Count the files hashed while `fn` runs (the expected inventory's own digest is one more hash). */
function filesHashed(t) {
  const hash = t.mock.method(crypto, 'createHash');
  return (fn) => {
    hash.mock.resetCalls();
    fn();
    return hash.mock.callCount() - 1;
  };
}

/** A private copy of a Store app, its record in a scratch directory, and validation helpers. */
function recordedCopy(t) {
  const { app: source } = storeApp(t);
  onWindows(t, {});
  const app = join(source, '../managed/app');
  cpSync(source, app, { recursive: true });
  const inventory = applicationInventory(app);
  const record = join(temporary(t), 'cache/windows-inventory.json');
  override(t, inventoryRecord, 'path', () => record);
  const hashed = filesHashed(t);
  const files = Object.values(inventory).filter(({ type }) => type === 'file').length;
  const options = { expectedVersion: VERSION, expectedRuntime: RUNTIME, expectedInventory: inventory };
  /** Validate the copy and return the number of files hashed. */
  const validate = (settings = {}) => hashed(() => validateWindowsAppTree(app, { ...options, ...settings }));
  const launch = () => validate({ reuseRecordedInventory: true });
  const entry = () => JSON.parse(readFileSync(record, 'utf8'))[app];
  return { app, record, files, options, validate, launch, entry, inventory };
}

test('a launch reuses a recorded inventory match of the same stamps, inventory, version and runtime', (t) => {
  const { app, record, files, launch, entry, inventory } = recordedCopy(t);
  assert.equal(launch(), files, 'the first launch hashes every file');
  const recorded = entry();
  assert.deepEqual([recorded.version, recorded.runtime, recorded.inventory], [VERSION, RUNTIME, inventorySha256(inventory)]);
  assert.deepEqual(recorded.stamps, applicationStamps(app));
  assert.deepEqual(recorded.stamps.map(([path, type]) => [path, type]),
    Object.entries(inventory).map(([path, { type }]) => [path, type]),
    'one stamp for each inventory entry');
  for (const [, , ...values] of recorded.stamps) for (const value of values) assert.match(value, /^\d+$/);
  if (HOST !== 'win32') assert.equal(statSync(record).mode & 0o777, 0o600);
  assert.equal(launch(), 0, 'a later launch hashes nothing');
  assert.equal(launch(), 0);
});

test('setup, update, doctor and status validate in full and refresh the record; the registered source is never recorded', (t) => {
  const { record, files, validate, launch } = recordedCopy(t);
  assert.equal(validate(), files);
  assert.ok(existsSync(record), 'a full validation records the copy for the next launch');
  assert.equal(validate(), files, 'a recorded copy is validated in full again');
  assert.equal(launch(), 0);
  rmSync(record);
  assert.equal(validate({ reuseRecordedInventory: true, recordInventory: false }), files);
  assert.ok(!existsSync(record));
  const { registered } = storeApp(t);
  onWindows(t, registered);
  resolveInstalledWindowsApp();
  assert.ok(!existsSync(record), 'the Store package itself is never recorded');
});

test('a changed modification time, file identity or size, or an added or removed file, validates in full', (t) => {
  const { app, launch, entry } = recordedCopy(t);
  const file = join(app, WINDOWS_REQUIRED_FILES[2]);
  launch();
  assert.equal(launch(), 0);
  utimesSync(file, new Date(0), new Date(1_000));
  assert.ok(launch() > 0, 'modification time');
  assert.equal(launch(), 0, 'rewritten after the match');
  const content = readFileSync(file);
  const moved = `${file}.moved`;
  renameSync(file, moved);
  writeFileSync(file, content);
  unlinkSync(moved);
  utimesSync(file, new Date(0), new Date(1_000));
  assert.ok(launch() > 0, 'identity (the same content and time in another file)');
  assert.equal(launch(), 0);
  writeFileSync(file, `${content}longer`);
  utimesSync(file, new Date(0), new Date(1_000));
  assert.throws(launch, /differs from selected source inventory/, 'size');
  writeFileSync(file, content);
  assert.ok(launch() > 0);
  const added = join(app, 'app/added.txt');
  write(added, 'added');
  assert.throws(launch, /differs from selected source inventory: app\/added\.txt/, 'added file');
  unlinkSync(added);
  assert.ok(launch() > 0);
  const before = entry();
  unlinkSync(file);
  assert.throws(launch, /missing or outside the app/, 'removed file');
  assert.deepEqual(entry(), before, 'a failed validation leaves the record as it was');
});

test('a removed file that is not required validates in full and fails', (t) => {
  const { app, inventory, options, launch, record } = recordedCopy(t);
  const extra = join(app, 'app/extra.txt');
  write(extra, 'extra');
  const expectedInventory = { ...inventory, 'app/extra.txt': applicationInventory(app)['app/extra.txt'] };
  const reuse = () => validateWindowsAppTree(app, { ...options, expectedInventory, reuseRecordedInventory: true });
  reuse();
  assert.ok(existsSync(record));
  reuse();
  unlinkSync(extra);
  assert.throws(reuse, /differs from selected source inventory: app\/extra\.txt/);
  assert.ok(launch() > 0, 'another expected inventory: in full, and it matches');
});

test('a failed validation is never recorded and fails as before', (t) => {
  const { app, record, options, launch } = recordedCopy(t);
  writeFileSync(join(app, WINDOWS_REQUIRED_FILES[2]), 'changed');
  assert.throws(launch, new RegExp(`differs from selected source inventory: ${WINDOWS_REQUIRED_FILES[2]}`));
  assert.ok(!existsSync(record));
  assert.throws(() => validateWindowsAppTree(app, { ...options, expectedRuntime: 'wrong', reuseRecordedInventory: true }),
    /runtime changed after selection/);
  assert.ok(!existsSync(record));
});

test('an edit that changes no stamp is not noticed at launch, but by a full validation', (t) => {
  const { app, validate, launch } = recordedCopy(t);
  const file = join(app, WINDOWS_REQUIRED_FILES[2]);
  utimesSync(file, new Date(0), new Date(1_000));
  launch();
  writeFileSync(file, 'X'.repeat(readFileSync(file).length));
  utimesSync(file, new Date(0), new Date(1_000));
  assert.equal(launch(), 0, 'the accepted trade-off');
  assert.throws(validate, /differs from selected source inventory/);
});

test('another version, runtime or inventory in the record, or a corrupt or unusable record, validates in full', (t) => {
  const { app, record, files, launch, entry } = recordedCopy(t);
  launch();
  const good = entry();
  for (const changes of [{ version: '1.0.0.0' }, { runtime: 'other' }, { inventory: '0'.repeat(64) }, { stamps: good.stamps.slice(1) }]) {
    writeFileSync(record, JSON.stringify({ [app]: { ...good, ...changes } }));
    assert.equal(launch(), files, Object.keys(changes)[0]);
    assert.equal(launch(), 0, 'rewritten');
  }
  for (const corrupt of ['{not json', '[]', 'null', JSON.stringify({ [app]: null })]) {
    writeFileSync(record, corrupt);
    assert.equal(launch(), files, corrupt);
    assert.equal(launch(), 0, `rewritten after ${corrupt}`);
  }
  override(t, inventoryRecord, 'path', () => { throw new Error('no home'); });
  assert.equal(launch(), files);
  assert.equal(launch(), files, 'nothing to reuse without a record');
});

test('entries of generations that are gone are dropped when the record is written', (t) => {
  const { app, record, launch } = recordedCopy(t);
  write(record, JSON.stringify({ [join(app, '../../gone/app')]: { version: VERSION } }));
  launch();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(record, 'utf8'))), [app]);
});

test('a link in a recorded copy is refused at every launch', { skip: posixOnly('creates a symbolic link') }, (t) => {
  const { app, launch } = recordedCopy(t);
  launch();
  symlinkSync(join(app, 'app/resources/codex.exe'), join(app, 'app/linked.exe'));
  assert.throws(launch, /contains a redirected path/);
});

test('concurrent launches wait for the one validating and reuse its record, or validate themselves after a bounded wait', (t) => {
  const { app, record, files, launch } = recordedCopy(t);
  launch();
  const finished = readFileSync(record, 'utf8');
  rmSync(record);
  // Another process holds the lock and records its validation while this one polls.
  let polls = 0;
  override(t, inventoryRecord, 'lock', () => {
    polls += 1;
    if (polls === 3) writeFileSync(record, finished);
    return null;
  });
  assert.equal(launch(), 0);
  assert.equal(polls, 3);
  // A file that changes after this launch first looked, while it waits: the record found after the wait is
  // compared with the tree as it is then, so the launch validates in full once the holder is done.
  override(t, inventoryRecord, 'wait', 5_000);
  rmSync(record);
  polls = 0;
  override(t, inventoryRecord, 'lock', () => {
    polls += 1;
    if (polls === 3) {
      writeFileSync(record, finished);
      utimesSync(join(app, WINDOWS_REQUIRED_FILES[2]), new Date(0), new Date(2_000));
    }
    return polls < 5 ? null : () => {};
  });
  assert.equal(launch(), files);
  assert.equal(polls, 5);
  assert.equal(launch(), 0, 'and records the tree as it is now');
  // A holder that never finishes: the copy is validated after the wait, then recorded.
  rmSync(record);
  override(t, inventoryRecord, 'lock', () => null);
  override(t, inventoryRecord, 'wait', 120);
  const started = Date.now();
  assert.equal(launch(), files);
  assert.ok(Date.now() - started >= 120);
  assert.ok(existsSync(record));
  // A lock that cannot be opened does not hold the launch up.
  override(t, inventoryRecord, 'lock', () => { throw new Error('EACCES'); });
  rmSync(record);
  assert.equal(launch(), files);
  assert.ok(existsSync(record));
});

test('the lock beside the record is released after each validation, also a failed one', (t) => {
  const { app, record, launch } = recordedCopy(t);
  launch();
  assert.ok(!existsSync(`${record}.lock`), 'the default Windows lock file is removed when released');
  rmSync(record);
  const released = [];
  override(t, inventoryRecord, 'lock', (path) => {
    assert.equal(path, `${record}.lock`);
    return () => released.push(path);
  });
  launch();
  rmSync(record);
  writeFileSync(join(app, WINDOWS_REQUIRED_FILES[2]), 'changed');
  assert.throws(launch, /differs/);
  assert.equal(released.length, 2);
});

test('an MCP launch reuses the record; --version, status and doctor validate in full', { skip: posixOnly('the managed-copy fixture stands in sh scripts for node.exe') }, async (t) => {
  const r = windowsRelease(t);
  const record = join(r.base, 'cache/windows-inventory.json');
  override(t, inventoryRecord, 'path', () => record);
  const hash = t.mock.method(crypto, 'createHash');
  const run = async (fn) => {
    hash.mock.resetCalls();
    await fn();
    return hash.mock.callCount();
  };
  const files = Object.values(applicationInventory(r.app)).filter(({ type }) => type === 'file').length;
  // Besides the files, a launch hashes the expected inventory (its digest is checked against the descriptor).
  const full = await run(() => launchWindows(t, r, []));
  const reused = await run(() => launchWindows(t, r, []));
  assert.equal(full - reused, files, 'the first launch validates in full, a later one hashes no file');
  mockWrite(t, process.stdout, () => true);
  assert.equal(await run(() => main(r.root, ['--version'])), full, 'lcu --version (run by lcu setup)');
  assert.equal(await run(() => paths(r.root)), full, 'status, browser, the installer and doctor without a resolved app');
  override(t, doctorHost, 'probe', () => { throw new Error('fixture stops here'); });
  override(t, doctorHost, 'interactive', () => false);
  await output(t);
  assert.equal(await run(() => main(r.root, ['doctor', '--non-interactive']).catch(() => {})), full, 'lcu doctor');
});
