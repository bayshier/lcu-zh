import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const logPath = process.env.LCU_CODEX_FIXTURE_LOG;
const log = entry => appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
const AUDIO_BYTES = Buffer.from([0, 17, 34, 51, 68, 85, 102, 119, 128, 255]);

const tools = [
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
  {
    name: 'js_add_node_module_dir',
    description: 'Synthetic host-only module registration tool.',
    inputSchema: {
      type: 'object', properties: { path: { type: 'string' } },
      required: ['path'], additionalProperties: false,
    },
    _meta: { ui: { visibility: [] } },
  },
  {
    name: 'turn_ended',
    description: 'Synthetic host-only turn cleanup tool.',
    inputSchema: {
      type: 'object',
      properties: {
        hook_event_name: { type: 'string' },
        session_id: { type: 'string' },
        turn_id: { type: 'string' },
      },
      required: ['hook_event_name', 'session_id', 'turn_id'],
      additionalProperties: false,
    },
    _meta: { ui: { visibility: [] } },
  },
];

const server = new Server({ name: 'lcu-codex-contract-fixture', version: '7.4.2' }, {
  capabilities: { tools: { listChanged: true } },
  instructions: 'Synthetic Codex relay instructions. Keep this exact fixture text.',
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

function approvalRequest() {
  return {
    mode: 'form',
    message: 'Approve the synthetic fixture operation?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      connector_id: 'fixture-connector',
      persist: ['session', 'always'],
      fixtureRequestMarker: { retained: true },
    },
  };
}

function waitUntilAborted(signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener('abort', resolve, { once: true });
  });
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args = {}, _meta } = request.params;
  log({ type: 'call', name, args, meta: _meta });

  if (name === 'turn_ended') {
    return { content: [{ type: 'text', text: 'Synthetic cleanup complete.' }] };
  }
  if (name === 'js_add_node_module_dir') {
    return { content: [{ type: 'text', text: 'Synthetic module path registered.' }] };
  }
  if (name === 'js_reset') {
    return { content: [{ type: 'text', text: 'Synthetic reset complete.' }] };
  }

  switch (args.code) {
    case 'rich-result':
      return {
        content: [
          { type: 'text', text: 'Synthetic text before image.', annotations: { audience: ['assistant'] } },
          { type: 'image', data: 'AQID', mimeType: 'image/png' },
        ],
        structuredContent: { fixture: { retained: true } },
        _meta: { fixtureResultMarker: { revision: 3 } },
      };
    case 'tool-error':
      return {
        isError: true,
        content: [{ type: 'text', text: 'Synthetic tool-level failure.' }],
        _meta: { fixtureErrorMarker: true },
      };
    case 'audio-result':
      log({ type: 'audio-payload', data: AUDIO_BYTES.toString('base64') });
      return {
        isError: false,
        content: [
          { type: 'text', text: 'Synthetic audio before.' },
          {
            type: 'audio', data: AUDIO_BYTES.toString('base64'), mimeType: 'audio/wav',
            annotations: { audience: ['assistant'] },
          },
          { type: 'image', data: 'AQID', mimeType: 'image/png' },
          { type: 'text', text: 'Synthetic audio after.' },
        ],
        structuredContent: { fixtureAudioResult: { retained: true } },
        _meta: { fixtureAudioMarker: { revision: 4 } },
      };
    case 'approval': {
      const response = await server.elicitInput(approvalRequest(), { signal: extra.signal });
      log({ type: 'elicitation-response', response });
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }
    case 'wait-for-abort':
      log({ type: 'call-waiting-for-abort', meta: _meta });
      await waitUntilAborted(extra.signal);
      log({ type: 'call-aborted', meta: _meta });
      return { content: [{ type: 'text', text: 'Fixture observed cancellation.' }] };
    case 'send-progress':
    case 'send-progress-then-fail':
      await server.notification({
        method: 'notifications/progress',
        params: {
          progressToken: _meta?.progressToken,
          progress: 2,
          total: 5,
          message: 'Synthetic fixture progress.',
        },
      });
      if (args.code === 'send-progress-then-fail') {
        throw new Error('Synthetic failure after progress.');
      }
      return { content: [{ type: 'text', text: 'Progress sent.' }] };
    case 'notify-tools-changed':
      await server.notification({ method: 'notifications/tools/list_changed' });
      return { content: [{ type: 'text', text: 'Tool list notification sent.' }] };
    default:
      return { content: [{ type: 'text', text: `Synthetic result: ${args.code ?? ''}` }] };
  }
});

log({ type: 'fixture-start', pid: process.pid });
process.on('exit', code => log({ type: 'fixture-exit', pid: process.pid, code }));
process.stdin.on('end', () => process.exit(0));
await server.connect(new StdioServerTransport());
