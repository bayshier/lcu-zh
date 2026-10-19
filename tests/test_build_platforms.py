"""Thin archive targets and build-only dependency provisioning."""
import json
from pathlib import Path
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


import re
import tarfile as _tarfile

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import build_bundle
from bundle import VERSION
from provision_agent_tools import provision

# Linux and macOS archives are built on their target OS; their import check needs POSIX modules.
posix_archive = unittest.skipIf(sys.platform == 'win32', 'Linux and macOS archives are built on POSIX hosts')


class BuildPlatformTests(unittest.TestCase):
    @posix_archive
    def test_darwin_archive_uses_selected_compatible_app_and_contains_only_thin_platform_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / 'ChatGPT.app'
            node = app / 'Contents/Resources/cua_node/bin/node'
            node.parent.mkdir(parents=True)
            node.write_text('fixture')
            def fake_provision(release, source, **options):
                self.assertEqual(options['target'], 'darwin')
                self.assertEqual(options['mac_node'], node)
                self.assertEqual(options['adapters_source'], build_bundle.SOURCE / 'adapters')
                (release / 'agent-tools/node/bin').mkdir(parents=True)
                (release / 'agent-tools/node/bin/node').symlink_to(
                    '../../../app/Contents/Resources/cua_node/bin/node')
                (release / 'adapters/pi').mkdir(parents=True)
                (release / 'adapters/client.mjs').write_text('fixture')
                (release / 'adapters/claude.mjs').write_text('fixture')
                (release / 'adapters/audio-files.mjs').write_text('fixture')
                (release / 'adapters/codex.mjs').write_text('fixture')
                (release / 'adapters/host-guard.mjs').write_text('fixture')
                (release / 'adapters/cross-turn.mjs').write_text('fixture')
                (release / 'adapters/diagnostics.mjs').write_text('fixture')
                (release / 'adapters/pi/index.ts').write_text('fixture')
            with mock.patch.object(build_bundle, 'architecture', return_value='arm64'), \
                    mock.patch.object(build_bundle, 'resolve_mac_app', return_value=node.parent.parent) as resolve, \
                    mock.patch.object(build_bundle, 'build_owner_auth',
                                      side_effect=lambda dest: Path(dest).write_text('fixture')) as owner_auth, \
                    mock.patch.object(build_bundle, 'provision_agents', side_effect=fake_provision):
                archive = build_bundle.build(root / 'dist', target='darwin', app=app)
            owner_auth.assert_called_once()
            resolve.assert_called_once_with(app, 'arm64')
            self.assertEqual(archive.name, f'lcu-{VERSION}-darwin-arm64.tar.gz')
            with tarfile.open(archive) as bundle:
                names = {member.name for member in bundle}
                prefix = f'lcu-{VERSION}-darwin-arm64/'
                self.assertIn(prefix + 'scripts/install_macos.py', names)
                self.assertIn(prefix + 'scripts/install.mjs', names)
                self.assertNotIn(prefix + 'scripts/install.py', names)
                self.assertNotIn(prefix + 'scripts/install_windows.mjs', names)
                self.assertFalse(any(name.startswith(prefix + 'lcu/') and name.endswith('.py') for name in names))
                self.assertIn(prefix + 'lcu/platforms.mjs', names)
                self.assertIn(prefix + 'lcu/macos_host.mjs', names)
                self.assertIn(prefix + 'lcu/macos_sky_service.mjs', names)
                self.assertNotIn(prefix + 'lcu/linux_sky_service.mjs', names)
                self.assertNotIn(prefix + 'lcu/x11.mjs', names)
                self.assertNotIn(prefix + 'bin/lcu-codex-sandbox', names)
                self.assertIn(prefix + 'lcu/sandbox_shim.mjs', names)
                self.assertIn(prefix + 'lcu/update.mjs', names)
                self.assertIn(prefix + 'bin/lcu-owner-auth', names)
                self.assertIn(prefix + 'lcu/app_layout.mjs', names)
                self.assertIn(prefix + 'lcu/asar.mjs', names)
                # runtime.mjs imports windows.mjs on every platform; the Windows host modules stay out.
                self.assertEqual({name for name in names if name.startswith(prefix + 'lcu/windows')}, {prefix + 'lcu/windows.mjs'})
                self.assertNotIn(prefix + 'bin/lcu.cmd', names)
                self.assertIn(prefix + 'adapters/client.mjs', names)
                self.assertIn(prefix + 'adapters/claude.mjs', names)
                self.assertIn(prefix + 'adapters/audio-files.mjs', names)
                self.assertIn(prefix + 'adapters/codex.mjs', names)
                self.assertIn(prefix + 'adapters/host-guard.mjs', names)
                self.assertIn(prefix + 'adapters/cross-turn.mjs', names)
                self.assertIn(prefix + 'adapters/diagnostics.mjs', names)
                self.assertNotIn(prefix + 'app/Contents/Resources/cua_node/bin/node', names)
                manifest = json.load(bundle.extractfile(prefix + 'bundle.json'))
                self.assertEqual((manifest['platform'], manifest['architecture']), ('darwin', 'arm64'))

    def test_darwin_archive_keeps_supported_architecture_gate(self):
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.object(build_bundle, 'architecture', return_value='x64'), \
                    mock.patch.object(build_bundle, 'resolve_mac_app') as resolve:
                with self.assertRaisesRegex(ValueError, 'does not support macOS x64'):
                    build_bundle.build(Path(temporary) / 'dist', target='darwin')
            resolve.assert_not_called()

    @posix_archive
    def test_linux_archive_name_and_manifest_remain_linux(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with mock.patch.object(build_bundle, 'architecture', return_value='x64'), \
                    mock.patch.object(build_bundle, 'provision_agents') as agent_tools:
                archive = build_bundle.build(root / 'dist')
            self.assertEqual(archive.name, f'lcu-{VERSION}-linux-x64.tar.gz')
            self.assertEqual(agent_tools.call_args.kwargs['target'], 'linux')
            with tarfile.open(archive) as bundle:
                manifest = json.load(bundle.extractfile(f'lcu-{VERSION}-linux-x64/bundle.json'))
                self.assertEqual((manifest['platform'], manifest['architecture']), ('linux', 'x64'))
                names = {member.name for member in bundle}
                for name in ('lcu/runtime.mjs', 'lcu/usage.txt', 'lcu/update_apply.mjs', 'lcu/status.mjs',
                             'scripts/install.sh', 'scripts/install.mjs', 'scripts/bundle.mjs', 'scripts/install.py'):
                    self.assertIn(f'lcu-{VERSION}-linux-x64/{name}', names)
                self.assertFalse(any(name.endswith('.py') and '/lcu/' in name for name in names))
                for name in ('scripts/bundle.py', 'scripts/installed_app.py', 'scripts/install_macos.py'):
                    self.assertNotIn(f'lcu-{VERSION}-linux-x64/{name}', names)
                self.assertNotIn(f'lcu-{VERSION}-linux-x64/bin/lcu-owner-auth', names)
                self.assertIn(f'lcu-{VERSION}-linux-x64/lcu/linux_sky_service.mjs', names)
                self.assertIn(f'lcu-{VERSION}-linux-x64/lcu/x11.mjs', names)
                self.assertIn(f'lcu-{VERSION}-linux-x64/lcu/sandbox_shim.mjs', names)
                shim = bundle.getmember(f'lcu-{VERSION}-linux-x64/bin/lcu-codex-sandbox')
                self.assertTrue(shim.mode & 0o111)
                self.assertNotIn(f'lcu-{VERSION}-linux-x64/lcu/macos_sky_service.mjs', names)
                self.assertEqual({name for name in names if name.startswith(f'lcu-{VERSION}-linux-x64/lcu/windows')},
                                 {f'lcu-{VERSION}-linux-x64/lcu/windows.mjs'})
                self.assertNotIn(f'lcu-{VERSION}-linux-x64/bin/lcu.cmd', names)

    @posix_archive
    def test_shipped_document_links_resolve_inside_the_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with mock.patch.object(build_bundle, 'architecture', return_value='x64'), \
                    mock.patch.object(build_bundle, 'provision_agents'):
                archive = build_bundle.build(root / 'dist')
            extracted = root / 'extracted'
            with _tarfile.open(archive) as bundle:
                bundle.extractall(extracted, filter='data')
            release = extracted / f'lcu-{VERSION}-linux-x64'
            link = re.compile(r'\]\(([^)]+)\)')
            checked = 0
            for path in [release / 'README.md', *(release / 'docs').rglob('*.md')]:
                for match in link.finditer(path.read_text()):
                    target = match.group(1).split('#', 1)[0].strip()
                    if not target or '://' in target or target.startswith('mailto:'):
                        continue
                    resolved = (path.parent / target).resolve()
                    # The closure guarantees no dangling relative document link.
                    if resolved.suffix == '.md':
                        self.assertTrue(resolved.is_file(), f'dangling document link {target} in {path}')
                        checked += 1
            self.assertGreater(checked, 0)

    def test_macos_provision_reuses_selected_node_and_packages_only_adapter_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            release = root / 'release'
            release.mkdir()
            node = root / 'selected-node'
            node.write_text('fixture')
            node.chmod(0o755)
            npm = root / 'npm-cli.js'
            npm.write_text('fixture')
            commands = []

            def fake_run(command, **kwargs):
                commands.append((command, kwargs))
                if 'ci' not in command:
                    return SimpleNamespace(returncode=0)
                destination = kwargs['cwd']
                if destination.name == 'agent-tools':
                    for package, version in (('skills', '1.7.0'), ('add-mcp', '2.4.0')):
                        target = destination / 'node_modules' / package
                        target.mkdir(parents=True)
                        (target / 'package.json').write_text(json.dumps({'version': version}))
                else:
                    target = destination / 'node_modules/@modelcontextprotocol/sdk'
                    target.mkdir(parents=True)
                    (target / 'package.json').write_text(json.dumps({'version': '1.30.0'}))
                return SimpleNamespace(returncode=0)

            with mock.patch('provision_agent_tools.platform.system', return_value='Darwin'), \
                    mock.patch('provision_agent_tools.platform.machine', return_value='arm64'), \
                    mock.patch('provision_agent_tools.shutil.which', return_value=str(npm)), \
                    mock.patch('provision_agent_tools.download', side_effect=AssertionError('unexpected download')), \
                    mock.patch('provision_agent_tools.subprocess.run', side_effect=fake_run):
                provision(release, SCRIPTS / 'agent-tools', target='darwin', mac_node=node,
                          adapters_source=SCRIPTS.parent / 'adapters')
            link = release / 'agent-tools/node/bin/node'
            self.assertEqual(link.readlink().as_posix(),
                             '../../../app/Contents/Resources/cua_node/bin/node')
            self.assertTrue((release / 'adapters/client.mjs').is_file())
            self.assertTrue((release / 'adapters/claude.mjs').is_file())
            self.assertTrue((release / 'adapters/audio-files.mjs').is_file())
            self.assertTrue((release / 'adapters/codex.mjs').is_file())
            self.assertTrue((release / 'adapters/pi/index.ts').is_file())
            mod = release / 'adapters/claude-mod/lcu-approve'
            for name in ('.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx'):
                self.assertTrue((mod / name).is_file(), name)
            self.assertFalse((mod / 'tests').exists())
            # The release carries every file of the mod but its tests, including the types contract
            # its manifest names (the engine refuses to load the mod without it).
            source = SCRIPTS.parent / 'adapters/claude-mod/lcu-approve'
            expected = {path.relative_to(source) for path in source.rglob('*')
                        if path.is_file() and path.relative_to(source).parts[0] != 'tests'
                        and path.name != '.DS_Store'}
            self.assertEqual({path.relative_to(mod) for path in mod.rglob('*') if path.is_file()}, expected)
            manifest = json.loads((mod / '.claude-plugin/plugin.json').read_text())
            if 'types' in manifest:
                self.assertTrue((mod / manifest['types']).is_file(), manifest['types'])
            for name in ('plugin.yaml', '__init__.py', 'bridge.mjs'):
                self.assertTrue((release / 'adapters/hermes' / name).is_file())
            self.assertFalse((release / 'adapters/hermes/lcu-config.json').exists())
            sdk_package = release / 'adapters/node_modules/@modelcontextprotocol/sdk/package.json'
            self.assertEqual(json.loads(sdk_package.read_text())['version'], '1.30.0')
            self.assertFalse((release / 'adapters/test').exists())
            adapter_ci = next(command for command, options in commands if 'ci' in command and
                              options['cwd'].name == 'adapters')
            self.assertIn('--omit=peer', adapter_ci)
            self.assertIn('--ignore-scripts', adapter_ci)


if __name__ == '__main__':
    unittest.main()
