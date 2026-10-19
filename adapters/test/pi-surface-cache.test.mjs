import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import piExtension, { surfaceKey } from '../pi/index.ts';

// These tests start the runtime only through commands that record their own starts, and keep the
// surface cache in a temporary home. The test preload turns the cache off for the other test files.
// The cache is off on Windows, and the fake release launcher is a POSIX shell script.
const skip = process.platform === 'win32' && 'the surface cache is off on Windows; the fake release is a POSIX shell script';
const fixture = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url));
// A host that is not an LCU release: its versions cannot be read, so it is never cached.
const countingHost = [process.execPath, '--input-type=module', '-e',
  `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.LCU_TEST_SPAWN_LOG, 'n');
await import(${JSON.stringify(new URL('./mcp-fixture.mjs', import.meta.url).href)});`];

const sharedCache = home => process.platform === 'darwin' ? join(home, 'Library', 'Caches', 'lcu') : join(home, '.cache', 'lcu');
const cacheFile = home => join(sharedCache(home), 'pi-surfaces.json');
const memory = () => globalThis[Symbol.for('lcu.pi.surfaces')];

/** Where a fake release keeps the app resources that hold the CUA manifest. */
const resources = root => process.platform === 'darwin'
  ? join(root, 'ChatGPT.app', 'Contents', 'Resources') : join(root, 'app', 'resources');

/** Set the app and CUA runtime versions a fake release reports. */
function setVersions(root, { app = '1.0', runtime = '0.0.1/a' } = {}) {
  writeFileSync(join(resources(root), 'cua_node', 'manifest.json'), JSON.stringify({ runtime_archive_version: runtime }));
  if (process.platform === 'darwin') {
    writeFileSync(join(root, 'ChatGPT.app', 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist><dict>
<key>CFBundleShortVersionString</key>\n<string>${app}</string>\n<key>CFBundleVersion</key><string>1</string></dict></plist>`);
  }
}

/**
 * A fake installed release at `<home>/<name>`: `bin/lcu` records `log` in the spawn log and runs the
 * fixture host; `installation.json`, `bundle.json` and the app files give it readable versions.
 * `bin/lcu-session` keeps the working directory and PATH and execs the command after
 * `--user ACCOUNT` and an optional `--`, as lcu/session.mjs does apart from its desktop variables.
 */
function release(home, name, versions, log = basename(name)) {
  const root = join(home, name);
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'lcu'), { recursive: true });
  mkdirSync(join(resources(root), 'cua_node'), { recursive: true });
  writeFileSync(join(root, 'bin', 'lcu'), `#!/bin/sh\nprintf ${log} >> "$LCU_TEST_SPAWN_LOG"\n` +
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}\n`);
  writeFileSync(join(root, 'bin', 'lcu-session'), '#!/bin/sh\n' +
    'case $1 in --user) shift 2 ;; --user=*) shift ;; *) exit 2 ;; esac\n[ "$1" = -- ] && shift\nexec "$@"\n');
  chmodSync(join(root, 'bin', 'lcu'), 0o755);
  chmodSync(join(root, 'bin', 'lcu-session'), 0o755);
  writeFileSync(join(root, 'lcu', 'runtime.mjs'), '');
  writeFileSync(join(root, 'lcu', 'session.mjs'), '');
  writeFileSync(join(root, 'bundle.json'), `{"version":"0.0.0-${log}"}`);
  writeFileSync(join(root, 'installation.json'), JSON.stringify(process.platform === 'darwin'
    ? { platform: 'darwin', app: join(root, 'ChatGPT.app') } : { platform: 'linux', app: join(root, 'app') }));
  writeFileSync(join(resources(root), 'app.asar'), 'asar');
  setVersions(root, versions);
  return root;
}

/** Run `body` with a temporary home, an empty in-memory cache and a fake release `r` as the command. */
async function withCache(body, { command = home => [join(release(home, 'r'), 'bin', 'lcu')] } = {}) {
  // accountHome() rejects a home whose parents include a symlink (/var on macOS). The temporary
  // home sits under the real home so cacheDirectory() uses it, and the test deletes it.
  const home = mkdtempSync(join(homedir(), '.lcu-pi-surface-'));
  const names = ['HOME', 'USERPROFILE', 'XDG_CACHE_HOME', 'LCU_MCP_COMMAND', 'LCU_TEST_SPAWN_LOG', 'PATH',
    'LCU_FIXTURE_LOG', 'LCU_SURFACE_CACHE', 'LCU_DIAGNOSTIC_LOG', 'LCU_LOG_DIR'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const cwd = process.cwd();
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, XDG_CACHE_HOME: join(home, '.cache'),
    LCU_TEST_SPAWN_LOG: join(home, 'spawns'), LCU_FIXTURE_LOG: join(home, 'mcp.jsonl'),
  });
  const selected = typeof command === 'function' ? command(home) : command;
  if (selected === null) delete process.env.LCU_MCP_COMMAND; // the adapter's own default or setup's command
  else process.env.LCU_MCP_COMMAND = JSON.stringify(selected);
  delete process.env.LCU_SURFACE_CACHE;
  memory()?.clear();
  const sessions = [];
  const started = () => {
    try { return readFileSync(join(home, 'spawns'), 'utf8'); } catch { return ''; }
  };
  try {
    await body({ home, started, spawns: () => started().length,
      session: (...args) => { const made = session(...args); sessions.push(made); return made; } });
  } finally {
    for (const made of sessions) await made.handlers.get('session_shutdown')?.();
    process.chdir(cwd);
    memory()?.clear();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function session(extension = piExtension, options = undefined) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const notes = [];
  const registrations = [];
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    registerTool(tool) { tools.set(tool.name, tool); registrations.push(tool.name); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  const ctx = { sessionManager: { getSessionId: () => 'surface-session' }, model: { id: 'surface-model' }, hasUI: true,
    ui: { notify(message, type) { notes.push({ message, type }); }, async select() { return undefined; } } };
  const loaded = extension(pi, options);
  const prompt = async (append = 'Existing append') => {
    const systemPromptOptions = { appendSystemPrompt: append };
    assert.equal(await handlers.get('before_agent_start')({ systemPrompt: 'Pi', systemPromptOptions }, ctx), undefined);
    return systemPromptOptions.appendSystemPrompt;
  };
  // What Pi sends the provider for each registered tool.
  const definitions = () => JSON.stringify([...tools.values()].map(tool => ({
    name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
  })));
  return { handlers, tools, commands, notes, registrations, ctx, loaded, prompt, definitions };
}

test('a second Pi session in the same process starts no host before its first LCU tool call', { skip }, async () => {
  await withCache(async ({ spawns, session }) => {
    const first = session();
    const firstPrompt = await first.prompt();
    assert.equal(spawns(), 1, 'an unknown surface connects in before_agent_start, as before');
    assert.match(firstPrompt, /^Existing append\n\nOriginal CUA initialization guide/);
    await first.handlers.get('session_shutdown')();

    // Pi may load the extension module again for another session or subagent; the surface is per process.
    const { default: secondCopy } = await import('../pi/index.ts?second-module-copy');
    const second = session(secondCopy);
    const secondPrompt = await second.prompt();
    assert.equal(spawns(), 1, 'a known surface must not start a host in before_agent_start');
    assert.equal(secondPrompt, firstPrompt, 'instructions must be byte-identical to a live connect');
    assert.equal(second.definitions(), first.definitions(), 'tool definitions must be byte-identical to a live connect');
    assert.deepEqual(second.registrations, ['js', 'js_reset']);
    const options = { appendSystemPrompt: secondPrompt };
    await second.handlers.get('before_agent_start')({ systemPrompt: 'Pi', systemPromptOptions: options }, second.ctx);
    assert.equal(options.appendSystemPrompt, secondPrompt, 'the instructions are appended once');

    await second.handlers.get('agent_start')({}, second.ctx);
    const result = await second.tools.get('js').execute('surface-call', { code: 'first' }, undefined, undefined, second.ctx);
    assert.equal(result.content[0].text, 'first');
    assert.equal(spawns(), 2, 'the first LCU tool call starts the host');
    assert.deepEqual(second.registrations, ['js', 'js_reset'], 'an unchanged surface is not registered again');
    await second.handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, second.ctx);
    assert.equal(second.notes.length, 0);
  });
});

test('a surface learned for one account is not served to another account in the same process', { skip }, async () => {
  await withCache(async ({ home, spawns, session }) => {
    const other = mkdtempSync(join(homedir(), '.lcu-pi-surface-'));
    try {
      await session().prompt();
      assert.equal(spawns(), 1);
      process.env.HOME = other;
      process.env.USERPROFILE = other;
      process.env.XDG_CACHE_HOME = join(other, '.cache');
      await session().prompt();
      assert.equal(spawns(), 2, 'another account must connect; the in-memory map is not a cross-account hit');
      assert.equal(existsSync(cacheFile(other)), true, 'the second account writes its own cache file');
      assert.equal(existsSync(cacheFile(home)), true, 'the first account keeps its own cache file');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

test('Pi uses the cache file after the in-memory copy is cleared and starts the host only for a tool call', { skip }, async () => {
  await withCache(async ({ home, spawns, session }) => {
    const first = session();
    const firstPrompt = await first.prompt();
    await first.handlers.get('session_shutdown')();
    memory().clear(); // only the file remains

    const second = session();
    assert.equal(await second.prompt(), firstPrompt);
    assert.equal(second.definitions(), first.definitions());
    assert.equal(spawns(), 1);
    await second.handlers.get('agent_start')({}, second.ctx);
    const result = await second.tools.get('js_reset').execute('surface-reset', {}, undefined, undefined, second.ctx);
    assert.equal(result.content[0].text, 'js_reset');
    assert.equal(spawns(), 2);

    const record = JSON.parse(readFileSync(cacheFile(home), 'utf8'));
    const entries = Object.values(record);
    assert.equal(entries.length, 1);
    assert.equal(entries.length, 1);
    assert.deepEqual(Object.keys(entries[0]), ['tools', 'instructions']);
    assert.deepEqual(entries[0].tools.map(tool => Object.keys(tool)), [
      ['name', 'description', 'inputSchema'], ['name', 'description', 'inputSchema']]);
    assert.equal(readFileSync(cacheFile(home), 'utf8').includes(home), false,
      'the file keeps no command, path or environment value');
  });
});

test('Pi keeps its cache file beside update.json and leaves the shared cache directory mode unchanged', { skip }, async () => {
  await withCache(async ({ home, session }) => {
    mkdirSync(sharedCache(home), { recursive: true });
    chmodSync(sharedCache(home), 0o755);
    writeFileSync(join(sharedCache(home), 'update.json'), '{}');
    await session().prompt();
    assert.equal(statSync(sharedCache(home)).mode & 0o777, 0o755, 'the shared directory keeps its mode');
    const names = readdirSync(sharedCache(home)).sort();
    assert.ok(names.includes('pi-surfaces.json'));
    assert.ok(names.includes('update.json'));
    assert.equal(names.includes('pi-surfaces'), false, 'no private cache directory');
    assert.equal(statSync(cacheFile(home)).mode & 0o777, 0o600);
  });
});

test('Pi connects in before_agent_start when no surface is known, or when the cache is turned off', { skip }, async () => {
  await withCache(async ({ spawns, session }) => {
    const first = session();
    assert.match(await first.prompt(), /Original CUA initialization guide/);
    assert.equal(spawns(), 1);
    assert.deepEqual(first.registrations, ['js', 'js_reset']);
    await first.handlers.get('session_shutdown')();

    process.env.LCU_SURFACE_CACHE = '0';
    const second = session();
    assert.match(await second.prompt(), /Original CUA initialization guide/);
    assert.equal(spawns(), 2, 'LCU_SURFACE_CACHE=0 connects in every session');
  });
});

test('Pi resolves a command name on PATH and misses when PATH selects another release', { skip }, async () => {
  await withCache(async ({ home, started, session }) => {
    const first = release(home, 'a', { app: '1.0', runtime: '0.0.1/a' });
    const other = release(home, 'b', { app: '2.0', runtime: '0.0.2/b' });
    const path = saved => `${join(saved, 'bin')}${delimiter}${process.env.PATH}`;

    process.env.PATH = path(first);
    const warm = session();
    const livePrompt = await warm.prompt();
    assert.equal(started(), 'a');
    await warm.handlers.get('session_shutdown')();
    const known = session();
    assert.equal(await known.prompt(), livePrompt);
    assert.equal(started(), 'a', 'the same release on PATH: known');
    assert.ok(existsSync(cacheFile(home)));

    // Another release earlier on PATH, as after an install that puts a newer `lcu` first.
    process.env.PATH = `${join(other, 'bin')}${delimiter}${path(first)}`;
    const moved = session();
    assert.equal(await moved.prompt(), livePrompt);
    assert.equal(started(), 'ab', 'PATH now selects another release: a miss that connects to that release');
  }, { command: ['lcu'] });
});

test('Pi never caches a command whose LCU release and versions cannot be identified', { skip }, async () => {
  for (const command of [countingHost, ['lcu-not-on-path']]) {
    await withCache(async ({ home, spawns, session }) => {
      const first = session();
      const second = session();
      if (command === countingHost) {
        await first.prompt();
        await first.handlers.get('session_shutdown')();
        await second.prompt();
        assert.equal(spawns(), 2, 'each session connects in before_agent_start');
      } else {
        await assert.rejects(first.prompt(), /ENOENT|spawn/);
        await assert.rejects(second.prompt(), /ENOENT|spawn/);
      }
      assert.equal(memory().size, 0, 'nothing is kept in memory');
      assert.equal(existsSync(sharedCache(home)), false, 'nothing is written to the cache directory');
    }, { command });
  }
});

test('Pi treats a corrupt cache file or an entry without exactly js and js_reset as a miss', { skip }, async () => {
  await withCache(async ({ home, spawns, session }) => {
    const first = session();
    const livePrompt = await first.prompt();
    await first.handlers.get('session_shutdown')();
    const valid = JSON.parse(readFileSync(cacheFile(home), 'utf8'));
    const [key] = Object.keys(valid);
    const live = valid[key];
    const [js, reset] = live.tools;
    const extra = { name: 'turn_ended', description: 'Internal.', inputSchema: { type: 'object' } };
    const variants = [
      ['corrupt JSON', '{"format":1,"entries":'],
      ['wrong types', { tools: 'js', instructions: 1 }],
      ['missing js_reset', { ...live, tools: [js] }],
      ['extra tool', { ...live, tools: [js, reset, extra] }],
      ['duplicate js', { ...live, tools: [js, js] }],
      ['schema not an object', { ...live, tools: [js, { ...reset, inputSchema: [] }] }],
      ['no instructions', { tools: live.tools }],
    ];
    let expected = 1;
    for (const [label, entry] of variants) {
      writeFileSync(cacheFile(home), typeof entry === 'string' ? entry
        : JSON.stringify({ [key]: entry }));
      memory().clear();
      const next = session();
      assert.equal(await next.prompt(), livePrompt, label);
      assert.equal(spawns(), ++expected, `${label}: connects in before_agent_start`);
      assert.deepEqual(next.registrations, ['js', 'js_reset'], label);
      assert.deepEqual(JSON.parse(readFileSync(cacheFile(home), 'utf8'))[key], live,
        `${label}: the connect rewrites the entry`);
      await next.handlers.get('session_shutdown')();
    }
  });
});

test('Pi replaces a cached surface that the host no longer reports and logs only metadata', { skip }, async () => {
  await withCache(async ({ home, spawns, session }) => {
    const first = session();
    const livePrompt = await first.prompt();
    const liveDefinitions = first.definitions();
    await first.handlers.get('session_shutdown')();
    const record = JSON.parse(readFileSync(cacheFile(home), 'utf8'));
    const [key] = Object.keys(record);
    record[key].tools[0].description = 'Stale JS description.';
    record[key].instructions = 'Stale guide.';
    writeFileSync(cacheFile(home), JSON.stringify(record));
    memory().clear();
    const logs = join(home, 'logs');
    delete process.env.LCU_DIAGNOSTIC_LOG;
    process.env.LCU_LOG_DIR = logs;

    const second = session();
    assert.equal(await second.prompt(), 'Existing append\n\nStale guide.');
    assert.equal(second.tools.get('js').description, 'Stale JS description.');
    assert.equal(spawns(), 1);
    await second.handlers.get('agent_start')({}, second.ctx);
    const result = await second.tools.get('js').execute('surface-changed', { code: 'still served' },
      undefined, undefined, second.ctx);
    assert.equal(result.content[0].text, 'still served');
    assert.equal(spawns(), 2);
    assert.equal(second.definitions(), liveDefinitions, 'the live tools replace the stale ones');
    assert.equal(await second.prompt(), livePrompt, 'the next before_agent_start uses the live instructions');

    const stored = JSON.parse(readFileSync(cacheFile(home), 'utf8'))[key];
    assert.equal(stored.instructions, 'Original CUA initialization guide.');
    assert.equal(stored.tools[0].description, 'Original JS description.');
    memory().clear();
    const third = session();
    assert.equal(await third.prompt(), livePrompt);
    assert.equal(spawns(), 2);

    const [logName] = readdirSync(logs).filter(name => name.startsWith('pi-'));
    const text = readFileSync(join(logs, logName), 'utf8');
    const events = text.trim().split('\n').map(JSON.parse).filter(entry => entry.event === 'surface_changed');
    assert.equal(events.length, 1);
    const { t: _time, ...event } = events[0];
    assert.deepEqual(event, { event: 'surface_changed', tools_changed: true, instructions_changed: true });
    assert.doesNotMatch(text, /Stale|Original JS description|initialization guide/);
  });
});

test('Pi rejects the first tool call cleanly when a known surface\'s host fails to start', { skip }, async () => {
  await withCache(async ({ home, session }) => {
    // The launcher's size and mtime are in the key: keep both so the surface stays known.
    const lcu = join(home, 'r', 'bin', 'lcu');
    utimesSync(lcu, 1e6, 1e6);
    await session().prompt();
    writeFileSync(lcu, '#!/bin/sh\nexit 1\n'.padEnd(statSync(lcu).size));
    utimesSync(lcu, 1e6, 1e6);

    const known = session();
    assert.match(await known.prompt(), /Original CUA initialization guide/);
    await known.handlers.get('agent_start')({}, known.ctx);
    await assert.rejects(known.tools.get('js').execute('surface-fail', { code: 'x' }, undefined, undefined, known.ctx));
    await known.handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, known.ctx);
    await known.handlers.get('session_shutdown')();
  });
});

test('Pi starts no host for agent_end or /lcu stop when no LCU tool ran', { skip }, async () => {
  await withCache(async ({ spawns, session }) => {
    const first = session();
    await first.prompt();
    await first.handlers.get('session_shutdown')();

    const second = session();
    await second.prompt();
    await second.handlers.get('agent_start')({}, second.ctx);
    await second.commands.get('lcu').handler('stop', second.ctx);
    assert.deepEqual(second.notes, [{ message: 'No active Computer Use app is available to stop.', type: 'info' }]);
    await second.handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, second.ctx);
    await second.handlers.get('session_shutdown')();
    assert.equal(second.notes.length, 1, 'no cleanup warning');
    assert.equal(spawns(), 1);
  });
});

test('OMP uses its own cache entry and does not connect at load when that entry is known', { skip }, async () => {
  await withCache(async ({ home, spawns, session }) => {
    const pi = session();
    await pi.prompt();
    await pi.handlers.get('session_shutdown')();
    assert.equal(spawns(), 1);
    const piRecord = readFileSync(cacheFile(home), 'utf8');

    const omp = { connectOnLoad: true, ompEssentialTools: true };
    const first = session(piExtension, omp);
    await first.loaded;
    assert.equal(spawns(), 2, 'a Pi entry is not an OMP hit, so OMP connects at load');
    assert.deepEqual(first.registrations, ['js', 'js_reset']);
    assert.ok([...first.tools.values()].every(tool => tool.loadMode === 'essential'));
    const prompt = await first.handlers.get('before_agent_start')({ systemPrompt: ['OMP rules'] }, first.ctx);
    assert.deepEqual(prompt.systemPrompt, ['OMP rules', 'Original CUA initialization guide.']);
    assert.equal(spawns(), 2, 'before_agent_start does not connect again');
    await first.handlers.get('session_shutdown')();
    assert.notEqual(readFileSync(cacheFile(home), 'utf8'), piRecord, 'OMP writes its own entry');

    memory().clear();
    const second = session(piExtension, omp);
    await second.loaded;
    assert.equal(spawns(), 2, 'the OMP cache file is a hit: no connect at load');
    assert.deepEqual(second.registrations, ['js', 'js_reset']);
    assert.ok([...second.tools.values()].every(tool => tool.loadMode === 'essential'));
    const again = await second.handlers.get('before_agent_start')({ systemPrompt: ['OMP rules'] }, second.ctx);
    assert.deepEqual(again.systemPrompt, ['OMP rules', 'Original CUA initialization guide.']);
    assert.equal(spawns(), 2);
    await second.handlers.get('session_shutdown')();

    memory().clear();
    await session().prompt();
    assert.equal(spawns(), 2, 'Pi still hits its own entry');
  });
});

test('Pi keys the surface on the app and CUA runtime versions of an installed release', { skip }, async () => {
  await withCache(async ({ home, spawns, session }) => {
    const root = join(home, 'r');
    const first = session();
    const livePrompt = await first.prompt();
    assert.equal(spawns(), 1);
    const second = session();
    assert.equal(await second.prompt(), livePrompt);
    assert.equal(spawns(), 1, 'same release, app and runtime: known');

    setVersions(root, { app: '1.0', runtime: '0.0.2/b' });
    const third = session();
    assert.equal(await third.prompt(), livePrompt);
    assert.equal(spawns(), 2, 'a new CUA runtime version is a miss');

    if (process.platform === 'darwin') {
      setVersions(root, { app: '2.0', runtime: '0.0.2/b' });
      await session().prompt();
      assert.equal(spawns(), 3, 'a new app version is a miss');
    }
    const before = spawns();
    rmSync(join(resources(root), 'cua_node', 'manifest.json'));
    await session().prompt();
    await session().prompt();
    assert.equal(spawns(), before + 2, 'a release whose runtime version cannot be read is never cached');
  });
});


/**
 * A copy of this adapter inside a fake release, with the modules it imports. A second evaluation:
 * Node treats the new file URL as a new module.
 */
function installedAdapter(root) {
  const adapters = join(root, 'adapters');
  mkdirSync(join(adapters, 'pi'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('../pi/index.ts', import.meta.url)), join(adapters, 'pi', 'index.ts'));
  writeFileSync(join(adapters, 'package.json'), '{"type":"module"}');
  for (const name of ['client.mjs', 'audio-files.mjs', 'diagnostics.mjs', 'host-guard.mjs', 'node_modules']) {
    symlinkSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(adapters, name));
  }
  for (const name of ['check_record.mjs', 'fsutil.mjs', 'lock.mjs']) {
    const target = join(root, 'lcu', name);
    if (existsSync(target)) rmSync(target);
    symlinkSync(fileURLToPath(new URL(`../../lcu/${name}`, import.meta.url)), target);
  }
  return new URL(`file://${join(adapters, 'pi', 'index.ts')}`).href;
}

/** Two Pi sessions with this command or options: the second must start no host before a tool call. */
async function expectCached({ session, spawns }, options, extension = piExtension) {
  const first = session(extension, options);
  const livePrompt = await first.prompt();
  assert.equal(spawns(), 1, 'the first session connects in before_agent_start');
  await first.handlers.get('session_shutdown')();
  const second = session(extension, options);
  assert.equal(await second.prompt(), livePrompt);
  assert.equal(spawns(), 1, 'the second session is a cache hit');
  await second.handlers.get('session_shutdown')();
  memory().clear();
  const third = session(extension, options);
  assert.equal(await third.prompt(), livePrompt);
  assert.equal(spawns(), 1, 'the cache file alone is a hit');
  await third.handlers.get('agent_start')({}, third.ctx);
  const result = await third.tools.get('js').execute('form-call', { code: 'form' }, undefined, undefined, third.ctx);
  assert.equal(result.content[0].text, 'form');
  assert.equal(spawns(), 2, 'the first LCU tool call starts the host');
}

/** An installed prefix as `lcu setup` leaves it: `current` links to a release under `releases/`. */
function prefix(home) {
  release(home, 'prefix/releases/0.0.0-test', undefined, 'r');
  symlinkSync('releases/0.0.0-test', join(home, 'prefix', 'current'));
  return join(home, 'prefix', 'current');
}

test('Pi caches the direct form lcu setup writes: <prefix>/current/bin/lcu with runtime flags', { skip }, async () => {
  await withCache(async context => {
    const current = prefix(context.home);
    await expectCached(context, { command: [join(current, 'bin', 'lcu'), '--chrome', '--audio'] });
  }, { command: null });
});

test('Pi caches the desktop-session form lcu setup writes: lcu-session --user ACCOUNT -- lcu', { skip }, async () => {
  await withCache(async context => {
    const current = prefix(context.home);
    await expectCached(context, { command: [join(current, 'bin', 'lcu-session'), '--user', userInfo().username, '--',
      join(current, 'bin', 'lcu'), '--chrome'] });
  }, { command: null });
});

test('Pi caches lcu-session with --user=ACCOUNT and an LCU command found on PATH', { skip }, async () => {
  await withCache(async context => {
    const root = release(context.home, 'r');
    process.env.PATH = `${join(root, 'bin')}${delimiter}${process.env.PATH}`;
    await expectCached(context, undefined);
  }, { command: ['lcu-session', `--user=${userInfo().username}`, '--', 'lcu'] });
});

test('Pi caches relative launcher paths against the working directory the transport uses', { skip }, async () => {
  for (const command of [['./r/bin/lcu'], ['./r/bin/lcu-session', '--user', 'account', '--', './r/bin/lcu']]) {
    await withCache(async context => {
      release(context.home, 'r');
      process.chdir(context.home);
      await expectCached(context, undefined);
    }, { command });
  }
});

test('Pi caches the default command it runs when LCU_MCP_COMMAND and setup select none', { skip }, async () => {
  await withCache(async context => {
    // A release that holds this adapter: its default is the release's own bin/lcu on macOS and
    // `bin/lcu-session --user <account> -- bin/lcu` on Linux.
    const root = release(context.home, 'r');
    const { default: installed } = await import(installedAdapter(root));
    await expectCached(context, undefined, installed);
  }, { command: null });
});

test('Pi never caches a wrapper that starts another release from another working directory', { skip }, async () => {
  // Pi's working directory holds release A at ./r; the wrapper starts ./r/bin/lcu from another directory
  // that holds release B. Only release B ever runs.
  await withCache(async ({ home, started, session }) => {
    release(home, 'one/r', undefined, 'A');
    const other = release(home, 'two/r', undefined, 'B');
    process.chdir(join(home, 'one'));
    const first = session();
    await first.prompt();
    assert.equal(started(), 'B');
    await first.handlers.get('session_shutdown')();
    setVersions(other, { app: '1.0', runtime: '0.0.2/b' });
    await session().prompt();
    assert.equal(started(), 'BB', 'each session connects in before_agent_start');
    assert.equal(memory().size, 0, 'nothing is kept in memory');
    assert.equal(existsSync(sharedCache(home)), false, 'nothing is written to the cache directory');
  }, { command: home => [process.execPath, '-e',
    'const child = require("node:child_process").spawn(process.argv[1], ' +
    '{ cwd: ' + JSON.stringify(join(home, 'two')) + ', stdio: "inherit" });' +
    'const stop = () => child.kill(); process.on("SIGTERM", stop); process.on("SIGINT", stop);' +
    'child.on("exit", code => process.exit(code ?? 1));',
  './r/bin/lcu'] });
});

test('Pi never caches env, shell or other wrappers, inside lcu-session or not', { skip }, async () => {
  const launcher = home => join(home, 'r', 'bin', 'lcu');
  const session = home => join(home, 'r', 'bin', 'lcu-session');
  for (const command of [
    home => ['/usr/bin/env', launcher(home)],
    home => ['/bin/sh', launcher(home)],
    home => [session(home), '--user', 'account', '--', '/bin/sh', launcher(home)],
    home => [session(home), '--user', 'account', launcher(home)],
  ]) {
    await withCache(async ({ home, spawns, session: made }) => {
      release(home, 'r');
      for (const expected of [1, 2]) {
        const next = made();
        await next.prompt();
        assert.equal(spawns(), expected, `${command(home).slice(0, 2).join(' ')}: connects in every session`);
        await next.handlers.get('session_shutdown')();
      }
      assert.equal(memory().size, 0);
      assert.equal(existsSync(sharedCache(home)), false);
    }, { command });
  }
});

test('the surface key includes the launch command, enabled surfaces, platform and Pi or OMP', { skip }, async () => {
  await withCache(async ({ home }) => {
    const command = [join(home, 'r', 'bin', 'lcu')];
    const base = surfaceKey(command, [], 'pi');
    assert.equal(typeof base, 'string');
    assert.notEqual(surfaceKey([...command, '--chrome'], [], 'pi'), base, '--chrome is part of the key');
    const saved = process.env.CUA_REPL_ENABLED_SURFACES;
    process.env.CUA_REPL_ENABLED_SURFACES = 'browser';
    try {
      assert.notEqual(surfaceKey(command, [], 'pi'), base, 'CUA_REPL_ENABLED_SURFACES is part of the key');
    } finally {
      if (saved === undefined) delete process.env.CUA_REPL_ENABLED_SURFACES;
      else process.env.CUA_REPL_ENABLED_SURFACES = saved;
    }
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...platform, value: process.platform === 'linux' ? 'darwin' : 'linux' });
    try {
      assert.notEqual(surfaceKey(command, [], 'pi'), base, 'platform is part of the key');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    assert.notEqual(surfaceKey(command, [], 'omp'), base, 'Pi and OMP do not share a key');
    const sessionLauncher = join(home, 'r', 'bin', 'lcu-session');
    assert.notEqual(
      surfaceKey([sessionLauncher, '--user', 'alice', '--', command[0]], [], 'pi'),
      surfaceKey([sessionLauncher, '--user', 'bob', '--', command[0]], [], 'pi'),
      '--user is part of the launch command, so two accounts do not share a key');
    const savedHome = process.env.HOME;
    const savedCache = process.env.XDG_CACHE_HOME;
    const other = mkdtempSync(join(homedir(), '.lcu-pi-surface-'));
    // Linux cacheDirectory() follows XDG_CACHE_HOME. macOS follows HOME. Change both.
    process.env.HOME = other;
    process.env.USERPROFILE = other;
    process.env.XDG_CACHE_HOME = join(other, '.cache');
    try {
      assert.notEqual(surfaceKey(command, [], 'pi'), base, 'the per-account cache directory is part of the key');
    } finally {
      process.env.HOME = savedHome;
      process.env.USERPROFILE = savedHome;
      if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = savedCache;
      rmSync(other, { recursive: true, force: true });
    }
    assert.equal(surfaceKey(command, [], 'pi'), base);
  });
});

test('a subagent child shares the in-memory surface, including a second evaluation of the adapter', { skip }, async () => {
  await withCache(async ({ home, spawns, session }) => {
    const first = session();
    const livePrompt = await first.prompt();
    await first.handlers.get('session_shutdown')();
    rmSync(cacheFile(home));
    const child = session();
    assert.equal(await child.prompt(), livePrompt);
    assert.equal(spawns(), 1, 'a later session in this evaluation shares the module-scope map');
    await child.handlers.get('session_shutdown')();

    const { default: copy } = await import(installedAdapter(join(home, 'r')));
    const reloaded = session(copy);
    assert.equal(await reloaded.prompt(), livePrompt);
    assert.equal(spawns(), 1, 'a second evaluation binds the same globalThis map');
  });
});

test('Pi keeps at most 8 entries in the cache file and drops the oldest', { skip }, async () => {
  await withCache(async ({ home, session }) => {
    const surface = { tools: [{ name: 'js', description: 'J.', inputSchema: { type: 'object' } },
      { name: 'js_reset', description: 'R.', inputSchema: { type: 'object' } }], instructions: 'I.' };
    const old = Array.from({ length: 8 }, (_, index) => `old-${index}`);
    mkdirSync(dirname(cacheFile(home)), { recursive: true, mode: 0o700 });
    writeFileSync(cacheFile(home), JSON.stringify(Object.fromEntries(old.map(key => [key, surface]))));
    await session().prompt();
    const keys = Object.keys(JSON.parse(readFileSync(cacheFile(home), 'utf8')));
    assert.equal(keys.length, 8);
    assert.deepEqual(keys.slice(0, 7), old.slice(1), 'the oldest entry is dropped');
    assert.equal(old.includes(keys[7]), false, 'the new entry is last');
  });
});

test('Pi serves the session when it cannot write the cache file', { skip }, async () => {
  const failures = [
    ['pi-surfaces.json is a directory', home => mkdirSync(cacheFile(home), { recursive: true })],
    ...(process.getuid?.() === 0 ? [] : [['the shared cache directory is read-only', home => {
      mkdirSync(sharedCache(home), { recursive: true });
      chmodSync(sharedCache(home), 0o555);
    }]]),
  ];
  for (const [label, prepare] of failures) {
    await withCache(async ({ home, spawns, session }) => {
      prepare(home);
      try {
        const first = session();
        const livePrompt = await first.prompt();
        assert.equal(spawns(), 1, label);
        await first.handlers.get('agent_start')({}, first.ctx);
        const result = await first.tools.get('js').execute('write-failed', { code: 'served' }, undefined, undefined, first.ctx);
        assert.equal(result.content[0].text, 'served', label);
        await first.handlers.get('session_shutdown')();
        const second = session();
        assert.equal(await second.prompt(), livePrompt, `${label}: the process still knows the surface`);
        assert.equal(spawns(), 1, label);
        memory().clear();
        await session().prompt();
        assert.equal(spawns(), 2, `${label}: without a file the next process connects as before`);
        const directory = dirname(cacheFile(home));
        if (existsSync(directory)) {
          assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.tmp')), [], `${label}: no temporary file is left`);
        }
      } finally {
        chmodSync(sharedCache(home), 0o755);
      }
    });
  }
});

// Narrow bypass regression: it fakes process.platform after the adapter and its dependencies were imported,
// so it checks the adapter's own Windows check, not Windows behavior. The child process keeps the change
// away from the other tests.
const windowsChild = 'Pi does not use or write the cache when process.platform is win32 (child process)';
if (process.env.LCU_TEST_WINDOWS_CHILD === '1') {
  test(windowsChild, async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    await withCache(async ({ home, spawns, session }) => {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      try {
        for (const expected of [1, 2]) {
          const made = session();
          assert.match(await made.prompt(), /Original CUA initialization guide/);
          assert.equal(spawns(), expected, 'every session connects in before_agent_start');
          await made.handlers.get('session_shutdown')();
        }
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
      assert.equal(memory().size, 0);
      assert.deepEqual(readdirSync(home).filter(name => !['mcp.jsonl', 'r', 'spawns'].includes(name)), [],
        'no cache directory is created');
    });
  });
} else {
  test('Pi does not use or write the cache on Windows (platform check, in a child process)', { skip }, () => {
    const preload = fileURLToPath(new URL('./no-diagnostic-log.mjs', import.meta.url));
    const child = spawnSync(process.execPath, ['--import', preload, '--test-reporter=tap',
      `--test-name-pattern=^${windowsChild.replace(/[()]/g, '\\$&')}$`, fileURLToPath(import.meta.url)], {
      env: { ...process.env, LCU_TEST_WINDOWS_CHILD: '1', NODE_TEST_CONTEXT: undefined }, encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /^# pass 1$/m);
    assert.match(child.stdout, /^# fail 0$/m);
  });
}
