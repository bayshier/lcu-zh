// Shared fixtures for the Node unit tests: disposable directories and hand-made app layouts (no OpenAI code).
import { chmodSync, chownSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sealRecord } from '../../lcu/platforms.mjs';
import { inventoryRecord } from '../../lcu/windows.mjs';
import { VERSION, inventory } from '../../scripts/bundle.mjs';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..');

// macOS signature and Windows inventory records go to scratch files for each test process, never to the
// account's own cache.
const records = realpathSync(mkdtempSync(join(tmpdir(), 'lcu-check-records-')));
sealRecord.path = () => join(records, 'macos-signatures.json');
inventoryRecord.path = () => join(records, 'windows-inventory.json');
process.on('exit', () => rmSync(records, { recursive: true, force: true }));

/**
 * The `skip` option of a test that cannot run on Windows: false elsewhere, the reason (POSIX modes, symlinks,
 * sh stand-ins) on Windows.
 */
export const posixOnly = (reason) => process.platform === 'win32' && `needs POSIX: ${reason}`;

/** node:test's `test` for a file whose tests all need POSIX; on Windows each is skipped with `reason`. */
export function posixTests(reason) {
  if (process.platform !== 'win32') return test;
  return (name, options, fn) => test(name, { ...(typeof options === 'object' ? options : {}), skip: posixOnly(reason) },
    typeof options === 'function' ? options : fn);
}

/** A resolved temporary directory removed after the test. */
export function temporary(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'lcu-test-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

export function write(path, content = '', mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
  return path;
}

/** An Electron ASAR archive holding `members` ({name: Buffer|string}). */
export function writeAsar(path, members) {
  const files = {};
  const payload = [];
  let offset = 0;
  for (const [name, value] of Object.entries(members)) {
    const content = Buffer.from(value);
    const parts = name.split('/');
    let node = files;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= { files: {} }).files;
    node[parts.at(-1)] = { offset: String(offset), size: content.length };
    payload.push(content);
    offset += content.length;
  }
  const header = Buffer.from(JSON.stringify({ files }));
  const preamble = Buffer.alloc(16);
  [4, 8 + header.length, 4 + header.length, header.length].forEach((value, index) => preamble.writeUInt32LE(value, index * 4));
  write(path, Buffer.concat([preamble, header, ...payload]));
}

const EXECUTABLE = '#!/bin/sh\nexit 0\n';

/** A Linux ChatGPT application layout. */
export function linuxApp(root, { version = '26.924.22138', runtimeVersion = 'runtime-new', arch = 'arm64', relocated = false } = {}) {
  write(join(root, 'ChatGPT'), EXECUTABLE, 0o755);
  write(join(root, 'resources/cua_node/bin/node'), EXECUTABLE, 0o755);
  write(join(root, 'resources/cua_node/bin/node_repl'), EXECUTABLE, 0o755);
  write(join(root, 'resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs'), 'export {};\n');
  for (const name of ['codex', 'codex-code-mode-host']) write(join(root, 'resources', relocated ? 'codex-cli/bin' : '', name), EXECUTABLE, 0o755);
  writeAsar(join(root, 'resources/app.asar'), { 'package.json': JSON.stringify({ name: 'chatgpt', version }) });
  write(join(root, 'resources/cua_node/manifest.json'), JSON.stringify({ platform: 'linux', arch, runtime_archive_version: runtimeVersion }));
  const plugins = join(root, 'resources/plugins/openai-bundled/plugins');
  write(join(plugins, 'chrome/.codex-plugin/plugin.json'), '{}\n');
  write(join(plugins, `chrome/extension-host/linux/${arch}/extension-host`), EXECUTABLE, 0o755);
  write(join(plugins, 'unified-computer-use/.mcp.json'), '{}\n');
  write(join(plugins, 'browser/install.js'), '{}\n');
  return realpathSync(root);
}

/** A Linux release `root` whose app link points at a fixture app. */
export function linuxRelease(base, { runtimeVersion = 'fixture-runtime-new' } = {}) {
  const root = join(base, 'releases/release');
  mkdirSync(root, { recursive: true });
  const app = linuxApp(join(base, 'usr/lib/chatgpt'), { runtimeVersion });
  return { root, app };
}

/** Replace a property of `object` for the duration of the test. */
export function override(t, object, name, value) {
  // Only the first override in a test records what to restore, so repeated overrides restore the original.
  const seen = overridden.get(t) ?? new Map();
  overridden.set(t, seen);
  const properties = seen.get(object) ?? new Set();
  seen.set(object, properties);
  if (!properties.has(name)) {
    properties.add(name);
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    t.after(() => (descriptor ? Object.defineProperty(object, name, descriptor) : delete object[name]));
  }
  Object.defineProperty(object, name, { value, configurable: true, writable: true, enumerable: true });
}
const overridden = new WeakMap();

/** Collect what LCU's management commands print (lcu/terminal.mjs) during the test: `{out, err}` strings. */
export async function output(t) {
  const { terminal } = await import('../../lcu/terminal.mjs');
  const seen = { out: '', err: '' };
  override(t, terminal, 'out', (text) => { seen.out += text; });
  override(t, terminal, 'err', (text) => { seen.err += text; });
  return seen;
}

/** A captured child result as lcu/capture.mjs returns it. */
export const result = (status = 0, stdout = '', stderr = '') => ({ status, signal: null, error: undefined, stdout, stderr });

/** Seal a release `root` the way scripts/bundle.py does. */
export function seal(root, arch, target = 'linux') {
  writeFileSync(join(root, 'bundle.json'), JSON.stringify({ format: 1, version: VERSION, platform: target, architecture: arch,
    files: inventory(root, target) }));
}

/**
 * Capture text written to `stream` (process.stdout or process.stderr) with `fn`. Non-string chunks pass through:
 * on some Node releases the test runner reports results over the same stream with binary writes.
 */
export function mockWrite(t, stream, fn) {
  const original = stream.write;
  return t.mock.method(stream, 'write', function write(chunk, ...rest) {
    if (typeof chunk !== 'string') return original.call(this, chunk, ...rest);
    fn(chunk);
    return true;
  });
}

/**
 * Run the rest of a test as a non-root account when the suite runs as root (containers): `dirs` are handed to that
 * uid and process.getuid reports it, so code that treats root specially (root ignores $HOME) takes its normal path.
 */
export function asNonRoot(t, ...dirs) {
  if (process.getuid?.() !== 0) return;
  const uid = 4242;
  for (const dir of dirs) chownSync(dir, uid, uid);
  override(t, process, 'getuid', () => uid);
}
