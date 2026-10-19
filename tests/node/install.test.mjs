import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, rmSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { acquire, installLockPath } from '../../lcu/lock.mjs';
import { SYSTEM_PACKAGES, checkedPrefix, deps, installMac, main, runAs, selectLinuxApp, selectRelease } from '../../scripts/install.mjs';
import { REPO, linuxApp, override, posixTests, seal, temporary, write, mockWrite } from './fixtures.mjs';

const test = posixTests('install.sh and the Linux/macOS installer (POSIX accounts, modes and sh)');

const ARCH = { arm64: 'arm64', x64: 'x64' }[process.arch];
const linux = process.platform === 'linux';
// Root must name the account setup is for.
const USER = ['--user', userInfo().username];

/** A sealed release source for this machine: what an extracted archive holds. */
function source(base, payload = 'new version') {
  const root = join(base, 'bundle');
  write(join(root, 'payload'), payload);
  write(join(root, 'runtime.lock.json'), JSON.stringify({ architectures: { [ARCH]: { sha256: '0'.repeat(64) } } }));
  seal(root, ARCH);
  return root;
}

/** A prefix whose current release is `releases/old`. */
function existing(base) {
  const prefix = join(base, 'lcu');
  write(join(prefix, 'releases/old/data'), 'previous version');
  writeFileSync(join(prefix, '.lcu-install'), '');
  symlinkSync('releases/old', join(prefix, 'current'));
  return prefix;
}

/** Stub modules (setup, tested) and the release check; returns the recorded calls. */
function stubbed(t, { setupStatus = 0, base } = {}) {
  const calls = [];
  override(t, deps, 'module', async (root, name) => ({
    main: async (argv) => { calls.push([name, root, argv]); return setupStatus; },
    report: (root) => calls.push(['report', root]),
  }));
  override(t, deps, 'validateRelease', (release) => calls.push(['validate', release]));
  if (base) override(t, deps, 'source', source(base));
  return calls;
}

test('a foreign, linked, relative or nested prefix is refused and left untouched', (t) => {
  const base = temporary(t);
  write(join(base, 'foreign/keep'), 'valuable');
  assert.throws(() => checkedPrefix(join(base, 'foreign')), /not an existing LCU installation/);
  assert.equal(readFileSync(join(base, 'foreign/keep'), 'utf8'), 'valuable');
  symlinkSync(base, join(base, 'link'));
  assert.throws(() => checkedPrefix(join(base, 'link/lcu')), /symlink/);
  assert.throws(() => checkedPrefix('relative/lcu'), /absolute/);
  assert.throws(() => checkedPrefix(join(base, 'bundle/nested'), join(base, 'bundle')), /outside the extracted release/);
  assert.throws(() => checkedPrefix('/usr/local'), /dedicated/);
  assert.equal(checkedPrefix(join(base, 'fresh/lcu')), join(base, 'fresh/lcu'));
  mkdirSync(join(base, 'marked/.lcu-install'), { recursive: true });
  assert.throws(() => checkedPrefix(join(base, 'marked')), /non-regular file/);
});

test('the system packages no longer include Python or XRes', () => {
  assert.ok(!SYSTEM_PACKAGES.includes('python3') && !SYSTEM_PACKAGES.includes('libxres1'));
  assert.ok(SYSTEM_PACKAGES.includes('libxtst6'));
});

test('usage errors exit 2 and --help exits 0 before anything else', { skip: !linux }, async (t) => {
  const calls = stubbed(t);
  mockWrite(t, process.stderr, () => true);
  mockWrite(t, process.stdout, () => true);
  assert.equal(await main([...USER, '--bogus']), 2);
  assert.equal(await main([...USER, '--scope', 'x']), 2);
  assert.equal(await main([...USER, '--help']), 0);
  assert.deepEqual(calls, []);
});

test('refusals come before setup, apt or any prefix write', { skip: !linux }, async (t) => {
  const base = temporary(t);
  const calls = stubbed(t);
  override(t, deps, 'spawn', () => assert.fail('apt or a command ran'));
  const prefix = join(base, 'lcu');
  await assert.rejects(main([...USER, '--offline', '--runtime-only', '--prefix', prefix]), /--offline requires --skip-system/);
  await assert.rejects(main([...USER, '--prefix', prefix, '--runtime-only', '--existing-app', join(base, 'missing')]),
    /chatgpt\.com\/download\/.*--existing-app PATH/);
  await assert.rejects(main([...USER, '--prefix', prefix, '--runtime-only', '--app-package', join(base, 'x.deb')]),
    /--app-package cannot install.*--existing-app PATH/);
  mkdirSync(join(base, 'app'));
  await assert.rejects(main([...USER, '--prefix', prefix, '--existing-app', join(base, 'app'), '--reconcile']), /lcu setup --reconcile/);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(prefix), false);
});

test('agent options are refused with --runtime-only, and an agent or export is required', { skip: !linux }, async (t) => {
  const base = temporary(t);
  const calls = stubbed(t);
  const app = linuxApp(join(base, 'chatgpt'), { arch: ARCH });
  await assert.rejects(main([...USER, '--prefix', join(base, 'lcu'), '--existing-app', app, '--skip-system', '--runtime-only', '--agent', 'codex']),
    /--runtime-only cannot include agent setup options/);
  for (const flags of [['--cross-turn', 'off'], ['--cross-turn', 'on', '--unattended']]) {
    await assert.rejects(main([...USER, '--prefix', join(base, 'lcu'), '--existing-app', app, '--skip-system', '--runtime-only', ...flags]),
      /--runtime-only cannot include agent setup options/);
  }
  assert.deepEqual(calls, []);
  await assert.rejects(main([...USER, '--prefix', join(base, 'lcu'), '--existing-app', app, '--skip-system', '--yes']), /Select --agent NAME/);
});

test('an installed app is selected in place with its own version and runtime', { skip: !linux }, (t) => {
  const app = linuxApp(join(temporary(t), 'chatgpt'), { arch: ARCH, runtimeVersion: 'runtime-new' });
  const [selected, descriptor, node] = selectLinuxApp(ARCH, { existingApp: app });
  assert.equal(selected, app);
  assert.deepEqual(descriptor, { package_version: '26.924.22138', runtime: 'runtime-new', architecture: ARCH });
  assert.equal(node, join(app, 'resources/cua_node/bin/node'));
});

test('a runtime-only install links the app, records its Node and reports the tested pair', { skip: !linux }, async (t) => {
  const base = temporary(t);
  const calls = stubbed(t, { base });
  const app = linuxApp(join(base, 'chatgpt'), { arch: ARCH });
  mockWrite(t, process.stdout, () => true);
  const prefix = join(base, 'lcu');
  assert.equal(await main([...USER, '--prefix', prefix, '--existing-app', app, '--skip-system', '--offline', '--runtime-only']), 0);
  const release = realpathSync(join(prefix, 'current'));
  assert.equal(readlinkSync(join(release, 'app')), app);
  assert.deepEqual(JSON.parse(readFileSync(join(release, 'installation.json'), 'utf8')),
    { package_version: '26.924.22138', runtime: 'runtime-new', architecture: ARCH, app });
  assert.equal(readFileSync(join(release, 'node-path'), 'utf8'), `${join(app, 'resources/cua_node/bin/node')}\n`);
  assert.equal(readFileSync(join(release, 'payload'), 'utf8'), 'new version');
  assert.ok(!existsSync(join(prefix, 'apps')));
  assert.deepEqual(calls.map(([name]) => name), ['validate', 'report']);
  assert.equal(calls[1][1], join(prefix, 'current'));
});

test('agent setup runs from the new release with the forwarded options, and its failure is reported', { skip: !linux }, async (t) => {
  const base = temporary(t);
  const app = linuxApp(join(base, 'chatgpt'), { arch: ARCH });
  const prefix = join(base, 'lcu');
  const argv = [...USER, '--prefix', prefix, '--existing-app', app, '--agent', 'pi', '--audio', '--yes', '--skip-system'];
  let calls = stubbed(t, { base });
  mockWrite(t, process.stdout, () => true);
  assert.equal(await main(argv), 0);
  const [, root, forwarded] = calls.at(-1);
  assert.equal(root, join(prefix, 'current'));
  assert.deepEqual(forwarded, ['--prefix', prefix, '--user', userInfo().username, '--scope', 'user', '--session', 'discover',
    '--agent', 'pi', '--yes', '--audio']);
  calls = stubbed(t, { base });
  assert.equal(await main([...argv, '--cross-turn', 'on', '--unattended']), 0);
  assert.ok(calls.at(-1)[2].includes('--unattended'));
  const cross = calls.at(-1)[2];
  assert.equal(cross[cross.indexOf('--cross-turn') + 1], 'on');
  calls = stubbed(t, { base });
  assert.equal(await main([...argv, '--cross-turn', 'off']), 0);
  const off = calls.at(-1)[2];
  assert.equal(off[off.indexOf('--cross-turn') + 1], 'off');
  assert.ok(!off.includes('--unattended'));
  calls = stubbed(t, { setupStatus: 5 });
  const errors = [];
  mockWrite(t, process.stderr, (text) => errors.push(text));
  assert.equal(await main(argv), 5);
  assert.match(errors.join(''), /setup failed; see the errors above/);
  assert.ok(errors.join('').includes(join(prefix, 'current/bin/lcu')));
});

test('apt failure stops the install before any release changes', { skip: !linux || process.getuid?.() !== 0 }, async (t) => {
  const base = temporary(t);
  stubbed(t, { base });
  const app = linuxApp(join(base, 'chatgpt'), { arch: ARCH });
  const prefix = existing(base);
  const commands = [];
  override(t, deps, 'spawn', (command, args) => { commands.push([command, ...args]); return { status: commands.length === 1 ? 0 : 100 }; });
  const path = process.env.PATH;
  process.env.PATH = `${join(base, 'bin')}:${path}`;
  t.after(() => { process.env.PATH = path; });
  write(join(base, 'bin/apt-get'), '', 0o755);
  await assert.rejects(main([...USER, '--prefix', prefix, '--existing-app', app, '--runtime-only']), /apt-get install failed/);
  assert.deepEqual(commands.map((command) => command.slice(0, 3)), [['apt-get', 'update'], ['apt-get', 'install', '-y']]);
  assert.deepEqual(readdirSync(join(prefix, 'releases')), ['old']);
});

test('a failed validation or an unexpected .next keeps the active release', async (t) => {
  const base = temporary(t);
  const prefix = existing(base);
  const bundle = source(base);
  const app = join(base, 'chatgpt');
  mkdirSync(app);
  override(t, deps, 'validateRelease', () => { throw new Error('runtime validation failed'); });
  await assert.rejects(selectRelease(prefix, ARCH, app, {}, '/node', { source: bundle }), /runtime validation failed/);
  assert.deepEqual(readdirSync(join(prefix, 'releases')), ['old']);
  override(t, deps, 'validateRelease', () => {});
  symlinkSync(base, join(prefix, '.next'));
  await assert.rejects(selectRelease(prefix, ARCH, app, {}, '/node', { source: bundle }), /Unexpected \.next path/);
  assert.equal(readFileSync(join(prefix, 'current/data'), 'utf8'), 'previous version');
  assert.deepEqual(readdirSync(join(prefix, 'releases')), ['old']);
});

test('installs into one prefix wait for each other', { skip: !linux }, async (t) => {
  const base = temporary(t);
  const prefix = existing(base);
  const bundle = source(base);
  const release = await acquire(installLockPath(prefix));
  const script = `import { deps, selectRelease } from ${JSON.stringify(pathToFileURL(join(REPO, 'scripts/install.mjs')).href)};
deps.validateRelease = () => {};
await selectRelease(${JSON.stringify(prefix)}, ${JSON.stringify(ARCH)}, ${JSON.stringify(base)}, {}, '/node', { source: ${JSON.stringify(bundle)} });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(child.exitCode, null, 'the second install did not wait for the lock');
  assert.equal(readFileSync(join(prefix, 'current/data'), 'utf8'), 'previous version');
  release();
  assert.equal(await exited, 0);
  assert.equal(readFileSync(join(prefix, 'current/payload'), 'utf8'), 'new version');
});

test('install.sh hands over to the Node installer on the app Node, and the 0.9.7 stub to install.sh', { skip: !linux }, (t) => {
  const base = temporary(t);
  const app = linuxApp(join(base, 'chatgpt'), { arch: ARCH });
  write(join(app, 'resources/cua_node/bin/node'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${base}/argv\n`, 0o755);
  const run = (command) => spawnSync(command[0], command.slice(1), { encoding: 'utf8' });
  let result = run([join(REPO, 'scripts/install.sh'), '--prefix', '/opt/x', '--existing-app', app, '--runtime-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(join(base, 'argv'), 'utf8').trim().split('\n'),
    [join(REPO, 'scripts/install.mjs'), '--prefix', '/opt/x', '--existing-app', app, '--runtime-only']);
  const python = spawnSync('python3', ['-c', 'pass']).status === 0;
  if (python) {
    result = run(['python3', '-B', join(REPO, 'scripts/install.py'), '--prefix', '/opt/y', `--existing-app=${app}`, '--skip-system']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(join(base, 'argv'), 'utf8').trim().split('\n'),
      [join(REPO, 'scripts/install.mjs'), '--prefix', '/opt/y', `--existing-app=${app}`, '--skip-system']);
  }
  result = run([join(REPO, 'scripts/install.sh'), '--existing-app', join(base, 'missing'), '--help']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, readFileSync(join(REPO, 'scripts/install-usage.txt'), 'utf8'));
  result = run([join(REPO, 'scripts/install.sh'), '--existing-app', join(base, 'missing')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /chatgpt\.com\/download/);
});

test('macOS: direct sessions only, and a missing app is reported before the prefix is created', async (t) => {
  const base = temporary(t);
  const calls = stubbed(t);
  const bundle = join(base, 'bundle');
  write(join(bundle, 'runtime.lock.json'), JSON.stringify({ platforms: { darwin: { architectures: { [ARCH]: {} } } } }));
  seal(bundle, ARCH, 'darwin');
  override(t, deps, 'source', bundle);
  override(t, process, 'platform', 'darwin');
  const prefix = join(base, 'lcu');
  await assert.rejects(main([...USER, '--prefix', prefix, '--runtime-only', '--session', 'discover']), /macOS uses --session direct/);
  // (setup's default session follows the real platform, so the test names it)
  await assert.rejects(main([...USER, '--prefix', prefix, '--runtime-only', '--session', 'direct', '--existing-app', join(base, 'ChatGPT.app')]),
    /chatgpt\.com\/download\/.*--existing-app PATH/);
  assert.equal(existsSync(prefix), false);
  assert.deepEqual(calls, []);
});

/** install.sh run on an app fixture whose Node records its arguments; `edit` changes the script copy first. */
function installSh(t, { edit = (text) => text, prepare = () => {} } = {}) {
  const base = temporary(t);
  chmodSync(base, 0o755);
  const app = linuxApp(join(base, 'chatgpt'), { arch: ARCH });
  write(join(app, 'resources/cua_node/bin/node'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${base}/argv\n`, 0o755);
  write(join(base, 'archive/scripts/install.sh'), edit(readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')), 0o755);
  prepare({ base, app });
  const result = spawnSync(join(base, 'archive/scripts/install.sh'), ['--existing-app', app, '--runtime-only'], { encoding: 'utf8' });
  return { ...result, ran: existsSync(join(base, 'argv')), base, app };
}

test('install.sh runs only a Node that other accounts cannot replace', { skip: !linux }, (t) => {
  assert.equal(installSh(t).ran, true);
  for (const [label, prepare, message] of [
    ['foreign owner', ({ app }) => chownSync(join(app, 'resources/cua_node/bin'), 4242, 4242), /owned by uid 4242/],
    ['group writable', ({ app }) => chmodSync(join(app, 'resources/cua_node'), 0o775), /writable by other accounts/],
    ['world writable', ({ app }) => chmodSync(join(app, 'resources/cua_node/bin/node'), 0o757), /writable by other accounts/],
    ['linked Node', ({ base, app }) => {
      write(join(base, 'real-node'), '#!/bin/sh\n', 0o755);
      (rmSync(join(app, 'resources/cua_node/bin/node')), symlinkSync(join(base, 'real-node'), join(app, 'resources/cua_node/bin/node')));
    }, /symbolic link/],
  ]) {
    if (label === 'foreign owner' && process.getuid() !== 0) continue;
    const result = installSh(t, { prepare });
    assert.equal(result.status, 1, label);
    assert.equal(result.ran, false, label);
    assert.match(result.stderr, message, label);
  }
  // A sticky directory (like /tmp) above the app is fine.
  assert.equal(installSh(t, { prepare: ({ base }) => chmodSync(base, 0o1777) }).ran, true);
});

test('install.sh as root explains why another account’s app is refused', { skip: !linux || process.getuid() !== 0 }, (t) => {
  const result = installSh(t, { prepare: ({ app }) => chownSync(app, 4242, 4242) });
  assert.equal(result.ran, false);
  assert.match(result.stderr, /owned by uid 4242\. Installing as root would run that account's copy.*Run the installer as the account that owns the app/);
});

test('install.sh on macOS runs only a Node signed by OpenAI', { skip: !linux }, (t) => {
  // The script as macOS runs it, with a stand-in codesign that accepts or refuses.
  const mac = (t2, status) => installSh(t2, {
    edit: (text) => text.replace('system=$(uname -s)', 'system=Darwin').replaceAll('/usr/bin/codesign', '"$LCU_TEST_CODESIGN"'),
    prepare: ({ base, app }) => {
      write(join(app, 'Contents/Resources/cua_node/bin/node'), readFileSync(join(app, 'resources/cua_node/bin/node')), 0o755);
      write(join(base, 'codesign'), `#!/bin/sh\necho "$@" > ${base}/codesign-args\nexit ${status}\n`, 0o755);
      process.env.LCU_TEST_CODESIGN = join(base, 'codesign');
    },
  });
  t.after(() => { delete process.env.LCU_TEST_CODESIGN; });
  const accepted = mac(t, 0);
  assert.equal(accepted.ran, true);
  assert.match(readFileSync(join(accepted.base, 'codesign-args'), 'utf8'), /--verify --strict .*2DC432GLL2.*Contents\/Resources\/cua_node\/bin\/node/);
  const refused = mac(t, 1);
  assert.equal(refused.status, 1);
  assert.equal(refused.ran, false);
  assert.match(refused.stderr, /is not signed by OpenAI/);
});

test('macOS: a failed validation keeps the previous selection, and setup’s exit status is kept', async (t) => {
  const base = temporary(t);
  const bundle = join(base, 'bundle');
  write(join(bundle, 'runtime.lock.json'), JSON.stringify({ platforms: { darwin: { architectures: { [ARCH]: {} } } } }));
  seal(bundle, ARCH, 'darwin');
  override(t, deps, 'source', bundle);
  override(t, process, 'platform', 'darwin');
  const app = join(base, 'ChatGPT.app');
  mkdirSync(join(app, 'Contents/Resources/cua_node/bin'), { recursive: true });
  override(t, deps, 'resolveMacApp', (location) => ({ app: location, runtime: join(location, 'Contents/Resources/cua_node'),
    version: '26.1', runtimeVersion: 'runtime-mac' }));
  const prefix = existing(base);
  override(t, deps, 'validateRelease', () => { throw new Error('signature check failed'); });
  await assert.rejects(installMac(prefix, app), /signature check failed/);
  assert.equal(readFileSync(join(prefix, 'current/data'), 'utf8'), 'previous version');
  assert.deepEqual(readdirSync(join(prefix, 'releases')), ['old']);
  const calls = stubbed(t, { setupStatus: 3 });
  const errors = [];
  mockWrite(t, process.stderr, (text) => { errors.push(text); return true; });
  mockWrite(t, process.stdout, () => true);
  assert.equal(await main([...USER, '--prefix', prefix, '--existing-app', app, '--session', 'direct', '--agent', 'codex', '--yes']), 3);
  const [name, , forwarded] = calls.at(-1);
  assert.equal(name, 'setup');
  assert.deepEqual(forwarded.slice(forwarded.indexOf('--session'), forwarded.indexOf('--session') + 2), ['--session', 'direct']);
  assert.match(errors.join(''), /setup failed; see the errors above/);
});

test('validation commands run as the target account, with its groups and environment', { skip: !linux || process.getuid() !== 0 ||
    spawnSync('useradd', ['--help']).error !== undefined }, (t) => {
  const name = `lcutest${process.pid}`;
  assert.equal(spawnSync('useradd', ['-M', '-d', '/tmp', '-s', '/bin/sh', '-U', '-G', 'adm', name]).status, 0);
  t.after(() => spawnSync('userdel', [name]));
  const [uid, gid] = ['-u', '-g'].map((flag) => Number(spawnSync('id', [flag, name], { encoding: 'utf8' }).stdout));
  const base = temporary(t);
  chmodSync(base, 0o777);
  const out = join(base, 'out.json');
  const home = join(base, 'home');
  mkdirSync(home);
  chownSync(home, uid, gid);
  const umask = process.umask();
  runAs([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ uid: process.getuid(),
    euid: process.geteuid(), gid: process.getgid(), groups: process.getgroups(), umask: process.umask(), cwd: process.cwd(),
    env: { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME } }))`], { name, uid, gid, home });
  const seen = JSON.parse(readFileSync(out, 'utf8'));
  const adm = Number(spawnSync('getent', ['group', 'adm'], { encoding: 'utf8' }).stdout.split(':')[2]);
  assert.deepEqual([seen.uid, seen.euid, seen.gid], [uid, uid, gid]);
  assert.deepEqual(seen.groups.sort(), [gid, adm].sort());
  assert.equal(seen.umask, umask);
  assert.equal(seen.cwd, home);
  assert.deepEqual(seen.env, { HOME: home, USER: name, LOGNAME: name });
  assert.throws(() => runAs([process.execPath, '-e', 'process.exit(4)'], { name, uid, gid, home }), /exit status 4/);
});
