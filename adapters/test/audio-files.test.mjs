import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { persistAudioContent } from '../audio-files.mjs';

const helperUrl = new URL('../audio-files.mjs', import.meta.url).href;

test('persists mixed audio blocks byte-for-byte in private files and retains result fields', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-audio-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const wav = Buffer.from([0, 1, 2, 127, 128, 255]);
  const mp3 = Buffer.from('original audio bytes\0\xff');
  const image = { type: 'image', data: 'AQID', mimeType: 'image/png', annotations: { tag: 'kept' } };
  const original = {
    isError: false,
    _meta: { source: 'fixture' },
    structuredContent: { retained: true },
    content: [
      { type: 'text', text: 'before' },
      { type: 'audio', data: wav.toString('base64'), mimeType: 'audio/wav' },
      image,
      { type: 'audio', data: mp3.toString('base64'), mimeType: 'audio/mpeg' },
      { type: 'text', text: 'after' },
    ],
  };

  const result = await persistAudioContent(original, directory);

  assert.notEqual(result, original);
  assert.equal(result.isError, false);
  assert.deepEqual(result._meta, original._meta);
  assert.deepEqual(result.structuredContent, original.structuredContent);
  assert.deepEqual(result.content.map(item => item.type), ['text', 'text', 'image', 'text', 'text']);
  assert.equal(result.content[0].text, 'before');
  assert.equal(result.content[2], image);
  assert.equal(result.content[4].text, 'after');
  assert.equal(original.content[1].type, 'audio');

  const expected = [
    { index: 1, bytes: wav, mimeType: 'audio/wav' },
    { index: 3, bytes: mp3, mimeType: 'audio/mpeg' },
  ];
  for (const item of expected) {
    const reference = result.content[item.index].text;
    assert.match(reference, new RegExp(`original MIME type: ${item.mimeType.replace('/', '\\/')}`));
    const match = /saved to (.+)$/.exec(reference);
    assert.ok(match, reference);
    const filePath = match[1];
    assert.equal(isAbsolute(filePath), true);
    assert.deepEqual(readFileSync(filePath), item.bytes);
    // Windows has no POSIX permission bits to check.
    if (process.platform !== 'win32') {
      assert.equal(statSync(filePath).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(filePath)).mode & 0o777, 0o700);
    }
  }
});

test('audio files remain readable after the writing process exits', t => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-audio-child-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from([82, 73, 70, 70, 0, 255, 10]);
  const script = `
    import { persistAudioContent } from ${JSON.stringify(helperUrl)};
    const result = await persistAudioContent({ content: [{
      type: 'audio', data: ${JSON.stringify(bytes.toString('base64'))}, mimeType: 'audio/wav'
    }] }, ${JSON.stringify(directory)});
    console.log(result.content[0].text);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const match = /saved to (.+)$/.exec(child.stdout.trim());
  assert.ok(match, child.stdout);
  assert.deepEqual(readFileSync(match[1]), bytes);
});

test('normal results pass through unchanged without creating audio files', async () => {
  const original = {
    isError: false,
    _meta: { source: 'fixture' },
    content: [{ type: 'text', text: 'unchanged' }],
  };
  assert.equal(await persistAudioContent(original), original);
});
