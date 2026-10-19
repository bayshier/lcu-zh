import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { accountHome } from '../../lcu/fsutil.mjs';
import { asNonRoot, override, posixTests, temporary } from './fixtures.mjs';

const test = posixTests('POSIX homes, owners and symlinks');
const database = () => ({ homedir: '/database/home' });

test('accountHome uses $HOME when it is an owned directory without links', (t) => {
  const home = temporary(t);
  asNonRoot(t, home);
  assert.equal(accountHome({ HOME: home }, database), home);
  assert.equal(accountHome({ HOME: `${home}/` }, database), home);
});

test('accountHome falls back to the user database for an unusable $HOME', (t) => {
  const root = temporary(t);
  mkdirSync(join(root, 'real'));
  symlinkSync(join(root, 'real'), join(root, 'link'));
  for (const HOME of [undefined, '', 'relative/home', join(root, 'missing'), join(root, 'link'), `${root}/link/../real`,
    join(root, 'real\nx')]) {
    assert.equal(accountHome(HOME === undefined ? {} : { HOME }, database), '/database/home', String(HOME));
  }
  // A directory reached through a linked parent.
  mkdirSync(join(root, 'real/home'));
  assert.equal(accountHome({ HOME: join(root, 'link/home') }, database), '/database/home');
  // Owned by another account (root owns /).
  if (process.getuid() !== 0) assert.equal(accountHome({ HOME: '/' }, database), '/database/home');
});

test('accountHome ignores $HOME for root', (t) => {
  override(t, process, 'getuid', () => 0);
  assert.equal(accountHome({ HOME: temporary(t) }, database), '/database/home');
});
