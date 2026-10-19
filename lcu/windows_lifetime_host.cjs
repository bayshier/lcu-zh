// Private lifetime signal only. CUA requests, approvals, and pipe framing stay upstream.
const net = require('node:net');
const crypto = require('node:crypto');

async function startLifetimeSignal(closeActiveTurn, address = `\\\\.\\pipe\\lcu-lifetime-${crypto.randomUUID()}`) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(4000, () => socket.destroy());
    let input = Buffer.alloc(0);
    let handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > 4096) { handled = true; socket.destroy(); return; }
      const newline = input.indexOf(10);
      if (newline < 0) return;
      handled = true;
      socket.pause();
      void (async () => {
        const ids = JSON.parse(input.subarray(0, newline).toString('utf8'));
        if (!ids || typeof ids.session_id !== 'string' || !ids.session_id.trim() ||
            typeof ids.turn_id !== 'string' || !ids.turn_id.trim()) {
          throw Error('Invalid turn IDs');
        }
        return {closed: await closeActiveTurn({sessionId: ids.session_id, turnId: ids.turn_id})};
      })().then(value => socket.end(JSON.stringify(value) + '\n'),
              () => socket.end('{"error":"Turn cleanup failed"}\n'));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, resolve);
  });
  return {address, dispose: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }};
}

module.exports = {startLifetimeSignal};
