#!/usr/bin/env python3
"""Build a thin LCU archive; setup requires an app already installed locally."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile

sys.dont_write_bytecode = True
from bundle import VERSION, architecture, seal, verify
from provision_agent_tools import provision as provision_agents

SOURCE = Path(__file__).resolve().parents[1]

# The docs/*.md set shipped in every archive; README rounds out the reachable
# roots for verification-record selection.
SHIPPED_DOCS = ('INSTALLATION.md', 'DEVELOPMENT.md', 'INSTRUCTIONS.md',
                'VERIFICATION.md', 'PROVENANCE.md', 'PARITY-STATUS.md',
                'STANDALONE-ADAPTATIONS.md', 'ADAPTERS.md')
_LINK = re.compile(r'\]\(([^)]+)\)')


def linked_docs(source):
    """Documents under docs/ reachable by relative .md links from the shipped docs.

    Shipping only the transitive closure keeps every relative document link in
    the archive resolvable while dropping records nothing links to.
    """
    source = Path(source)
    docs = (source / 'docs').resolve()
    roots = [source / 'README.md', *(source / 'docs' / name for name in SHIPPED_DOCS)]
    seen, linked, stack = set(), set(), [path.resolve() for path in roots]
    while stack:
        path = stack.pop()
        if path in seen or not path.is_file():
            continue
        seen.add(path)
        for match in _LINK.finditer(path.read_text(encoding='utf-8')):
            target = match.group(1).split('#', 1)[0].strip()
            if not target or '://' in target or target.startswith('mailto:'):
                continue
            resolved = (path.parent / target).resolve()
            if resolved.suffix == '.md' and resolved.is_relative_to(docs):
                linked.add(resolved)
                stack.append(resolved)
    return linked


def linked_verification_records(source):
    verification = (Path(source) / 'docs/verification').resolve()
    return {path for path in linked_docs(source) if path.parent == verification}


OWNER_AUTH = 'lcu-owner-auth'

# lcu/ modules that ship on one platform only; every other module ships everywhere.
PLATFORM_MODULES = {
    'linux_sky_service.mjs': 'linux', 'x11.mjs': 'linux',
    'macos_host.mjs': 'darwin', 'macos_sky_service.mjs': 'darwin',
    'windows_host.mjs': 'windows', 'windows_host_analyze.cjs': 'windows', 'windows_host_entry.cjs': 'windows',
    'windows_lifetime_host.cjs': 'windows', 'windows_sky_service.mjs': 'windows',
}
POSIX_MODULES = {'session.mjs'}
# The installers. install.py (Linux), install_macos.py and install_windows.py are logic-free stubs that LCU
# 0.9.7's `lcu update` runs with its own Python on that platform; they hand over to the Node installer.
SHIPPED_SCRIPTS = {
    'linux': ('install.sh', 'install.mjs', 'install-usage.txt', 'bundle.mjs', 'install.py'),
    'darwin': ('install.sh', 'install.mjs', 'install-usage.txt', 'bundle.mjs', 'install_macos.py'),
    'windows': ('install.ps1', 'install_windows.mjs', 'bundle.mjs', 'windows_launcher.mjs', 'install_windows.py'),
}


def build_owner_auth(destination):
    """Compile LCU's own owner-authentication helper (used by `lcu apps`) for this Mac.

    The helper is ad-hoc signed (swiftc's linker signs it); it is LCU's code, not an OpenAI binary.
    """
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['swiftc', '-O', str(SOURCE / 'scripts/native' / (OWNER_AUTH + '.swift')),
                    '-o', str(destination)], check=True, timeout=300)
    subprocess.run(['codesign', '--force', '--sign', '-', '--identifier', 'org.amontlabs.lcu-owner-auth',
                    str(destination)], check=True, timeout=60,
                   capture_output=True)
    os.chmod(destination, 0o755)


def resolve_mac_app(app, arch):
    """The CUA runtime directory of a compatible signed ChatGPT.app, checked by LCU's own Node validator."""
    node = Path(app) / 'Contents/Resources/cua_node/bin/node'
    script = ('const { resolveInstalledMacApp } = await import(process.argv[1]); '
              'console.log(resolveInstalledMacApp(process.argv[2], { arch: process.argv[3] }).runtime);')
    result = subprocess.run([str(node), '--input-type=module', '-e', script, (SOURCE / 'lcu/platforms.mjs').as_uri(),
                             str(app), arch], capture_output=True, text=True, timeout=300)
    if result.returncode:
        raise ValueError(f'The ChatGPT app cannot be used for a macOS build: {result.stderr.strip()}')
    return Path(result.stdout.strip())


def build(output, package=None, *, target='linux', app=None):
    if package is not None:
        raise ValueError('Build-time --package is retired. Install the official app separately before LCU setup.')
    # The Windows archive contains only platform-neutral LCU source and locked
    # JavaScript dependencies. Build it on a trusted development host; the
    # Windows installer validates the registered official MSIX in place.
    arch = 'x64' if target == 'windows' else architecture(target)
    selected_node = None
    if target == 'darwin':
        policy = json.loads((SOURCE / 'runtime.lock.json').read_text())['platforms']['darwin']
        if arch not in policy.get('architectures', {}):
            raise ValueError(f'This LCU release does not support macOS {arch}.')
        selected_node = resolve_mac_app(app or Path('/Applications/ChatGPT.app'), arch) / 'bin/node'
    elif target not in ('linux', 'windows') or app is not None:
        raise ValueError('An installed application path is supported only for a macOS build.')
    output.mkdir(parents=True, exist_ok=True)
    name = f'lcu-{VERSION}-{target}-{arch}'
    destination = output / (name + ('.zip' if target == 'windows' else '.tar.gz'))
    if destination.exists() or destination.with_suffix(destination.suffix + '.sha256').exists():
        raise ValueError(f'Release already exists: {destination}; use a new output directory.')
    with tempfile.TemporaryDirectory(prefix='lcu-build-') as temporary:
        scratch = Path(temporary)
        release = scratch / name
        release.mkdir()
        # bin/lcu and bin/lcu-session are POSIX sh launchers; Windows runs lcu.cmd.
        ignored = ['*.cmd'] if target != 'windows' else ['lcu', 'lcu-session']
        if target != 'linux':
            ignored.append('lcu-codex-sandbox')
        shutil.copytree(SOURCE / 'bin', release / 'bin', ignore=shutil.ignore_patterns(*ignored))
        (release / 'lcu').mkdir()
        for path in sorted((SOURCE / 'lcu').iterdir()):
            if path.is_file() and path.suffix in ('.mjs', '.cjs', '.txt') and \
                    PLATFORM_MODULES.get(path.name, target) == target and \
                    not (target == 'windows' and path.name in POSIX_MODULES):
                shutil.copy2(path, release / 'lcu' / path.name)
        if target == 'darwin':
            build_owner_auth(release / 'bin' / OWNER_AUTH)
        elif target == 'windows':
            # The pinned acorn parser the Windows host analyzer uses (see docs/PROVENANCE.md).
            shutil.copytree(SOURCE / 'lcu/vendor/acorn', release / 'lcu/vendor/acorn')
        (release / 'docs').mkdir()
        for filename in SHIPPED_DOCS:
            shutil.copy2(SOURCE / 'docs' / filename, release / 'docs' / filename)
        # Ship only documents the shipped docs link to (transitively), so every
        # relative document link resolves without carrying unlinked records.
        docs = (SOURCE / 'docs').resolve()
        for document in sorted(linked_docs(SOURCE)):
            if document.is_symlink():
                raise ValueError(f'Linked document cannot be a symlink: {document}')
            shipped = release / 'docs' / document.relative_to(docs)
            shipped.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(document, shipped)
        for filename in ('README.md', 'LICENSE', 'runtime.lock.json', 'tested-versions.json'):
            shutil.copy2(SOURCE / filename, release / filename)
        (release / 'scripts').mkdir()
        for filename in SHIPPED_SCRIPTS[target]:
            shutil.copy2(SOURCE / 'scripts' / filename, release / 'scripts' / filename)
        provision_agents(release, SOURCE / 'scripts/agent-tools', target=target,
                         mac_node=selected_node, adapters_source=SOURCE / 'adapters')
        # Every shipped module must at least parse; the Node that checks it is the build host's own.
        node = shutil.which('node')
        if node is None:
            raise ValueError('The build needs node on PATH to check the shipped modules.')
        for module in sorted([*release.glob('lcu/*.mjs'), *release.glob('scripts/*.mjs')]):
            subprocess.run([node, '--check', str(module)], check=True, timeout=20)
        seal(release, arch, target)
        verify(release, arch, target)
        fd, temporary_archive = tempfile.mkstemp(prefix='.lcu-', suffix=destination.suffix, dir=output)
        os.close(fd)
        try:
            if target == 'windows':
                with zipfile.ZipFile(temporary_archive, 'w', compression=zipfile.ZIP_DEFLATED,
                                     compresslevel=6) as archive:
                    for path in sorted(release.rglob('*')):
                        if path.is_symlink():
                            raise ValueError(f'Windows bundle cannot contain a symlink: {path}')
                        if path.is_file():
                            archive.write(path, arcname=(Path(name) / path.relative_to(release)).as_posix())
            else:
                with tarfile.open(temporary_archive, 'w:gz', compresslevel=6) as archive:
                    archive.add(release, arcname=name)
            os.chmod(temporary_archive, 0o644)
            os.replace(temporary_archive, destination)
        finally:
            Path(temporary_archive).unlink(missing_ok=True)
    with destination.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    destination.with_suffix(destination.suffix + '.sha256').write_text(f'{digest}  {destination.name}\n')
    print(destination)
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=SOURCE / 'dist')
    parser.add_argument('--package', type=Path, help='Retired; install the official app separately before LCU setup')
    parser.add_argument('--platform', choices=('linux', 'darwin', 'windows'), default='linux')
    parser.add_argument('--app', type=Path, help='Pinned locally installed ChatGPT.app for a macOS build')
    args = parser.parse_args()
    try:
        if sys.version_info < (3, 12):
            raise ValueError('Python 3.12 or later is required')
        build(args.output.resolve(), args.package.resolve() if args.package else None,
              target=args.platform, app=args.app)
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        sys.exit(f'LCU build: {exc}')
