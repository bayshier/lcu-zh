// Small bounded reader for selected Electron ASAR members.
// Builtins come from process.getBuiltinModule, which skips the per-launch cost of an ESM builtin facade.
const { closeSync, fstatSync, openSync, readSync } = process.getBuiltinModule('node:fs');

const MAX_HEADER_SIZE = 64 * 1024 * 1024;
const MAX_MEMBER_SIZE = 64 * 1024 * 1024;

function readExactly(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const count = readSync(fd, buffer, done, length - done, position + done);
    if (!count) break;
    done += count;
  }
  return buffer.subarray(0, done);
}

function withArchive(archive, use) {
  const fd = openSync(archive, 'r');
  try {
    const size = fstatSync(fd).size;
    const preamble = readExactly(fd, 16, 0);
    if (preamble.length !== 16) throw new Error('ASAR header is truncated.');
    const [sizePayload, headerSize, headerPayload, jsonSize] = [0, 4, 8, 12].map((at) => preamble.readUInt32LE(at));
    const dataOffset = 8 + headerSize;
    if (sizePayload !== 4 || headerSize < 8 || headerPayload !== headerSize - 4 || jsonSize > headerPayload - 4 ||
        jsonSize > MAX_HEADER_SIZE || dataOffset > size) {
      throw new Error('ASAR header is invalid.');
    }
    const encoded = readExactly(fd, jsonSize, 16);
    if (encoded.length !== jsonSize) throw new Error('ASAR header JSON is truncated.');
    let header;
    try {
      header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded));
    } catch {
      throw new Error('ASAR header JSON is invalid.');
    }
    if (!isObject(header) || !isObject(header.files)) throw new Error('ASAR header has no file tree.');
    return use({ fd, header, dataOffset, size });
  } finally {
    closeSync(fd);
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function memberNode(header, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || name.startsWith('/') ||
      name.split('/').some((part) => ['', '.', '..'].includes(part))) {
    throw new Error(`Invalid ASAR member path: ${JSON.stringify(name)}`);
  }
  let node = header;
  for (const part of name.split('/')) {
    node = isObject(node) && isObject(node.files) && Object.hasOwn(node.files, part) ? node.files[part] : undefined;
    if (node === undefined) throw new Error(`ASAR member is missing: ${name}`);
  }
  if (!isObject(node)) throw new Error(`ASAR member entry is invalid: ${name}`);
  return node;
}

/** Member paths from the bounded ASAR header, sorted, without reading payloads. */
export function listAsarMembers(archive) {
  return withArchive(archive, ({ header }) => {
    const result = [];
    const visit = (directory, prefix) => {
      if (!isObject(directory.files)) throw new Error('ASAR directory entry is invalid.');
      for (const [name, node] of Object.entries(directory.files)) {
        if (!name || /[/\\\0]/.test(name) || name === '.' || name === '..' || !isObject(node)) {
          throw new Error('ASAR member path is invalid.');
        }
        const path = prefix ? `${prefix}/${name}` : name;
        if (isObject(node.files)) visit(node, path);
        else result.push(path);
      }
    };
    visit(header, '');
    return result.sort();
  });
}

/** Read named regular packed members after validating their bounds: `{name: Buffer}`. */
export function readAsarMembers(archive, names) {
  return withArchive(archive, ({ fd, header, dataOffset, size: archiveSize }) => {
    const result = {};
    for (const name of names) {
      const node = memberNode(header, name);
      let { offset, size } = node;
      if (typeof offset === 'string') {
        if (!/^\s*[+-]?\d+\s*$/.test(offset)) throw new Error(`ASAR member offset is invalid: ${name}`);
        offset = Number(offset);
      }
      if (node.unpacked || 'link' in node || !Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(size) || size < 0 || size > MAX_MEMBER_SIZE || dataOffset + offset + size > archiveSize) {
        throw new Error(`ASAR member is invalid or out of bounds: ${name}`);
      }
      const content = readExactly(fd, size, dataOffset + offset);
      if (content.length !== size) throw new Error(`ASAR member is truncated: ${name}`);
      result[name] = content;
    }
    return result;
  });
}
