import assert from 'node:assert/strict';
import { symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { locateCodexTools } from '../../lcu/app_layout.mjs';
import { readAsarMembers, listAsarMembers } from '../../lcu/asar.mjs';
import { temporary, write, writeAsar } from './fixtures.mjs';

const pair = (resources, relative, suffix = '') => [
  write(join(resources, relative, `codex${suffix}`), 'original Codex CLI'),
  write(join(resources, relative, `codex-code-mode-host${suffix}`), 'original code-mode host'),
];

test('legacy and relocated original pairs are found', (t) => {
  for (const relative of ['.', 'codex-cli/bin']) {
    const resources = join(temporary(t), 'Resources');
    const [cli, codeModeHost] = pair(resources, relative);
    assert.deepEqual(locateCodexTools(resources), { cli, codeModeHost });
  }
});

test('Windows executables are found', (t) => {
  const resources = join(temporary(t), 'Resources');
  const [cli, codeModeHost] = pair(resources, 'codex-cli/bin', '.exe');
  assert.deepEqual(locateCodexTools(resources, { windows: true }), { cli, codeModeHost });
});

test('partial and symlinked layouts are refused', (t) => {
  const resources = join(temporary(t), 'Resources');
  const [cli] = pair(resources, 'codex-cli/bin');
  unlinkSync(join(resources, 'codex-cli/bin/codex-code-mode-host'));
  const [legacy] = pair(resources, '.');
  unlinkSync(legacy);
  assert.throws(() => locateCodexTools(resources), /complete original Codex CLI layout/);
  const external = write(join(resources, '../external-codex'), 'outside app');
  unlinkSync(cli);
  symlinkSync(external, cli);
  writeFileSync(join(resources, 'codex-cli/bin/codex-code-mode-host'), 'host');
  assert.throws(() => locateCodexTools(resources), /complete original Codex CLI layout/);
});

test('two complete layouts are ambiguous', (t) => {
  const resources = join(temporary(t), 'Resources');
  pair(resources, '.');
  pair(resources, 'codex-cli/bin');
  assert.throws(() => locateCodexTools(resources), /Ambiguous original Codex CLI layout/);
});

test('ASAR members are listed and read within their bounds', (t) => {
  const archive = join(temporary(t), 'app.asar');
  writeAsar(archive, { 'package.json': '{"version":"1"}', '.vite/build/main.js': 'main' });
  assert.deepEqual(listAsarMembers(archive), ['.vite/build/main.js', 'package.json']);
  assert.equal(readAsarMembers(archive, ['.vite/build/main.js'])['.vite/build/main.js'].toString(), 'main');
  assert.throws(() => readAsarMembers(archive, ['missing.js']), /ASAR member is missing/);
  assert.throws(() => readAsarMembers(archive, ['../package.json']), /Invalid ASAR member path/);
  writeFileSync(archive, Buffer.alloc(8));
  assert.throws(() => listAsarMembers(archive), /ASAR header is truncated/);
});
