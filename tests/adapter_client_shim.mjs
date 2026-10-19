// Drive adapters/client.mjs like the Pi extension does: real session and turn IDs, no sandbox metadata.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const [module, ...command] = process.argv.slice(2);
const { createCuaClient } = await import(pathToFileURL(module).href);
const cua = createCuaClient({ command });
const ids = { sessionId: 'adapter-session', turnId: 'adapter-turn' };
let sequence = 0;

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  try {
    let result;
    if (request.type === 'connect') {
      await cua.connect();
      result = { instructions: cua.instructions };
    } else if (request.type === 'call') {
      result = await cua.call(request.name, request.arguments, { ...ids, toolCallId: `call-${++sequence}` });
    } else if (request.type === 'turnEnded') {
      result = await cua.turnEnded(ids);
    } else if (request.type === 'close') {
      await cua.close();
      result = { closed: true };
    } else throw new Error(`unknown request ${request.type}`);
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: false, error: String(error?.message ?? error) })}\n`);
  }
}
await cua.close().catch(() => {});
