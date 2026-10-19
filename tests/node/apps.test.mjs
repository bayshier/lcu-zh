// `lcu apps`: the always-allowed app list, against a temporary home with hand-made app bundles.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import * as apps from '../../lcu/apps.mjs';
import { REPO, output, posixTests, temporary, write } from './fixtures.mjs';

const test = posixTests('the apps helper stand-in is an sh script and the store keeps POSIX modes');

const plist = (info) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${Object.entries(info)
  .map(([key, value]) => `\t<key>${key}</key>\n\t<string>${value}</string>\n`).join('')}</dict>\n</plist>\n`;

function makeApp(directory, name, identifier, display) {
  write(join(directory, `${name}.app/Contents/Info.plist`), plist({ CFBundleIdentifier: identifier, CFBundleName: name,
    ...(display ? { CFBundleDisplayName: display } : {}) }));
  return join(directory, `${name}.app`);
}

function fixture(t) {
  const home = temporary(t);
  const applications = join(home, 'Applications');
  mkdirSync(applications);
  makeApp(applications, 'Zed', 'dev.zed.Zed');
  makeApp(applications, 'Safari', 'com.apple.Safari');
  makeApp(applications, 'Terminal', 'com.apple.Terminal');
  const f = { home, applications, store: apps.storePath(home), calls: [] };
  f.run = async (argv, { approve = true, platform = 'darwin' } = {}) => {
    const seen = await output(t);
    const auth = (root, reason) => {
      f.calls.push(reason);
      if (!approve) throw new apps.AppsError('authentication was cancelled or failed. Nothing was changed.');
    };
    const code = await apps.main(REPO, argv, { platform, home, auth });
    return { code, out: seen.out, err: seen.err };
  };
  f.write = (document) => write(f.store, typeof document === 'string' ? document : JSON.stringify(document));
  f.ids = () => JSON.parse(readFileSync(f.store, 'utf8'))[apps.KEY];
  return f;
}

test('a name, a bundle id and a path resolve to the same app; ambiguity and unknown names are reported', (t) => {
  const f = fixture(t);
  for (const query of ['Zed', 'zed', 'dev.zed.Zed', join(f.applications, 'Zed.app')]) {
    assert.deepEqual(apps.resolveApp(query, { home: f.home }), ['dev.zed.Zed', 'Zed', true], query);
  }
  makeApp(f.applications, 'Code', 'com.example.code', 'Visual Code');
  assert.equal(apps.resolveApp('Visual Code', { home: f.home })[0], 'com.example.code');
  makeApp(f.applications, 'Other', 'dev.other.Zed', 'Zed');
  assert.throws(() => apps.resolveApp('Zed', { home: f.home }), /matches several apps/);
  assert.throws(() => apps.resolveApp('Nope', { home: f.home }), /no installed app named "Nope"/);
  assert.deepEqual(apps.resolveApp('com.gone.App', { home: f.home }), ['com.gone.App', 'com.gone.App', false]);
});

test('list shows names, ids and flags without authentication; JSON and the empty list', async (t) => {
  const f = fixture(t);
  assert.match((await f.run(['list'])).out, /No apps are always allowed/);
  write(join(f.applications, 'Balatro.app/Contents/Info.plist'), `${plist({ CFBundleName: 'Balatro' })}\0\0`);
  assert.equal(apps.bundleInfo(join(f.applications, 'Balatro.app')), null);
  f.write({ [apps.KEY]: ['dev.zed.Zed', 'com.apple.Safari', 'com.gone.App'] });
  const { code, out } = await f.run([]);
  assert.equal(code, 0);
  assert.match(out, /Safari\s+com\.apple\.Safari\s+\(high risk\)/);
  assert.ok(out.includes('com.gone.App  (not installed)'));
  assert.deepEqual(f.calls, []);
  f.write({ [apps.KEY]: ['com.apple.Terminal', 'dev.zed.Zed'] });
  const listed = JSON.parse((await f.run(['--json'])).out);
  assert.deepEqual(listed.apps.map((app) => app.bundleId), ['com.apple.Terminal', 'dev.zed.Zed']);
  assert.equal(listed.apps[0].blocked, true);
  assert.deepEqual(listed.apps[1], { name: 'Zed', bundleId: 'dev.zed.Zed', installed: true, risk: 'normal', blocked: false });
  assert.equal(listed.file, f.store);
});

test('allow authenticates with a clear reason, adds once, and keeps other keys and order', async (t) => {
  const f = fixture(t);
  f.write({ schema: 3, [apps.KEY]: ['b.id'], extra: { a: [1] } });
  assert.equal((await f.run(['allow', 'Zed'])).code, 0);
  assert.deepEqual(f.calls, ['always allow Computer Use to control Zed (dev.zed.Zed)']);
  assert.deepEqual(JSON.parse(readFileSync(f.store, 'utf8')), { schema: 3, [apps.KEY]: ['b.id', 'dev.zed.Zed'], extra: { a: [1] } });
  assert.match((await f.run(['allow', 'dev.zed.Zed'])).out, /already always allowed/);
  assert.equal(f.calls.length, 1);
  const risky = await f.run(['allow', 'Safari']);
  assert.match(risky.err, /high risk/);
  assert.match(f.calls.at(-1), /\(high risk\)$/);
});

test('refusals: a failed authentication, a forbidden app, an uninstalled id', async (t) => {
  const f = fixture(t);
  assert.deepEqual([(await f.run(['allow', 'Zed'], { approve: false })).code, existsSync(f.store)], [1, false]);
  const forbidden = await f.run(['allow', 'Terminal']);
  assert.equal(forbidden.code, 1);
  assert.match(forbidden.err, /never controls Terminal/);
  assert.match((await f.run(['allow', 'com.gone.App'])).err, /is not installed here/);
  assert.equal(f.calls.length, 1);
});

test('revoke by name, id, or for an uninstalled entry; an absent app needs no prompt', async (t) => {
  const f = fixture(t);
  f.write({ [apps.KEY]: ['dev.zed.Zed', 'com.gone.App', 'com.apple.Safari'] });
  await f.run(['revoke', 'Zed']);
  await f.run(['revoke', 'com.gone.App']);
  assert.deepEqual(f.ids(), ['com.apple.Safari']);
  assert.equal(f.calls.length, 2);
  assert.match((await f.run(['revoke', 'dev.zed.Zed'])).out, /is not in the always-allowed list/);
  assert.equal(f.calls.length, 2);
  assert.match((await f.run(['revoke', 'Nope'])).err, /not among the approved apps/);
});

test('a malformed store is reported and never overwritten; an object without the key is empty', async (t) => {
  const f = fixture(t);
  for (const content of ['{not json', '[]', JSON.stringify({ [apps.KEY]: 'x' }), JSON.stringify({ [apps.KEY]: [1] })]) {
    f.write(content);
    const { code, err } = await f.run(['allow', 'Zed']);
    assert.equal(code, 1);
    assert.match(err, /not a valid approvals file/);
    assert.equal(readFileSync(f.store, 'utf8'), content);
  }
  f.write({ other: 1 });
  await f.run(['allow', 'Zed']);
  assert.deepEqual(JSON.parse(readFileSync(f.store, 'utf8')), { other: 1, [apps.KEY]: ['dev.zed.Zed'] });
});

test('modify recomputes after a racing writer, redoes a clobbered write, and gives up when the file never settles', async (t) => {
  const f = fixture(t);
  f.write({ [apps.KEY]: ['a.id'] });
  let raced = false;
  await apps.modify(f.store, (ids) => {
    if (!raced) {
      raced = true;
      f.write({ [apps.KEY]: ['a.id', 'runtime.id'] });
    }
    return [...ids, 'dev.zed.Zed'];
  }, { wait: async () => {} });
  assert.deepEqual(f.ids(), ['a.id', 'runtime.id', 'dev.zed.Zed']);
  f.write({ [apps.KEY]: ['a.id'] });
  let clobbered = false;
  await apps.modify(f.store, (ids) => (ids.includes('dev.zed.Zed') ? ids : [...ids, 'dev.zed.Zed']), { wait: async () => {
    if (!clobbered) {
      clobbered = true;
      f.write({ [apps.KEY]: ['a.id', 'runtime.id'] });
    }
  } });
  assert.deepEqual(f.ids(), ['a.id', 'runtime.id', 'dev.zed.Zed']);
  let count = 0;
  await assert.rejects(apps.modify(f.store, (ids) => [...ids, 'x'], { attempts: 3, wait: async () => {
    count += 1;
    f.write({ [apps.KEY]: [`n${count}`] });
  } }), /kept changing/);
});

test('parallel updates all land; a new store directory is created and an existing mode kept', async (t) => {
  const f = fixture(t);
  await Promise.all(Array.from({ length: 6 }, (_, index) => apps.modify(f.store, (ids) => (ids.includes(`id.${index}`) ? ids : [...ids, `id.${index}`]))));
  assert.equal(new Set(f.ids()).size, 6);
  chmodSync(f.store, 0o640);
  await apps.modify(f.store, (ids) => [...ids, 'x.y']);
  assert.equal(statSync(f.store).mode & 0o777, 0o640);
});

test('Linux and Windows explain themselves', async (t) => {
  const f = fixture(t);
  const linux = await f.run(['allow', 'Zed'], { platform: 'linux' });
  assert.equal(linux.code, 1);
  assert.match(linux.err, /no per-app approval/);
  assert.match((await f.run([], { platform: 'win32' })).err, /not supported on Windows/);
  assert.equal(existsSync(f.store), false);
});

test('authentication maps the helper exit codes and fails closed', (t) => {
  const root = temporary(t);
  assert.throws(() => apps.authenticate(root, 'why'), /helper is missing/);
  const helper = (body) => write(join(root, apps.HELPER), `#!/bin/sh\n${body}`, 0o755);
  helper('echo "$@" > "$0.args"; exit 0');
  apps.authenticate(root, 'why');
  assert.equal(readFileSync(join(root, `${apps.HELPER}.args`), 'utf8').trim(), '--reason why');
  helper('exit 1');
  assert.throws(() => apps.authenticate(root, 'why'), /cancelled or failed/);
  helper('echo no graphical login session >&2; exit 2');
  assert.throws(() => apps.authenticate(root, 'why'), /cannot ask for authentication: no graphical/);
  helper('kill -9 $$');
  assert.throws(() => apps.authenticate(root, 'why'), apps.AppsError);
});
