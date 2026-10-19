import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCuaClient } from '../client.mjs';
import { isolatedEnv } from './isolated-env.mjs';

// Run against a selected installed official application. This uses an isolated
// child home and only pure REPL arithmetic; it makes no desktop/browser call.
test('installed original CUA MCP starts, keeps JS state, and resets',
  { skip: !process.env.LCU_REAL_COMMAND }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'lcu-original-smoke-'));
    const bridge = createCuaClient({ command: JSON.parse(process.env.LCU_REAL_COMMAND),
      env: isolatedEnv(home, { NODE_REPL_DISABLE_ANALYTICS: '1' }) });
    try {
      await bridge.connect();
      assert.ok(bridge.instructions.length > 0);
      assert.match(bridge.instructions, /cua_repl|cua/i);
      assert.deepEqual(new Set(bridge.publicTools().map(tool => tool.name)), new Set(['js', 'js_reset']));
      for (const tool of bridge.publicTools()) {
        assert.ok(tool.description);
        assert.equal(tool.inputSchema.type, 'object');
      }
      const js = bridge.publicTools().find(tool => tool.name === 'js');
      assert.deepEqual(js.inputSchema.required, ['code']);
      assert.ok(js.inputSchema.properties.code);
      const first = await bridge.call('js', { code: 'var lcuSmokeValue = 6 * 7; nodeRepl.write(lcuSmokeValue);' },
        { sessionId: 'isolated-smoke', turnId: 'arithmetic' });
      assert.equal(first.isError, false);
      assert.match(first.content.map(item => item.text ?? '').join('\n'), /42/);
      const second = await bridge.call('js', { code: 'nodeRepl.write(lcuSmokeValue + 1);' },
        { sessionId: 'isolated-smoke', turnId: 'arithmetic' });
      assert.equal(second.isError, false);
      assert.match(second.content.map(item => item.text ?? '').join('\n'), /43/);
      await bridge.turnEnded({ sessionId: 'isolated-smoke', turnId: 'arithmetic' });
      const reset = await bridge.call('js_reset', {}, { sessionId: 'isolated-smoke', turnId: 'reset' });
      assert.equal(reset.isError, false);
    } finally {
      await bridge.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
