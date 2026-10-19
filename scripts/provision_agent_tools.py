#!/usr/bin/env python3
"""Install private, integrity-pinned upstream agent installers in a new release."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
from urllib.request import urlopen

NODE_VERSION = '24.21.0'
# Official https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
NODE_SHA256 = {
    'arm64': '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2',
    'x64': 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
}


def download(url, destination, expected):
    digest = hashlib.sha256()
    with urlopen(url, timeout=30) as response, destination.open('xb') as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise ValueError('Node download integrity check failed; refusing to execute it.')


def provision(release, source, *, target='linux', mac_node=None, adapters_source=None):
    architecture = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}.get(platform.machine())
    expected_system = {'linux': 'Linux', 'darwin': 'Darwin'}.get(target)
    if (target != 'windows' and (expected_system is None or platform.system() != expected_system or architecture is None)):
        raise ValueError(f'Agent installer runtime requires {target} arm64 or x64.')
    destination = release / 'agent-tools'
    destination.mkdir()
    # Keep download/cache off /tmp (often a small tmpfs in VM images).
    try:
        with tempfile.TemporaryDirectory(prefix='.agent-tools-', dir=release) as temporary:
            scratch = Path(temporary)
            if target == 'linux':
                name = f'node-v{NODE_VERSION}-linux-{architecture}'
                archive = scratch / 'node.tar.xz'
                download(f'https://nodejs.org/dist/v{NODE_VERSION}/{name}.tar.xz', archive, NODE_SHA256[architecture])
                with tarfile.open(archive, 'r:xz') as bundle:
                    bundle.extractall(scratch, filter='data')
                (scratch / name).rename(destination / 'node')
                node = destination / 'node/bin/node'
                npm = destination / 'node/lib/node_modules/npm/bin/npm-cli.js'
            else:
                node_command = shutil.which('node') if target == 'windows' else None
                node = Path(node_command).resolve() if node_command else (
                    Path(mac_node) if mac_node is not None else None)
                npm_command = shutil.which('npm')
                npm = Path(npm_command).resolve() if npm_command else None
                if os.name == 'nt' and target == 'windows' and node is not None:
                    # Windows npm is a .cmd shim; Node runs the CLI script beside node.exe.
                    npm = node.parent / 'node_modules/npm/bin/npm-cli.js'
                if node is None or not node.is_file() or not os.access(node, os.X_OK):
                    raise ValueError('A local Node executable is required to build these locked JavaScript tools.')
                if npm is None or not npm.is_file():
                    raise ValueError('A local npm CLI is required to build the agent tools.')
            for filename in ('package.json', 'package-lock.json'):
                shutil.copyfile(source / filename, destination / filename)
            # Do not read caller npmrc, use their cache, or install globally.
            environment = {
                'PATH': str(node.parent) + os.pathsep + os.environ.get('PATH', ''),
                'HOME': str(scratch), 'LANG': 'C.UTF-8',
                'NPM_CONFIG_USERCONFIG': str(scratch / 'empty.npmrc'),
                'NPM_CONFIG_GLOBALCONFIG': str(scratch / 'global.npmrc'),
                'NPM_CONFIG_UPDATE_NOTIFIER': 'false',
            }
            if os.name == 'nt':
                # Node cannot initialize its CSPRNG on Windows without SystemRoot.
                environment['SYSTEMROOT'] = os.environ['SYSTEMROOT']
            subprocess.run([str(node), str(npm), 'ci',
                            '--cache', str(scratch / 'npm-cache'), '--ignore-scripts',
                            *(['--no-bin-links'] if target == 'windows' else []),
                            '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'],
                           cwd=destination, env=environment, check=True, timeout=180)
            expected = json.loads((destination / 'package.json').read_text())['dependencies']
            for package, entry in (('skills', 'bin/cli.mjs'), ('add-mcp', 'dist/index.js')):
                metadata = json.loads((destination / 'node_modules' / package / 'package.json').read_text())
                if metadata['version'] != expected[package]:
                    raise ValueError(f'Unexpected installed {package} version.')
                subprocess.run([str(node), str(destination / 'node_modules' / package / entry), '--version'],
                               cwd=scratch, env=environment, check=True, timeout=20)
            if adapters_source is not None:
                adapters = release / 'adapters'
                adapters.mkdir()
                for filename in ('package.json', 'package-lock.json', 'client.mjs', 'claude.mjs',
                                 'audio-files.mjs', 'codex.mjs', 'diagnostics.mjs', 'host-guard.mjs',
                                 'cross-turn.mjs'):
                    shutil.copy2(adapters_source / filename, adapters / filename)
                shutil.copytree(adapters_source / 'claude-mod', adapters / 'claude-mod',
                                ignore=shutil.ignore_patterns('node_modules', 'tests', '.DS_Store'))
                (adapters / 'pi').mkdir()
                shutil.copy2(adapters_source / 'pi/index.ts', adapters / 'pi/index.ts')
                (adapters / 'hermes').mkdir()
                for filename in ('plugin.yaml', '__init__.py', 'bridge.mjs'):
                    shutil.copy2(adapters_source / 'hermes' / filename, adapters / 'hermes' / filename)
                subprocess.run([str(node), str(npm), 'ci',
                                '--cache', str(scratch / 'npm-cache'), '--omit=dev', '--omit=peer',
                                *(['--no-bin-links'] if target == 'windows' else []),
                                '--ignore-scripts', '--no-audit', '--no-fund',
                                '--registry=https://registry.npmjs.org'],
                               cwd=adapters, env=environment, check=True, timeout=180)
                expected_sdk = json.loads((adapters / 'package.json').read_text())['dependencies']['@modelcontextprotocol/sdk']
                installed_sdk = json.loads((adapters / 'node_modules/@modelcontextprotocol/sdk/package.json').read_text())['version']
                if installed_sdk != expected_sdk:
                    raise ValueError('Unexpected installed MCP SDK version.')
            # Registration uses the official CUA Node selected at install time.
            # npm is only a build dependency; keep no second Node distribution.
            if target == 'linux':
                shutil.rmtree(destination / 'node')
            if target != 'windows':
                (destination / 'node/bin').mkdir(parents=True)
                selected_node = ('../../../app/resources/cua_node/bin/node' if target == 'linux'
                                 else '../../../app/Contents/Resources/cua_node/bin/node')
                (destination / 'node/bin/node').symlink_to(selected_node)
            else:
                for path in release.rglob('*'):
                    if path.is_symlink() or (path.is_file() and path.suffix.lower() == '.node'):
                        raise ValueError(f'Windows tool bundle must be portable JavaScript: {path}')
    except BaseException:
        shutil.rmtree(destination)
        if adapters_source is not None:
            shutil.rmtree(release / 'adapters', ignore_errors=True)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parent / 'agent-tools')
    parser.add_argument('--target', choices=('linux', 'darwin', 'windows'), default='linux')
    parser.add_argument('--mac-node', type=Path)
    parser.add_argument('--adapters-source', type=Path)
    arguments = parser.parse_args()
    provision(arguments.release.resolve(), arguments.source.resolve(), target=arguments.target,
              mac_node=arguments.mac_node, adapters_source=arguments.adapters_source)
