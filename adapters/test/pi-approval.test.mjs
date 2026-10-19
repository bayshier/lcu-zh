import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import piExtension from '../pi/index.ts';

const fixture = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url));
const origin = 'http://127.0.0.1:8080';
let session = 0;

async function withPi({ allowedOrigins = [], hasUI = true, ui } = {}, run) {
  const oldCommand = process.env.LCU_MCP_COMMAND;
  const oldOrigins = process.env.LCU_APPROVED_ORIGINS;
  const oldLog = process.env.LCU_FIXTURE_LOG;
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, fixture]);
  process.env.LCU_APPROVED_ORIGINS = JSON.stringify(allowedOrigins);
  delete process.env.LCU_FIXTURE_LOG;

  const handlers = new Map();
  const tools = new Map();
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
  };
  const ctx = {
    sessionManager: { getSessionId: () => `pi-origin-session-${++session}` },
    model: { id: 'pi-model' },
    hasUI,
    ...(ui ? { ui } : {}),
  };
  let started = false;
  try {
    piExtension(pi);
    await handlers.get('before_agent_start')({ systemPrompt: 'Pi approval fixture' }, ctx);
    await handlers.get('agent_start')({}, ctx);
    started = true;
    const execute = async code => {
      const result = await tools.get('js').execute('approval-test', { code }, undefined, undefined, ctx);
      return JSON.parse(result.content[0].text);
    };
    return await run({ execute });
  } finally {
    if (started) {
      await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
    }
    await handlers.get('session_shutdown')?.();
    if (oldCommand === undefined) delete process.env.LCU_MCP_COMMAND;
    else process.env.LCU_MCP_COMMAND = oldCommand;
    if (oldOrigins === undefined) delete process.env.LCU_APPROVED_ORIGINS;
    else process.env.LCU_APPROVED_ORIGINS = oldOrigins;
    if (oldLog === undefined) delete process.env.LCU_FIXTURE_LOG;
    else process.env.LCU_FIXTURE_LOG = oldLog;
  }
}

test('Pi maps original browser-origin accept, decline, and dismissal to distinct MCP responses', async () => {
  const prompts = [];
  let selection;
  await withPi({ ui: {
    async select(message, options) {
      prompts.push({ message, options });
      return selection;
    },
  } }, async ({ execute }) => {
    selection = 'Allow';
    assert.deepEqual(await execute('pi-origin-approval'), { action: 'accept', content: {} });
    selection = 'Decline';
    assert.deepEqual(await execute('pi-origin-approval'), { action: 'decline' });
    selection = undefined;
    assert.deepEqual(await execute('pi-origin-approval'), { action: 'cancel' });
  });
  assert.deepEqual(prompts, Array.from({ length: 3 }, () => ({
    message: `Allow Browser use to access ${origin}?`,
    options: ['Allow', 'Decline'],
  })));
});

test('Pi treats a dismissed empty-form approval as cancel, not decline', async () => {
  await withPi({ ui: {
    // Pi confirm returns false both for No and when the dialog is dismissed.
    async confirm() { return false; },
    async select() { return undefined; },
  } }, async ({ execute }) => {
    assert.deepEqual(await execute('pi-origin-approval'), { action: 'cancel' });
  });
});

test('Pi cancels a browser-origin request when the host has no interactive UI', async () => {
  await withPi({ hasUI: false }, async ({ execute }) => {
    assert.deepEqual(await execute('pi-origin-approval'), { action: 'cancel' });
  });
});

test('Pi auto-accepts only the exact preauthorized origin', async () => {
  await withPi({ allowedOrigins: [origin], ui: {
    async select() { assert.fail('Exact origin preauthorization should bypass the prompt'); },
  } }, async ({ execute }) => {
    assert.deepEqual(await execute('pi-origin-approval'), { action: 'accept', content: {} });
  });

  const prompts = [];
  await withPi({ allowedOrigins: [origin], ui: {
    async select(message, options) {
      prompts.push({ message, options });
      return 'Decline';
    },
  } }, async ({ execute }) => {
    assert.deepEqual(await execute('pi-origin-lookalike'), { action: 'decline' });
  });
  assert.deepEqual(prompts, [{
    message: 'Allow Browser use to access http://127.0.0.1.attacker.invalid:8080?',
    options: ['Allow', 'Decline'],
  }]);
});

test('an unrelated empty form still asks Pi when a browser origin is preauthorized', async () => {
  const prompts = [];
  await withPi({ allowedOrigins: [origin], ui: {
    async select(message, options) {
      prompts.push({ message, options });
      return 'Decline';
    },
  } }, async ({ execute }) => {
    assert.deepEqual(await execute('pi-origin-other-empty'), { action: 'decline' });
  });
  assert.deepEqual(prompts, [{
    message: 'Allow Browser use to use your browsing history for this task?',
    options: ['Allow', 'Decline'],
  }]);
});
