// Forward the original Sky service unchanged; notify the separate original host
// when node_repl reports a real completed or interrupted turn.
import {pathToFileURL} from 'node:url';
import {Buffer} from 'node:buffer';

let original;
let registered = false;

function lifetimeSignal(runtime, session_id, turn_id) {
  const address = runtime.env.LCU_WRE_LIFETIME_PIPE;
  if (!address || typeof runtime.nativePipe?.createConnection !== 'function') {
    throw Error('Original Windows native-pipe lifetime channel is unavailable');
  }
  return runtime.nativePipe.createConnection(address).then(socket => new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    let finished = false;
    const timer = setTimeout(() => finish(Error('Windows native turn cleanup timed out')), 3000);
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.end();
      if (error) reject(error); else resolve(result);
    }
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 4096) return finish(Error('Windows native cleanup response is too large'));
      const newline = data.indexOf(10);
      if (newline < 0) return;
      try {
        const result = JSON.parse(data.subarray(0, newline).toString('utf8'));
        if (!result || typeof result.closed !== 'boolean') {
          throw Error('Windows native cleanup returned an invalid response');
        }
        finish(null, result.closed);
      } catch (error) { finish(error); }
    });
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(Error('Windows native cleanup channel closed')));
    socket.write(Buffer.from(JSON.stringify({session_id, turn_id}) + '\n'));
  }));
}

function register() {
  if (registered) return;
  const runtime = globalThis.nodeRepl;
  if (typeof runtime?.addTurnEndedHandler !== 'function') {
    throw Error('Original node_repl turn-ended hook is unavailable');
  }
  runtime.addTurnEndedHandler({timeoutMs: 4000, run: async ({session_id, turn_id}) => {
    if (typeof session_id !== 'string' || !session_id.trim() ||
        typeof turn_id !== 'string' || !turn_id.trim()) {
      throw Error('Original node_repl turn IDs are missing');
    }
    await lifetimeSignal(runtime, session_id, turn_id);
  }});
  registered = true;
}

export async function handleRpc(request) {
  register();
  original ??= import(pathToFileURL(globalThis.nodeRepl.env.LCU_WRE_SKY_SERVICE_PATH).href);
  return (await original).handleRpc(request);
}
