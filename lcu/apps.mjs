// `lcu apps`: manage the apps Computer Use may always control, behind owner authentication (macOS).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, chmodSync, closeSync, constants, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { isDirectory } from './fsutil.mjs';
import { plistStrings } from './platforms.mjs';
import { say, warn } from './terminal.mjs';

export const KEY = 'approvedBundleIdentifiers';
const STORE = 'Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json';
export const HELPER = 'bin/lcu-owner-auth';
// The original runtime refuses these before it asks anyone, so an entry would never take effect.
const FORBIDDEN = { 'com.apple.Terminal': 'Terminal', 'com.googlecode.iterm2': 'iTerm2', 'com.openai.codex': 'ChatGPT',
  'com.apple.UserNotificationCenter': 'Notification Center' };
// The original runtime marks these "Elevated Risk" (browsers, password managers, iPhone Mirroring).
const HIGH_RISK = new Set(['com.apple.Safari', 'com.google.Chrome', 'app.zen-browser.zen', 'com.apple.Passwords',
  'com.apple.keychainaccess', 'com.apple.ScreenContinuity', 'org.mozilla.firefox', 'com.microsoft.edgemac', 'com.brave.Browser',
  'company.thebrowser.Browser', 'com.operasoftware.Opera', 'com.vivaldi.Vivaldi', 'org.chromium.Chromium', 'com.1password.1password',
  'com.bitwarden.desktop']);
const RISK_NOTE = 'This app is marked high risk by Computer Use (browsers, password managers and iPhone Mirroring are): ' +
  'content it shows can carry prompt injection, and the agent can read or change what it holds. Watch the agent while it uses this app.';
const AUTH_TIMEOUT = 300_000;
const WRITE_ATTEMPTS = 8;

/** A problem to show the user. */
export class AppsError extends Error {}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const readOrNull = (path) => { try { return readFileSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

export const storePath = (home = homedir()) => join(home, STORE);

/** `{raw, document, ids}` of the approvals file (raw null when absent). A damaged file is never overwritten. */
function readStore(path) {
  let raw;
  try {
    raw = readOrNull(path);
  } catch (error) {
    throw new AppsError(`cannot read ${path}: ${error.message}`);
  }
  if (raw === null) return { raw: null, document: {}, ids: [] };
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    document = null;
  }
  const ids = document && typeof document === 'object' && !Array.isArray(document) ? document[KEY] ?? [] : null;
  if (!Array.isArray(ids) || !ids.every((item) => typeof item === 'string')) {
    throw new AppsError(`${path} is not a valid approvals file (expected {"${KEY}": [bundle ids]}); leaving it untouched. ` +
      'Move it aside to start from an empty list.');
  }
  return { raw, document, ids };
}

const sameIds = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);

/**
 * Apply `change(ids) -> ids` with an atomic replace that tolerates the runtime writing too. The runtime does not
 * share a lock with LCU, so the file is re-read just before the replace and again afterwards. If either read shows
 * another writer got in, the change is recomputed from the new content. Keys other than the approved list are kept.
 */
export async function modify(path, change, { attempts = WRITE_ATTEMPTS, wait = sleep } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { raw, document, ids } = readStore(path);
    const updated = change([...ids]);
    if (raw !== null && sameIds(updated, ids)) return ids;
    mkdirSync(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeSync(fd, `${JSON.stringify({ ...document, [KEY]: updated }, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        chmodSync(temporary, statSync(path).mode & 0o777);
      } catch {
        // a new file keeps the private default
      }
      const now = readOrNull(path);
      if (now === null ? raw !== null : raw === null || !now.equals(raw)) continue;
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    await wait(50 * (attempt + 1));
    if (sameIds(readStore(path).ids, updated)) return updated;
  }
  throw new AppsError(`${path} kept changing while it was being updated; try again.`);
}

// App lookup -----------------------------------------------------------------------------------------

const appDirectories = (home = homedir()) => ['/Applications', '/Applications/Utilities', '/System/Applications',
  '/System/Applications/Utilities', join(home, 'Applications')];

/** `[bundle id, display name]` of an .app directory, or null when it is not a bundle. */
export function bundleInfo(app) {
  let info;
  try {
    info = plistStrings(readFileSync(join(app, 'Contents/Info.plist')));
  } catch {
    return null;
  }
  const identifier = info.CFBundleIdentifier;
  if (typeof identifier !== 'string' || !identifier) return null;
  return [identifier, info.CFBundleDisplayName || info.CFBundleName || basename(app, extname(app))];
}

function mdfind(query) {
  const done = spawnSync('/usr/bin/mdfind', [query], { encoding: 'utf8', timeout: 10_000 });
  return done.status === 0 ? done.stdout.split('\n').filter((line) => line.endsWith('.app')) : [];
}

const quote = (value) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
const bundles = (directory) => (isDirectory(directory) ? readdirSync(directory).sort().filter((name) => name.endsWith('.app')) : []);

/** Prefer the standard application folders, then the shortest path. */
function best(candidates, directories) {
  const rank = (app) => [directories.includes(dirname(app)) ? 0 : 1, app.length, app];
  return [...candidates].sort((left, right) => {
    const [a, b] = [rank(left), rank(right)];
    return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
  });
}

/** Where the app with this bundle id is installed, or null. */
function findById(identifier, directories) {
  let candidates = directories.flatMap((directory) => bundles(directory).map((name) => join(directory, name)))
    .filter((app) => bundleInfo(app)?.[0] === identifier);
  if (!candidates.length) {
    candidates = mdfind(`kMDItemCFBundleIdentifier == "${quote(identifier)}"`).filter((app) => bundleInfo(app)?.[0] === identifier);
  }
  return candidates.length ? best(candidates, directories)[0] : null;
}

export function displayName(identifier, directories) {
  const app = findById(identifier, directories);
  return app ? bundleInfo(app)?.[1] ?? null : null;
}

/** `[bundle id, display name, installed]` for an app name, a bundle id or an .app path. */
export function resolveApp(query, { home } = {}) {
  const directories = appDirectories(home);
  if (query.endsWith('.app') || query.endsWith('.app/') || query.includes('/')) {
    const path = resolve(query.replace(/^~(?=\/|$)/, homedir()));
    if (!isDirectory(path)) throw new AppsError(`${query} is not an application bundle.`);
    const info = bundleInfo(path);
    if (!info) throw new AppsError(`${query} has no bundle identifier in Contents/Info.plist.`);
    return [info[0], info[1], true];
  }
  const wanted = query.toLowerCase();
  const matches = new Map();
  for (const directory of directories) {
    for (const entry of bundles(directory)) {
      const app = join(directory, entry);
      const info = bundleInfo(app);
      if (info && [entry.slice(0, -4).toLowerCase(), info[1].toLowerCase()].includes(wanted) && !matches.has(info[0])) {
        matches.set(info[0], [info[1], app]);
      }
    }
  }
  if (!matches.size) {
    for (const app of mdfind(`kMDItemKind == "Application" && kMDItemDisplayName == "${quote(query)}"c`)) {
      const info = bundleInfo(app);
      if (info && !matches.has(info[0])) matches.set(info[0], [info[1], app]);
    }
  }
  if (!matches.size && query.includes('.')) {
    const app = findById(query, directories);
    const info = app ? bundleInfo(app) : null;
    return info ? [info[0], info[1], true] : [query, query, false];
  }
  if (!matches.size) throw new AppsError(`no installed app named "${query}". Pass its bundle identifier or the path to its .app.`);
  if (matches.size > 1) {
    const options = [...matches].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, [, app]]) => `${id} (${app})`).join(', ');
    throw new AppsError(`"${query}" matches several apps: ${options}. Pass the bundle identifier or path.`);
  }
  const [[identifier, [name]]] = matches;
  return [identifier, name, true];
}

/** Like resolveApp, but a name or id that matches an approved entry wins, even if uninstalled. */
function resolveApproved(query, ids, { home } = {}) {
  const directories = appDirectories(home);
  if (ids.includes(query)) return [query, displayName(query, directories) ?? query];
  const named = ids.filter((id) => (displayName(id, directories) ?? '').toLowerCase() === query.toLowerCase());
  if (named.length === 1) return [named[0], displayName(named[0], directories)];
  try {
    const [identifier, name] = resolveApp(query, { home });
    return [identifier, name];
  } catch {
    if (named.length) throw new AppsError(`"${query}" matches several approved apps: ${named.join(', ')}.`);
    throw new AppsError(`"${query}" is not among the approved apps. Run \`lcu apps\` to see them.`);
  }
}

// Authentication -------------------------------------------------------------------------------------

/** Ask macOS for Touch ID or the login password; throws AppsError unless the owner approved. */
export function authenticate(root, reason) {
  const helper = join(root, HELPER);
  try {
    if (!statSync(helper).isFile()) throw new Error();
    accessSync(helper, constants.X_OK);
  } catch {
    throw new AppsError(`the owner-authentication helper is missing (${helper}); reinstall this LCU release. Nothing was changed.`);
  }
  warn('Waiting for Touch ID or your password...');
  const done = spawnSync(helper, ['--reason', reason], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: AUTH_TIMEOUT });
  if (done.error) throw new AppsError(`could not run the owner-authentication helper: ${done.error.message}. Nothing was changed.`);
  if (done.status === 0) return;
  if (done.status === 1) throw new AppsError('authentication was cancelled or failed. Nothing was changed.');
  const detail = done.stderr.trim() || `exit status ${done.status ?? done.signal}`;
  throw new AppsError(`cannot ask for authentication: ${detail}. Run this from a terminal in your logged-in desktop session. Nothing was changed.`);
}

// Commands -------------------------------------------------------------------------------------------

function describe(identifier, directories) {
  const name = displayName(identifier, directories);
  return { name: name ?? identifier, bundleId: identifier, installed: name !== null,
    risk: HIGH_RISK.has(identifier) ? 'high' : 'normal', blocked: identifier in FORBIDDEN };
}

function list({ json }, { home }) {
  const path = storePath(home);
  const { ids } = readStore(path);
  const directories = appDirectories(home);
  const apps = ids.map((id) => describe(id, directories)).sort((a, b) => {
    const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
    return x < y ? -1 : x > y ? 1 : a.bundleId < b.bundleId ? -1 : a.bundleId > b.bundleId ? 1 : 0;
  });
  if (json) {
    say(JSON.stringify({ apps, file: path }, null, 2));
    return 0;
  }
  if (!apps.length) {
    say('No apps are always allowed for Computer Use.', 'Allow one with: lcu apps allow <app>');
    return 0;
  }
  const width = Math.max(...apps.map((app) => app.name.length));
  for (const app of apps) {
    const notes = [...(app.risk === 'high' ? ['high risk'] : []), ...(app.blocked ? ['blocked: Computer Use refuses this app'] : []),
      ...(app.installed ? [] : ['not installed'])];
    say(`${app.name.padEnd(width)}  ${app.bundleId}${notes.length ? `  (${notes.join('; ')})` : ''}`);
  }
  return 0;
}

async function allow({ app }, { root, home, auth }) {
  const path = storePath(home);
  const [identifier, name, installed] = resolveApp(app, { home });
  const label = `${name} (${identifier})`;
  if (identifier in FORBIDDEN) {
    throw new AppsError(`Computer Use never controls ${FORBIDDEN[identifier]} (${identifier}), so approving it would have no effect. Nothing was changed.`);
  }
  if (!installed) throw new AppsError(`${identifier} is not installed here; Computer Use would reject it as an invalid app.`);
  if (readStore(path).ids.includes(identifier)) {
    say(`${label} is already always allowed.`);
    return 0;
  }
  const risky = HIGH_RISK.has(identifier);
  if (risky) warn(`Warning: ${RISK_NOTE}`);
  await auth(root, `always allow Computer Use to control ${label}${risky ? ' (high risk)' : ''}`);
  await modify(path, (ids) => (ids.includes(identifier) ? ids : [...ids, identifier]));
  say(`Always allowed: ${label}. Running sessions pick this up immediately.`);
  return 0;
}

async function revoke({ app }, { root, home, auth }) {
  const path = storePath(home);
  const { ids } = readStore(path);
  const [identifier, name] = resolveApproved(app, ids, { home });
  const label = name !== identifier ? `${name} (${identifier})` : identifier;
  if (!ids.includes(identifier)) {
    say(`${label} is not in the always-allowed list.`);
    return 0;
  }
  await auth(root, `stop always allowing Computer Use to control ${label}`);
  await modify(path, (current) => current.filter((item) => item !== identifier));
  say(`Removed: ${label}. Computer Use asks again the next time it needs this app.`);
  return 0;
}

export const USAGE = 'lcu apps [list] [--json]\n       lcu apps allow <app>\n       lcu apps revoke <app>';
const HELP = `Usage: ${USAGE}

Manage the apps Computer Use may always control, without the Codex app.

  list [--json]   show the always-allowed apps (JSON with --json)
  allow <app>     always allow an app (asks for Touch ID or your password)
  revoke <app>    remove an app (asks for Touch ID or your password)

<app> is an app name ("Zed"), a bundle identifier (dev.zed.Zed) or the path to an .app.
allow and revoke ask for Touch ID or your login password; list does not.`;

function parseCommand(words) {
  const [action, ...rest] = words;
  if (!['list', 'allow', 'revoke'].includes(action)) throw new Error(`Unknown action '${action}'; use list, allow or revoke.`);
  const options = { help: { type: 'boolean', short: 'h' }, ...(action === 'list' ? { json: { type: 'boolean' } } : {}) };
  const { values, positionals } = parseArgs({ args: rest, options, allowPositionals: action !== 'list' });
  if (values.help) return { action: 'help' };
  if (action !== 'list' && positionals.length !== 1) {
    throw new Error(positionals.length ? `Unexpected argument '${positionals[1]}'.` : `Name the app to ${action}.`);
  }
  return { action, json: Boolean(values.json), app: positionals[0] };
}

/** `lcu apps ARGV`; returns the exit status. */
export async function main(root, argv, { platform = process.platform, home, auth = authenticate } = {}) {
  if (platform === 'linux') {
    warn('lcu apps is macOS-only. The Linux computer-use runtime has no per-app approval: your harness\'s own tool approval ' +
      'is the only gate, so there is no list to manage. See docs/ADAPTERS.md.');
    return 1;
  }
  if (platform !== 'darwin') {
    warn('lcu apps is not supported on Windows.');
    return 1;
  }
  const words = [...argv];
  if (!words.length || (words[0].startsWith('-') && !['-h', '--help'].includes(words[0]))) words.unshift('list');
  let args;
  try {
    args = ['-h', '--help'].includes(words[0]) ? { action: 'help' } : parseCommand(words);
  } catch (error) {
    warn(`lcu apps: ${error.message}`, "Run 'lcu apps --help' for usage.");
    return 2;
  }
  if (args.action === 'help') {
    say(HELP);
    return 0;
  }
  try {
    return await { list, allow, revoke }[args.action](args, { root, home, auth });
  } catch (error) {
    if (!(error instanceof AppsError)) throw error;
    warn(`lcu apps: ${error.message}`);
    return 1;
  }
}
