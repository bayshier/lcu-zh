import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  callWithDeadline, createApprovalGate, createCuaClient, createWorkerTurns, nativeAppApprovalOptions,
  nativeAppApprovalResponse, relayElicitation, sendControlRequest, TURN_CLEANUP_TIMEOUT_CODE,
} from '../client.mjs';

// Host control is a macOS feature, but sendControlRequest only needs a net
// endpoint; Windows has no Unix sockets in temp directories, so use a pipe.
const controlEndpoint = directory => process.platform === 'win32'
  ? `\\\\.\\pipe\\${directory.split(/[\\/]/).at(-1)}`
  : join(directory, 'control.sock');

const command = [process.execPath, fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url))];

const nativeApproval = (persist = ['session', 'always']) => ({
  mode: 'form',
  message: 'Allow Computer Use to use "LCU Fixture App"?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: {
    codex_approval_kind: 'mcp_tool_call',
    connector_id: 'computer-use',
    persist,
    tool_name: 'get_app_state',
    tool_params: { app: 'dev.lcu.NativeFixture.generated' },
  },
});

test('keeps original tool descriptors and initialization instructions; hides internal tools', async () => {
  const bridge = createCuaClient({ command });
  try {
    await bridge.connect();
    assert.equal(bridge.instructions, 'Original CUA initialization guide.');
    assert.deepEqual(bridge.publicTools().map(tool => tool.name), ['js', 'js_reset']);
    assert.equal(bridge.publicTools()[0].description, 'Original JS description.');
    assert.deepEqual(bridge.publicTools()[0].inputSchema.required, ['code']);
    await assert.rejects(bridge.call('turn_ended', {}, { sessionId: 's', turnId: 't' }), /reserved/);
    await assert.rejects(bridge.call('js', { code: 'x' }), /real host session/);
    const result = await bridge.call('js', { code: 'x' }, { sessionId: 'real-session', turnId: 'real-turn' });
    assert.deepEqual(result.content, [{ type: 'text', text: 'x' }]);
    await bridge.turnEnded({ sessionId: 'real-session', turnId: 'real-turn' });
    await assert.rejects(bridge.turnEnded({ sessionId: 'fail-session', turnId: 'real-turn' }),
      /cleanup failed/);
  } finally { await bridge.close(); }
});

test('turnEnded reports the host turn-ended timeout as a typed, retryable error', async () => {
  const bridge = createCuaClient({ command });
  try {
    await bridge.connect();
    await assert.rejects(bridge.turnEnded({ sessionId: 'timeout-1-session', turnId: 't1' }), error => {
      assert.equal(error.code, TURN_CLEANUP_TIMEOUT_CODE);
      assert.equal(error.code, 'LCU_TURN_CLEANUP_TIMEOUT');
      assert.match(error.message, /may still be finishing in the background/);
      assert.match(error.message, /retried before the next action/);
      return true;
    });
    // The same cleanup succeeds once the worker has finished it.
    await bridge.turnEnded({ sessionId: 'timeout-1-session', turnId: 't1' });
    await assert.rejects(bridge.turnEnded({ sessionId: 'fail-session', turnId: 't2' }),
      error => error.code === undefined && /cleanup failed/.test(error.message));
  } finally { await bridge.close(); }
});

test('forwards real call context and retains unrelated caller metadata', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-client-context-'));
  const oldLog = process.env.LCU_FIXTURE_LOG;
  const log = join(directory, 'mcp.jsonl');
  process.env.LCU_FIXTURE_LOG = log;
  const bridge = createCuaClient({ command });
  try {
    await bridge.connect();
    await bridge.call('js', { code: 'context' }, {
      sessionId: 'host-session', turnId: 'host-turn', toolCallId: 'host-call',
      threadId: 'host-thread', threadSource: 'subagent',
      chatgptConversationId: 'host-conversation', model: 'host-model', reasoningEffort: 'high',
      metadata: {
        'openai/confirmation_policies': { computer_use: 'confirm' },
        'sandbox/policy': { mode: 'workspace-write' },
        'x-codex-turn-metadata': { caller_field: 'retained', item_id: 'host-item' },
      },
    });
    const entry = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert.deepEqual(entry.meta, {
      'openai/confirmation_policies': { computer_use: 'confirm' },
      'sandbox/policy': { mode: 'workspace-write' },
      'x-codex-turn-metadata': {
        caller_field: 'retained', item_id: 'host-item', session_id: 'host-session', turn_id: 'host-turn',
        call_id: 'host-call', thread_id: 'host-thread', thread_source: 'subagent',
        chatgpt_conversation_id: 'host-conversation', model: 'host-model', reasoning_effort: 'high',
      },
    });
  } finally {
    await bridge.close();
    if (oldLog === undefined) delete process.env.LCU_FIXTURE_LOG;
    else process.env.LCU_FIXTURE_LOG = oldLog;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('host-control requests use the private newline JSON protocol and surface original errors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-control-contract-'));
  const socketPath = controlEndpoint(directory);
  const requests = [];
  let rejectNext = false;
  const server = createServer(socket => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', data => {
      input += data;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      requests.push(request);
      if (rejectNext) {
        socket.end(`${JSON.stringify({ ok: false, error: 'active turn mismatch' })}\n`);
        return;
      }
      const result = request.type === 'status'
        ? { computerUse: { activeApplications: [{ id: 'app-1', name: 'Fixture', bundleIdentifier: 'dev.lcu.fixture' }] } }
        : { accepted: true, applicationId: request.app };
      socket.end(`${JSON.stringify({ ok: true, result })}\n`);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const status = await sendControlRequest(socketPath, {
      type: 'status', session_id: 'active-session', turn_id: 'active-turn',
    });
    assert.equal(status.computerUse.activeApplications[0].bundleIdentifier, 'dev.lcu.fixture');
    const stopped = await sendControlRequest(socketPath, {
      type: 'stop', session_id: 'active-session', turn_id: 'active-turn', app: 'dev.lcu.fixture',
    });
    assert.deepEqual(stopped, { accepted: true, applicationId: 'dev.lcu.fixture' });
    assert.deepEqual(requests, [
      { type: 'status', session_id: 'active-session', turn_id: 'active-turn' },
      { type: 'stop', session_id: 'active-session', turn_id: 'active-turn', app: 'dev.lcu.fixture' },
    ]);

    rejectNext = true;
    await assert.rejects(sendControlRequest(socketPath, {
      type: 'stop', session_id: 'foreign-session', turn_id: 'foreign-turn', app: 'dev.lcu.fixture',
    }), /active turn mismatch/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('host-control client expires an unresponsive request at its finite outer deadline', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-control-deadline-'));
  const socketPath = controlEndpoint(directory);
  let received;
  const requestReceived = new Promise(resolve => { received = resolve; });
  const server = createServer(socket => socket.once('data', received));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = sendControlRequest(socketPath, {type: 'status'});
    await requestReceived;
    t.mock.timers.tick(45_000);
    await assert.rejects(pending, /LCU host-control request timed out/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('macOS control endpoint is optional, private to a live client, and unavailable after close',
  { skip: process.platform === 'win32' && 'the macOS host-control endpoint is a Unix socket' }, async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
  const bridge = createCuaClient({ command });
  try {
    assert.equal(bridge.hasHostControl, false);
    await bridge.connect();
    assert.equal(bridge.hasHostControl, true);
    await bridge.close();
    assert.equal(bridge.hasHostControl, false);
    await assert.rejects(bridge.controlStatus({ sessionId: 'session', turnId: 'turn' }), /after the client closes/);
  } finally {
    await bridge.close().catch(() => {});
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
});

test('elicitation is denied by default and exact authorized origins are accepted', async () => {
  for (const [allowedOrigins, expected] of [
    [[], 'cancel'], [['http://127.0.0.1:8080'], 'accept'],
  ]) {
    const bridge = createCuaClient({ command, allowedOrigins });
    try {
      await bridge.connect();
      const result = await bridge.call('js', { code: 'approval' }, { sessionId: 's', turnId: 't' });
      assert.equal(result.content[0].text, expected);
    } finally { await bridge.close(); }
  }
  const seen = [];
  const bridge = createCuaClient({ command, allowedOrigins: ['https://different.example'],
    onElicitation: async params => { seen.push(params); return { action: 'decline' }; } });
  try {
    await bridge.connect();
    const result = await bridge.call('js', { code: 'approval' }, { sessionId: 's', turnId: 't' });
    assert.equal(result.content[0].text, 'decline');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]._meta.origin, 'http://127.0.0.1:8080');
  } finally { await bridge.close(); }
  assert.throws(() => createCuaClient({ command, allowedOrigins: ['http://127.0.0.1:8080/'] }), /exact HTTP/);
});

test('native app approval choices preserve resource identity and only offered persistence scopes', () => {
  const request = nativeApproval();
  const options = nativeAppApprovalOptions(request);
  assert.deepEqual(options, {
    message: request.message,
    resource: 'dev.lcu.NativeFixture.generated',
    choices: [
      { value: 'once', label: 'Allow once' },
      { value: 'session', label: 'Allow for this session' },
      { value: 'always', label: 'Always allow' },
      { value: 'decline', label: 'Decline' },
    ],
  });
  assert.deepEqual(nativeAppApprovalResponse(request, 'once'), { action: 'accept', content: {} });
  assert.deepEqual(nativeAppApprovalResponse(request, 'session'), {
    action: 'accept', content: {}, _meta: { persist: 'session' },
  });
  assert.deepEqual(nativeAppApprovalResponse(request, 'always'), {
    action: 'accept', content: {}, _meta: { persist: 'always' },
  });
  assert.deepEqual(nativeAppApprovalResponse(request, 'decline'), { action: 'decline' });
  assert.deepEqual(nativeAppApprovalResponse(request, 'cancel'), { action: 'cancel' });

  const sessionOnly = nativeApproval(['session']);
  assert.deepEqual(nativeAppApprovalOptions(sessionOnly).choices.map(choice => choice.value),
    ['once', 'session', 'decline']);
  assert.deepEqual(nativeAppApprovalResponse(sessionOnly, 'always'), { action: 'cancel' });
  assert.deepEqual(nativeAppApprovalResponse(nativeApproval([]), 'session'), { action: 'cancel' });
});

test('native app approval classifier leaves unrelated or unsupported elicitations unchanged', () => {
  const base = nativeApproval();
  for (const params of [
    { ...base, mode: 'url' },
    { ...base, requestedSchema: { type: 'object', properties: { secret: { type: 'string' } } } },
    { ...base, _meta: { ...base._meta, connector_id: 'browser' } },
    { ...base, _meta: { ...base._meta, tool_params: {} } },
    { mode: 'form', message: 'Other empty form', requestedSchema: { type: 'object', properties: {} }, _meta: {} },
  ]) {
    assert.equal(nativeAppApprovalOptions(params), undefined);
    assert.deepEqual(nativeAppApprovalResponse(params, 'always'), { action: 'cancel' });
  }
  const malformedScopes = { ...base, _meta: { ...base._meta, persist: 'always' } };
  assert.deepEqual(nativeAppApprovalOptions(malformedScopes).choices.map(choice => choice.value),
    ['once', 'decline']);
  assert.deepEqual(nativeAppApprovalResponse(malformedScopes, 'always'), { action: 'cancel' });
});

const flush = () => new Promise(resolve => setImmediate(resolve));

async function elicitationPair(answer) {
  const server = new Server({ name: 'relay', version: '1' }, { capabilities: {} });
  const client = new Client({ name: 'host', version: '1' }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, answer);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { server, close: () => client.close() };
}

test('a forwarded approval outlives the default 60 s request timeout', async t => {
  let answer;
  const answered = new Promise(resolve => { answer = resolve; });
  const { server, close } = await elicitationPair(() => answered);
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const pending = relayElicitation(server, createApprovalGate(), nativeApproval(), undefined);
    await flush();
    t.mock.timers.tick(10 * 60_000);
    answer({ action: 'accept', content: {} });
    assert.deepEqual(await pending, { action: 'accept', content: {} });
  } finally { await close(); }
});

test('an abandoned forwarded approval is cancelled when its signal aborts', async t => {
  const { server, close } = await elicitationPair(() => new Promise(() => {}));
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const controller = new AbortController();
    const pending = relayElicitation(server, createApprovalGate(), nativeApproval(), controller.signal);
    await flush();
    controller.abort(new Error('interrupted'));
    await assert.rejects(pending, /interrupted/);
  } finally { await close(); }
});

test('a tool-call deadline stands still while an approval is pending and still expires afterwards', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const gate = createApprovalGate();
  let finish;
  const call = callWithDeadline(gate, 120_000, undefined, signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    finish = resolve;
  }));
  t.mock.timers.tick(100_000);
  let decide;
  const approval = gate.track(() => new Promise(resolve => { decide = resolve; }));
  t.mock.timers.tick(10 * 60_000);
  decide();
  await approval;
  t.mock.timers.tick(19_999);
  finish('done');
  assert.equal(await call, 'done');

  const hung = callWithDeadline(gate, 120_000, undefined, signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  t.mock.timers.tick(120_000);
  await assert.rejects(hung, /Request timed out/);
});

test('aborting a tool call cancels the approval it is waiting on', async () => {
  let seen;
  const bridge = createCuaClient({ command, onElicitation: params => new Promise(resolve => {
    seen = resolve;
  }) });
  const controller = new AbortController();
  try {
    await bridge.connect();
    const call = bridge.call('js', { code: 'approval' }, { sessionId: 's', turnId: 't', signal: controller.signal });
    while (!seen) await flush();
    controller.abort(new Error('interrupted'));
    await assert.rejects(call, /interrupted/);
  } finally { await bridge.close(); }
});

test('an approval for an app hosting the agent is declined without asking the host', async () => {
  const seen = [];
  const bridge = createCuaClient({ command, onElicitation: async params => { seen.push(params); return { action: 'accept', content: {} }; } });
  try {
    await bridge.connect();
    const result = await bridge.call('js', { code: 'approval-native-host' }, { sessionId: 's', turnId: 't' });
    assert.deepEqual(JSON.parse(result.content[0].text), { action: 'decline' });
    assert.equal(seen.length, 0);
  } finally { await bridge.close(); }
});

test('js_reset ends every turn that ran js upstream first, then continues it under a fresh id', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-client-reset-'));
  const oldLog = process.env.LCU_FIXTURE_LOG;
  const log = join(directory, 'mcp.jsonl');
  process.env.LCU_FIXTURE_LOG = log;
  const bridge = createCuaClient({ command });
  try {
    await bridge.connect();
    const records = () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    await bridge.call('js', { code: 'a' }, { sessionId: 's', turnId: 'used' });
    await bridge.call('js', { code: 'b' }, { sessionId: 's2', turnId: 'other' });
    await bridge.call('js_reset', {}, { sessionId: 's', turnId: 'used' });
    const resetAt = records().findIndex(entry => entry.name === 'js_reset');
    assert.deepEqual(records().slice(2, resetAt).map(entry => [entry.name, entry.args.hook_event_name,
      entry.args.session_id, entry.args.turn_id]).sort(),
    [['turn_ended', 'Interrupt', 's', 'used'], ['turn_ended', 'Interrupt', 's2', 'other']]);
    const fresh = records()[resetAt].meta['x-codex-turn-metadata'].turn_id;
    assert.notEqual(fresh, 'used');
    await bridge.call('js', { code: 'c' }, { sessionId: 's', turnId: 'used' });
    assert.equal(records().at(-1).meta['x-codex-turn-metadata'].turn_id, fresh);
    await bridge.turnEnded({ sessionId: 's', turnId: 'used' });
    assert.equal(records().at(-1).args.turn_id, fresh);
    // A second reset ends only turns that ran js since the first.
    const before = records().length;
    await bridge.call('js_reset', {}, { sessionId: 's3', turnId: 'idle' });
    assert.deepEqual(records().slice(before).map(entry => entry.name), ['js_reset']);
    assert.equal(records().at(-1).meta['x-codex-turn-metadata'].turn_id, 'idle');
  } finally {
    await bridge.close();
    if (oldLog === undefined) delete process.env.LCU_FIXTURE_LOG;
    else process.env.LCU_FIXTURE_LOG = oldLog;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('worker turns report whether a turn end can reach the original hook, and stay bounded', async () => {
  const turns = createWorkerTurns({ limit: 2 });
  assert.equal(turns.skyHook('s', 't'), 'none');
  turns.ranJs('s', 't');
  assert.equal(turns.skyHook('s', 't'), 'live');
  const ended = [];
  await turns.reset(async (session, id) => { ended.push([session, id]); throw new Error('cleanup failed'); });
  assert.deepEqual(ended, [['s', 't']], 'a failed end does not stop the reset');
  assert.equal(turns.skyHook('s', 't'), 'none');
  const fresh = turns.upstreamId('s', 't');
  assert.notEqual(fresh, 't');
  turns.ranJs('s', 't');
  assert.equal(turns.upstreamId('s', 't'), fresh);
  turns.ranJs('s', 'u');
  turns.ranJs('s', 'v');
  assert.equal(turns.upstreamId('s', 't'), 't', 'the oldest turn is evicted past the limit');
  turns.ended('s', 'v');
  assert.equal(turns.skyHook('s', 'v'), 'none');
});
