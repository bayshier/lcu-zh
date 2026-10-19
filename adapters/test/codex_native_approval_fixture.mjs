import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Harmless protocol/UI fixture. It never opens the named app or performs an
// operation; it reproduces the native approval elicitation sent by Mac CUA.
const logPath = process.env.LCU_APPROVAL_LOG;
const app = process.env.LCU_FIXTURE_APP;
const sessionId = process.env.LCU_FIXTURE_SESSION;
const turnId = process.env.LCU_FIXTURE_TURN;
if (!logPath || !app || !sessionId || !turnId) {
  throw new Error('Codex approval fixture environment is incomplete');
}

const server = new McpServer(
  { name: 'lcu-codex-native-approval-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.registerTool('native_app', {
  description: 'Ask Codex to render the original native computer-use approval choices.',
  inputSchema: {},
}, async () => {
  const request = {
    mode: 'form',
    message: 'Allow Computer Use to use "LCU Mac Native Fixture"?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: {
      progressToken: 0,
      codex_approval_kind: 'mcp_tool_call',
      connector_id: 'computer-use',
      connector_name: 'Computer Use',
      persist: ['session', 'always'],
      riskLevel: 'low',
      tool_name: 'get_app_state',
      tool_params: { app },
      tool_params_display: [{ display_name: 'App', name: 'app', value: 'LCU Mac Native Fixture' }],
      'x-codex-turn-metadata': { session_id: sessionId, turn_id: turnId },
    },
  };
  appendFileSync(logPath, JSON.stringify({ kind: 'request', request }) + '\n');
  const response = await server.server.elicitInput(request);
  appendFileSync(logPath, JSON.stringify({ kind: 'response', response }) + '\n');
  if (response.action !== 'accept') {
    return { isError: true, content: [{ type: 'text', text: `approval ${response.action}` }] };
  }
  return { content: [{ type: 'text', text: 'Fixture approval recorded; no app operation was performed.' }] };
});
await server.connect(new StdioServerTransport());
