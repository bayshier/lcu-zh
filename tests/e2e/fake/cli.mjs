// One fake for every external program LCU runs during setup: the app's own `codex` (also its `app-server`
// config writer) and the harness CLIs (codex, claude, pi, omp, hermes) on the account PATH. Each call is
// appended to RECORDS/commands.jsonl; NAME and RECORDS are substituted when the fake is installed.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const NAME = '@NAME@';
const RECORDS = '@RECORDS@';
const argv = process.argv.slice(2);
const log = (entry) => appendFileSync(join(RECORDS, 'commands.jsonl'), JSON.stringify(entry) + '\n');
const env = { ...process.env };
for (const key of ['E2E_NODE_ARGV0', 'PWD', 'OLDPWD', 'SHLVL', '_']) delete env[key];
log({ tool: NAME, argv, cwd: process.cwd(), env });

if (NAME === 'app-codex' && argv.includes('app-server')) {
  // The original config writer, reduced to what `lcu setup --agent codex` asks of it. Edits are appended to
  // $CODEX_HOME/config.toml as comments, so the file LCU commits stays valid TOML and the edits stay visible.
  const home = process.env.CODEX_HOME || join(process.env.HOME, '.codex');
  const state = new Map();
  const out = (message) => process.stdout.write(JSON.stringify(message) + '\n');
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.method === undefined || message.id === undefined) continue;
    log({ tool: 'app-codex:rpc', method: message.method, params: message.params ?? null });
    if (message.method === 'config/batchWrite') {
      mkdirSync(home, { recursive: true });
      for (const edit of message.params.edits) {
        state.set(edit.keyPath, edit.value);
        appendFileSync(join(home, 'config.toml'), `# e2e-edit ${JSON.stringify(edit)}\n`);
      }
      out({ id: message.id, result: { status: 'ok' } });
    } else if (message.method === 'hooks/list') {
      const source = join(realpathSync(home), 'config.toml');
      const hooks = [];
      for (const [keyPath, groups] of state) {
        if (!keyPath.startsWith('hooks.') || keyPath.startsWith('hooks.state.')) continue;
        const event = keyPath.slice('hooks.'.length);
        groups.forEach((group, g) => group.hooks.forEach((hook, h) => hooks.push({
          sourcePath: source, eventName: event[0].toLowerCase() + event.slice(1), server: hook.server,
          tool: hook.tool, command: hook.command, key: `${source}:${event}:${g}:${h}`, currentHash: `sha256:${event}:${g}:${h}`,
        })));
      }
      out({ id: message.id, result: { data: [{ errors: [], hooks }] } });
    } else out({ id: message.id, result: { userAgent: 'e2e' } });
  }
  process.exit(0);
}
if (NAME === 'app-codex') {
  process.stdout.write(JSON.stringify({ codex: argv }) + '\n');
  process.exit(0);
}
if (NAME === 'codex' && argv[0] === '--version') process.stdout.write('codex-cli 0.999.0\n');
if (NAME === 'omp' && argv[0] === 'config') {
  // `omp config get|set|reset KEY [VALUE]`, kept in a file in the account home so the result is compared too.
  const path = join(process.env.HOME, '.omp-e2e-config.json');
  const config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const [, action, key, value] = argv;
  if (action === 'get') process.stdout.write(JSON.stringify({ value: config[key] ?? {} }) + '\n');
  else {
    if (action === 'set') config[key] = JSON.parse(value);
    else delete config[key];
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  }
}
process.exit(0);
