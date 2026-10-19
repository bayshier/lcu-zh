// `lcu setup`: register LCU with agent harnesses, without requiring a running desktop.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, chmodSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,   realpathSync, renameSync, rmdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { locateCodexTools } from './app_layout.mjs';
import * as approvals from './approval.mjs';
import * as capture from './capture.mjs';
import { installHooks, requireCliHookSupport, exportFiles } from './codex_hooks.mjs';
import { install as installApprovalMod } from './claude_mod.mjs';
import { install as hideHostOnlyTools } from './claude_visibility.mjs';
import { accountHome, isFile, lstat, real, shellQuote } from './fsutil.mjs';
import { approvalNote, question as crossTurnQuestion, readCrossTurn, setCrossTurn } from './cross_turn.mjs';
import { configureHermes, configureOmp } from './harness_setup.mjs';
import { withLock } from './lock.mjs';
import { ask, say, warn } from './terminal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const windows = () => process.platform === 'win32';
const APP_DOWNLOAD_URL = 'https://chatgpt.com/download/';

export function appPrerequisiteMessage(location, { alternateLocation = false } = {}) {
  let message = 'LCU requires the official ChatGPT desktop app, which includes Codex, to be installed first. ' +
    'LCU does not download or install the app.';
  if (location !== undefined && location !== null) message += ` No app was found at ${location}.`;
  message += ` Install it from ${APP_DOWNLOAD_URL} and rerun LCU.`;
  if (alternateLocation) message += ' If it is installed elsewhere, pass --existing-app PATH.';
  return message;
}

// LCU names mapped to upstream installers; configuration formats belong upstream.
export const CLIENTS = {
  codex: { label: 'Codex', executable: 'codex', detectPath: '.codex', mcpAgent: 'codex' },
  'claude-code': { label: 'Claude Code', executable: 'claude', detectPath: '.claude.json', mcpAgent: 'claude-code' },
  pi: { label: 'Pi', executable: 'pi', detectPath: '.pi/agent', mcpAgent: 'pi' },
  omp: { label: 'Oh My Pi', executable: 'omp', detectPath: '.omp', mcpAgent: '' },
  hermes: { label: 'Hermes', executable: 'hermes', detectPath: '.hermes', mcpAgent: '' },
};
export const ALIASES = { claude: 'claude-code', 'oh-my-pi': 'omp', 'hermes-agent': 'hermes' };
// Harnesses whose native registration needs their own executable; Codex and Claude Code register through
// add-mcp and their config files without the CLI installed.
const NEEDS_BINARY = ['pi', 'omp', 'hermes'];
// Native harness plugins are profile-scoped; project scope is unsupported.
const USER_ONLY_AGENTS = ['omp', 'hermes'];

// Shell and Windows command-line quoting for the commands LCU prints and registers.
export const shellJoin = (args) => args.map(shellQuote).join(' ');
export function windowsCommandLine(args) {
  return args.map((arg) => {
    const quote = !arg || /[ \t]/.test(arg);
    let text = '';
    let slashes = 0;
    for (const char of arg) {
      if (char === '\\') slashes += 1;
      else {
        text += '\\'.repeat(char === '"' ? slashes * 2 + 1 : slashes) + char;
        slashes = 0;
      }
    }
    text += '\\'.repeat(quote ? slashes * 2 : slashes);
    return quote ? `"${text}"` : text;
  }).join(' ');
}

/** The first executable named `name` on `path` (PATHEXT applies on Windows), or null. */
export function which(name, path = process.env.PATH ?? '') {
  const extensions = windows() ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, name + extension);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        if (!windows() || extension) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** `{name, uid, gid, home}` of a local account, or null. */
function lookupAccount(name) {
  const own = userInfo();
  // Without --user, the calling account's home as its agents see it ($HOME when that is safe to use).
  if (name === undefined) return { name: own.username, uid: own.uid, gid: own.gid, home: accountHome(process.env, () => own) };
  if (name === own.username) {
    return { name: own.username, uid: own.uid, gid: own.gid, home: windows() ? process.env.USERPROFILE || own.homedir : own.homedir };
  }
  if (process.platform === 'darwin') {
    const result = capture.run('/usr/bin/dscacheutil', ['-q', 'user', '-a', 'name', name], { timeout: 20_000 });
    const fields = Object.fromEntries(result.stdout.split('\n').map((line) => line.split(': ')).filter((pair) => pair.length === 2));
    return fields.name === name ? { name, uid: Number(fields.uid), gid: Number(fields.gid), home: fields.dir } : null;
  }
  const result = capture.run('getent', ['passwd', name], { timeout: 20_000 });
  const fields = result.status === 0 ? result.stdout.split('\n')[0].split(':') : [];
  return fields.length >= 7 && fields[0] === name ? { name, uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5] } : null;
}

/** The operating-system and harness operations setup performs, replaceable in tests. */
export const seams = {
  /** Run a child with its output captured: `{status, stdout, stderr, error}`. */
  run: (command, args, options) => capture.run(command, args, options),
  /** Run a child on this terminal: `{status, signal, error}`. */
  spawn: (command, args, options) => spawnSync(...capture.batchCommand(command, args, { stdio: 'inherit', ...options })),
  which,
  account: lookupAccount,
  interactive: () => process.stdin.isTTY === true,
  ask,
  installBrowser: async (root) => (await import('./browser.mjs')).install(root),
};

/** Run an installer step; its diagnostics are shown to the invoking user, never stored. */
export function checked(label, command, args, options) {
  const result = seams.run(command, args, options);
  if (result.error) throw new Error(`${label} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${label} exited ${result.status ?? result.signal}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

// Files ----------------------------------------------------------------------------------------------


/** The absolute form of `path`; refuses parent traversal, control characters and symlinks anywhere on it. */
export function regularPath(path) {
  path = String(path);
  if (path.split(/[\\/]/).includes('..') || /[\x00-\x1f]/.test(path)) {
    throw new Error(`Use a path without parent traversal or control characters: ${path}`);
  }
  const absolute = resolve(path);
  for (let item = absolute; ; item = dirname(item)) {
    if (lstat(item)?.isSymbolicLink()) throw new Error(`Refusing a symlink in setup destination: ${item}. Use manual configuration instead.`);
    if (item === dirname(item)) break;
  }
  return absolute;
}

/** The bytes of a regular file, or null when it does not exist. */
export function readFile(path) {
  path = regularPath(path);
  if (!existsSync(path)) return null;
  if (!statSync(path).isFile()) throw new Error(`Expected a regular file: ${path}`);
  return readFileSync(path);
}

/** Replace `path` with `data` (null removes it) through a synced temporary file; the file keeps its mode. */
export function atomicWrite(path, data) {
  path = regularPath(path);
  mkdirSync(dirname(path), { recursive: true });
  if (data === null) {
    rmSync(path, { force: true });
    return;
  }
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temporary = join(dirname(path), `.lcu-setup-${randomBytes(6).toString('hex')}`);
  try {
    const fd = openSync(temporary, 'wx', mode);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const same = (left, right) => (left === null || right === null ? left === right : Buffer.compare(left, right) === 0);

/** One planned file change; `after` null removes the file. */
export const change = (path, before, after) => ({ path, before, after: typeof after === 'string' ? Buffer.from(after) : after });
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** JSON settings bytes as earlier releases read them: an empty file is `{}` and a UTF-8 byte order mark is ignored. */
export const parseJson = (data) => (data?.length ? JSON.parse(data.toString('utf8').replace(/^\uFEFF/, '')) : {});

/** `object[key]`, set to `fallback` when absent; a present value that is not an object (or array) is refused. */
export function member(object, key, fallback, message) {
  if (!Object.hasOwn(object, key)) object[key] = fallback;
  const value = object[key];
  const valid = Array.isArray(fallback) ? Array.isArray(value) : value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!valid) throw new Error(message);
  return value;
}

/**
 * Compact JSON with `, ` and `: ` separators and non-ASCII escaped: the form of the record keys, package
 * identities and hook trust keys earlier releases stored, so existing records keep matching.
 */
export const spacedJson = (value) => (Array.isArray(value) ? `[${value.map(spacedJson).join(', ')}]`
  : value !== null && typeof value === 'object' ? `{${Object.entries(value).map(([key, item]) => `${spacedJson(key)}: ${spacedJson(item)}`).join(', ')}}`
    : JSON.stringify(value).replace(/[\u0080-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));

/** Apply changes after a preflight; roll back our own writes if a later write fails. Returns how many changed. */
export function applyChanges(changes) {
  changes = changes.filter((item) => !same(item.before, item.after));
  for (const item of changes) {
    if (!same(readFile(item.path), item.before)) throw new Error(`File changed during setup; retry: ${item.path}`);
  }
  const applied = [];
  try {
    for (const item of changes) {
      if (!same(readFile(item.path), item.before)) throw new Error(`File changed during setup; retry: ${item.path}`);
      atomicWrite(item.path, item.after);
      applied.push(item);
    }
  } catch (error) {
    // Never undo a concurrent editor's changes.
    for (const item of applied.reverse()) if (same(readFile(item.path), item.after)) atomicWrite(item.path, item.before);
    throw error;
  }
  return changes.length;
}

// Saved choices ----------------------------------------------------------------------------------------

export const stateDirectory = (home) => (windows() ? join(home, 'AppData/Local/LCU') : join(home, '.local/state/lcu'));

/** Run `fn` holding the account's setup lock. */
export function setupLock(home, fn) {
  const path = regularPath(join(stateDirectory(home), 'setup.lock'));
  mkdirSync(dirname(path), { recursive: true });
  return withLock(path, fn);
}

/** Per-account opt-in memory, beside setup.lock. */
export const setupStatePath = (home) => regularPath(join(stateDirectory(home), 'setup.json'));

/** Saved opt-ins and pending harnesses; a missing file is the default, a malformed one an error. */
export function loadSetupState(home) {
  const path = setupStatePath(home);
  const data = readFile(path);
  if (data === null) return { chrome: false, audio: false, approval: 'ask', pending: [], pending_context: null };
  const malformed = () => new Error(`Malformed LCU setup state at ${path}; delete it and rerun setup.`);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    throw malformed();
  }
  // `approval` and `pending` were added after `chrome` and `audio`; an older file means "ask" and none pending.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw malformed();
  const pending = Object.hasOwn(parsed, 'pending') ? parsed.pending : [];
  const context = parsed.pending_context ?? null;
  const validContext = context === null || (typeof context === 'object' && !Array.isArray(context) &&
    ['user', 'project'].includes(context.scope) && ['discover', 'direct'].includes(context.session) &&
    (context.project === null || context.project === undefined || typeof context.project === 'string'));
  if (typeof parsed.chrome !== 'boolean' || typeof parsed.audio !== 'boolean' || !['ask', 'auto'].includes(parsed.approval ?? 'ask') ||
      !Array.isArray(pending) || !pending.every((item) => NEEDS_BINARY.includes(item)) || !validContext) throw malformed();
  return { chrome: parsed.chrome, audio: parsed.audio, approval: parsed.approval ?? 'ask', pending: [...new Set(pending)],
    pending_context: pending.length ? context : null };
}

export function saveSetupState(home, { chrome, audio, approval = 'ask', pending = [], pendingContext = null }) {
  pending = [...new Set(pending)];
  const document = { chrome, audio, approval };
  // Absent when nothing is pending, so the file stays readable by earlier LCU versions.
  if (pending.length) Object.assign(document, { pending, pending_context: pendingContext });
  atomicWrite(setupStatePath(home), Buffer.from(json(document)));
}

/** PATH plus the user-level directories harness installers use, for a harness installed after login. */
function harnessSearchPath(home, path = process.env.PATH ?? '') {
  const extra = ['.local/bin', '.bun/bin', '.npm-global/bin', '.cargo/bin'].map((name) => join(home, name));
  return [...new Set([...path.split(delimiter).filter(Boolean), ...extra])].join(delimiter);
}

export const harnessInstalled = (name, home, path) => Boolean(seams.which(CLIENTS[name].executable, harnessSearchPath(home, path)));

// Installers ---------------------------------------------------------------------------------------------

/** The installers' environment: a real account home; only profile overrides understood upstream are honored. */
export function installerEnvironment(home, names, environ = process.env) {
  const env = { ...environ };
  const rejected = { 'claude-code': ['CLAUDE_CONFIG_DIR'], 'gemini-cli': ['GEMINI_CLI_HOME'],
    opencode: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'], 'copilot-cli': ['COPILOT_HOME'] };
  for (const name of names) {
    for (const variable of rejected[name] ?? []) {
      if (env[variable]) throw new Error(`${variable} is not supported by the bundled installers for ${name}; unset it or use --export.`);
    }
  }
  const supported = [];
  if (names.includes('codex')) supported.push('CODEX_HOME');
  if (names.includes('hermes')) supported.push('HERMES_HOME');
  if (names.includes('omp')) supported.push('PI_CODING_AGENT_DIR');
  if (['opencode', 'vscode', 'copilot-cli'].some((name) => names.includes(name))) supported.push('XDG_CONFIG_HOME');
  for (const variable of supported) {
    if (env[variable] && !isAbsolute(env[variable])) throw new Error(`${variable} must be absolute.`);
  }
  if (names.includes('copilot-cli') && env.XDG_CONFIG_HOME) {
    throw new Error('XDG_CONFIG_HOME is not supported for Copilot CLI by the bundled installers; unset it or use --export.');
  }
  Object.assign(env, { HOME: String(home), DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', NO_COLOR: '1', CI: '1' });
  // Node flags can inject code; setup uses only the packaged runtime and CLIs.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
}

/** `[node, skills, mcp]`: the bundled agent installers of a release. */
async function installerPaths(toolsRoot) {
  const node = windows() ? join((await import('./runtime.mjs')).paths(dirname(toolsRoot)).runtime, 'bin/node.exe')
    : join(toolsRoot, 'node/bin/node');
  const paths = [node, join(toolsRoot, 'node_modules/skills/bin/cli.mjs'), join(toolsRoot, 'node_modules/add-mcp/dist/index.js')];
  for (const path of paths) {
    if (!isFile(path)) throw new Error(`Bundled agent installer missing: ${path}. Rerun scripts/install.sh with this --prefix.`);
  }
  try {
    accessSync(node, constants.X_OK);
  } catch {
    throw new Error(`Bundled Node runtime is not executable: ${node}`);
  }
  return paths;
}

// add-mcp 2.4.0 accepts malformed JSONC without checking parse errors. Keep this read-only guard until upstream
// fails closed. Paths and formats still come from its public adapter metadata; all configuration writes remain
// upstream-owned.
const MCP_PREFLIGHT = String.raw`
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
try {
  const [cli, name, scope] = process.argv.slice(1);
  const require = createRequire(pathToFileURL(cli));
  const { agents } = await import(pathToFileURL(join(dirname(cli), 'lib.js')));
  const agent = agents[name];
  const local = scope === 'project';
  const cwd = process.cwd();
  const path = agent.resolveConfigPath ? agent.resolveConfigPath(agent, { local, cwd })
    : local ? join(cwd, agent.localConfigPath) : agent.configPath;
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') process.exit(0); throw error; }
  let data;
  if (agent.format === 'toml') data = require('@iarna/toml').parse(text);
  else if (agent.format === 'json') {
    const jsonc = require('jsonc-parser');
    const errors = [];
    const tree = jsonc.parseTree(text, errors, { allowTrailingComma: true });
    if (errors.length) throw new Error(${'`'}Malformed configuration: ${'${path}'}${'`'});
    function checkDuplicates(node) {
      if (!node) return;
      if (node.type === 'object') {
        const keys = new Set();
        for (const property of node.children || []) {
          const key = property.children[0].value;
          if (keys.has(key)) throw new Error(${'`'}Duplicate configuration key in ${'${path}'}: ${'${key}'}${'`'});
          keys.add(key);
        }
      }
      for (const child of node.children || []) checkDuplicates(child);
    }
    checkDuplicates(tree);
    data = jsonc.getNodeValue(tree);
  } else throw new Error(${'`'}Unsupported configuration format: ${'${agent.format}'}${'`'});
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(data)) throw new Error(${'`'}Configuration must be an object: ${'${path}'}${'`'});
  const key = local && agent.localConfigKey ? agent.localConfigKey : agent.configKey;
  let current = data;
  for (const part of key.split('.')) {
    if (!Object.hasOwn(current, part)) break;
    current = current[part];
    if (!object(current)) throw new Error(${'`'}MCP configuration must be an object: ${'${path}'}${'`'});
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
`;

function preflightMcp(node, mcp, client, scope, cwd, env) {
  const result = seams.run(node, ['--input-type=module', '-e', MCP_PREFLIGHT, mcp, client.mcpAgent, scope], { cwd, env, timeout: 20_000 });
  if (result.error) throw new Error(`MCP configuration preflight could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'MCP configuration preflight failed');
}

const MCP_REGISTER = String.raw`
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [cli, agent, scope, commandJson, policyJson] = process.argv.slice(1);
const { agents, upsertServer } = await import(pathToFileURL(join(dirname(cli), 'lib.js')));
if (agent === 'codex') {
  const transform = agents.codex.transformConfig;
  const policy = JSON.parse(policyJson);
  agents.codex.transformConfig = (...args) => ({ ...transform(...args), ...policy });
}
const [command, ...args] = JSON.parse(commandJson);
const result = upsertServer(agent, 'lcu', { command, args }, { local: scope === 'project', cwd: process.cwd() });
if (!result.success) throw new Error(result.error);
console.log(JSON.stringify(result));
`;

/** The original MCP host contract shipped with the app, without the launch fields LCU supplies itself. */
export async function hostPolicy(releaseRoot) {
  const resources = await installedAppResources(releaseRoot);
  const descriptor = join(resources, 'plugins/openai-bundled/plugins/unified-computer-use/.mcp.json');
  const { command, args, enabled, ...policy } = JSON.parse(readFileSync(descriptor, 'utf8')).mcpServers.cua_repl;
  return policy;
}

/** The selected app's resource directory, without depending on release payload copies. */
export async function installedAppResources(releaseRoot) {
  releaseRoot = realpath(resolve(releaseRoot));
  if (windows()) return (await import('./runtime.mjs')).paths(releaseRoot).resources;
  const descriptor = join(releaseRoot, 'installation.json');
  if (!isFile(descriptor)) throw new Error(`Installed application descriptor missing: ${descriptor}`);
  let installation;
  try {
    installation = JSON.parse(readFileSync(descriptor, 'utf8'));
  } catch {
    throw new Error(`Invalid installed application descriptor: ${descriptor}`);
  }
  const reference = installation?.app;
  if (typeof reference !== 'string' || !reference) throw new Error(`Installed application descriptor has no app reference: ${descriptor}`);
  let described;
  let selected;
  try {
    described = realpathStrict(resolve(releaseRoot, reference));
    selected = realpathStrict(join(releaseRoot, 'app'));
  } catch {
    throw new Error(`Installed application path is incomplete: ${releaseRoot}`);
  }
  if (described !== selected) throw new Error(`Installed application descriptor does not match selected app: ${descriptor}`);
  const target = installation.platform ?? 'linux';
  if (!['linux', 'darwin'].includes(target)) throw new Error(`Unsupported installed application platform: ${target}`);
  const resources = join(selected, target === 'darwin' ? 'Contents/Resources' : 'resources');
  if (!existsSync(resources) || !statSync(resources).isDirectory()) throw new Error(`Installed application resources missing: ${resources}`);
  return resources;
}
const realpathStrict = (path) => realpathSync(path);
const realpath = (path) => { try { return realpathStrict(path); } catch { return path; } };

/** Delete the skill earlier LCU versions generated; official Codex computer use registers none. */
export function removeGeneratedSkill(home) {
  const root = windows() ? join(home, 'AppData/Local/LCU/skills') : join(home, '.local/share/lcu/skills');
  const generated = join(regularPath(root), 'lcu');
  const info = lstat(generated);
  if (info?.isDirectory() && !info.isSymbolicLink()) {
    rmSync(generated, { recursive: true, force: true });
    try {
      rmdirSync(root);
    } catch {
      // other skills remain
    }
  }
}

// Descriptions used by the `lcu` skill that LCU 0.6.0 and earlier registered.
const OLD_SKILL_MARKERS = ['original Codex computer-use runtime', 'LCU MCP computer-use tools'];

/**
 * Remove the `lcu` skill registered by LCU 0.6.0 and earlier, and nothing else. The skill installer keeps a
 * shared `.agents/skills` copy while any other detected agent could use it, so remove it for every agent, but
 * only after confirming the installed skill is LCU's own. Returns `none`, `kept` or `removed`.
 */
export function removeOldSkill(node, skills, cwd, env, globalArgs) {
  const installer = (...args) => checked('skill installer', node, [skills, ...args, ...globalArgs], { cwd, env, timeout: 120_000 });
  const result = installer('list', '--json');
  let installed;
  try {
    installed = JSON.parse(result.stdout || '[]');
  } catch {
    installed = undefined;
  }
  if (!Array.isArray(installed)) {
    const tail = (result.stderr ?? '').trim().slice(-500);
    throw new Error(`skill installer returned invalid JSON (${Buffer.byteLength(result.stdout ?? '')} bytes)${tail ? `: ${tail}` : ''}`);
  }
  const entry = installed.find((item) => item && typeof item === 'object' && item.name === 'lcu');
  if (!entry) return 'none';
  const skill = join(String(entry.path ?? ''), 'SKILL.md');
  let text = '';
  try {
    if (statSync(skill).isFile()) text = readFileSync(skill, 'utf8');
  } catch {
    // no readable skill file
  }
  const frontmatter = text.startsWith('---') && text.split('---').length >= 3 ? text.split('---')[1] : '';
  const fields = Object.fromEntries(frontmatter.split(/\r?\n/).filter((line) => line.includes(':'))
    .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]));
  if ((fields.name ?? '').trim() !== 'lcu' || !OLD_SKILL_MARKERS.some((marker) => (fields.description ?? '').includes(marker))) return 'kept';
  installer('remove', 'lcu', '--yes');
  return 'removed';
}

/** The message for a failed step: expected failures carry their own message; programming errors name their type. */
const describe = (error) => ([TypeError, ReferenceError, RangeError, SyntaxError].some((type) => error instanceof type)
  ? `${error.name}: ${error.message}` : error?.message ?? String(error));

/**
 * Delegate registration and return the failed steps as `[name, phase, message]`. `approval` is null (leave
 * harness approval settings alone), `auto` or `ask` (see approval.mjs).
 */
export async function configure(names, home, command, toolsRoot, releaseRoot,
  { scope = 'user', project = null, setupCommand = null, environ, approval = null } = {}) {
  const env = installerEnvironment(home, names, environ);
  const [node, skills, mcp] = await installerPaths(toolsRoot);
  const resources = await installedAppResources(releaseRoot);
  const originalPlugins = join(resources, 'plugins/openai-bundled');
  const cwd = scope === 'project' ? project : home;
  const globalArgs = scope === 'user' ? ['--global'] : [];
  const projectScope = scope === 'project' ? project : null;
  const failures = [];
  const fail = (name, phase, error) => {
    failures.push([name, phase, describe(error)]);
    warn(`${CLIENTS[name].label}: ${phase} failed: ${describe(error)}`);
  };
  const applyApproval = (name, plan) => {
    if (approval === null) return;
    try {
      say(`${CLIENTS[name].label}: approval ${approval}: ${approvals.apply(approval, name, home, { scope, project, env, plan })}.`);
    } catch (error) {
      fail(name, 'approval', error);
    }
  };

  for (const name of names) {
    const client = CLIENTS[name];
    if (name === 'omp' || name === 'hermes') {
      try {
        if (name === 'omp') configureOmp(home, command, releaseRoot, { scope, project, env });
        else configureHermes(home, command, node, releaseRoot, { scope, project, env });
        say(`${client.label}: plugin registered.`);
      } catch (error) {
        fail(name, 'plugin', error);
        continue;
      }
      applyApproval(name);
      continue;
    }
    let mcpCommand = command;
    let mcpSetupError = null;
    let codexPlan = null;
    if (name === 'claude-code') {
      const adapter = join(releaseRoot, 'adapters/claude.mjs');
      if (!existsSync(adapter)) mcpSetupError = `Claude MCP relay missing: ${adapter}. Reinstall LCU into this release prefix, then rerun setup.`;
      else mcpCommand = [node, adapter, ...command];
    }
    if (name === 'codex') {
      const adapter = join(releaseRoot, 'adapters/codex.mjs');
      const audioHelper = join(releaseRoot, 'adapters/audio-files.mjs');
      if (!existsSync(adapter) || !existsSync(audioHelper)) {
        mcpSetupError = `Codex audio relay missing: ${adapter} or ${audioHelper}. Reinstall LCU into this release prefix, then rerun setup.`;
      } else mcpCommand = [node, adapter, ...command];
      try {
        requireCliHookSupport(env);
        // Registration replaces `[mcp_servers.lcu]`; read the previous approval value first.
        codexPlan = approvals.codexPlan(approval, home, { scope, project, env });
      } catch (error) {
        fail(name, 'host', error);
        continue;
      }
    }
    // Earlier LCU versions registered an `lcu` skill; official Codex computer use has none, so remove it.
    // Best-effort legacy cleanup: a failure here must not fail setup.
    try {
      const outcome = removeOldSkill(node, skills, cwd, env, globalArgs);
      if (outcome === 'removed') say(`${client.label}: old LCU skill removed.`);
      else if (outcome === 'kept') say(`${client.label}: kept an \`lcu\` skill that LCU did not create.`);
    } catch (error) {
      warn(`${client.label}: skipped old LCU skill cleanup: ${describe(error)}`);
    }
    const phase = name === 'pi' ? 'extension' : 'MCP';
    try {
      let result;
      if (name === 'pi') {
        result = registerPi(home, command, releaseRoot, { scope, project, env, cwd, setupCommand });
      } else {
        if (mcpSetupError) throw new Error(mcpSetupError);
        preflightMcp(node, mcp, client, scope, cwd, env);
        const policy = approvals.mergeCodexPolicy(await hostPolicy(releaseRoot), codexPlan?.policy ?? {});
        result = checked('installer', node, ['--input-type=module', '-e', MCP_REGISTER, mcp, client.mcpAgent, scope,
          JSON.stringify(mcpCommand), JSON.stringify(policy)], { cwd, env, timeout: 120_000 });
      }
      if (name === 'codex') {
        let registered;
        try {
          registered = JSON.parse(result.stdout);
        } catch {
          registered = null;
        }
        if (!registered || typeof registered !== 'object' || Array.isArray(registered) || typeof registered.path !== 'string') {
          const detail = (result.stdout || result.stderr || '').trim();
          throw new Error(`Codex registration returned unexpected output${detail ? `: ${detail}` : ''}`);
        }
        const cli = locateCodexTools(resources, { windows: windows() }).cli;
        await installHooks(cli, registered.path, cwd, env, originalPlugins, setupCommand);
      } else if (name === 'claude-code') {
        hideHostOnlyTools(home, { project: projectScope });
        say(`${client.label}: approval mod installed at ${installApprovalMod(home, releaseRoot, { project: projectScope })}.`);
      }
      say(`${client.label}: ${phase} registered.`);
      applyApproval(name, codexPlan);
    } catch (error) {
      fail(name, phase, error);
    }
  }
  return failures;
}

/** Pi loads LCU as a local extension that selects the registered command per project. */
function registerPi(home, command, releaseRoot, { scope, project, env, cwd, setupCommand }) {
  const pi = seams.which('pi', env.PATH);
  if (!pi) {
    throw new Error('Pi is not on the target account PATH. Install Pi, then run ' +
      `\`${setupCommand || 'lcu'} setup --agent pi --yes\` from that account shell.`);
  }
  const adapter = join(releaseRoot, 'adapters/pi/index.ts');
  if (!existsSync(adapter)) throw new Error(`LCU Pi adapter missing: ${adapter}`);
  const root = windows() ? join(home, 'AppData/Local/LCU/pi') : join(home, '.local/share/lcu/pi');
  const extension = join(root, 'extension.mjs');
  const selectedCommand = join(root, 'commands.json');
  const wrapper = `import lcu from ${JSON.stringify(pathToFileURL(adapter).href)};\n` +
    'import {readFileSync, realpathSync} from "node:fs";\n' +
    `const config = JSON.parse(readFileSync(${JSON.stringify(selectedCommand)}, "utf8"));\n` +
    'export default pi => lcu(pi, {command: config.projects?.[realpathSync(process.cwd())] ?? config.user});\n';
  const previous = readFile(selectedCommand);
  const config = previous?.length ? parseJson(previous) : { projects: {} };
  if (!config || typeof config !== 'object' || Array.isArray(config) || !config.projects || typeof config.projects !== 'object' || Array.isArray(config.projects)) {
    throw new Error(`Invalid LCU Pi command configuration: ${selectedCommand}`);
  }
  if (scope === 'user') config.user = command;
  else config.projects[realpathStrict(project)] = command;
  applyChanges([change(extension, readFile(extension), wrapper), change(selectedCommand, previous, json(config))]);
  return checked('installer', pi, ['install', ...(scope === 'user' ? [] : ['-l']), extension],
    { cwd, env: { ...env, PI_OFFLINE: '1' }, timeout: 120_000 });
}

/** Write a portable plugin for custom clients to a new directory. */
export async function exportBundle(destination, command, releaseRoot, { chrome = false, audio = false, codexFiles = exportFiles } = {}) {
  destination = regularPath(destination);
  if (existsSync(destination)) throw new Error('Export destination already exists; choose a new directory.');
  const policy = await hostPolicy(releaseRoot);
  // Re-run flags for the destinationSetup metadata.
  const setupFlags = (chrome ? '--chrome ' : '') + (audio ? '--audio ' : '');
  const installation = JSON.parse(readFileSync(join(releaseRoot, 'installation.json'), 'utf8'));
  const resourceRoot = (installation.platform ?? 'linux') === 'darwin' ? 'Contents/Resources' : 'resources';
  const manifest = { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'lcu',
    description: 'Computer use through the locally installed Codex runtime.' };
  // A cross-machine export cannot retain the producer's prefix or account. Resolve the destination's selected
  // release when its MCP client starts.
  const platformDefaults = 'set -eu; case "$(uname -s)" in ' +
    'Darwin) default_prefix="$HOME/.local/share/lcu"; default_session=direct;; ' +
    'Linux) default_prefix=/opt/lcu; default_session=discover;; ' +
    '*) echo "Unsupported LCU platform" >&2; exit 2;; esac; ' +
    'prefix=${LCU_PREFIX:-$default_prefix}; ' +
    'case "$prefix" in /*) ;; *) echo "LCU_PREFIX must be absolute" >&2; exit 2;; esac; ';
  const sessions = (direct) => 'case "${LCU_SESSION_MODE:-$default_session}" in ' +
    `direct) exec ${direct} "$@";; ` +
    `discover) exec "$prefix/current/bin/lcu-session" --user "$(id -un)" -- ${direct} "$@";; ` +
    '*) echo "LCU_SESSION_MODE must be discover or direct" >&2; exit 2;; esac';
  const launch = platformDefaults + sessions('"$prefix/current/bin/lcu"');
  const codexLaunch = `${platformDefaults}node="$prefix/current/agent-tools/node/bin/node"; ` +
    'adapter="$prefix/current/adapters/codex.mjs"; server="$prefix/current/bin/lcu"; ' + sessions('"$node" "$adapter" "$server"');
  const runtimeFlags = [...(chrome ? ['--chrome'] : []), ...(audio ? ['--audio'] : [])];
  const portable = ['/bin/sh', '-c', launch, 'lcu-export', ...runtimeFlags];
  const portableCodex = ['/bin/sh', '-c', codexLaunch, 'lcu-export', ...runtimeFlags];
  const bootstrap = {
    requiresInstalledApplication: true,
    computerAudioOptIn: audio
      ? 'Enabled in the registered MCP command with --audio. The original optional recording API may require its own approval. A saved audio file does not mean the selected model receives audio. LCU does not add audio-specific instructions.'
      : 'Disabled unless the caller explicitly sets both original audio environment flags.',
    applicationResourceRoot: resourceRoot,
    destinationSetup: 'Install the matching thin LCU archive and selected application, then run ' +
      `lcu setup --export /new/path ${setupFlags}--yes on the destination account and import that newly generated export.`,
    runtimePrefix: 'Set LCU_PREFIX for a nondefault destination prefix: /opt/lcu on Linux, $HOME/.local/share/lcu on macOS.',
    sessionMode: 'Linux defaults to XFCE discovery; set LCU_SESSION_MODE=direct inside its desktop session. macOS defaults to direct.',
    instructions: 'The original MCP server instructions, tool descriptions and tool results, as in official Codex; no skill.',
  };
  const resources = await installedAppResources(releaseRoot);
  const changes = [
    change(join(destination, 'plugin.json'), null, json(manifest)),
    change(join(destination, 'mcp.json'), null, json({ mcpServers: { lcu: { type: 'stdio', command: portable[0], args: portable.slice(1) } } })),
    change(join(destination, 'host-contract.json'), null, json(policy)),
    change(join(destination, 'lcu-bootstrap.json'), null, json(bootstrap)),
    change(join(destination, 'codex.mcp.json'), null, json({ mcpServers: { lcu: { ...policy, command: portableCodex[0], args: portableCodex.slice(1) } } })),
    ...Object.entries(codexFiles(portableCodex, join(resources, 'plugins/openai-bundled')))
      .map(([name, data]) => change(join(destination, name), null, data)),
  ];
  applyChanges(changes);
}

// Command line -------------------------------------------------------------------------------------------

const defaultPrefix = () => (windows() ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'LCU')
  : process.platform === 'darwin' ? join(accountHome(), '.local/share/lcu') : '/opt/lcu');
const defaultSession = () => (process.platform === 'darwin' || windows() ? 'direct' : 'discover');

export const OPTIONS = {
  prefix: { type: 'string' },
  user: { type: 'string' },
  agent: { type: 'string', multiple: true, default: [] },
  scope: { type: 'string', default: 'user' },
  project: { type: 'string' },
  yes: { type: 'boolean', default: false },
  'list-agents': { type: 'boolean', default: false },
  export: { type: 'string' },
  chrome: { type: 'boolean', default: false },
  'no-chrome': { type: 'boolean', default: false },
  audio: { type: 'boolean', default: false },
  'no-audio': { type: 'boolean', default: false },
  approval: { type: 'string' },
  session: { type: 'string' },
  'allow-missing': { type: 'boolean', default: false },
  reconcile: { type: 'boolean', default: false },
  'cross-turn': { type: 'string' },
  unattended: { type: 'boolean', default: false },
  'browser-host': { type: 'boolean', default: false },
  'check-desktop': { type: 'boolean', default: false },
  'validate-only': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};
const CHOICES = { scope: ['user', 'project'], approval: ['ask', 'auto'], session: ['discover', 'direct'], 'cross-turn': ['on', 'off'] };

export const USAGE = 'Usage: lcu setup [--agent ID ...] [--scope user|project] [--project PATH] [--yes] [--chrome | --no-chrome]\n' +
  '                 [--audio | --no-audio] [--approval ask|auto] [--session discover|direct] [--allow-missing]\n' +
  '                 [--cross-turn on|off [--unattended]] [--reconcile] [--check-desktop] [--export PATH] [--list-agents] [--user ACCOUNT] [--prefix PATH]';
const HELP = `${USAGE}

Configure LCU tools, without requiring a running desktop.

Options:
  --agent ID          Agent ID; repeat for several, all for every supported client, or auto for detected
                      clients. Use --list-agents.
  --scope user|project
  --project PATH      Absolute existing project directory for project scope
  --yes               Apply explicit choices without a confirmation prompt
  --list-agents       List supported adapters and exit
  --export PATH       Export a portable tools plugin for custom clients to a new directory
  --chrome            Opt into original Chrome control, extension connector, and browser guidance
  --no-chrome         Disable Chrome control, overriding a saved opt-in
  --audio             Opt into the original optional computer-audio recording API
  --no-audio          Disable computer-audio recording, overriding a saved opt-in
  --approval ask|auto Optional, for unattended machines: auto adds only LCU's own harness approval entries so its
                      tools run without a per-call prompt (per-app approval stays); ask removes exactly those
                      entries and leaves harness defaults (the default, kept from the previous setup)
  --session discover|direct
                      discover attaches through lcu-session (XFCE); direct uses the current desktop account
  --cross-turn on|off Keep Computer Use available across turns, including turns started by background events
                      (macOS and Windows per-app approvals still apply). on asks the owner to authenticate on macOS. Without it,
                      interactive setup asks once; --yes leaves the setting unchanged. Same as \`lcu cross-turn\`
  --unattended        With --cross-turn on: skip the owner prompt; for disposable sandbox machines only
  --allow-missing     Skip pi, omp and hermes when their executable is not installed yet and record them as
                      pending (Codex and Claude Code still register); exit 0 when that is the only problem.
                      \`lcu setup --reconcile\` registers them once they appear
  --reconcile         Register pending harnesses that are now installed, using the saved opt-ins and approval
                      mode; non-interactive, idempotent, and silent when there is nothing to do
  --check-desktop     Require live desktop readiness after setup; never opens System Settings automatically
  --user ACCOUNT      Target account (its user-database home); root must select one. Default: this account, in $HOME when usable
  --prefix PATH       Runtime prefix (Linux: /opt/lcu; macOS: ~/.local/share/lcu; Windows: %LOCALAPPDATA%\\LCU)

Run on the machine hosting the agent backend. For Codex SSH remote projects, that is the VM. This command never
installs or authenticates the agent itself.
`;

/** A command-line mistake: exit status 2. */
export class UsageError extends Error {}

/** Parse `lcu setup` arguments (`options` adds the installer's own). */
export function parse(argv, options = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { ...OPTIONS, ...options }, strict: true, allowPositionals: false }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  for (const [key, choices] of Object.entries(CHOICES)) {
    if (values[key] !== undefined && !choices.includes(values[key])) {
      throw new UsageError(`Unknown --${key} value '${values[key]}'; use ${choices.join(' or ')}.`);
    }
  }
  values.prefix ??= defaultPrefix();
  values.session ??= defaultSession();
  return values;
}

/** Check the parsed arguments; returns `{account, names}`. */
export function validate(args) {
  if (args['browser-host']) {
    throw new Error('--browser-host was removed; use `lcu setup --agent AGENT --chrome` for external Chrome. Embedded in-app browser hosting is not supported.');
  }
  if (args.reconcile) {
    const used = [['--agent', args.agent.length], ['--export', args.export], ['--approval', args.approval], ['--chrome', args.chrome],
      ['--no-chrome', args['no-chrome']], ['--audio', args.audio], ['--no-audio', args['no-audio']], ['--project', args.project],
      ['--check-desktop', args['check-desktop']], ['--allow-missing', args['allow-missing']], ['--cross-turn', args['cross-turn']], ['--unattended', args.unattended], ['--scope', args.scope !== 'user']]
      .filter(([, value]) => value).map(([flag]) => flag);
    if (used.length) throw new Error(`--reconcile uses the saved setup and cannot be combined with ${used.join(', ')}.`);
  }
  if (args['allow-missing'] && args.export) throw new Error('--allow-missing configures a harness; it cannot be combined with --export.');
  if (args.unattended && args['cross-turn'] !== 'on') throw new Error('--unattended only applies together with --cross-turn on.');
  if (args['cross-turn'] && args.export) throw new Error('--cross-turn configures this account; it cannot be combined with --export.');
  if (args.chrome && args['no-chrome']) throw new Error('Use either --chrome or --no-chrome, not both.');
  if (args.audio && args['no-audio']) throw new Error('Use either --audio or --no-audio, not both.');
  const prefix = args.prefix;
  const parts = normalize(prefix).split(/[\\/]/).filter(Boolean);
  if (!isAbsolute(prefix) || parts.length < (windows() ? 3 : 2) || prefix.split(/[\\/]/).includes('..') || /[\x00-\x1f]/.test(prefix)) {
    throw new Error('Use a dedicated absolute prefix, such as /opt/lcu.');
  }
  let account;
  if (windows()) {
    account = seams.account();
    if (args.user && args.user.toLowerCase() !== account.name.toLowerCase()) throw new Error('Windows setup only configures the current signed-in account.');
    if (args.session !== 'direct') throw new Error('Windows requires --session direct.');
    if (args.export) throw new Error('Windows portable export is not implemented; select --agent instead.');
  } else {
    if (process.getuid() === 0 && args.user === undefined) throw new Error('Root must specify --user ACCOUNT.');
    account = seams.account(args.user);
    if (!account) throw new Error('The selected account does not exist. Create it before setup.');
    if (![0, account.uid].includes(process.getuid())) throw new Error('Run as the selected account or root.');
  }
  if (!isAbsolute(account.home ?? '') || !existsSync(account.home) || !statSync(account.home).isDirectory()) {
    throw new Error('Selected account must have an existing absolute home directory.');
  }
  if (args.scope === 'project') {
    if (!args.project || !isAbsolute(args.project) || !existsSync(args.project) || !statSync(args.project).isDirectory()) {
      throw new Error('--scope project requires --project with an existing absolute directory.');
    }
  } else if (args.project) throw new Error('--project requires --scope project.');
  if (args.export && args.agent.length) throw new Error('Choose --export or --agent, not both.');
  if (args.export && args.approval) throw new Error('--approval configures a harness; it cannot be combined with --export.');
  if (args.export) {
    if (!isAbsolute(args.export)) throw new Error('--export requires an absolute path.');
    regularPath(args.export);
    if (existsSync(args.export)) throw new Error('Export destination already exists; choose a new directory.');
  }
  let names = [...new Set(args.agent.map((name) => ALIASES[name] ?? name))];
  const unknown = names.filter((name) => !CLIENTS[name] && name !== 'auto' && name !== 'all').sort();
  if (unknown.length) {
    throw new Error(`Unknown agent: ${unknown.join(', ')}. Run lcu setup --list-agents, or use --export for a custom client.`);
  }
  if ((names.includes('auto') || names.includes('all')) && names.length > 1) {
    throw new Error('Use --agent all or --agent auto alone, or select explicit agent IDs.');
  }
  if (names.length === 1 && names[0] === 'all') names = Object.keys(CLIENTS);
  if (!(names.length === 1 && names[0] === 'auto')) validateAgentScope(names, args.scope);
  return { account, names };
}

const agentScopes = (name) => (USER_ONLY_AGENTS.includes(name) ? 'user' : 'user, project');

function validateAgentScope(names, scope) {
  if (scope === 'project' && names.some((name) => USER_ONLY_AGENTS.includes(name))) {
    throw new Error('Oh My Pi and Hermes native plugins are profile-scoped. Use --scope user with the intended profile; project scope is not supported.');
  }
}

export const detect = (home) => Object.entries(CLIENTS)
  .filter(([, client]) => seams.which(client.executable) || existsSync(join(home, client.detectPath))).map(([name]) => name);

async function chooseAgents(home) {
  const detected = detect(home);
  say('Select one or more agents for this account (comma-separated IDs).');
  for (const [name, client] of Object.entries(CLIENTS)) say(`  ${name.padEnd(16)} ${client.label}${detected.includes(name) ? ' [detected]' : ''}`);
  say('Use all for every supported client, including those not installed yet.',
    'For other clients, cancel and use --export /absolute/new/plugin-directory.');
  let names = [...new Set((await seams.ask('Agents: ')).trim().split(',').map((name) => name.trim()).filter(Boolean)
    .map((name) => ALIASES[name] ?? name))];
  if (names.length === 1 && names[0] === 'all') return Object.keys(CLIENTS);
  if (names.length === 1 && names[0] === 'auto') names = detected;
  if (!names.length || names.some((name) => !CLIENTS[name])) throw new Error('Choose supported agent IDs, or use --export for a custom client.');
  return names;
}

/** `{mode, command, timeout}` of the desktop check after registration; the timeout is in milliseconds. */
export function desktopReadinessRequest(args, { interactive, desktopCommand }) {
  const mode = args['check-desktop'] ? 'required' : args.export ? 'skip' : args.yes || !interactive ? 'deferred' : 'guided';
  if (mode === 'skip') return { mode, command: null, timeout: null };
  const doctor = [...desktopCommand, 'doctor'];
  if (mode === 'required') return { mode, command: [...doctor, '--non-interactive', '--require-ready'], timeout: 50_000 };
  // Guided and deferred both run the plain doctor without a bounded timeout; a person may need as long as they
  // like to read settings guidance.
  return { mode, command: doctor, timeout: null };
}

/** Run a doctor command on this terminal; `{status, interrupted, error}`. An interrupt stops only the doctor. */
function runDesktopDoctor(command, timeout) {
  command = startable(command);
  const ignore = () => {};
  process.on('SIGINT', ignore);
  try {
    const result = seams.spawn(command[0], command.slice(1), timeout ? { timeout } : {});
    return { status: result.status, interrupted: result.signal === 'SIGINT', error: result.error };
  } finally {
    process.off('SIGINT', ignore);
  }
}

/**
 * `{releaseRoot, runtime, launcher, desktopCommand, directRuntime}` for the selected session mode. Registrations
 * name stable launchers: on Windows `<prefix>\lcu.cmd`, which the installer rewrites to run the selected app's
 * Node, since that Node lives in a private app generation `lcu prune` may remove. `directRuntime` is how setup
 * itself runs LCU: Node does not start a .cmd file without a shell, so on Windows it runs the launcher on the
 * current Node.
 */
export function runtimePaths(args, account, session = args.session) {
  if (windows()) {
    const runtime = join(args.prefix, 'lcu.cmd');
    const launcher = join(args.prefix, 'windows_launcher.mjs');
    return { releaseRoot: dirname(HERE), runtime, launcher, desktopCommand: [runtime], directRuntime: [process.execPath, launcher] };
  }
  const releaseRoot = join(args.prefix, 'current');
  const runtime = join(releaseRoot, 'bin/lcu');
  const launcher = join(releaseRoot, 'bin/lcu-session');
  return { releaseRoot, runtime, launcher, directRuntime: [runtime],
    desktopCommand: session === 'direct' ? [runtime] : [launcher, '--user', account.name, '--', runtime] };
}

/** A command setup can start itself: the Windows `lcu.cmd` launcher becomes the current Node on its script. */
const startable = (command) => (windows() && /\.cmd$/i.test(command[0])
  ? [process.execPath, join(dirname(command[0]), 'windows_launcher.mjs'), ...command.slice(1)] : command);

function requireLaunchers(...paths) {
  for (const path of paths) {
    let usable = false;
    try {
      accessSync(path, constants.X_OK);
      usable = statSync(path).isFile();
    } catch {
      // reported below
    }
    if (!usable) throw new Error(`Managed runtime missing or inaccessible: ${path}. Run scripts/install.sh first, or select its --prefix.`);
  }
}

function checkRuntime(directRuntime) {
  const result = seams.spawn(directRuntime[0], [...directRuntime.slice(1), '--version'], { stdio: ['inherit', 'ignore', 'inherit'], timeout: 20_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`${shellJoin([...directRuntime, '--version'])} failed${result.error ? `: ${result.error.message}` : ` with exit status ${result.status ?? result.signal}`}`);
  }
}

const runtimeFlags = (chrome, audio) => [...(chrome ? ['--chrome'] : []), ...(audio ? ['--audio'] : [])];

/** Register pending harnesses that have appeared since setup; quiet and cheap when there are none. */
async function reconcile(args, account, home, register) {
  const path = harnessSearchPath(home);
  const ready = (state) => state.pending.filter((name) => harnessInstalled(name, home, path));
  // Unlocked first look: the common login-time run reads one small file and exits.
  if (!ready(loadSetupState(home)).length) return 0;
  return setupLock(home, async () => {
    // Another setup or reconcile may have registered them while this one waited.
    const state = loadSetupState(home);
    const names = ready(state);
    if (!names.length) return 0;
    const context = state.pending_context ?? { scope: 'user', project: null, session: args.session };
    const project = context.project || null;
    if (context.scope === 'project' && (!project || !existsSync(project) || !statSync(project).isDirectory())) {
      throw new Error(`Saved project directory is missing: ${context.project}. ` +
        'Rerun `lcu setup --agent all --allow-missing --scope project --project PATH`.');
    }
    const { releaseRoot, runtime, launcher, desktopCommand, directRuntime } = runtimePaths(args, account, context.session);
    requireLaunchers(runtime, launcher);
    checkRuntime(directRuntime);
    const toolsRoot = join(releaseRoot, 'agent-tools');
    const environment = { ...process.env, PATH: path };
    installerEnvironment(home, names, environment);
    await installerPaths(toolsRoot);
    say(`LCU: registering ${names.map((name) => CLIENTS[name].label).join(', ')} (installed since setup) with the saved settings.`);
    const failures = await register(names, home, [...desktopCommand, ...runtimeFlags(state.chrome, state.audio)], toolsRoot,
      releaseRoot, { scope: context.scope, project, setupCommand: runtime, environ: environment,
        approval: state.approval === 'auto' ? 'auto' : null });
    const failed = new Set(failures.map(([name]) => name));
    const remaining = state.pending.filter((name) => !names.includes(name) || failed.has(name));
    saveSetupState(home, { chrome: state.chrome, audio: state.audio, approval: state.approval, pending: remaining, pendingContext: context });
    if (failures.length) {
      throw new Error(`${failures.length} registration step(s) failed; still pending: ${remaining.join(', ')}. ` +
        'Fix the errors above; the next reconcile retries.');
    }
    say(`Registered: ${names.join(', ')}. Restart or reconnect those harnesses.`);
    return 0;
  });
}

/** Become the selected account: account files are always written as their owner, including image builds. */
function becomeAccount(account) {
  process.initgroups(account.name, account.gid);
  process.setgid(account.gid);
  process.setuid(account.uid);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { HOME: account.home, USER: account.name, LOGNAME: account.name,
    PATH: `${account.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8' });
  process.chdir(account.home);
}

/** `lcu setup ARGV`; `configure` registers the selected harnesses (another one only in tests). Returns the exit status. */
export async function main(argv, { configure: register = configure, crossTurn = {} } = {}) {
  let args;
  try {
    args = parse(argv);
  } catch (error) {
    warn(`lcu setup: ${error.message}`, "Run 'lcu setup --help' for usage.");
    return 2;
  }
  if (args.help) {
    say(HELP.trimEnd());
    return 0;
  }
  if (args['list-agents']) {
    for (const [name, client] of Object.entries(CLIENTS)) say(`${name.padEnd(16)} ${client.label} (${agentScopes(name)})`);
    say('Custom clients: --export /absolute/new/plugin-directory');
    return 0;
  }
  try {
    const { account, names: selected } = validate(args);
    let names = selected;
    const otherAccount = !windows() && process.getuid() === 0 && account.uid !== 0;
    if (args['validate-only']) {
      // Another account must never inherit the caller's profile overrides.
      if (!args.export) installerEnvironment(account.home, names, otherAccount ? {} : process.env);
      return 0;
    }
    if (otherAccount) becomeAccount(account);
    const home = account.home;
    if (args.reconcile) {
      try {
        return await reconcile(args, account, home, register);
      } catch (error) {
        warn(`Reconcile failed: ${error.message}`);
        return 1;
      }
    }
    return await setup(args, account, home, names, register, crossTurn);
  } catch (error) {
    warn(`Setup failed: ${describe(error)}`);
    return 1;
  }
}

async function setup(args, account, home, names, register, crossTurn) {
  const { releaseRoot, runtime, launcher, desktopCommand, directRuntime } = runtimePaths(args, account);
  requireLaunchers(runtime, launcher);
  if (names.length === 1 && names[0] === 'auto') {
    names = detect(home);
    if (!names.length && !args['allow-missing']) {
      throw new Error('No agents detected. Select --agent explicitly (works before the agent is installed), or use --export.');
    }
  }
  if (!names.length && !args.export) {
    if (!seams.interactive()) {
      throw new Error('Noninteractive setup requires --agent ID (repeatable), --agent all, --agent auto, or --export PATH.');
    }
    names = await chooseAgents(home);
  }
  validateAgentScope(names, args.scope);
  let missing = [];
  let setupEnvironment;
  if (args['allow-missing']) {
    // Registration through each harness's own CLI needs that CLI; defer those harnesses.
    setupEnvironment = { ...process.env, PATH: harnessSearchPath(home) };
    missing = names.filter((name) => NEEDS_BINARY.includes(name) && !harnessInstalled(name, home));
    names = names.filter((name) => !missing.includes(name));
  }
  checkRuntime(directRuntime);
  const toolsRoot = join(releaseRoot, 'agent-tools');
  if (!args.export) {
    installerEnvironment(home, names);
    await installerPaths(toolsRoot);
  }
  const setupCommand = runtime;
  const outcome = await setupLock(home, () => registerLocked(args, account, home, names, missing, register,
    { releaseRoot, desktopCommand, directRuntime, toolsRoot, setupCommand, setupEnvironment, crossTurn }));
  if (outcome === 'cancelled') return 0;
  return finish(args, outcome, { desktopCommand, directRuntime, setupCommand, home });
}

async function registerLocked(args, account, home, names, missing, register, paths) {
  const { releaseRoot, desktopCommand, directRuntime, toolsRoot, setupCommand, setupEnvironment, crossTurn } = paths;
  const state = loadSetupState(home);
  // A saved choice, including a declined prompt, suppresses the prompt.
  const saved = existsSync(setupStatePath(home));
  // Explicit flags win; otherwise a saved opt-in is kept.
  let audio = false;
  if (args.audio) audio = true;
  else if (!args['no-audio'] && state.audio) {
    audio = true;
    say('Keeping computer-audio recording enabled from the previous setup (use --no-audio to disable).');
  }
  let chrome = false;
  if (args.chrome) chrome = true;
  else if (args['no-chrome']) chrome = false;
  else if (state.chrome) {
    chrome = true;
    say('Keeping Chrome control enabled from the previous setup (use --no-chrome to disable).');
  } else if (!saved && !args.yes && seams.interactive()) {
    chrome = ['y', 'yes'].includes((await seams.ask('Enable Chrome browser control and its extension connector? [y/N] ')).trim().toLowerCase());
  }
  // `ask` keeps harness defaults. A saved `auto` is reapplied to each harness and scope selected now; an
  // explicit `--approval ask` is the only thing that removes entries.
  let approvalMode = 'ask';
  if (args.approval) approvalMode = args.approval;
  else if (state.approval === 'auto') {
    approvalMode = 'auto';
    say('Keeping automatic approval of LCU tools from the previous setup (use --approval ask to restore harness defaults).');
  }
  // Cross-turn Computer Use has its own file. An explicit flag wins; otherwise the owner is asked once, and only
  // when interactive and nothing is stored yet. A stored choice (even a damaged file) is kept as it is.
  let crossTurnWanted = null;
  const crossTurnState = args.export ? null : readCrossTurn(home);
  if (args['cross-turn']) crossTurnWanted = args['cross-turn'] === 'on';
  else if (crossTurnState && !crossTurnState.configured && !args.yes && seams.interactive()) {
    crossTurnWanted = ['y', 'yes'].includes((await seams.ask(crossTurnQuestion(crossTurn.platform))).trim().toLowerCase());
  }
  const approvalAction = approvalMode === 'auto' ? 'auto' : args.approval === 'ask' ? 'ask' : null;
  const command = [...desktopCommand, ...runtimeFlags(chrome, audio)];
  if (args.export) say(`Export tools to ${args.export}`);
  else {
    for (const name of missing) {
      say(`${CLIENTS[name].label}: not installed; will register when it appears ` +
        `(\`${setupCommand} setup --reconcile\` registers it with these settings).`);
    }
    if (names.length) say(`Configure ${names.join(', ')} for ${account.name} (${args.scope} scope).`);
    say('Existing LCU MCP entries will be updated and any old LCU skill removed; unrelated configuration is preserved.');
    if (names.includes('codex')) say('Codex: install and trust the original Stop, Interrupt, and SubagentStop cleanup hooks for LCU.');
  }
  if (chrome) {
    say('Chrome control selected: register the original extension connector for this desktop account and include Chrome guidance.');
    if (names.includes('claude-code')) {
      say('Claude Code: original turn cleanup runs on normal Stop and active MCP-call cancellation. Esc during model wait after a tool completes has no cleanup event and may leave temporary tabs open; Chrome remains experimental.');
    }
  } else say('Native desktop control selected; Chrome connector and guidance are excluded.');
  if (approvalMode === 'auto' && !args.export) {
    const entries = { 'claude-code': 'Claude Code: allow `mcp__lcu__js` and `mcp__lcu__js_reset`',
      codex: 'Codex: `approval_mode = "approve"` for the `js` and `js_reset` tools of `[mcp_servers.lcu]`',
      omp: 'Oh My Pi: `tools.approval` `js` and `js_reset` set to `allow`' };
    const chosen = names.filter((name) => entries[name]).map((name) => entries[name]);
    say('Approval mode auto: add only LCU\'s own entries so its tools run without a per-call harness prompt' +
      (chosen.length ? `: ${chosen.join('; ')}` : '') + '. ' +
      (names.some((name) => name === 'pi' || name === 'hermes') ? 'Pi and Hermes have no such gate. ' : '') +
      'Native-app and Chrome approvals from the original runtime are unchanged.');
  } else if (approvalAction === 'ask' && !args.export) {
    say('Approval mode ask: remove only the entries `--approval auto` added, restoring harness defaults.');
  }
  if (crossTurnState) {
    if (crossTurnState.problem) warn(`lcu cross-turn: ${crossTurnState.problem}`);
    if (crossTurnWanted === null) {
      say(`Cross-turn Computer Use: ${crossTurnState.enabled ? 'on' : 'off'}, unchanged (\`lcu cross-turn on|off\` changes it).`);
    } else if (crossTurnWanted === crossTurnState.enabled && crossTurnState.configured && !crossTurnState.problem) {
      say(`Cross-turn Computer Use: already ${crossTurnWanted ? 'on' : 'off'}.`);
    } else {
      say(`Cross-turn Computer Use: turn ${crossTurnWanted ? 'on' : 'off'}${crossTurnWanted && !args.unattended && (crossTurn.platform ?? process.platform) === 'darwin'
        ? ' (asks for Touch ID or your password)' : ''}. ${approvalNote(crossTurn.platform)}`);
    }
  }
  if (audio) say('Computer audio selected: enable the original optional recording API and its approval flow. A saved audio file is not model audio input.');
  if (windows() && names.includes('claude-code')) {
    say('Claude Code: original turn cleanup runs on normal Stop and active MCP-call cancellation. Esc during model wait after a tool completes has no cleanup event and may leave native helpers active.');
  }
  await (await import('./tested.mjs')).report(releaseRoot, { write: (text) => say(text.trimEnd()) });
  if (!args.yes) {
    if (!seams.interactive()) throw new Error('Review the selection above, then rerun with --yes for noninteractive setup.');
    if (!['y', 'yes'].includes((await seams.ask('Apply this setup? [y/N] ')).trim().toLowerCase())) {
      say('Cancelled; no agent configuration changed.');
      return 'cancelled';
    }
  }
  // The original native host is a per-account browser connection.
  if (chrome) await seams.installBrowser(releaseRoot);
  removeGeneratedSkill(home);
  let failures = [];
  if (args.export) await exportBundle(args.export, command, releaseRoot, { chrome, audio });
  else if (names.length) {
    failures = await register(names, home, command, toolsRoot, releaseRoot, { scope: args.scope,
      project: args.project ?? null, setupCommand, approval: approvalAction, environ: setupEnvironment });
  }
  // Remember opt-ins even when registration failed, so a retry or `--reconcile` keeps them. Harnesses registered
  // now leave the pending set; a later reconcile applies the saved chrome, audio and approval mode to the rest.
  // A pending harness whose registration failed stays pending.
  const failed = [...new Set(failures.map(([name]) => name))];
  const pending = args.export ? [] : [...new Set([...state.pending, ...missing])]
    .filter((name) => !names.includes(name) || failed.includes(name));
  saveSetupState(home, { chrome, audio, approval: approvalMode, pending, pendingContext: pending.length
    ? (missing.length ? { scope: args.scope, session: args.session, project: args.project ?? null } : state.pending_context) : null });
  if (crossTurnWanted !== null) {
    // A failed or cancelled owner authentication leaves the setting as it was and does not fail the rest of setup.
    try {
      const done = await setCrossTurn(home, crossTurnWanted, { root: releaseRoot, unattended: args.unattended, ...crossTurn });
      if (done.note) warn(done.note);
      say(done.changed ? `Cross-turn Computer Use is now ${done.enabled ? 'on' : 'off'}.` : `Cross-turn Computer Use stays ${done.enabled ? 'on' : 'off'}.`);
    } catch (error) {
      warn(`Cross-turn Computer Use unchanged: ${error.message}`, 'Retry with `lcu cross-turn on` or `lcu setup --cross-turn on`.');
    }
  }
  if (failures.length) {
    const retry = [setupCommand, 'setup', '--prefix', args.prefix, ...(args.user ? ['--user', account.name] : []), '--scope', args.scope,
      '--session', args.session, '--yes', ...(args.project ? ['--project', args.project] : []),
      chrome ? '--chrome' : '--no-chrome', audio ? '--audio' : '--no-audio',
      // A defaulted `ask` must not be passed: it would remove approval entries.
      ...(args.approval || approvalMode === 'auto' ? ['--approval', approvalMode] : []),
      ...(args['allow-missing'] ? ['--allow-missing'] : []), ...failed.flatMap((name) => ['--agent', name])];
    throw new Error(`${failures.length} registration step(s) failed (${failures.map(([name, phase]) => `${name}: ${phase}`).join(', ')}). ` +
      `Choices were saved; completed steps remain installed. After resolving the errors, retry: ${shellJoin(retry)}`);
  }
  if (!args.export && (missing.length || pending.length)) {
    say(`Registered now: ${names.join(', ') || 'none'}.`);
    say(`Pending (not installed): ${pending.join(', ') || 'none'}. Install them, then run \`${setupCommand} setup --reconcile\` (safe at every login).`);
  }
  return { chrome, audio };
}

async function finish(args, { chrome, audio }, { desktopCommand, directRuntime, setupCommand, home }) {
  say('Configuration prepared. Restart/reconnect the selected agent, then ask it to use LCU to inspect the desktop.');
  if (process.platform === 'darwin') {
    const { MAC_SOCKET_ENV, macSocketPathProblem } = await import('./platforms.mjs');
    const problem = macSocketPathProblem();
    if (problem) say(`Warning: ${problem}`);
    const accountHome = userInfo().homedir;
    if (!args.export && !(MAC_SOCKET_ENV in process.env) && real(home) !== real(accountHome)) {
      say(`Warning: setup configured the agents in ${home}, not in this account's home folder ${accountHome}. ` +
        'The original Computer Use client finds the ChatGPT helper from HOME, so an agent started with this HOME ' +
        'cannot reach it (\'native pipe startup failed\') unless ' + `${MAC_SOCKET_ENV} names the helper's socket.`);
    }
  }
  if (chrome) {
    const status = seams.run(directRuntime[0], [...directRuntime.slice(1), 'browser', 'status'], { timeout: 20_000 });
    const text = (status.stdout ?? '').trim();
    if (text) say(text);
    if (status.error || (status.status !== 0 && !text)) say(`Browser status unavailable; run \`${setupCommand} browser status\` after setup.`);
  } else {
    say(`Chrome browser control not enabled; add it later with \`${setupCommand} setup --agent AGENT --chrome\`; other saved opt-ins are kept.`);
  }
  if (!audio) say(`Computer-audio recording not enabled; add it later with \`${setupCommand} setup --agent AGENT --audio\`; other saved opt-ins are kept.`);
  if (args.export) say('Import this plugin with a compatible client, or use its mcp.json with your custom agent.');
  const { mode, command, timeout } = desktopReadinessRequest(args, { interactive: seams.interactive(), desktopCommand });
  if (mode === 'required') {
    say('Checking live desktop readiness. This check will not open System Settings.');
    const result = runDesktopDoctor(command, timeout);
    if (result.interrupted) {
      warn('', 'Agent configuration is saved; the required desktop check was cancelled. Rerun lcu doctor to check readiness.');
      return 2;
    }
    if (result.error) {
      warn('Agent configuration is saved, but desktop readiness was not verified. Check the runtime, then rerun lcu doctor.',
        `Details: ${result.error.message}`);
      return 2;
    }
    if (result.status !== 0) {
      warn('Agent configuration is saved, but desktop readiness was not verified. Review the status above, then rerun lcu doctor.');
      return 2;
    }
    say('Desktop readiness check passed. Tool discovery still needs the first agent connection.');
  } else if (mode === 'guided') {
    say('Starting the guided desktop readiness check. Settings opens only if you choose a pane.');
    const result = runDesktopDoctor(command, timeout);
    if (result.interrupted) say('', 'Agent configuration is saved. The guided check was cancelled; rerun lcu doctor when ready.');
    else if (result.error) {
      say(`Agent configuration is saved, but the guided check could not finish: ${result.error.message}`,
        'Reconnect your agent, then run lcu doctor to review desktop readiness.');
    } else if (result.status !== 0) {
      say('Agent configuration is saved, but desktop readiness remains unverified. Reconnect your agent and run lcu doctor after resolving the status above.');
    }
  } else if (mode === 'deferred') {
    say('Desktop readiness was not checked. Reconnect your agent, then run:', `  ${shellJoin(command)}`);
  }
  return 0;
}
