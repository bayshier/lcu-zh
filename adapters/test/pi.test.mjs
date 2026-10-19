import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import piExtension from '../pi/index.ts';

const fixture = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url));

async function waitForFileMatch(path, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const entries = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      if (predicate(entries)) return entries;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Fixture did not reach the expected state within ${timeoutMs} ms`);
}

test('Pi keeps one original CUA turn across model rounds and cleans up after agent_end', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-pi-'));
  const log = join(directory, 'mcp.jsonl');
  const oldCommand = process.env.LCU_MCP_COMMAND;
  const oldLog = process.env.LCU_FIXTURE_LOG;
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, fixture]);
  process.env.LCU_FIXTURE_LOG = log;
  const handlers = new Map();
  const tools = new Map();
  let audioDirectory;
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
  };
  const ctx = { sessionManager: { getSessionId: () => 'pi-real-session' },
    model: { id: 'pi-model' }, hasUI: false };
  try {
    piExtension(pi);
    const emptyOptions = { appendSystemPrompt: '' };
    const prompt = await handlers.get('before_agent_start')(
      { systemPrompt: 'Pi base prompt', systemPromptOptions: emptyOptions }, ctx);
    assert.equal(prompt, undefined);
    assert.match(emptyOptions.appendSystemPrompt, /Original CUA initialization guide/);
    const withText = { appendSystemPrompt: 'Existing append' };
    const before = handlers.get('before_agent_start');
    await before({ systemPrompt: 'Pi base prompt', systemPromptOptions: withText }, ctx);
    assert.match(withText.appendSystemPrompt, /^Existing append\n\nOriginal CUA initialization guide/s);
    const once = withText.appendSystemPrompt;
    assert.equal(await before({ systemPrompt: 'Pi base prompt', systemPromptOptions: withText }, ctx), undefined);
    assert.equal(withText.appendSystemPrompt, once);
    const legacy = await before({ systemPrompt: 'Pi base prompt' }, ctx);
    assert.match(legacy.systemPrompt, /^Pi base prompt\n\nOriginal CUA initialization guide/);
    assert.deepEqual([...tools.keys()], ['js', 'js_reset']);
    assert.equal(tools.get('js').description, 'Original JS description.');
    assert.deepEqual(tools.get('js').parameters.required, ['code']);
    await handlers.get('agent_start')({}, ctx);
    const first = await tools.get('js').execute('1', { code: 'first' }, undefined, undefined, ctx);
    assert.equal(first.content[0].text, 'first');
    // Pi emits turn_end after each assistant/model round. LCU cleanup belongs
    // to agent_end, so this event has no adapter handler.
    assert.equal(handlers.has('turn_end'), false);
    const second = await tools.get('js').execute('2', { code: 'second' }, undefined, undefined, ctx);
    assert.equal(second.content[0].text, 'second');
    const audio = await tools.get('js').execute('3', { code: 'audio' }, undefined, undefined, ctx);
    assert.equal('isError' in audio, false);
    assert.match(audio.content[0].text, /original MIME type: audio\/wav/);
    const audioPath = /saved to (.+)$/.exec(audio.content[0].text)?.[1];
    assert.ok(audioPath);
    assert.equal(isAbsolute(audioPath), true);
    assert.deepEqual(readFileSync(audioPath), Buffer.from('AAAA', 'base64'));
    audioDirectory = dirname(audioPath);
    let entries = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries.some(entry => entry.name === 'turn_ended'), false);
    assert.equal(entries[0].meta['x-codex-turn-metadata'].session_id, 'pi-real-session');
    assert.equal(entries[0].meta['x-codex-turn-metadata'].turn_id,
      entries[1].meta['x-codex-turn-metadata'].turn_id);
    assert.equal(entries[0].meta['x-codex-turn-metadata'].model, 'pi-model');
    assert.equal(entries[0].meta['x-codex-turn-metadata'].call_id, '1');
    assert.equal(entries[1].meta['x-codex-turn-metadata'].call_id, '2');
    assert.equal(entries[0].meta['x-codex-turn-metadata'].thread_id, undefined);
    await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
    entries = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const ended = entries.filter(entry => entry.name === 'turn_ended');
    assert.equal(ended.length, 1);
    assert.deepEqual(ended[0].args, {
      hook_event_name: 'Stop', session_id: 'pi-real-session',
      turn_id: entries[0].meta['x-codex-turn-metadata'].turn_id,
    });
    await handlers.get('session_shutdown')();
  } finally {
    await handlers.get('session_shutdown')?.();
    if (audioDirectory) rmSync(audioDirectory, { recursive: true, force: true });
    if (oldCommand === undefined) delete process.env.LCU_MCP_COMMAND;
    else process.env.LCU_MCP_COMMAND = oldCommand;
    if (oldLog === undefined) delete process.env.LCU_FIXTURE_LOG;
    else process.env.LCU_FIXTURE_LOG = oldLog;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Pi /lcu stop reaches private host control while the original tool call is pending',
  { skip: process.platform === 'win32' && 'the macOS host-control endpoint is a Unix socket' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-pi-stop-'));
  const log = join(directory, 'mcp.jsonl');
  const oldCommand = process.env.LCU_MCP_COMMAND;
  const oldLog = process.env.LCU_FIXTURE_LOG;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, fixture]);
  process.env.LCU_FIXTURE_LOG = log;
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const notifications = [];
  const selections = [];
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  const ctx = {
    sessionManager: { getSessionId: () => 'pi-stop-session' },
    model: { id: 'pi-stop-model' }, hasUI: true,
    ui: {
      async select(title, options) { selections.push({ title, options }); return options[0]; },
      notify(message, type) { notifications.push({ message, type }); },
    },
  };
  try {
    piExtension(pi);
    await handlers.get('before_agent_start')({ systemPrompt: 'Pi' }, ctx);
    await handlers.get('agent_start')({}, ctx);
    const pending = tools.get('js').execute('tool-call-live', { code: 'stop-pending' }, undefined, undefined, ctx);
    const calls = await waitForFileMatch(log, entries => entries.some(entry =>
      entry.name === 'js' && entry.args.code === 'stop-pending'));
    const turn = calls.find(entry => entry.name === 'js').meta['x-codex-turn-metadata'];
    assert.equal(typeof turn.session_id, 'string');
    assert.equal(turn.call_id, 'tool-call-live');
    assert.equal(typeof turn.turn_id, 'string');

    assert.equal(typeof commands.get('lcu')?.handler, 'function');
    await commands.get('lcu').handler('stop', ctx);
    const result = await pending;
    assert.equal(result.content[0].text, 'Original stopped condition.');
    assert.deepEqual(selections, [{
      title: 'Stop computer use for an app', options: ['Fixture App (dev.lcu.fixture)'],
    }]);
    assert.deepEqual(notifications.at(-1), { message: 'Requested Computer Use Stop for Fixture App.', type: 'info' });

    const entries = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const controls = entries.filter(entry => entry.type === 'control').map(entry => entry.request);
    assert.deepEqual(controls, [
      { type: 'status', session_id: turn.session_id, turn_id: turn.turn_id },
      { type: 'stop', session_id: turn.session_id, turn_id: turn.turn_id, app: 'dev.lcu.fixture' },
    ]);
    await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
  } finally {
    await handlers.get('session_shutdown')?.();
    if (oldCommand === undefined) delete process.env.LCU_MCP_COMMAND;
    else process.env.LCU_MCP_COMMAND = oldCommand;
    if (oldLog === undefined) delete process.env.LCU_FIXTURE_LOG;
    else process.env.LCU_FIXTURE_LOG = oldLog;
    Object.defineProperty(process, 'platform', platformDescriptor);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Pi /lcu pick preserves profile and tab identity in the editor without claiming user tabs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-pi-pick-user-'));
  const log = join(directory, 'mcp.jsonl');
  const oldCommand = process.env.LCU_MCP_COMMAND;
  const oldLog = process.env.LCU_FIXTURE_LOG;
  const oldStale = process.env.LCU_PICK_STALE;
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, fixture]);
  process.env.LCU_FIXTURE_LOG = log;
  delete process.env.LCU_PICK_STALE;
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const selections = [];
  const notifications = [];
  let editor = 'Summarize the selected page';
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  const ctx = {
    sessionManager: { getSessionId: () => 'pi-picker-session' },
    model: { id: 'pi-picker-model' }, hasUI: true,
    ui: {
      async select(title, options) {
        selections.push({ title, options });
        if (title === 'Pick a Computer Use target') return 'Browser tabs (2 browsers)';
        if (title === 'Pick a browser or profile') return options.find(option => option.includes('profile-b'));
        if (title.startsWith('Pick tab type')) return 'Open user tab';
        if (title.startsWith('Pick a tab')) return options.find(option => option.includes('[702]'));
        return undefined;
      },
      getEditorText() { return editor; },
      setEditorText(value) { editor = value; },
      notify(message, type) { notifications.push({ message, type }); },
    },
  };
  try {
    piExtension(pi);
    await commands.get('lcu').handler('pick', ctx);
    assert.deepEqual(selections[1], {
      title: 'Pick a browser or profile',
      options: ['Chrome · extension · chrome · profile-a · profile-a',
        'Chrome · extension · chrome · profile-b · profile-b'],
    });
    assert.ok(selections[3].options[0].includes('[701]'));
    assert.ok(selections[3].options[1].includes('[702]'));
    assert.match(editor, /^Summarize the selected page\n\n/);
    assert.match(editor, /browser ID "profile-b"/);
    assert.match(editor, /provider tab ID "702"/);
    assert.match(editor, /https:\/\/work\.example\/reports/);
    assert.match(editor, /openTabs\(\).*claimTab/s);
    assert.match(editor, /do not claim another tab/);

    const entries = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const calls = entries.filter(entry => entry.name === 'js');
    assert.deepEqual(calls.map(entry => entry.args.code.match(/lcu-pick:[\w-]+/)?.[0]), [
      'lcu-pick:inventory', 'lcu-pick:user-tabs', 'lcu-pick:verify-user-tab',
    ]);
    assert.ok(calls.every(entry => entry.meta['x-codex-turn-metadata'].session_id === 'pi-picker-session'));
    assert.ok(calls.every(entry => entry.meta['x-codex-turn-metadata'].model === 'pi-picker-model'));
    assert.ok(calls.every(entry => entry.meta['x-codex-turn-metadata'].call_id === undefined));
    assert.equal(entries.filter(entry => entry.name === 'turn_ended').length, 1);
    assert.match(notifications.at(-1).message, /Review and submit/);
  } finally {
    await handlers.get('session_shutdown')?.();
    if (oldCommand === undefined) delete process.env.LCU_MCP_COMMAND;
    else process.env.LCU_MCP_COMMAND = oldCommand;
    if (oldLog === undefined) delete process.env.LCU_FIXTURE_LOG;
    else process.env.LCU_FIXTURE_LOG = oldLog;
    if (oldStale === undefined) delete process.env.LCU_PICK_STALE;
    else process.env.LCU_PICK_STALE = oldStale;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Pi /lcu pick uses exact session tab IDs and preserves a stale or cancelled selection safely', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-pi-pick-session-'));
  const log = join(directory, 'mcp.jsonl');
  const oldCommand = process.env.LCU_MCP_COMMAND;
  const oldLog = process.env.LCU_FIXTURE_LOG;
  const oldStale = process.env.LCU_PICK_STALE;
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, fixture]);
  process.env.LCU_FIXTURE_LOG = log;
  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  let editor = 'Keep this draft';
  let cancelType = false;
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    registerTool() {}, registerCommand(name, command) { commands.set(name, command); },
  };
  const ctx = {
    sessionManager: { getSessionId: () => 'pi-session-tab-session' },
    model: { id: 'pi-model' }, hasUI: true,
    ui: {
      async select(title, options) {
        if (title === 'Pick a Computer Use target') return 'Browser tabs (2 browsers)';
        if (title === 'Pick a browser or profile') return options.find(option => option.includes('profile-b'));
        if (title.startsWith('Pick tab type')) return cancelType ? undefined : 'Session tab';
        if (title.startsWith('Pick a tab')) return options.find(option => option.includes('[session-tab-b]'));
        return undefined;
      },
      getEditorText() { return editor; }, setEditorText(value) { editor = value; },
      notify(message, type) { notifications.push({ message, type }); },
    },
  };
  try {
    piExtension(pi);
    process.env.LCU_PICK_STALE = 'session-tab';
    await commands.get('lcu').handler('pick', ctx);
    assert.equal(editor, 'Keep this draft');
    assert.match(notifications.at(-1).message, /changed or is no longer available/);
    let entries = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(entries.some(entry => entry.name === 'js' && entry.args.code.includes('lcu-pick:verify-session-tab')));
    assert.equal(entries.filter(entry => entry.name === 'turn_ended').length, 1);

    delete process.env.LCU_PICK_STALE;
    cancelType = true;
    const before = entries.length;
    await commands.get('lcu').handler('pick', ctx);
    assert.equal(editor, 'Keep this draft');
    entries = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries.filter(entry => entry.name === 'turn_ended').length, 2);
    assert.equal(entries.slice(before).filter(entry => entry.name === 'js').length, 1);
  } finally {
    await handlers.get('session_shutdown')?.();
    if (oldCommand === undefined) delete process.env.LCU_MCP_COMMAND;
    else process.env.LCU_MCP_COMMAND = oldCommand;
    if (oldLog === undefined) delete process.env.LCU_FIXTURE_LOG;
    else process.env.LCU_FIXTURE_LOG = oldLog;
    if (oldStale === undefined) delete process.env.LCU_PICK_STALE;
    else process.env.LCU_PICK_STALE = oldStale;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Pi picker cleanup ends only its private turn when a real Pi turn starts during selection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-pi-pick-overlap-'));
  const log = join(directory, 'mcp.jsonl');
  const oldCommand = process.env.LCU_MCP_COMMAND;
  const oldLog = process.env.LCU_FIXTURE_LOG;
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, fixture]);
  process.env.LCU_FIXTURE_LOG = log;
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const notifications = [];
  let editor = 'Existing draft';
  let startTurnDuringSelect = true;
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  const ctx = {
    sessionManager: { getSessionId: () => 'fail-once-session' },
    model: { id: 'real-model' }, hasUI: true,
    ui: {
      async select(title, options) {
        if (title === 'Pick a Computer Use target' && startTurnDuringSelect) {
          startTurnDuringSelect = false;
          await handlers.get('agent_start')({}, ctx);
        }
        return options[0];
      },
      getEditorText() { return editor; }, setEditorText(value) { editor = value; },
      notify(message, type) { notifications.push({ message, type }); },
    },
  };
  try {
    piExtension(pi);
    await handlers.get('before_agent_start')({ systemPrompt: 'Pi' }, ctx);
    await commands.get('lcu').handler('pick', ctx);
    assert.equal(editor, 'Existing draft');
    assert.ok(notifications.some(item => /A Pi turn started while the picker was open/.test(item.message)));
    assert.ok(notifications.some(item => /picker cleanup failed/.test(item.message)));

    await tools.get('js').execute('real-call-after-picker', { code: 'real-call-after-picker' }, undefined, undefined, ctx);
    const entries = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const pickerCall = entries.find(entry => entry.name === 'js' && entry.args.code.includes('// lcu-pick:inventory'));
    const pickerTurn = pickerCall.meta['x-codex-turn-metadata'].turn_id;
    const endedTurns = entries.filter(entry => entry.name === 'turn_ended');
    assert.deepEqual(endedTurns.map(entry => entry.args.turn_id), [pickerTurn, pickerTurn]);
    const activeCall = entries.find(entry => entry.name === 'js' && entry.args.code === 'real-call-after-picker');
    assert.equal(activeCall.meta['x-codex-turn-metadata'].session_id, 'fail-once-session');
    assert.notEqual(activeCall.meta['x-codex-turn-metadata'].turn_id, pickerTurn);
    await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
  } finally {
    await handlers.get('session_shutdown')?.();
    if (oldCommand === undefined) delete process.env.LCU_MCP_COMMAND;
    else process.env.LCU_MCP_COMMAND = oldCommand;
    if (oldLog === undefined) delete process.env.LCU_FIXTURE_LOG;
    else process.env.LCU_FIXTURE_LOG = oldLog;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Pi asks for non-origin empty-form approval and cancels unsupported forms', async () => {
  const oldCommand = process.env.LCU_MCP_COMMAND;
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, fixture]);
  const handlers = new Map();
  const tools = new Map();
  const prompts = [];
  const pi = { on(event, handler) { handlers.set(event, handler); },
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {} };
  const ctx = { sessionManager: { getSessionId: () => 'pi-approval-session' },
    model: { id: 'pi-model' }, hasUI: true,
    ui: { async select(title, options) { prompts.push([title, options]); return 'Allow'; } } };
  try {
    piExtension(pi);
    await handlers.get('before_agent_start')({ systemPrompt: 'Pi' }, ctx);
    await handlers.get('agent_start')({}, ctx);
    const native = await tools.get('js').execute('1', { code: 'approval-other' }, undefined, undefined, ctx);
    assert.equal(native.content[0].text, 'accept');
    assert.deepEqual(prompts, [['Allow native window access?', ['Allow', 'Decline']]]);
    const form = await tools.get('js').execute('2', { code: 'approval-form' }, undefined, undefined, ctx);
    assert.equal(form.content[0].text, 'cancel');
    assert.equal(prompts.length, 1);
    await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'aborted' }] }, ctx);
  } finally {
    await handlers.get('session_shutdown')?.();
    if (oldCommand === undefined) delete process.env.LCU_MCP_COMMAND;
    else process.env.LCU_MCP_COMMAND = oldCommand;
  }
});

test('Pi forwards only the native app approval persistence scope selected in its UI', async () => {
  const oldCommand = process.env.LCU_MCP_COMMAND;
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, fixture]);
  const handlers = new Map();
  const tools = new Map();
  const prompts = [];
  let selection = 'Allow for this session';
  const pi = { on(event, handler) { handlers.set(event, handler); }, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {} };
  const ctx = { sessionManager: { getSessionId: () => 'pi-native-approval-session' },
    model: { id: 'pi-model' }, hasUI: true,
    ui: {
      async select(title, options) { prompts.push({ title, options }); return selection; },
      async confirm() { assert.fail('Native app requests use the scope selector'); },
    } };
  try {
    piExtension(pi);
    await handlers.get('before_agent_start')({ systemPrompt: 'Pi' }, ctx);
    await handlers.get('agent_start')({}, ctx);
    const execute = async (code, id) => {
      const result = await tools.get('js').execute(id, { code }, undefined, undefined, ctx);
      return JSON.parse(result.content[0].text);
    };
    const session = await execute('approval-native', 'native-session');
    assert.deepEqual(session, { action: 'accept', content: {}, _meta: { persist: 'session' } });
    assert.deepEqual(prompts.at(-1), {
      title: 'Allow Computer Use to use "LCU Fixture App"?',
      options: ['Allow once', 'Allow for this session', 'Always allow', 'Decline'],
    });

    selection = 'Always allow';
    const always = await execute('approval-native', 'native-always');
    assert.deepEqual(always, { action: 'accept', content: {}, _meta: { persist: 'always' } });

    selection = 'Allow once';
    const once = await execute('approval-native', 'native-once');
    assert.deepEqual(once, { action: 'accept', content: {} });

    selection = 'Always allow';
    const forbidden = await execute('approval-native-session-only', 'native-forbidden-scope');
    assert.deepEqual(forbidden, { action: 'cancel' });
    assert.deepEqual(prompts.at(-1).options, ['Allow once', 'Allow for this session', 'Decline']);

    selection = 'Decline';
    assert.deepEqual(await execute('approval-native', 'native-decline'), { action: 'decline' });
    selection = undefined;
    assert.deepEqual(await execute('approval-native', 'native-cancel'), { action: 'cancel' });
    assert.equal(prompts.length, 6);
    await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
  } finally {
    await handlers.get('session_shutdown')?.();
    if (oldCommand === undefined) delete process.env.LCU_MCP_COMMAND;
    else process.env.LCU_MCP_COMMAND = oldCommand;
  }
});

test('Pi retains failed turn cleanup, warns without throwing, and keeps Sky tools blocked', async () => {
  const oldCommand = process.env.LCU_MCP_COMMAND;
  const oldLog = process.env.LCU_FIXTURE_LOG;
  const directory = mkdtempSync(join(tmpdir(), 'lcu-pi-cleanup-'));
  const log = join(directory, 'mcp.jsonl');
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, fixture]);
  process.env.LCU_FIXTURE_LOG = log;
  const handlers = new Map();
  const tools = new Map();
  const pi = { on(event, handler) { handlers.set(event, handler); }, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {} };
  const warnings = [];
  const ctx = { sessionManager: { getSessionId: () => 'fail-session' }, hasUI: false,
    ui: { notify: (message, level) => warnings.push({ message, level }) } };
  try {
    piExtension(pi);
    await handlers.get('before_agent_start')({ systemPrompt: 'Pi' }, ctx);
    await handlers.get('agent_start')({}, ctx);
    await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'warning');
    assert.match(warnings[0].message, /cleanup failed/);
    await assert.rejects(tools.get('js').execute('after-end', { code: 'late' }, undefined, undefined, ctx),
      /active Pi agent turn/);

    // A new turn cannot run Sky actions until the previous cleanup succeeds.
    await handlers.get('agent_start')({}, ctx);
    assert.equal(warnings.length, 2);
    await assert.rejects(tools.get('js').execute('blocked', { code: 'late' }, undefined, undefined, ctx),
      /still finishing the previous turn/);
    let entries = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    let cleanups = entries.filter(entry => entry.name === 'turn_ended');
    assert.equal(cleanups.length, 3);
    assert.equal(entries.some(entry => entry.name === 'js'), false);
    assert.ok(cleanups.every(entry => entry.args.hook_event_name === 'Stop'));
    assert.ok(cleanups.every(entry => entry.args.session_id === 'fail-session'));
    assert.equal(new Set(cleanups.map(entry => entry.args.turn_id)).size, 1);

    // Shutdown also retries the retained cleanup before closing the connection.
    await assert.rejects(handlers.get('session_shutdown')(), /cleanup failed/);
    entries = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    cleanups = entries.filter(entry => entry.name === 'turn_ended');
    assert.equal(cleanups.length, 4);
  } finally {
    await handlers.get('session_shutdown')?.().catch(() => {});
    if (oldCommand === undefined) delete process.env.LCU_MCP_COMMAND;
    else process.env.LCU_MCP_COMMAND = oldCommand;
    if (oldLog === undefined) delete process.env.LCU_FIXTURE_LOG;
    else process.env.LCU_FIXTURE_LOG = oldLog;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Pi can recover when a retained cleanup succeeds on retry', async () => {
  const oldCommand = process.env.LCU_MCP_COMMAND;
  const oldLog = process.env.LCU_FIXTURE_LOG;
  const directory = mkdtempSync(join(tmpdir(), 'lcu-pi-retry-'));
  const log = join(directory, 'mcp.jsonl');
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, fixture]);
  process.env.LCU_FIXTURE_LOG = log;
  const handlers = new Map();
  const tools = new Map();
  const pi = { on(event, handler) { handlers.set(event, handler); }, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {} };
  const warnings = [];
  const ctx = { sessionManager: { getSessionId: () => 'fail-once-session' }, hasUI: false,
    ui: { notify: (message, level) => warnings.push({ message, level }) } };
  try {
    piExtension(pi);
    await handlers.get('before_agent_start')({ systemPrompt: 'Pi' }, ctx);
    await handlers.get('agent_start')({}, ctx);
    await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /cleanup failed once/);

    // Retrying cleanup succeeds before the next turn is made available.
    await handlers.get('agent_start')({}, ctx);
    assert.equal(warnings.length, 1);
    const result = await tools.get('js').execute('new-turn', { code: 'recovered' }, undefined, undefined, ctx);
    assert.equal(result.content[0].text, 'recovered');
    await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);

    const entries = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const cleanups = entries.filter(entry => entry.name === 'turn_ended');
    assert.equal(cleanups.length, 3);
    assert.equal(cleanups[0].args.turn_id, cleanups[1].args.turn_id);
    assert.notEqual(cleanups[1].args.turn_id, cleanups[2].args.turn_id);
  } finally {
    await handlers.get('session_shutdown')?.();
    if (oldCommand === undefined) delete process.env.LCU_MCP_COMMAND;
    else process.env.LCU_MCP_COMMAND = oldCommand;
    if (oldLog === undefined) delete process.env.LCU_FIXTURE_LOG;
    else process.env.LCU_FIXTURE_LOG = oldLog;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Pi warns instead of throwing when the host times out turn cleanup, and holds Sky tools until it clears', async () => {
  const oldCommand = process.env.LCU_MCP_COMMAND;
  const oldLog = process.env.LCU_FIXTURE_LOG;
  const directory = mkdtempSync(join(tmpdir(), 'lcu-pi-timeout-'));
  const log = join(directory, 'mcp.jsonl');
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, fixture]);
  process.env.LCU_FIXTURE_LOG = log;
  const handlers = new Map();
  const tools = new Map();
  const pi = { on(event, handler) { handlers.set(event, handler); }, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {} };
  const warnings = [];
  // The host times out the first three turn_ended calls: agent_end, the
  // agent_start retry, and the first tool call of the new turn.
  const ctx = { sessionManager: { getSessionId: () => 'timeout-3-session' }, hasUI: false,
    ui: { notify: (message, level) => warnings.push({ message, level }) } };
  const readEntries = () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  try {
    piExtension(pi);
    await handlers.get('before_agent_start')({ systemPrompt: 'Pi' }, ctx);
    await handlers.get('agent_start')({}, ctx);
    const first = await tools.get('js').execute('t1', { code: 'first' }, undefined, undefined, ctx);
    assert.equal(first.content[0].text, 'first');

    // Turn end: timeout is a warning, not an error, and cleanup stays pending.
    await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'warning');
    assert.match(warnings[0].message, /may still be finishing in the background/);
    await assert.rejects(tools.get('js').execute('late', { code: 'late' }, undefined, undefined, ctx),
      /active Pi agent turn/);

    // The next turn starts without throwing, but no Sky action runs while the
    // old cleanup is still pending.
    await handlers.get('agent_start')({}, ctx);
    assert.equal(warnings.length, 2);
    // Parallel tool calls share one cleanup retry and are all held.
    const heldCalls = await Promise.allSettled([
      tools.get('js').execute('held-a', { code: 'held-a' }, undefined, undefined, ctx),
      tools.get('js').execute('held-b', { code: 'held-b' }, undefined, undefined, ctx),
    ]);
    assert.deepEqual(heldCalls.map(call => call.status), ['rejected', 'rejected']);
    for (const call of heldCalls) assert.match(String(call.reason), /still finishing the previous turn/);
    assert.equal(readEntries().filter(entry => entry.name === 'js').length, 1);

    // Once the retry succeeds the held turn becomes active.
    const resumed = await tools.get('js').execute('resumed', { code: 'resumed' }, undefined, undefined, ctx);
    assert.equal(resumed.content[0].text, 'resumed');
    await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);

    const entries = readEntries();
    const cleanups = entries.filter(entry => entry.name === 'turn_ended');
    assert.equal(cleanups.length, 5);
    assert.equal(new Set(cleanups.slice(0, 4).map(entry => entry.args.turn_id)).size, 1);
    assert.notEqual(cleanups[3].args.turn_id, cleanups[4].args.turn_id);
    const calls = entries.filter(entry => entry.name === 'js');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].meta['x-codex-turn-metadata'].turn_id, cleanups[4].args.turn_id);
    assert.equal(warnings.length, 2);
  } finally {
    await handlers.get('session_shutdown')?.();
    if (oldCommand === undefined) delete process.env.LCU_MCP_COMMAND;
    else process.env.LCU_MCP_COMMAND = oldCommand;
    if (oldLog === undefined) delete process.env.LCU_FIXTURE_LOG;
    else process.env.LCU_FIXTURE_LOG = oldLog;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Pi drops a held turn that ends while cleanup is pending and never runs its tools', async () => {
  const oldCommand = process.env.LCU_MCP_COMMAND;
  const oldLog = process.env.LCU_FIXTURE_LOG;
  const directory = mkdtempSync(join(tmpdir(), 'lcu-pi-held-end-'));
  const log = join(directory, 'mcp.jsonl');
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, fixture]);
  process.env.LCU_FIXTURE_LOG = log;
  const handlers = new Map();
  const tools = new Map();
  const pi = { on(event, handler) { handlers.set(event, handler); }, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {} };
  const warnings = [];
  const ctx = { sessionManager: { getSessionId: () => 'timeout-2-session' }, hasUI: false,
    ui: { notify: (message, level) => warnings.push({ message, level }) } };
  try {
    piExtension(pi);
    await handlers.get('before_agent_start')({ systemPrompt: 'Pi' }, ctx);
    await handlers.get('agent_start')({}, ctx);
    await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
    await handlers.get('agent_start')({}, ctx);
    assert.equal(warnings.length, 2);
    // The held turn ends before cleanup cleared; this retry succeeds.
    await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
    assert.equal(warnings.length, 2);
    await assert.rejects(tools.get('js').execute('stale', { code: 'stale' }, undefined, undefined, ctx),
      /active Pi agent turn/);
    const entries = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries.filter(entry => entry.name === 'js').length, 0);
    assert.equal(entries.filter(entry => entry.name === 'turn_ended').length, 3);
  } finally {
    await handlers.get('session_shutdown')?.();
    if (oldCommand === undefined) delete process.env.LCU_MCP_COMMAND;
    else process.env.LCU_MCP_COMMAND = oldCommand;
    if (oldLog === undefined) delete process.env.LCU_FIXTURE_LOG;
    else process.env.LCU_FIXTURE_LOG = oldLog;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Pi deduplicates agent_end cleanup when shutdown overlaps it', async () => {
  const oldCommand = process.env.LCU_MCP_COMMAND;
  const oldLog = process.env.LCU_FIXTURE_LOG;
  const directory = mkdtempSync(join(tmpdir(), 'lcu-pi-overlap-'));
  const log = join(directory, 'mcp.jsonl');
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, fixture]);
  process.env.LCU_FIXTURE_LOG = log;
  const handlers = new Map();
  const pi = { on(event, handler) { handlers.set(event, handler); }, registerTool() {}, registerCommand() {} };
  const ctx = { sessionManager: { getSessionId: () => 'overlap-session' }, hasUI: false };
  try {
    piExtension(pi);
    await handlers.get('before_agent_start')({ systemPrompt: 'Pi' }, ctx);
    await handlers.get('agent_start')({}, ctx);
    const ending = handlers.get('agent_end')({
      messages: [{ role: 'assistant', stopReason: 'stop' }],
    }, ctx);
    const shutdown = handlers.get('session_shutdown')();
    await Promise.all([ending, shutdown]);

    const entries = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries.filter(entry => entry.name === 'turn_ended').length, 1);
  } finally {
    await handlers.get('session_shutdown')?.();
    if (oldCommand === undefined) delete process.env.LCU_MCP_COMMAND;
    else process.env.LCU_MCP_COMMAND = oldCommand;
    if (oldLog === undefined) delete process.env.LCU_FIXTURE_LOG;
    else process.env.LCU_FIXTURE_LOG = oldLog;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Pi does not start another host to end a turn when the host never connected', async () => {
  const oldCommand = process.env.LCU_MCP_COMMAND;
  const oldSpawns = process.env.LCU_TEST_SPAWN_LOG;
  const directory = mkdtempSync(join(tmpdir(), 'lcu-pi-noconnect-'));
  const spawns = join(directory, 'spawns');
  // A host that exits at once: connect() fails, as it does when a start outlasts the connect timeout.
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, '-e',
    "require('node:fs').appendFileSync(process.env.LCU_TEST_SPAWN_LOG, 'x'); process.exit(1)"]);
  process.env.LCU_TEST_SPAWN_LOG = spawns;
  const handlers = new Map();
  const pi = { on(event, handler) { handlers.set(event, handler); }, registerTool() {}, registerCommand() {} };
  const warnings = [];
  const ctx = { sessionManager: { getSessionId: () => 'noconnect-session' }, hasUI: false,
    ui: { notify: (message, level) => warnings.push({ message, level }) } };
  try {
    piExtension(pi);
    await assert.rejects(handlers.get('before_agent_start')({ systemPrompt: 'Pi' }, ctx));
    await handlers.get('agent_start')({}, ctx);
    await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
    await handlers.get('session_shutdown')();
    assert.deepEqual(warnings, []);
    assert.equal(readFileSync(spawns, 'utf8'), 'x');
  } finally {
    if (oldCommand === undefined) delete process.env.LCU_MCP_COMMAND;
    else process.env.LCU_MCP_COMMAND = oldCommand;
    if (oldSpawns === undefined) delete process.env.LCU_TEST_SPAWN_LOG;
    else process.env.LCU_TEST_SPAWN_LOG = oldSpawns;
    rmSync(directory, { recursive: true, force: true });
  }
});
