// Command-line access to LCU's X questions (lcu/x11.mjs) for the real-desktop tests, printing what the former
// python3 helper printed: `socket` 1 or 0; `pid WINDOW` and `xres WINDOW` (the id without the namespace proof)
// the process id or nothing; `guard WINDOW [X Y]` one JSON line or nothing; `release BUTTONS KEYS` 1 or
// nothing. `all WINDOW` answers socket, xres and pid in one process, as one JSON line with getpid.
import {clientPid, inputState, releaseInput, xServerInThisNamespace} from '../lcu/x11.mjs';

const [mode, ...args] = process.argv.slice(2);
const numbers = text => (text ?? '').split(',').filter(Boolean).map(Number);
const pid = async proof => String(await clientPid(Number(args[0]), {proof}).catch(() => null) ?? '');

if (mode === 'socket') {
  console.log(await xServerInThisNamespace() ? 1 : 0);
} else if (mode === 'pid' || mode === 'xres') {
  const answer = await pid(mode === 'pid');
  if (answer) console.log(answer);
} else if (mode === 'guard') {
  const point = args.length >= 3 ? {x: Number(args[1]), y: Number(args[2])} : null;
  const state = await inputState(Number(args[0]), point).catch(() => null);
  if (state) console.log(JSON.stringify(state));
} else if (mode === 'release') {
  if (await releaseInput(numbers(args[0]), numbers(args[1])).catch(() => false)) console.log(1);
} else if (mode === 'all') {
  console.log(JSON.stringify({getpid: String(process.pid), socket: await xServerInThisNamespace() ? '1' : '0',
    xres: await pid(false), pid: await pid(true)}));
} else {
  process.exitCode = 2;
}
