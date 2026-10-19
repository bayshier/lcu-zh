// The `lcu` entry: dispatch commands, and launch the selected application's original computer-use provider.
// Builtins come from process.getBuiltinModule: an ESM import of a builtin builds its export facade, which
// costs milliseconds on every launch; child_process, crypto and tty are loaded only where they are used.
const { accessSync, constants, readFileSync, readSync, realpathSync, writeSync } = process.getBuiltinModule('node:fs');
const { userInfo } = process.getBuiltinModule('node:os');
const { basename, dirname, isAbsolute, join, posix, resolve, win32 } = process.getBuiltinModule('node:path');
const { fileURLToPath, pathToFileURL } = process.getBuiltinModule('node:url');

import { locateCodexTools } from './app_layout.mjs';
import { isMain, run } from './entry.mjs';
import { isFile, readJson, real } from './fsutil.mjs';
import { MAC_SOCKET_ENV, macSocketPath, resolveInstalledLinuxApp, resolveInstalledMacApp } from './platforms.mjs';
import { configuration as shimConfiguration, CONFIG_ENV as SHIM_CONFIG_ENV, FAULT_ENV as SHIM_FAULT_ENV, SKY_SERVICE } from './sandbox_shim.mjs';
import { nativeInput } from './tested.mjs';
import { component, inventorySha256, isRedirected, validateWindowsAppTree } from './windows.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// One help text for runtime.mjs and for the launcher, which prints it when the recorded Node is missing.
const HELP = readFileSync(join(HERE, 'usage.txt'), 'utf8');
export const USAGE = HELP.split('\n\n')[0];

const surfaces = (env) => new Set((env.CUA_REPL_ENABLED_SURFACES ?? '').split(',').map((surface) => surface.trim()));
const unique = (values) => [...new Set(values)];

/**
 * Resolve one selected, intact application generation: `{app, resources, runtime, metadata: {version, runtime}}`.
 * Identity, signature and ownership checks run here, once per call. `reuseRecordedChecks` (launches only) lets
 * macOS skip the deep signature check of a build, and Windows the hashing of a private copy, that this account
 * already verified and that has not changed since.
 */
export function paths(root, descriptor = readJson(join(root, 'installation.json')), { reuseRecordedChecks = false } = {}) {
  const app = join(root, 'app');
  const lock = readJson(join(root, 'runtime.lock.json'));
  const selected = typeof descriptor.app === 'string' ? descriptor.app : '';
  const arch = descriptor.architecture;
  const target = descriptor.platform ?? 'linux';
  if (target === 'darwin') {
    if (!isAbsolute(selected) || !lock.platforms?.darwin?.architectures?.[arch] || real(selected) !== real(app)) {
      throw new Error('Selected application descriptor does not match the supported macOS app link.');
    }
    const resolved = resolveInstalledMacApp(selected, { arch, reuseRecordedSeal: reuseRecordedChecks });
    return { app: resolved.app, resources: resolved.resources, runtime: resolved.runtime,
      metadata: { version: resolved.version, runtime: resolved.runtimeVersion } };
  }
  if (target === 'windows') return windowsPaths(root, lock, descriptor, reuseRecordedChecks);
  if (target !== 'linux') throw new Error(`Unsupported installed application platform: ${target}`);
  if (!isAbsolute(selected) || !Object.hasOwn(lock.architectures ?? {}, arch) || real(selected) !== real(app)) {
    throw new Error('Selected application descriptor does not match the supported architecture and app link. ' +
      'Rerun scripts/install.sh.');
  }
  let resolved;
  try {
    resolved = resolveInstalledLinuxApp(selected, { arch });
  } catch (error) {
    throw new Error(`${error.message}. Rerun scripts/install.sh.`);
  }
  // Launch through the release's link, as before; it resolves to the installed app.
  const resources = join(app, 'resources');
  return { app, resources, runtime: join(resources, 'cua_node'),
    metadata: { version: resolved.version, runtime: resolved.runtimeVersion } };
}

function windowsPaths(root, lock, descriptor, reuseRecordedInventory) {
  const { app: selected, architecture: arch, package_version: version, runtime, sha256: digest } = descriptor;
  if (typeof selected !== 'string' || !isAbsolute(selected) || arch !== 'x64' ||
      !lock.platforms?.windows?.architectures?.[arch] || typeof version !== 'string' || !version ||
      typeof runtime !== 'string' || !runtime || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error('Selected Windows application descriptor is incomplete or unsupported.');
  }
  const apps = join(dirname(dirname(root)), 'apps');
  const generation = join(apps, digest);
  const expected = join(generation, 'app');
  const inventoryPath = join(generation, 'inventory.json');
  // Windows paths compare without regard to case, as the file system does.
  const same = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
  if (!same(selected, expected) || [apps, generation, selected, inventoryPath].some(isRedirected) || !isFile(inventoryPath)) {
    throw new Error('Selected Windows application is not the managed private generation.');
  }
  let inventory;
  try {
    inventory = readJson(inventoryPath);
  } catch {
    throw new Error('Managed Windows application inventory is invalid.');
  }
  if (inventorySha256(inventory) !== digest) throw new Error('Managed Windows application inventory does not match its descriptor.');
  const resolved = validateWindowsAppTree(selected, { expectedVersion: version, expectedRuntime: runtime, expectedInventory: inventory,
    reuseRecordedInventory });
  if (resolved.app !== realpathSync(expected)) throw new Error('Selected Windows application does not match the managed generation.');
  return { app: resolved.app, resources: resolved.resources, runtime: resolved.runtime,
    metadata: { version: resolved.version, runtime: resolved.runtimeVersion } };
}

/** The directory the original runtime uses when CODEX_HOME is not set (Node's own path.join). */
export function defaultCodexHome(env, windows) {
  if (windows) return win32.join(env.USERPROFILE || env.HOME || userInfo().homedir, '.codex');
  return posix.join('HOME' in env ? env.HOME : userInfo().homedir, '.codex');
}

/** The child environment for the original runtime. `env` is the caller's environment (not modified). */
export function environment(root, resolved, { chrome = false, audio = false, platform, env: source = process.env } = {}) {
  resolved ??= paths(root);
  const { resources, runtime, metadata } = resolved;
  const target = platform ?? readJson(join(root, 'installation.json')).platform ?? 'linux';
  const windows = target === 'windows';
  const separator = windows ? ';' : ':';
  const moduleDir = join(runtime, windows ? 'bin/node_modules' : 'lib/node_modules');
  const node = join(runtime, windows ? 'bin/node.exe' : 'bin/node');
  const nodeRepl = join(runtime, windows ? 'bin/node_repl.exe' : 'bin/node_repl');
  const codex = locateCodexTools(resources, { windows }).cli;
  const env = { ...source };
  // Windows variable names are case-insensitive: PATH may arrive as `Path`; keep one spelling of it.
  const existingPath = windows ? Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
    : env.PATH ?? '/usr/bin:/bin';
  if (windows) for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  // The original selects and trusts CODEX_HOME verbatim, including an explicitly empty value.
  if (!('CODEX_HOME' in env)) env.CODEX_HOME = defaultCodexHome(env, windows);
  // Select our verified executables, while retaining upstream caller options, metadata, services, policy
  // flags, and additional module/trust roots.
  const prepend = (key, ...first) => unique([...first.filter(Boolean),
    ...(env[key] ?? '').split(separator).filter(Boolean)]).join(separator);
  Object.assign(env, {
    PATH: join(runtime, 'bin') + separator + existingPath,
    CUA_REPL_NODE_REPL_PATH: nodeRepl,
    NODE_REPL_NODE_PATH: node,
    NODE_REPL_NODE_MODULE_DIRS: prepend('NODE_REPL_NODE_MODULE_DIRS', moduleDir),
    NODE_REPL_TRUSTED_CODE_PATHS: prepend('NODE_REPL_TRUSTED_CODE_PATHS', env.CODEX_HOME, moduleDir, join(resources, 'plugins')),
  });
  // The original launcher selects both its API and instructions from this surface list. External Chrome is
  // an explicit opt-in for LCU clients.
  env.CUA_REPL_ENABLED_SURFACES ??= chrome ? 'browser,computer' : 'computer';
  // These paired switches are the original optional computer-audio API gate. Inherit caller policy when
  // LCU was not explicitly asked to enable audio.
  if (audio) {
    env.SKY_ENABLE_AUDIO = '1';
    env.NODE_REPL_ENABLE_AUDIO = '1';
  }
  env.CUA_REPL_BROWSER_ENV ??= 'codex-app';
  env.CODEX_CLI_PATH ??= codex;
  if (basename(dirname(resources)) === 'Contents') {
    // Original Sky's macOS native-pipe transport uses this signed helper through LaunchServices when no
    // existing CUA service is connected.
    env.SKY_CUA_SERVICE_PATH ??= join(runtime, 'lib/node_modules/@oai/sky/Codex Computer Use.app');
  }
  // Fixed host defaults from the pinned application. The unified codex-app surface is selected only with
  // browserUseTinysky in the original.
  env.NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS ??= '1000';
  if (env.CUA_REPL_BROWSER_ENV === 'codex-app') {
    env.BROWSER_USE_AVAILABLE_BACKENDS ??= 'chrome';
    env.BROWSER_USE_TINYSKY_ENABLED ??= '1';
    const flavor = (env.BUILD_FLAVOR ?? '').trim();
    env.BROWSER_USE_CODEX_APP_BUILD_FLAVOR ??=
      ['dev', 'agent', 'nightly', 'internal-alpha', 'public-beta', 'prod'].includes(flavor) ? flavor : 'prod';
    env.BROWSER_USE_CODEX_APP_VERSION ??= metadata.version;
  }
  env.NODE_REPL_DISABLE_ANALYTICS ??= '1';
  // Original browser service switch: do not initialize account identity or telemetry. The relay already
  // supplies the local agent-header decision.
  env.BROWSER_USE_DISABLE_AMBIENT_NETWORK ??= '1';
  // Upstream browser routing needs an identity even for a generic MCP client. This names this actual MCP
  // connection, not a Codex model or an approval. Host-supplied request metadata keeps precedence.
  if (!('NODE_REPL_REQUEST_META' in env)) {
    const identity = `lcu-${process.getBuiltinModule('node:crypto').randomUUID()}`;
    env.NODE_REPL_REQUEST_META = JSON.stringify({ 'x-codex-turn-metadata': { session_id: identity, turn_id: `${identity}-connection` } });
  }
  if (target === 'linux') {
    configureLinuxInput(root, runtime, env, metadata);
    const mode = (env.LCU_NODE_REPL_SANDBOX ?? '').trim().toLowerCase();
    if (mode === 'off') defaultLinuxSandboxState(env);
    else if (mode !== 'host') configureLinuxSandboxShim(root, runtime, env);
  }
  return env;
}

const LINUX_INPUT_TOOLKITS = ['gtk4', 'qt-scroll'];

const linuxInputTranslationOff = (env) =>
  ['off', '0', 'false', 'no'].includes((env.LCU_LINUX_INPUT_TRANSLATION ?? '').trim().toLowerCase());

/**
 * Interpose a thin wrapper on the Sky RPC for window-targeted input GTK 4 and Qt ignore. The original Linux
 * engine sends window-targeted keys, clicks, scroll and drag with XSendEvent, which GTK 4 (XInput2 only)
 * ignores, and Qt ignores for scroll. The wrapper re-issues those calls through the engine's own
 * desktop-level path for those windows only. `LCU_LINUX_INPUT_TRANSLATION=off` leaves the original service in
 * place. An exact tested app/runtime pair whose record lists `native_input` is not translated for those toolkits.
 */
function configureLinuxInput(root, runtime, env, metadata) {
  if (linuxInputTranslationOff(env)) return;
  const wrapper = join(root, 'lcu/linux_sky_service.mjs');
  if (!surfaces(env).has('computer') || !isFile(wrapper)) return;
  let toolkits = LINUX_INPUT_TOOLKITS;
  try {
    const { architecture } = readJson(join(root, 'installation.json'));
    const native = nativeInput(root, { platform: 'linux', architecture, appVersion: metadata.version, runtime: metadata.runtime });
    toolkits = toolkits.filter((toolkit) => !native.includes(toolkit));
  } catch {
    // an unreadable record keeps the translation on
  }
  if (!toolkits.length) return;
  // The original launcher keeps a caller-supplied service map verbatim. Wrap Sky only when no map is supplied,
  // or when the caller's map names the original Sky service explicitly (or already this wrapper).
  if (env.NODE_REPL_TRUSTED_SERVICES !== undefined) {
    let supplied;
    try {
      supplied = JSON.parse(env.NODE_REPL_TRUSTED_SERVICES);
    } catch {
      return;
    }
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || ![SKY_SERVICE, wrapper].includes(supplied.sky)) {
      return; // an empty, custom-only or custom-Sky map is the caller's and stays exactly as given
    }
  }
  try {
    overrideTrustedService(env, wrapper, ':', 'Linux', { computerGated: true });
  } catch {
    return;
  }
  env.LCU_LINUX_SKY_SERVICE_PATH = join(runtime, 'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js');
  env.LCU_LINUX_INPUT_TOOLKITS = toolkits.join(',');
}

/**
 * Keep the model's JavaScript kernel sandboxed while Sky, the trusted worker, can reach X11. node_repl starts
 * both through CODEX_CLI_PATH, so LCU points it at a launcher shim (`sandbox_shim.mjs`) that leaves the kernel
 * sandboxed as asked and starts only the identified Sky worker outside it. A host that sends its own
 * `codex/sandbox-state-meta` keeps full precedence. Without the shim file the original behavior stays, which
 * fails closed. LCU_NODE_REPL_SANDBOX=host leaves everything untouched and `off` runs the kernel unsandboxed.
 */
function configureLinuxSandboxShim(root, runtime, env) {
  const shim = join(root, 'bin/lcu-codex-sandbox');
  if (!isFile(shim) || !env.CODEX_CLI_PATH) return;
  const wrapper = join(root, 'lcu/linux_sky_service.mjs');
  let sky = SKY_SERVICE; // the original launcher's default when no map is supplied
  if (env.NODE_REPL_TRUSTED_SERVICES !== undefined) {
    try {
      sky = JSON.parse(env.NODE_REPL_TRUSTED_SERVICES)?.sky;
    } catch {
      sky = SKY_SERVICE;
    }
  }
  env[SHIM_CONFIG_ENV] = shimConfiguration(runtime, env.CODEX_CLI_PATH, sky === wrapper ? wrapper : null);
  // node_repl starts the kernel with only the variables on this list; the shim needs its configuration there
  // too. The test-only fault hook travels the same way and can only make the shim refuse.
  env.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST = [env.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST, SHIM_CONFIG_ENV,
    SHIM_FAULT_ENV in env ? SHIM_FAULT_ENV : ''].filter(Boolean).join(',');
  env.CODEX_CLI_PATH = shim;
}

const SANDBOX_STATE_META = 'codex/sandbox-state-meta';

/**
 * Give the original node_repl the `disabled` sandbox state official Codex sends under danger-full-access
 * (`LCU_NODE_REPL_SANDBOX=off`). A host that sends its own state keeps precedence.
 */
function defaultLinuxSandboxState(env) {
  let request;
  try {
    request = JSON.parse(env.NODE_REPL_REQUEST_META);
  } catch {
    return;
  }
  if (!request || typeof request !== 'object' || Array.isArray(request) || SANDBOX_STATE_META in request) return;
  let cwd = '/';
  try {
    cwd = process.cwd();
  } catch {
    // a removed working directory
  }
  request[SANDBOX_STATE_META] = { permissionProfile: { type: 'disabled' }, sandboxCwd: pathToFileURL(cwd).href };
  env.NODE_REPL_REQUEST_META = JSON.stringify(request);
}

/**
 * Start from `/` when the launch directory cannot be entered: without a sandbox state of its own, node_repl
 * starts its kernel in the working directory and fails when the account cannot enter it.
 */
export function leaveUnusableWorkingDirectory() {
  try {
    accessSync('.', constants.R_OK | constants.X_OK);
  } catch {
    process.chdir('/');
  }
}

/** Answer a legacy-version probe with an error, reading byte by byte so nothing past its line is consumed. */
function replyToServerDiscover(input = 0, output = 1) {
  const raw = [];
  const byte = Buffer.alloc(1);
  while (raw.length <= 1024 * 1024) {
    let count;
    try {
      count = readSync(input, byte, 0, 1, null);
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      continue;
    }
    if (!count) break;
    raw.push(byte[0]);
    if (byte[0] === 0x0a) break;
  }
  if (raw.at(-1) !== 0x0a) throw new Error('Expected a newline-terminated initial JSON-RPC server/discover request.');
  if (raw.length > 1024 * 1024) throw new Error('Initial JSON-RPC server/discover request exceeds 1 MiB.');
  let request;
  try {
    request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(raw)));
  } catch {
    throw new Error('Expected a valid initial JSON-RPC server/discover request.');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' ||
      request.method !== 'server/discover' || !['string', 'number'].includes(typeof request.id)) {
    throw new Error('Expected an initial JSON-RPC server/discover request in compatibility mode.');
  }
  writeSync(output, `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`);
}

/** Add the native-cleanup Sky wrapper while keeping any other trusted services. */
function overrideTrustedService(env, wrapper, separator, platformName, { computerGated }) {
  const enabled = surfaces(env);
  const gate = computerGated ? enabled.has('computer') : true;
  let supplied;
  if (env.NODE_REPL_TRUSTED_SERVICES === undefined) {
    supplied = {};
    if (enabled.has('browser')) supplied.browser = '@oai/browser-desktop/service';
    if (gate) supplied.sky = SKY_SERVICE;
  } else {
    try {
      supplied = JSON.parse(env.NODE_REPL_TRUSTED_SERVICES);
    } catch {
      supplied = null;
    }
  }
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) ||
      Object.values(supplied).some((value) => typeof value !== 'string')) {
    throw new Error('NODE_REPL_TRUSTED_SERVICES must be a JSON string map.');
  }
  if (gate && ![undefined, SKY_SERVICE, wrapper].includes(supplied.sky)) {
    throw new Error(`A custom Sky trusted-service override conflicts with ${platformName} native cleanup.`);
  }
  env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify(gate ? { ...supplied, sky: wrapper } : supplied);
  env.NODE_REPL_TRUSTED_CODE_PATHS = unique([dirname(wrapper),
    ...(env.NODE_REPL_TRUSTED_CODE_PATHS ?? '').split(separator).filter(Boolean)]).join(separator);
}

/** Keep original Sky behavior and add only its turn-ended host hook; returns the original client, or null. */
export function configureMacosLifecycle(root, runtime, env) {
  if (!surfaces(env).has('computer')) return null;
  overrideTrustedService(env, join(root, 'lcu/macos_sky_service.mjs'), ':', 'macOS', { computerGated: false });
  const sky = join(runtime, 'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src');
  env.LCU_MAC_SKY_SERVICE_PATH = join(sky, 'service.js');
  env.LCU_MAC_SKY_CLIENT_PATH = join(sky, 'targets/mac/client.js');
  return join(env.SKY_CUA_SERVICE_PATH, 'Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient');
}

/** Run the original server as a child with inherited stdio; its status, or 128 + N when signal N ended it. */
function runChild(command, env) {
  return new Promise((resolveStatus, reject) => {
    const child = process.getBuiltinModule('node:child_process').spawn(command[0], command.slice(1), { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (status, signal) => resolveStatus(status ?? 128 + (process.getBuiltinModule('node:os').constants.signals[signal] ?? 0)));
  });
}

async function command(name) {
  return import(`./${name}.mjs`);
}

/** `[line, status]` for `lcu --version`, with the version and runtime observed from the selected app. */
function versionLine(root) {
  const version = isFile(join(root, 'bundle.json')) ? readJson(join(root, 'bundle.json')).version : 'source-checkout';
  const descriptorPath = join(root, 'installation.json');
  if (!isFile(descriptorPath)) return [`lcu ${version} (ChatGPT linux app not selected)`, 0];
  const descriptor = readJson(descriptorPath);
  const target = descriptor.platform ?? 'linux';
  try {
    const { metadata } = paths(root, descriptor);
    return [`lcu ${version} (ChatGPT ${target} ${metadata.version}; CUA ${metadata.runtime})`, 0];
  } catch (error) {
    return [`lcu ${version} (ChatGPT ${target} app invalid: ${error.message})`, 1];
  }
}

/** Run `lcu ARGV` from the release `root`; returns the exit status. */
export async function main(root, argv) {
  // Agent registrations place LCU options before generic executable probes.
  const probe = [...argv];
  const seen = new Set();
  while (['--chrome', '--audio'].includes(probe[0]) && !seen.has(probe[0])) seen.add(probe.shift());
  if (probe.length === 1 && ['--help', '-h', '--version'].includes(probe[0])) argv = probe;
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv[0] === '--version') {
    const [line, status] = versionLine(root);
    process.stdout.write(`${line}\n`);
    return status;
  }
  const [name, ...rest] = argv;
  switch (name) {
    case 'setup':
      return (await command('setup')).main(argv.includes('--prefix') ? rest : [...rest, '--prefix', dirname(dirname(root))]);
    case 'browser':
      return (await command('browser')).main(root, rest);
    case 'status':
      return (await command('status')).main(root, rest);
    case 'apps':
      return (await command('apps')).main(root, rest);
    case 'cross-turn':
      return (await command('cross_turn')).main(root, rest);
    case 'origins':
      return (await command('origins')).main(rest);
    case 'prune':
      return (await command('maintenance')).main(root, rest);
    case 'update':
      return (await command('update')).main(root, rest);
    default:
  }
  if (argv.length === 1 && argv[0] === '--with-browser-host') {
    throw new Error('--with-browser-host was removed with the embedded browser. ' +
      'Run lcu browser install and enable the official Chrome extension.');
  }
  const count = (flag) => argv.filter((arg) => arg === flag).length;
  const direct = argv.filter((arg) => arg !== '--chrome' && arg !== '--audio');
  const doctorArgs = direct[0] === 'doctor' ? direct.slice(1) : null;
  const discoveryCompat = direct.length === 1 && direct[0] === '--mcp-discovery-compat';
  if (count('--chrome') > 1 || count('--audio') > 1 || (direct.length && !discoveryCompat && !doctorArgs)) {
    throw new Error(USAGE);
  }
  // `lcu doctor --help` documents the check without resolving the installed app.
  if (doctorArgs && (doctorArgs.includes('--help') || doctorArgs.includes('-h'))) {
    return (await command('doctor')).main(root, doctorArgs);
  }
  // A bare stdio server launched from a real terminal only appears to hang.
  const tty = process.getBuiltinModule('node:tty');
  if (!direct.length && tty.isatty(0) && tty.isatty(1)) {
    const lcu = join(root, 'bin/lcu');
    process.stderr.write(`lcu is a stdio MCP server, launched by an agent harness over pipes, not run directly.\n${USAGE}\n` +
      `Run \`${lcu} setup\` to register it with a harness, or \`${lcu} doctor\` to check readiness.\n`);
    return 2;
  }
  const descriptor = readJson(join(root, 'installation.json'));
  const platform = descriptor.platform ?? 'linux';
  // A launch reuses a recorded deep signature check (macOS) or inventory match (Windows); `lcu doctor` always
  // checks in full.
  const resolved = paths(root, descriptor, { reuseRecordedChecks: !doctorArgs });
  const env = environment(root, resolved, { chrome: count('--chrome') === 1, audio: count('--audio') === 1, platform });
  if (doctorArgs) return (await command('doctor')).main(root, doctorArgs, { resolved, env });
  if (platform === 'windows') return launchWindows(root, resolved, env, discoveryCompat);
  const launch = [env.NODE_REPL_NODE_PATH, join(resolved.runtime, 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')];
  if (discoveryCompat) replyToServerDiscover();
  if (platform === 'darwin') {
    const client = configureMacosLifecycle(root, resolved.runtime, env);
    if (client) return launchMacos(client, launch, env);
  }
  if (platform === 'linux') leaveUnusableWorkingDirectory();
  process.execve(join(resolved.runtime, 'bin/node'), launch, env);
  return 0;
}

async function launchMacos(client, launch, env) {
  const { startOriginalHost } = await import('./macos_host.mjs');
  // Always decided here, never inherited: only the default socket location is known, and the original client
  // builds its socket path from $HOME (Node's os.homedir), so an account whose HOME is elsewhere is talking to a
  // different socket. Any override, even an empty one, means the client may not use the default socket.
  const accountHome = userInfo().homedir;
  const clientHome = 'HOME' in env ? env.HOME : accountHome;
  if (MAC_SOCKET_ENV in env || !clientHome || real(clientHome) !== real(accountHome)) delete env.LCU_MAC_SERVICE_LOCK;
  else env.LCU_MAC_SERVICE_LOCK = `${macSocketPath(env).path}.lock`;
  const host = await startOriginalHost({ client, env, controlAddress: env.LCU_MAC_CONTROL_SOCKET });
  env.LCU_MAC_LIFETIME_SOCKET = host.address;
  try {
    return await runChild(launch, env);
  } finally {
    await host.stop();
  }
}

async function launchWindows(root, resolved, env, discoveryCompat) {
  const { startOriginalHost, stopOriginalHost } = await import('./windows_host.mjs');
  const sky = '@oai/sky/dist/project/cua/sky_js/src';
  const original = (relative) => component(resolved.app, `app/resources/cua_node/bin/node_modules/${relative}`);
  const launch = [env.NODE_REPL_NODE_PATH, original('@oai/cua-repl/bin/cua-repl.mjs')];
  if (discoveryCompat) replyToServerDiscover();
  const host = await startOriginalHost({ node: env.NODE_REPL_NODE_PATH, entry: join(root, 'lcu-host/windows-pipe-host.cjs'),
    helper: original('@oai/sky/bin/windows/codex-computer-use.exe'),
    transport: original(`${sky}/targets/windows/internal/helper_transport.js`), env });
  try {
    env.SKY_CUA_NATIVE_PIPE = '1';
    env.SKY_CUA_NATIVE_PIPE_DIRECTORY = host.pipe;
    env.LCU_WRE_LIFETIME_PIPE = host.lifetime;
    env.LCU_WRE_SKY_SERVICE_PATH = original(`${sky}/service.js`);
    overrideTrustedService(env, join(root, 'lcu-host/windows-sky-service.mjs'), ';', 'Windows', { computerGated: true });
    return await runChild(launch, env);
  } finally {
    await stopOriginalHost(host.child);
  }
}

/** Entry for launchers and the Windows account launcher: run `lcu` from `root` with `argv`. */
export const cli = (root, argv) => run('LCU', () => main(root, argv));

if (isMain(import.meta)) cli(dirname(HERE), process.argv.slice(2));
