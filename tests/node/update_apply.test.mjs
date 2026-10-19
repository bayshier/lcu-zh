import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import * as apply from '../../lcu/update_apply.mjs';
import { override, temporary, write } from './fixtures.mjs';

const INFO = { version: '0.9.2', tag: 'v0.9.2', release_url: 'https://example.invalid/r', severity: 'normal' };
const linux = process.platform === 'linux';

/**
 * A gzip-compressed ustar archive of `[name, value]`: a string is a file; `{symlink}`, `{link}` (hard),
 * `{device: '3'|'4'|'6'}` (character, block, FIFO) make other entries, and `{data, mode}` a file with a mode.
 */
function tarGz(entries) {
  const blocks = [];
  for (const [name, value] of entries) {
    const header = Buffer.alloc(512);
    const content = typeof value === 'string' ? value : value.data;
    const type = content !== undefined ? '0' : value.symlink !== undefined ? '2' : value.link !== undefined ? '1' : value.device;
    const data = Buffer.from(content ?? '');
    header.write(name, 0, 100);
    header.write(`${(value.mode ?? 0o755).toString(8).padStart(7, '0')}\0`, 100);
    header.write(data.length.toString(8).padStart(11, '0'), 124);
    header.write('00000000000', 136);
    header.write(type, 156);
    if (type === '1' || type === '2') header.write(value.symlink ?? value.link, 157, 100);
    header.write('ustar\x0000', 257);
    header.fill(' ', 148, 156);
    header.write(`${[...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const release = (name = 'lcu-0.9.2-linux-x64', extra = []) =>
  tarGz([[`${name}/bundle.json`, '{}'], [`${name}/scripts/install.mjs`, '//'], ...extra]);

/** An installed 0.9.1 release in a prefix. */
function installed(t, { platform = 'linux', arch = 'x64', app, bundle = true } = {}) {
  const base = temporary(t);
  const prefix = join(base, 'opt/lcu');
  const root = join(prefix, 'releases/0.9.1-abcdef012345');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(prefix, '.lcu-install'), '');
  write(join(root, 'installation.json'), JSON.stringify({ platform, architecture: arch, ...(app ? { app } : {}) }));
  if (bundle) write(join(root, 'bundle.json'), JSON.stringify({ version: '0.9.1', architecture: arch }));
  const errors = [];
  override(t, apply.deps, 'interactive', () => false);
  override(t, apply.deps, 'uid', () => 1000);
  override(t, apply.deps, 'report', (text) => errors.push(text));
  override(t, apply.deps, 'print', () => {});
  return { base, prefix, root, errors };
}

/** Apply with `archive` served as the release asset; returns `[status, commands]`. */
async function run(t, root, archive, { yes = true, status = 0, checksum } = {}) {
  const commands = [];
  override(t, apply.deps, 'download', async (url, file) => {
    writeFileSync(file, archive);
    return createHash('sha256').update(archive).digest('hex');
  });
  override(t, apply.deps, 'text', async (url) =>
    `${checksum ?? createHash('sha256').update(archive).digest('hex')}  ${url.split('/').at(-1).slice(0, -7)}\n`);
  override(t, apply.deps, 'run', (command) => { commands.push(command); return status; });
  return [await apply.apply(root, INFO, { yes }), commands];
}

test('asset names and checksum files', () => {
  assert.equal(apply.assetName('0.9.2', 'darwin', 'arm64'), 'lcu-0.9.2-darwin-arm64.tar.gz');
  assert.equal(apply.assetName('0.9.2', 'windows', 'x64'), 'lcu-0.9.2-windows-x64.zip');
  assert.throws(() => apply.assetName('0.9.2', 'freebsd', 'x64'), /No LCU release archive/);
  const digest = 'a'.repeat(64);
  assert.equal(apply.expectedSha256(`${digest}  f.tar.gz\n`, 'f.tar.gz'), digest);
  assert.equal(apply.expectedSha256(`${digest} *f.tar.gz\n`, 'f.tar.gz'), digest);
  assert.throws(() => apply.expectedSha256(`${digest}  other.tar.gz\n`, 'f.tar.gz'), /Malformed checksum/);
});

test('a source checkout, a release outside a prefix or a linked prefix marker is refused', async (t) => {
  const { root, base, prefix } = installed(t, { bundle: false });
  assert.deepEqual(await run(t, root, release()), [1, []]);
  const loose = join(base, 'loose');
  write(join(loose, 'bundle.json'), '{}');
  assert.deepEqual(await run(t, loose, release()), [1, []]);
  writeFileSync(join(root, 'bundle.json'), JSON.stringify({ version: '0.9.1', architecture: 'x64' }));
  const marker = join(prefix, '.lcu-install');
  rmSync(marker);
  mkdirSync(marker);
  assert.deepEqual(await run(t, root, release()), [1, []]);
});

test('without --yes and a terminal nothing is downloaded', async (t) => {
  const { root } = installed(t);
  override(t, apply.deps, 'download', async () => assert.fail('downloaded'));
  override(t, apply.deps, 'run', () => assert.fail('ran'));
  assert.equal(await apply.apply(root, INFO, { yes: false }), 2);
});

test('a checksum mismatch stops before extraction', { skip: !linux }, async (t) => {
  const { root } = installed(t);
  assert.deepEqual(await run(t, root, release(), { checksum: '0'.repeat(64) }), [1, []]);
});

test('archives that would write outside the release are refused, and nothing lands outside', { skip: !linux }, async (t) => {
  const top = 'lcu-0.9.2-linux-x64';
  const cases = {
    'symlink chain': [[`${top}/l`, { symlink: '.' }], [`${top}/x`, { symlink: 'l/../..' }], [`${top}/x/evil`, 'x']],
    'link then write': [[`${top}/up`, { symlink: '..' }], [`${top}/up/evil`, 'x']],
    'absolute path': [['/tmp/lcu-evil-absolute', 'x']],
    'parent path': [[`${top}/../evil`, 'x']],
    'absolute link': [[`${top}/link`, { symlink: '/etc/passwd' }]],
    'escaping link': [[`${top}/link`, { symlink: '../../outside' }]],
    'hardlink escape': [[`${top}/hard`, { link: '../outside' }]],
    'hardlink to a non-member': [[`${top}/hard`, { link: 'etc/passwd' }]],
    device: [[`${top}/null`, { device: '3' }]],
    fifo: [[`${top}/pipe`, { device: '6' }]],
  };
  for (const [label, extra] of Object.entries(cases)) {
    const { root, base } = installed(t);
    assert.deepEqual(await run(t, root, release(top, extra)), [1, []], label);
    assert.deepEqual(readdirSync(base).sort(), ['opt'], label);
  }
  assert.equal(existsSync('/tmp/lcu-evil-absolute'), false);
});

test('a zip with a symlink is refused before extraction', (t) => {
  override(t, apply.deps, 'tar', (args) => ({ status: 0, stdout: args[0] === '-tf'
    ? 'r/\nr/bundle.json\nr/link\n'
    : 'drwxr-xr-x  0 0 0 0 Oct  8 12:00 r/\n-rw-r--r--  0 0 0 2 Oct  8 12:00 r/bundle.json\nlrwxr-xr-x  0 0 0 0 Oct  8 12:00 r/link -> bundle.json\n' }));
  assert.throws(() => apply.extract('release.zip', temporary(t)), /link escapes the release: r\/link/);
});

test('extraction keeps files, modes and inside links, and clears special and group/other write bits', { skip: !linux }, (t) => {
  const base = temporary(t);
  const archive = join(base, 'r.tar.gz');
  writeFileSync(archive, tarGz([['r/bin/lcu', '#!/bin/sh\n'], ['r/bin/alias', { symlink: 'lcu' }], ['r/copy', { link: 'r/bin/lcu' }],
    ['r/setuid', { data: 'x', mode: 0o4777 }], ['r/private', { data: 'x', mode: 0o400 }]]));
  const out = join(base, 'out');
  mkdirSync(out);
  apply.extract(archive, out);
  assert.equal(readFileSync(join(out, 'r/bin/alias'), 'utf8'), '#!/bin/sh\n');
  assert.equal(readFileSync(join(out, 'r/copy'), 'utf8'), '#!/bin/sh\n');
  assert.ok(lstatSync(join(out, 'r/bin/alias')).isSymbolicLink());
  assert.equal(statSync(join(out, 'r/bin/lcu')).mode & 0o7777, 0o755);
  assert.equal(statSync(join(out, 'r/setuid')).mode & 0o7777, 0o755);
  assert.equal(statSync(join(out, 'r/private')).mode & 0o7777, 0o600);
});

test('symlink resolution follows the archive’s own links', () => {
  const links = new Map([['top/l', '.'], ['top/x', 'l/../..']]);
  assert.equal(apply.escapes('top/l/../..', links), true);
  assert.equal(apply.escapes('top/x', links), true);
  assert.equal(apply.escapes('top/l/a', links), false);
  assert.equal(apply.escapes('top/loop', new Map([['top/loop', 'loop']])), true);
});

test('Linux runs the new Node installer for the same app, then the new release refreshes integrations', { skip: !linux }, async (t) => {
  const app = join(temporary(t), 'chatgpt');
  mkdirSync(app);
  const { root, prefix } = installed(t, { app });
  const [status, commands] = await run(t, root, release('lcu-0.9.2-linux-x64', [['lcu-0.9.2-linux-x64/bin/lcu', '#!/bin/sh\n']]));
  assert.equal(status, 0);
  assert.equal(commands[0][0], process.execPath);
  assert.match(commands[0][1], /lcu-0\.9\.2-linux-x64\/scripts\/install\.mjs$/);
  assert.deepEqual(commands[0].slice(2), ['--prefix', prefix, '--runtime-only', '--existing-app', app, '--skip-system']);
  assert.deepEqual(commands[1], [join(prefix, 'current/bin/lcu'), 'update', '--post-install']);
});

test('macOS and Windows installer commands', () => {
  assert.deepEqual(apply.installerCommand('darwin', '/p', { app: '/' }, '/s', 'node'),
    ['node', join('/s', 'scripts/install.mjs'), '--prefix', '/p', '--runtime-only', '--existing-app', '/']);
  assert.deepEqual(apply.installerCommand('windows', '/p', {}, '/s', 'node'),
    ['node', join('/s', 'scripts/install_windows.mjs'), '--prefix', '/p', '--runtime-only']);
});

test('an installer failure is returned and nothing else runs', { skip: !linux }, async (t) => {
  const { root } = installed(t);
  const [status, commands] = await run(t, root, release(), { status: 7 });
  assert.equal(status, 7);
  assert.equal(commands.length, 1);
});

test('an unwritable Linux prefix keeps the verified release and prints the sudo command', { skip: !linux }, async (t) => {
  const { root, errors } = installed(t);
  override(t, apply.deps, 'writable', () => false);
  assert.deepEqual(await run(t, root, release()), [1, []]);
  assert.match(errors.join(''), /not writable by this account[\s\S]*sudo .*install\.mjs .*--user/);
});
