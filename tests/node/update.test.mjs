import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import * as update from '../../lcu/update.mjs';
import { override, temporary, write, mockWrite } from './fixtures.mjs';

const INFO = { version: '0.9.2', tag: 'v0.9.2', severity: 'normal', release_url: 'https://github.com/amontlabs/lcu/releases/tag/v0.9.2' };

/** An installed 0.9.1 release, a private home and cache, and no real refresh. */
function setup(t, version = '0.9.1') {
  const base = temporary(t);
  const home = join(base, 'home');
  mkdirSync(home);
  const proxies = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
  // homedir() reads USERPROFILE on Windows, and the Windows cache lives under LOCALAPPDATA.
  const saved = Object.fromEntries(['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'LCU_NO_UPDATE_CHECK', ...proxies]
    .map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData/Local'), XDG_CACHE_HOME: join(home, 'xdg') });
  for (const key of ['LCU_NO_UPDATE_CHECK', ...proxies]) delete process.env[key];
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const root = join(base, 'prefix/releases/r1');
  if (version) write(join(root, 'bundle.json'), JSON.stringify({ version }));
  else mkdirSync(root, { recursive: true });
  const spawned = [];
  override(t, update.deps, 'spawnRefresh', (release) => spawned.push(release));
  return { base, home, root, spawned };
}

function cache(latest = INFO, { error = null, age = 0 } = {}) {
  write(update.cachePath(), JSON.stringify({ checked_at: Date.now() / 1000 - age, latest, error }));
}

/** Run `lcu update ARGV`; returns `[status, stdout]`. */
async function cli(t, root, ...argv) {
  const out = [];
  const stdout = mockWrite(t, process.stdout, (text) => { out.push(text); return true; });
  const stderr = mockWrite(t, process.stderr, () => true);
  try {
    return [await update.main(root, argv), out.join('')];
  } finally {
    stdout.mock.restore();
    stderr.mock.restore();
  }
}

test('versions compare as dotted integers', (t) => {
  const { root } = setup(t);
  assert.deepEqual(update.parseVersion('v0.9.2'), [0, 9, 2]);
  assert.equal(update.parseVersion('0.9.x'), null);
  assert.equal(update.parseVersion(''), null);
  assert.equal(update.newer(root, INFO), true);
  for (const [version, expected] of [['0.9.1', false], ['0.8.9', false], ['0.10.0', true], ['garbage', false]]) {
    assert.equal(update.newer(root, { version }), expected, version);
  }
});

test('the cache is per account', (t) => {
  const { home } = setup(t);
  assert.ok(update.cachePath().startsWith(home));
  assert.ok(update.cachePath().endsWith('update.json'));
});

/** Answer fetch with `respond(url, init)` (a Response, or a thrown error) and record curl calls. */
function network(t, respond, curlOutput = '') {
  const calls = { fetch: [], curl: [] };
  override(t, update.deps, 'fetch', async (url, init) => { calls.fetch.push([url, init.method ?? 'GET']); return respond(url, init); });
  override(t, update.deps, 'curl', (args) => {
    calls.curl.push(args);
    const output = args.indexOf('-o');
    if (output >= 0 && args[output + 1] !== '/dev/null') writeFileSync(args[output + 1], curlOutput);
    return { status: 0, stdout: Buffer.from(curlOutput), stderr: '' };
  });
  return calls;
}
const redirect = (location) => new Response(null, { status: 302, headers: location ? { location } : {} });

test('the latest tag comes from the redirect of /releases/latest', async (t) => {
  setup(t);
  network(t, () => redirect('https://github.com/amontlabs/lcu/releases/tag/v0.9.2'));
  assert.equal(await update.latestTag(), 'v0.9.2');
  network(t, () => redirect('/amontlabs/lcu/releases/tag/0.9.3'));
  assert.equal(await update.latestTag(), '0.9.3');
  network(t, () => new Response(null, { status: 404 }));
  await assert.rejects(update.latestTag(), /HTTP 404/);
  network(t, () => new Response(null, { status: 200 }));
  await assert.rejects(update.latestTag(), /Unexpected response/);
  network(t, () => redirect(null));
  await assert.rejects(update.latestTag(), /Unexpected response/);
});

test('a failed request falls back to curl, and a proxy goes to curl directly', async (t) => {
  setup(t);
  let calls = network(t, () => { throw new TypeError('fetch failed'); }, 'https://github.com/amontlabs/lcu/releases/tag/v0.9.4');
  assert.equal(await update.latestTag(), 'v0.9.4');
  assert.equal(calls.fetch.length, 1);
  assert.deepEqual(calls.curl[0].slice(0, 6), ['-fsS', '--proto', '=https', '--tlsv1.2', '--max-time', '5']);
  assert.ok(calls.curl[0].includes('%{redirect_url}'));
  process.env.HTTPS_PROXY = 'http://proxy.invalid:3128';
  calls = network(t, () => assert.fail('fetch ignores the proxy'), 'https://github.com/amontlabs/lcu/releases/tag/v0.9.5');
  assert.equal(await update.latestTag(), 'v0.9.5');
  process.env.NO_PROXY = 'example.com,.github.com';
  assert.equal(update.proxied('https://github.com/x'), false);
  assert.equal(update.proxied('https://raw.githubusercontent.com/x'), true);
});

test('a download behind a proxy goes to a file through curl and is hashed', async (t) => {
  const { base } = setup(t);
  process.env.https_proxy = 'http://proxy.invalid:3128';
  const calls = network(t, () => assert.fail('fetch ignores the proxy'), 'archive bytes');
  const file = join(base, 'archive.tar.gz');
  const digest = await update.downloadTo('https://github.com/a/b.tar.gz', file);
  assert.equal(readFileSync(file, 'utf8'), 'archive bytes');
  assert.equal(digest, (await import('node:crypto')).createHash('sha256').update('archive bytes').digest('hex'));
  assert.deepEqual(calls.curl[0].slice(-4), ['-L', '-o', file, 'https://github.com/a/b.tar.gz']);
  delete process.env.https_proxy;
  network(t, () => new Response('fetched bytes'));
  await update.downloadTo('https://github.com/a/b.tar.gz', file);
  assert.equal(readFileSync(file, 'utf8'), 'fetched bytes');
  network(t, () => new Response('gone', { status: 404 }));
  await assert.rejects(update.downloadTo('https://github.com/a/b.tar.gz', file), /HTTP 404/);
});

test('the release and its severity marker', async (t) => {
  setup(t);
  let notes = '# LCU 0.9.2\n\n<!-- lcu-severity: security -->\n';
  network(t, (url, init) => (init.method === 'HEAD' ? redirect('/amontlabs/lcu/releases/tag/v0.9.2') : new Response(notes)));
  assert.deepEqual(await update.fetchLatest(), { ...INFO, severity: 'security' });
  for (const [text, expected] of [['Add `<!-- lcu-severity: security -->` to the notes.', 'normal'],
    ['<!-- lcu-severity: breaking -->', 'breaking'], ['<!-- lcu-severity: weird -->', 'normal'], ['nothing', 'normal']]) {
    notes = text;
    assert.equal(await update.severityOf('v0.9.2', '0.9.2'), expected);
  }
  network(t, () => new Response('', { status: 500 }));
  assert.equal(await update.severityOf('v0.9.2', '0.9.2'), 'normal');
  network(t, () => redirect('/amontlabs/lcu/releases/tag/nightly'));
  await assert.rejects(update.fetchLatest(), /Unrecognized release tag/);
});

test('staleness backs off after an error', () => {
  const now = Date.now() / 1000;
  assert.equal(update.stale(null), true);
  assert.equal(update.stale({ checked_at: now - 540, error: null }, now), false);
  assert.equal(update.stale({ checked_at: now - 601, error: null }, now), true);
  assert.equal(update.stale({ checked_at: now - 600, error: 'down' }, now), false);
  assert.equal(update.stale({ checked_at: now - 4000, error: 'down' }, now), true);
  assert.equal(update.stale({ checked_at: now + 999, error: null }, now), true);
});

test('a check writes the cache and keeps the known release on error', async (t) => {
  setup(t);
  override(t, update.deps, 'fetchLatest', async () => INFO);
  assert.deepEqual(await update.check(), [INFO, null]);
  assert.deepEqual(update.readCache().latest, INFO);
  override(t, update.deps, 'fetchLatest', async () => { throw new Error('offline'); });
  assert.deepEqual(await update.check(), [null, 'offline']);
  assert.deepEqual([update.readCache().latest, update.readCache().error], [INFO, 'offline']);
});

test('checks are off for source checkouts and with LCU_NO_UPDATE_CHECK', (t) => {
  const { root, base, spawned } = setup(t);
  assert.equal(update.enabled(root), true);
  for (const [value, expected] of [['1', false], ['yes', false], ['0', true], ['', true]]) {
    assert.equal(update.enabled(root, { LCU_NO_UPDATE_CHECK: value }), expected);
  }
  const source = join(base, 'src');
  mkdirSync(source);
  assert.equal(update.enabled(source), false);
  cache();
  assert.equal(update.notice(source), null);
  process.env.LCU_NO_UPDATE_CHECK = '1';
  assert.equal(update.notice(root), null);
  assert.equal(update.statusLine(root), null);
  assert.deepEqual(spawned, []);
});

test('the notice names the stable command, the severity and the release', (t) => {
  const { root, spawned } = setup(t);
  cache();
  const found = update.notice(root);
  assert.deepEqual(spawned, []); // fresh cache
  // The stable command: `current/bin/lcu` on POSIX, the prefix's lcu.cmd on Windows (see stableCommand below).
  const command = join(root, process.platform === 'win32' ? '../../lcu.cmd' : '../../current/bin/lcu');
  assert.deepEqual(Object.keys(found).sort(), ['command', 'current', 'latest', 'message', 'release_url', 'severity']);
  assert.deepEqual([found.current, found.latest, found.severity, found.command], ['0.9.1', '0.9.2', 'normal', command]);
  assert.ok(found.message.startsWith('LCU 0.9.2 is available'));
  assert.ok(found.message.includes(`\`${command} update\``) && found.message.includes('without asking'));
  cache({ ...INFO, severity: 'security' });
  assert.ok(update.notice(root).message.startsWith('Security update: '));
  cache({ ...INFO, severity: 'breaking' });
  assert.ok(update.notice(root).message.startsWith('Breaking update: '));
  assert.match(update.statusLine(root), /0\.9\.2/);
  cache({ ...INFO, version: '0.9.1' });
  assert.equal(update.noticeCached(root), null);
  assert.equal(update.statusLine(root), null);
});

test('a stale cache starts one detached refresh, guarded by a stamp', (t) => {
  const { root, spawned } = setup(t);
  assert.equal(update.notice(root), null);
  update.notice(root);
  assert.deepEqual(spawned, [root]);
  const stamp = join(update.cachePath(), '../refresh.stamp');
  const old = Date.now() / 1000 - 121;
  utimesSync(stamp, old, old);
  cache(INFO, { age: 90000 });
  assert.equal(update.notice(root).latest, '0.9.2');
  assert.equal(spawned.length, 2);
});

test('the refresh stamp tolerates clock skew', (t) => {
  setup(t);
  assert.equal(update.refreshClaimed(), true);
  const stamp = join(update.cachePath(), '../refresh.stamp');
  const now = statSync(stamp).mtimeMs / 1000 - 0.05;
  assert.equal(update.refreshClaimed(now), false);
  const future = now + update.STAMP_SKEW + 1;
  utimesSync(stamp, future, future);
  assert.equal(update.refreshClaimed(now), true);
});

test('a notice never fails', async (t) => {
  const { root } = setup(t);
  override(t, update.deps, 'spawnRefresh', () => { throw new Error('no'); });
  assert.equal(update.notice(root), null);
  write(update.cachePath(), '{not json');
  assert.equal(update.notice(root), null);
  cache({ version: null });
  assert.equal(update.notice(root), null);
  assert.deepEqual(await cli(t, root, '--notice', '--json'), [0, '{}\n']);
});

test('the notice command prints the cached notice for people and agents', async (t) => {
  const { root } = setup(t);
  cache();
  const [status, out] = await cli(t, root, '--notice', '--json');
  assert.equal(status, 0);
  assert.equal(JSON.parse(out).latest, '0.9.2');
  assert.match((await cli(t, root, '--notice'))[1], /^LCU 0\.9\.2 is available/);
  cache({ ...INFO, version: '0.9.1' });
  assert.deepEqual(await cli(t, root, '--notice', '--json'), [0, '{}\n']);
  assert.deepEqual(await cli(t, root, '--notice'), [0, '']);
  assert.deepEqual(await cli(t, root, '--notice', '--hook', 'SessionStart'), [0, '']);
});

async function hook(t, root, event, stdin = '{"session_id": "s1"}') {
  override(t, update.deps, 'readStdin', () => stdin);
  const [status, out] = await cli(t, root, '--notice', '--hook', event);
  assert.equal(status, 0);
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

test('hooks announce a release once per session and once a day per account', async (t) => {
  const { root } = setup(t);
  cache();
  const first = await hook(t, root, 'SessionStart');
  assert.equal(first.hookEventName, 'SessionStart');
  assert.ok(first.additionalContext.startsWith('LCU 0.9.2 is available'));
  assert.equal(await hook(t, root, 'SessionStart'), null);
  assert.equal(await hook(t, root, 'UserPromptSubmit', '{"session_id": "s2"}'), null);
  cache({ ...INFO, version: '0.9.3', tag: 'v0.9.3' });
  assert.match((await hook(t, root, 'UserPromptSubmit')).additionalContext, /0\.9\.3/);
  assert.equal(await hook(t, root, 'SessionStart', '{"session_id": "s2"}'), null);
});

test('the announcement cooldown is account wide and per release', (t) => {
  setup(t);
  const day = update.ANNOUNCE_COOLDOWN;
  const at = 1_000_000_000;
  override(t, update.deps, 'now', () => at);
  assert.equal(update.announce('a', '0.9.2', at), true);
  assert.equal(update.announce('a', '0.9.2', at + 1), false);
  assert.equal(update.announce('b', '0.9.2', at + 3600), false);
  assert.equal(update.announce(null, '0.9.2', at + day - 1), false);
  assert.equal(update.announce('b', '0.9.2', at + day), true);
  assert.equal(update.announce('c', '0.9.2', at + day + 1), false);
  assert.equal(update.announce('a', '0.9.2', at + 3 * day), false);
  assert.equal(update.announce('c', '0.9.3', at + day + 2), true);
  assert.equal(update.announce('d', '0.9.3', at + day + 3), false);
  const data = JSON.parse(readFileSync(join(update.cachePath(), '../announced.json'), 'utf8'));
  assert.deepEqual(data[update.ANNOUNCE_ACCOUNT], { version: '0.9.3', at: at + day + 2 });
  assert.ok(!('d' in data));
});

test('hooks without a usable session id still follow the cooldown, and old entries are pruned', async (t) => {
  const { root } = setup(t);
  cache();
  const path = join(update.cachePath(), '../announced.json');
  for (const stdin of ['', 'garbage{', '[]', '{"session_id": 5}', '{}']) {
    if (existsSync(path)) unlinkSync(path);
    assert.notEqual(await hook(t, root, 'SessionStart', stdin), null, stdin);
    assert.equal(await hook(t, root, 'SessionStart', stdin), null);
    assert.equal(await hook(t, root, 'UserPromptSubmit', stdin), null);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))), [update.ANNOUNCE_ACCOUNT]);
  }
  const now = Date.now() / 1000;
  writeFileSync(path, JSON.stringify({ old: { version: '0.9.2', at: now - 8 * 86400 }, recent: { version: '0.9.2', at: now - 86400 },
    bad: 3, [update.ANNOUNCE_ACCOUNT]: { version: '0.9.2', at: now - 2 * 86400 } }));
  assert.equal(await hook(t, root, 'UserPromptSubmit', '{"session_id": "recent"}'), null);
  assert.notEqual(await hook(t, root, 'UserPromptSubmit', '{"session_id": "old"}'), null);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort(), [update.ANNOUNCE_ACCOUNT, 'old', 'recent']);
});

test('--announce applies the cooldown for agent integrations', async (t) => {
  const { root } = setup(t);
  cache();
  assert.equal(JSON.parse((await cli(t, root, '--notice', '--json', '--announce=s1'))[1]).latest, '0.9.2');
  assert.deepEqual(await cli(t, root, '--notice', '--json', '--announce=s1'), [0, '{}\n']);
  assert.deepEqual(await cli(t, root, '--notice', '--json', '--announce'), [0, '{}\n']);
  assert.deepEqual(await cli(t, root, '--notice', '--announce', 's3'), [0, '']);
  assert.equal(JSON.parse((await cli(t, root, '--notice', '--json'))[1]).latest, '0.9.2');
});

test('check, refresh and apply', async (t) => {
  const { root } = setup(t);
  override(t, update.deps, 'fetchLatest', async () => INFO);
  let [status, out] = await cli(t, root, '--check');
  assert.equal(status, 0);
  assert.match(out, /LCU 0\.9\.2 is available \(installed 0\.9\.1\)[\s\S]*update to upgrade\./);
  const data = JSON.parse((await cli(t, root, '--check', '--json'))[1]);
  assert.deepEqual([data.current, data.update_available, data.error, data.latest], ['0.9.1', true, null, INFO]);
  assert.deepEqual(await cli(t, root, '--refresh'), [0, '']);
  const applied = [];
  override(t, update.deps, 'apply', async (...args) => { applied.push(args); return 7; });
  assert.equal((await cli(t, root, '--yes'))[0], 7);
  assert.deepEqual(applied, [[root, INFO, { yes: true }]]);
  override(t, update.deps, 'fetchLatest', async () => ({ ...INFO, version: '0.9.1' }));
  assert.deepEqual(await cli(t, root, '--check'), [0, 'LCU 0.9.1 is up to date.\n']);
  assert.deepEqual(await cli(t, root), [0, 'LCU 0.9.1 is up to date.\n']);
  assert.equal(applied.length, 1);
  override(t, update.deps, 'fetchLatest', async () => { throw new Error('down'); });
  [status, out] = await cli(t, root, '--check', '--json');
  assert.equal(status, 1);
  assert.equal(JSON.parse(out).error, 'down');
});

test('usage errors exit 2', async (t) => {
  const { root } = setup(t);
  assert.equal((await cli(t, root, '--bogus'))[0], 2);
  assert.equal((await cli(t, root, '--check', '--notice'))[0], 2);
  assert.equal((await cli(t, root, '--notice', '--hook', 'Stop'))[0], 2);
});

test('the stable command per platform', (t) => {
  const { root } = setup(t);
  assert.equal(update.stableCommand(root, 'darwin'), join(root, '../../current/bin/lcu'));
  assert.equal(update.stableCommand(root, 'win32'), join(root, '../../lcu.cmd'));
});

/** postInstall with stubbed harness modules; returns `[stdout, stderr, calls]`. */
async function postInstall(t, root, home, { refresh = async () => ['absent', null, []], needsSetup = false } = {}) {
  const calls = [];
  const real = update.deps.module;
  override(t, update.deps, 'module', async (name) => ({
    claude_mod: { ...(await real('claude_mod')), install: async (...args) => calls.push(['install', ...args]) },
    browser: { refresh: async (release) => {
      calls.push(['refresh', release]);
      const [status, destination, displaced] = await refresh();
      return { status, destination, displaced };
    } },
  })[name] ?? real(name));
  if (needsSetup) {
    write(join(home, '.codex/config.toml'), '[mcp_servers.lcu]\ncommand = "/p/current/bin/lcu"\n');
  }
  const out = [];
  const err = [];
  const stdout = mockWrite(t, process.stdout, (text) => { out.push(text); return true; });
  const stderr = mockWrite(t, process.stderr, (text) => { err.push(text); return true; });
  try {
    assert.equal(await update.postInstall(root, home), 0);
  } finally {
    stdout.mock.restore();
    stderr.mock.restore();
  }
  return [out.join(''), err.join(''), calls];
}

test('post-install refreshes only LCU’s own Claude mod', async (t) => {
  const { root, home } = setup(t);
  let [out, , calls] = await postInstall(t, root, home);
  assert.equal(out, '');
  assert.deepEqual(calls, [['refresh', root]]);
  const manifest = join(home, '.claude/skills/lcu-approve/.claude-plugin/plugin.json');
  write(manifest, '{"name": "someone-else"}');
  [out, , calls] = await postInstall(t, root, home);
  assert.equal(out, '');
  writeFileSync(manifest, '{"name": "lcu-approve"}');
  [out, , calls] = await postInstall(t, root, home);
  assert.match(out, /Refreshed the Claude Code lcu-approve mod/);
  assert.deepEqual(calls[0], ['install', home, root]);
});

test('post-install reports the Chrome relay refresh and never fails on it', async (t) => {
  const { root, home } = setup(t);
  let [out, err] = await postInstall(t, root, home, { refresh: async () => ['changed', '/relay/dir', []] });
  assert.match(out, /Refreshed the Chrome relay at \/relay\/dir[\s\S]*restart Chrome/);
  assert.equal(err, '');
  [out] = await postInstall(t, root, home, { refresh: async () => ['unchanged', '/relay/dir', ['/cfg/manifest.json']] });
  assert.ok(!out.includes('restart Chrome') && out.includes('/cfg/manifest.json') && out.includes('browser install'));
  [out] = await postInstall(t, root, home, { refresh: async () => ['elsewhere', '/relay/dir', []] });
  assert.ok(out.includes('left alone') && !out.includes('Refreshed the Chrome relay'));
  [out] = await postInstall(t, root, home, { refresh: async () => ['root', '/relay/dir', []] });
  assert.match(out, /ran as root/);
  [out, err] = await postInstall(t, root, home, { refresh: async () => { throw new Error('The original Chrome installer failed (exit 1).'); } });
  assert.equal(out, '');
  assert.match(err, /could not refresh the Chrome relay.*installer failed.*browser install/);
  [out] = await postInstall(t, root, home, { needsSetup: true });
  assert.match(out, /setup --agent codex/);
});

test('the Codex hint appears only while LCU is registered without both notice hooks', async (t) => {
  const { home } = setup(t);
  const codex = join(home, '.codex');
  const env = { CODEX_HOME: codex };
  assert.equal(await update.codexNeedsSetup(home, env), false);
  write(join(codex, 'config.toml'), '[mcp_servers.lcu]\ncommand = "/p/current/bin/lcu"\n');
  assert.equal(await update.codexNeedsSetup(home, env), true);
  const hook = (event) => `[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\n` +
    `command = "/p/current/bin/lcu update --notice --hook ${event}"\n`;
  writeFileSync(join(codex, 'config.toml'), `[mcp_servers.lcu]\ncommand = "/p/current/bin/lcu"\n${hook('SessionStart')}`);
  assert.equal(await update.codexNeedsSetup(home, env), true);
  writeFileSync(join(codex, 'config.toml'), `[mcp_servers.lcu]\ncommand = "/p/current/bin/lcu"\n${hook('SessionStart')}${hook('UserPromptSubmit')}`);
  assert.equal(await update.codexNeedsSetup(home, env), false);
});
