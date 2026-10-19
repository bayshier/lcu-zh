import { createInterface } from 'node:readline';
import { createCuaClient } from '../client.mjs';
import { persistAudioContent } from '../audio-files.mjs';

let cua;
let queue = Promise.resolve();
let elicitationSequence = 0;
const pendingElicitations = new Map();

function requestElicitation(params) {
  return new Promise(resolve => {
    const id = ++elicitationSequence;
    pendingElicitations.set(id, resolve);
    process.stdout.write(`${JSON.stringify({ type: 'elicitation', id, params })}\n`);
  });
}

async function handle(request) {
  switch (request?.type) {
    case 'connect': {
      if (!cua) {
        if (!Array.isArray(request.command) || request.command.length === 0 ||
            request.command.some(part => typeof part !== 'string' || !part)) {
          throw new Error('Hermes LCU config must contain the original LCU MCP command argv');
        }
        cua = createCuaClient({ command: request.command, adapter: 'hermes', onElicitation: requestElicitation });
        try {
          await cua.connect();
        } catch (error) {
          const failed = cua;
          cua = undefined;
          await failed.close().catch(() => {});
          throw error;
        }
      }
      return { instructions: cua.instructions, tools: cua.publicTools() };
    }
    case 'call': {
      if (!cua) throw new Error('Original CUA MCP server is not connected');
      const result = await cua.call(request.name, request.arguments ?? {}, {
        sessionId: request.sessionId,
        turnId: request.turnId,
        toolCallId: request.toolCallId,
      });
      return await persistAudioContent(result);
    }
    case 'turnEnded': {
      if (!cua) return { content: [{ type: 'text', text: 'LCU was not connected.' }] };
      return await cua.turnEnded({
        sessionId: request.sessionId,
        turnId: request.turnId,
        event: request.event,
      });
    }
    case 'close': {
      const current = cua;
      cua = undefined;
      if (current) await current.close();
      return { closed: true };
    }
    default:
      throw new Error(`Unknown Hermes LCU bridge request: ${String(request?.type)}`);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let parsed;
  try { parsed = JSON.parse(line); } catch { parsed = undefined; }
  if (parsed?.type === 'elicitationResponse') {
    const resolve = pendingElicitations.get(parsed.id);
    if (resolve) {
      pendingElicitations.delete(parsed.id);
      resolve(parsed.response);
    }
    return;
  }
  queue = queue.then(async () => {
    let request;
    try {
      request = parsed ?? JSON.parse(line);
      const result = await handle(request);
      process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ id: request?.id, ok: false,
        error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }).catch(error => {
    console.error(`Hermes LCU bridge failure: ${error instanceof Error ? error.message : String(error)}`);
  });
});
input.on('close', async () => {
  for (const resolve of pendingElicitations.values()) resolve({ action: 'cancel' });
  pendingElicitations.clear();
  await queue;
  if (cua) await cua.close().catch(() => {});
});
