import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { subagentTurnId } from '../claude.mjs';
import { crossTurnEnabled, crossTurnSettingPath } from '../cross-turn.mjs';

const relay = fileURLToPath(new URL('../claude.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./claude-fixture.mjs', import.meta.url));
const clientModule = fileURLToPath(new URL('../client.mjs', import.meta.url));

function installedCurrentEntryPoint(directory) {
  const releaseAdapters = join(directory, 'releases', '0.3.0-test', 'adapters');
  mkdirSync(releaseAdapters, { recursive: true });
  copyFileSync(relay, join(releaseAdapters, 'claude.mjs'));
  copyFileSync(clientModule, join(releaseAdapters, 'client.mjs'));
  copyFileSync(fileURLToPath(new URL('../host-guard.mjs', import.meta.url)), join(releaseAdapters, 'host-guard.mjs'));
  copyFileSync(fileURLToPath(new URL('../cross-turn.mjs', import.meta.url)), join(releaseAdapters, 'cross-turn.mjs'));
  copyFileSync(fileURLToPath(new URL('../diagnostics.mjs', import.meta.url)), join(releaseAdapters, 'diagnostics.mjs'));
  symlinkSync(join(dirname(relay), 'node_modules'), join(releaseAdapters, 'node_modules'), 'dir');
  symlinkSync(join(directory, 'releases', '0.3.0-test'), join(directory, 'current'), 'dir');
  return join(directory, 'current', 'adapters', 'claude.mjs');
}

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

async function connectRelay({ throughCurrentSymlink = false, crossTurn, maxEndedTurns } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-claude-relay-test-'));
  // The relay reads the setting from the account's state directory, which HOME points at below.
  if (crossTurn !== undefined) {
    const setting = crossTurnSettingPath(directory);
    mkdirSync(dirname(setting), { recursive: true });
    writeFileSync(setting, JSON.stringify({ enabled: crossTurn }));
  }
  const logPath = join(directory, 'original-fixture.jsonl');
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: directory,
    USERPROFILE: directory,
    TMPDIR: directory,
    LCU_FIXTURE_LOG: logPath,
    LCU_LOG_DIR: join(directory, 'diagnostics'),
  };
  const scriptPath = throughCurrentSymlink ? installedCurrentEntryPoint(directory) : relay;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: maxEndedTurns === undefined ? [scriptPath, process.execPath, fixture] : ['--input-type=module', '-e',
      `import { runClaudeBridge } from ${JSON.stringify(pathToFileURL(relay).href)};` +
      `await runClaudeBridge({ command: ${JSON.stringify(process.execPath)}, ` +
      `args: [${JSON.stringify(fixture)}], maxEndedTurns: ${maxEndedTurns} });`],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'claude-relay-contract-test', version: '1' }, {
    capabilities: { elicitation: { form: {}, url: {} } },
  });
  const elicitationRequests = [];
  const elicitationResponses = [];
  client.setRequestHandler(ElicitRequestSchema, async request => {
    elicitationRequests.push(structuredClone(request.params));
    const next = elicitationResponses.shift();
    return (typeof next === 'function' ? await next(request.params) : next) ?? { action: 'cancel' };
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  const logs = () => readRecords(logPath);
  const diagnosticText = () => {
    const directory = join(env.LCU_LOG_DIR);
    return existsSync(directory)
      ? readdirSync(directory).map(name => readFileSync(join(directory, name), 'utf8')).join('') : '';
  };
  const diagnostics = () => diagnosticText().split('\n').filter(Boolean).map(line => JSON.parse(line));
  async function close() {
    await client.close().catch(() => {});
    const started = logs().find(entry => entry.type === 'fixture-start');
    if (started && !logs().some(entry => entry.type === 'fixture-exit')) {
      try { process.kill(started.pid, 'SIGTERM'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      await waitFor(() => logs().some(entry => entry.type === 'fixture-exit')).catch(() => {});
    }
    rmSync(directory, { recursive: true, force: true });
  }
  return {
    client,
    logs,
    diagnostics,
    diagnosticText,
    directory,
    elicitationRequests,
    respondToNextElicitation(response) { elicitationResponses.push(response); },
    close,
    get stderr() { return stderr; },
  };
}

async function bindContext(client, {
  sessionId = 'session-test', turnId = 'prompt-test', toolUseId, agentId,
}) {
  const arguments_ = {
    session_id: sessionId,
    turn_id: turnId,
    tool_use_id: toolUseId,
    ...(agentId ? { agent_id: agentId } : {}),
  };
  return client.callTool({ name: 'set_turn_context', arguments: arguments_ });
}

/**
 * Return once the relay has acted on the host's elicitation answer: let the client flush its
 * response, then make a round-trip that the relay reads only after draining that answer.
 */
async function relayHasHostAnswer(bridge) {
  await new Promise(resolve => setImmediate(resolve));
  await bridge.client.ping();
}

async function callWithContext(client, name, args, {
  sessionId = 'session-test', turnId = 'prompt-test', toolUseId, agentId, callerMeta = {}, signal,
}) {
  await bindContext(client, { sessionId, turnId, toolUseId, agentId });
  return client.callTool({ name, arguments: args, _meta: {
    'claudecode/toolUseId': toolUseId,
    ...callerMeta,
  } }, undefined, { signal });
}

async function assertOriginalProtocol(bridge) {
  assert.equal(bridge.client.getInstructions(),
    'Original Claude relay fixture instructions. Preserve this text exactly.');
  const tools = (await bridge.client.listTools()).tools;
  assert.deepEqual(tools.filter(tool => tool.name === 'js' || tool.name === 'js_reset'), [
    { name: 'js', description: 'Original JavaScript tool description.', inputSchema: {
      type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false,
    } },
    { name: 'js_reset', description: 'Original JavaScript reset description.', inputSchema: {
      type: 'object', properties: {}, additionalProperties: false,
    } },
  ]);

  const context = {
    session_id: 'session-smoke', turn_id: 'prompt-smoke',
    tool_use_id: 'tool-use-smoke',
  };
  const bind = await bridge.client.callTool({ name: 'set_turn_context', arguments: context });
  assert.equal(bind.content[0].text, 'Turn context bound.');
  const result = await bridge.client.callTool({
    name: 'js',
    arguments: { code: 'identity-smoke' },
    _meta: { 'claudecode/toolUseId': context.tool_use_id, callerMarker: { retained: true },
      'openai/confirmation_policies': { computer_use: 'confirm' },
      'sandbox/policy': { mode: 'workspace-write' },
      'x-codex-turn-metadata': { caller_field: 'retained', thread_id: 'real-thread', thread_source: 'subagent' } },
  });
  assert.deepEqual(result.content, [{ type: 'text', text: 'identity-smoke' }]);

  const forwarded = bridge.logs().find(entry => entry.type === 'tool-call' && entry.name === 'js');
  assert.deepEqual(forwarded, {
    type: 'tool-call',
    name: 'js',
    args: { code: 'identity-smoke' },
    meta: {
      'claudecode/toolUseId': context.tool_use_id,
      callerMarker: { retained: true },
      'openai/confirmation_policies': { computer_use: 'confirm' },
      'sandbox/policy': { mode: 'workspace-write' },
      'x-codex-turn-metadata': {
        caller_field: 'retained', thread_id: 'real-thread', thread_source: 'subagent',
        session_id: context.session_id, turn_id: context.turn_id, call_id: context.tool_use_id,
      },
    },
  });
}

test('Claude relay preserves original tool contract and forwards the exact correlated identity', async () => {
  const bridge = await connectRelay();
  try {
    await assertOriginalProtocol(bridge);
  } finally {
    await bridge.close();
  }
});

test('Claude relay starts and preserves its protocol through an installed current symlink', async () => {
  const bridge = await connectRelay({ throughCurrentSymlink: true });
  try {
    await assertOriginalProtocol(bridge);
  } finally {
    await bridge.close();
  }
});

test('Claude relay preserves original results/errors and isolates parallel and stale tool-use identities', async () => {
  const bridge = await connectRelay();
  try {
    const missing = await bridge.client.callTool({ name: 'js', arguments: { code: 'must-not-run' } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Missing exact Claude PreToolUse identity/);
    assert.equal(bridge.logs().filter(entry => entry.type === 'tool-call' && entry.name === 'js').length, 0);

    const rich = await callWithContext(bridge.client, 'js', { code: 'rich-result' }, { toolUseId: 'rich-use' });
    assert.deepEqual(rich, {
      content: [
        { type: 'text', text: 'Original result text.', annotations: { audience: ['assistant'], priority: 0.7 } },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
      structuredContent: { nested: { retained: true } },
      _meta: { originalResult: { revision: 4 } },
    });
    const failure = await callWithContext(bridge.client, 'js', { code: 'tool-error' }, { toolUseId: 'error-use' });
    assert.deepEqual(failure, {
      isError: true,
      content: [{ type: 'text', text: 'Original tool-level failure.' }],
      _meta: { originalError: true },
    });

    await bindContext(bridge.client, {
      sessionId: 'parallel-session-a', turnId: 'parallel-turn-a', toolUseId: 'parallel-use-a',
    });
    await bindContext(bridge.client, {
      sessionId: 'parallel-session-b', turnId: 'parallel-turn-b', toolUseId: 'parallel-use-b',
    });
    const [parallelJs, parallelReset] = await Promise.all([
      bridge.client.callTool({ name: 'js', arguments: { code: 'parallel-slow' }, _meta: {
        'claudecode/toolUseId': 'parallel-use-a', caller: 'a',
      } }),
      bridge.client.callTool({ name: 'js_reset', arguments: {}, _meta: {
        'claudecode/toolUseId': 'parallel-use-b', caller: 'b',
      } }),
    ]);
    assert.equal(parallelJs.content[0].text, 'parallel-slow');
    assert.equal(parallelReset.content[0].text, 'Original reset result.');
    const parallelCalls = bridge.logs().filter(entry => entry.type === 'tool-call' &&
      (entry.args.code === 'parallel-slow' || entry.name === 'js_reset'));
    assert.deepEqual(parallelCalls.map(entry => ({
      name: entry.name,
      meta: entry.meta,
    })).sort((a, b) => a.name.localeCompare(b.name)), [
      { name: 'js', meta: {
        'claudecode/toolUseId': 'parallel-use-a',
        caller: 'a',
        'x-codex-turn-metadata': { session_id: 'parallel-session-a', turn_id: 'parallel-turn-a', call_id: 'parallel-use-a' },
      } },
      { name: 'js_reset', meta: {
        'claudecode/toolUseId': 'parallel-use-b',
        caller: 'b',
        'x-codex-turn-metadata': { session_id: 'parallel-session-b', turn_id: 'parallel-turn-b', call_id: 'parallel-use-b' },
      } },
    ]);

    await bindContext(bridge.client, {
      sessionId: 'stale-session', turnId: 'stale-turn', toolUseId: 'stale-use',
    });
    const cleanup = await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'Stop', session_id: 'stale-session', turn_id: 'stale-turn',
    } });
    assert.equal(cleanup.content[0].text, 'Original cleanup completed.');
    const stale = await bridge.client.callTool({ name: 'js', arguments: { code: 'stale-must-not-run' }, _meta: {
      'claudecode/toolUseId': 'stale-use',
    } });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /Missing exact Claude PreToolUse identity/);
    assert.equal(bridge.logs().filter(entry => entry.type === 'tool-call' &&
      entry.args.code === 'stale-must-not-run').length, 0);
  } finally {
    await bridge.close();
  }
});


test('Claude relay isolates overlapping child identities and makes SubagentStop cleanup idempotent', async () => {
  const bridge = await connectRelay();
  try {
    const sessionId = 'shared-host-session';
    const turnId = 'shared-prompt';
    const initial = [
      { toolUseId: 'parent-active', code: 'parent-active' },
      { toolUseId: 'child-a-active', code: 'child-a-active', agentId: 'agent-a' },
      { toolUseId: 'child-b-active', code: 'child-b-active', agentId: 'agent-b' },
    ];
    for (const identity of initial) {
      await bindContext(bridge.client, { sessionId, turnId, ...identity });
    }
    const results = await Promise.all(initial.map(identity => bridge.client.callTool({
      name: 'js', arguments: { code: identity.code },
      _meta: { 'claudecode/toolUseId': identity.toolUseId },
    })));
    assert.ok(results.every(result => !result.isError));

    const forwarded = Object.fromEntries(bridge.logs()
      .filter(entry => entry.type === 'tool-call' && initial.some(item => item.code === entry.args.code))
      .map(entry => [entry.args.code, entry.meta['x-codex-turn-metadata']]));
    assert.deepEqual(forwarded, {
      'parent-active': { session_id: sessionId, turn_id: turnId, call_id: 'parent-active' },
      // A subagent has its own upstream turn id, so its SubagentStop can never end the parent's prompt.
      'child-a-active': { session_id: 'agent-a', turn_id: subagentTurnId('agent-a', turnId), call_id: 'child-a-active' },
      'child-b-active': { session_id: 'agent-b', turn_id: subagentTurnId('agent-b', turnId), call_id: 'child-b-active' },
    });

    const pending = [
      { toolUseId: 'parent-pending', code: 'parent-pending' },
      { toolUseId: 'child-a-pending', code: 'child-a-pending', agentId: 'agent-a' },
      { toolUseId: 'child-b-pending', code: 'child-b-pending', agentId: 'agent-b' },
    ];
    for (const identity of pending) {
      await bindContext(bridge.client, { sessionId, turnId, ...identity });
    }

    const childAStop = { hook_event_name: 'SubagentStop', session_id: 'agent-a', turn_id: turnId };
    const childACleanup = await bridge.client.callTool({ name: 'turn_ended', arguments: childAStop });
    assert.ok(!childACleanup.isError);

    const duplicateCleanup = await bridge.client.callTool({ name: 'turn_ended', arguments: childAStop });
    assert.equal(duplicateCleanup.content[0].text, 'Turn already ended.');
    assert.equal(bridge.logs().filter(entry => entry.type === 'turn-ended' &&
      entry.args.hook_event_name === 'SubagentStop' && entry.args.session_id === 'agent-a').length, 1);

    const staleChild = await bridge.client.callTool({ name: 'js', arguments: { code: 'child-a-stale' },
      _meta: { 'claudecode/toolUseId': 'child-a-pending' } });
    assert.equal(staleChild.isError, true);
    assert.match(staleChild.content[0].text, /Missing exact Claude PreToolUse identity/);
    assert.equal(bridge.logs().filter(entry => entry.type === 'tool-call' &&
      entry.args.code === 'child-a-stale').length, 0);

    const parentStop = await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId,
    } });
    assert.ok(!parentStop.isError);
    const staleParent = await bridge.client.callTool({ name: 'js', arguments: { code: 'parent-stale' },
      _meta: { 'claudecode/toolUseId': 'parent-pending' } });
    assert.equal(staleParent.isError, true);
    assert.match(staleParent.content[0].text, /Missing exact Claude PreToolUse identity/);
    assert.equal(bridge.logs().filter(entry => entry.type === 'tool-call' &&
      entry.args.code === 'parent-stale').length, 0);

    const childB = await bridge.client.callTool({ name: 'js', arguments: { code: 'child-b-pending' },
      _meta: { 'claudecode/toolUseId': 'child-b-pending' } });
    assert.ok(!childB.isError);
    const childBStop = await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'SubagentStop', session_id: 'agent-b', turn_id: turnId,
    } });
    assert.ok(!childBStop.isError);
    assert.equal(bridge.logs().filter(entry => entry.type === 'turn-ended' &&
      entry.args.hook_event_name === 'SubagentStop').length, 3,
      'agent-a once, agent-b by the parent Stop cascade (cross-turn off) and by its own SubagentStop');
  } finally {
    await bridge.close();
  }
});

test('Claude relay re-runs Stop cleanup after an aborted call re-binds the same turn', async () => {
  const bridge = await connectRelay();
  try {
    const sessionId = 'relive-session';
    const turnId = 'relive-turn';
    // An aborted call runs Interrupt cleanup, marking the turn ended.
    const controller = new AbortController();
    const aborted = callWithContext(bridge.client, 'js', { code: 'cancel-active' }, {
      sessionId, turnId, toolUseId: 'relive-abort', signal: controller.signal,
    }).then(value => ({ value }), error => ({ error }));
    await waitFor(() => bridge.logs().some(entry => entry.type === 'active-call-start'));
    controller.abort();
    assert.ok((await aborted).error, 'the canceled call should reject at the caller');
    await waitFor(() => bridge.logs().some(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === sessionId));
    assert.equal(bridge.logs().filter(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === sessionId).length, 1);

    // The model continues in the same prompt_id: re-binding revives the turn.
    const live = await callWithContext(bridge.client, 'js', { code: 'relive-live' }, {
      sessionId, turnId, toolUseId: 'relive-live',
    });
    assert.equal(live.content[0].text, 'relive-live');

    // The final Stop must reach upstream turn_ended a second time, not dedupe.
    const stop = await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId,
    } });
    assert.equal(stop.content[0].text, 'Original cleanup completed.');
    assert.equal(bridge.logs().filter(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === sessionId).length, 2);

    // A duplicate Stop for the still-ended turn is still deduped.
    const duplicate = await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId,
    } });
    assert.equal(duplicate.content[0].text, 'Turn already ended.');
    assert.equal(bridge.logs().filter(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === sessionId).length, 2);
  } finally {
    await bridge.close();
  }
});

test('Claude relay re-runs Stop cleanup when a re-bind lands while Interrupt cleanup is in flight', async () => {
  const bridge = await connectRelay();
  try {
    // The fixture holds turn_ended for 'hold-*' sessions until released.
    const sessionId = 'hold-session';
    const turnId = 'hold-turn';
    const turnEnds = () => bridge.logs().filter(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === sessionId);
    const controller = new AbortController();
    const aborted = callWithContext(bridge.client, 'js', { code: 'cancel-active' }, {
      sessionId, turnId, toolUseId: 'hold-abort', signal: controller.signal,
    }).then(value => ({ value }), error => ({ error }));
    await waitFor(() => bridge.logs().some(entry => entry.type === 'active-call-start'));
    controller.abort();
    assert.ok((await aborted).error, 'the canceled call should reject at the caller');
    await waitFor(() => turnEnds().length === 1);
    assert.equal(turnEnds()[0].args.hook_event_name, 'Interrupt');

    // The model re-binds the same turn while the Interrupt reply is still held.
    const bound = await bindContext(bridge.client, { sessionId, turnId, toolUseId: 'hold-live' });
    assert.equal(bound.content[0].text, 'Turn context bound.');
    const release = await callWithContext(bridge.client, 'js', { code: 'release-held-cleanup' }, {
      sessionId, turnId, toolUseId: 'hold-release',
    });
    assert.equal(release.content[0].text, 'released');
    assert.ok(bridge.logs().some(entry => entry.type === 'turn-ended-released'));

    // The late Interrupt completion must not drop the revived turn's identities.
    const live = await bridge.client.callTool({ name: 'js', arguments: { code: 'hold-live' },
      _meta: { 'claudecode/toolUseId': 'hold-live' } });
    assert.equal(live.content[0].text, 'hold-live');

    // The final Stop must reach upstream turn_ended a second time, not dedupe.
    const stop = await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId,
    } });
    assert.equal(stop.content[0].text, 'Original cleanup completed.');
    assert.deepEqual(turnEnds().map(entry => entry.args.hook_event_name), ['Interrupt', 'Stop']);

    const duplicate = await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId,
    } });
    assert.equal(duplicate.content[0].text, 'Turn already ended.');
    assert.equal(turnEnds().length, 2);
  } finally {
    await bridge.close();
  }
});

test('Claude relay maps native scopes and passes unrelated form and URL elicitations through unchanged', async () => {
  const bridge = await connectRelay();
  try {
    const nativeMeta = {
      codex_approval_kind: 'mcp_tool_call',
      connector_id: 'computer-use',
      persist: ['session', 'always'],
      tool_name: 'get_app_state',
      tool_params: { app: 'dev.lcu.NativeFixture.generated' },
      fixtureOpaque: { keep: true },
    };
    for (const [choice, expected] of [
      ['once', { action: 'accept', content: {} }],
      ['session', { action: 'accept', content: {}, _meta: { persist: 'session' } }],
      ['always', { action: 'accept', content: {}, _meta: { persist: 'always' } }],
      ['decline', { action: 'decline' }],
    ]) {
      bridge.respondToNextElicitation({ action: 'accept', content: { choice } });
      const result = await callWithContext(bridge.client, 'js', { code: 'approval-native' }, {
        toolUseId: `approval-${choice}`,
      });
      assert.deepEqual(JSON.parse(result.content[0].text), expected);
      const shown = bridge.elicitationRequests.at(-1);
      assert.deepEqual(shown._meta, nativeMeta);
      assert.equal(shown.message, 'Allow Computer Use to use "LCU Fixture App"?');
      const choiceSchema = shown.requestedSchema.properties.choice;
      const choices = choiceSchema.enum?.map((value, index) => ({
        value,
        label: choiceSchema.enumNames?.[index],
      })) ?? choiceSchema.oneOf?.map(option => ({ value: option.const, label: option.title }));
      assert.deepEqual(choices, [
        { value: 'once', label: 'Allow once' },
        { value: 'session', label: 'Allow for this session' },
        { value: 'always', label: 'Always allow' },
        { value: 'decline', label: 'Decline' },
      ]);
    }

    bridge.respondToNextElicitation({ action: 'cancel' });
    const cancelled = await callWithContext(bridge.client, 'js', { code: 'approval-native' }, {
      toolUseId: 'approval-cancel',
    });
    assert.deepEqual(JSON.parse(cancelled.content[0].text), { action: 'cancel' });

    bridge.respondToNextElicitation({ action: 'accept', content: { choice: 'always' } });
    const unoffered = await callWithContext(bridge.client, 'js', { code: 'approval-native-session-only' }, {
      toolUseId: 'approval-unoffered-scope',
    });
    assert.deepEqual(JSON.parse(unoffered.content[0].text), { action: 'cancel' });
    const sessionOnly = bridge.elicitationRequests.at(-1).requestedSchema.properties.choice;
    assert.deepEqual(sessionOnly.enum, ['once', 'session', 'decline']);

    const unrelatedMeta = { fixture: 'unrelated-form', opaque: { id: 39 } };
    const unrelatedRequest = {
      mode: 'form',
      message: 'Enter the fixture secret.',
      requestedSchema: { type: 'object', properties: { secret: { type: 'string', minLength: 1 } }, required: ['secret'] },
      _meta: unrelatedMeta,
    };
    bridge.respondToNextElicitation({ action: 'accept', content: { secret: 'kept secret' } });
    const form = await callWithContext(bridge.client, 'js', { code: 'approval-form' }, {
      toolUseId: 'approval-unrelated-form',
    });
    assert.deepEqual(JSON.parse(form.content[0].text), { action: 'accept', content: { secret: 'kept secret' } });
    assert.deepEqual(bridge.elicitationRequests.at(-1), unrelatedRequest);

    const urlRequest = {
      mode: 'url',
      message: 'Open the original fixture approval URL.',
      elicitationId: 'fixture-url-elicitation',
      url: 'https://approval.example.invalid/continue',
      _meta: { fixture: 'url-form-pass-through', opaque: { id: 71 } },
    };
    bridge.respondToNextElicitation({ action: 'decline' });
    const url = await callWithContext(bridge.client, 'js', { code: 'approval-url' }, {
      toolUseId: 'approval-url',
    });
    assert.deepEqual(JSON.parse(url.content[0].text), { action: 'decline' });
    assert.deepEqual(bridge.elicitationRequests.at(-1), urlRequest);
  } finally {
    await bridge.close();
  }
});

test('Claude relay interrupts an active turn on cancel and drains cleanup before a real stdio close', async () => {
  const cancelled = await connectRelay();
  try {
    const controller = new AbortController();
    const pending = callWithContext(cancelled.client, 'js', { code: 'cancel-active' }, {
      sessionId: 'cancel-session', turnId: 'cancel-turn', toolUseId: 'cancel-use', signal: controller.signal,
    }).then(value => ({ value }), error => ({ error }));
    await waitFor(() => cancelled.logs().some(entry => entry.type === 'active-call-start'));
    controller.abort();
    const settled = await pending;
    assert.ok(settled.error, 'an explicitly canceled MCP request should reject at the caller');
    await waitFor(() => cancelled.logs().some(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === 'cancel-session' && entry.args.turn_id === 'cancel-turn'));
    assert.equal(cancelled.logs().filter(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === 'cancel-session').length, 1);
  } finally {
    await cancelled.close();
  }

  const closed = await connectRelay();
  try {
    const pending = callWithContext(closed.client, 'js', { code: 'close-active' }, {
      sessionId: 'close-session', turnId: 'close-turn', toolUseId: 'close-use',
    }).then(value => ({ value }), error => ({ error }));
    await waitFor(() => closed.logs().some(entry => entry.type === 'active-call-start'));
    await closed.client.close();
    const settled = await pending;
    assert.ok(settled.error, 'closing the host transport should settle the active tool call');
    await waitFor(() => closed.logs().some(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === 'close-session' && entry.args.turn_id === 'close-turn'));
    const events = closed.logs();
    const startIndex = events.findIndex(entry => entry.type === 'active-call-start' && entry.code === 'close-active');
    const cleanupIndex = events.findIndex(entry => entry.type === 'turn-ended' && entry.args.session_id === 'close-session');
    const exitIndex = events.findIndex(entry => entry.type === 'fixture-exit');
    assert.ok(startIndex >= 0 && cleanupIndex > startIndex && exitIndex > cleanupIndex,
      'the relay must complete original Interrupt cleanup before closing the original server');
    assert.equal(events.filter(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === 'close-session').length, 1);
  } finally {
    await closed.close();
  }
});

test('Claude relay ends within seconds when its host goes away during a call whose cleanup never finishes', async () => {
  // The host is killed: the relay only sees stdin EOF and nobody sends it a signal.
  const { SHUTDOWN_DRAIN_TIMEOUT_MS } = await import('../claude.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'lcu-claude-relay-gone-'));
  const logPath = join(directory, 'original-fixture.jsonl');
  const logs = () => readRecords(logPath);
  const child = spawn(process.execPath, [relay, process.execPath, fixture], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory, TMPDIR: directory,
      LCU_FIXTURE_LOG: logPath, LCU_LOG_DIR: join(directory, 'diagnostics') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdout.resume();
  child.stderr.resume();
  const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  try {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'claude-relay-gone-test', version: '1' } } });
    send({ method: 'notifications/initialized' });
    // A 'hold-' session's original turn_ended never answers, and the call ignores its cancellation.
    send({ id: 2, method: 'tools/call', params: { name: 'set_turn_context',
      arguments: { session_id: 'hold-gone', turn_id: 'gone-turn', tool_use_id: 'gone-use' } } });
    send({ id: 3, method: 'tools/call', params: { name: 'js', arguments: { code: 'ignore-cancel' },
      _meta: { 'claudecode/toolUseId': 'gone-use' } } });
    await waitFor(() => logs().some(entry => entry.type === 'active-call-start' && entry.code === 'ignore-cancel'));
    const started = Date.now();
    child.stdin.end();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS + 8_000))]);
    const elapsed = Date.now() - started;
    assert.notEqual(child.exitCode ?? child.signalCode, null, `relay still running ${elapsed} ms after its host went away`);
    assert.ok(elapsed < SHUTDOWN_DRAIN_TIMEOUT_MS + 3_000, `relay took ${elapsed} ms to exit`);
    const events = logs();
    const aborted = events.findIndex(entry => entry.type === 'active-call-aborted' && entry.code === 'ignore-cancel');
    const cleanup = events.findIndex(entry => entry.type === 'turn-ended' && entry.args.session_id === 'hold-gone' &&
      entry.args.hook_event_name === 'Interrupt');
    const exit = events.findIndex(entry => entry.type === 'fixture-exit');
    assert.ok(aborted >= 0 && cleanup > aborted && exit > cleanup,
      'the relay cancels the call, then starts Interrupt cleanup, then closes the original server');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const started = logs().find(entry => entry.type === 'fixture-start');
    if (started && !logs().some(entry => entry.type === 'fixture-exit')) {
      try { process.kill(started.pid, 'SIGKILL'); } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Claude relay declines an approval for an agent host app without asking the host', async () => {
  const bridge = await connectRelay();
  try {
    const before = bridge.elicitationRequests.length;
    bridge.respondToNextElicitation({ action: 'accept', content: { choice: 'always' } });
    const result = await callWithContext(bridge.client, 'js', { code: 'approval-native-host' }, {
      toolUseId: 'approval-agent-host',
    });
    assert.deepEqual(JSON.parse(result.content[0].text), { action: 'decline' });
    assert.equal(bridge.elicitationRequests.length, before);
  } finally {
    await bridge.close();
  }
});

test('a refused agent host app never gets a pending approval record for the mod to show', async () => {
  const bridge = await connectRelay();
  try {
    const mod = { 'claudecode/toolUseId': 'toolu_plugin_0123456789abcdef' };
    const message = 'Allow Computer Use to use "LCU Fixture App"?';
    const result = await callWithContext(bridge.client, 'js', { code: 'approval-native-host' }, {
      toolUseId: 'host-no-record',
    });
    assert.deepEqual(JSON.parse(result.content[0].text), { action: 'decline' });
    // The decline short-circuited before broker.open: the mod finds nothing to describe or choose.
    const described = await bridge.client.callTool({
      name: 'approval_request', arguments: { message }, _meta: mod });
    assert.equal(described.isError, true);
    assert.match(described.content[0].text, /No pending native-app approval/);
  } finally {
    await bridge.close();
  }
});

const MOD = { 'claudecode/toolUseId': 'toolu_plugin_0123456789abcdef' };
const approvalCall = (client, name, args, meta = MOD) =>
  client.callTool({ name, arguments: args, _meta: meta });
const NATIVE_MESSAGE = 'Allow Computer Use to use "LCU Fixture App"?';

test('Claude relay answers a native-app approval from the choice the lcu-approve mod recorded', async () => {
  const bridge = await connectRelay();
  try {
    for (const [choice, expected] of [
      ['session', { action: 'accept', content: {}, _meta: { persist: 'session' } }],
      ['always', { action: 'accept', content: {}, _meta: { persist: 'always' } }],
      ['deny', { action: 'decline' }],
      ['cancel', { action: 'cancel' }],
    ]) {
      let described;
      bridge.respondToNextElicitation(async () => {
        const request = await approvalCall(bridge.client, 'approval_request', { message: NATIVE_MESSAGE });
        described = JSON.parse(request.content[0].text);
        const recorded = await approvalCall(bridge.client, 'approval_choice', { id: described.id, choice });
        assert.notEqual(recorded.isError, true);
        // The host's own form is blocked by the mod, so Claude Code answers decline.
        return { action: 'decline' };
      });
      const result = await callWithContext(bridge.client, 'js', { code: 'approval-native' }, {
        toolUseId: `mod-${choice}`,
      });
      assert.deepEqual(JSON.parse(result.content[0].text), expected, choice);
      assert.deepEqual({ ...described, id: 'ID' }, {
        id: 'ID',
        message: NATIVE_MESSAGE,
        app: 'dev.lcu.NativeFixture.generated',
        label: 'dev.lcu.NativeFixture.generated',
        scopes: ['session', 'always'],
        riskLevel: 'low',
      });
      // The record is gone with the elicitation: the choice cannot be replayed.
      const replay = await approvalCall(bridge.client, 'approval_choice', { id: described.id, choice: 'session' });
      assert.equal(replay.isError, true);
    }
  } finally {
    await bridge.close();
  }
});

test('Claude relay falls back to the host answer when the mod recorded nothing', async () => {
  const bridge = await connectRelay();
  try {
    bridge.respondToNextElicitation(async () => ({ action: 'accept', content: { choice: 'session' } }));
    const accepted = await callWithContext(bridge.client, 'js', { code: 'approval-native' }, { toolUseId: 'host-session' });
    assert.deepEqual(JSON.parse(accepted.content[0].text),
      { action: 'accept', content: {}, _meta: { persist: 'session' } });

    // Nothing from the mod at all: the host's decline is the answer.
    bridge.respondToNextElicitation(async () => ({ action: 'decline' }));
    const declined = await callWithContext(bridge.client, 'js', { code: 'approval-native' }, { toolUseId: 'host-decline' });
    assert.deepEqual(JSON.parse(declined.content[0].text), { action: 'decline' });
  } finally {
    await bridge.close();
  }
});

test('Claude relay rejects approval choices that are not the mod\'s, current, single use and offered', async () => {
  const bridge = await connectRelay();
  try {
    const attempts = [];
    bridge.respondToNextElicitation(async () => {
      const described = JSON.parse((await approvalCall(bridge.client, 'approval_request',
        { message: NATIVE_MESSAGE })).content[0].text);
      const choose = (args, meta) => approvalCall(bridge.client, 'approval_choice', args, meta);
      attempts.push(
        // The model's own tool-use ids, no id, and a hook-type call carry no plugin prefix.
        await choose({ id: described.id, choice: 'session' }, { 'claudecode/toolUseId': 'toolu_01ABC' }),
        await choose({ id: described.id, choice: 'session' }, {}),
        await choose({ id: 'not-the-pending-id', choice: 'session' }),
        await choose({ id: described.id, choice: 'forever' }),
        // A second description for the same message finds nothing left to claim.
        await approvalCall(bridge.client, 'approval_request', { message: NATIVE_MESSAGE }),
        await approvalCall(bridge.client, 'approval_request', { message: 'Some other question?' }),
        await approvalCall(bridge.client, 'approval_request', { message: NATIVE_MESSAGE }, { 'claudecode/toolUseId': 'toolu_01model' }),
      );
      const first = await choose({ id: described.id, choice: 'session' });
      const second = await choose({ id: described.id, choice: 'always' });
      attempts.push(second);
      assert.notEqual(first.isError, true);
      return { action: 'decline' };
    });
    const result = await callWithContext(bridge.client, 'js', { code: 'approval-native' }, { toolUseId: 'rejects' });
    assert.deepEqual(attempts.map(attempt => attempt.isError), [true, true, true, true, true, true, true, true]);
    assert.deepEqual(JSON.parse(result.content[0].text),
      { action: 'accept', content: {}, _meta: { persist: 'session' } });

    // Persistent approval not offered: "always" is refused and the record stays open for a valid choice.
    let refused;
    bridge.respondToNextElicitation(async () => {
      const described = JSON.parse((await approvalCall(bridge.client, 'approval_request',
        { message: NATIVE_MESSAGE })).content[0].text);
      assert.deepEqual(described.scopes, ['session']);
      refused = await approvalCall(bridge.client, 'approval_choice', { id: described.id, choice: 'always' });
      // The mod then records what the person can actually choose.
      await approvalCall(bridge.client, 'approval_choice', { id: described.id, choice: 'deny' });
      return { action: 'decline' };
    });
    const sessionOnly = await callWithContext(bridge.client, 'js', { code: 'approval-native-session-only' }, {
      toolUseId: 'rejects-always',
    });
    assert.equal(refused.isError, true);
    assert.deepEqual(JSON.parse(sessionOnly.content[0].text), { action: 'decline' });
  } finally {
    await bridge.close();
  }
});

test('Claude relay keeps a mod-claimed elicitation open past the host decline until the mod chooses', async () => {
  const bridge = await connectRelay();
  try {
    let described;
    const hostDeclined = Promise.withResolvers();
    bridge.respondToNextElicitation(async () => {
      described = JSON.parse((await approvalCall(bridge.client, 'approval_request',
        { message: NATIVE_MESSAGE })).content[0].text);
      hostDeclined.resolve();
      // The mod's hook returned a block at once: the host declines before any press.
      return { action: 'decline' };
    });
    let settled = false;
    const call = callWithContext(bridge.client, 'js', { code: 'approval-native' }, { toolUseId: 'wait' })
      .then(result => { settled = true; return result; });
    // A failed assertion below must not leave the call's rejection at close() unhandled.
    call.catch(() => {});
    await hostDeclined.promise;
    assert.ok(described, 'the mod claimed the record');
    await relayHasHostAnswer(bridge);
    // Had the relay answered the runtime on the host decline, the call would settle in this window.
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(settled, false, 'still waiting for the person');
    const recorded = await approvalCall(bridge.client, 'approval_choice', { id: described.id, choice: 'always' });
    assert.notEqual(recorded.isError, true);
    assert.deepEqual(JSON.parse((await call).content[0].text),
      { action: 'accept', content: {}, _meta: { persist: 'always' } });
  } finally {
    await bridge.close();
  }
});

test('Claude relay answers the runtime with a decline recorded after the host decline', async () => {
  const bridge = await connectRelay();
  try {
    let described;
    const hostCancelled = Promise.withResolvers();
    bridge.respondToNextElicitation(async () => {
      described = JSON.parse((await approvalCall(bridge.client, 'approval_request',
        { message: NATIVE_MESSAGE })).content[0].text);
      hostCancelled.resolve();
      return { action: 'cancel' };
    });
    const call = callWithContext(bridge.client, 'js', { code: 'approval-native' }, { toolUseId: 'wait-deny' });
    call.catch(() => {});
    await hostCancelled.promise;
    // Record the choice only after the relay has acted on the host's cancel.
    await relayHasHostAnswer(bridge);
    await approvalCall(bridge.client, 'approval_choice', { id: described.id, choice: 'deny' });
    assert.deepEqual(JSON.parse((await call).content[0].text), { action: 'decline' });
  } finally {
    await bridge.close();
  }
});

test('Claude relay stops waiting for a mod choice when the call is aborted and refuses it afterwards', async () => {
  const bridge = await connectRelay();
  try {
    let described;
    const hostDeclined = Promise.withResolvers();
    bridge.respondToNextElicitation(async () => {
      described = JSON.parse((await approvalCall(bridge.client, 'approval_request',
        { message: NATIVE_MESSAGE })).content[0].text);
      hostDeclined.resolve();
      return { action: 'decline' };
    });
    const controller = new AbortController();
    const aborted = callWithContext(bridge.client, 'js', { code: 'approval-native' }, {
      toolUseId: 'wait-abort', signal: controller.signal,
    }).then(() => undefined, error => error);
    await hostDeclined.promise;
    // Abort only once the relay is holding the elicitation open past the host decline.
    await relayHasHostAnswer(bridge);
    assert.ok(described);
    controller.abort();
    assert.ok(await aborted, 'the aborted call rejects at the caller');
    // The relay releases the wait and sends Interrupt cleanup upstream in the same tick that
    // handles the cancel, so once the fixture sees it the record is gone.
    await waitFor(() => bridge.logs().some(entry => entry.type === 'turn-ended' &&
      entry.args.hook_event_name === 'Interrupt'));
    // The record ended with the request: the mod's late press is refused, which tells it to close its pane.
    const late = await approvalCall(bridge.client, 'approval_choice', { id: described.id, choice: 'session' });
    assert.equal(late.isError, true);
  } finally {
    await bridge.close();
  }
});

test('Claude relay lists the host-only approval tools for the mod and answers none of them to the model', async () => {
  const bridge = await connectRelay();
  try {
    const names = (await bridge.client.listTools()).tools.map(tool => tool.name);
    for (const name of ['approval_request', 'approval_choice']) assert.ok(names.includes(name), name);
    for (const [name, args] of [['approval_request', { message: NATIVE_MESSAGE }],
      ['approval_choice', { id: 'x', choice: 'always' }]]) {
      const refused = await approvalCall(bridge.client, name, args, { 'claudecode/toolUseId': 'toolu_01model' });
      assert.equal(refused.isError, true, name);
    }
  } finally {
    await bridge.close();
  }
});

test('Claude relay logs each call and approval as metadata only', async () => {
  const bridge = await connectRelay();
  try {
    const codeMarker = 'diag-code-marker-7731';
    const ok = await callWithContext(bridge.client, 'js', { code: codeMarker, timeout_ms: 1234 }, { toolUseId: 'diag-ok' });
    assert.equal(ok.content[0].text, codeMarker);
    const failed = await callWithContext(bridge.client, 'js', { code: 'tool-error' }, { toolUseId: 'diag-error' });
    assert.equal(failed.isError, true);

    bridge.respondToNextElicitation(async () => {
      const request = await approvalCall(bridge.client, 'approval_request', { message: NATIVE_MESSAGE });
      const described = JSON.parse(request.content[0].text);
      await approvalCall(bridge.client, 'approval_choice', { id: described.id, choice: 'always' });
      return { action: 'decline' };
    });
    await callWithContext(bridge.client, 'js', { code: 'approval-native' }, { toolUseId: 'diag-approval' });

    const controller = new AbortController();
    const aborted = callWithContext(bridge.client, 'js', { code: 'cancel-active' }, {
      toolUseId: 'diag-abort', signal: controller.signal,
    }).then(() => undefined, error => error);
    await waitFor(() => bridge.logs().some(entry => entry.type === 'active-call-start'));
    controller.abort();
    await aborted;
    await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'Stop', session_id: 'session-test', turn_id: 'prompt-test',
    } });
    await waitFor(() => bridge.diagnostics().some(entry => entry.event === 'turn_end' && entry.hook_event === 'Stop'));

    const events = bridge.diagnostics();
    const ends = events.filter(entry => entry.event === 'call_end');
    assert.deepEqual(ends.map(entry => [entry.call, entry.tool, entry.outcome]), [
      [1, 'js', 'ok'], [2, 'js', 'tool_error'], [3, 'js', 'ok'], [4, 'js', 'aborted'],
    ]);
    assert.deepEqual(events.find(entry => entry.event === 'call_start'),
      { ...events.find(entry => entry.event === 'call_start'), call: 1, tool: 'js', timeout_ms: 1234 });
    assert.equal(events[0].event, 'log_open');
    assert.ok(events.some(entry => entry.event === 'upstream_connect' && entry.ok === true));

    const open = events.find(entry => entry.event === 'approval_open');
    assert.deepEqual([open.approval, open.call, open.kind, open.app, open.scopes],
      [1, 3, 'native_app', 'dev.lcu.NativeFixture.generated', ['session', 'always']]);
    assert.ok(events.some(entry => entry.event === 'approval_claimed' && entry.approval === 1));
    assert.ok(events.some(entry => entry.event === 'approval_choice' && entry.approval === 1 && entry.choice === 'always'));
    const end = events.find(entry => entry.event === 'approval_end');
    assert.deepEqual([end.approval, end.action, end.persist], [1, 'accept', 'always']);
    assert.equal(typeof end.ms, 'number');
    assert.ok(events.some(entry => entry.event === 'turn_end' && entry.outcome === 'ok'));

    const text = bridge.diagnosticText();
    for (const secret of [codeMarker, 'Original tool-level failure', 'LCU Fixture App', NATIVE_MESSAGE,
      'diag-ok', 'session-test', 'prompt-test']) {
      assert.equal(text.includes(secret), false, secret);
    }
  } finally {
    await bridge.close();
  }
});

test('Claude relay logs a refused agent host approval without its message', async () => {
  const bridge = await connectRelay();
  try {
    await callWithContext(bridge.client, 'js', { code: 'approval-native-host' }, { toolUseId: 'diag-host' });
    const events = bridge.diagnostics();
    assert.equal(events.find(entry => entry.event === 'approval_open').kind, 'agent_host_refused');
    assert.equal(events.find(entry => entry.event === 'approval_end').action, 'decline');
  } finally {
    await bridge.close();
  }
});

const stop = (client, sessionId, turnId, event = 'Stop') => client.callTool({ name: 'turn_ended', arguments: {
  hook_event_name: event, session_id: sessionId, turn_id: turnId,
} });
const upstreamTurnOf = (bridge, toolUseId) => bridge.logs().find(entry => entry.type === 'tool-call' &&
  entry.meta['claudecode/toolUseId'] === toolUseId).meta['x-codex-turn-metadata'].turn_id;

test('cross-turn setting path matches the setup state directory', () => {
  assert.equal(crossTurnSettingPath('/h', 'linux'), '/h/.local/state/lcu/cross-turn.json');
  assert.equal(crossTurnSettingPath('/h', 'darwin'), '/h/.local/state/lcu/cross-turn.json');
  assert.equal(crossTurnSettingPath('C:\\h', 'win32'), 'C:\\h\\AppData\\Local\\LCU\\cross-turn.json');
});

test('cross-turn setting is on only for a regular file with enabled true', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-cross-turn-setting-'));
  try {
    const path = join(directory, 'cross-turn.json');
    assert.equal(crossTurnEnabled(path), false, 'missing');
    const cases = [['{not json', false], ['[]', false], ['null', false], ['true', false], ['"yes"', false],
      ['{}', false], ['{"enabled":false}', false], ['{"enabled":"true"}', false], ['{"enabled":1}', false],
      ['{"enabled":true}', true], ['{"enabled":true,"source":"owner","changed_at":"x"}', true]];
    for (const [text, expected] of cases) {
      writeFileSync(path, text);
      assert.equal(crossTurnEnabled(path), expected, text);
    }
    // Like `lcu cross-turn status`: a UTF-8 BOM is accepted, invalid UTF-8 is not.
    writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"enabled":true}')]));
    assert.equal(crossTurnEnabled(path), true, 'BOM');
    writeFileSync(path, Buffer.concat([Buffer.from('{"enabled":true,"source":"'), Buffer.from([0xff]), Buffer.from('"}')]));
    assert.equal(crossTurnEnabled(path), false, 'invalid UTF-8');
    const target = join(directory, 'real.json');
    writeFileSync(target, '{"enabled":true}');
    rmSync(path);
    symlinkSync(target, path);
    assert.equal(crossTurnEnabled(path), false, 'a symlink is not a regular file');
    assert.equal(crossTurnEnabled(directory), false, 'a directory');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Claude relay with cross-turn on gives a woken turn a fresh upstream turn id that the original service accepts', async () => {
  const bridge = await connectRelay({ crossTurn: true });
  try {
    const sessionId = 'strict-session';
    const turnId = 'strict-prompt';
    const first = await callWithContext(bridge.client, 'js', { code: 'first-life' }, { sessionId, turnId, toolUseId: 'ct-1' });
    assert.equal(first.content[0].text, 'first-life');
    assert.equal(upstreamTurnOf(bridge, 'ct-1'), turnId, 'the first life uses the prompt id unchanged');
    await stop(bridge.client, sessionId, turnId);

    // A background event wakes the same prompt id: the original service would refuse the ended id.
    const second = await callWithContext(bridge.client, 'js', { code: 'second-life' }, { sessionId, turnId, toolUseId: 'ct-2' });
    assert.equal(second.isError, undefined);
    assert.equal(second.content[0].text, 'second-life');
    const fresh = upstreamTurnOf(bridge, 'ct-2');
    assert.notEqual(fresh, turnId);
    const meta = bridge.logs().find(entry => entry.type === 'tool-call' &&
      entry.meta['claudecode/toolUseId'] === 'ct-2').meta['x-codex-turn-metadata'];
    assert.equal(meta.session_id, sessionId);

    const secondStop = await stop(bridge.client, sessionId, turnId);
    assert.equal(secondStop.content[0].text, 'Original cleanup completed.');
    const ends = bridge.logs().filter(entry => entry.type === 'turn-ended');
    assert.deepEqual(ends.map(entry => entry.args.turn_id), [turnId, fresh]);
    assert.equal((await stop(bridge.client, sessionId, turnId)).content[0].text, 'Turn already ended.');

    // A third life gets yet another id.
    await callWithContext(bridge.client, 'js', { code: 'third-life' }, { sessionId, turnId, toolUseId: 'ct-3' });
    const third = upstreamTurnOf(bridge, 'ct-3');
    assert.ok(third !== turnId && third !== fresh);

    // Two binds in one life share the fresh id, and no raw id is logged.
    await callWithContext(bridge.client, 'js', { code: 'third-again' }, { sessionId, turnId, toolUseId: 'ct-4' });
    assert.equal(upstreamTurnOf(bridge, 'ct-4'), third);
    const renewals = bridge.diagnostics().filter(entry => entry.event === 'turn_renew');
    assert.equal(renewals.length, 2);
    assert.ok(!bridge.diagnosticText().includes(fresh));
  } finally {
    await bridge.close();
  }
});

test('Claude relay with cross-turn off keeps the prompt id as the upstream turn id and the original service refuses the woken turn', async () => {
  for (const crossTurn of [false, undefined]) {
    const bridge = await connectRelay({ crossTurn });
    try {
      const sessionId = 'strict-session';
      const turnId = 'strict-prompt';
      await callWithContext(bridge.client, 'js', { code: 'first-life' }, { sessionId, turnId, toolUseId: 'off-1' });
      await stop(bridge.client, sessionId, turnId);
      const second = await callWithContext(bridge.client, 'js', { code: 'second-life' }, { sessionId, turnId, toolUseId: 'off-2' });
      assert.equal(upstreamTurnOf(bridge, 'off-2'), turnId);
      assert.equal(second.isError, true);
      await stop(bridge.client, sessionId, turnId);
      assert.deepEqual(bridge.logs().filter(entry => entry.type === 'turn-ended').map(entry => entry.args.turn_id),
        [turnId, turnId]);
      assert.equal(bridge.diagnostics().filter(entry => entry.event === 'turn_renew').length, 0);
    } finally {
      await bridge.close();
    }
  }
});

test('Claude relay with cross-turn on renews a subagent turn under the child identity', async () => {
  const bridge = await connectRelay({ crossTurn: true });
  try {
    const agentId = 'strict-child';
    const turnId = 'strict-shared-prompt';
    await callWithContext(bridge.client, 'js', { code: 'a' }, {
      sessionId: 'strict-parent', turnId, toolUseId: 'sub-1', agentId });
    assert.equal(upstreamTurnOf(bridge, 'sub-1'), subagentTurnId(agentId, turnId));
    await stop(bridge.client, agentId, turnId, 'SubagentStop');
    const again = await callWithContext(bridge.client, 'js', { code: 'b' }, {
      sessionId: 'strict-parent', turnId, toolUseId: 'sub-2', agentId });
    assert.equal(again.isError, undefined);
    const fresh = upstreamTurnOf(bridge, 'sub-2');
    assert.notEqual(fresh, turnId);
    await stop(bridge.client, agentId, turnId, 'SubagentStop');
    const ends = bridge.logs().filter(entry => entry.type === 'turn-ended');
    assert.deepEqual(ends.map(entry => [entry.args.session_id, entry.args.hook_event_name, entry.args.turn_id]),
      [[agentId, 'SubagentStop', subagentTurnId(agentId, turnId)], [agentId, 'SubagentStop', fresh]]);
  } finally {
    await bridge.close();
  }
});

test('Claude relay with cross-turn on renews after an Interrupt, also while the Interrupt is still in flight', async () => {
  const bridge = await connectRelay({ crossTurn: true });
  try {
    const sessionId = 'strict-session';
    const turnId = 'strict-interrupt';
    const controller = new AbortController();
    const aborted = callWithContext(bridge.client, 'js', { code: 'cancel-active' }, {
      sessionId, turnId, toolUseId: 'int-1', signal: controller.signal,
    }).then(value => ({ value }), error => ({ error }));
    await waitFor(() => bridge.logs().some(entry => entry.type === 'active-call-start'));
    controller.abort();
    assert.ok((await aborted).error);
    await waitFor(() => bridge.logs().some(entry => entry.type === 'turn-ended'));

    const live = await callWithContext(bridge.client, 'js', { code: 'int-live' }, { sessionId, turnId, toolUseId: 'int-2' });
    assert.equal(live.isError, undefined);
    const fresh = upstreamTurnOf(bridge, 'int-2');
    assert.notEqual(fresh, turnId);
    await stop(bridge.client, sessionId, turnId);
    assert.deepEqual(bridge.logs().filter(entry => entry.type === 'turn-ended')
      .map(entry => [entry.args.hook_event_name, entry.args.turn_id]), [['Interrupt', turnId], ['Stop', fresh]]);
  } finally {
    await bridge.close();
  }
});

test('Claude relay with cross-turn on renews a re-bind that lands while Interrupt cleanup is in flight', async () => {
  const bridge = await connectRelay({ crossTurn: true });
  try {
    const sessionId = 'hold-session';
    const turnId = 'hold-cross';
    const controller = new AbortController();
    const aborted = callWithContext(bridge.client, 'js', { code: 'cancel-active' }, {
      sessionId, turnId, toolUseId: 'hc-1', signal: controller.signal,
    }).then(value => ({ value }), error => ({ error }));
    await waitFor(() => bridge.logs().some(entry => entry.type === 'active-call-start'));
    controller.abort();
    assert.ok((await aborted).error);
    await waitFor(() => bridge.logs().some(entry => entry.type === 'turn-ended'));
    await callWithContext(bridge.client, 'js', { code: 'release-held-cleanup' }, { sessionId, turnId, toolUseId: 'hc-2' });
    const fresh = upstreamTurnOf(bridge, 'hc-2');
    assert.notEqual(fresh, turnId);
    await stop(bridge.client, sessionId, turnId);
    assert.deepEqual(bridge.logs().filter(entry => entry.type === 'turn-ended').map(entry => entry.args.turn_id),
      [turnId, fresh]);
  } finally {
    await bridge.close();
  }
});

test('Claude relay with cross-turn on ends a renewed turn with its fresh id when the host goes away', async () => {
  const bridge = await connectRelay({ crossTurn: true });
  try {
    const sessionId = 'strict-session';
    const turnId = 'strict-drain';
    await callWithContext(bridge.client, 'js', { code: 'x' }, { sessionId, turnId, toolUseId: 'dr-1' });
    await stop(bridge.client, sessionId, turnId);
    await callWithContext(bridge.client, 'js', { code: 'y' }, { sessionId, turnId, toolUseId: 'dr-2' });
    const fresh = upstreamTurnOf(bridge, 'dr-2');
    await bridge.client.close();
    await waitFor(() => bridge.logs().filter(entry => entry.type === 'turn-ended').length === 2);
    const last = bridge.logs().filter(entry => entry.type === 'turn-ended')[1];
    assert.deepEqual([last.args.hook_event_name, last.args.turn_id], ['Interrupt', fresh]);
  } finally {
    await bridge.close();
  }
});

test('Claude relay: a foreground subagent ending never ends the parent turn, with cross-turn on or off', async () => {
  for (const crossTurn of [false, true]) {
    const bridge = await connectRelay({ crossTurn });
    try {
      const parent = 'strict-parent';
      const child = 'strict-child';
      const turnId = 'strict-shared';
      await callWithContext(bridge.client, 'js', { code: 'p1' }, { sessionId: parent, turnId, toolUseId: 'fg-1' });
      await callWithContext(bridge.client, 'js', { code: 'c1' }, { sessionId: parent, turnId, toolUseId: 'fg-2', agentId: child });
      await stop(bridge.client, child, turnId, 'SubagentStop');
      const after = await callWithContext(bridge.client, 'js', { code: 'p2' }, { sessionId: parent, turnId, toolUseId: 'fg-3' });
      assert.equal(after.isError, undefined, `crossTurn=${crossTurn}`);
      assert.equal(upstreamTurnOf(bridge, 'fg-3'), turnId);
      assert.deepEqual(bridge.logs().filter(entry => entry.type === 'turn-ended').map(entry => entry.args.turn_id),
        [subagentTurnId(child, turnId)]);
    } finally {
      await bridge.close();
    }
  }
});

test('Claude relay: a background subagent after the parent Stop is refused with cross-turn off and works with it on', async () => {
  for (const crossTurn of [false, true]) {
    const bridge = await connectRelay({ crossTurn });
    try {
      const parent = 'strict-parent';
      const child = 'strict-child';
      const turnId = 'strict-background';
      await callWithContext(bridge.client, 'js', { code: 'p1' }, { sessionId: parent, turnId, toolUseId: 'bg-1' });
      const live = await callWithContext(bridge.client, 'js', { code: 'c1' }, { sessionId: parent, turnId, toolUseId: 'bg-2', agentId: child });
      assert.equal(live.isError, undefined);
      await stop(bridge.client, parent, turnId);
      const ends = () => bridge.logs().filter(entry => entry.type === 'turn-ended');
      const later = await callWithContext(bridge.client, 'js', { code: 'c2' }, { sessionId: parent, turnId, toolUseId: 'bg-3', agentId: child });
      if (crossTurn) {
        assert.equal(later.isError, undefined);
        assert.equal(upstreamTurnOf(bridge, 'bg-3'), subagentTurnId(child, turnId));
        assert.deepEqual(ends().map(entry => entry.args.turn_id), [turnId], 'no cascade');
      } else {
        assert.equal(later.isError, true);
        assert.equal(upstreamTurnOf(bridge, 'bg-3'), turnId);
        assert.deepEqual(ends().map(entry => [entry.args.session_id, entry.args.turn_id]),
          [[parent, turnId], [child, subagentTurnId(child, turnId)]], 'cascade to the live subagent');
      }
      // The subagent's own SubagentStop still cleans up in the relay.
      assert.ok(!(await stop(bridge.client, child, turnId, 'SubagentStop')).isError);
    } finally {
      await bridge.close();
    }
  }
});

const rejected = async promise => {
  try { return (await promise).isError === true; } catch { return true; }
};
const turnEnds = bridge => bridge.logs().filter(entry => entry.type === 'turn-ended');

test('Claude relay: cancelling a call of an ended life does not end the renewed life', async () => {
  const bridge = await connectRelay({ crossTurn: true });
  try {
    const sessionId = 'strict-session';
    const turnId = 'strict-old-call';
    const controller = new AbortController();
    const old = callWithContext(bridge.client, 'js', { code: 'cancel-active' }, {
      sessionId, turnId, toolUseId: 'oc-1', signal: controller.signal,
    }).then(value => ({ value }), error => ({ error }));
    await waitFor(() => bridge.logs().some(entry => entry.type === 'active-call-start'));
    await stop(bridge.client, sessionId, turnId);
    await bindContext(bridge.client, { sessionId, turnId, toolUseId: 'oc-2' });
    controller.abort();
    assert.ok((await old).error);
    await bridge.client.ping();
    assert.equal(turnEnds(bridge).length, 1, 'the old life was already ended; no cleanup for the renewed one');
    const live = await bridge.client.callTool({ name: 'js', arguments: { code: 'renewed' },
      _meta: { 'claudecode/toolUseId': 'oc-2' } });
    assert.equal(live.isError, undefined, 'the renewed life keeps its bound identity');
    const fresh = upstreamTurnOf(bridge, 'oc-2');
    assert.notEqual(fresh, turnId);
    await stop(bridge.client, sessionId, turnId);
    assert.deepEqual(turnEnds(bridge).map(entry => entry.args.turn_id), [turnId, fresh]);
  } finally {
    await bridge.close();
  }
});

test('Claude relay: the parent cascade ends each subagent id it captured even if a subagent re-binds meanwhile', async () => {
  const bridge = await connectRelay({ crossTurn: false });
  try {
    const turnId = 'cascade-prompt';
    await callWithContext(bridge.client, 'js', { code: 'a' }, { sessionId: 'p-session', turnId, toolUseId: 'cs-p' });
    await callWithContext(bridge.client, 'js', { code: 'a' }, { sessionId: 'p-session', turnId, toolUseId: 'cs-a', agentId: 'hold-a' });
    await callWithContext(bridge.client, 'js', { code: 'b' }, { sessionId: 'p-session', turnId, toolUseId: 'cs-b', agentId: 'child-b' });
    const parentStop = stop(bridge.client, 'p-session', turnId);
    await waitFor(() => turnEnds(bridge).some(entry => entry.args.session_id === 'hold-a'));
    // Child B re-binds while A's cascade cleanup is held: its mapping moves to the ended prompt id.
    await bindContext(bridge.client, { sessionId: 'p-session', turnId, toolUseId: 'cs-b2', agentId: 'child-b' });
    await callWithContext(bridge.client, 'js', { code: 'release-held-cleanup' }, { sessionId: 'other', turnId: 'other', toolUseId: 'cs-r' });
    await parentStop;
    const forB = turnEnds(bridge).filter(entry => entry.args.session_id === 'child-b');
    assert.deepEqual(forB.map(entry => entry.args.turn_id), [subagentTurnId('child-b', turnId)],
      'B\'s live id from when the cascade began is ended, not the prompt id twice');
  } finally {
    await bridge.close();
  }
});

test('Claude relay with cross-turn off refuses a subagent bound while the parent Stop is still pending', async () => {
  for (const crossTurn of [false, true]) {
    const bridge = await connectRelay({ crossTurn });
    try {
      const parent = 'hold-strict-parent';
      const turnId = 'strict-pending';
      await callWithContext(bridge.client, 'js', { code: 'p' }, { sessionId: parent, turnId, toolUseId: 'pd-p' });
      const parentStop = stop(bridge.client, parent, turnId);
      await waitFor(() => turnEnds(bridge).some(entry => entry.args.session_id === parent));
      const child = await callWithContext(bridge.client, 'js', { code: 'c' }, {
        sessionId: parent, turnId, toolUseId: 'pd-c', agentId: 'strict-child' });
      assert.equal(child.isError === true, !crossTurn, `crossTurn=${crossTurn}`);
      assert.equal(upstreamTurnOf(bridge, 'pd-c'), crossTurn ? subagentTurnId('strict-child', turnId) : turnId);
      await callWithContext(bridge.client, 'js', { code: 'release-held-cleanup' }, { sessionId: 'other', turnId: 'other', toolUseId: 'pd-r' });
      await parentStop;
    } finally {
      await bridge.close();
    }
  }
});

test('Claude relay bounds its history by eviction and never refuses work or cleanup for it', async () => {
  const fill = async (bridge, count) => {
    for (let index = 0; index < count; index++) {
      await callWithContext(bridge.client, 'js', { code: 'f' }, {
        sessionId: `strict-fill-${index}`, turnId: `fill-${index}`, toolUseId: `fill-${index}` });
      await stop(bridge.client, `strict-fill-${index}`, `fill-${index}`);
    }
  };
  // Off: a prompt closed more than the cap ago is forgotten, so its child runs on its own id (prior behavior).
  let bridge = await connectRelay({ crossTurn: false, maxEndedTurns: 3 });
  try {
    await callWithContext(bridge.client, 'js', { code: 'p0' }, { sessionId: 'strict-p', turnId: 'strict-p0', toolUseId: 'ev-p' });
    await stop(bridge.client, 'strict-p', 'strict-p0');
    const early = await callWithContext(bridge.client, 'js', { code: 'c' }, {
      sessionId: 'strict-p', turnId: 'strict-p0', toolUseId: 'ev-c1', agentId: 'strict-c1' });
    assert.equal(early.isError, true, 'refused while the prompt is remembered');
    await fill(bridge, 3);
    const late = await callWithContext(bridge.client, 'js', { code: 'c' }, {
      sessionId: 'strict-p', turnId: 'strict-p0', toolUseId: 'ev-c2', agentId: 'strict-c2' });
    assert.equal(late.isError, undefined, 'no refusal because of history size');
    await fill(bridge, 5);
    assert.ok(!(await stop(bridge.client, 'strict-late', 'late-prompt')).isError, 'cleanup is never refused either');
  } finally {
    await bridge.close();
  }
  // On: an evicted key rebinds with its prompt id, which upstream may refuse (prior behavior).
  bridge = await connectRelay({ crossTurn: true, maxEndedTurns: 3 });
  try {
    await callWithContext(bridge.client, 'js', { code: 'p0' }, { sessionId: 'strict-p', turnId: 'strict-p0', toolUseId: 'ev-p' });
    await stop(bridge.client, 'strict-p', 'strict-p0');
    await fill(bridge, 2);
    await callWithContext(bridge.client, 'js', { code: 'kept' }, { sessionId: 'strict-p', turnId: 'strict-p0', toolUseId: 'ev-kept' });
    assert.notEqual(upstreamTurnOf(bridge, 'ev-kept'), 'strict-p0', 'remembered: renewed');
    await stop(bridge.client, 'strict-p', 'strict-p0');
    await fill(bridge, 3);
    await callWithContext(bridge.client, 'js', { code: 'old' }, { sessionId: 'strict-p', turnId: 'strict-p0', toolUseId: 'ev-old' });
    assert.equal(upstreamTurnOf(bridge, 'ev-old'), 'strict-p0', 'evicted: forwards its prompt id');
  } finally {
    await bridge.close();
  }
});

test('Claude relay cascade captures child ids when the parent end starts, even if a child re-binds while it is held', async () => {
  const bridge = await connectRelay({ crossTurn: false });
  try {
    const parent = 'hold-strict-parent';
    const turnId = 'strict-snapshot';
    await callWithContext(bridge.client, 'js', { code: 'p' }, { sessionId: parent, turnId, toolUseId: 'sn-p' });
    await callWithContext(bridge.client, 'js', { code: 'c' }, { sessionId: parent, turnId, toolUseId: 'sn-c', agentId: 'strict-child' });
    const parentStop = stop(bridge.client, parent, turnId);
    await waitFor(() => turnEnds(bridge).some(entry => entry.args.session_id === parent));
    // The child re-binds from its own id to the closed prompt id while the parent's reply is held.
    await bindContext(bridge.client, { sessionId: parent, turnId, toolUseId: 'sn-c2', agentId: 'strict-child' });
    await callWithContext(bridge.client, 'js', { code: 'release-held-cleanup' }, { sessionId: 'other', turnId: 'other', toolUseId: 'sn-r' });
    await parentStop;
    assert.deepEqual(turnEnds(bridge).filter(entry => entry.args.session_id === 'strict-child')
      .map(entry => entry.args.turn_id), [subagentTurnId('strict-child', turnId)]);
  } finally {
    await bridge.close();
  }
});

test('Claude relay keeps a prompt closed when upstream answers its end with an error', async () => {
  const bridge = await connectRelay({ crossTurn: false });
  try {
    const parent = 'fail-strict-parent';
    const turnId = 'strict-failed-end';
    await callWithContext(bridge.client, 'js', { code: 'p' }, { sessionId: parent, turnId, toolUseId: 'fe-p' });
    assert.equal(await rejected(stop(bridge.client, parent, turnId)), true);
    const child = await callWithContext(bridge.client, 'js', { code: 'c' }, {
      sessionId: parent, turnId, toolUseId: 'fe-c', agentId: 'strict-child' });
    assert.equal(child.isError, true);
    assert.equal(upstreamTurnOf(bridge, 'fe-c'), turnId);
  } finally {
    await bridge.close();
  }
});

test('Claude relay renews a child that an off-mode cascade ended once cross-turn is turned on', async () => {
  const bridge = await connectRelay({ crossTurn: false });
  try {
    const parent = 'strict-parent';
    const turnId = 'strict-flip';
    await callWithContext(bridge.client, 'js', { code: 'p' }, { sessionId: parent, turnId, toolUseId: 'fl-p' });
    await callWithContext(bridge.client, 'js', { code: 'c' }, { sessionId: parent, turnId, toolUseId: 'fl-c', agentId: 'strict-child' });
    await stop(bridge.client, parent, turnId);
    writeFileSync(crossTurnSettingPath(bridge.directory), '{"enabled":true}');
    const again = await callWithContext(bridge.client, 'js', { code: 'c2' }, {
      sessionId: parent, turnId, toolUseId: 'fl-c2', agentId: 'strict-child' });
    assert.equal(again.isError, undefined);
    const fresh = upstreamTurnOf(bridge, 'fl-c2');
    assert.ok(fresh !== turnId && fresh !== subagentTurnId('strict-child', turnId));
  } finally {
    await bridge.close();
  }
});

test('Claude relay shutdown waits for a superseded life whose cleanup is still pending', async () => {
  const bridge = await connectRelay({ crossTurn: true });
  try {
    const sessionId = 'hold-session';
    const turnId = 'sd-turn';
    await callWithContext(bridge.client, 'js', { code: 'u' }, { sessionId, turnId, toolUseId: 'sd-1' });
    const heldStop = stop(bridge.client, sessionId, turnId).catch(() => {});
    await waitFor(() => turnEnds(bridge).length === 1);
    await callWithContext(bridge.client, 'js', { code: 'v' }, { sessionId, turnId, toolUseId: 'sd-2' });
    assert.ok(!(await stop(bridge.client, sessionId, turnId)).isError);
    const closing = Date.now();
    await bridge.client.close();
    await heldStop;
    // close() returns once the relay has exited (or been killed after the SDK's grace), so its duration shows
    // whether the relay held on for the pending cleanup; no fixture-exit record is needed (and none is
    // reliable when Windows kills the relay).
    assert.ok(Date.now() - closing >= 1_500,
      'the held cleanup of the superseded life kept the original server open for the drain window');
  } finally {
    await bridge.close();
  }
});

test('Claude relay keeps a renewed id on its active life and rejects new turns at the live limit', async () => {
  const bridge = await connectRelay({ crossTurn: true });
  try {
    const sessionId = 'strict-session';
    const turnId = 'strict-oldest';
    await callWithContext(bridge.client, 'js', { code: 'a' }, { sessionId, turnId, toolUseId: 'lim-0' });
    await stop(bridge.client, sessionId, turnId);
    await bindContext(bridge.client, { sessionId, turnId, toolUseId: 'lim-1' });
    let refusedAt;
    for (let index = 0; index < 1100 && refusedAt === undefined; index++) {
      if (await rejected(bindContext(bridge.client, {
        sessionId: `limit-${index}`, turnId: `limit-${index}`, toolUseId: `limit-${index}` }))) refusedAt = index;
    }
    assert.ok(refusedAt !== undefined, 'new work is rejected once too many turns are live');
    const live = await bridge.client.callTool({ name: 'js', arguments: { code: 'still' },
      _meta: { 'claudecode/toolUseId': 'lim-1' } });
    assert.equal(live.isError, undefined);
    const fresh = upstreamTurnOf(bridge, 'lim-1');
    assert.notEqual(fresh, turnId);
    await stop(bridge.client, sessionId, turnId);
    assert.deepEqual(turnEnds(bridge).map(entry => entry.args.turn_id), [turnId, fresh]);
  } finally {
    await bridge.close();
  }
});

test('Claude relay does not let a child context bound before the parent Stop run on its live id afterwards', async () => {
  const bridge = await connectRelay({ crossTurn: false });
  try {
    const parent = 'hold-strict-parent';
    const turnId = 'strict-prebound';
    await callWithContext(bridge.client, 'js', { code: 'p' }, { sessionId: parent, turnId, toolUseId: 'pb-p' });
    await callWithContext(bridge.client, 'js', { code: 'c0' }, { sessionId: parent, turnId, toolUseId: 'pb-c0', agentId: 'strict-child' });
    await bindContext(bridge.client, { sessionId: parent, turnId, toolUseId: 'pb-c', agentId: 'strict-child' });
    const parentStop = stop(bridge.client, parent, turnId);
    await waitFor(() => turnEnds(bridge).some(entry => entry.args.session_id === parent));
    const child = await bridge.client.callTool({ name: 'js', arguments: { code: 'late-child' },
      _meta: { 'claudecode/toolUseId': 'pb-c' } });
    assert.equal(child.isError, true);
    assert.equal(upstreamTurnOf(bridge, 'pb-c'), turnId);
    await callWithContext(bridge.client, 'js', { code: 'release-held-cleanup' }, { sessionId: 'other', turnId: 'other', toolUseId: 'pb-r' });
    await parentStop;
  } finally {
    await bridge.close();
  }
});

test('Claude relay renews with cross-turn on after its own cleanup failed', async () => {
  const bridge = await connectRelay({ crossTurn: true });
  try {
    const sessionId = 'fail-strict-main';
    const turnId = 'strict-own-failed';
    await callWithContext(bridge.client, 'js', { code: 'a' }, { sessionId, turnId, toolUseId: 'of-1' });
    assert.equal(await rejected(stop(bridge.client, sessionId, turnId)), true);
    const again = await callWithContext(bridge.client, 'js', { code: 'b' }, { sessionId, turnId, toolUseId: 'of-2' });
    assert.equal(again.isError, undefined);
    assert.notEqual(upstreamTurnOf(bridge, 'of-2'), turnId);
  } finally {
    await bridge.close();
  }
});

test('Claude relay recovers a child refused with cross-turn off once cross-turn is turned on', async () => {
  const bridge = await connectRelay({ crossTurn: false });
  try {
    const parent = 'strict-parent';
    const turnId = 'strict-recover';
    await callWithContext(bridge.client, 'js', { code: 'p' }, { sessionId: parent, turnId, toolUseId: 'rc-p' });
    await stop(bridge.client, parent, turnId);
    const refused = await callWithContext(bridge.client, 'js', { code: 'c' }, {
      sessionId: parent, turnId, toolUseId: 'rc-c', agentId: 'strict-child' });
    assert.equal(refused.isError, true);
    writeFileSync(crossTurnSettingPath(bridge.directory), '{"enabled":true}');
    const again = await callWithContext(bridge.client, 'js', { code: 'c2' }, {
      sessionId: parent, turnId, toolUseId: 'rc-c2', agentId: 'strict-child' });
    assert.equal(again.isError, undefined);
    assert.equal(upstreamTurnOf(bridge, 'rc-c2') === turnId, false);
  } finally {
    await bridge.close();
  }
});

test('Claude relay shutdown ends the children its parent cascade submits during the drain', async () => {
  const bridge = await connectRelay({ crossTurn: false });
  try {
    const parent = 'sd-parent';
    const turnId = 'sd-cascade';
    await callWithContext(bridge.client, 'js', { code: 'p' }, { sessionId: parent, turnId, toolUseId: 'sc-p' });
    for (const child of ['sd-child-1', 'sd-child-2']) {
      await callWithContext(bridge.client, 'js', { code: 'c' }, { sessionId: parent, turnId, toolUseId: `sc-${child}`, agentId: child });
    }
    await bridge.client.close();
    for (const child of ['sd-child-1', 'sd-child-2']) {
      await waitFor(() => bridge.logs().some(entry => entry.type === 'turn-ended' && entry.args.session_id === child));
    }
  } finally {
    await bridge.close();
  }
});

test('Claude relay recommits a prompt closure on a deduplicated Stop after history eviction', async () => {
  const bridge = await connectRelay({ crossTurn: false, maxEndedTurns: 3 });
  try {
    const sessionId = 'hold-strict-p';
    const turnId = 'strict-p0';
    await callWithContext(bridge.client, 'js', { code: 'p0' }, { sessionId, turnId, toolUseId: 'rc2-p' });
    // P0's cleanup is held: its prompt is closed at once, its key is recorded only when the reply arrives.
    const firstStop = stop(bridge.client, sessionId, turnId);
    await waitFor(() => turnEnds(bridge).some(entry => entry.args.session_id === sessionId));
    for (const index of [1, 2, 3]) await stop(bridge.client, `strict-u${index}`, `u${index}`);
    await callWithContext(bridge.client, 'js', { code: 'release-held-cleanup' }, { sessionId: 'other', turnId: 'other', toolUseId: 'rc2-r' });
    await firstStop;
    // P0's prompt is now evicted from the history, but its key survives.
    const before = turnEnds(bridge).length;
    const dedupe = await stop(bridge.client, sessionId, turnId);
    assert.equal(dedupe.content[0].text, 'Turn already ended.');
    assert.equal(turnEnds(bridge).length, before, 'no additional upstream cleanup for P0');
    const child = await callWithContext(bridge.client, 'js', { code: 'c' }, {
      sessionId, turnId, toolUseId: 'rc2-c', agentId: 'strict-c' });
    assert.equal(child.isError, true, 'the deduplicated Stop recommitted the prompt closure');
  } finally {
    await bridge.close();
  }
});

test('Claude relay renews a key whose end was reported before its first bind, main and subagent', async () => {
  const bridge = await connectRelay({ crossTurn: true });
  try {
    const turnId = 'strict-unbound-end';
    await stop(bridge.client, 'strict-main', turnId);
    const main = await callWithContext(bridge.client, 'js', { code: 'm' }, { sessionId: 'strict-main', turnId, toolUseId: 'ub-m' });
    assert.equal(main.isError, undefined);
    assert.notEqual(upstreamTurnOf(bridge, 'ub-m'), turnId);

    await stop(bridge.client, 'strict-agent', turnId, 'SubagentStop');
    const child = await callWithContext(bridge.client, 'js', { code: 's' }, {
      sessionId: 'strict-main', turnId, toolUseId: 'ub-s', agentId: 'strict-agent' });
    assert.equal(child.isError, undefined);
    assert.notEqual(upstreamTurnOf(bridge, 'ub-s'), subagentTurnId('strict-agent', turnId));
  } finally {
    await bridge.close();
  }
});

test('Claude relay reads a cross-turn setting that starts with a UTF-8 BOM', async () => {
  const bridge = await connectRelay({ crossTurn: false });
  try {
    writeFileSync(crossTurnSettingPath(bridge.directory),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"enabled":true}')]));
    const sessionId = 'strict-bom';
    await callWithContext(bridge.client, 'js', { code: 'a' }, { sessionId, turnId: 'strict-bom', toolUseId: 'bom-1' });
    await stop(bridge.client, sessionId, 'strict-bom');
    const again = await callWithContext(bridge.client, 'js', { code: 'b' }, { sessionId, turnId: 'strict-bom', toolUseId: 'bom-2' });
    assert.equal(again.isError, undefined);
  } finally {
    await bridge.close();
  }
});

test('Claude relay ends every turn that ran js before js_reset stops the worker holding their hooks', async () => {
  for (const crossTurn of [false, true]) {
    const bridge = await connectRelay({ crossTurn });
    try {
      const parent = 'strict-reset-parent';
      const child = 'strict-reset-child';
      const turnId = 'strict-reset-prompt';
      const idle = 'strict-reset-idle';
      await callWithContext(bridge.client, 'js', { code: 'p1' }, { sessionId: parent, turnId, toolUseId: 'rs-1' });
      await callWithContext(bridge.client, 'js', { code: 'c1' }, { sessionId: parent, turnId, toolUseId: 'rs-2', agentId: child });
      // A turn that only bound a context ran nothing on the worker and is left alone.
      await bindContext(bridge.client, { sessionId: idle, turnId: 'idle-prompt', toolUseId: 'rs-idle' });
      const reset = await callWithContext(bridge.client, 'js_reset', {}, { sessionId: parent, turnId, toolUseId: 'rs-3' });
      assert.equal(reset.content[0].text, 'Original reset result.');

      const records = bridge.logs();
      const resetAt = records.findIndex(entry => entry.type === 'tool-call' && entry.name === 'js_reset');
      const ends = records.slice(0, resetAt).filter(entry => entry.type === 'turn-ended');
      assert.deepEqual(ends.map(entry => [entry.args.hook_event_name, entry.args.session_id, entry.args.turn_id]).sort(), [
        ['Interrupt', child, subagentTurnId(child, turnId)],
        ['Interrupt', parent, turnId],
      ], `crossTurn=${crossTurn}: both turns end upstream before the reset is forwarded`);
      const fresh = upstreamTurnOf(bridge, 'rs-3');
      assert.notEqual(fresh, turnId, 'the reset call already carries the fresh id');

      // The same turn keeps working after the reset, its subagent too: the prompt was not closed.
      const after = await callWithContext(bridge.client, 'js', { code: 'p2' }, { sessionId: parent, turnId, toolUseId: 'rs-4' });
      assert.equal(after.isError, undefined, `crossTurn=${crossTurn}`);
      assert.equal(upstreamTurnOf(bridge, 'rs-4'), fresh);
      const childAfter = await callWithContext(bridge.client, 'js', { code: 'c2' },
        { sessionId: parent, turnId, toolUseId: 'rs-5', agentId: child });
      assert.equal(childAfter.isError, undefined, `crossTurn=${crossTurn}`);
      const childFresh = upstreamTurnOf(bridge, 'rs-5');
      assert.ok(![turnId, fresh, subagentTurnId(child, turnId)].includes(childFresh));

      await stop(bridge.client, child, turnId, 'SubagentStop');
      await stop(bridge.client, parent, turnId);
      const stops = bridge.logs().filter(entry => entry.type === 'turn-ended').slice(2);
      assert.deepEqual(stops.map(entry => entry.args.turn_id), [childFresh, fresh]);

      const turnEnds = bridge.diagnostics().filter(entry => entry.event === 'turn_end');
      assert.deepEqual(turnEnds.filter(entry => entry.cause === 'js_reset').map(entry => [entry.outcome, entry.sky_hook]),
        [['ok', 'live'], ['ok', 'live']]);
      assert.deepEqual(turnEnds.filter(entry => !entry.cause).map(entry => [entry.hook_event, entry.sky_hook]),
        [['SubagentStop', 'live'], ['Stop', 'live']]);
    } finally {
      await bridge.close();
    }
  }
});

test('Claude relay logs whether a turn end can reach the original hook', async () => {
  const bridge = await connectRelay();
  try {
    // No js on the worker: nothing to reach.
    await bindContext(bridge.client, { sessionId: 'hook-none', turnId: 'prompt-none', toolUseId: 'hk-1' });
    await stop(bridge.client, 'hook-none', 'prompt-none');
    // A reset with no turn on the worker ends nothing upstream.
    await callWithContext(bridge.client, 'js_reset', {}, { sessionId: 'hook-reset', turnId: 'prompt-reset', toolUseId: 'hk-2' });
    assert.equal(bridge.logs().filter(entry => entry.type === 'turn-ended').length, 1);
    assert.equal(upstreamTurnOf(bridge, 'hk-2'), 'prompt-reset');
    await stop(bridge.client, 'hook-reset', 'prompt-reset');
    assert.deepEqual(bridge.diagnostics().filter(entry => entry.event === 'turn_end').map(entry => entry.sky_hook),
      ['none', 'none']);
  } finally {
    await bridge.close();
  }
});
