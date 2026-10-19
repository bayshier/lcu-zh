// Codex lifecycle hooks (codex_hooks.mjs) and the app-server client (app_server.mjs).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppServer, AppServerRequestError, withAppServer } from '../../lcu/app_server.mjs';
import * as hooks from '../../lcu/codex_hooks.mjs';
import * as setup from '../../lcu/setup.mjs';
import { parse as parseToml } from '../../lcu/toml.mjs';
import { override, posixTests, result, temporary, write } from './fixtures.mjs';

const test = posixTests('the fake Codex CLI is an sh script');

test('the update-notice hooks run the stable command, quoted for each shell', () => {
  const group = hooks.noticeHook('/a b/current/bin/lcu');
  const [hook] = group.hooks;
  assert.equal(hook.type, 'command');
  assert.equal(hook.command, "'/a b/current/bin/lcu' update --notice --hook SessionStart");
  assert.equal(hook.commandWindows, '"/a b/current/bin/lcu" update --notice --hook SessionStart');
  assert.deepEqual([group.matcher, hook.timeout, hook.statusMessage], ['startup|resume', 10, 'Checking for LCU updates']);
  const prompt = hooks.noticeHook('/a b/current/bin/lcu', 'UserPromptSubmit');
  assert.ok(!('matcher' in prompt));
  assert.equal(prompt.hooks[0].command, "'/a b/current/bin/lcu' update --notice --hook UserPromptSubmit");
  assert.equal(prompt.hooks[0].timeout, 5);
  assert.ok(!('statusMessage' in prompt.hooks[0]));
});

test('only LCU notice groups are recognized as LCU\'s own', () => {
  assert.ok(hooks.isNoticeGroup(hooks.noticeHook('/x/current/bin/lcu')));
  assert.ok(hooks.isNoticeGroup(hooks.noticeHook('/x y/lcu')));
  assert.ok(hooks.isNoticeGroup(hooks.noticeHook('/x/lcu.cmd', 'UserPromptSubmit')));
  assert.ok(hooks.isNoticeGroup(hooks.noticeHook('/x/lcu', 'UserPromptSubmit'), 'UserPromptSubmit'));
  assert.ok(!hooks.isNoticeGroup(hooks.noticeHook('/x/lcu', 'UserPromptSubmit'), 'SessionStart'));
  for (const other of [{ hooks: [{ type: 'command', command: 'echo hi' }] },
    { hooks: [{ type: 'command', command: '/x/other update --notice --hook SessionStart' }] },
    { hooks: [{ type: 'command', command: '/x/lcu update --notice --hook-json' }] },
    { hooks: [{ type: 'command', command: '/x/lcu update --notice --hook Stop' }] },
    { hooks: [{ type: 'command', command: "'/x/lcu update --notice --hook SessionStart" }] },
    { hooks: [{ type: 'mcp_tool', server: 'lcu', tool: 'turn_ended' }] }, { hooks: [] }]) {
    assert.ok(!hooks.isNoticeGroup(other), JSON.stringify(other));
  }
});

test('CODEX_HOME is selected as the CLI does; an empty one is refused', (t) => {
  assert.equal(hooks.selectedCodexHome({ HOME: '/home/a' }), '/home/a/.codex');
  assert.equal(hooks.selectedCodexHome({ HOME: '/home/a', CODEX_HOME: '/custom' }), '/custom');
  assert.throws(() => hooks.selectedCodexHome({ HOME: '/home/a', CODEX_HOME: '' }), /set but empty/);
  assert.throws(() => hooks.requireCliHookSupport({ CODEX_HOME: '' }), /set but empty/);
});

test('a missing Codex CLI keeps setup available; an unsupported one fails with an isolated probe', (t) => {
  const calls = [];
  override(t, setup.seams, 'which', () => null);
  override(t, setup.seams, 'run', (...args) => calls.push(args));
  hooks.requireCliHookSupport({ PATH: '/bin', HOME: '/home/a' });
  assert.deepEqual(calls, []);
  override(t, setup.seams, 'which', () => '/fixture/bin/codex');
  override(t, setup.seams, 'run', (command, args, options) => {
    calls.push([command, args, options]);
    assert.deepEqual(Object.keys(options.env).sort(), ['CODEX_HOME', 'HOME', 'PATH', 'SystemRoot']);
    assert.equal(options.env.HOME, options.cwd);
    assert.match(readFileSync(join(options.cwd, 'config.toml'), 'utf8'), /type = "mcp_tool"/);
    return args[0] === '--version' ? result(0, 'codex-cli 0.1.0\n') : result(1, '', 'unknown variant `mcp_tool`\n  at line 2');
  });
  assert.throws(() => hooks.requireCliHookSupport({ PATH: '/bin', HOME: '/home/a', SECRET: 'x', SystemRoot: 'C:\\Windows' }),
    /Installed Codex CLI \/fixture\/bin\/codex \(codex-cli 0\.1\.0\) cannot load the original MCP lifecycle hooks\. Codex reported: unknown variant `mcp_tool` at line 2\./);
  assert.deepEqual(calls.map(([, args]) => args), [['--version'], ['mcp', 'list']]);
});

function hostPlugin(root) {
  const plugin = join(root, 'plugins/unified-computer-use');
  const hook = (event) => [{ hooks: [{ type: 'mcp_tool', server: 'cua_repl', tool: 'turn_ended', input: { hook_event_name: event, session_id: '${session_id}' } }] }];
  write(join(plugin, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'unified-computer-use', description: 'original',
    hooks: { hooks: { Stop: hook('Stop'), Interrupt: hook('Interrupt'), SubagentStop: hook('SubagentStop') } } }));
  write(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: { type: 'stdio', command: 'node', args: ['x'], startup_timeout_sec: 120 } } }));
  return root;
}

test('the original hooks are readdressed to LCU and the export mirrors the original plugin', (t) => {
  const root = hostPlugin(temporary(t));
  const events = hooks.originalHooks(root);
  assert.deepEqual(Object.keys(events), ['Stop', 'Interrupt', 'SubagentStop']);
  assert.ok(Object.values(events).flat().flatMap((group) => group.hooks).every((hook) => hook.server === 'lcu'));
  const files = hooks.exportFiles(['/bin/sh', '-c', 'x'], root);
  const manifest = JSON.parse(files['.codex-plugin/plugin.json']);
  assert.deepEqual([manifest.name, manifest.hooks.hooks.Stop[0].hooks[0].server], ['lcu', 'lcu']);
  assert.deepEqual(JSON.parse(files['.mcp.json']).mcpServers, { lcu: { type: 'stdio', command: '/bin/sh', args: ['-c', 'x'], startup_timeout_sec: 120, enabled: true } });
  assert.deepEqual(JSON.parse(files['lifecycle-contract.json']).hooks, manifest.hooks.hooks);
  const plugin = join(root, 'plugins/unified-computer-use/.codex-plugin/plugin.json');
  writeFileSync(plugin, readFileSync(plugin, 'utf8').replaceAll('cua_repl', 'other'));
  assert.throws(() => hooks.originalHooks(root), /lifecycle contract changed/);
});

// A real Codex CLI installs the hooks through its own config writer; run only where one is installed.
const codex = setup.which('codex');
test('installing the hooks is trusted, idempotent and removable', { skip: !codex && 'no Codex CLI on PATH' }, async (t) => {
  const root = hostPlugin(temporary(t));
  const home = join(root, 'home');
  mkdirSync(home);
  const config = write(join(home, 'config.toml'), '[hooks]\nSessionStart = [{ hooks = [{ type = "command", command = "echo mine" }] }]\n');
  const env = { ...process.env, HOME: home, CODEX_HOME: home };
  const install = (notice) => hooks.installHooks(codex, config, root, env, root, notice);
  await install('/p/current/bin/lcu');
  const first = readFileSync(config);
  const data = parseToml(first.toString());
  assert.equal(data.hooks.SessionStart[0].hooks[0].command, 'echo mine');
  assert.equal(data.hooks.SessionStart.filter((group) => hooks.isNoticeGroup(group)).length, 1);
  assert.equal(Object.keys(data.hooks.state).length, 5);
  await install('/p/current/bin/lcu');
  assert.ok(readFileSync(config).equals(first));
  await install(null);
  assert.deepEqual(parseToml(readFileSync(config, 'utf8')).hooks.SessionStart.map((group) => group.hooks[0].command), ['echo mine']);
});

const SERVER = String.raw`
const readline = await import('node:readline');
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: { ok: true } }));
  else if (message.method === 'ask') {
    console.log(JSON.stringify({ method: 'note', params: {} }));
    console.log(JSON.stringify({ id: 'server-1', method: 'question', params: {} }));
  } else if (message.id === 'server-1') console.log(JSON.stringify({ id: 1000, result: message }));
  else if (message.method === 'echo') console.log(JSON.stringify({ id: message.id, result: message.params }));
  else if (message.method === 'fail') console.log(JSON.stringify({ id: message.id, error: { code: 1, message: 'refused' } }));
  else if (message.method === 'exit') process.exit(0);
}
`;

test('the app-server client matches replies, answers server requests, and tells timeouts from a lost server', async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
  const notes = [];
  const server = await new AppServer(child, { onNotification: (message) => notes.push(message.method) }).initialize();
  assert.deepEqual(server.initialization, { ok: true });
  const [a, b] = await Promise.all([server.call('echo', { n: 1 }), server.call('echo', { n: 2 })]);
  assert.deepEqual([a, b], [{ n: 1 }, { n: 2 }]);
  await assert.rejects(server.call('fail', {}), (error) => error instanceof AppServerRequestError && error.message === 'refused');
  await assert.rejects(server.call('silent', {}, { timeout: 100 }), /timed out: silent/);
  server.send({ id: 99, method: 'ask' });
  await new Promise((done) => setTimeout(done, 200));
  assert.deepEqual(notes, ['note']);
  const pending = server.call('never', {});
  server.send({ method: 'exit' });
  await assert.rejects(pending, /exited unexpectedly/);
  await server.close();
});

test('an app-server that cannot start fails initialize, and cleanup returns at once', async (t) => {
  const missing = join(temporary(t), 'no-such-codex');
  const started = Date.now();
  await assert.rejects(withAppServer(missing, temporary(t), process.env, () => assert.fail('ran without a server')), /ENOENT/);
  // Closed before the failed start is even reported: no `exit` event ever comes.
  const server = new AppServer(spawn(missing, [], { stdio: ['pipe', 'pipe', 'ignore'] }));
  const initializing = assert.rejects(server.initialize(), /ENOENT/);
  await server.close();
  await initializing;
  assert.ok(Date.now() - started < 2000, `cleanup took ${Date.now() - started} ms`);
});
