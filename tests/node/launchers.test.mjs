// The /bin/sh launchers, run for real against a copy of the tree (docs/REMOVE-PYTHON.md, "Launcher contract").
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO, posixTests, temporary } from './fixtures.mjs';

const test = posixTests('bin/lcu, lcu-session and lcu-codex-sandbox are sh launchers');

function tree(t) {
  const base = temporary(t);
  const root = join(base, 'release');
  for (const part of ['bin', 'lcu']) cpSync(join(REPO, part), join(root, part), { recursive: true });
  const node = join(base, 'node dir with spaces/node');
  mkdirSync(join(node, '..'));
  symlinkSync(process.execPath, node);
  return { base, root, node, nodePath: join(root, 'node-path') };
}

const run = (launcher, args = [], env = {}) => spawnSync(launcher, args, { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
const version = (r, env) => run(join(r.root, 'bin/lcu'), ['--version'], env);
const usage = readFileSync(join(REPO, 'lcu/usage.txt'), 'utf8');

test('the recorded Node runs, with or without a trailing newline, from a path with spaces', (t) => {
  const r = tree(t);
  for (const content of [`${r.node}\n`, r.node]) {
    writeFileSync(r.nodePath, content);
    const result = version(r);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^lcu source-checkout \(ChatGPT linux app not selected\)$/m);
  }
  const shim = run(join(r.root, 'bin/lcu-codex-sandbox'), ['--version']);
  assert.equal(shim.status, 70, 'the sandbox shim ran, and refused without its configuration');
  const session = run(join(r.root, 'bin/lcu-session'), ['--help']);
  assert.equal(session.status, 0);
  assert.match(session.stdout, /Usage: lcu-session/);
});

test('without node-path LCU_NODE is used; with one, LCU_NODE is ignored', (t) => {
  const r = tree(t);
  assert.equal(version(r, { LCU_NODE: r.node }).status, 0);
  const unset = version(r);
  assert.equal(unset.status, 1);
  assert.match(unset.stderr, /^LCU: this LCU tree records no Node \(node-path\) and LCU_NODE is not set/);
  const bad = version(r, { LCU_NODE: join(r.base, 'missing') });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^LCU: LCU_NODE \(.*missing\) is not an executable file/);
  writeFileSync(r.nodePath, join(r.base, 'missing-node'));
  const ignored = version(r, { LCU_NODE: r.node });
  assert.equal(ignored.status, 1);
  assert.match(ignored.stderr, /^LCU: the ChatGPT app's Node \(.*missing-node\) is missing or not executable/);
  writeFileSync(r.nodePath, '');
  assert.equal(version(r, { LCU_NODE: r.node }).status, 1, 'an empty record does not fall back either');
});

test('a recorded Node that is not executable, or a directory, is refused', (t) => {
  const r = tree(t);
  const plain = join(r.base, 'plain-node');
  writeFileSync(plain, '#!/bin/sh\necho ran\n');
  chmodSync(plain, 0o644);
  for (const target of [plain, join(r.base, 'node dir with spaces')]) {
    writeFileSync(r.nodePath, target);
    const result = version(r);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing or not executable/);
    assert.equal(result.stdout, '');
  }
  const session = run(join(r.root, 'bin/lcu-session'), ['--help']);
  assert.match(session.stderr, /^LCU session: /);
});

test('an unreadable node-path is an error, never a fallback', { skip: process.getuid?.() === 0 && 'root reads every file' }, (t) => {
  const r = tree(t);
  writeFileSync(r.nodePath, r.node);
  chmodSync(r.nodePath, 0);
  const result = version(r, { LCU_NODE: r.node });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LCU: cannot read .*node-path/);
});

test('without a usable Node only plain `lcu --help` / `lcu -h` prints the usage', (t) => {
  const r = tree(t);
  for (const flag of ['--help', '-h']) {
    const result = run(join(r.root, 'bin/lcu'), [flag]);
    assert.deepEqual([result.status, result.stdout], [0, usage]);
  }
  for (const args of [['--chrome', '--help'], ['--help', 'extra'], ['setup', '--help'], []]) {
    const result = run(join(r.root, 'bin/lcu'), args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
  }
  writeFileSync(r.nodePath, r.node);
  const real = run(join(r.root, 'bin/lcu'), ['--help']);
  assert.deepEqual([real.status, real.stdout], [0, usage], 'Node prints the same text');
});

test('a relative symlink to the launcher finds its release', (t) => {
  const r = tree(t);
  writeFileSync(r.nodePath, r.node);
  mkdirSync(join(r.base, 'links'));
  symlinkSync('../release/bin/lcu', join(r.base, 'links/lcu'));
  symlinkSync('lcu', join(r.base, 'links/lcu-again'));
  for (const name of ['lcu', 'lcu-again']) {
    const result = run(join(r.base, 'links', name), ['--version']);
    assert.equal(result.status, 0, result.stderr);
  }
  const relative = spawnSync('./lcu', ['--version'], { cwd: join(r.base, 'links'), encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(relative.status, 0, relative.stderr);
});
