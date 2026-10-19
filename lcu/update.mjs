// Find out whether a newer LCU release exists, cache the answer and tell the agent.
// `lcu update --notice --hook ...` runs on agent prompts: it reads only the cache and never waits on the network.
const { mkdirSync, readFileSync, readSync, renameSync, statSync, utimesSync, writeFileSync, closeSync, openSync } = process.getBuiltinModule('node:fs');
const { dirname, join } = process.getBuiltinModule('node:path');
const { parseArgs } = process.getBuiltinModule('node:util');

import { cacheDirectory } from './check_record.mjs';
import { accountHome } from './fsutil.mjs';

export const REPO = 'amontlabs/lcu';
const LATEST_URL = `https://github.com/${REPO}/releases/latest`;
const RELEASE_URL = `https://github.com/${REPO}/releases/tag/`;
const notesUrl = (tag, version) => `https://raw.githubusercontent.com/${REPO}/${tag}/docs/releases/${version}.md`;
const INTERVAL = 600;
const RETRY = 3600;
const STAMP_TTL = 120;
export const STAMP_SKEW = 2; // Windows file times can run ahead of the clock
const ANNOUNCE_TTL = 7 * 24 * 3600;
export const ANNOUNCE_COOLDOWN = 24 * 3600;
export const ANNOUNCE_ACCOUNT = '*';
export const TIMEOUT = 5;
const SEVERITIES = ['security', 'breaking'];

/** What tests replace. */
export const deps = {
  now: () => Date.now() / 1000,
  spawnRefresh(root) {
    const child = process.getBuiltinModule('node:child_process').spawn(process.execPath,
      [join(root, 'lcu/runtime.mjs'), 'update', '--refresh'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  },
  fetchLatest: () => fetchLatest(),
  fetch: (url, init) => fetch(url, init),
  /** Run curl with `args`: `{status, stdout, stderr, error}`; the output is small (headers, notes, checksums). */
  curl: (args, timeout) => process.getBuiltinModule('node:child_process').spawnSync('curl', args,
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: (timeout + 5) * 1000, maxBuffer: 4 << 20 }),
  apply: async (root, info, options) => (await import('./update_apply.mjs')).apply(root, info, options),
  module: (name) => import(`./${name}.mjs`),
  readStdin() {
    let fd = 0;
    if (process.getBuiltinModule('node:tty').isatty(0)) return null;
    const chunks = [];
    const buffer = Buffer.alloc(65536);
    for (let total = 0, count; total < 1 << 20 && (count = readSync(fd, buffer)) > 0; total += count) {
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(chunks).toString('utf8');
  },
};

/** Dotted integers, or null when unparsable. */
export function parseVersion(text) {
  const value = String(text ?? '').trim().replace(/^v+/, '');
  if (!value) return null;
  const parts = value.split('.');
  return parts.every((part) => /^\d+$/.test(part)) ? parts.map(Number) : null;
}

const compare = (left, right) => {
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if ((left[i] ?? -1) !== (right[i] ?? -1)) return (left[i] ?? -1) - (right[i] ?? -1);
  }
  return 0;
};

/** The release version, or null for a source checkout or unreadable bundle. */
function installedVersion(root) {
  try {
    const version = JSON.parse(readFileSync(join(root, 'bundle.json'), 'utf8')).version;
    return version ?? null;
  } catch {
    return null;
  }
}

/** False for source checkouts and when LCU_NO_UPDATE_CHECK is set. */
export function enabled(root, env = process.env) {
  if (!['', '0'].includes((env.LCU_NO_UPDATE_CHECK ?? '').trim())) return false;
  return parseVersion(installedVersion(root)) !== null;
}

/** Per-account cache file; the install prefix may be root-owned. */
export const cachePath = () => join(cacheDirectory(), 'update.json');

const sibling = (name) => join(dirname(cachePath()), name);

export function readCache() {
  try {
    const data = JSON.parse(readFileSync(cachePath(), 'utf8'));
    return data && typeof data === 'object' && typeof data.checked_at === 'number' ? data : null;
  } catch {
    return null;
  }
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temporary, JSON.stringify(data));
  renameSync(temporary, path);
}

/** Atomic write; failures are ignored (the cache is only a courtesy). */
function writeCache(latest, error) {
  try {
    writeJson(cachePath(), { checked_at: deps.now(), latest, error });
  } catch {
    // ignored
  }
}

export function stale(cache, now = deps.now()) {
  if (!cache) return true;
  const age = now - cache.checked_at;
  return age < 0 || age >= (cache.error ? RETRY : INTERVAL);
}

/** Node's own CAs plus the system store, so a machine's own trust anchors keep working. */
let trustExtended = false;
function trustSystemCertificates() {
  if (trustExtended) return;
  trustExtended = true;
  const tls = process.getBuiltinModule('node:tls');
  try {
    tls.setDefaultCACertificates?.([...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])]);
  } catch {
    // keep Node's defaults
  }
}

/** True when `url` goes through an HTTPS proxy from the environment, which Node's fetch does not use. */
export function proxied(url, env = process.env) {
  if (!(env.HTTPS_PROXY || env.https_proxy)) return false;
  const host = new URL(url).hostname.toLowerCase();
  const bypass = `${env.NO_PROXY ?? env.no_proxy ?? ''}`.split(',').map((entry) => entry.trim().toLowerCase().replace(/^\*?\./, ''))
    .filter(Boolean);
  return !bypass.some((entry) => entry === '*' || host === entry || host.endsWith(`.${entry}`));
}

/**
 * Run the system curl over HTTPS only; it uses the system trust store and proxy settings. Returns its output.
 * A download writes to a file (`-o`), never to this process's memory.
 */
export function curl(args, timeout = TIMEOUT) {
  const result = deps.curl(['-fsS', '--proto', '=https', '--tlsv1.2', '--max-time', String(timeout), ...args], timeout);
  if (result.error && result.status == null) throw new Error(`curl could not run (${result.error.code ?? result.error.message}).`);
  if (result.status !== 0) throw new Error(`${result.stderr ?? ''}`.trim() || `curl exited ${result.status}`);
  return Buffer.from(result.stdout ?? '');
}

const DEVNULL = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** fetch `url`, or null when the request itself failed (no HTTP answer), so curl can try. */
async function attempt(url, init, timeout) {
  trustSystemCertificates();
  try {
    return await deps.fetch(url, { ...init, headers: { 'User-Agent': 'lcu-update' }, signal: AbortSignal.timeout(timeout * 1000) });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error(`Timed out fetching ${url}`);
    return null;
  }
}

/** The body of `url` (redirects followed), at most `limit` bytes. */
export async function getText(url, { limit = 1 << 16, timeout = TIMEOUT } = {}) {
  const response = proxied(url) ? null : await attempt(url, {}, timeout);
  if (!response) return curl(['-L', url], timeout).subarray(0, limit).toString('utf8');
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer()).subarray(0, limit).toString('utf8');
}

/** Download `url` into `file`; returns the file's SHA-256. */
export async function downloadTo(url, file, { timeout = 30 * 60 } = {}) {
  const { createReadStream, createWriteStream } = process.getBuiltinModule('node:fs');
  const { pipeline } = process.getBuiltinModule('node:stream/promises');
  const { Readable } = process.getBuiltinModule('node:stream');
  const response = proxied(url) ? null : await attempt(url, {}, timeout);
  if (response) {
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  } else {
    curl(['-L', '-o', file, url], timeout);
  }
  const digest = process.getBuiltinModule('node:crypto').createHash('sha256');
  await pipeline(createReadStream(file), digest);
  return digest.digest('hex');
}

const REDIRECTS = [301, 302, 303, 307, 308];

/** The latest release tag, from the redirect of /releases/latest (no API, no rate limit). */
export async function latestTag() {
  let location;
  const response = proxied(LATEST_URL) ? null : await attempt(LATEST_URL, { method: 'HEAD', redirect: 'manual' }, TIMEOUT);
  if (!response) location = curl(['-I', '-o', DEVNULL, '-w', '%{redirect_url}', LATEST_URL]).toString('utf8').trim();
  else if (REDIRECTS.includes(response.status)) location = response.headers.get('location');
  else if (!response.ok) throw new Error(`HTTP ${response.status} for ${LATEST_URL}`);
  const match = /\/releases\/tag\/([^/?#]+)$/.exec(location ?? '');
  if (!match) throw new Error('Unexpected response while looking for the latest LCU release.');
  return match[1];
}

/** `security` or `breaking` from the release notes marker; anything else is `normal`. */
export async function severityOf(tag, version) {
  let text;
  try {
    text = await getText(notesUrl(tag, version), { limit: 262144 });
  } catch {
    return 'normal';
  }
  // Only a marker on its own line counts, so notes that mention the syntax inline are not flagged.
  const match = /^[ \t]*<!--\s*lcu-severity:\s*(\w+)\s*-->[ \t]*$/m.exec(text);
  return match && SEVERITIES.includes(match[1]) ? match[1] : 'normal';
}

/** Release info for the newest release; throws on failure. */
export async function fetchLatest() {
  const tag = await latestTag();
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  if (parseVersion(version) === null) throw new Error(`Unrecognized release tag: ${tag}`);
  return { version, tag, release_url: RELEASE_URL + tag, severity: await severityOf(tag, version) };
}

/** Check now and update the cache: `[info, null]` or `[null, error]`. */
export async function check() {
  try {
    const info = await deps.fetchLatest();
    writeCache(info, null);
    return [info, null];
  } catch (error) {
    const message = error?.message || String(error);
    // Keep the last known release so a flaky network does not hide a pending update.
    writeCache(readCache()?.latest ?? null, message);
    return [null, message];
  }
}

export function newer(root, info) {
  const current = parseVersion(installedVersion(root));
  const latest = parseVersion(info?.version);
  return Boolean(current && latest && compare(latest, current) > 0);
}

/** The stable `lcu` path of this installation (`current` on POSIX, `<prefix>\lcu.cmd` on Windows). */
export function stableCommand(root, platform = process.platform) {
  const inPrefix = dirname(root).split(/[\\/]/).at(-1) === 'releases';
  if (platform === 'win32' && inPrefix) return join(dirname(dirname(root)), 'lcu.cmd');
  return join(inPrefix ? join(dirname(dirname(root)), 'current') : root, 'bin/lcu');
}

/** True when this caller should spawn a refresh (touches refresh.stamp); never throws. */
export function refreshClaimed(now = deps.now()) {
  try {
    const stamp = sibling('refresh.stamp');
    try {
      const age = now - statSync(stamp).mtimeMs / 1000;
      if (age >= -STAMP_SKEW && age < STAMP_TTL) return false;
    } catch {
      // no stamp yet
    }
    mkdirSync(dirname(stamp), { recursive: true });
    closeSync(openSync(stamp, 'a'));
    utimesSync(stamp, now, now);
    return true;
  } catch {
    return true;
  }
}

function message(root, info, current) {
  const prefix = { security: 'Security update: ', breaking: 'Breaking update: ' }[info.severity] ?? '';
  return `${prefix}LCU ${info.version} is available (installed: ${current}). Tell the user and offer to run ` +
    `\`${stableCommand(root)} update\`; do not upgrade without asking. Agents using LCU must be ` +
    `restarted afterwards. Release notes: ${info.release_url}`;
}

/** The notice from the cache only (no refresh), or null. */
export function noticeCached(root) {
  const info = readCache()?.latest;
  if (!info || typeof info !== 'object' || !newer(root, info)) return null;
  const current = installedVersion(root);
  const severity = SEVERITIES.includes(info.severity) ? info.severity : 'normal';
  return { current, latest: info.version, severity, release_url: info.release_url, command: stableCommand(root),
    message: message(root, { ...info, severity }, current) };
}

/** The cached update notice, refreshing a stale cache in the background. Never blocks and never throws. */
export function notice(root) {
  try {
    if (!enabled(root)) return null;
    if (stale(readCache())) {
      try {
        if (refreshClaimed()) deps.spawnRefresh(root);
      } catch {
        // a failed refresh never hides the cached notice
      }
    }
    return noticeCached(root);
  } catch {
    return null;
  }
}

/** The cached notice when update checks are enabled, else null; never throws. */
export function cachedNotice(root) {
  try {
    return enabled(root) ? noticeCached(root) : null;
  } catch {
    return null;
  }
}

/** One human line for status and doctor from the cache only, or null. */
export function statusLine(root) {
  const found = cachedNotice(root);
  return found && `LCU ${found.latest} is available (installed ${found.current}): ${found.release_url}. ` +
    `Run \`${found.command} update\` to upgrade.`;
}

/** session_id from the hook input JSON on stdin (the harness closes it), or null. */
function hookSessionId() {
  try {
    const data = JSON.parse(deps.readStdin());
    const value = data && typeof data === 'object' && !Array.isArray(data) ? data.session_id : null;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

/**
 * True when an agent session should be told about `version` now; records it. Never throws. A release is
 * announced at most once per ANNOUNCE_COOLDOWN across every session on the account (the `*` entry of
 * announced.json); a session is never told twice about the same release, and a different release is announced
 * at once. Without a session id only the account-wide cooldown applies.
 */
export function announce(sessionId, version, now = deps.now()) {
  try {
    const path = sibling('announced.json');
    let data = {};
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch {
      // start afresh
    }
    data = Object.fromEntries(Object.entries(data).filter(([, value]) => value && typeof value === 'object' &&
      typeof value.at === 'number' && now - value.at >= 0 && now - value.at < ANNOUNCE_TTL));
    if (sessionId && data[sessionId]?.version === version) return false;
    const last = data[ANNOUNCE_ACCOUNT];
    if (last?.version === version && now - last.at < ANNOUNCE_COOLDOWN) return false;
    data[ANNOUNCE_ACCOUNT] = { version, at: now };
    if (sessionId) data[sessionId] = { version, at: now };
    try {
      writeJson(path, data);
    } catch {
      // still announce
    }
    return true;
  } catch {
    return true;
  }
}

/** Refresh the Chrome relay `lcu browser install` set up earlier; never enables Chrome, never fails the update. */
async function refreshChromeRelay(root) {
  const command = `${stableCommand(root)} browser install`;
  const out = (line) => process.stdout.write(`${line}\n`);
  try {
    const { status: state, destination, displaced = [] } = await (await deps.module('browser')).refresh(root);
    if (state === 'absent') return;
    if (state === 'elsewhere') {
      out(`Chrome: the native-host manifest no longer points at the LCU relay, so it was left alone. To use Chrome through LCU again, run \`${command}\`.`);
    } else if (state === 'root') {
      out(`Chrome: the relay was not refreshed because the update ran as root. As the desktop account, run \`${command}\`.`);
    } else {
      out(`Refreshed the Chrome relay at ${destination}.`);
      if (state === 'changed') {
        out("If the extension was already connected, restart Chrome or turn the ChatGPT extension off and on so it reconnects through LCU's relay.");
      }
      if (displaced.length) {
        out(`Chrome: a native-host manifest points somewhere other than the LCU relay and was left alone (${displaced[0]}). ` +
          `To use Chrome through LCU again, run \`${command}\`.`);
      }
    }
  } catch (error) {
    process.stderr.write(`lcu update: could not refresh the Chrome relay (${error?.message ?? error}); run \`${command}\`.\n`);
  }
}

/** Refresh what setup copied out of an earlier release; `lcu update` runs it from the new release. */
export async function postInstall(root, home = accountHome()) {
  const claudeMod = await deps.module('claude_mod');
  const target = claudeMod.destination(home);
  // An absent mod, or a plugin of that name that is not LCU's, is left alone.
  if (claudeMod.owned(target)) {
    await claudeMod.install(home, root);
    process.stdout.write(`Refreshed the Claude Code lcu-approve mod at ${target}.\n`);
  }
  await refreshChromeRelay(root);
  if (await codexNeedsSetup(home)) {
    process.stdout.write(`Codex: run \`${stableCommand(root)} setup --agent codex\` to add the LCU update-notice hook.\n`);
  }
  return 0;
}

/** True when Codex has LCU registered but not the update-notice hooks (`lcu setup --agent codex` adds them). */
export async function codexNeedsSetup(home = accountHome(), env = process.env) {
  let config;
  try {
    const { parse } = await deps.module('toml');
    config = parse(readFileSync(join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'), 'utf8'));
  } catch {
    return false;
  }
  if (!config.mcp_servers || !Object.hasOwn(config.mcp_servers, 'lcu')) return false;
  const { isNoticeGroup } = await deps.module('codex_hooks');
  const hooks = config.hooks ?? {};
  return !['SessionStart', 'UserPromptSubmit'].every((event) => (Array.isArray(hooks[event]) ? hooks[event] : [])
    .some((group) => group && typeof group === 'object' && isNoticeGroup(group)));
}

const OPTIONS = {
  check: { type: 'boolean' }, notice: { type: 'boolean' }, refresh: { type: 'boolean' }, 'post-install': { type: 'boolean' },
  json: { type: 'boolean' }, hook: { type: 'string' }, announce: { type: 'string' }, yes: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};
const USAGE = 'Usage: lcu update [-h] [--check | --notice] [--json] [--yes]\n\n' +
  'Find out whether a newer LCU release exists and install it.\n\n' +
  '  --check   check now without installing\n  --notice  print the cached update notice for an agent (never uses the network)\n' +
  '  --json    print JSON (with --check or --notice)\n  --yes     do not ask before installing\n';

function parse(argv) {
  // `--announce` takes an optional value: alone (or before another option) it means "no session id".
  const args = argv.flatMap((arg, index) => (arg === '--announce' && (index + 1 === argv.length || argv[index + 1].startsWith('-'))
    ? ['--announce='] : [arg]));
  const { values } = parseArgs({ args, options: OPTIONS, strict: true });
  const modes = ['check', 'notice', 'refresh', 'post-install'].filter((name) => values[name]);
  if (modes.length > 1) throw new Error(`--${modes[1]} not allowed with --${modes[0]}`);
  if (values.hook !== undefined && !['SessionStart', 'UserPromptSubmit'].includes(values.hook)) {
    throw new Error(`invalid --hook ${values.hook}`);
  }
  return values;
}

/** `lcu update ARGV` for the release `root`; returns the exit status. */
export async function main(root, argv = []) {
  let args;
  try {
    args = parse(argv);
  } catch (error) {
    process.stderr.write(`lcu update: ${error.message}\nRun 'lcu update --help' for usage.\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.notice) {
    try {
      let found = notice(root);
      if (args.hook) {
        // A hook's documented way to add model context: once per session and release, and at most once a day
        // per release across the account, else silent.
        const session = found && hookSessionId();
        if (found && (session || args.hook === 'SessionStart') && announce(session, found.latest)) {
          process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: args.hook, additionalContext: found.message } })}\n`);
        }
      } else {
        // An agent integration (the Claude Code mod) is under the same cooldown as the hooks.
        if (found && args.announce !== undefined && !announce(args.announce || null, found.latest)) found = null;
        if (args.json) process.stdout.write(`${JSON.stringify(found ?? {})}\n`);
        else if (found) process.stdout.write(`${found.message}\n`);
      }
    } catch {
      // a notice never fails the agent
    }
    return 0;
  }
  if (args['post-install']) return postInstall(root);
  if (args.refresh) {
    try {
      if (enabled(root)) await check();
    } catch {
      // silent
    }
    return 0;
  }
  const current = installedVersion(root);
  if (parseVersion(current) === null) throw new Error('lcu update needs an installed LCU release, not a source checkout.');
  const [info, error] = await check();
  const available = newer(root, info);
  if (args.check) {
    if (args.json) process.stdout.write(`${JSON.stringify({ current, latest: info, update_available: available, error })}\n`);
    else if (error) process.stderr.write(`lcu update: could not check for updates: ${error}\n`);
    else if (available) {
      process.stdout.write(`LCU ${info.version} is available (installed ${current}): ${info.release_url}\n` +
        `Run ${stableCommand(root)} update to upgrade.\n`);
    } else process.stdout.write(`LCU ${current} is up to date.\n`);
    return error ? 1 : 0;
  }
  if (error) {
    process.stderr.write(`lcu update: could not check for updates: ${error}\n`);
    return 1;
  }
  if (!available) {
    process.stdout.write(`LCU ${current} is up to date.\n`);
    return 0;
  }
  return deps.apply(root, info, { yes: Boolean(args.yes) });
}
