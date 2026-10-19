import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO } from './fixtures.mjs';

test('the source tree carries no copied app instructions or in-app browser host', () => {
  for (const relative of ['instructions', 'skills/lcu/references', 'lcu/host']) {
    assert.equal(existsSync(join(REPO, relative)), false, relative);
  }
});
