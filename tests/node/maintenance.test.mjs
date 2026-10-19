// `lcu prune` keeps the current and recent generations and refuses odd layouts.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { main } from '../../lcu/maintenance.mjs';
import { output, temporary, write } from './fixtures.mjs';

const GEN = '1.0.0-x64-0123456789abcdef';
const OTHER = '1.1.0-x64-fedcba9876543210';

function fixture(t) {
  const base = temporary(t);
  const prefix = join(base, 'opt/lcu');
  write(join(prefix, '.lcu-install'));
  const f = { base, prefix };
  f.generation = (name, windows = false) => {
    const path = join(prefix, 'apps', name, windows ? 'app' : 'payload/usr/lib/chatgpt');
    write(join(path, 'blob'), 'x'.repeat(4096));
    return path;
  };
  f.release = (name, generation, mtime, { windows = false, platform, app } = {}) => {
    const release = join(prefix, 'releases', name);
    mkdirSync(release, { recursive: true });
    let reference = app;
    if (!reference && windows) reference = join(prefix, 'apps', generation, 'app');
    else if (!reference) {
      reference = relative(release, join(prefix, 'apps', generation, 'payload/usr/lib/chatgpt'));
      symlinkSync(reference, join(release, 'app'));
    } else symlinkSync(app, join(release, 'app'));
    writeFileSync(join(release, 'installation.json'), JSON.stringify({ platform: platform ?? (windows ? 'windows' : 'linux'), app: reference }));
    utimesSync(release, mtime, mtime);
    return release;
  };
  f.current = (name) => symlinkSync(join('releases', name), join(prefix, 'current'));
  f.run = async (root, argv) => {
    const seen = await output(t);
    await main(root, argv);
    return seen.out;
  };
  f.names = (directory) => new Set(readdirSync(join(prefix, directory)));
  return f;
}

test('a dry run lists without deleting', async (t) => {
  const f = fixture(t);
  f.generation(GEN);
  const current = f.release('0.5.0-aaaaaaaaaaaa', GEN, 200);
  f.release('0.4.0-bbbbbbbbbbbb', GEN, 100);
  f.current('0.5.0-aaaaaaaaaaaa');
  const out = await f.run(current, ['--keep', '1']);
  assert.ok(out.includes('Would remove') && out.includes('0.4.0-bbbbbbbbbbbb'));
  assert.ok(out.includes('Rerun with --yes to delete. Restart or stop agents using older LCU releases first.'));
  assert.ok(existsSync(join(f.prefix, 'releases/0.4.0-bbbbbbbbbbbb')));
});

test('--yes deletes old releases and unreferenced generations, keeping the most recent by mtime', async (t) => {
  const f = fixture(t);
  f.generation(GEN);
  f.generation(OTHER);
  const current = f.release('0.6.0-aaaaaaaaaaaa', GEN, 300);
  f.release('0.5.0-bbbbbbbbbbbb', GEN, 200);
  f.release('0.4.0-cccccccccccc', OTHER, 100);
  f.current('0.6.0-aaaaaaaaaaaa');
  assert.match(await f.run(current, ['--keep', '2', '--yes']), /Removed/);
  assert.deepEqual(f.names('releases'), new Set(['0.6.0-aaaaaaaaaaaa', '0.5.0-bbbbbbbbbbbb']));
  assert.deepEqual(f.names('apps'), new Set([GEN]));
  await f.run(current, ['--keep', '1', '--yes']);
  assert.deepEqual(f.names('releases'), new Set(['0.6.0-aaaaaaaaaaaa']));
  assert.deepEqual(f.names('apps'), new Set([GEN]));
  assert.match(await f.run(current, ['--yes']), /Nothing to prune/);
});

test('the Windows layout uses current.json and absolute app paths', async (t) => {
  const f = fixture(t);
  f.generation('a'.repeat(64), true);
  f.generation('b'.repeat(64), true);
  const current = f.release('0.5.0-aaaaaaaaaaaa', 'a'.repeat(64), 200, { windows: true });
  f.release('0.4.0-bbbbbbbbbbbb', 'b'.repeat(64), 100, { windows: true });
  writeFileSync(join(f.prefix, 'current.json'), JSON.stringify({ release: '0.5.0-aaaaaaaaaaaa' }));
  await f.run(current, ['--keep', '1', '--yes']);
  assert.deepEqual(f.names('releases'), new Set(['0.5.0-aaaaaaaaaaaa']));
  assert.deepEqual(f.names('apps'), new Set(['a'.repeat(64)]));
});

test('an in-place Linux release reclaims earlier copies, but keeps a copy it still uses', async (t) => {
  const f = fixture(t);
  f.generation(GEN);
  const installed = join(f.base, 'usr/lib/chatgpt');
  mkdirSync(installed, { recursive: true });
  const current = f.release('0.8.0-aaaaaaaaaaaa', null, 300, { app: installed });
  f.release('0.7.0-bbbbbbbbbbbb', GEN, 200);
  f.current('0.8.0-aaaaaaaaaaaa');
  await f.run(current, ['--keep', '1', '--yes']);
  assert.deepEqual(f.names('releases'), new Set(['0.8.0-aaaaaaaaaaaa']));
  assert.deepEqual(f.names('apps'), new Set());
  assert.ok(existsSync(installed));
  const g = fixture(t);
  const old = g.generation(GEN);
  g.generation(OTHER);
  const using = g.release('0.8.0-aaaaaaaaaaaa', null, 300, { app: old });
  g.release('0.7.0-bbbbbbbbbbbb', GEN, 200);
  g.current('0.8.0-aaaaaaaaaaaa');
  await g.run(using, ['--keep', '1', '--yes']);
  assert.deepEqual(g.names('apps'), new Set([GEN]));
  assert.ok(existsSync(join(old, 'blob')));
});

test('macOS releases have no app generations', async (t) => {
  const f = fixture(t);
  const current = f.release('0.5.0-aaaaaaaaaaaa', null, 200, { platform: 'darwin', app: '/Applications/ChatGPT.app' });
  f.release('0.4.0-bbbbbbbbbbbb', null, 100, { platform: 'darwin', app: '/Applications/ChatGPT.app' });
  f.current('0.5.0-aaaaaaaaaaaa');
  await f.run(current, ['--keep', '1', '--yes']);
  assert.deepEqual(f.names('releases'), new Set(['0.5.0-aaaaaaaaaaaa']));
});

test('unexpected entries and a missing install marker are refused; usage errors exit 2', async (t) => {
  const f = fixture(t);
  f.generation(GEN);
  const current = f.release('0.5.0-aaaaaaaaaaaa', GEN, 200);
  f.current('0.5.0-aaaaaaaaaaaa');
  symlinkSync(current, join(f.prefix, 'releases/sneaky'));
  await assert.rejects(f.run(current, ['--yes']), /unexpected entry/);
  unlinkSync(join(f.prefix, 'releases/sneaky'));
  mkdirSync(join(f.prefix, 'releases/not-a-release'));
  await assert.rejects(f.run(current, ['--yes']), /unexpected entry/);
  unlinkSync(join(f.prefix, '.lcu-install'));
  await assert.rejects(f.run(current, ['--yes']), /Not an LCU installation/);
  assert.equal(await main(current, ['--keep', 'x']), 2);
  assert.equal(await main(current, ['--bogus']), 2);
});
