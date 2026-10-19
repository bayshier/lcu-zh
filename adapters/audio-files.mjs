import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const AUDIO_EXTENSIONS = new Map([
  ['audio/aac', '.aac'],
  ['audio/flac', '.flac'],
  ['audio/mp3', '.mp3'],
  ['audio/mp4', '.m4a'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['audio/opus', '.opus'],
  ['audio/wav', '.wav'],
  ['audio/wave', '.wav'],
  ['audio/webm', '.webm'],
  ['audio/x-m4a', '.m4a'],
  ['audio/x-wav', '.wav'],
]);

function decodeAudio(data) {
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
      (data.includes('=') && data.length % 4 !== 0)) {
    throw new TypeError('Original CUA audio data must be valid base64');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) {
    throw new TypeError('Original CUA audio data must be valid base64');
  }
  return bytes;
}

function extensionFor(mimeType) {
  const mediaType = mimeType.split(';', 1)[0].trim().toLowerCase();
  return AUDIO_EXTENSIONS.get(mediaType) ?? '.audio';
}

/**
 * Replace MCP audio blocks with references to retained temporary files
 * containing the exact decoded bytes. Results without audio pass through untouched.
 *
 * @template { { content?: unknown[] } } T
 * @param {T} result
 * @param {string} [directory]
 * @returns {Promise<T>}
 */
export async function persistAudioContent(result, directory) {
  if (!Array.isArray(result?.content)) return result;

  const audioBlocks = result.content.filter(block => block?.type === 'audio');
  if (audioBlocks.length === 0) return result;

  const audio = audioBlocks.map(block => {
    if (typeof block.mimeType !== 'string') {
      throw new TypeError('Original CUA audio content is missing its MIME type');
    }
    return { block, bytes: decodeAudio(block.data) };
  });

  const parentDirectory = resolve(directory ?? tmpdir());
  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  const privateDirectory = await mkdtemp(join(parentDirectory, 'lcu-audio-'));
  let audioIndex = 0;
  try {
    await chmod(privateDirectory, 0o700);
    const content = [];
    for (const block of result.content) {
      if (block?.type !== 'audio') {
        content.push(block);
        continue;
      }

      const current = audio[audioIndex];
      const filePath = join(privateDirectory, `audio-${audioIndex + 1}${extensionFor(current.block.mimeType)}`);
      await writeFile(filePath, current.bytes, { flag: 'wx', mode: 0o600 });
      const metadata = { ...block };
      delete metadata.data;
      delete metadata.mimeType;
      delete metadata.type;
      content.push({
        ...metadata,
        type: 'text',
        text: `Audio result (original MIME type: ${current.block.mimeType}) saved to ${filePath}`,
      });
      audioIndex += 1;
    }
    return { ...result, content };
  } catch (error) {
    await rm(privateDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
