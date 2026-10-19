// Run a child and capture its output through files rather than pipes.
//
// Node writes to pipes asynchronously on macOS, so a CLI that prints and then calls `process.exit()`
// loses everything past the 64 KiB pipe buffer. File writes are synchronous on every platform, so the
// whole output survives the exit.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// cmd.exe metacharacters, escaped with ^ (the set cross-spawn escapes for cmd shims).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for a program a batch file starts: MSVCRT quoting, then cmd escaping (twice through `%*`). */
function batchArgument(arg) {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

/**
 * `[command, args, options]` that start `command`: on Windows a .cmd or .bat file (an npm shim such as codex.cmd)
 * runs through `cmd.exe /d /s /c`, because Node refuses to start batch files without a shell. Each argument is
 * quoted for the C runtime and its cmd metacharacters escaped twice, as cross-spawn does, because the batch
 * file passes them on through `%*`; the path is escaped once. Only a line break or NUL cannot be passed.
 */
export function batchCommand(command, args = [], options = {}, platform = process.platform) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(command)) return [command, args, options];
  const parts = [command, ...args].map(String);
  const bad = parts.find((part) => /[\r\n\0]/.test(part));
  if (bad !== undefined) throw new Error(`Cannot pass ${JSON.stringify(bad)} safely to the batch file ${command}.`);
  const line = [parts[0].replace(CMD_META, '^$1'), ...parts.slice(1).map(batchArgument)].join(' ');
  return ['cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true }];
}

/** spawnSync with stdin closed and stdout/stderr read back from temporary files as text. */
export function run(command, args = [], options = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'lcu-capture-'));
  const out = openSync(join(folder, 'out'), 'w+', 0o600);
  const err = openSync(join(folder, 'err'), 'w+', 0o600);
  try {
    const result = spawnSync(...batchCommand(command, args, { ...options, stdio: ['ignore', out, err] }));
    return { status: result.status, signal: result.signal, error: result.error,
      stdout: readFileSync(join(folder, 'out'), 'utf8'), stderr: readFileSync(join(folder, 'err'), 'utf8') };
  } finally {
    closeSync(out);
    closeSync(err);
    rmSync(folder, { recursive: true, force: true });
  }
}
