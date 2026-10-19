import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { acquire, installLockPath } from '../../lcu/lock.mjs';
import { WINDOWS_REQUIRED_FILES, applicationInventory, canonicalJson, inventorySha256 } from '../../lcu/windows.mjs';
import { checkedPrefix, deps, generationInUse, install, launcherCommand, main, preflightHost } from '../../scripts/install_windows.mjs';
import { override, temporary, write, mockWrite } from './fixtures.mjs';

const NODE_MEMBER = 'app/resources/cua_node/bin/node.exe';

/** An archive, a Store app and stubs for everything that needs Windows; `calls` records the order. */
function fixture(t) {
  const base = temporary(t);
  const source = join(base, 'archive');
  write(join(source, 'scripts/windows_launcher.mjs'), 'launcher');
  write(join(source, 'runtime.lock.json'), JSON.stringify({ platforms: { windows: { architectures: { x64: {} } } } }));
  const official = join(base, 'official-app');
  for (const relative of WINDOWS_REQUIRED_FILES) write(join(official, relative), relative === NODE_MEMBER ? 'node fixture' : relative);
  write(join(official, 'app/resources/NOTICE.txt'), 'original notice');
  const inventory = applicationInventory(official);
  const selected = { app: official, version: '26.930.7945.0', runtimeVersion: 'runtime-fixture', inventory,
    inventoryDigest: inventorySha256(inventory) };
  const calls = [];
  const stubs = {
    source, platform: () => 'win32', architecture: () => 'x64', verify: () => {},
    resolveInstalledWindowsApp: () => selected,
    validateWindowsAppTree: (app, { expectedInventory }) => {
      if (canonicalJson(applicationInventory(app)) !== canonicalJson(expectedInventory)) {
        throw new Error('Windows application differs from selected source inventory');
      }
    },
    planOriginalHost: () => calls.push('preflight'),
    materializeOriginalHost: () => calls.push('host'),
    paths: async () => calls.push('paths'),
  };
  for (const [name, value] of Object.entries(stubs)) override(t, deps, name, value);
  mockWrite(t, process.stderr, () => true);
  return { base, source, official, selected, calls, prefix: join(base, 'installed') };
}

const generations = (prefix) => readdirSync(join(prefix, 'apps'));
const current = (prefix) => JSON.parse(readFileSync(join(prefix, 'current.json'), 'utf8'));

test('a missing registered app or host layout fails before any copy or prefix write', async (t) => {
  const f = fixture(t);
  override(t, deps, 'resolveInstalledWindowsApp', () => { throw new Error('Install the official ChatGPT MSIX for this Windows account first.'); });
  await assert.rejects(install(f.prefix), /chatgpt\.com\/download\/.*signed-in account/);
  override(t, deps, 'resolveInstalledWindowsApp', () => f.selected);
  override(t, deps, 'planOriginalHost', () => { throw new Error('Required Windows host layout is unavailable: example'); });
  await assert.rejects(install(f.prefix), /unavailable: example \(observed ChatGPT app 26\.930\.7945\.0, runtime runtime-fixture/);
  assert.equal(existsSync(f.prefix), false);
});

test('an install copies the app once, records its inventory, Node and launcher, and switches current', async (t) => {
  const f = fixture(t);
  const release = await install(f.prefix);
  assert.deepEqual(f.calls, ['preflight', 'host', 'paths']);
  const installed = JSON.parse(readFileSync(join(release, 'installation.json'), 'utf8'));
  const generation = join(f.prefix, 'apps', f.selected.inventoryDigest);
  assert.deepEqual(installed, { platform: 'windows', architecture: 'x64', app: join(generation, 'app'),
    package_version: '26.930.7945.0', runtime: 'runtime-fixture', sha256: f.selected.inventoryDigest });
  assert.deepEqual(JSON.parse(readFileSync(join(generation, 'inventory.json'), 'utf8')), f.selected.inventory);
  assert.equal(readFileSync(join(generation, 'app/app/resources/NOTICE.txt'), 'utf8'), 'original notice');
  const node = join(generation, 'app', NODE_MEMBER);
  assert.equal(readFileSync(join(release, 'node-path'), 'utf8').trim(), node);
  const command = readFileSync(join(f.prefix, 'lcu.cmd'), 'utf8');
  assert.equal(command, launcherCommand(node));
  assert.ok(command.includes(`:run\r\n"${node}" "%~dp0windows_launcher.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`));
  assert.equal(readFileSync(join(f.prefix, 'windows_launcher.mjs'), 'utf8'), 'launcher');
  assert.equal(current(f.prefix).release, basename(release));
  // A second install reuses the generation.
  const second = await install(f.prefix);
  assert.equal(JSON.parse(readFileSync(join(second, 'installation.json'), 'utf8')).app, join(generation, 'app'));
  assert.deepEqual(generations(f.prefix), [f.selected.inventoryDigest]);
});

test('a failure after the copy removes the copy and release this run created', async (t) => {
  const f = fixture(t);
  override(t, deps, 'materializeOriginalHost', (app) => {
    assert.ok(existsSync(app));
    throw new Error('Required Windows host layout is unavailable: late failure');
  });
  await assert.rejects(install(f.prefix), /late failure/);
  assert.deepEqual(generations(f.prefix), []);
  assert.deepEqual(readdirSync(join(f.prefix, 'releases')), []);
  assert.equal(existsSync(join(f.prefix, 'current.json')), false);
});

test('a redirected release directory still removes the new copy', async (t) => {
  const f = fixture(t);
  const real = deps.isRedirected;
  override(t, deps, 'isRedirected', (path) => basename(path) === 'releases' || real(path));
  await assert.rejects(install(f.prefix), /redirected Windows release directory/);
  assert.deepEqual(generations(f.prefix), []);
});

test('failed launcher writes are rolled back and the new copy removed', async (t) => {
  const f = fixture(t);
  write(join(f.prefix, 'windows_launcher.mjs'), 'previous launcher');
  write(join(f.prefix, '.lcu-install'), '');
  const writes = [];
  override(t, deps, 'write', (path) => {
    writes.push(basename(path));
    if (writes.length === 2) throw new Error('command locked');
    if (writes.length === 3) throw new Error('restore locked');
  });
  await assert.rejects(install(f.prefix), /restore locked/);
  assert.deepEqual(writes, ['windows_launcher.mjs', 'lcu.cmd', 'windows_launcher.mjs']);
  assert.deepEqual(generations(f.prefix), []);
  assert.deepEqual(readdirSync(join(f.prefix, 'releases')), []);
});

test('a failed pointer switch or a tampered generation keeps the current release', async (t) => {
  const f = fixture(t);
  await install(f.prefix);
  const before = current(f.prefix);
  const command = readFileSync(join(f.prefix, 'lcu.cmd'));
  write(join(f.source, 'scripts/windows_launcher.mjs'), 'new launcher');
  override(t, deps, 'rename', () => { throw new Error('pointer blocked'); });
  await assert.rejects(install(f.prefix), /pointer blocked/);
  assert.deepEqual(current(f.prefix), before);
  assert.equal(readFileSync(join(f.prefix, 'windows_launcher.mjs'), 'utf8'), 'launcher');
  assert.deepEqual(readFileSync(join(f.prefix, 'lcu.cmd')), command);
  assert.deepEqual(readdirSync(join(f.prefix, 'releases')), [before.release]);
  writeFileSync(join(f.prefix, 'apps', f.selected.inventoryDigest, 'app', WINDOWS_REQUIRED_FILES[2]), 'tampered');
  await assert.rejects(install(f.prefix), /differs from selected source inventory/);
  assert.deepEqual(current(f.prefix), before);
  assert.deepEqual(generations(f.prefix), [f.selected.inventoryDigest]);
});

test('a second install for the same prefix is refused while one runs', async (t) => {
  const f = fixture(t);
  write(join(f.prefix, '.lcu-install'), '');
  const release = await acquire(installLockPath(f.prefix));
  await assert.rejects(install(f.prefix), /Another LCU install is already running/);
  assert.equal(existsSync(join(f.prefix, 'apps')), false);
  release();
  await install(f.prefix);
});

test('a generation a release records, or may record, is kept after a failure', async (t) => {
  const f = fixture(t);
  override(t, deps, 'materializeOriginalHost', (app) => {
    write(join(f.prefix, 'releases/other/installation.json'), JSON.stringify({ app }));
    throw new Error('host extraction failed');
  });
  await assert.rejects(install(f.prefix), /host extraction failed/);
  assert.equal(generations(f.prefix).length, 1);
  const generation = join(f.prefix, 'apps/digest');
  const record = join(f.prefix, 'releases/other/installation.json');
  for (const text of ['not json', '{"app": 5}', '{"app": null}', '[]', '{}']) {
    writeFileSync(record, text);
    assert.equal(generationInUse(f.prefix, generation), true, text);
  }
  writeFileSync(record, JSON.stringify({ app: join(f.prefix, 'apps/other/app') }));
  assert.equal(generationInUse(f.prefix, generation), false);
});

test('a failure never removes a generation that already existed', async (t) => {
  const f = fixture(t);
  await install(f.prefix);
  const generation = join(f.prefix, 'apps', f.selected.inventoryDigest);
  const before = current(f.prefix);
  override(t, deps, 'materializeOriginalHost', () => { throw new Error('host extraction failed'); });
  await assert.rejects(install(f.prefix), /host extraction failed/);
  assert.ok(existsSync(join(generation, 'app/app/resources/NOTICE.txt')));
  assert.deepEqual(current(f.prefix), before);
});

test('the layout check runs on a private copy of the app Node, and refuses a missing one', (t) => {
  const f = fixture(t);
  const seen = {};
  override(t, deps, 'planOriginalHost', (app, { node }) => {
    Object.assign(seen, { app, node, content: readFileSync(node, 'utf8') });
    throw new Error('Required Windows host layout is unavailable: no factory');
  });
  assert.throws(() => preflightHost(f.selected), /no factory \(observed ChatGPT app 26\.930\.7945\.0, runtime runtime-fixture/);
  assert.equal(seen.app, f.official);
  assert.notEqual(seen.node, join(f.official, NODE_MEMBER));
  assert.equal(seen.content, 'node fixture');
  assert.equal(existsSync(seen.node), false);
  renameSync(join(f.official, NODE_MEMBER), join(f.base, 'moved'));
  assert.throws(() => preflightHost(f.selected), /no usable app\/resources\/cua_node\/bin\/node\.exe/);
});

test('the prefix must be dedicated and free of links', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.base, 'other'));
  symlinkSync(join(f.base, 'other'), join(f.base, 'junction'));
  assert.throws(() => checkedPrefix(join(f.base, 'junction/lcu')), /linked Windows installation path/);
  assert.throws(() => checkedPrefix('relative'), /dedicated absolute/);
  assert.throws(() => checkedPrefix('/lcu'), /dedicated absolute/);
  assert.throws(() => checkedPrefix(f.base), /outside the extracted release archive/);
  write(join(f.base, 'busy/file'), 'x');
  assert.throws(() => checkedPrefix(join(f.base, 'busy')), /occupied/);
});

test('agent setup gets the shared options from the new release', async (t) => {
  const f = fixture(t);
  mockWrite(t, process.stdout, () => true);
  const seen = [];
  override(t, deps, 'setup', async (release) => ({ main: async (argv) => { seen.push(release, argv); return 0; } }));
  assert.equal(await main(['--prefix', f.prefix, '--agent', 'codex', '--audio', '--yes']), 0);
  assert.deepEqual(seen[1], ['--prefix', f.prefix, '--session', 'direct', '--scope', 'user', '--agent', 'codex', '--audio', '--yes']);
  await assert.rejects(main(['--prefix', f.prefix, '--runtime-only', '--agent', 'codex']), /--runtime-only cannot include/);
  await assert.rejects(main(['--prefix', f.prefix]), /Choose --agent NAME or --runtime-only/);
});

test('a rewritten lcu.cmd is harmless wherever cmd.exe resumes the old one (0.9.7 updating itself)', () => {
  // LCU 0.9.7's launcher, with a long Python path; cmd.exe resumes after its second line.
  const old = '@echo off\r\n"C:\\Users\\someone\\AppData\\Local\\Programs\\Python\\Python313\\python.exe" -B ' +
    '"%~dp0windows_launcher.py" %*\r\nexit /b %ERRORLEVEL%\r\n';
  const node = 'C:\\Users\\someone\\AppData\\Local\\LCU\\apps\\digest\\app\\app\\resources\\cua_node\\bin\\node.exe';
  const text = launcherCommand(node, Buffer.byteLength(old));
  const lines = text.split('\r\n');
  assert.equal(lines[0], '@echo off & goto run');
  assert.match(lines[1], /^:+$/);
  assert.ok(lines[1].length >= Buffer.byteLength(old));
  assert.deepEqual(lines.slice(2), ['exit /b %ERRORLEVEL%', ':run', `"${node}" "%~dp0windows_launcher.mjs" %*`, 'exit /b %ERRORLEVEL%', '']);
  // Wherever the old file stops after its running second line, cmd lands in the label line, then exits.
  for (let offset = old.indexOf('\r\n', 11) + 2; offset <= old.length; offset += 1) {
    const rest = text.slice(offset).split('\r\n');
    assert.match(rest[0], /^:*$/, `offset ${offset}`);
    assert.equal(rest[1], 'exit /b %ERRORLEVEL%');
  }
  assert.ok(launcherCommand(node).split('\r\n')[1].length >= 512);
});
