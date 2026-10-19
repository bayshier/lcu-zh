import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TEXT = 'LCU_RESULT_FIXTURE_TEXT_20260926';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, payload])));
  return Buffer.concat([length, name, payload, checksum]);
}

function imageBytes() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const pixel = Buffer.from([0, 0x37, 0xa1, 0xd8, 0xff]); // filter byte + opaque pixel
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixel)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function audioBytes() {
  const sampleRate = 24000;
  const samples = Math.round(sampleRate * 0.08);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 2400), index * 2);
  }
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([wav, pcm]);
}

const definitions = [
  { name: 'js', description: 'Original JS description.', inputSchema: {
    type: 'object', properties: { code: { type: 'string' }, title: { type: 'string' } },
    required: ['code'], additionalProperties: false,
  } },
  { name: 'js_reset', description: 'Original reset description.', inputSchema: {
    type: 'object', properties: {}, additionalProperties: false,
  } },
  { name: 'js_add_node_module_dir', description: 'Add an absolute `node_modules` directory for package imports. The directory remains available after `js_reset`.', inputSchema: {
    type: 'object', properties: { path: { type: 'string', minLength: 1,
      description: 'Absolute path to a node_modules directory to add to Node package resolution.' } },
    required: ['path'], additionalProperties: false,
  }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'turn_ended', description: 'Notify trusted libraries that a Codex turn ended. Repeated notifications for the same session and turn are ignored.', inputSchema: {
    type: 'object', properties: {
      hook_event_name: { type: 'string', minLength: 1 }, session_id: { type: 'string', minLength: 1 }, turn_id: { type: 'string', minLength: 1 },
    }, required: ['hook_event_name', 'session_id', 'turn_id'], additionalProperties: false,
  }, annotations: { idempotentHint: true }, _meta: { ui: { visibility: [] } } },
];

const server = new Server({ name: 'original-cua-result-fixture', version: '1' }, {
  capabilities: { tools: {} },
  instructions: 'Original CUA initialization guide. Preserve this text exactly.',
});
const record = value => process.env.LCU_RESULT_LOG && appendFileSync(process.env.LCU_RESULT_LOG,
  `${JSON.stringify(value)}\n`, { mode: 0o600 });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {}, _meta } = request.params;
  const code = args.code;
  const match = typeof code === 'string' && /^lcu-result:(text|image|audio|error)$/.exec(code);
  record({ kind: 'call', name, args, meta: _meta });
  if (name !== 'js' || !match) {
    if (name === 'js_reset') return { content: [{ type: 'text', text: 'Original reset result.' }] };
    if (name === 'turn_ended') return { content: [{ type: 'text', text: 'Turn ended.' }] };
    if (name === 'js_add_node_module_dir') return { content: [{ type: 'text', text: 'Registered.' }] };
    return { isError: true, content: [{ type: 'text', text: 'Unknown fixture call.' }] };
  }

  const fixtureCase = match[1];
  let result;
  if (fixtureCase === 'text') {
    result = { content: [{ type: 'text', text: TEXT }] };
  } else if (fixtureCase === 'image') {
    const bytes = imageBytes();
    result = { content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }] };
    record({ kind: 'payload', fixtureCase, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  } else if (fixtureCase === 'audio') {
    const bytes = audioBytes();
    result = { content: [{ type: 'audio', data: bytes.toString('base64'), mimeType: 'audio/wav' }] };
    record({ kind: 'payload', fixtureCase, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  } else {
    result = { isError: true, content: [{ type: 'text', text: 'LCU_RESULT_FIXTURE_ERROR_20260926' }] };
  }
  record({ kind: 'result', fixtureCase, result });
  return result;
});

await server.connect(new StdioServerTransport());
