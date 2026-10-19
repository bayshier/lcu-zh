import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ElicitRequestSchema,
  ProgressNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

const relay = fileURLToPath(new URL('../codex.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./codex-fixture.mjs', import.meta.url));
const AUDIO_BYTES = Buffer.from([0, 17, 34, 51, 68, 85, 102, 119, 128, 255]);
const INSTRUCTIONS = 'Synthetic Codex relay instructions. Keep this exact fixture text.';
const PUBLIC_TOOLS = [
  {
    name: 'js',
    description: 'Synthetic JavaScript tool for Codex relay tests.',
    inputSchema: {
      type: 'object', properties: { code: { type: 'string' } },
      required: ['code'], additionalProperties: false,
    },
    _meta: { fixtureToolMarker: 'js-descriptor-retained' },
  },
  {
    name: 'js_reset',
    description: 'Synthetic JavaScript reset tool for Codex relay tests.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

function readRecords(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Condition did not become true within ${timeoutMs} ms`);
}

async function connectCodexRelay(relayPath = relay, { delayProgress = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-codex-relay-test-'));
  const logPath = join(directory, 'fixture.jsonl');
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: directory,
    TMPDIR: directory,
    LCU_CODEX_FIXTURE_LOG: logPath,
    LCU_LOG_DIR: join(directory, 'diagnostics'),
  };
  if (delayProgress) {
    // --import takes a URL; a Windows drive path would read as a 'd:' scheme.
    const preload = new URL('./codex-progress-delay.mjs', import.meta.url).href;
    env.NODE_OPTIONS = `--import=${preload}`;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [relayPath, process.execPath, fixture],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'codex-relay-contract-test', version: '1' }, {
    capabilities: { elicitation: { form: {}, url: {} } },
  });
  const receivedMessages = [];
  const progressEvents = [];
  const progressRequestIds = new Map();
  client.setNotificationHandler(ProgressNotificationSchema, async notification => {
    progressEvents.push(notification.params);
  });
  const originalSend = transport.send.bind(transport);
  transport.send = message => {
    if (message.method === 'tools/call' && message.params?.arguments?.code?.startsWith('send-progress')) {
      progressRequestIds.set(message.params._meta?.progressToken, message.id);
    }
    return originalSend(message);
  };
  const elicitationRequests = [];
  const elicitationResponses = [];
  client.setRequestHandler(ElicitRequestSchema, async request => {
    elicitationRequests.push(structuredClone(request.params));
    return elicitationResponses.shift() ?? { action: 'cancel' };
  });
  let resolveListChanged;
  let listChangedCount = 0;
  const listChanged = new Promise(resolve => { resolveListChanged = resolve; });
  client.setNotificationHandler(ToolListChangedNotificationSchema, async notification => {
    listChangedCount += 1;
    resolveListChanged(notification);
  });
  try {
    await client.connect(transport);
    const originalOnMessage = transport.onmessage;
    transport.onmessage = message => {
      receivedMessages.push(message);
      return originalOnMessage(message);
    };
  } catch (error) {
    await client.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  const logs = () => readRecords(logPath);
  const diagnosticText = () => {
    const diagnostics = env.LCU_LOG_DIR;
    return existsSync(diagnostics)
      ? readdirSync(diagnostics).map(name => readFileSync(join(diagnostics, name), 'utf8')).join('') : '';
  };
  const diagnostics = () => diagnosticText().split('\n').filter(Boolean).map(line => JSON.parse(line));
  let closePromise;
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      await client.close().catch(() => {});
      await waitFor(() => logs().some(entry => entry.type === 'fixture-exit'), 2_000).catch(() => {});
      const fixtureStarted = logs().find(entry => entry.type === 'fixture-start');
      let graceful = logs().some(entry => entry.type === 'fixture-exit');
      if (!graceful && fixtureStarted) {
        try { process.kill(fixtureStarted.pid, 'SIGTERM'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
        await waitFor(() => logs().some(entry => entry.type === 'fixture-exit')).catch(() => {});
        graceful = logs().some(entry => entry.type === 'fixture-exit');
      }
      rmSync(directory, { recursive: true, force: true });
      return graceful;
    })();
    return closePromise;
  }
  return {
    client,
    logs,
    diagnostics,
    diagnosticText,
    elicitationRequests,
    elicitationResponses,
    listChanged,
    progressEvents,
    progressRequestIds,
    receivedMessages,
    get listChangedCount() { return listChangedCount; },
    close,
    get stderr() { return stderr; },
  };
}

test('Codex relay starts through the installed current symlink', { timeout: 10_000 }, async () => {
  const install = mkdtempSync(join(tmpdir(), 'lcu-codex-current-symlink-test-'));
  const release = join(install, 'releases', '0.3.0');
  const adapters = join(release, 'adapters');
  mkdirSync(adapters, { recursive: true });
  copyFileSync(relay, join(adapters, 'codex.mjs'));
  copyFileSync(fileURLToPath(new URL('../audio-files.mjs', import.meta.url)), join(adapters, 'audio-files.mjs'));
  copyFileSync(fileURLToPath(new URL('../client.mjs', import.meta.url)), join(adapters, 'client.mjs'));
  copyFileSync(fileURLToPath(new URL('../host-guard.mjs', import.meta.url)), join(adapters, 'host-guard.mjs'));
  copyFileSync(fileURLToPath(new URL('../diagnostics.mjs', import.meta.url)), join(adapters, 'diagnostics.mjs'));
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(adapters, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(release, join(install, 'current'), process.platform === 'win32' ? 'junction' : 'dir');

  let bridge;
  try {
    bridge = await connectCodexRelay(join(install, 'current', 'adapters', 'codex.mjs'));
    assert.equal(bridge.client.getServerVersion().name, 'lcu-codex-contract-fixture');
    assert.deepEqual((await bridge.client.listTools()).tools.map(tool => tool.name), ['js', 'js_reset']);
    const result = await bridge.client.callTool({ name: 'js', arguments: { code: 'current-symlink' } });
    assert.equal(result.content[0].text, 'Synthetic result: current-symlink');
  } finally {
    await bridge?.close();
    rmSync(install, { recursive: true, force: true });
  }
});

test('Codex relay preserves MCP contracts and changes only returned audio blocks', { timeout: 20_000 }, async () => {
  const bridge = await connectCodexRelay(relay, { delayProgress: true });
  try {
    assert.deepEqual(bridge.client.getServerVersion(), {
      name: 'lcu-codex-contract-fixture', version: '7.4.2',
    });
    assert.equal(bridge.client.getInstructions(), INSTRUCTIONS);
    assert.deepEqual(bridge.client.getServerCapabilities(), { tools: { listChanged: true } });

    const listed = await bridge.client.listTools();
    assert.deepEqual(listed.tools, PUBLIC_TOOLS);
    assert.ok(!listed.tools.some(tool => ['js_add_node_module_dir', 'turn_ended'].includes(tool.name)));

    const requestMeta = {
      'x-codex-turn-metadata': { session_id: 'fixture-session-81', turn_id: 'fixture-turn-12' },
      callerMarker: { retained: true },
    };
    const identityResult = await bridge.client.callTool({
      name: 'js', arguments: { code: 'metadata-result' }, _meta: requestMeta,
    });
    assert.deepEqual(identityResult, {
      content: [{ type: 'text', text: 'Synthetic result: metadata-result' }],
    });
    assert.deepEqual(bridge.logs().find(entry => entry.type === 'call' && entry.args.code === 'metadata-result'), {
      type: 'call', name: 'js', args: { code: 'metadata-result' }, meta: requestMeta,
    });

    const rich = await bridge.client.callTool({ name: 'js', arguments: { code: 'rich-result' } });
    assert.deepEqual(rich, {
      content: [
        { type: 'text', text: 'Synthetic text before image.', annotations: { audience: ['assistant'] } },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ],
      structuredContent: { fixture: { retained: true } },
      _meta: { fixtureResultMarker: { revision: 3 } },
    });
    const toolError = await bridge.client.callTool({ name: 'js', arguments: { code: 'tool-error' } });
    assert.deepEqual(toolError, {
      isError: true,
      content: [{ type: 'text', text: 'Synthetic tool-level failure.' }],
      _meta: { fixtureErrorMarker: true },
    });

    const audio = await bridge.client.callTool({ name: 'js', arguments: { code: 'audio-result' } });
    assert.equal(audio.isError, false);
    assert.deepEqual(audio.content.map(item => item.type), ['text', 'text', 'image', 'text']);
    assert.equal(audio.content[0].text, 'Synthetic audio before.');
    assert.equal(audio.content[2].data, 'AQID');
    assert.equal(audio.content[3].text, 'Synthetic audio after.');
    assert.match(audio.content[1].text, /original MIME type: audio\/wav/);
    const savedPath = /saved to (.+)$/.exec(audio.content[1].text)?.[1];
    assert.ok(savedPath);
    assert.equal(isAbsolute(savedPath), true);
    assert.deepEqual(readFileSync(savedPath), AUDIO_BYTES);
    assert.ok(!JSON.stringify(audio).includes(AUDIO_BYTES.toString('base64')));
    assert.deepEqual(audio.content[1].annotations, { audience: ['assistant'] });
    assert.deepEqual(audio.structuredContent, { fixtureAudioResult: { retained: true } });
    assert.deepEqual(audio._meta, { fixtureAudioMarker: { revision: 4 } });

    const moduleRegistration = await bridge.client.callTool({
      name: 'js_add_node_module_dir', arguments: { path: '/synthetic/module-path' },
    });
    assert.equal(moduleRegistration.content[0].text, 'Synthetic module path registered.');
    const cleanupArgs = {
      hook_event_name: 'Stop', session_id: 'fixture-session-81', turn_id: 'fixture-turn-12',
    };
    const cleanupMeta = { 'x-codex-turn-metadata': { session_id: cleanupArgs.session_id, turn_id: cleanupArgs.turn_id } };
    const cleanup = await bridge.client.callTool({ name: 'turn_ended', arguments: cleanupArgs, _meta: cleanupMeta });
    assert.equal(cleanup.content[0].text, 'Synthetic cleanup complete.');
    assert.deepEqual(bridge.logs().find(entry => entry.type === 'call' && entry.name === 'turn_ended'), {
      type: 'call', name: 'turn_ended', args: cleanupArgs, meta: cleanupMeta,
    });

    const accepted = { action: 'accept', content: {}, _meta: { persist: 'session', fixtureResponseMarker: true } };
    bridge.elicitationResponses.push(accepted);
    await bridge.client.callTool({ name: 'js', arguments: { code: 'approval' } });
    assert.deepEqual(bridge.elicitationRequests[0], {
      mode: 'form',
      message: 'Approve the synthetic fixture operation?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        connector_id: 'fixture-connector',
        persist: ['session', 'always'],
        fixtureRequestMarker: { retained: true },
      },
    });
    assert.deepEqual(bridge.logs().find(entry => entry.type === 'elicitation-response').response, accepted);

    const progressToken = 'codex-progress-contract-token';
    const progressResult = await bridge.client.callTool(
      { name: 'js', arguments: { code: 'send-progress' },
        _meta: { callerMarker: 'progress-call', progressToken } },
    );
    assert.equal(progressResult.content[0].text, 'Progress sent.');
    await waitFor(() => bridge.progressEvents.length > 0);
    assert.equal(bridge.progressEvents[0].progressToken, progressToken);
    assert.deepEqual(bridge.progressEvents.map(({ progress, total, message }) => ({ progress, total, message })), [{
      progress: 2, total: 5, message: 'Synthetic fixture progress.',
    }], bridge.stderr);
    const requestId = bridge.progressRequestIds.get(progressToken);
    const progressIndex = bridge.receivedMessages.findIndex(message =>
      message.method === 'notifications/progress' && message.params?.progressToken === progressToken);
    const responseIndex = bridge.receivedMessages.findIndex(message =>
      message.id === requestId && Object.hasOwn(message, 'result'));
    assert.ok(progressIndex >= 0, 'the relay must emit progress to its downstream client');
    assert.ok(responseIndex > progressIndex, 'the tool result must not overtake the progress notification');
    assert.equal(bridge.logs().find(entry => entry.type === 'call' && entry.args.code === 'send-progress').meta.callerMarker,
      'progress-call');

    const errorProgressToken = 'codex-progress-error-contract-token';
    await assert.rejects(bridge.client.callTool({
      name: 'js', arguments: { code: 'send-progress-then-fail' },
      _meta: { callerMarker: 'progress-error-call', progressToken: errorProgressToken },
    }));
    await waitFor(() => bridge.progressEvents.some(event => event.progressToken === errorProgressToken));
    const errorRequestId = bridge.progressRequestIds.get(errorProgressToken);
    const errorProgressIndex = bridge.receivedMessages.findIndex(message =>
      message.method === 'notifications/progress' && message.params?.progressToken === errorProgressToken);
    const errorResponseIndex = bridge.receivedMessages.findIndex(message =>
      message.id === errorRequestId && Object.hasOwn(message, 'error'));
    assert.ok(errorProgressIndex >= 0, 'progress before an upstream error must reach the downstream client');
    assert.ok(errorResponseIndex > errorProgressIndex, 'the error response must not overtake accepted progress');

    await bridge.client.callTool({ name: 'js', arguments: { code: 'notify-tools-changed' } });
    const notification = await Promise.race([
      bridge.listChanged,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Tool list change was not forwarded')), 2_000)),
    ]);
    assert.deepEqual(notification, { method: 'notifications/tools/list_changed' });
    assert.equal(bridge.listChangedCount, 1);

    const controller = new AbortController();
    const cancelledCall = bridge.client.callTool(
      { name: 'js', arguments: { code: 'wait-for-abort' }, _meta: { callerMarker: 'cancel-call' } },
      undefined,
      { signal: controller.signal },
    );
    await waitFor(() => bridge.logs().some(entry => entry.type === 'call-waiting-for-abort'));
    controller.abort();
    await assert.rejects(cancelledCall);
    await waitFor(() => bridge.logs().some(entry => entry.type === 'call-aborted'));
    assert.equal(bridge.logs().find(entry => entry.type === 'call-aborted').meta.callerMarker, 'cancel-call');

    const gracefulClose = await bridge.close();
    assert.equal(gracefulClose, true, `Codex relay did not gracefully close the upstream fixture: ${bridge.stderr}`);
  } finally {
    await bridge.close();
  }
});

test('Codex relay logs calls and approvals as metadata only', { timeout: 20_000 }, async () => {
  const bridge = await connectCodexRelay();
  try {
    const codeMarker = 'codex-diag-code-marker-5521';
    const ok = await bridge.client.callTool({ name: 'js', arguments: { code: codeMarker, timeout_ms: 777 } });
    assert.equal(ok.content[0].text, `Synthetic result: ${codeMarker}`);
    const failed = await bridge.client.callTool({ name: 'js', arguments: { code: 'tool-error' } });
    assert.equal(failed.isError, true);
    bridge.elicitationResponses.push({ action: 'accept', content: {}, _meta: { persist: 'session' } });
    await bridge.client.callTool({ name: 'js', arguments: { code: 'approval' } });
    await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'Stop', session_id: 'diag-session-1', turn_id: 'diag-turn-1',
    } });

    const events = bridge.diagnostics();
    assert.ok(events.some(entry => entry.event === 'upstream_connect' && entry.ok === true));
    assert.deepEqual(events.filter(entry => entry.event === 'call_end').map(entry => [entry.call, entry.outcome]),
      [[1, 'ok'], [2, 'tool_error'], [3, 'ok']]);
    assert.equal(events.find(entry => entry.event === 'call_start').timeout_ms, 777);
    const open = events.find(entry => entry.event === 'approval_open');
    assert.deepEqual([open.approval, open.call, open.kind], [1, 3, 'other']);
    const end = events.find(entry => entry.event === 'approval_end');
    assert.deepEqual([end.approval, end.action, end.persist], [1, 'accept', 'session']);

    const text = bridge.diagnosticText();
    for (const secret of [codeMarker, 'Synthetic tool-level failure', 'Approve the synthetic fixture operation',
      'diag-session-1', 'diag-turn-1']) {
      assert.equal(text.includes(secret), false, secret);
    }
  } finally {
    await bridge.close();
  }
});

test('Codex relay ends turns that ran js before js_reset and maps their later calls and Stop to a fresh id', { timeout: 20_000 }, async () => {
  const bridge = await connectCodexRelay();
  const meta = (session_id, turn_id) => ({ 'x-codex-turn-metadata': { session_id, turn_id, caller: 'kept' } });
  try {
    await bridge.client.callTool({ name: 'js', arguments: { code: 'a' }, _meta: meta('thread-a', 'turn-a') });
    // Metadata may arrive as JSON text.
    await bridge.client.callTool({ name: 'js', arguments: { code: 'b' },
      _meta: { 'x-codex-turn-metadata': JSON.stringify({ session_id: 'thread-b', turn_id: 'turn-b' }) } });
    const reset = await bridge.client.callTool({ name: 'js_reset', arguments: {}, _meta: meta('thread-a', 'turn-a') });
    assert.equal(reset.content[0].text, 'Synthetic reset complete.');
    const calls = () => bridge.logs().filter(entry => entry.type === 'call');
    const resetAt = calls().findIndex(entry => entry.name === 'js_reset');
    assert.deepEqual(calls().slice(2, resetAt).map(entry => [entry.args.hook_event_name, entry.args.session_id,
      entry.args.turn_id]).sort(), [['Interrupt', 'thread-a', 'turn-a'], ['Interrupt', 'thread-b', 'turn-b']]);
    const fresh = calls()[resetAt].meta['x-codex-turn-metadata'];
    assert.notEqual(fresh.turn_id, 'turn-a');
    assert.equal(fresh.caller, 'kept');

    await bridge.client.callTool({ name: 'js', arguments: { code: 'c' }, _meta: meta('thread-a', 'turn-a') });
    assert.equal(calls().at(-1).meta['x-codex-turn-metadata'].turn_id, fresh.turn_id);
    await bridge.client.callTool({ name: 'js', arguments: { code: 'd' },
      _meta: { 'x-codex-turn-metadata': JSON.stringify({ session_id: 'thread-b', turn_id: 'turn-b' }) } });
    const freshB = JSON.parse(calls().at(-1).meta['x-codex-turn-metadata']).turn_id;
    assert.ok(![fresh.turn_id, 'turn-b'].includes(freshB));
    await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'Stop', session_id: 'thread-a', turn_id: 'turn-a',
    } });
    assert.equal(calls().at(-1).args.turn_id, fresh.turn_id);
    // An unrelated Stop passes through unchanged.
    await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'Stop', session_id: 'thread-c', turn_id: 'turn-c',
    } });
    assert.equal(calls().at(-1).args.turn_id, 'turn-c');

    const ends = bridge.diagnostics().filter(entry => entry.event === 'turn_end');
    assert.deepEqual(ends.map(entry => [entry.hook_event, entry.cause, entry.outcome, entry.sky_hook]), [
      ['Interrupt', 'js_reset', 'ok', 'live'], ['Interrupt', 'js_reset', 'ok', 'live'],
      ['Stop', undefined, 'ok', 'live'], ['Stop', undefined, 'ok', 'none'],
    ]);
  } finally {
    await bridge.close();
  }
});
