// Registration boundaries for the Oh My Pi and Hermes native harness packages.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as setup from '../../lcu/setup.mjs';
import { output, override, posixTests, result, temporary, write } from './fixtures.mjs';

const test = posixTests('the fake OMP and Hermes CLIs are sh scripts');

function fixture(t) {
  const root = temporary(t);
  const home = join(root, 'home');
  const project = join(root, 'project with spaces');
  mkdirSync(home);
  mkdirSync(project);
  const release = join(root, 'release');
  write(join(release, 'adapters/pi/index.ts'), 'export default function () {}');
  for (const name of ['plugin.yaml', '__init__.py', 'bridge.mjs']) write(join(release, 'adapters/hermes', name), `fixture ${name}`);
  const tools = join(root, 'tools');
  write(join(tools, 'node/bin/node'), '#!/bin/sh\n', 0o755);
  write(join(tools, 'node_modules/skills/bin/cli.mjs'));
  write(join(tools, 'node_modules/add-mcp/dist/index.js'));
  write(join(release, 'installation.json'), '{"app":"app"}');
  mkdirSync(join(release, 'app/resources'), { recursive: true });
  const f = { root, home, project, release, tools, command: ['/opt/lcu/current/bin/lcu', '--audio', '--chrome'], calls: [] };
  f.configure = async (name, { scope = 'user', run, executable = `/bin/${name}`, env = {} } = {}) => {
    override(t, setup.seams, 'which', () => executable);
    override(t, setup.seams, 'run', (command, args, options) => {
      f.calls.push({ argv: [command, ...args], options });
      return run ? run(command, args, options) : result(0);
    });
    await output(t);
    return setup.configure([name], home, f.command, tools, release, { scope, project: scope === 'project' ? project : null,
      environ: { PATH: '/bin', ...env } });
  };
  return f;
}

const files = (root) => Object.fromEntries(readdirSync(root, { recursive: true }).sort()
  .filter((name) => { try { readFileSync(join(root, name)); return true; } catch { return false; } })
  .map((name) => [name, readFileSync(join(root, name), 'utf8')]));

test('detect finds a harness by its executable', (t) => {
  override(t, setup.seams, 'which', (name) => (name === 'omp' ? '/mock/bin/omp' : null));
  assert.deepEqual(setup.detect(temporary(t)), ['omp']);
});

test('OMP links a per-profile package that imports the adapter relatively, with the command and no skill', async (t) => {
  const f = fixture(t);
  for (const profile of ['blue', 'green']) {
    assert.deepEqual(await f.configure('omp', { env: { OMP_PROFILE: profile } }), []);
    const { argv, options } = f.calls.at(-1);
    assert.deepEqual(argv.slice(0, 3), ['/bin/omp', 'plugin', 'link']);
    const pkg = argv[3];
    assert.deepEqual(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).omp.extensions, ['./index.ts']);
    const wrapper = readFileSync(join(pkg, 'index.ts'), 'utf8');
    const specifier = JSON.parse(wrapper.split('import lcu from ')[1].split(';')[0]);
    assert.ok(specifier.startsWith('.'));
    assert.equal(realpathSync(resolve(pkg, specifier)), join(f.release, 'adapters/pi/index.ts'));
    assert.ok(wrapper.includes(JSON.stringify(f.command)) && wrapper.includes('connectOnLoad: true') && wrapper.includes('ompEssentialTools: true'));
    assert.equal(existsSync(join(pkg, 'skills')), false);
    assert.equal(options.cwd, f.home);
    assert.equal(options.env.HOME, f.home);
  }
  assert.notEqual(f.calls[0].argv.at(-1), f.calls[1].argv.at(-1));
  assert.equal(existsSync(join(f.project, '.pi')), false);
});

test('OMP and Hermes refuse project scope, a missing executable, and relative profiles without installing', async (t) => {
  const f = fixture(t);
  let failures = await f.configure('omp', { scope: 'project' });
  assert.match(failures[0][2], /project scope is not supported/);
  assert.equal(f.calls.length, 0);
  failures = await f.configure('hermes', { scope: 'project' });
  assert.match(failures[0][2], /project scope is not supported/);
  assert.equal(existsSync(join(f.home, '.hermes')), false);
  failures = await f.configure('omp', { executable: null });
  assert.deepEqual(failures[0].slice(0, 2), ['omp', 'plugin']);
  assert.match(failures[0][2], /not on the target account PATH/);
  assert.equal(existsSync(join(f.home, '.local/share/lcu/omp')), false);
  await assert.rejects(f.configure('hermes', { env: { HERMES_HOME: 'relative/profile' } }), /must be absolute/);
  await assert.rejects(f.configure('omp', { env: { PI_CODING_AGENT_DIR: 'relative/profile' } }), /must be absolute/);
  failures = await f.configure('omp', { run: () => result(9, '', 'plugin failed') });
  assert.match(failures[0][2], /plugin failed/);
});

test('Hermes registers its local plugin and command under the selected profile', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.configure('hermes'), []);
  assert.deepEqual(f.calls[0].argv, ['/bin/hermes', 'plugins', 'enable', 'lcu-cua']);
  assert.equal(f.calls[0].options.env.HERMES_HOME, join(f.home, '.hermes'));
  const pkg = join(f.home, '.hermes/plugins/lcu-cua');
  assert.deepEqual(JSON.parse(readFileSync(join(pkg, 'lcu-config.json'), 'utf8')),
    { command: f.command, node: join(f.tools, 'node/bin/node'), bridge: join(f.release, 'adapters/hermes/bridge.mjs') });
  const profile = join(f.root, 'custom hermes profile');
  assert.deepEqual(await f.configure('hermes', { env: { HERMES_HOME: profile } }), []);
  assert.ok(existsSync(join(profile, 'plugins/lcu-cua/lcu-config.json')));
  assert.equal(f.calls.at(-1).options.env.HERMES_HOME, profile);
});

test('a symlinked or unowned plugin directory is never replaced', async (t) => {
  const f = fixture(t);
  const other = write(join(f.root, 'other-plugin/keep.txt'), 'untouched');
  mkdirSync(join(f.home, '.hermes/plugins'), { recursive: true });
  symlinkSync(join(f.root, 'other-plugin'), join(f.home, '.hermes/plugins/lcu-cua'));
  assert.match((await f.configure('hermes'))[0][2], /symlink/);
  assert.equal(readFileSync(other, 'utf8'), 'untouched');
  const g = fixture(t);
  const mine = write(join(g.home, '.hermes/plugins/lcu-cua/__init__.py'), 'user plugin');
  assert.match((await g.configure('hermes'))[0][2], /unowned plugin directory/);
  assert.equal(readFileSync(mine, 'utf8'), 'user plugin');
});

test('a failed re-registration restores the previous package', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.configure('hermes'), []);
  const pkg = join(f.home, '.hermes/plugins/lcu-cua');
  const previous = files(pkg);
  f.command = ['/changed/runtime'];
  const failures = await f.configure('hermes', { run: () => result(1, '', 'enable failed') });
  assert.match(failures[0][2], /enable failed/);
  assert.deepEqual(files(pkg), previous);
});
