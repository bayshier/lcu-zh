"""Build-time release inventory: seal an LCU release, and download test package fixtures.

Not shipped. Installed releases are verified by scripts/bundle.mjs, which also holds VERSION; the
inventory here must stay identical to the one there (tests/test_bundle.py checks both against each other).
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
from urllib.request import Request, urlopen

_NODE_BUNDLE = Path(__file__).resolve().parent / 'bundle.mjs'
VERSION = re.search(r"^export const VERSION = '([^']+)';$", _NODE_BUNDLE.read_text(), re.MULTILINE).group(1)


def architecture(target='linux'):
    arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}.get(platform.machine().lower())
    expected = {'linux': 'Linux', 'darwin': 'Darwin', 'windows': 'Windows'}.get(target)
    if expected is None or platform.system() != expected or arch is None or (target == 'windows' and arch != 'x64'):
        raise ValueError(f'LCU requires {target} ARM64 or x86-64.')
    return arch


def inventory(root, target='linux'):
    root = root.resolve()
    files = {}
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        if relative == 'bundle.json':
            continue
        if path.is_symlink():
            link = os.readlink(path)
            if Path(link).is_absolute() or not path.resolve().is_relative_to(root):
                raise ValueError(f'Unsafe bundle symlink: {relative}')
            files[relative] = {'type': 'symlink', 'target': link}
        elif path.is_file():
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            entry = {'type': 'file', 'sha256': digest}
            if target != 'windows':
                entry['mode'] = path.stat().st_mode & 0o777
            files[relative] = entry
        elif not path.is_dir():
            raise ValueError(f'Unsupported bundle entry: {relative}')
    return files


def seal(root, arch, target='linux'):
    manifest = {'format': 1, 'version': VERSION, 'platform': target, 'architecture': arch,
                'files': inventory(root, target)}
    (root / 'bundle.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')


def verify(root, arch, target='linux'):
    """The build's own check of what it sealed."""
    path = root / 'bundle.json'
    if not path.is_file() or path.is_symlink():
        raise ValueError('The release has no bundle.json.')
    manifest = json.loads(path.read_text())
    if (not isinstance(manifest, dict) or manifest.get('format') != 1 or manifest.get('platform') != target
            or manifest.get('version') != VERSION or manifest.get('architecture') != arch
            or manifest.get('files') != inventory(root, target)):
        raise ValueError('LCU bundle integrity check failed.')
    return manifest


def download_fixture(lock, entry, destination):
    """Fetch the pinned official package as a development/test fixture; LCU's installer never downloads it."""
    url = lock['source'].format(deb_arch=entry['deb_arch'])
    digest = hashlib.sha256()
    try:
        with urlopen(Request(url, headers={'User-Agent': 'lcu-dev'}), timeout=60) as response, \
                destination.open('xb') as output:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    if digest.hexdigest() != entry['sha256']:
        destination.unlink(missing_ok=True)
        raise ValueError('Official application package checksum mismatch; refusing to extract it')
