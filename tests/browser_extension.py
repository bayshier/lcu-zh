"""Build-only acquisition of a pinned public extension for isolated browser tests."""
import base64
import hashlib
import json
from pathlib import Path
import struct
import sys
from urllib.request import urlopen
import zipfile

EXTENSION_ID = 'hehggadaopoacecdllhhajmbjkdcmajg'
VERSION = '1.26.901.11451'
SHA256 = '688d5c0a8141c9bee394d3738d4a177b448713c2fa9c29b5af1815bfddae46e1'
URL = ('https://clients2.google.com/service/update2/crx?response=redirect&prodversion=143.0.7499.4'
       '&acceptformat=crx3&x=id%3D' + EXTENSION_ID + '%26uc')


def fields(data):
    offset = 0
    def varint():
        nonlocal offset
        result = shift = 0
        while True:
            value = data[offset]
            offset += 1
            result |= (value & 127) << shift
            if not value & 128:
                return result
            shift += 7
    while offset < len(data):
        tag = varint()
        if tag & 7 == 2:
            length = varint()
            value = data[offset:offset + length]
            offset += length
        elif tag & 7 == 0:
            value = varint()
        else:
            raise ValueError('Unsupported CRX header field')
        yield tag >> 3, value


def prepare(archive, destination):
    raw = archive.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SHA256:
        raise ValueError('Official extension changed; audit the new artifact before changing the pin')
    if raw[:8] != b'Cr24\x03\x00\x00\x00':
        raise ValueError('Expected CRX3')
    header_size = struct.unpack('<I', raw[8:12])[0]
    key = None
    for number, value in fields(raw[12:12 + header_size]):
        if number in (2, 3):
            candidate = dict(fields(value))[1]
            identity = ''.join(chr(int(digit, 16) + 97)
                               for digit in hashlib.sha256(candidate).hexdigest()[:32])
            if identity == EXTENSION_ID:
                key = candidate
    if key is None:
        raise ValueError('Original extension public key missing')
    with zipfile.ZipFile(archive) as source:
        for item in source.infolist():
            if item.filename.startswith('/') or '..' in Path(item.filename).parts:
                raise ValueError('Unsafe extension archive path')
        source.extractall(destination)
    manifest = destination / 'manifest.json'
    contents = json.loads(manifest.read_text())
    if contents['version'] != VERSION:
        raise ValueError('Unexpected extension version')
    # Preserve the signed ID when Chromium loads this disposable unpacked fixture.
    # No executable extension code is changed.
    contents['key'] = base64.b64encode(key).decode()
    manifest.write_text(json.dumps(contents, indent=2) + '\n')


if __name__ == '__main__':
    archive, destination = map(Path, sys.argv[1:])
    if not archive.exists():
        with urlopen(URL, timeout=60) as response:
            archive.write_bytes(response.read())
    prepare(archive, destination)
