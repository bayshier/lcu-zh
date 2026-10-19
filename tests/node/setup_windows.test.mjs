// Windows setup: the registered account only, direct sessions, no portable export (from tests/test_windows_setup.py).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import * as setup from '../../lcu/setup.mjs';
import { override, temporary } from './fixtures.mjs';

test('Windows setup configures the signed-in account with direct sessions and no export',
  { skip: process.platform !== 'win32' && 'Windows only: lcu/setup.mjs fixes its platform when it loads' }, (t) => {
    const home = temporary(t);
    override(t, setup.seams, 'account', () => ({ name: 'Fixture', home }));
    const check = (...argv) => setup.validate(setup.parse(['--prefix', join(home, 'LCU'), ...argv]));
    const { account, names } = check('--agent', 'codex', '--session', 'direct');
    assert.deepEqual([account.home, names], [home, ['codex']]);
    assert.deepEqual(check('--agent', 'codex').names, ['codex']); // direct is the Windows default
    assert.deepEqual(check('--agent', 'codex', '--user', 'fixture').names, ['codex']);
    assert.throws(() => check('--agent', 'codex', '--session', 'discover'), /--session direct/);
    assert.throws(() => check('--agent', 'codex', '--user', 'someone-else'), /current signed-in account/);
    assert.throws(() => check('--export', join(home, 'export')), /Windows portable export/);
  });
