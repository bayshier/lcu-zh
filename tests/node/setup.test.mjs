import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AppsError } from '../../lcu/apps.mjs';
import { question } from '../../lcu/cross_turn.mjs';
import * as setup from '../../lcu/setup.mjs';
import { REPO, output, override, posixTests, result, temporary, write } from './fixtures.mjs';

const test = posixTests('Linux/macOS setup (POSIX accounts with uid/gid, sh launchers)');

const ALL = ['pi', 'codex', 'claude-code', 'omp', 'hermes'];
const executable = (path) => write(path, '#!/bin/sh\nexit 0\n', 0o755);

/** A prefix with launchers and agent tools, an account home, and stubbed registration. */
function fixture(t) {
  const root = temporary(t);
  const prefix = join(root, 'prefix');
  const home = join(root, 'home');
  mkdirSync(home);
  for (const name of ['current/bin/lcu', 'current/bin/lcu-session', 'current/agent-tools/node/bin/node']) executable(join(prefix, name));
  for (const name of ['current/agent-tools/node_modules/skills/bin/cli.mjs', 'current/agent-tools/node_modules/add-mcp/dist/index.js']) write(join(prefix, name));
  const state = { installed: new Set(), failing: new Set(), registered: [], spawned: [], root, prefix, home };
  const account = { name: 'fixture', uid: process.getuid(), gid: process.getgid(), home };
  override(t, setup.seams, 'account', () => account);
  override(t, setup.seams, 'interactive', () => false);
  override(t, setup.seams, 'which', (name) => ([...state.installed].some((client) => setup.CLIENTS[client].executable === name) ? `/fixture/${name}` : null));
  override(t, setup.seams, 'spawn', (command, args) => {
    state.spawned.push([command, ...args]);
    return { status: 0, signal: null };
  });
  override(t, setup.seams, 'run', () => result(0));
  override(t, setup.seams, 'installBrowser', async () => {});
  state.configure = async (names, _home, command, _tools, _release, options) => {
    state.registered.push({ names: [...names], command, ...options });
    return names.filter((name) => state.failing.has(name)).map((name) => [name, 'plugin', 'boom']);
  };
  // Cross-turn owner authentication never reaches the real macOS helper: `auth` records and approves or refuses.
  state.authCalls = [];
  state.approve = true;
  state.crossTurn = { platform: 'darwin', auth: async (_root, reason) => {
    state.authCalls.push(reason);
    if (!state.approve) throw new AppsError('authentication was cancelled or failed. Nothing was changed.');
  } };
  state.raw = async (...argv) => {
    const seen = await output(t);
    const code = await setup.main(['--prefix', prefix, '--user', 'fixture', '--session', 'direct', ...argv],
      { configure: state.configure, crossTurn: state.crossTurn });
    return { code, out: seen.out, err: seen.err };
  };
  state.main = (...argv) => state.raw('--yes', '--no-chrome', ...argv);
  state.reconcile = async (...argv) => {
    const seen = await output(t);
    const code = await setup.main(['--prefix', prefix, '--user', 'fixture', '--reconcile', ...argv], { configure: state.configure });
    return { code, out: seen.out, err: seen.err };
  };
  state.agents = (...names) => names.flatMap((name) => ['--agent', name]);
  return state;
}

test('apply_changes refuses a concurrent edit and leaves it in place', (t) => {
  const path = join(temporary(t), 'config');
  writeFileSync(path, 'concurrent change');
  assert.throws(() => setup.applyChanges([setup.change(path, Buffer.from('old config'), 'new config')]), /File changed during setup/);
  assert.equal(readFileSync(path, 'utf8'), 'concurrent change');
});

test('writes keep the file mode and never go through a symlink', (t) => {
  const root = temporary(t);
  const path = write(join(root, 'a/config.json'), '{}', 0o640);
  setup.applyChanges([setup.change(path, Buffer.from('{}'), '{"a":1}')]);
  assert.equal(statSync(path).mode & 0o777, 0o640);
  process.getBuiltinModule('node:fs').symlinkSync(join(root, 'a'), join(root, 'link'));
  assert.throws(() => setup.readFile(join(root, 'link/config.json')), /symlink/);
  assert.throws(() => setup.regularPath(`${root}/a/../b`), /parent traversal/);
});

test('setup state round-trips; old files mean ask with nothing pending; malformed files are refused', (t) => {
  const home = temporary(t);
  const empty = { chrome: false, audio: false, approval: 'ask', pending: [], pending_context: null };
  assert.deepEqual(setup.loadSetupState(home), empty);
  setup.saveSetupState(home, { chrome: true, audio: false });
  assert.deepEqual(JSON.parse(readFileSync(setup.setupStatePath(home), 'utf8')), { chrome: true, audio: false, approval: 'ask' });
  const context = { scope: 'user', project: null, session: 'direct' };
  setup.saveSetupState(home, { chrome: false, audio: true, approval: 'auto', pending: ['pi', 'pi', 'omp'], pendingContext: context });
  assert.deepEqual(setup.loadSetupState(home), { chrome: false, audio: true, approval: 'auto', pending: ['pi', 'omp'], pending_context: context });
  writeFileSync(setup.setupStatePath(home), '{"chrome": true, "audio": false}');
  assert.deepEqual(setup.loadSetupState(home), { ...empty, chrome: true });
  for (const text of ['{"chrome": true, "audio": false, "approval": "yolo"}', '{ not json', '{"chrome": "yes", "audio": false}',
    '{"chrome": false, "audio": false, "pending": "pi"}', '{"chrome": false, "audio": false, "pending": ["codex"]}',
    '{"chrome": false, "audio": false, "pending": ["pi"], "pending_context": {"scope": "x"}}']) {
    writeFileSync(setup.setupStatePath(home), text);
    assert.throws(() => setup.loadSetupState(home), /Malformed LCU setup state/, text);
  }
});

test('validation: conflicts, scopes, agents and reconcile', (t) => {
  const root = temporary(t);
  override(t, setup.seams, 'account', () => ({ name: 'fixture', uid: process.getuid(), gid: process.getgid(), home: root }));
  const check = (...argv) => setup.validate(setup.parse(['--user', 'fixture', ...argv]));
  assert.throws(() => check('--browser-host'), /setup --agent AGENT --chrome/);
  assert.throws(() => check('--chrome', '--no-chrome', '--agent', 'codex'), /not both/);
  assert.throws(() => check('--audio', '--no-audio', '--agent', 'codex'), /not both/);
  for (const name of ['omp', 'hermes']) {
    assert.throws(() => check('--scope', 'project', '--project', root, '--agent', name), /project scope is not supported/);
  }
  assert.throws(() => check('--export', '/tmp/x', '--allow-missing'), /cannot be combined with --export/);
  for (const flag of [['--approval', 'auto'], ['--agent', 'pi'], ['--chrome'], ['--allow-missing'], ['--scope', 'project']]) {
    assert.throws(() => check('--reconcile', ...flag), /cannot be combined/);
  }
  assert.throws(() => check('--agent', 'nope'), /Unknown agent: nope/);
  assert.throws(() => check('--prefix', 'relative'), /dedicated absolute prefix/);
  assert.deepEqual(check('--agent', 'claude', '--agent', 'claude-code').names, ['claude-code']);
  assert.deepEqual(check('--agent', 'all').names, Object.keys(setup.CLIENTS));
  assert.throws(() => setup.parse(['--scope', 'x']), setup.UsageError);
  assert.throws(() => setup.parse(['--bogus']), setup.UsageError);
});

test('--list-agents shows the scopes, and usage errors exit 2', async (t) => {
  const seen = await output(t);
  assert.equal(await setup.main(['--list-agents']), 0);
  assert.match(seen.out, /omp .*\(user\)/);
  assert.match(seen.out, /hermes .*\(user\)/);
  assert.match(seen.out, /codex .*\(user, project\)/);
  assert.equal(await setup.main(['--bogus']), 2);
  assert.equal(await setup.main(['--scope', 'x']), 2);
});

test('the shell and Windows quoting match what registrations and retries print', () => {
  assert.equal(setup.shellJoin(['/a b/lcu', 'setup', "it's", '']), "'/a b/lcu' setup 'it'\"'\"'s' ''");
  assert.equal(setup.windowsCommandLine(['C:\\a b\\lcu.cmd', 'x"y', 'c:\\d\\']), '"C:\\a b\\lcu.cmd" x\\"y c:\\d\\');
});

test('a chrome opt-in is saved and reused; --no-chrome turns it off; a saved decline is not asked again', async (t) => {
  const f = fixture(t);
  await f.raw('--agent', 'codex', '--chrome', '--yes');
  assert.deepEqual(JSON.parse(readFileSync(join(f.home, '.local/state/lcu/setup.json'), 'utf8')), { chrome: true, audio: false, approval: 'ask' });
  assert.ok(f.registered.at(-1).command.includes('--chrome'));
  const kept = await f.raw('--agent', 'codex', '--yes');
  assert.ok(f.registered.at(-1).command.includes('--chrome'));
  assert.match(kept.out, /Keeping Chrome control enabled/);
  await f.raw('--agent', 'codex', '--yes', '--no-chrome');
  assert.ok(!f.registered.at(-1).command.includes('--chrome'));
  assert.deepEqual(JSON.parse(readFileSync(join(f.home, '.local/state/lcu/setup.json'), 'utf8')), { chrome: false, audio: false, approval: 'ask' });
  const prompts = [];
  override(t, setup.seams, 'interactive', () => true);
  override(t, setup.seams, 'ask', (question) => {
    prompts.push(question);
    return 'y';
  });
  await f.raw('--agent', 'codex');
  assert.deepEqual(prompts, [CROSS_TURN_QUESTION, 'Apply this setup? [y/N] ']);
  assert.ok(!f.registered.at(-1).command.includes('--chrome'));
});

test('the runtime is probed and the registered command is the direct launcher with the opt-ins', async (t) => {
  const f = fixture(t);
  const { code } = await f.main('--agent', 'codex', '--audio');
  assert.equal(code, 0);
  assert.deepEqual(f.spawned[0], [join(f.prefix, 'current/bin/lcu'), '--version']);
  assert.deepEqual(f.registered[0].command, [join(f.prefix, 'current/bin/lcu'), '--audio']);
  await setup.main(['--prefix', f.prefix, '--user', 'fixture', '--session', 'discover', '--yes', '--agent', 'codex'], { configure: f.configure });
  assert.deepEqual(f.registered[1].command, [join(f.prefix, 'current/bin/lcu-session'), '--user', 'fixture', '--', join(f.prefix, 'current/bin/lcu'), '--audio']);
});

test('a missing runtime fails setup with exit 1', async (t) => {
  const f = fixture(t);
  const { code, err } = await f.main('--agent', 'codex', '--prefix', join(f.root, 'elsewhere/lcu'));
  assert.equal(code, 1);
  assert.match(err, /Setup failed: Managed runtime missing/);
});

test('failed registration still saves choices and prints a retry without a defaulted approval', async (t) => {
  const f = fixture(t);
  f.installed = new Set(['pi']);
  f.failing = new Set(['pi', 'codex']);
  const failed = await f.main(...f.agents(...ALL), '--allow-missing', '--approval', 'auto', '--audio');
  assert.equal(failed.code, 1);
  assert.match(failed.err, /2 registration step\(s\) failed \(pi: plugin, codex: plugin\)\. Choices were saved;/);
  assert.match(failed.err, /--approval auto/);
  assert.match(failed.err, /--audio/);
  const state = setup.loadSetupState(f.home);
  assert.deepEqual([state.audio, state.approval, state.pending], [true, 'auto', ['omp', 'hermes']]);
  assert.deepEqual(state.pending_context, { scope: 'user', project: null, session: 'direct' });
  const other = fixture(t);
  other.failing = new Set(['codex']);
  const retry = await other.main('--agent', 'codex');
  assert.match(retry.err, /retry:/);
  assert.doesNotMatch(retry.err, /--approval/);
  assert.match((await other.main('--agent', 'codex', '--approval', 'ask')).err, /--approval ask/);
});

// Root must name --user and ignores $HOME by design; these two run as the invoking account (CI runners are not root).
const NON_ROOT = { skip: process.getuid?.() === 0 && 'running as root, which ignores $HOME and requires --user by design' };

test('without --user, setup targets $HOME when it is usable, else the user database home', NON_ROOT, (t) => {
  const own = userInfo();
  const home = temporary(t);
  const saved = process.env.HOME;
  t.after(() => { process.env.HOME = saved; });
  process.env.HOME = home;
  assert.deepEqual(setup.seams.account(), { name: own.username, uid: own.uid, gid: own.gid, home });
  const check = (...argv) => setup.validate(setup.parse(['--prefix', join(home, 'prefix'), ...argv]));
  assert.equal(check('--agent', 'codex').account.home, home);
  // --user keeps the user database home, as it does for root.
  assert.equal(check('--agent', 'codex', '--user', own.username).account.home, own.homedir);
  for (const unusable of ['relative', join(home, 'missing'), '/']) {
    process.env.HOME = unusable;
    assert.equal(setup.seams.account().home, own.homedir, unusable);
  }
  override(t, process, 'getuid', () => 0);
  process.env.HOME = home;
  assert.throws(() => check('--agent', 'codex'), /Root must specify --user ACCOUNT/);
});

test('a retry names --user only when the caller did', NON_ROOT, async (t) => {
  const f = fixture(t);
  f.failing = new Set(['codex']);
  assert.match((await f.main('--agent', 'codex')).err, /--user fixture/);
  const seen = await output(t);
  const code = await setup.main(['--prefix', f.prefix, '--session', 'direct', '--yes', '--no-chrome', '--agent', 'codex'],
    { configure: f.configure });
  assert.equal(code, 1);
  assert.match(seen.err, /retry:/);
  assert.doesNotMatch(seen.err, /--user/);
});

test('--allow-missing skips and records missing harnesses and exits 0', async (t) => {
  const f = fixture(t);
  f.installed = new Set(['pi']);
  const { code, out } = await f.main(...f.agents(...ALL), '--allow-missing', '--approval', 'auto');
  assert.equal(code, 0);
  assert.deepEqual(f.registered[0].names, ['pi', 'codex', 'claude-code']);
  assert.equal(f.registered[0].approval, 'auto');
  assert.match(out, /Oh My Pi: not installed; will register when it appears/);
  assert.match(out, /Registered now: pi, codex, claude-code\./);
  assert.match(out, /Pending \(not installed\): omp, hermes\./);
  // Later explicit registrations clear their own pending entry and keep the others.
  f.installed = new Set(['omp']);
  await f.main('--agent', 'omp', '--allow-missing');
  assert.deepEqual(setup.loadSetupState(f.home).pending, ['hermes']);
  await f.main('--agent', 'codex', '--approval', 'auto');
  assert.deepEqual(setup.loadSetupState(f.home).pending, ['hermes']);
});

test('without --allow-missing a missing harness is still attempted', async (t) => {
  const f = fixture(t);
  await f.main(...f.agents(...ALL));
  assert.deepEqual(f.registered[0].names, ALL);
  assert.deepEqual(setup.loadSetupState(f.home).pending, []);
});

test('reconcile: silent without work; registers what appeared with the saved settings; keeps failures pending', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.reconcile(), { code: 0, out: '', err: '' });
  assert.equal(existsSync(setup.setupStatePath(f.home)), false);
  setup.saveSetupState(f.home, { chrome: false, audio: true, approval: 'auto', pending: ['pi', 'omp', 'hermes'],
    pendingContext: { scope: 'user', project: null, session: 'direct' } });
  const before = readFileSync(setup.setupStatePath(f.home));
  assert.deepEqual(await f.reconcile(), { code: 0, out: '', err: '' });
  assert.ok(readFileSync(setup.setupStatePath(f.home)).equals(before));
  f.installed = new Set(['omp', 'codex']);
  const done = await f.reconcile();
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(f.registered[0].names, ['omp']);
  assert.deepEqual(f.registered[0].command, [join(f.prefix, 'current/bin/lcu'), '--audio']);
  assert.deepEqual([f.registered[0].approval, f.registered[0].scope], ['auto', 'user']);
  assert.match(done.out, /Registered: omp/);
  assert.deepEqual(setup.loadSetupState(f.home).pending, ['pi', 'hermes']);
  f.registered.length = 0;
  assert.deepEqual(await f.reconcile(), { code: 0, out: '', err: '' });
  f.installed = new Set(['pi', 'hermes']);
  f.failing = new Set(['hermes']);
  const partial = await f.reconcile();
  assert.equal(partial.code, 1);
  assert.match(partial.err, /still pending: hermes/);
  assert.deepEqual(setup.loadSetupState(f.home).pending, ['hermes']);
});

test('reconcile uses the saved project scope and session mode; a saved ask leaves approval alone', async (t) => {
  const f = fixture(t);
  const project = join(f.root, 'project');
  mkdirSync(project);
  setup.saveSetupState(f.home, { chrome: false, audio: false, approval: 'ask', pending: ['pi'],
    pendingContext: { scope: 'project', project, session: 'discover' } });
  f.installed = new Set(['pi']);
  const done = await f.reconcile();
  assert.equal(done.code, 0, done.err);
  assert.deepEqual([f.registered[0].scope, f.registered[0].project, f.registered[0].approval], ['project', project, null]);
  assert.equal(f.registered[0].command[0], join(f.prefix, 'current/bin/lcu-session'));
});

test('a harness installed in a user directory outside PATH is found', (t) => {
  const home = temporary(t);
  executable(join(home, '.bun/bin/pi'));
  assert.equal(setup.harnessInstalled('pi', home, '/nonexistent'), true);
  assert.equal(setup.harnessInstalled('omp', home, '/nonexistent'), false);
});

test('reconcile waits for a held setup lock, then finds nothing left to do', async (t) => {
  const f = fixture(t);
  setup.saveSetupState(f.home, { chrome: false, audio: true, approval: 'auto', pending: ['pi'],
    pendingContext: { scope: 'user', project: null, session: 'direct' } });
  f.installed = new Set(['pi']);
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `import { setupLock } from ${JSON.stringify(pathToFileURL(join(REPO, 'lcu/setup.mjs')).href)};
     await setupLock(${JSON.stringify(f.home)}, () => new Promise((done) => { console.log('held'); process.stdin.on('end', done).resume(); }));`],
  { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => holder.kill());
  await new Promise((done) => holder.stdout.once('data', done));
  let finished = false;
  const waiting = f.reconcile().then((value) => { finished = true; return value; });
  await new Promise((done) => setTimeout(done, 700));
  assert.equal(finished, false, 'reconcile must wait for the setup lock');
  setup.saveSetupState(f.home, { chrome: false, audio: true, approval: 'auto' });
  holder.stdin.end();
  assert.deepEqual(await waiting, { code: 0, out: '', err: '' });
  assert.deepEqual(f.registered, []);
});

// Registration through the bundled installers (`configure`), with the installer processes stubbed.

function release(t) {
  const root = temporary(t);
  const home = join(root, 'home');
  const releaseRoot = join(root, 'release');
  const resources = join(releaseRoot, 'app/resources');
  mkdirSync(home);
  write(join(releaseRoot, 'installation.json'), '{"version":"fixture","app":"app"}');
  write(join(resources, 'plugins/openai-bundled/plugins/unified-computer-use/.mcp.json'),
    '{"mcpServers":{"cua_repl":{"type":"stdio","command":"node","args":[],"enabled":true}}}');
  const tools = join(root, 'agent-tools');
  executable(join(tools, 'node/bin/node'));
  write(join(tools, 'node_modules/skills/bin/cli.mjs'));
  write(join(tools, 'node_modules/add-mcp/dist/index.js'));
  return { root, home, release: releaseRoot, resources, tools, node: join(tools, 'node/bin/node'),
    skills: join(tools, 'node_modules/skills/bin/cli.mjs'), mcp: join(tools, 'node_modules/add-mcp/dist/index.js') };
}

test('the selected app descriptor and resources are required; the host contract drops the launch fields', async (t) => {
  const r = release(t);
  assert.equal(await setup.installedAppResources(r.release), r.resources);
  assert.deepEqual(await setup.hostPolicy(r.release), { type: 'stdio' });
  process.getBuiltinModule('node:fs').unlinkSync(join(r.release, 'installation.json'));
  await assert.rejects(setup.installedAppResources(r.release), /descriptor missing/);
});

test('Claude Code registration forwards the command through the relay and installs visibility and the mod', async (t) => {
  const r = release(t);
  write(join(r.release, 'adapters/claude.mjs'), 'fixture relay');
  cpSync(join(REPO, 'adapters/claude-mod'), join(r.release, 'adapters/claude-mod'), { recursive: true });
  const project = join(r.root, 'project');
  mkdirSync(project);
  write(join(r.home, '.claude/settings.json'), JSON.stringify({ model: 'sonnet', permissions: { allow: ['Read'], deny: ['Bash(rm *)'] },
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'keep-me' }] }] } }));
  await output(t);
  const register = async (scope, command) => {
    const calls = [];
    override(t, setup.seams, 'run', (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === r.skills && args[1] === 'list') {
        assert.equal(args.includes('--global'), scope === 'user');
        return result(0, '[]');
      }
      return result(0, '{}');
    });
    const failures = await setup.configure(['claude-code'], r.home, command, r.tools, r.release,
      { scope, project: scope === 'project' ? project : null, environ: { HOME: r.home } });
    assert.deepEqual(failures, []);
    const registration = calls.find((call) => call[1] === '--input-type=module' && call[4] === r.mcp && call[5] === 'claude-code' && call.length === 9);
    assert.ok(calls.some((call) => call[1] === '--input-type=module' && call[5] === 'claude-code' && call.length === 7), 'preflight');
    assert.equal(registration[6], scope);
    return JSON.parse(registration.at(-2));
  };
  const base = ['/usr/bin/lcu', '--session', 'direct'];
  assert.deepEqual(await register('user', base), [r.node, join(r.release, 'adapters/claude.mjs'), ...base]);
  const configured = readFileSync(join(r.home, '.claude/settings.json'));
  const data = JSON.parse(configured);
  assert.equal(data.model, 'sonnet');
  assert.deepEqual(data.permissions.allow, ['Read']);
  assert.deepEqual(data.permissions.deny, ['Bash(rm *)', 'mcp__lcu__turn_ended', 'mcp__lcu__js_add_node_module_dir', 'mcp__lcu__set_turn_context']);
  assert.equal(data.hooks.UserPromptSubmit[0].hooks[0].command, 'keep-me');
  assert.equal(data.hooks.PreToolUse[0].matcher, 'mcp__lcu__js|mcp__lcu__js_reset');
  assert.deepEqual(data.hooks.Stop[0].hooks[0].input, { hook_event_name: 'Stop', session_id: '${session_id}', turn_id: '${prompt_id}' });
  await register('user', base);
  assert.ok(readFileSync(join(r.home, '.claude/settings.json')).equals(configured));
  const projectCommand = [...base, '--chrome', '--audio'];
  assert.deepEqual(await register('project', projectCommand), [r.node, join(r.release, 'adapters/claude.mjs'), ...projectCommand]);
  assert.deepEqual(JSON.parse(readFileSync(join(project, '.claude/settings.local.json'), 'utf8')).permissions.deny,
    ['mcp__lcu__turn_ended', 'mcp__lcu__js_add_node_module_dir', 'mcp__lcu__set_turn_context']);
  assert.equal(existsSync(join(project, '.claude/settings.json')), false);
  assert.ok(existsSync(join(r.home, '.claude/skills/lcu-approve/.claude-plugin/plugin.json')));
  assert.ok(existsSync(join(project, '.claude/skills/lcu-approve/hooks/register.tsx')));
});

test('Codex registration wraps the command in the relay and carries the host policy', async (t) => {
  const r = release(t);
  write(join(r.release, 'adapters/codex.mjs'), 'fixture relay');
  write(join(r.release, 'adapters/audio-files.mjs'), 'fixture helper');
  const policy = { enabled_tools: ['js', 'js_reset', 'turn_ended'], startup_timeout_sec: 120, tools: { js: { output_token_limit: 25000 } } };
  write(join(r.resources, 'plugins/openai-bundled/plugins/unified-computer-use/.mcp.json'),
    JSON.stringify({ mcpServers: { cua_repl: { command: 'node', args: [], ...policy } } }));
  const calls = [];
  override(t, setup.seams, 'run', (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === r.skills) return result(0, '[]');
    return result(0, JSON.stringify({ path: join(r.home, '.codex/config.toml') }));
  });
  await output(t);
  const original = ['/opt/lcu/current/bin/lcu', '--chrome', '--audio'];
  // No Codex CLI layout in this fixture app: registration runs, then installing the hooks fails as a step.
  const failures = await setup.configure(['codex'], r.home, original, r.tools, r.release, { environ: { HOME: r.home, PATH: '/nonexistent' } });
  const registration = calls.find((call) => call[1] === '--input-type=module' && call[5] === 'codex' && call.length === 9);
  assert.deepEqual(JSON.parse(registration.at(-2)), [r.node, join(r.release, 'adapters/codex.mjs'), ...original]);
  assert.deepEqual(JSON.parse(registration.at(-1)), policy);
  assert.deepEqual(failures.map(([name, phase]) => [name, phase]), [['codex', 'MCP']]);
  assert.match(failures[0][2], /Codex CLI layout/);
});

test('Codex registration output that is not an object is a failure, and one harness failing does not stop the next', async (t) => {
  const r = release(t);
  for (const name of ['claude.mjs', 'codex.mjs', 'audio-files.mjs']) write(join(r.release, 'adapters', name), 'x');
  const seen = await output(t);
  for (const stdout of ['[]', '{}', 'null']) {
    override(t, setup.seams, 'run', (cmd, args) => (args[0] === r.skills ? result(0, '[]') : result(0, stdout)));
    const failures = await setup.configure(['codex'], r.home, ['/opt/lcu/bin/lcu'], r.tools, r.release, { environ: { HOME: r.home, PATH: '' } });
    assert.deepEqual(failures.map(([name, phase]) => [name, phase]), [['codex', 'MCP']]);
    assert.match(failures[0][2], /unexpected output/);
  }
  let registrations = 0;
  override(t, setup.seams, 'run', (cmd, args) => {
    if (args[0] === r.skills) throw new TypeError('weird');
    if (args.length === 6) return result(0);
    registrations += 1;
    if (registrations === 1) throw new Error('nope');
    return result(0, '{}');
  });
  const failures = await setup.configure(['claude-code', 'codex'], r.home, ['/opt/lcu/bin/lcu'], r.tools, r.release, { environ: { HOME: r.home, PATH: '' } });
  assert.deepEqual(failures[0], ['claude-code', 'MCP', 'nope']);
  assert.equal(registrations, 2);
  assert.match(seen.err, /Claude Code: skipped old LCU skill cleanup: TypeError: weird/);
  assert.match(seen.err, /MCP failed: nope/);
});

test('Pi registration writes the local extension and the per-scope command, offline', async (t) => {
  const r = release(t);
  write(join(r.release, 'adapters/pi/index.ts'), 'fixture');
  const commands = write(join(r.home, '.local/share/lcu/pi/commands.json'),
    JSON.stringify({ projects: { '/existing/project': ['/usr/bin/lcu'] }, preserved: true }));
  const calls = [];
  override(t, setup.seams, 'which', (name) => (name === 'pi' ? '/bin/pi' : null));
  override(t, setup.seams, 'run', (cmd, args, options) => {
    calls.push([cmd, args, options]);
    if (args[0] === r.skills) return result(0, '[]');
    assert.deepEqual(args, ['install', join(r.home, '.local/share/lcu/pi/extension.mjs')]);
    assert.equal(options.env.PI_OFFLINE, '1');
    return result(0, 'Installed');
  });
  await output(t);
  assert.deepEqual(await setup.configure(['pi'], r.home, ['/usr/bin/lcu', '--audio'], r.tools, r.release, { environ: { HOME: r.home } }), []);
  assert.equal(calls.length, 2);
  const wrapper = readFileSync(join(r.home, '.local/share/lcu/pi/extension.mjs'), 'utf8');
  assert.ok(wrapper.includes(pathToFileURL(join(r.release, 'adapters/pi/index.ts')).href));
  assert.ok(wrapper.includes('realpathSync(process.cwd())'));
  assert.deepEqual(JSON.parse(readFileSync(commands, 'utf8')), { projects: { '/existing/project': ['/usr/bin/lcu'] }, preserved: true, user: ['/usr/bin/lcu', '--audio'] });
});

test('the old LCU skill is removed only when it is LCU\'s own', (t) => {
  const root = temporary(t);
  const installed = join(root, 'installed/lcu');
  mkdirSync(installed, { recursive: true });
  const cases = [[[], null, 'none'],
    [[{ name: 'lcu', path: installed }], 'description: Control macOS desktop windows through the original Codex computer-use runtime.', 'removed'],
    [[{ name: 'lcu', path: installed }], 'description: Read and operate Linux desktop windows using the LCU MCP computer-use tools.', 'removed'],
    [[{ name: 'lcu', path: installed }], "description: Someone else's unrelated skill.", 'kept'],
    [[{ name: 'lcu', path: installed }], 'description: My notes. See the original Codex computer-use runtime docs.\nname: other', 'kept']];
  for (const [listing, text, expected] of cases) {
    const calls = [];
    override(t, setup.seams, 'run', (cmd, args) => {
      calls.push(args.slice(1));
      return result(0, args[1] === 'list' ? JSON.stringify(listing) : '');
    });
    if (text) writeFileSync(join(installed, 'SKILL.md'), `---\nname: lcu\n${text}\n---\n`);
    assert.equal(setup.removeOldSkill('node', 'skills', root, {}, ['--global']), expected);
    assert.deepEqual(calls, [['list', '--json', '--global'], ...(expected === 'removed' ? [['remove', 'lcu', '--yes', '--global']] : [])]);
  }
  for (const stdout of ['null', '{"name": "lcu"}']) {
    override(t, setup.seams, 'run', () => result(0, stdout));
    assert.throws(() => setup.removeOldSkill('node', 'skills', root, {}, []));
  }
  override(t, setup.seams, 'run', () => result(0, '{"truncated', 'boom: stderr detail'));
  assert.throws(() => setup.removeOldSkill('node', 'skills', root, {}, []), /invalid JSON \(11 bytes\): boom: stderr detail/);
});

test('the skill earlier versions generated is removed', (t) => {
  const home = temporary(t);
  setup.removeGeneratedSkill(home);
  write(join(home, '.local/share/lcu/skills/lcu/SKILL.md'), 'old');
  setup.removeGeneratedSkill(home);
  assert.equal(existsSync(join(home, '.local/share/lcu/skills')), false);
});

test('an export carries no skill or producer path and resolves the destination prefix and session', async (t) => {
  const r = release(t);
  const destination = join(r.root, 'export');
  await setup.exportBundle(destination, ['/producer/private/lcu'], r.release, { codexFiles: () => ({}) });
  const files = ['plugin.json', 'mcp.json', 'host-contract.json', 'lcu-bootstrap.json', 'codex.mcp.json'];
  const text = files.map((name) => readFileSync(join(destination, name), 'utf8')).join('\n');
  assert.ok(!text.includes('/producer/private/lcu') && !text.includes(r.root));
  const command = JSON.parse(readFileSync(join(destination, 'mcp.json'), 'utf8')).mcpServers.lcu;
  assert.equal(command.command, '/bin/sh');
  const prefix = join(r.root, 'destination');
  for (const name of ['lcu', 'lcu-session']) write(join(prefix, 'current/bin', name), '#!/bin/sh\nprintf "%s\\n" "$@"\n', 0o755);
  const run = (mode, cmd) => process.getBuiltinModule('node:child_process').spawnSync(cmd.command, [...cmd.args, 'doctor'],
    { env: { ...process.env, LCU_PREFIX: prefix, LCU_SESSION_MODE: mode }, encoding: 'utf8' }).stdout;
  assert.equal(run('direct', command), 'doctor\n');
  assert.equal(run('discover', command), `--user\n${process.getBuiltinModule('node:os').userInfo().username}\n--\n${join(prefix, 'current/bin/lcu')}\ndoctor\n`);
  const codex = JSON.parse(readFileSync(join(destination, 'codex.mcp.json'), 'utf8')).mcpServers.lcu;
  assert.match(codex.args[1], /current\/agent-tools\/node\/bin\/node/);
  assert.match(codex.args[1], /current\/adapters\/codex\.mjs/);
  await setup.exportBundle(join(r.root, 'chrome-export'), ['/usr/bin/lcu', '--chrome'], r.release, { chrome: true, codexFiles: () => ({}) });
  assert.equal(JSON.parse(readFileSync(join(r.root, 'chrome-export/mcp.json'), 'utf8')).mcpServers.lcu.args.at(-1), '--chrome');
  assert.match(JSON.parse(readFileSync(join(r.root, 'chrome-export/lcu-bootstrap.json'), 'utf8')).destinationSetup, /--chrome/);
  assert.ok(!command.args.includes('--chrome'));
});

test('desktop readiness: --yes defers, --check-desktop requires a bounded check, interactive guides, export skips', () => {
  const desktopCommand = ['/opt/lcu/current/bin/lcu'];
  const request = (args, interactive) => setup.desktopReadinessRequest({ 'check-desktop': false, export: undefined, yes: false, ...args },
    { interactive, desktopCommand });
  assert.equal(request({ yes: true }, true).mode, 'deferred');
  assert.deepEqual(request({}, true), { mode: 'guided', command: [...desktopCommand, 'doctor'], timeout: null });
  assert.deepEqual(request({ 'check-desktop': true, yes: true }, false),
    { mode: 'required', command: [...desktopCommand, 'doctor', '--non-interactive', '--require-ready'], timeout: 50_000 });
  assert.equal(request({ export: '/plugin' }, true).mode, 'skip');
});

test('setup with --check-desktop exits 2 when the desktop is not ready', async (t) => {
  const f = fixture(t);
  override(t, setup.seams, 'spawn', (command, args) => ({ status: args.includes('doctor') ? 2 : 0, signal: null }));
  const { code, err } = await f.main('--agent', 'codex', '--check-desktop');
  assert.equal(code, 2);
  assert.match(err, /desktop readiness was not verified/);
});

test('a too-long macOS socket path is a warning at the end of setup', async (t) => {
  const f = fixture(t);
  override(t, process, 'platform', 'darwin');
  process.env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH = `/${'a'.repeat(200)}`;
  t.after(() => delete process.env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH);
  const { code, out } = await f.main('--agent', 'codex');
  assert.equal(code, 0);
  assert.ok(out.indexOf('Warning: Computer Use cannot start for this macOS account') > out.indexOf('Configuration prepared.'));
  assert.doesNotMatch(out, /not in this account's home folder/);
});

test('macOS setup into a home other than the account home warns that the helper is out of reach', async (t) => {
  const f = fixture(t);
  override(t, process, 'platform', 'darwin');
  const { code, out } = await f.main('--agent', 'codex');
  assert.equal(code, 0);
  assert.match(out, new RegExp(`Warning: setup configured the agents in ${f.home}, not in this account's home folder`));
  assert.match(out, /SKY_CUA_SERVICE_NATIVE_PIPE_PATH names the helper's socket/);
});

test('Windows setup configures only the signed-in account, in a direct session, without export', (t) => {
  const home = temporary(t);
  override(t, process, 'platform', 'win32');
  override(t, setup.seams, 'account', () => ({ name: 'Alice', uid: null, gid: null, home }));
  const check = (...argv) => setup.validate(setup.parse(['--prefix', '/Users/alice/AppData/Local/LCU', ...argv]));
  assert.equal(setup.parse([]).session, 'direct');
  assert.deepEqual(check('--agent', 'codex', '--user', 'alice').names, ['codex']);
  assert.throws(() => check('--agent', 'codex', '--user', 'bob'), /only configures the current signed-in account/);
  assert.throws(() => check('--agent', 'codex', '--session', 'discover'), /requires --session direct/);
  assert.throws(() => check('--export', join(home, 'x')), /portable export is not implemented/);
});

test('Windows registrations name the stable lcu.cmd; setup itself starts the launcher on the current Node', (t) => {
  override(t, process, 'platform', 'win32');
  const prefix = '/Users/alice/AppData/Local/LCU';
  const paths = setup.runtimePaths({ prefix, session: 'direct' }, { name: 'alice' });
  assert.deepEqual(paths.desktopCommand, [join(prefix, 'lcu.cmd')]);
  assert.deepEqual(paths.directRuntime, [process.execPath, join(prefix, 'windows_launcher.mjs')]);
  assert.equal(paths.runtime, join(prefix, 'lcu.cmd'));
});

test('an export cannot carry an approval mode', (t) => {
  override(t, setup.seams, 'account', () => ({ name: 'fixture', uid: process.getuid(), gid: process.getgid(), home: temporary(t) }));
  assert.throws(() => setup.validate(setup.parse(['--user', 'fixture', '--export', '/tmp/new-export', '--approval', 'auto'])),
    /cannot be combined with --export/);
});

test('the old skill listing survives a Node exit right after a large output', (t) => {
  const root = temporary(t);
  const skills = write(join(root, 'skills.mjs'), "console.log(JSON.stringify(Array.from({length: 2000}, (_, i) => " +
    "({name: 'other-' + i, path: '/x/' + 'p'.repeat(60)}))));\nprocess.exit(0);\n");
  assert.equal(setup.removeOldSkill(process.execPath, skills, root, process.env, ['--global']), 'none');
});

test('JSON settings: an empty file is {} and a byte order mark is ignored', () => {
  assert.deepEqual(setup.parseJson(Buffer.alloc(0)), {});
  assert.deepEqual(setup.parseJson(null), {});
  assert.deepEqual(setup.parseJson(Buffer.from('﻿{"a": 1}')), { a: 1 });
});

test('a terminal question reads one line without spinning, and is empty at the end of input', async () => {
  const script = `import { ask } from ${JSON.stringify(pathToFileURL(join(REPO, 'lcu/terminal.mjs')).href)};
    const started = process.cpuUsage(); const answer = await ask('Q? '); const end = await ask('again? ');
    const used = process.cpuUsage(started); console.log(JSON.stringify({ answer, end, cpu: (used.user + used.system) / 1000 }));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  await new Promise((done) => setTimeout(done, 400));
  child.stdin.end('yes\n');
  await new Promise((done) => child.once('close', done));
  const answer = JSON.parse(out.slice(out.indexOf('{')));
  assert.equal(answer.answer, 'yes');
  assert.equal(answer.end, '');
  assert.ok(answer.cpu < 300, `${answer.cpu} ms of CPU while waiting`);
});

// Cross-turn Computer Use -------------------------------------------------------------------------------

const CROSS_TURN_QUESTION = question('darwin');
const crossTurnFile = (f) => join(f.home, '.local/state/lcu/cross-turn.json');
const crossTurnState = (f) => JSON.parse(readFileSync(crossTurnFile(f), 'utf8'));

test('setup validation: --cross-turn takes on|off; --unattended needs --cross-turn on; no export or reconcile', (t) => {
  const root = temporary(t);
  override(t, setup.seams, 'account', () => ({ name: 'fixture', uid: process.getuid(), gid: process.getgid(), home: root }));
  const check = (...argv) => setup.validate(setup.parse(['--user', 'fixture', ...argv]));
  assert.throws(() => setup.parse(['--cross-turn', 'maybe']), setup.UsageError);
  assert.throws(() => check('--agent', 'codex', '--unattended'), /only applies together with --cross-turn on/);
  assert.throws(() => check('--agent', 'codex', '--cross-turn', 'off', '--unattended'), /only applies together with --cross-turn on/);
  assert.throws(() => check('--export', '/tmp/new-export', '--cross-turn', 'on'), /cannot be combined with --export/);
  assert.throws(() => check('--reconcile', '--cross-turn', 'on'), /cannot be combined/);
  assert.throws(() => check('--reconcile', '--unattended'), /cannot be combined/);
  assert.deepEqual(check('--agent', 'codex', '--cross-turn', 'on', '--unattended').names, ['codex']);
  assert.match(setup.USAGE, /--cross-turn on\|off \[--unattended\]/);
});

test('--cross-turn on authenticates once on macOS, records the owner, and is idempotent', async (t) => {
  const f = fixture(t);
  const first = await f.main('--agent', 'codex', '--cross-turn', 'on');
  assert.equal(first.code, 0);
  assert.equal(f.authCalls.length, 1);
  assert.match(first.out, /Cross-turn Computer Use is now on/);
  assert.deepEqual([crossTurnState(f).enabled, crossTurnState(f).source], [true, 'owner']);
  const again = await f.main('--agent', 'codex', '--cross-turn', 'on');
  assert.equal(f.authCalls.length, 1);
  assert.match(again.out, /already on/);
  await f.main('--agent', 'codex', '--cross-turn', 'off');
  assert.equal(f.authCalls.length, 1);
  assert.equal(crossTurnState(f).enabled, false);
  // setup.json is untouched by the setting
  assert.deepEqual(JSON.parse(readFileSync(join(f.home, '.local/state/lcu/setup.json'), 'utf8')), { chrome: false, audio: false, approval: 'ask' });
});

test('--cross-turn on --unattended skips the prompt with a warning; Linux records cli', async (t) => {
  const f = fixture(t);
  const unattended = await f.main('--agent', 'codex', '--cross-turn', 'on', '--unattended');
  assert.equal(f.authCalls.length, 0);
  assert.equal(crossTurnState(f).source, 'unattended');
  assert.match(unattended.err, /disposable sandbox machines/);
  await f.main('--agent', 'codex', '--cross-turn', 'off');
  f.crossTurn.platform = 'linux';
  await f.main('--agent', 'codex', '--cross-turn', 'on');
  assert.equal(f.authCalls.length, 0);
  assert.deepEqual([crossTurnState(f).enabled, crossTurnState(f).source], [true, 'cli']);
});

test('a cancelled owner authentication leaves the setting alone and does not fail the rest of setup', async (t) => {
  const f = fixture(t);
  f.approve = false;
  const { code, err, out } = await f.main('--agent', 'codex', '--cross-turn', 'on');
  assert.equal(code, 0);
  assert.match(err, /Cross-turn Computer Use unchanged: authentication was cancelled/);
  assert.equal(existsSync(crossTurnFile(f)), false);
  assert.equal(f.registered.length, 1);
  assert.match(out, /Configuration prepared/);
});

/** A fixture whose terminal is interactive: it records every question and answers the cross-turn one with `answers.crossTurn`. */
function interactiveFixture(t, answers) {
  const f = fixture(t);
  override(t, setup.seams, 'interactive', () => true);
  override(t, setup.seams, 'ask', (question) => {
    f.prompts.push(question);
    return question === CROSS_TURN_QUESTION ? answers.crossTurn : answers.apply;
  });
  f.prompts = [];
  return f;
}

test('interactive setup asks about cross-turn once; yes authenticates, no is recorded, --yes leaves it unchanged', async (t) => {
  const answers = { crossTurn: 'y', apply: 'y' };
  let f = interactiveFixture(t, answers);
  await f.raw('--agent', 'codex', '--no-chrome');
  assert.deepEqual(f.prompts, [CROSS_TURN_QUESTION, 'Apply this setup? [y/N] ']);
  assert.equal(f.authCalls.length, 1);
  assert.equal(crossTurnState(f).enabled, true);
  f.prompts.length = 0;
  await f.raw('--agent', 'codex', '--no-chrome');
  assert.deepEqual(f.prompts, ['Apply this setup? [y/N] ']);

  answers.crossTurn = 'n';
  f = interactiveFixture(t, answers);
  await f.raw('--agent', 'codex', '--no-chrome');
  assert.equal(f.authCalls.length, 0);
  assert.equal(crossTurnState(f).enabled, false);
  f.prompts.length = 0;
  await f.raw('--agent', 'codex', '--no-chrome');
  assert.deepEqual(f.prompts, ['Apply this setup? [y/N] ']);

  f = interactiveFixture(t, answers);
  const yes = await f.raw('--agent', 'codex', '--no-chrome', '--yes');
  assert.deepEqual(f.prompts, []);
  assert.equal(existsSync(crossTurnFile(f)), false);
  assert.match(yes.out, /Cross-turn Computer Use: off, unchanged/);
});

test('declining "Apply this setup?" applies no cross-turn change, and a damaged file is neither asked about nor replaced', async (t) => {
  const answers = { crossTurn: 'y', apply: 'n' };
  let f = interactiveFixture(t, answers);
  await f.raw('--agent', 'codex', '--no-chrome');
  assert.equal(existsSync(crossTurnFile(f)), false);
  assert.equal(f.authCalls.length, 0);
  assert.deepEqual(f.registered, []);

  f = interactiveFixture(t, answers);
  write(crossTurnFile(f), '{broken');
  const { err } = await f.raw('--agent', 'codex', '--no-chrome');
  assert.ok(!f.prompts.includes(CROSS_TURN_QUESTION));
  assert.match(err, /not a valid cross-turn setting/);
  assert.equal(readFileSync(crossTurnFile(f), 'utf8'), '{broken');
});

test('the cross-turn question names per-app approvals only where they exist', () => {
  assert.match(question('darwin'), /Per-app approvals still apply\. \[y\/N\] $/);
  assert.match(question('win32'), /Per-app approvals still apply/);
  assert.match(question('linux'), /has no per-app approval/);
  assert.doesNotMatch(question('linux'), /Per-app approvals still apply/);
});
