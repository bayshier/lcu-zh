// `lcu origins`: show and forget the Chrome site decisions the original runtime saves per session.
//
// When a user answers "Allow Browser use to access <origin>?", the original browser service keeps the answer
// for that harness session in `$CODEX_HOME/browser/sessions/<session-id>.toml` as `[origins] allowed = [...] /
// denied = [...]` and checks it before it asks again. That format is the original runtime's private storage, not
// an interface. This module only reads it and removes entries; it never adds one, so granting access stays with
// the original prompt. It does not touch `browser/config.toml` or `browser_use.origins` in `config.toml`.
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';

import { isFile } from './fsutil.mjs';
import { acquire } from './lock.mjs';
import { defaultCodexHome } from './runtime.mjs';
import { say, warn } from './terminal.mjs';
import { parse as parseToml } from './toml.mjs';

const KINDS = ['allowed', 'denied'];
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/; // the original runtime's own rule for a session id
const WRITE_ATTEMPTS = 5;
export const LOCK_NAME = '.lcu-origins.lock'; // not a session file: no .toml suffix
const LOCK_WAIT = 10_000;
const CACHE_NOTE = 'A running agent may keep its saved decisions in memory for up to 5 minutes. Restart the agent, ' +
  'or wait, and the next request for the site asks again.';
const DEFAULT_PORTS = { http: 80, https: 443 };
const STRING = /"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/g;

/** A problem to show the user. */
export class OriginsError extends Error {}
/** A session file LCU can read but will not rewrite. */
class UnsupportedShape extends OriginsError {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A table: plain objects only, so a float or a date read from the file is a value, not a table.
const isObject = (value) => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const reason = (error) => error.message.replace(/^[A-Z]+: /, '').replace(/, \w+ '.*'$/, '');

/** The file operations a forget performs (`forgetIn` takes others, to race the original runtime in tests). */
const FILES = {
  read: (path) => readFileSync(path),
  /** Write `text` next to `path` and return the temporary file, ready to replace it. */
  writeTemporary(path, text, mode) {
    const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        chmodSync(temporary, mode);
      } catch {
        // keep the private default
      }
      return temporary;
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  },
  replace: (source, target) => renameSync(source, target),
};

// Locations ------------------------------------------------------------------------------------------

/** CODEX_HOME exactly as the launched runtime sees it (see runtime.environment). */
export function codexHome(env = process.env, { windows = process.platform === 'win32' } = {}) {
  if (!('CODEX_HOME' in env)) return (windows ? win32 : posix).normalize(defaultCodexHome(env, windows));
  const value = env.CODEX_HOME;
  if (!value) throw new OriginsError('CODEX_HOME is set but empty; unset it or set an absolute path.');
  const path = windows ? win32 : posix;
  if (!path.isAbsolute(value)) throw new OriginsError(`CODEX_HOME must be an absolute path, not ${JSON.stringify(value)}.`);
  const normal = path.normalize(value);
  return normal.length > path.parse(normal).root.length ? normal.replace(/[\\/]+$/, '') : normal;
}

const sessionsDirectory = (home) => join(home, 'browser', 'sessions');

export function checkSessionId(value) {
  if (!SESSION_ID.test(value) || value.endsWith('\n')) {
    throw new OriginsError(`${JSON.stringify(value)} is not a session id (1 to 128 letters, digits, "_" or "-").`);
  }
  return value;
}


/** `[[session id, path]]` of the saved session files; only `session` when it is given. */
function sessionFiles(directory, session) {
  if (session !== undefined) {
    const path = join(directory, `${checkSessionId(session)}.toml`);
    if (!isFile(path)) throw new OriginsError(`no saved site decisions for session ${session} (${path} does not exist).`);
    return [[session, path]];
  }
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith('.toml')).sort()
    .map((name) => [name.slice(0, -5), join(directory, name)])
    .filter(([id, path]) => SESSION_ID.test(id) && isFile(path));
}

// Origins --------------------------------------------------------------------------------------------

function ipv4(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

/** `scheme://host[:port]` in the form a browser reports it: lowercase, default port dropped. */
export function normalizeOrigin(value) {
  const text = value.trim();
  const hint = () => new OriginsError(`${JSON.stringify(value)} is not an origin; pass scheme://host[:port], for example https://example.com.`);
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/s.exec(text);
  if (!match) throw hint();
  const scheme = match[1].toLowerCase();
  const [, , netloc, rest] = match;
  if (!(scheme in DEFAULT_PORTS) || netloc.includes('@') || !['', '/'].includes(rest)) throw hint();
  let host;
  let port = '';
  if (netloc.startsWith('[')) {
    const close = netloc.indexOf(']');
    if (close < 0) throw hint();
    host = netloc.slice(1, close);
    const after = netloc.slice(close + 1);
    if (after && !after.startsWith(':')) throw hint();
    port = after.slice(1);
  } else {
    if (netloc.includes(']')) throw hint();
    const colon = netloc.indexOf(':');
    host = colon < 0 ? netloc : netloc.slice(0, colon);
    port = colon < 0 ? '' : netloc.slice(colon + 1);
  }
  host = host.toLowerCase();
  if (port && !/^\d+$/.test(port)) throw hint();
  const portNumber = port ? Number(port) : null;
  if (!host) throw hint();
  if (/[^\x00-\x7f]/.test(host)) {
    throw new OriginsError(`${JSON.stringify(value)} has a non-ASCII host; pass its punycode (xn--) form, which is what the browser reports.`);
  }
  if (host.includes(':')) {
    if (!isIPv6(host) || host.includes('%')) throw hint();
    host = new URL(`http://[${host}]`).hostname.slice(1, -1);
  } else if (!/^[a-z0-9._-]+$/.test(host)) throw hint();
  else if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(host.replace(/\.+$/, '').split('.').at(-1))) {
    // Browsers read a name ending in a number as an IPv4 address and rewrite it; accept only a plain one.
    if (!ipv4(host)) {
      throw new OriginsError(`${JSON.stringify(value)} looks like an IPv4 address in an unusual form; pass it as four decimal numbers.`);
    }
  }
  if (portNumber !== null && !(portNumber > 0 && portNumber < 65536)) throw hint();
  let result = `${scheme}://${host.includes(':') ? `[${host}]` : host}`;
  if (portNumber !== null && portNumber !== DEFAULT_PORTS[scheme]) result += `:${portNumber}`;
  return result;
}

function sameOrigin(stored, origin) {
  if (stored === origin) return true;
  try {
    return normalizeOrigin(stored) === origin;
  } catch {
    return false;
  }
}

// Session files --------------------------------------------------------------------------------------

/** `{document, origins: {kind: [origins]}}` of a session file's bytes, or OriginsError when it is not usable. */
export function parse(raw, path) {
  let document;
  try {
    document = parseToml(new TextDecoder('utf-8', { fatal: true }).decode(raw), { floats: true });
  } catch (error) {
    throw new OriginsError(`${path} is not valid TOML (${error.message}); leaving it untouched.`);
  }
  const table = document.origins ?? {};
  if (!isObject(table)) throw new OriginsError(`${path} has an "origins" entry that is not a table; leaving it untouched.`);
  if ((Object.keys(document).length && !('origins' in document)) || (Object.keys(table).length && !KINDS.some((kind) => kind in table))) {
    throw new OriginsError(`${path} does not have the expected [origins] allowed/denied lists (found ` +
      `${Object.keys(Object.keys(table).length ? table : document).sort().join(', ')}); it may be from a different runtime ` +
      'version, so it is neither listed as empty nor changed.');
  }
  const origins = {};
  for (const kind of KINDS) {
    const entries = table[kind] ?? [];
    if (!Array.isArray(entries) || !entries.every((item) => typeof item === 'string')) {
      throw new OriginsError(`${path}: origins.${kind} is not a list of strings; leaving it untouched.`);
    }
    origins[kind] = entries;
  }
  return { document, origins };
}

export function read(path, files = FILES) {
  let raw;
  try {
    raw = files.read(path);
  } catch (error) {
    throw new OriginsError(`cannot read ${path}: ${reason(error)}`);
  }
  return { raw, ...parse(raw, path) };
}

const quote = (text) => JSON.stringify(text).replaceAll('\x7f', '\\u007f');
const key = (name) => (/^[A-Za-z0-9_-]+$/.test(name) ? name : quote(name));

function value(item, where) {
  if (typeof item === 'boolean') return String(item);
  if (Number.isInteger(item)) return String(item);
  if (typeof item === 'string') return quote(item);
  if (Array.isArray(item) && item.every((entry) => typeof entry === 'string')) return `[${item.map(quote).join(', ')}]`;
  throw new UnsupportedShape(`${where} holds a value LCU does not rewrite; leaving it untouched.`);
}

/** Serialize tables of strings, booleans, integers and string lists; refuse anything else. */
export function render(document, path = 'the file') {
  const lines = Object.entries(document).filter(([, item]) => !isObject(item)).map(([name, item]) => `${key(name)} = ${value(item, path)}`);
  for (const [name, table] of Object.entries(document)) {
    if (!isObject(table)) continue;
    if (lines.length) lines.push('');
    lines.push(`[${key(name)}]`, ...Object.entries(table).map(([entry, item]) => `${key(entry)} = ${value(item, `${path}: [${name}] ${entry}`)}`));
  }
  return `${lines.join('\n')}\n`;
}

/** The text to write for `document`, or UnsupportedShape when rewriting could lose something. */
function rewritableText(raw, document, path) {
  const text = raw.toString('utf8');
  if (text.includes('"""') || text.includes("'''") || text.replace(STRING, '').includes('#')) {
    throw new UnsupportedShape(`${path} has comments or multi-line strings, which LCU cannot rewrite without losing them; leaving it untouched.`);
  }
  const rendered = render(document, path);
  let same = false;
  try {
    same = isDeepStrictEqual(parseToml(rendered, { floats: true }), document);
  } catch {
    // not faithful
  }
  if (!same) throw new UnsupportedShape(`${path} has a structure LCU cannot rewrite faithfully; leaving it untouched.`);
  return rendered;
}

/**
 * Run `fn` holding LCU's lock on one sessions folder. The original runtime does not take this lock, so it only
 * serializes LCU's own writers.
 */
export async function locked(directory, fn, { wait = LOCK_WAIT } = {}) {
  let release;
  try {
    release = await acquire(join(directory, LOCK_NAME), { wait,
      busy: () => new OriginsError('another `lcu origins` command is changing these files; try again in a moment.') });
  } catch (error) {
    if (error instanceof OriginsError) throw error;
    throw new OriginsError(`cannot lock ${directory}: ${reason(error)}`);
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Remove `origin` from the given lists of one session file; resolves with `{kind: count removed}`.
 *
 * Concurrent `lcu origins` commands are serialized by `locked`. The original runtime shares no lock with LCU (it
 * serializes only its own writes, in-process), so the file is also read again just before the replace, and the
 * change is recomputed if the runtime wrote before that read, and once more afterwards to report a write that
 * landed after the replace. A runtime write between the last pre-replace read and the replace itself is
 * overwritten without being noticed; no check without a lock the runtime shares can close that window, which is
 * microseconds wide. What is lost then is a saved answer, so the runtime asks about that site again; a lost entry
 * never grants access.
 */
export function forgetIn(path, origin, kinds, { attempts = WRITE_ATTEMPTS, files = {} } = {}) {
  return locked(dirname(path), async () => {
    try {
      return await forget(path, origin, kinds, attempts, { ...FILES, ...files });
    } catch (error) {
      if (error instanceof OriginsError) throw error;
      throw new OriginsError(`cannot update ${path}: ${reason(error)}`);
    }
  });
}

async function forget(path, origin, kinds, attempts, files) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (lstatSync(path).isSymbolicLink()) throw new OriginsError(`${path} is a symbolic link; leaving it untouched.`);
    const { raw, document, origins } = read(path, files);
    const removed = {};
    for (const kind of kinds) {
      const kept = origins[kind].filter((entry) => !sameOrigin(entry, origin));
      if (kept.length !== origins[kind].length) {
        removed[kind] = origins[kind].length - kept.length;
        document.origins[kind] = kept;
      }
    }
    if (!Object.keys(removed).length) return {};
    const text = rewritableText(raw, document, path);
    const temporary = files.writeTemporary(path, text, statSync(path).mode & 0o777);
    try {
      if (!files.read(path).equals(raw)) continue;
      try {
        files.replace(temporary, path);
      } catch (error) {
        throw new OriginsError(`cannot replace ${path}: ${reason(error)}`);
      }
    } finally {
      rmSync(temporary, { force: true });
    }
    await sleep(50);
    if (files.read(path).toString('utf8') !== text) {
      throw new OriginsError(`the original runtime changed ${path} while it was being updated; run ` +
        '`lcu origins list` to see what is saved now and repeat the command if needed.');
    }
    return removed;
  }
  throw new OriginsError(`${path} kept changing while it was being updated; try again.`);
}

// Commands -------------------------------------------------------------------------------------------

function list(args, home) {
  const directory = sessionsDirectory(home);
  const sessions = [];
  const problems = [];
  for (const [session, path] of sessionFiles(directory, args.session)) {
    try {
      sessions.push({ session, file: path, ...read(path).origins });
    } catch (error) {
      if (args.session !== undefined) throw error;
      problems.push({ session, file: path, error: error.message });
    }
  }
  const status = problems.length ? 1 : 0;
  if (args.json) {
    say(JSON.stringify({ codexHome: home, sessions, problems }, null, 2));
    return status;
  }
  for (const problem of problems) warn(`lcu origins: skipped ${problem.file}: ${problem.error}`);
  const shown = sessions.filter((entry) => entry.allowed.length || entry.denied.length);
  if (!shown.length && !problems.length) say(`No saved Chrome site decisions in ${directory}.`);
  for (const entry of shown) {
    say(`session ${entry.session}`);
    for (const kind of KINDS) for (const origin of entry[kind]) say(`  ${kind.padEnd(7)} ${origin}`);
  }
  return status;
}

async function forgetCommand(args, home) {
  const origin = normalizeOrigin(args.origin);
  const kinds = KINDS.filter((kind) => args[kind]);
  if (!kinds.length) kinds.push('denied');
  const directory = sessionsDirectory(home);
  const found = sessionFiles(directory, args.session);
  if (!found.length) {
    say(`No saved Chrome site decisions in ${directory}; nothing changed.`);
    return 0;
  }
  let changed = 0;
  const problems = [];
  for (const [session, path] of found) {
    let removed;
    try {
      removed = await forgetIn(path, origin, kinds);
    } catch (error) {
      if (args.session !== undefined || !(error instanceof OriginsError)) throw error;
      problems.push(error.message);
      continue;
    }
    for (const [kind, count] of Object.entries(removed)) {
      say(count === 1 ? `Removed ${origin} from ${kind} in session ${session}.` : `Removed ${count} entries for ${origin} from ${kind} in session ${session}.`);
    }
    if (Object.keys(removed).length) changed += 1;
  }
  for (const problem of problems) warn(`lcu origins: skipped: ${problem}`);
  if (changed) say(CACHE_NOTE);
  else {
    say(`${origin} is not in the saved ${kinds.join(' or ')} list of ` +
      `${args.session !== undefined ? `session ${args.session}` : `${found.length} saved session(s)`}; nothing changed.`);
  }
  return problems.length ? 1 : 0;
}

export const USAGE = 'Usage: lcu origins [list] [--session ID] [--json]\n' +
  '       lcu origins forget ORIGIN [--session ID | --all-sessions] [--allowed | --denied]';
const HELP = `${USAGE}

Show and forget the Chrome site decisions the original runtime saved for each agent session.

  list                show the saved allowed and denied origins per session
    --session ID      show only this session
    --json            print JSON instead of text
  forget ORIGIN       remove a saved decision so the site is asked about again
                      (scheme://host[:port], for example https://example.com)
    --session ID      only this session (default: every saved session)
    --all-sessions    every saved session (the default)
    --allowed         remove from the allowed list
    --denied          remove from the denied list (the default)

forget removes a saved answer so the next request for that site asks again. It never allows a site: only the
original prompt can. By default it removes the origin from the denied list of every saved session; --allowed
removes it from the allowed list instead (both flags: both lists).
${CACHE_NOTE}`;

function parseCommand(argv) {
  const [action, ...rest] = argv;
  const options = action === 'forget'
    ? { session: { type: 'string' }, 'all-sessions': { type: 'boolean' }, allowed: { type: 'boolean' }, denied: { type: 'boolean' } }
    : { session: { type: 'string' }, json: { type: 'boolean' } };
  if (!['list', 'forget'].includes(action)) throw new Error(`Unknown action '${action}'; use list or forget.`);
  const { values, positionals } = parseArgs({ args: rest, options: { ...options, help: { type: 'boolean', short: 'h' } }, allowPositionals: action === 'forget' });
  if (values.help) return { action: 'help' };
  if (action === 'forget') {
    if (positionals.length !== 1) throw new Error(positionals.length ? `Unexpected argument '${positionals[1]}'.` : 'Name the origin to forget, for example https://example.com.');
    if (values.session !== undefined && values['all-sessions']) throw new Error('Use either --session or --all-sessions, not both.');
    values.origin = positionals[0];
  }
  return { action, ...values };
}

/** `lcu origins ARGV`; returns the exit status. */
export async function main(argv, { env = process.env, windows } = {}) {
  const words = [...argv];
  if (!words.length || (words[0].startsWith('-') && !['-h', '--help'].includes(words[0]))) words.unshift('list');
  if (['-h', '--help'].includes(words[0])) {
    say(HELP);
    return 0;
  }
  let args;
  try {
    args = parseCommand(words);
  } catch (error) {
    warn(`lcu origins: ${error.message}`, "Run 'lcu origins --help' for usage.");
    return 2;
  }
  if (args.action === 'help') {
    say(HELP);
    return 0;
  }
  try {
    const home = codexHome(env, windows === undefined ? {} : { windows });
    return args.action === 'list' ? list(args, home) : await forgetCommand(args, home);
  } catch (error) {
    if (!(error instanceof OriginsError) && !error.code) throw error;
    warn(`lcu origins: ${error.message}`);
    return 1;
  }
}
