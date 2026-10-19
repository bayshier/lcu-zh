// An MCP server that advertises the original node_repl's sandbox-state capability and records
// the `_meta` of each tool call, so a host's real behavior can be observed.
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'sandbox-meta-fixture', version: '1' }, {
  capabilities: { tools: {}, experimental: { 'codex/sandbox-state-meta': {} } },
  instructions: 'Records request metadata.',
});
const tool = name => ({ name, description: name, inputSchema: { type: 'object', properties: { code: { type: 'string' } } } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['js', 'js_reset'].map(tool) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (process.env.LCU_FIXTURE_LOG) {
    appendFileSync(process.env.LCU_FIXTURE_LOG, `${JSON.stringify({ name: request.params.name, meta: request.params._meta ?? null,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('LCU_'))) })}\n`);
  }
  return { content: [{ type: 'text', text: 'recorded' }] };
});
await server.connect(new StdioServerTransport());
