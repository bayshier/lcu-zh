// Extract the unchanged original Windows pipe host into a private generation, and run it.
//
// Only the tiny launch entry and the structural analyzer are LCU code. The native host and its dependencies
// come unchanged from the installed application's app.asar. The host factory is located by structure (a
// parsed top-level function whose options are the native-pipe settings), never by a minified name, and the
// declarations it needs are copied verbatim into one generated module.
// Builtins come from process.getBuiltinModule, like the rest of the launch path.
const { spawn, spawnSync } = process.getBuiltinModule('node:child_process');
const { lstatSync, mkdirSync, readFileSync, writeFileSync } = process.getBuiltinModule('node:fs');
const { dirname, join, posix } = process.getBuiltinModule('node:path');
const { fileURLToPath } = process.getBuiltinModule('node:url');

import { listAsarMembers, readAsarMembers } from './asar.mjs';
import { isFile } from './fsutil.mjs';
import { component } from './windows.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_PATH = /^\.vite\/build\/main(?:-[^/]+)?\.js$/;
const ANALYZER = join(HERE, 'windows_host_analyze.cjs');
const GENERATED = 'lcu-original-pipe-host.cjs';
const RESOLVED_SUFFIXES = ['', '.js', '.json', '.node', '/package.json', '/index.js', '/index.json', '/index.node'];
const MAX_CHUNKS = 400;
const NODE_MEMBER = 'app/resources/cua_node/bin/node.exe';

const unavailable = (detail) => new Error(`Required Windows host layout is unavailable: ${detail}`);

/** Run the structural analyzer on the original Node with a JSON request. */
export function analyze(node, request) {
  if (!isFile(node)) throw unavailable('the original Node needed to read the host layout is missing');
  const env = { PATH: process.env.PATH ?? '' };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT; // Node aborts at startup on Windows without it
  const result = spawnSync(node, ['--max-old-space-size=2048', ANALYZER], {
    input: JSON.stringify(request), env, timeout: 180_000, maxBuffer: 1024 * 1024 * 1024 });
  if (result.error && result.status === null) throw unavailable(`the structural analyzer could not run (${result.error.code ?? result.error.message})`);
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    response = null;
  }
  if (result.status !== 0 || !response || typeof response !== 'object') {
    const detail = `${result.stderr ?? ''}`.trim().split('\n')[0];
    throw unavailable(`the structural analyzer failed to read the main bundle${detail ? ` (${detail.slice(0, 160)})` : ''}`);
  }
  if (response.ok !== true) throw unavailable(String(response.error || 'the structural analyzer rejected the main bundle'));
  return response;
}

function decode(source, name) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    throw unavailable(`${name} is not UTF-8`);
  }
}

function memberFor(current, specifier, members) {
  const base = posix.join(posix.dirname(current), specifier).replace(/(.)\/+$/, '$1');
  if (base === '..' || base.startsWith('../') || posix.isAbsolute(base)) {
    throw unavailable(`original dependency ${JSON.stringify(specifier)} leaves the application archive`);
  }
  // Node's own order for a relative specifier: the exact file, then .js, .json, .node, then a directory's
  // package.json "main" (not supported here) or index file. A trailing slash (or `/.`, `/..`) names a
  // directory only; Node then skips file candidates.
  const directoryOnly = /(?:\/|\/\.|\/\.\.)$/.test(specifier) || specifier === '.' || specifier === '..';
  for (const suffix of RESOLVED_SUFFIXES) {
    if (directoryOnly && !suffix.startsWith('/')) continue;
    if (members.has(base + suffix)) {
      if (suffix === '/package.json') throw unavailable(`original dependency ${base} is a package directory, which is not supported`);
      return base + suffix;
    }
  }
  throw unavailable(`original dependency is missing: ${base}`);
}

/** Resolve one module's static dependencies; fail closed on anything not plain and local. */
function localDependencies(current, requires, imports, members) {
  for (const item of imports) {
    if (!item.builtin) throw unavailable(`${current} imports ${JSON.stringify(item.spec)} statically, which is not supported`);
  }
  const found = [];
  for (const { spec, builtin } of requires) {
    if (builtin) continue;
    if (spec === 'electron' || spec.startsWith('electron/')) throw unavailable(`the native-pipe host depends on Electron through ${current}`);
    if (!spec.startsWith('.')) throw unavailable(`unsupported non-relative original dependency ${JSON.stringify(spec)} in ${current}`);
    found.push(memberFor(current, spec, members));
  }
  return found;
}

/**
 * Read the selected app's app.asar and plan the host extraction without writing anything. `node` runs the
 * structural analyzer; it defaults to the app's own Node, which the protected Store directory does not let
 * LCU execute (the installer passes a private copy).
 */
export function planOriginalHost(app, { node } = {}) {
  const archive = join(app, 'app/resources/app.asar');
  let regular = false;
  try {
    regular = lstatSync(archive).isFile();
  } catch {
    // missing
  }
  if (!regular) throw unavailable('app/resources/app.asar is missing or redirected');
  return planOriginalAsar(archive, { node: node ?? component(app, NODE_MEMBER) });
}

/** The same read-only plan for a bare app.asar: `{main, factory, module, contents: {name: Buffer}, uncarried}`. */
export function planOriginalAsar(archive, { node }) {
  const members = new Set(listAsarMembers(archive));
  const results = [];
  for (const name of [...members].filter((member) => MAIN_PATH.test(member)).sort()) {
    const source = readAsarMembers(archive, [name])[name];
    const response = analyze(node, { op: 'host', source: decode(source, name) });
    if ((response.matches ?? 0) !== 0) results.push([name, response]);
  }
  if (!results.length) {
    throw unavailable('no main bundle has a top-level native-pipe host factory (a function taking codexCliPath, ' +
      'nativePipeDirectory, windowsHelperPath and windowsHelperTransportModulePath options)');
  }
  if (results.length !== 1 || results[0][1].matches !== 1) throw unavailable('more than one top-level native-pipe host factory matches');
  const [main, response] = results[0];
  // Walk the relative-require graph from the generated module's own requirements.
  let queue = [...new Set(localDependencies(main, response.requires, response.imports, members))];
  const contents = {};
  while (queue.length) {
    const batch = queue.filter((name) => !Object.hasOwn(contents, name));
    if (!batch.length) break;
    if (Object.keys(contents).length + batch.length > MAX_CHUNKS) throw unavailable('original dependency graph is unexpectedly large');
    const sources = readAsarMembers(archive, batch);
    const scripts = {};
    for (const name of batch) {
      if (MAIN_PATH.test(name)) throw unavailable(`original dependency graph reaches the main bundle through ${name}`);
      if (name.endsWith('.node')) throw unavailable(`original dependency ${name} is a native module`);
      contents[name] = sources[name];
      if (name.endsWith('.json')) continue;
      if (!name.endsWith('.js') && !name.endsWith('.cjs')) throw unavailable(`original dependency ${name} is not a CommonJS module`);
      scripts[name] = decode(sources[name], name);
    }
    queue = [];
    if (Object.keys(scripts).length) {
      const listed = analyze(node, { op: 'requires', files: scripts }).files;
      for (const name of Object.keys(scripts)) queue.push(...localDependencies(name, listed[name].requires, listed[name].imports, members));
    }
    queue = [...new Set(queue)];
  }
  return { main, factory: response.factory, module: response.module, contents, uncarried: response.uncarried ?? 0 };
}

/** Extract the structurally selected host factory and its exact dependencies; returns the entry path. */
export const materializeOriginalHost = (app, destination, { node } = {}) =>
  writeOriginalHost(planOriginalHost(app, { node }), destination);

/** Write a planned host (generated module, chunks, thin entry) into a new directory; returns the entry path. */
export function writeOriginalHost(plan, destination) {
  const template = readFileSync(join(HERE, 'windows_host_entry.cjs'), 'utf8');
  const marker = '// ORIGINAL_WINDOWS_PIPE_HOST_MODULE';
  if (template.split(marker).length !== 2) throw new Error('Windows host entry marker is missing or ambiguous.');
  // The generated module sits beside the original main bundle, so every original relative require inside it
  // keeps resolving as written.
  const generated = posix.join(posix.dirname(plan.main), GENERATED);
  const entry = template.replace(marker, () => `const createPipeHost = require(${JSON.stringify(`./${generated}`)});`);
  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(destination);
  const write = (name, content) => {
    mkdirSync(dirname(join(destination, name)), { recursive: true });
    writeFileSync(join(destination, name), content);
  };
  for (const [name, content] of Object.entries(plan.contents)) write(name, content);
  write(generated, plan.module);
  write('windows-pipe-host.cjs', entry);
  write('windows-lifetime-host.cjs', readFileSync(join(HERE, 'windows_lifetime_host.cjs')));
  write('windows-sky-service.mjs', readFileSync(join(HERE, 'windows_sky_service.mjs')));
  return join(destination, 'windows-pipe-host.cjs');
}

const PIPE = /^\\\\\.\\pipe\\lcu-wre-/;
const LIFETIME = /^\\\\\.\\pipe\\lcu-lifetime-/;

/** Start the extracted original host and wait for its actual pipe readiness: `{child, pipe, lifetime}`. */
export async function startOriginalHost({ node, entry, helper, transport, env }) {
  if (![node, entry, helper, transport].every(isFile)) throw new Error('The selected original Windows native host is incomplete.');
  const child = spawn(node, [entry], { cwd: dirname(entry), stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...env, LCU_WRE_HELPER_PATH: helper, LCU_WRE_TRANSPORT_PATH: transport } });
  child.stdin.on('error', () => {});
  try {
    const line = await new Promise((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
      child.once('error', reject);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', function ready(chunk) {
        buffered += chunk;
        if (!buffered.includes('\n')) return;
        clearTimeout(timer);
        child.stdout.off('data', ready);
        child.stdout.resume(); // later output is not read
        resolve(buffered.slice(0, buffered.indexOf('\n')));
      });
      child.stdout.once('end', () => { clearTimeout(timer); reject(new Error('closed')); });
    });
    const state = JSON.parse(line);
    const { pipePath: pipe, lifetimePath: lifetime } = state ?? {};
    if (state?.ready !== true || typeof pipe !== 'string' || !PIPE.test(pipe) || pipe.length > 256 ||
        typeof lifetime !== 'string' || !LIFETIME.test(lifetime) || lifetime.length > 256) {
      throw new Error('not ready');
    }
    return { child, pipe, lifetime };
  } catch {
    await stopOriginalHost(child, { requireSuccess: false });
    throw new Error('Original Windows native host failed to become ready.');
  }
}

function exitStatus(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode ?? 1);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), milliseconds);
    child.once('exit', (status) => {
      clearTimeout(timer);
      resolve(status ?? 1);
    });
  });
}

/** Dispose only the host process owned by this LCU MCP connection: close its stdin, then wait (bounded). */
export async function stopOriginalHost(child, { requireSuccess = true } = {}) {
  child.stdin?.end();
  let status = await exitStatus(child, 10_000);
  if (status === undefined) {
    child.kill();
    status = await exitStatus(child, 5_000);
  }
  child.stdout?.destroy();
  if (requireSuccess && status !== 0) throw new Error(`Original Windows native host exited with status ${status ?? 'unknown'}.`);
}
