import assert from 'node:assert/strict';
import { chmodSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { architecture, inventory, verify } from '../../scripts/bundle.mjs';
import { override, posixOnly, seal, temporary, write } from './fixtures.mjs';

function bundle(t) {
  const root = join(temporary(t), 'bundle');
  const binary = write(join(root, 'runtime/bin/node'), 'fixture binary', 0o755);
  symlinkSync('node', join(root, 'runtime/bin/alias'));
  seal(root, 'arm64');
  return { root, binary };
}

test('a file after a symlink still records its mode', { skip: posixOnly('POSIX file modes') }, (t) => {
  const files = inventory(bundle(t).root);
  assert.equal(files['runtime/bin/alias'].type, 'symlink');
  assert.equal(files['runtime/bin/node'].mode, 0o755);
});

test('a relocated bundle verifies', (t) => {
  const { root } = bundle(t);
  renameSync(root, `${root}-moved`);
  assert.equal(verify(`${root}-moved`, 'arm64').architecture, 'arm64');
});

test('modified, missing, injected and re-moded files are rejected', { skip: posixOnly('POSIX file modes') }, (t) => {
  for (const change of [
    ({ binary }) => writeFileSync(binary, 'corrupted'),
    ({ binary }) => unlinkSync(binary),
    ({ root }) => write(join(root, 'runtime/unexpected.js'), 'code'),
    ({ binary }) => chmodSync(binary, 0o644),
  ]) {
    const fixture = bundle(t);
    change(fixture);
    assert.throws(() => verify(fixture.root, 'arm64'), /integrity/);
  }
});

test('architecture, manifest shape, missing manifest and escaping links are refused', (t) => {
  const { root } = bundle(t);
  assert.throws(() => verify(root, 'x64'), /architecture arm64 does not match/);
  writeFileSync(join(root, 'bundle.json'), '[]');
  assert.throws(() => verify(root, 'arm64'), /manifest/);
  rmSync(join(root, 'bundle.json'));
  assert.throws(() => verify(root, 'arm64'), /extracted LCU release bundle/);
  unlinkSync(join(root, 'runtime/bin/alias'));
  symlinkSync('/bin/sh', join(root, 'runtime/bin/alias'));
  assert.throws(() => seal(root, 'arm64'), /Unsafe bundle symlink/);
});

test('a Windows bundle records no modes', (t) => {
  const root = join(temporary(t), 'windows');
  const launcher = write(join(root, 'bin/lcu.cmd'), 'fixture\r\n', 0o755);
  seal(root, 'x64', 'windows');
  chmodSync(launcher, 0o644);
  verify(root, 'x64', 'windows');
  writeFileSync(launcher, 'tampered\r\n');
  assert.throws(() => verify(root, 'x64', 'windows'), /integrity/);
});

test('the architecture follows the platform and Node architecture', (t) => {
  override(t, process, 'platform', 'win32');
  override(t, process, 'arch', 'arm64');
  assert.throws(() => architecture('windows'), /windows ARM64 or x86-64/);
  override(t, process, 'arch', 'x64');
  assert.equal(architecture('windows'), 'x64');
  assert.throws(() => architecture('linux'), /linux/);
});
