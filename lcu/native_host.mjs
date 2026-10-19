// Relay the original Chrome native host with LCU's local agent-header policy.
//
// LCU always enables the official extension's browser-agent request header. This lets the original browser
// service use Chrome without a Codex account while the extension still labels requests from agent-controlled
// tabs. All other native messages pass through unchanged to the installed application's original host.
// `lcu browser install` copies this file beside the private plugin copy, so it imports nothing from LCU.
// Builtins come from process.getBuiltinModule, like the rest of the launch path.
const { spawn } = process.getBuiltinModule('node:child_process');
const { realpathSync, statSync } = process.getBuiltinModule('node:fs');
const { dirname, join } = process.getBuiltinModule('node:path');
const { fileURLToPath } = process.getBuiltinModule('node:url');

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** Native-messaging payloads (4-byte little-endian length, then the body) from a byte stream. */
export async function* readFrames(stream) {
  let buffered = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    while (buffered.length >= 4) {
      const size = buffered.readUInt32LE(0);
      if (size > MAX_MESSAGE_BYTES) throw new Error('Native message exceeds the supported size');
      if (buffered.length < 4 + size) break;
      yield buffered.subarray(4, 4 + size);
      buffered = buffered.subarray(4 + size);
    }
  }
  if (buffered.length) throw new Error(buffered.length < 4 ? 'Short native-message length' : 'Short native-message body');
}

export function frame(payload) {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(payload.length);
  return Buffer.concat([prefix, payload]);
}

/** Turn on the extension's agent request header in its capability reply; every other message is unchanged. */
export function enableAgentHeader(payload) {
  let message;
  try {
    message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    return payload;
  }
  const result = message?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.type !== 'extension' ||
      result.agentRequestHeaderEnabled !== false) {
    return payload;
  }
  result.agentRequestHeaderEnabled = true;
  return Buffer.from(JSON.stringify(message));
}

/** Copy frames from `source` to the writable `destination`, transforming each payload. */
export async function relay(source, destination, transform = (payload) => payload) {
  for await (const payload of readFrames(source)) {
    if (!destination.write(frame(transform(payload)))) await new Promise((resolve) => destination.once('drain', resolve));
  }
}

/** The original host binary shipped beside this relay for the running platform. */
export function originalHost(base = dirname(fileURLToPath(import.meta.url)), platform = process.platform, arch = process.arch) {
  const host = { linux: ['linux', 'extension-host'], darwin: ['macos', 'ChatGPT for Chrome'],
    win32: ['windows', 'extension-host.exe'] }[platform];
  if (!host || !['arm64', 'x64'].includes(arch) || (platform === 'win32' && arch !== 'x64')) {
    throw new Error('The original Chrome native host is available only for supported Linux, macOS, or Windows architectures');
  }
  const binary = join(base, 'chrome/extension-host', host[0], arch, host[1]);
  try {
    if (statSync(binary).isFile()) return binary;
  } catch {
    // reported below
  }
  throw new Error(`The original Chrome native host is missing: ${binary}`);
}

export async function main(argv = process.argv.slice(2)) {
  const child = spawn(originalHost(), argv, { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve(status ?? (signal ? 1 : 0)));
  });
  const errors = [];
  const fail = (error) => {
    errors.push(error);
    if (child.exitCode === null) child.kill();
  };
  child.stdin.on('error', () => {}); // a host that exits early is reported by its status
  const inbound = relay(process.stdin, child.stdin, enableAgentHeader).catch(fail).finally(() => child.stdin.end());
  await relay(child.stdout, process.stdout).catch(fail);
  const status = await exited;
  process.stdin.destroy();
  await Promise.race([inbound, new Promise((resolve) => setTimeout(resolve, 1000).unref())]);
  if (errors.length) {
    process.stderr.write(`LCU Chrome native-host relay failed: ${errors[0].message}\n`);
    return 1;
  }
  return status;
}

const started = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (started) {
  main().then((status) => { process.exitCode = status; }, (error) => {
    process.stderr.write(`LCU Chrome native-host relay failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
