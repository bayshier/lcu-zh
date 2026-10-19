import { appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { runInNewContext } from 'node:vm';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'original-cua-contract-fixture', version: '1' },
  { capabilities: { tools: {} }, instructions: 'Original CUA initialization guide.' });
const record = value => process.env.LCU_FIXTURE_LOG && appendFileSync(process.env.LCU_FIXTURE_LOG, `${JSON.stringify(value)}\n`);
const failedCleanupSessions = new Set();
const cleanupTimeouts = new Map();
let activeRequest;
let completePending;
const controlPath = process.env.LCU_MAC_CONTROL_SOCKET;
if (controlPath) {
  const control = createServer(socket => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', data => {
      input += data;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      record({ type: 'control', request });
      if (!activeRequest || request.session_id !== activeRequest.session_id ||
          request.turn_id !== activeRequest.turn_id) {
        socket.end(`${JSON.stringify({ ok: false, error: 'active turn mismatch' })}\n`);
        return;
      }
      if (request.type === 'status') {
        socket.end(`${JSON.stringify({ ok: true, result: { computerUse: { activeApplications: [
          { id: 'fixture-window', name: 'Fixture App', bundleIdentifier: 'dev.lcu.fixture', bundleURL: '' },
        ] } } })}\n`);
        return;
      }
      if (request.type === 'stop' && request.app === 'dev.lcu.fixture' && completePending) {
        completePending();
        completePending = undefined;
        socket.end(`${JSON.stringify({ ok: true, result: { accepted: true, applicationId: request.app } })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ ok: false, error: 'invalid control request' })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    control.once('error', reject);
    control.listen(controlPath, resolve);
  });
}
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'js', description: 'Original JS description.', inputSchema: {
    type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false,
  } },
  { name: 'js_reset', description: 'Original reset description.', inputSchema: {
    type: 'object', properties: {}, additionalProperties: false,
  } },
  { name: 'js_add_node_module_dir', description: 'Internal.', inputSchema: { type: 'object' } },
  { name: 'turn_ended', description: 'Internal.', inputSchema: { type: 'object' } },
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args, _meta } = request.params;
  record({ name, args, meta: _meta });
  if (name === 'js' && args?.code === 'stop-pending') {
    const turn = _meta?.['x-codex-turn-metadata'] ?? {};
    activeRequest = { session_id: turn.session_id, turn_id: turn.turn_id };
    return new Promise(resolve => {
      completePending = () => resolve({ content: [{ type: 'text', text: 'Original stopped condition.' }] });
    });
  }
  if (name === 'js' && args?.code.includes('// lcu-pick:')) {
    const profile = id => ({ id, name: 'Chrome', type: 'extension', family: 'chrome',
      metadata: { extensionInstanceId: id } });
    const apps = [
      { id: 'dev.lcu.fixture.editor-a', displayName: 'Editor' },
      { id: 'dev.lcu.fixture.editor-b', displayName: 'Editor' },
    ];
    const browsers = [profile('profile-a'), profile('profile-b')];
    const sessionTabs = id => id === 'profile-b'
      ? [{ id: 'session-tab-b', providerTabId: 'provider-b', title: 'Dashboard', url: 'https://work.example/dashboard' }]
      : [{ id: 'session-tab-a', providerTabId: 'provider-a', title: 'Dashboard', url: 'https://personal.example/dashboard' }];
    const userTabs = [
      { id: 'user-a', providerTabId: '701', title: 'Dashboard', url: 'https://work.example/dashboard' },
      { id: 'user-b', providerTabId: '702', title: 'Dashboard', url: 'https://work.example/reports' },
    ];
    const cua = {
      async listApps() {
        if (process.env.LCU_PICK_APP_FAIL === '1') throw new Error('fixture app inventory unavailable');
        return apps;
      },
      browsers: {
        async list() {
          if (process.env.LCU_PICK_BROWSER_FAIL === '1') throw new Error('fixture browser unavailable');
          return browsers;
        },
        async get(id) {
          const selected = browsers.find(item => item.id === id);
          if (!selected) throw new Error('no such original browser');
          return {
            tabs: { async list() {
              const tabs = sessionTabs(id);
              return process.env.LCU_PICK_STALE === 'session-tab' &&
                args.code.includes('verify-session-tab') ? [] : tabs;
            } },
            user: { async openTabs() {
              return process.env.LCU_PICK_STALE === 'user-tab' &&
                args.code.includes('verify-user-tab') ? [] : userTabs;
            } },
          };
        },
      },
    };
    let resultLine;
    await runInNewContext(`(async () => {\n${args.code}\n})()`, {
      cua,
      nodeRepl: { write(value) { resultLine = value; } },
    });
    if (resultLine === undefined) throw new Error('picker code did not write a result');
    return { content: [{ type: 'text', text: resultLine }] };
  }
  // 'timeout-N-session' reproduces the original host's 5 s turn-ended limit on its first N calls.
  const timeoutSession = name === 'turn_ended' && /^timeout-(\d+)-session$/.exec(args?.session_id ?? '');
  if (timeoutSession) {
    const seen = cleanupTimeouts.get(args.session_id) ?? 0;
    cleanupTimeouts.set(args.session_id, seen + 1);
    if (seen < Number(timeoutSession[1])) {
      return { isError: true, content: [{ type: 'text', text: 'turn-ended handlers timed out' }] };
    }
  }
  if (name === 'turn_ended' && args?.session_id === 'fail-session') {
    return { isError: true, content: [{ type: 'text', text: 'cleanup failed' }] };
  }
  if (name === 'turn_ended' && args?.session_id === 'fail-once-session' &&
      !failedCleanupSessions.has(args.session_id)) {
    failedCleanupSessions.add(args.session_id);
    return { isError: true, content: [{ type: 'text', text: 'cleanup failed once' }] };
  }
  if (name === 'js' && ['approval', 'approval-other', 'approval-form', 'approval-native',
    'approval-native-session-only', 'approval-native-host', 'pi-origin-approval', 'pi-origin-lookalike',
    'pi-origin-other-empty'].includes(args?.code)) {
    const browser = args.code === 'approval' || args.code === 'pi-origin-approval' ||
      args.code === 'pi-origin-lookalike';
    const piOrigin = args.code.startsWith('pi-origin-');
    const otherEmpty = args.code === 'pi-origin-other-empty';
    const origin = args.code === 'pi-origin-lookalike'
      ? 'http://127.0.0.1.attacker.invalid:8080' : 'http://127.0.0.1:8080';
    const form = args.code === 'approval-form';
    const native = args.code === 'approval-native' || args.code === 'approval-native-session-only' ||
      args.code === 'approval-native-host';
    const decision = await server.elicitInput({
      message: browser ? `Allow Browser use to access ${origin}?` : otherEmpty
        ? 'Allow Browser use to use your browsing history for this task?' : form ? 'Enter a secret' :
          native ? 'Allow Computer Use to use "LCU Fixture App"?' : 'Allow native window access?',
      _meta: browser ? {
        codex_approval_kind: 'mcp_tool_call',
        codex_sensitive_action: true,
        connector_id: 'browser-use',
        connector_name: 'Browser use',
        persist: 'always',
        tool_name: 'access_browser_origin',
        tool_title: 'Access browser origin',
        tool_params: { origin },
        tool_params_display: [],
        origin,
      } : otherEmpty ? {
        codex_approval_kind: 'mcp_tool_call',
        connector_id: 'browser-use',
        connector_name: 'Browser use',
        persist: 'always',
        subtitle: 'ChatGPT can use records of pages visited, including from earlier sessions, to help with this task.',
        tool_params: { source: 'fixture' },
        sensitive_data: 'browsing_history',
      } : native ? {
        codex_approval_kind: 'mcp_tool_call',
        connector_id: 'computer-use',
        persist: args.code === 'approval-native-session-only' ? ['session'] : ['session', 'always'],
        tool_name: 'get_app_state',
        tool_params: { app: args.code === 'approval-native-host' ? 'com.apple.Terminal' : 'dev.lcu.NativeFixture.generated' },
      } : {},
      requestedSchema: { type: 'object', properties: form ? { secret: { type: 'string' } } : {} },
    });
    return { content: [{ type: 'text', text: native || piOrigin ? JSON.stringify(decision) : decision.action }] };
  }
  if (name === 'js' && args?.code === 'audio') {
    return { content: [{ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }] };
  }
  return { content: [{ type: 'text', text: name === 'js' ? String(args?.code) : name }] };
});
await server.connect(new StdioServerTransport());
