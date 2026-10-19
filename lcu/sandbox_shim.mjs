// Stand between the original node_repl and `codex sandbox` on Linux (`lcu-codex-sandbox`).
//
// On a machine where bubblewrap works, the original node_repl starts its JavaScript kernel (the code the
// model writes in `js` calls) and its trusted worker (which hosts the Sky desktop service) with
// `$CODEX_CLI_PATH sandbox ... -- COMMAND`. The sandbox's network-off seccomp filter also refuses
// connect(2) to the X11 socket, so Sky cannot work inside it. LCU sets CODEX_CLI_PATH to this shim:
//
// * the kernel is handed to the real `codex sandbox` exactly as node_repl asked;
// * the trusted worker is run directly, outside the sandbox, only when it is positively identified as the
//   selected runtime's worker hosting the selected runtime's Sky service; any other worker is handed to the
//   real sandbox as asked;
// * a `sandbox` invocation in any format this module does not recognise is refused with an error, so nothing
//   the shim cannot classify ever starts, let alone starts unsandboxed;
// * every other `codex` subcommand is passed through unchanged.
// Builtins come from process.getBuiltinModule, which skips the per-launch cost of an ESM builtin facade.
const { lstatSync, readlinkSync, realpathSync, statSync } = process.getBuiltinModule('node:fs');
const { basename, dirname, isAbsolute } = process.getBuiltinModule('node:path');

import { isMain, run } from './entry.mjs';

export const CONFIG_ENV = 'LCU_SANDBOX_SHIM';
// Test-only: `unrecognized-kernel`, `unrecognized-worker` or `unrecognized-format` make the shim see that
// invocation in a format it does not recognise. LCU never sets it; it can only make the shim refuse.
export const FAULT_ENV = 'LCU_TEST_SANDBOX_SHIM_FAULT';
export const SKY_SERVICE = '@oai/sky/service';
const SANDBOX_PREFIX = ['sandbox', '-c', 'shell_environment_policy.inherit="all"', '-c', 'default_permissions="node_repl"'];
const PROFILE_KEY = 'permissions.node_repl=';
const SERVICE_PACKAGES = { [SKY_SERVICE]: '@oai/sky', '@oai/browser-desktop/service': '@oai/browser-desktop' };
const NODE_FLAG = '--experimental-vm-modules';

/** A `sandbox` invocation whose format this shim does not know. */
export class Unrecognized extends Error {}

/** The value LCU puts in CONFIG_ENV for the shim. */
export const configuration = (runtime, codex, wrapper) => JSON.stringify({ codex, runtime, wrapper: wrapper || null });

/** A copy of `env` whose CODEX_CLI_PATH is the real Codex executable again. */
export function unshimmedEnv(env) {
  const restored = { ...env };
  try {
    const { codex } = JSON.parse(env[CONFIG_ENV]);
    if (codex !== undefined) restored.CODEX_CLI_PATH = codex;
  } catch {
    // not shimmed
  }
  return restored;
}

function loadConfiguration(env) {
  let config;
  try {
    config = JSON.parse(env[CONFIG_ENV]);
  } catch {
    throw new Unrecognized('the shim has no LCU configuration');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.codex !== 'string' ||
      typeof config.runtime !== 'string' || !(config.wrapper == null || typeof config.wrapper === 'string')) {
    throw new Unrecognized('the shim configuration is malformed');
  }
  return config;
}

const real = (path) => { try { return realpathSync(path); } catch { return path; } };
const within = (path, root) => path === root || path.startsWith(`${root.replace(/\/+$/, '')}/`);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The value of the TOML inline profile node_repl passes: inline tables with bare or quoted keys, strings,
 * booleans, decimal integers and arrays. Anything else (dotted keys, floats, dates, comments) throws, and the
 * shim then refuses the invocation.
 */
export function parseTomlValue(text) {
  let at = 0;
  const fail = () => { throw new Error(`unsupported TOML at ${at}`); };
  const space = () => { while (text[at] === ' ' || text[at] === '\t') at += 1; };
  const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  const string = () => {
    const quote = text[at];
    let result = '';
    for (at += 1; text[at] !== quote; at += 1) {
      if (at >= text.length || text[at] === '\n') fail();
      if (quote === "'" || text[at] !== '\\') {
        result += text[at];
        continue;
      }
      const escape = text[at + 1];
      const hex = { u: 4, U: 8 }[escape];
      if (hex) {
        const digits = text.slice(at + 2, at + 2 + hex);
        if (!/^[0-9A-Fa-f]+$/.test(digits) || digits.length !== hex) fail();
        result += String.fromCodePoint(parseInt(digits, 16));
        at += 1 + hex;
      } else if (Object.hasOwn(ESCAPES, escape)) {
        result += ESCAPES[escape];
        at += 1;
      } else fail();
    }
    at += 1;
    return result;
  };
  const value = () => {
    space();
    if (text[at] === '"' || text[at] === "'") return string();
    if (text[at] === '{' || text[at] === '[') {
      const table = text[at] === '{';
      const close = table ? '}' : ']';
      const result = table ? {} : [];
      at += 1;
      space();
      if (text[at] === close) {
        at += 1;
        return result;
      }
      for (;;) {
        if (table) {
          space();
          const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(at));
          const key = text[at] === '"' || text[at] === "'" ? string() : bare ? (at += bare[0].length, bare[0]) : fail();
          space();
          if (text[at] !== '=' || Object.hasOwn(result, key)) fail();
          at += 1;
          result[key] = value();
        } else result.push(value());
        space();
        if (text[at] === close) {
          at += 1;
          return result;
        }
        if (text[at] !== ',') fail();
        at += 1;
        space();
        if (table && text[at] === close) fail(); // TOML inline tables take no trailing comma
        if (!table && text[at] === close) {
          at += 1;
          return result;
        }
      }
    }
    const word = /^(?:true|false|[+-]?(?:0|[1-9]\d*))(?![\w.])/.exec(text.slice(at));
    if (!word) fail();
    at += word[0].length;
    return word[0] === 'true' || (word[0] === 'false' ? false : Number(word[0]));
  };
  const result = value();
  space();
  if (at !== text.length) fail();
  return result;
}

/**
 * node_repl first runs a short `/bin/sh` command in the sandbox to learn whether it works. A refused probe
 * would read as "no sandbox here" and leave the kernel unsandboxed, so any `/bin/sh` command passes through.
 */
const isAvailabilityProbe = (argv) => argv.includes('--') && argv[argv.indexOf('--') + 1] === '/bin/sh';

/** `{profile, command}` for exactly the invocation node_repl makes. */
function parseSandbox(argv) {
  const head = SANDBOX_PREFIX.length;
  if (SANDBOX_PREFIX.some((part, index) => argv[index] !== part) || argv.length < head + 4 || argv[head] !== '-c' ||
      !argv[head + 1].startsWith(PROFILE_KEY) || argv[head + 2] !== '--') {
    throw new Unrecognized('unexpected sandbox arguments');
  }
  let profile;
  try {
    profile = parseTomlValue(argv[head + 1].slice(PROFILE_KEY.length));
  } catch {
    throw new Unrecognized('unreadable permission profile');
  }
  if (!isPlainObject(profile) || Object.keys(profile).some((name) => name !== 'filesystem' && name !== 'network') ||
      !isPlainObject(profile.filesystem) || !isPlainObject(profile.network) ||
      Object.values(profile.filesystem).some((rule) => typeof rule !== 'string')) {
    throw new Unrecognized('unexpected permission profile shape');
  }
  return { profile, command: argv.slice(head + 3) };
}

/** `kernel` or `worker`; throws Unrecognized for any other command. */
export function classify(command, config) {
  if (command.length < 3 || command[1] !== NODE_FLAG || !isAbsolute(command[2]) ||
      real(command[0]) !== real(`${config.runtime}/bin/node`)) {
    throw new Unrecognized('unexpected command');
  }
  const script = basename(command[2]);
  if (script === 'kernel.js' && command.length === 7 && command[3] === '--session-id' && command[5] === '--working-dir') return 'kernel';
  if (script === 'trusted-worker.js' && command.length === 4 && isAbsolute(command[3])) return 'worker';
  throw new Unrecognized('unexpected script or arguments');
}

/** Not writable by others, nor by a group other than the account's own (umask 002 is common). */
const isPrivate = (info) => !(info.mode & 0o002) && (!(info.mode & 0o020) || info.gid === process.getegid());

function servicePackage(runtime, specifier) {
  const name = Object.hasOwn(SERVICE_PACKAGES, specifier) ? SERVICE_PACKAGES[specifier] : undefined;
  if (!name) return false;
  const path = real(`${runtime}/lib/node_modules/${name}/package.json`);
  try {
    return statSync(path).isFile() && within(path, real(runtime));
  } catch {
    return false;
  }
}

/** null when `command` is the selected runtime's trusted worker hosting its Sky service, else the reason it is not. */
function identifySkyWorker(command, config, env, parentExe) {
  const { runtime, wrapper } = config;
  const nodeRepl = real(`${runtime}/bin/node_repl`);
  if (parentExe !== nodeRepl || !within(nodeRepl, real(runtime))) return "it was not started by the selected runtime's node_repl";
  const node = real(command[0]);
  if (node !== real(`${runtime}/bin/node`) || !within(node, real(runtime))) return "its Node is not the selected runtime's";
  const script = command[2];
  const folder = dirname(script);
  let folderInfo;
  let scriptInfo;
  let sibling;
  try {
    folderInfo = lstatSync(folder);
    scriptInfo = lstatSync(script);
    sibling = statSync(`${folder}/kernel.js`).isFile();
  } catch {
    sibling = false;
  }
  if (!folderInfo?.isDirectory() || !scriptInfo?.isFile() || folderInfo.uid !== process.geteuid() ||
      scriptInfo.uid !== process.geteuid() || !isPrivate(folderInfo) || !isPrivate(scriptInfo) || !sibling ||
      !basename(folder).startsWith('.tmp') || dirname(folder) !== real(env.TMPDIR || '/tmp')) {
    return "its script is not in node_repl's own temporary folder";
  }
  let services;
  try {
    services = env.NODE_REPL_TRUSTED_SERVICES === undefined ? undefined : JSON.parse(env.NODE_REPL_TRUSTED_SERVICES);
  } catch {
    services = undefined;
  }
  if (!isPlainObject(services) || Object.keys(services).some((name) => name !== 'sky' && name !== 'browser') ||
      Object.values(services).some((value) => typeof value !== 'string')) {
    return "the trusted services are not exactly the selected runtime's";
  }
  const { sky } = services;
  if (sky === undefined) return 'it hosts no Sky service';
  let isFile = false;
  try {
    isFile = Boolean(wrapper) && statSync(wrapper).isFile();
  } catch {
    // missing wrapper
  }
  if (!(sky === SKY_SERVICE ? servicePackage(runtime, sky)
    : isFile && sky === wrapper && isAbsolute(wrapper) && real(wrapper) === wrapper)) {
    return "its Sky service is not the selected runtime's";
  }
  if ('browser' in services && !servicePackage(runtime, services.browser)) return "its browser service is not the selected runtime's";
  return null;
}

/** `{action, argv, note}`: `real` execs the real Codex, `direct` execs the command itself. Throws Unrecognized to refuse. */
export function decide(argv, env, parentExe) {
  const config = loadConfiguration(env);
  if (argv[0] !== 'sandbox' || isAvailabilityProbe(argv)) return { action: 'real', argv, note: '' };
  const { command } = parseSandbox(argv);
  const kind = classify(command, config);
  const fault = env[FAULT_ENV] ?? '';
  if (fault === 'unrecognized-format' || fault === `unrecognized-${kind}`) parseSandbox(argv.filter((part) => part !== '--'));
  if (kind === 'worker') {
    const reason = identifySkyWorker(command, config, env, parentExe);
    if (reason === null) return { action: 'direct', argv: command, note: '' };
    return { action: 'real', argv, note: `the trusted worker stays sandboxed: ${reason}` };
  }
  return { action: 'real', argv, note: '' };
}

function parentExecutable() {
  try {
    return realpathSync(readlinkSync(`/proc/${process.ppid}/exe`));
  } catch {
    return null;
  }
}

export function main(argv, env = process.env, { parentExe = parentExecutable } = {}) {
  let decision;
  try {
    decision = decide(argv, env, parentExe());
  } catch (error) {
    if (!(error instanceof Unrecognized)) throw error;
    process.stderr.write('LCU: the original node_repl started its sandbox in a way this LCU release does not ' +
      `recognise (${error.message}). Refusing to start it, so the model's JavaScript is never left unsandboxed. ` +
      'Run `lcu update` for a release that knows this runtime; LCU_NODE_REPL_SANDBOX=off runs the JavaScript ' +
      'kernel without a sandbox.\n');
    return 70;
  }
  if (decision.note) process.stderr.write(`LCU: ${decision.note}.\n`);
  if (decision.action === 'direct') {
    process.execve(decision.argv[0], decision.argv);
  } else {
    const { codex } = loadConfiguration(env);
    process.execve(codex, [codex, ...decision.argv]);
  }
  return 0;
}

if (isMain(import.meta)) run('LCU', () => main(process.argv.slice(2)));
