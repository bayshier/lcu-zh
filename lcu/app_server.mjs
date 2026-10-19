// A small JSON-RPC client for the original Codex app-server over stdio.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { batchCommand } from './capture.mjs';

/** An error the app-server returned for a request, as opposed to losing the connection. */
export class AppServerRequestError extends Error {}

export class AppServer {
  /**
   * `child` is a spawned app-server with piped stdin and stdout. `onRequest(request)` answers server-originated
   * requests with a response envelope carrying the same id and either `result` or `error`; without it they are
   * refused. `onNotification(message)` receives notifications.
   */
  constructor(child, { onRequest = null, onNotification = () => {} } = {}) {
    this.child = child;
    this.sequence = 0;
    this.pending = new Map();
    this.closed = null;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    const lost = (error) => {
      this.closed ??= error ?? new Error('Bundled Codex app-server exited unexpectedly.');
      for (const { reject } of this.pending.values()) reject(this.closed);
      this.pending.clear();
    };
    child.once('error', lost);
    child.stdin.on('error', () => {}); // reported as the lost connection
    createInterface({ input: child.stdout, crlfDelay: Infinity })
      .on('line', (line) => this.route(line).catch((error) => {
        lost(error);
        child.kill();
      }))
      .on('close', () => lost());
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async route(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if ('id' in message && 'method' in message) {
      const refusal = { id: message.id, error: { code: -32601, message: 'Server-originated requests are unsupported.' } };
      const response = this.onRequest ? await this.onRequest(message) : refusal;
      if (!response || response.id !== message.id || 'method' in response || ('result' in response) === ('error' in response)) {
        throw new Error('App-server request handler returned an invalid response envelope.');
      }
      this.send(response);
    } else if ('id' in message) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if ('error' in message) waiter.reject(new AppServerRequestError(message.error?.message));
      else waiter.resolve(message.result);
    } else this.onNotification(message);
  }

  /** Call `method` and resolve with its result. */
  call(method, params, { timeout = 45_000 } = {}) {
    if (this.closed) return Promise.reject(this.closed);
    this.sequence += 1;
    const id = this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bundled Codex app-server timed out: ${method}`));
      }, timeout);
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.send({ id, method, params });
    });
  }

  async initialize() {
    this.initialization = await this.call('initialize', { clientInfo: { name: 'lcu', version: '0.3.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
    return this;
  }

  /**
   * End the connection and wait for the server to exit, killing it if it does not. A server that never started
   * (a failed spawn emits `error` and `close`, never `exit`) is not waited for, and the wait is bounded.
   */
  async close() {
    const { child } = this;
    child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    await new Promise((resolve) => {
      const events = ['exit', 'close', 'error'];
      const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
      const giveUp = setTimeout(() => done(), 15_000);
      function done() {
        clearTimeout(kill);
        clearTimeout(giveUp);
        for (const event of events) child.off(event, done);
        resolve();
      }
      for (const event of events) child.once(event, done);
      child.kill('SIGTERM');
    });
  }
}

/**
 * Run `fn(server)` against the app-server of the Codex CLI `cli`. The caller's configuration is retained; no
 * model turn is executed and no policy is changed.
 */
export async function withAppServer(cli, cwd, env, fn, options) {
  const child = spawn(...batchCommand(cli, ['--strict-config', 'app-server', '--listen', 'stdio://'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] }));
  const server = new AppServer(child, options);
  try {
    await server.initialize();
    return await fn(server);
  } finally {
    await server.close();
  }
}
