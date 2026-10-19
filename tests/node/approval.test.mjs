// Approval mode: add and remove only LCU's own harness approval entries.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as approval from '../../lcu/approval.mjs';
import * as visibility from '../../lcu/claude_visibility.mjs';
import * as setup from '../../lcu/setup.mjs';
import { REPO, output, override, posixTests, result, temporary, write } from './fixtures.mjs';

const test = posixTests('fake launchers and harness CLIs are sh scripts, and accounts carry POSIX uid/gid');

function claude(t) {
  const root = temporary(t);
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home);
  mkdirSync(project);
  const user = join(home, '.claude/settings.json');
  const local = join(project, '.claude/settings.local.json');
  return { home, project, user, local,
    apply: (mode, scopeProject) => approval.apply(mode, 'claude-code', home, { scope: scopeProject ? 'project' : 'user', project: scopeProject, env: {} }),
    write: (path, data) => write(path, `${JSON.stringify(data, null, 2)}\n`),
    read: (path) => JSON.parse(readFileSync(path, 'utf8')) };
}

test('Claude: auto adds exactly the model tools at user scope and ask removes exactly them', (t) => {
  const c = claude(t);
  const original = { model: 'sonnet', permissions: { allow: ['Read'], deny: ['Bash(rm *)'], ask: ['Edit'] },
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'keep-me' }] }] } };
  c.write(c.user, original);
  assert.match(c.apply('auto'), /added/);
  assert.deepEqual(c.read(c.user), { ...original, permissions: { ...original.permissions, allow: ['Read', 'mcp__lcu__js', 'mcp__lcu__js_reset'] } });
  assert.match(c.apply('ask'), /removed/);
  assert.deepEqual(c.read(c.user), original);
});

test('Claude: project scope uses settings.local.json; auto is byte-stable; ask without a rule writes nothing', (t) => {
  const c = claude(t);
  assert.match(c.apply('ask'), /^unchanged/);
  assert.equal(existsSync(c.user), false);
  c.write(c.user, { permissions: { allow: ['Read'] } });
  const before = readFileSync(c.user);
  c.apply('auto', c.project);
  assert.deepEqual(c.read(c.local), { permissions: { allow: ['mcp__lcu__js', 'mcp__lcu__js_reset'] } });
  assert.ok(readFileSync(c.user).equals(before));
  c.apply('ask', c.project);
  assert.deepEqual(c.read(c.local), {});
  c.apply('auto');
  const first = readFileSync(c.user);
  assert.match(c.apply('auto'), /^unchanged/);
  assert.ok(readFileSync(c.user).equals(first));
});

test('Claude: rules the user wrote are never removed, records are per settings path', (t) => {
  const c = claude(t);
  c.write(c.user, { permissions: { allow: ['mcp__lcu__js', 'mcp__other'] } });
  c.apply('auto');
  assert.deepEqual(c.read(c.user).permissions.allow, ['mcp__lcu__js', 'mcp__other', 'mcp__lcu__js_reset']);
  c.apply('ask');
  assert.deepEqual(c.read(c.user).permissions.allow, ['mcp__lcu__js', 'mcp__other']);
  const d = claude(t);
  d.write(d.user, { permissions: { allow: ['Read', 'mcp__lcu'] } });
  assert.match(d.apply('auto'), /^unchanged/);
  assert.match(d.apply('ask'), /kept your own/);
  assert.deepEqual(d.read(d.user), { permissions: { allow: ['Read', 'mcp__lcu'] } });
  const e = claude(t);
  e.write(e.local, { permissions: { allow: ['mcp__lcu'] } });
  e.apply('auto');
  e.apply('auto', e.project);
  e.apply('ask', e.project);
  assert.deepEqual(e.read(e.local), { permissions: { allow: ['mcp__lcu'] } });
  e.apply('ask');
  assert.deepEqual(e.read(e.user), {});
});

test('Claude: the legacy server-wide rule is migrated by auto and removed by ask', (t) => {
  const c = claude(t);
  const key = `claude-code|${c.user}`;
  approval.saveRecord(c.home, { [key]: { added: ['mcp__lcu'] } });
  c.write(c.user, { permissions: { allow: ['Read', 'mcp__lcu'] } });
  assert.match(c.apply('auto'), /^added/);
  assert.deepEqual(c.read(c.user).permissions.allow, ['Read', 'mcp__lcu__js', 'mcp__lcu__js_reset']);
  assert.deepEqual(approval.loadRecord(c.home)[key].added, ['mcp__lcu__js', 'mcp__lcu__js_reset']);
  c.apply('ask');
  assert.deepEqual(c.read(c.user), { permissions: { allow: ['Read'] } });
  approval.saveRecord(c.home, { [key]: { added: ['mcp__lcu'] } });
  c.write(c.user, { permissions: { allow: ['Read', 'mcp__lcu'] } });
  assert.match(c.apply('ask'), /removed/);
  assert.deepEqual(approval.loadRecord(c.home), {});
});

test('Claude: host-only tools stay denied; mod-only tools are never allowed or denied', (t) => {
  const c = claude(t);
  visibility.install(c.home);
  c.apply('auto');
  let permissions = c.read(c.user).permissions;
  assert.deepEqual(new Set(permissions.allow), new Set(approval.CLAUDE_RULES));
  assert.deepEqual(permissions.deny, visibility.HOST_ONLY);
  c.apply('ask');
  permissions = c.read(c.user).permissions;
  assert.ok(!('allow' in permissions));
  for (const rule of visibility.MOD_ONLY) assert.ok(!(permissions.deny ?? []).includes(rule));
});

test('Claude: malformed settings are refused without a write', (t) => {
  const c = claude(t);
  for (const content of ['{ not json', '[]', '{"permissions": []}', '{"permissions": {"allow": "x"}}', '{"permissions": {"allow": [1]}}',
    '{"permissions": null}', '{"permissions": {"allow": null}}']) {
    write(c.user, content);
    assert.throws(() => c.apply('auto'), Error, content);
    assert.equal(readFileSync(c.user, 'utf8'), content);
  }
});

test('the model tool lists agree between LCU and its adapters', () => {
  const names = (text, constant) => new RegExp(`${constant} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(text)[1];
  const client = readFileSync(join(REPO, 'adapters/client.mjs'), 'utf8');
  const relay = readFileSync(join(REPO, 'adapters/claude.mjs'), 'utf8');
  const expected = approval.MODEL_TOOLS.map((tool) => `'${tool}'`).join(', ');
  assert.equal(names(client, 'MODEL_TOOLS'), expected);
  assert.equal(names(relay, 'PUBLIC_TOOLS'), expected);
  assert.ok(readFileSync(join(REPO, 'lcu/claude_visibility.mjs'), 'utf8').includes(approval.CLAUDE_RULES.join('|')));
  assert.equal(names(relay, 'MOD_ONLY_TOOLS'), visibility.MOD_ONLY.map((rule) => `'${rule.replace('mcp__lcu__', '')}'`).join(', '));
  assert.ok(client.includes('toolu_plugin_'));
});

/** Stands in for `omp config get|set|reset tools.approval`. */
function fakeOmp(t, initial = {}) {
  const fake = { value: { ...initial }, calls: [], envs: [] };
  override(t, setup.seams, 'which', () => '/bin/omp');
  override(t, setup.seams, 'run', (command, args, options) => {
    fake.calls.push(args.slice(1));
    fake.envs.push(options.env);
    const [, action, key] = args;
    assert.equal(key, 'tools.approval');
    if (action === 'get') return result(0, JSON.stringify({ key, value: fake.value }));
    fake.value = action === 'set' ? JSON.parse(args[3]) : {};
    return result(0);
  });
  fake.writes = () => fake.calls.filter((call) => call[0] !== 'get');
  return fake;
}
const omp = (mode, home, env = {}) => approval.apply(mode, 'omp', home, { scope: 'user', project: null, env: { PATH: '/bin', ...env } });

test('OMP: auto allows both tools, keeps other policies and a user\'s own; ask removes only what it added', (t) => {
  const home = temporary(t);
  let fake = fakeOmp(t, { bash: 'prompt' });
  omp('auto', home);
  assert.deepEqual(fake.value, { bash: 'prompt', js: 'allow', js_reset: 'allow' });
  assert.equal(omp('auto', home), 'unchanged');
  omp('ask', home);
  assert.deepEqual(fake.value, { bash: 'prompt' });
  fake = fakeOmp(t, { js: 'deny' });
  assert.match(omp('auto', home), /kept your `js: deny`/);
  assert.deepEqual(fake.value, { js: 'deny', js_reset: 'allow' });
  omp('ask', home);
  assert.deepEqual(fake.value, { js: 'deny' });
  fake = fakeOmp(t, { js: 'allow', js_reset: 'allow' });
  omp('ask', home);
  assert.deepEqual(fake.writes(), []);
});

test('OMP: records are per profile, the environment selects it, and ask resets an emptied setting', (t) => {
  const home = temporary(t);
  const fake = fakeOmp(t);
  omp('auto', home, { OMP_PROFILE: 'blue' });
  assert.equal(fake.envs.at(-1).OMP_PROFILE, 'blue');
  assert.deepEqual(Object.keys(approval.loadRecord(home)), [`omp|${home}|{"OMP_PROFILE": "blue"}`]);
  const other = fakeOmp(t, { js: 'allow', js_reset: 'allow' });
  omp('ask', home, { OMP_PROFILE: 'green' });
  assert.deepEqual(other.writes(), []);
  const blue = fakeOmp(t, { js: 'allow', js_reset: 'allow' });
  omp('ask', home, { OMP_PROFILE: 'blue' });
  assert.deepEqual(blue.writes(), [['reset', 'tools.approval']]);
  assert.equal(omp('ask', home, { OMP_PROFILE: 'blue' }), 'unchanged');
});

test('OMP: a missing executable and unexpected output fail clearly', (t) => {
  const home = temporary(t);
  override(t, setup.seams, 'which', () => null);
  assert.throws(() => omp('auto', home), /not on the target account PATH/);
  override(t, setup.seams, 'which', () => '/bin/omp');
  override(t, setup.seams, 'run', () => result(0, 'not json'));
  assert.throws(() => omp('auto', home), /unexpected tools.approval value/);
  override(t, setup.seams, 'run', () => result(0, '{"value": []}'));
  assert.throws(() => omp('auto', home), /must be a mapping/);
  override(t, setup.seams, 'run', () => result(3, '', 'broken'));
  assert.throws(() => omp('auto', home), /omp config exited 3: broken/);
});

function codex(t) {
  const root = temporary(t);
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home);
  mkdirSync(project);
  const config = join(home, '.codex/config.toml');
  const env = { HOME: home };
  const plan = (mode, scope = 'user') => approval.codexPlan(mode, home, { scope, project, env });
  return { home, project, config, plan,
    write: (text, path = config) => write(path, text),
    cycle(mode, scope = 'user') {
      const planned = plan(mode, scope);
      approval.apply(mode, 'codex', home, { scope, project, env, plan: planned });
      return planned;
    } };
}
const TOOLS = { js: { approval_mode: 'approve' }, js_reset: { approval_mode: 'approve' } };

test('Codex: auto approves exactly the model tools and ask removes only the entries it added', (t) => {
  const c = codex(t);
  assert.deepEqual(c.plan('auto').policy, { tools: TOOLS });
  assert.deepEqual(c.plan('ask').policy, {});
  assert.deepEqual(c.plan(null).policy, {});
  c.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "prompt"\n');
  assert.deepEqual(c.cycle('auto').policy, { default_tools_approval_mode: 'prompt', tools: TOOLS });
  c.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "prompt"\n[mcp_servers.lcu.tools.js]\napproval_mode = "approve"\n' +
    '[mcp_servers.lcu.tools.js_reset]\napproval_mode = "approve"\n');
  c.cycle('auto');
  assert.deepEqual(c.plan('ask').policy, { default_tools_approval_mode: 'prompt' });
  c.cycle('ask');
  assert.deepEqual(approval.loadRecord(c.home), {});
});

test('Codex: a tool mode the user set is kept; values LCU did not record are preserved', (t) => {
  const c = codex(t);
  c.write('[mcp_servers.lcu.tools.js]\napproval_mode = "prompt"\n[mcp_servers.lcu.tools.js_reset]\napproval_mode = "approve"\n');
  const mine = { js: { approval_mode: 'prompt' }, js_reset: { approval_mode: 'approve' } };
  assert.deepEqual(c.cycle('auto').policy.tools, mine);
  assert.deepEqual(approval.loadRecord(c.home), {});
  assert.deepEqual(c.plan('ask').policy.tools, mine);
  c.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "approve"\n');
  for (const mode of ['ask', null]) assert.deepEqual(c.plan(mode).policy, { default_tools_approval_mode: 'approve' });
});

test('Codex: the legacy server-wide record is migrated by auto and restored by ask', (t) => {
  const c = codex(t);
  const key = `codex|${c.config}`;
  for (const [mode, expected] of [['auto', { default_tools_approval_mode: 'prompt', tools: TOOLS }], ['ask', { default_tools_approval_mode: 'prompt' }]]) {
    approval.saveRecord(c.home, { [key]: { prior: 'prompt' } });
    c.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "approve"\n');
    assert.deepEqual(c.plan(mode).policy, expected);
  }
  approval.saveRecord(c.home, { [key]: { prior: null } });
  assert.deepEqual(c.plan('auto').policy, { tools: TOOLS });
  assert.deepEqual(c.plan('ask').policy, {});
  c.cycle('auto');
  assert.deepEqual(approval.loadRecord(c.home)[key], { tools: ['js', 'js_reset'] });
});

test('Codex: project scope reads and records the project config; the policy merges over the host contract', (t) => {
  const c = codex(t);
  c.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "prompt"\n');
  c.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "never"\n', join(c.project, '.codex/config.toml'));
  c.cycle('auto', 'project');
  assert.deepEqual(c.plan('ask', 'user').policy, { default_tools_approval_mode: 'prompt' });
  assert.deepEqual(c.plan('ask', 'project').policy, { default_tools_approval_mode: 'never' });
  const host = { startup_timeout_sec: 120, tools: { js: { output_token_limit: 25000 } } };
  const merged = approval.mergeCodexPolicy(host, { tools: TOOLS });
  assert.deepEqual(merged.tools, { js: { output_token_limit: 25000, approval_mode: 'approve' }, js_reset: { approval_mode: 'approve' } });
  assert.deepEqual(approval.mergeCodexPolicy(host, {}), host);
});

test('Pi and Hermes have nothing to configure; an unknown mode is refused; the record is sorted JSON', (t) => {
  assert.match(approval.apply('auto', 'pi', '/h', { scope: 'user', project: null, env: {} }), /no permission system/);
  assert.match(approval.apply('ask', 'hermes', '/h', { scope: 'user', project: null, env: {} }), /pre_tool_call/);
  assert.throws(() => approval.apply('yolo', 'pi', '/h', { scope: 'user', project: null, env: {} }), /Unknown approval mode/);
  const home = temporary(t);
  approval.saveRecord(home, { b: { z: 1, a: 2 }, a: {} });
  assert.equal(readFileSync(approval.recordPath(home), 'utf8'), '{\n  "a": {},\n  "b": {\n    "a": 2,\n    "z": 1\n  }\n}\n');
  writeFileSync(approval.recordPath(home), '[]');
  assert.throws(() => approval.loadRecord(home), /Malformed LCU approval record/);
});

test('setup remembers the approval mode: default ask leaves harnesses alone, auto is reapplied, explicit ask removes', async (t) => {
  const root = temporary(t);
  const prefix = join(root, 'prefix');
  const home = join(root, 'home');
  mkdirSync(home);
  for (const name of ['current/bin/lcu', 'current/bin/lcu-session', 'current/agent-tools/node/bin/node']) write(join(prefix, name), '#!/bin/sh\n', 0o755);
  for (const name of ['current/agent-tools/node_modules/skills/bin/cli.mjs', 'current/agent-tools/node_modules/add-mcp/dist/index.js']) write(join(prefix, name));
  override(t, setup.seams, 'account', () => ({ name: 'fixture', uid: process.getuid(), gid: process.getgid(), home }));
  override(t, setup.seams, 'interactive', () => false);
  override(t, setup.seams, 'spawn', () => ({ status: 0 }));
  override(t, setup.seams, 'run', () => result(0));
  const configured = [];
  let failures = [];
  const configure = async (names, h, command, tools, release, options) => {
    configured.push(options.approval);
    return failures;
  };
  const drive = async (...argv) => {
    const seen = await output(t);
    await setup.main(['--prefix', prefix, '--user', 'fixture', '--session', 'direct', '--yes', '--no-chrome', ...argv], { configure });
    return seen;
  };
  const saved = () => setup.loadSetupState(home).approval;
  let seen = await drive('--agent', 'codex');
  assert.deepEqual([configured, saved()], [[null], 'ask']);
  assert.doesNotMatch(seen.out, /Approval mode/);
  seen = await drive('--agent', 'codex', '--agent', 'pi', '--approval', 'auto');
  assert.equal(configured.at(-1), 'auto');
  assert.match(seen.out, /Codex: `approval_mode = "approve"` for the `js` and `js_reset` tools/);
  assert.match(seen.out, /Pi and Hermes have no such gate/);
  seen = await drive('--agent', 'codex');
  assert.equal(configured.at(-1), 'auto');
  assert.match(seen.out, /Keeping automatic approval/);
  seen = await drive('--agent', 'codex', '--approval', 'ask');
  assert.deepEqual([configured.at(-1), saved()], ['ask', 'ask']);
  assert.match(seen.out, /Approval mode ask: remove only the entries/);
  await drive('--agent', 'codex');
  assert.equal(configured.at(-1), null);
  failures = [['codex', 'approval', 'boom']];
  seen = await drive('--agent', 'codex', '--approval', 'auto');
  assert.equal(saved(), 'auto');
  assert.match(seen.err, /--approval auto/);
  assert.equal(await setup.main(['--approval', 'yolo']), 2);
});

test('Claude: an empty settings file or a byte order mark reads as before', (t) => {
  const c = claude(t);
  write(c.user, '');
  assert.match(c.apply('auto'), /added/);
  assert.deepEqual(c.read(c.user), { permissions: { allow: ['mcp__lcu__js', 'mcp__lcu__js_reset'] } });
  write(c.user, '\uFEFF{"model": "x"}');
  c.apply('auto');
  assert.equal(c.read(c.user).model, 'x');
});
