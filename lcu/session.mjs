// Attach to one existing XFCE session owned by the calling account (`lcu-session`).
// Builtins come from process.getBuiltinModule, which skips the per-launch cost of an ESM builtin facade.
const { accessSync, constants, readdirSync, readFileSync, statSync } = process.getBuiltinModule('node:fs');
const { userInfo } = process.getBuiltinModule('node:os');
const { delimiter, join } = process.getBuiltinModule('node:path');

import { isMain, run } from './entry.mjs';

const GUI_KEYS = ['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE'];
const USAGE = 'Usage: lcu-session --user ACCOUNT -- COMMAND [ARG...]\n' +
  'Run COMMAND in the one XFCE desktop session of ACCOUNT, which must be the calling account.';

/** The GUI variables of the caller's one XFCE session found under `proc`. */
export function discover(proc = '/proc', uid = process.getuid()) {
  const sessions = new Map();
  for (const name of readdirSync(proc)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const entry = join(proc, name);
      if (statSync(entry).uid !== uid || readFileSync(join(entry, 'comm'), 'utf8').trim() !== 'xfce4-session') continue;
      const values = {};
      for (const item of new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(entry, 'environ'))).split('\0')) {
        const at = item.indexOf('=');
        if (at >= 0) values[item.slice(0, at)] = item.slice(at + 1);
      }
      if (values.DISPLAY && values.DBUS_SESSION_BUS_ADDRESS) {
        const selected = Object.fromEntries(GUI_KEYS.filter((key) => key in values).map((key) => [key, values[key]]));
        sessions.set(JSON.stringify(selected), selected);
      }
    } catch {
      // the process ended, or is not readable by this account
    }
  }
  if (sessions.size !== 1) {
    throw new Error(`Expected one XFCE desktop for UID ${uid}; found ${sessions.size}. Start a desktop, or use ` +
      '--session direct with an explicit GUI environment.');
  }
  return [...sessions.values()][0];
}

function parse(argv) {
  let user;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '--user') user = argv[++index];
    else if (arg.startsWith('--user=')) user = arg.slice(7);
    else return { user, command: argv.slice(arg === '--' ? index + 1 : index) };
    if (user === undefined) break;
  }
  return { user, command: [] };
}

/** The first executable file named `command` on `path` (execvp's default path when unset), as execvp finds it. */
export function which(command, path = '/bin:/usr/bin') {
  if (command.includes('/')) return command;
  for (const directory of path.split(delimiter)) {
    const candidate = join(directory || '.', command);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // not here, or not executable: keep looking
    }
  }
  throw new Error(`Command not found: ${command}`);
}

/** The uid of account `name`, or null when there is no such account. */
function accountUid(name) {
  if (userInfo().username === name) return process.getuid();
  const result = process.getBuiltinModule('node:child_process').spawnSync('/usr/bin/id', ['-u', '--', name], { encoding: 'utf8' });
  return result.status === 0 && /^\d+\n?$/.test(result.stdout) ? Number(result.stdout) : null;
}

export function main(argv = process.argv.slice(2)) {
  const { help, user, command } = parse(argv);
  if (help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!user || !command.length) {
    process.stderr.write(`${USAGE}\nlcu-session: ${user ? 'provide a command after --' : '--user is required'}\n`);
    return 2;
  }
  const uid = accountUid(user);
  if (uid === null) throw new Error(`Unknown account: ${user}`);
  if (uid !== process.getuid()) throw new Error(`Run the launcher as the selected desktop account (${user}).`);
  const env = { ...process.env };
  for (const key of GUI_KEYS) delete env[key];
  Object.assign(env, discover());
  process.execve(which(command[0], env.PATH), command, env);
}

if (isMain(import.meta)) run('LCU session', () => main());
