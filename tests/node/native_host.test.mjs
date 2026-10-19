import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';

import { enableAgentHeader, frame, originalHost, readFrames, relay } from '../../lcu/native_host.mjs';
import { REPO, temporary, write } from './fixtures.mjs';

test('a fresh extension reply enables labeled agent requests', () => {
  const original = { jsonrpc: '2.0', id: 7, result: { type: 'extension', agentRequestHeaderEnabled: false, otherCapability: { nested: true } } };
  assert.deepEqual(JSON.parse(enableAgentHeader(Buffer.from(JSON.stringify(original)))),
    { ...original, result: { ...original.result, agentRequestHeaderEnabled: true } });
});

test('other native messages stay byte-identical', () => {
  for (const message of ['{ "result": {"type":"extension", "agentRequestHeaderEnabled":true} }',
    '{ "result": {"type":"other", "agentRequestHeaderEnabled":false} }',
    '{ "method":"event", "params":{"agentRequestHeaderEnabled":false} }', 'not json']) {
    const payload = Buffer.from(message);
    assert.equal(enableAgentHeader(payload), payload);
  }
});

const collect = async (stream) => { const out = []; for await (const payload of readFrames(stream)) out.push(payload); return out; };

test('a framed stream keeps several native messages, and a truncated one fails closed', async () => {
  const messages = ['{"id":1,"result":{"type":"extension","agentRequestHeaderEnabled":false}}', '{"id":2,"result":{"type":"other"}}'];
  const destination = new PassThrough();
  // Split mid-frame to show reassembly.
  const bytes = Buffer.concat(messages.map((message) => frame(Buffer.from(message))));
  await relay(Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]), destination, enableAgentHeader);
  destination.end();
  const [first, second] = await collect(destination);
  assert.equal(JSON.parse(first).result.agentRequestHeaderEnabled, true);
  assert.equal(second.toString(), messages[1]);
  const truncated = Buffer.concat([Buffer.from([20, 0, 0, 0]), Buffer.from('partial')]);
  await assert.rejects(collect(Readable.from([truncated])), /Short native-message body/);
});

test('the original host is selected for each supported platform, and a missing one fails closed', (t) => {
  const base = temporary(t);
  for (const [platform, arch, segment, name] of [['linux', 'x64', 'linux/x64', 'extension-host'],
    ['linux', 'arm64', 'linux/arm64', 'extension-host'], ['darwin', 'arm64', 'macos/arm64', 'ChatGPT for Chrome'],
    ['darwin', 'x64', 'macos/x64', 'ChatGPT for Chrome'], ['win32', 'x64', 'windows/x64', 'extension-host.exe']]) {
    const expected = write(join(base, 'chrome/extension-host', segment, name), 'fixture');
    assert.equal(originalHost(base, platform, arch), expected);
  }
  assert.throws(() => originalHost(join(base, 'elsewhere'), 'darwin', 'arm64'), /original Chrome native host is missing/);
  assert.throws(() => originalHost(base, 'win32', 'arm64'), /supported Linux, macOS, or Windows/);
});

test('a copied relay runs standalone and relays through the original host', (t) => {
  const base = temporary(t);
  const relayCopy = join(base, 'lcu-native-host.mjs');
  copyFileSync(join(REPO, 'lcu/native_host.mjs'), relayCopy);
  const segment = { linux: 'linux', darwin: 'macos' }[process.platform];
  if (!segment) return t.skip('POSIX relay fixture');
  const name = process.platform === 'darwin' ? 'ChatGPT for Chrome' : 'extension-host';
  write(join(base, 'chrome/extension-host', segment, process.arch, name), `#!/bin/sh\nexec cat\n`, 0o755);
  const message = Buffer.from('{"result":{"type":"extension","agentRequestHeaderEnabled":false}}');
  const result = spawnSync(process.execPath, [relayCopy], { input: frame(message) });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(JSON.parse(result.stdout.subarray(4)).result.agentRequestHeaderEnabled, true);
});
