// The Claude Code approval mod (claude_mod.mjs) and host-only tool visibility (claude_visibility.mjs).
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { test } from 'node:test';

import * as mod from '../../lcu/claude_mod.mjs';
import * as visibility from '../../lcu/claude_visibility.mjs';
import { REPO, temporary, write } from './fixtures.mjs';

const MOD = join(REPO, 'adapters/claude-mod/lcu-approve');
const snapshot = (root) => Object.fromEntries(readdirSync(root, { recursive: true }).sort()
  .filter((name) => { try { readFileSync(join(root, name)); return true; } catch { return false; } })
  .map((name) => [name.split(sep).join('/'), readFileSync(join(root, name), 'utf8')]));

test('the shipped mod is a function-hook plugin for the lcu server', () => {
  assert.equal(JSON.parse(readFileSync(join(MOD, '.claude-plugin/plugin.json'), 'utf8')).name, mod.NAME);
  assert.deepEqual(JSON.parse(readFileSync(join(MOD, 'hooks/hooks.json'), 'utf8')), { modules: ['./register.tsx'] });
  const source = readFileSync(join(MOD, 'hooks/register.tsx'), 'utf8');
  assert.ok(source.includes("const SERVER = 'lcu'"));
  for (const event of ["'classic.Elicitation'", "'tool.call'", "'tool.check'", "'ui.render'", "'computer-use-apps'"]) assert.ok(source.includes(event), event);
});

test('user-scope install is idempotent, omits the mod tests and records the lcu command', (t) => {
  const home = temporary(t);
  const target = mod.install(home, REPO);
  assert.equal(target, join(home, '.claude/skills/lcu-approve'));
  assert.deepEqual(Object.keys(snapshot(target)).sort(), ['.claude-plugin/plugin.json', 'hooks/data.ts', 'hooks/hooks.json',
    'hooks/register.tsx', 'hooks/views.tsx', 'lcu.json', 'types/index.d.ts']);
  const before = snapshot(target);
  mod.install(home, REPO);
  assert.deepEqual(snapshot(target), before);
  assert.deepEqual(JSON.parse(before['lcu.json']), { lcu: join(REPO, 'bin/lcu') });
  const release = join(home, 'prefix/releases/1.0-abc');
  cpSync(MOD, join(release, 'adapters/claude-mod/lcu-approve'), { recursive: true, filter: (path) => basename(path) !== 'tests' });
  assert.deepEqual(JSON.parse(readFileSync(join(mod.install(home, release), 'lcu.json'), 'utf8')), { lcu: join(home, 'prefix/current/bin/lcu') });
});

test('project scope installs under the project; a reinstall replaces changed and drops stale files', (t) => {
  const root = temporary(t);
  const project = join(root, 'project');
  mkdirSync(project);
  assert.equal(mod.install(join(root, 'home'), REPO, { project }), join(project, '.claude/skills/lcu-approve'));
  assert.equal(existsSync(join(root, 'home/.claude')), false);
  const target = mod.install(root, REPO);
  writeFileSync(join(target, 'hooks/register.tsx'), 'old');
  writeFileSync(join(target, 'hooks/old.tsx'), 'stale');
  mod.install(root, REPO);
  assert.equal(readFileSync(join(target, 'hooks/register.tsx'), 'utf8'), readFileSync(join(MOD, 'hooks/register.tsx'), 'utf8'));
  assert.equal(existsSync(join(target, 'hooks/old.tsx')), false);
});

test('a foreign plugin of the same name is refused and kept; remove deletes only the mod', (t) => {
  const home = temporary(t);
  const target = write(join(home, '.claude/skills/lcu-approve/.claude-plugin/plugin.json'), '{"name": "mine"}');
  assert.throws(() => mod.install(home, REPO), /not the LCU mod/);
  assert.throws(() => mod.remove(home), /not the LCU mod/);
  assert.equal(readFileSync(target, 'utf8'), '{"name": "mine"}');
  const other = temporary(t);
  write(join(other, '.claude/skills/other/SKILL.md'), 'keep');
  mod.install(other, REPO);
  assert.equal(mod.remove(other), true);
  assert.equal(existsSync(join(other, '.claude/skills/lcu-approve')), false);
  assert.equal(readFileSync(join(other, '.claude/skills/other/SKILL.md'), 'utf8'), 'keep');
  assert.equal(mod.remove(other), false);
  assert.throws(() => mod.install(other, join(other, 'empty')), /Reinstall LCU/);
});

test('visibility denies exactly the host-only tools, adds the lifecycle hooks once and keeps other settings', (t) => {
  const home = temporary(t);
  const path = write(join(home, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['mcp__lcu__js'], deny: ['Bash'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }));
  visibility.install(home);
  const first = readFileSync(path, 'utf8');
  const settings = JSON.parse(first);
  assert.deepEqual(settings.permissions, { allow: ['mcp__lcu__js'], deny: ['Bash', ...visibility.HOST_ONLY] });
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'mine');
  assert.equal(settings.hooks.SubagentStop[0].hooks[0].input.session_id, '${agent_id}');
  assert.equal(settings.hooks.StopFailure[0].hooks[0].input.hook_event_name, 'Interrupt');
  assert.ok(!visibility.MOD_ONLY.some((tool) => settings.permissions.deny.includes(tool)));
  visibility.install(home);
  assert.equal(readFileSync(path, 'utf8'), first);
  for (const bad of ['[]', '{"permissions": []}', '{"permissions": {"deny": [1]}}', '{"hooks": {"Stop": {}}}', '{"hooks": {"Stop": [{"matcher": 1, "hooks": []}]}}',
    '{"permissions": null}', '{"permissions": {"deny": null}}', '{"hooks": null}', '{"hooks": {"Stop": null}}']) {
    writeFileSync(path, bad);
    assert.throws(() => visibility.install(home), Error, bad);
    assert.equal(readFileSync(path, 'utf8'), bad);
  }
});

test('an empty settings file or one with a byte order mark is read as before', (t) => {
  for (const content of ['', '\uFEFF{"model": "sonnet"}']) {
    const home = temporary(t);
    const path = write(join(home, '.claude/settings.json'), content);
    visibility.install(home);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(settings.permissions.deny, visibility.HOST_ONLY);
    if (content) assert.equal(settings.model, 'sonnet');
  }
});
