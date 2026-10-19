import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'hermes-original-cua-fixture', version: '1' },
  { capabilities: { tools: {} }, instructions: 'Original CUA initialization guide.' });
const record = value => process.env.LCU_FIXTURE_LOG && appendFileSync(process.env.LCU_FIXTURE_LOG, `${JSON.stringify(value)}\n`);
let failCleanupOnce = true;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'js', description: 'Original JS description.', inputSchema: {
    type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false,
  } },
  { name: 'js_reset', description: 'Original reset description.', inputSchema: {
    type: 'object', properties: {}, additionalProperties: false,
  } },
  { name: 'turn_ended', description: 'Internal cleanup.', inputSchema: { type: 'object' } },
  { name: 'js_add_node_module_dir', description: 'Internal.', inputSchema: { type: 'object' } },
] }));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args, _meta } = request.params;
  record({ name, args, meta: _meta });
  if (name === 'turn_ended' && args.session_id === 'cleanup-once' && failCleanupOnce) {
    failCleanupOnce = false;
    return { isError: true, content: [{ type: 'text', text: 'cleanup failed once' }] };
  }
  if (name === 'turn_ended') return { content: [{ type: 'text', text: 'cleanup ok' }] };
  if (args?.code === 'approval-native' || args?.code === 'approval-native-session-only' ||
      args?.code === 'approval-form' || args?.code === 'approval-origin') {
    const native = args.code.startsWith('approval-native');
    const browserOrigin = args.code === 'approval-origin';
    const decision = await server.elicitInput({
      mode: 'form', message: native ? 'Allow Computer Use to use "Fixture App"?' : 'Enter fixture text',
      requestedSchema: native || browserOrigin ? { type: 'object', properties: {} } : {
        type: 'object', properties: { text: { type: 'string' } }, required: ['text'],
      },
      _meta: browserOrigin ? { codex_approval_kind: 'mcp_tool_call', connector_id: 'browser-use',
        tool_name: 'access_browser_origin', origin: 'http://127.0.0.1:8080', persist: 'always' } : native ? {
        codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use',
        persist: args.code === 'approval-native-session-only' ? ['session'] : ['session', 'always'],
        tool_name: 'get_app_state', tool_params: { app: 'dev.lcu.fixture' } } : {},
    });
    record({ name: 'elicitation-result', code: args.code, decision });
    return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
  }
  if (args?.code === 'image') return { content: [
    { type: 'text', text: 'Original screenshot result.' },
    { type: 'image', data: 'AAECAw==', mimeType: 'image/png' },
  ] };
  if (args?.code === 'audio') return { content: [
    { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
  ] };
  return { content: [{ type: 'text', text: name === 'js' ? String(args?.code) : name }] };
});

await server.connect(new StdioServerTransport());
