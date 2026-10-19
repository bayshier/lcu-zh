// Delay forwarded progress writes to make ordering at the bridge boundary observable.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const send = StdioServerTransport.prototype.send;
StdioServerTransport.prototype.send = function (message) {
  if (!process.argv[1]?.endsWith('/codex.mjs') || message?.method !== 'notifications/progress') {
    return send.call(this, message);
  }
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      send.call(this, message).then(resolve, reject);
    }, 100);
  });
};
