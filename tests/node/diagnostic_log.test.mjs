import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import * as adapters from '../../adapters/diagnostics.mjs';
import * as diagnosticLog from '../../lcu/diagnostic_log.mjs';

test('the settings match the adapters module that applies them', () => {
  assert.equal(diagnosticLog.RETENTION_DAYS, adapters.RETENTION_DAYS);
  assert.equal(diagnosticLog.MAX_TOTAL_MB * 1024 * 1024, adapters.MAX_TOTAL_BYTES);
  assert.equal(diagnosticLog.MAX_FILE_MB * 1024 * 1024, adapters.MAX_FILE_BYTES);
  for (const options of [{ env: {}, platform: 'darwin', home: '/h' }, { env: { XDG_STATE_HOME: '/s' }, platform: 'linux', home: '/h' }]) {
    assert.equal(diagnosticLog.directory(options), adapters.diagnosticLogDirectory(options));
  }
});

test('the directory follows the platform, XDG and the override', () => {
  assert.equal(diagnosticLog.directory({ env: {}, platform: 'darwin', home: '/h' }), join('/h', 'Library', 'Logs', 'LCU'));
  assert.equal(diagnosticLog.directory({ env: {}, platform: 'linux', home: '/h' }), join('/h', '.local', 'state', 'lcu', 'logs'));
  assert.equal(diagnosticLog.directory({ env: { XDG_STATE_HOME: '/s' }, platform: 'linux', home: '/h' }), join('/s', 'lcu', 'logs'));
  assert.equal(diagnosticLog.directory({ env: { LCU_LOG_DIR: '/o', XDG_STATE_HOME: '/s' }, platform: 'darwin', home: '/h' }), '/o');
});

test('turning the log off is reported', () => {
  assert.equal(diagnosticLog.status({ env: {}, platform: 'linux', home: '/h' }).enabled, true);
  assert.equal(diagnosticLog.status({ env: { LCU_DIAGNOSTIC_LOG: '0' } }).enabled, false);
  assert.match(diagnosticLog.summary({ env: { LCU_DIAGNOSTIC_LOG: '0' } }), /off/);
  const summary = diagnosticLog.summary({ env: {}, platform: 'linux', home: '/h' });
  assert.ok(summary.includes(`${join('/h', '.local', 'state', 'lcu', 'logs')} `), summary);
  assert.match(summary, /7 days/);
});
