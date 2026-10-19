#!/usr/bin/env python3
"""Fail if a release archive carries an OpenAI app payload.

Every file is compared against the official component checksums in
runtime.lock.json and against the app's own layout names, so a copied app
file is caught by content or by path.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile
import zipfile

SOURCE = Path(__file__).resolve().parents[1]
FORBIDDEN_NAMES = {'app.asar', 'app.asar.unpacked', 'node_repl', 'codex', 'codex.exe',
                   'codex-code-mode-host', 'extension-host', 'extension-host.exe', 'cua_node',
                   'openai-bundled'}
FORBIDDEN_SUFFIXES = {'.asar', '.deb', '.msix', '.msixbundle', '.appx'}
FORBIDDEN_PREFIXES = ('instructions/', 'skills/lcu/references/', 'lcu/host/')


def official_digests(lock):
    digests = {entry['sha256'] for entry in lock.get('architectures', {}).values()}
    for entry in lock.get('architectures', {}).values():
        digests.update(entry.get('components', {}).values())
    for platform in lock.get('platforms', {}).values():
        for entry in platform.get('architectures', {}).values():
            if isinstance(entry, dict):
                digests.update(value for value in entry.get('components', {}).values()
                               if isinstance(value, str))
    return digests


def members(archive):
    if archive.suffix == '.zip':
        with zipfile.ZipFile(archive) as bundle:
            for info in bundle.infolist():
                if not info.is_dir():
                    yield info.filename, bundle.read(info)
    else:
        with tarfile.open(archive) as bundle:
            for info in bundle:
                stream = bundle.extractfile(info) if info.isfile() else None
                yield info.name, stream.read() if stream else None


def problems(archive, digests):
    for name, content in members(archive):
        relative = PurePosixPath(*PurePosixPath(name).parts[1:])
        parts = set(relative.parts)
        if parts & FORBIDDEN_NAMES or relative.suffix in FORBIDDEN_SUFFIXES \
                or relative.as_posix().startswith(FORBIDDEN_PREFIXES):
            yield f'{name}: app payload path'
        elif content is not None and hashlib.sha256(content).hexdigest() in digests:
            yield f'{name}: matches an official app component checksum'


def main(paths):
    if not paths:
        sys.exit('usage: check_archive.py ARCHIVE...')
    digests = official_digests(json.loads((SOURCE / 'runtime.lock.json').read_text(encoding='utf-8')))
    failed = False
    for path in map(Path, paths):
        found = list(problems(path, digests))
        for problem in found:
            print(problem, file=sys.stderr)
        failed |= bool(found)
        print(f'{path.name}: {"FAIL" if found else "ok"}')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main(sys.argv[1:])
