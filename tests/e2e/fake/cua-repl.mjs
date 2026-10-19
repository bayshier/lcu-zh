// Fake original `cua-repl.mjs`: records how LCU launched it, answers a minimal MCP handshake, then exits
// when stdin closes. RECORDS is substituted when the fake app is built. No OpenAI code is involved.
import { fstatSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const RECORDS = '@RECORDS@';
const kind = (fd) => {
  try {
    const s = fstatSync(fd);
    return s.isFIFO() ? 'pipe' : s.isFile() ? 'file' : s.isCharacterDevice() ? 'char' : s.isSocket() ? 'socket' : 'other';
  } catch { return 'closed'; }
};
const env = { ...process.env };
const node = env.E2E_NODE_ARGV0;
for (const key of ['E2E_NODE_ARGV0', 'PWD', 'OLDPWD', 'SHLVL', '_']) delete env[key];
const record = { node, script: process.argv[1], args: process.argv.slice(2), cwd: process.cwd(), env,
                 fds: [0, 1, 2].map(kind), stdin: [], shim: [] };
const file = `${RECORDS}/launch-${process.pid}.json`;
const save = () => writeFileSync(file, JSON.stringify(record, null, 1) + '\n');
save();

// What node_repl would ask of $CODEX_CLI_PATH (LCU's sandbox shim): pass-through, the availability probe, a
// kernel command, and an invocation the shim must refuse. The fake app codex prints the argv it received.
if (env.CODEX_CLI_PATH) {
  const prefix = ['sandbox', '-c', 'shell_environment_policy.inherit="all"', '-c', 'default_permissions="node_repl"'];
  const probes = [
    ['--version'],
    [...prefix, '--', '/bin/sh', '-c', 'true'],
    [...prefix, '-c', 'permissions.node_repl={filesystem={}, network={}}', '--', env.NODE_REPL_NODE_PATH ?? '',
     '--experimental-vm-modules', '/nonexistent/kernel.js', '--session-id', 's', '--working-dir', '/'],
    ['sandbox', 'unexpected'],
  ];
  for (const args of probes) {
    const run = spawnSync(env.CODEX_CLI_PATH, args, { env: process.env, encoding: 'utf8', timeout: 20000 });
    record.shim.push({ args, status: run.status, stdout: run.stdout?.trim() || '' });
  }
  save();
}

const tools = ['js', 'js_reset', 'turn_ended', 'js_add_node_module_dir']
  .map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
const reply = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const timer = setTimeout(() => { record.timedOut = true; save(); process.exit(3); }, 60000);
for await (const line of createInterface({ input: process.stdin })) {
  record.stdin.push(line);
  save();
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message?.id === undefined || typeof message.method !== 'string') continue;
  if (message.method === 'initialize') {
    reply({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'e2e-recorder', version: '0.0.0' }, instructions: 'e2e' } });
  } else if (message.method === 'tools/list') {
    reply({ jsonrpc: '2.0', id: message.id, result: { tools } });
  } else {
    reply({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'e2e' }] } });
  }
}
clearTimeout(timer);
save();
