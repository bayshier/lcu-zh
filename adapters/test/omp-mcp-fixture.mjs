import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const log = value => process.env.LCU_FIXTURE_LOG &&
  appendFileSync(process.env.LCU_FIXTURE_LOG, `${JSON.stringify(value)}\n`);
const server = new Server({ name: 'lcu-omp-registration-fixture', version: '1' }, {
  capabilities: { tools: {} }, instructions: 'Original CUA initialization guide.',
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'js', description: 'Original JS description.', inputSchema: {
    type: 'object', properties: { code: { type: 'string' } }, required: ['code'],
  } },
  { name: 'js_reset', description: 'Original reset description.', inputSchema: {
    type: 'object', properties: {},
  } },
  { name: 'turn_ended', description: 'Original lifecycle cleanup.', inputSchema: {
    type: 'object', properties: { hook_event_name: { type: 'string' } },
  } },
] }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  log({ name: request.params.name, args: request.params.arguments, meta: extra._meta });
  return { content: [{ type: 'text', text: request.params.name }] };
});
await server.connect(new StdioServerTransport());
