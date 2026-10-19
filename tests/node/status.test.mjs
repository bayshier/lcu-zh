import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { main } from '../../lcu/status.mjs';
import { asNonRoot, linuxApp, output, override, posixTests, temporary, write } from './fixtures.mjs';

const test = posixTests('the Linux release layout, whose app is a symlink');

function release(t) {
  const base = temporary(t);
  override(t, process.env, 'HOME', join(base, 'home'));
  override(t, process.env, 'XDG_CACHE_HOME', join(base, 'home/.cache'));
  override(t, process.env, 'LCU_NO_UPDATE_CHECK', '1');
  mkdirSync(join(base, 'home'));
  const root = join(base, 'prefix/releases/r1');
  const app = linuxApp(join(base, 'chatgpt'), { runtimeVersion: 'runtime-new' });
  mkdirSync(root, { recursive: true });
  symlinkSync(app, join(root, 'app'));
  write(join(root, 'runtime.lock.json'), JSON.stringify({ architectures: { arm64: { sha256: '0'.repeat(64) } } }));
  write(join(root, 'installation.json'), JSON.stringify({ app, architecture: 'arm64', package_version: '26.924.22138', runtime: 'runtime-new' }));
  write(join(root, 'bundle.json'), JSON.stringify({ version: '0.9.8' }));
  write(join(root, 'tested-versions.json'), JSON.stringify({ format: 1, entries: [{ platform: 'linux', architecture: 'arm64',
    app_version: '26.924.22138', runtime: 'runtime-new', lcu_version: '0.9.7' }] }));
  return { root, app };
}

test('status reports the release, the observed app and the tested pair', { skip: process.platform !== 'linux' }, async (t) => {
  const { root } = release(t);
  asNonRoot(t, process.env.HOME);
  const seen = await output(t);
  assert.equal(await main(root, ['--json']), 0);
  const status = JSON.parse(seen.out);
  assert.equal(status.lcu_version, '0.9.8');
  assert.deepEqual([status.platform, status.architecture], ['linux', 'arm64']);
  assert.deepEqual([status.app.version, status.app.runtime], ['26.924.22138', 'runtime-new']);
  assert.equal(status.compatibility.status, 'tested');
  assert.equal(status.changed_since_install, null);
  assert.deepEqual([status.setup, status.pending, status.update], [null, [], null]);
  assert.deepEqual(status.cross_turn, { enabled: false, source: null });
  seen.out = '';
  assert.equal(await main(root, []), 0);
  assert.match(seen.out, /^LCU 0\.9\.8 \(linux arm64\)\.\nOriginal app: ChatGPT 26\.924\.22138 \(CUA runtime-new\)[\s\S]*Tested pair: yes[\s\S]*Cross-turn Computer Use: off\./);
  write(join(process.env.HOME, '.local/state/lcu/cross-turn.json'), JSON.stringify({ enabled: true, source: 'owner' }));
  seen.out = '';
  assert.equal(await main(root, ['--json']), 0);
  assert.deepEqual(JSON.parse(seen.out).cross_turn, { enabled: true, source: 'owner' });
});

test('status exits 1 without a selected app and 2 on a usage error', async (t) => {
  const base = temporary(t);
  const seen = await output(t);
  assert.equal(await main(base, ['--json']), 1);
  assert.match(JSON.parse(seen.out).error, /installation\.json is missing/);
  assert.equal(await main(base, ['--bogus']), 2);
});
