#!/usr/bin/env python3
"""End-to-end checks that compare two LCU implementation trees (OLD and NEW) by what matters.

Each check runs both implementations in fresh sandboxes (temp dirs, a disposable account, a fake
ChatGPT app made of small recorder scripts, never OpenAI binaries) and compares parsed data:
files `lcu setup` writes, exit codes, and how the original runtime is launched. Output text is never
compared. Test tooling only; it is not shipped. Run it through tests/e2e/run.sh.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import pty
import pwd
import re
import shlex
import shutil
import statistics
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import tomllib

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
ARCH = {'x86_64': 'x64', 'amd64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}[os.uname().machine.lower()]
ROOT = os.getuid() == 0
SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
# A pair recorded in tested-versions.json, so status reports a stable "tested" verdict.
APP_VERSION, RUNTIME = '26.928.31416', '0.0.27/20260927214556-b77d38801cca'
CHECKS = ('setup', 'exit', 'launch', 'upgrade', 'nopython', 'startup')
MCP_INIT = (json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
    'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'e2e', 'version': '0'}}}) + '\n' +
    json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n' +
    json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'}) + '\n')
DISCOVER = json.dumps({'jsonrpc': '2.0', 'id': 'probe', 'method': 'server/discover'}) + '\n'


def log(message):
    print(message, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- trees and archives

def tree_from_spec(spec, destination):
    """A directory as is, or a git ref exported with `git archive` (no worktree state)."""
    if Path(spec).is_dir():
        return Path(spec).resolve()
    data = subprocess.run(['git', '-C', str(REPO), 'archive', spec], check=True, capture_output=True).stdout
    destination.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        archive.extractall(destination, filter='data')
    return destination


def tree_key(source):
    digest = hashlib.sha256()
    for path in sorted(source.rglob('*')):
        relative = path.relative_to(source)
        if relative.parts[0] in ('.git', 'dist', 'node_modules', '.verification', 'tests') or \
                '__pycache__' in relative.parts or 'node_modules' in relative.parts:
            continue
        digest.update(str(relative).encode() + b'\0')
        if path.is_symlink():
            digest.update(os.readlink(path).encode())
        elif path.is_file():
            digest.update(hashlib.sha256(path.read_bytes()).digest() + oct(path.stat().st_mode & 0o777).encode())
    return digest.hexdigest()[:24]


# build_bundle.py gives npm a minimal environment; behind a TLS-intercepting proxy npm then needs the
# proxy CA. Forward only the CA/proxy variables of this shell into the build's child processes.
BUILD_SHIM = r'''
import os, runpy, subprocess, sys
keep = {k: v for k, v in os.environ.items() if k in ('NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy')}
real = subprocess.run
def run(*args, **kwargs):
    if kwargs.get('env') is not None:
        kwargs['env'] = {**kwargs['env'], **keep}
    return real(*args, **kwargs)
subprocess.run = run
sys.argv = sys.argv[1:]
sys.path.insert(0, os.path.dirname(os.path.abspath(sys.argv[0])))
runpy.run_path(sys.argv[0], run_name='__main__')
'''


def build_archive(source, cache):
    """The Linux release archive of a tree, built with its own scripts/build_bundle.py and cached by content."""
    output = cache / tree_key(source)
    found = sorted(output.glob('lcu-*-linux-*.tar.gz')) if output.is_dir() else []
    if found:
        return found[0]
    cache.mkdir(parents=True, exist_ok=True)
    log(f'building {source} (cached at {output})')
    for attempt in range(3):  # the build downloads Node and npm packages; retry transient failures
        scratch = Path(tempfile.mkdtemp(prefix='.build-', dir=cache))
        if subprocess.run([sys.executable, '-c', BUILD_SHIM, str(source / 'scripts/build_bundle.py'), '--output',
                           str(scratch)], cwd=source, stdout=subprocess.DEVNULL).returncode == 0:
            break
        shutil.rmtree(scratch)
    else:
        raise SystemExit(f'Building {source} failed three times')
    os.replace(scratch, output)
    return sorted(output.glob('lcu-*-linux-*.tar.gz'))[0]


class Impl:
    def __init__(self, label, archive):
        self.label, self.archive = label, Path(archive).resolve()
        match = re.fullmatch(r'lcu-(.+)-linux-(arm64|x64)\.tar\.gz', self.archive.name)
        if not match or match.group(2) != ARCH:
            raise SystemExit(f'Not a Linux {ARCH} LCU archive: {self.archive}')
        self.version = match.group(1)
        self.name = self.archive.name.removesuffix('.tar.gz')


# ---------------------------------------------------------------- sandbox

def write(path, data, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    path.write_bytes(data.encode() if isinstance(data, str) else data)
    path.chmod(mode)


def make_fake_app(app, records, node):
    """A minimal /usr/lib/chatgpt layout that passes LCU's structure checks. Every executable is a recorder
    or a no-op; `cua_node/bin/node` execs the real Node so LCU (and its Node port) can run on it."""
    resources = app / 'resources'
    runtime = resources / 'cua_node'
    plugins = resources / 'plugins/openai-bundled/plugins'
    noop = '#!/bin/sh\nexit 0\n'

    def fake(name):
        return f'#!{node}\n' + (HERE / 'fake/cli.mjs').read_text().replace('@NAME@', name).replace('@RECORDS@', str(records))

    write(app / 'ChatGPT', noop, 0o755)
    write(runtime / 'bin/node', f'#!/bin/sh\nE2E_NODE_ARGV0="$0" exec {shlex.quote(node)} "$@"\n', 0o755)
    write(runtime / 'bin/node_repl', noop, 0o755)
    write(runtime / 'manifest.json', json.dumps({'platform': 'linux', 'arch': ARCH, 'runtime_archive_version': RUNTIME}))
    write(runtime / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs',
          (HERE / 'fake/cua-repl.mjs').read_text().replace('@RECORDS@', str(records)))
    sky = runtime / 'lib/node_modules/@oai/sky'
    write(sky / 'package.json', json.dumps({'name': '@oai/sky', 'version': '0.0.0', 'type': 'module',
                                            'exports': {'./service': './dist/project/cua/sky_js/src/service.js'}}))
    write(sky / 'dist/project/cua/sky_js/src/service.js',
          "export async function handleRpc(request) {\n"
          "  return request.type === 'setup' ? { target: 'linux', methods: [] } : null;\n}\n")
    write(resources / 'codex', fake('app-codex'), 0o755)
    write(resources / 'codex-code-mode-host', noop, 0o755)
    package = json.dumps({'name': 'chatgpt', 'version': APP_VERSION}).encode()
    header = json.dumps({'files': {'package.json': {'offset': '0', 'size': len(package)}}}, separators=(',', ':')).encode()
    write(resources / 'app.asar', struct.pack('<4I', 4, 8 + len(header), 4 + len(header), len(header)) + header + package)
    write(plugins / 'chrome/.codex-plugin/plugin.json', json.dumps({'name': 'chrome', 'hooks': {'hooks': {}}}))
    write(plugins / f'chrome/extension-host/linux/{ARCH}/extension-host', noop, 0o755)
    scripts = plugins / 'chrome/scripts'
    write(scripts / 'installManifest.mjs', CHROME_INSTALL.replace('@RECORDS@', str(records)).replace('@ARCH@', ARCH))
    write(scripts / 'extension-ids.json', json.dumps({'browserDiagnostics': [{
        'browserFamily': family, 'shortDisplayName': family, 'extensionManagementUrl': 'about:blank',
        'storeUrl': 'about:blank'} for family in ('chrome', 'edge')]}))
    write(scripts / 'check-extension-installed.js', 'console.log(JSON.stringify({installed: false, enabled: false}));\n')
    write(scripts / 'check-native-host-manifest.js', 'console.log(JSON.stringify({correct: false}));\n')
    write(plugins / 'browser/package.json', '{}\n')
    hook = {'type': 'mcp_tool', 'server': 'cua_repl', 'tool': 'turn_ended',
            'input': {'session_id': '${session_id}', 'turn_id': '${turn_id}'}}
    write(plugins / 'unified-computer-use/.codex-plugin/plugin.json', json.dumps({
        'name': 'unified-computer-use',
        'hooks': {'hooks': {event: [{'hooks': [hook]}] for event in ('Stop', 'Interrupt', 'SubagentStop')}}}))
    write(plugins / 'unified-computer-use/.mcp.json', json.dumps({'mcpServers': {'cua_repl': {
        'command': 'cua-repl', 'args': [], 'enabled': True, 'tool_timeout_sec': 600,
        'tools': {'js': {'approval_mode': 'approve'}}}}}))
    return fake


# Stand-in for the original Chrome plugin installer: records its options and writes the native-host manifest
# pointing at the private plugin copy it runs from, plus the runtime paths beside the host, as the original does.
CHROME_INSTALL = '''import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function install(options) {
  const here = dirname(fileURLToPath(import.meta.url));
  appendFileSync('@RECORDS@/commands.jsonl', JSON.stringify({ tool: 'chrome-install', options, here }) + '\\n');
  const host = join(here, '../extension-host/linux/@ARCH@/extension-host');
  writeFileSync(join(dirname(host), 'extension-host-config.json'), JSON.stringify(options.appServerRuntimePaths));
  const manifest = join(process.env.HOME, '.config/google-chrome/NativeMessagingHosts/com.openai.codexextension.json');
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, JSON.stringify({ name: 'com.openai.codexextension', path: host, type: 'stdio',
    allowed_origins: ['chrome-extension://e2e/'] }, null, 2));
}
'''


class Account:
    """A disposable account whose home is the sandbox home (root), else the caller's own account."""

    def __init__(self, home, name=None):
        if ROOT:
            self.name = name or 'lcue2e' + os.urandom(3).hex()
            subprocess.run(['useradd', '-M', '-d', str(home), '-s', '/bin/sh', '-U', self.name], check=True)
            entry = pwd.getpwnam(self.name)
        else:
            entry = pwd.getpwuid(os.getuid())
            self.name = entry.pw_name
        self.uid, self.gid = entry.pw_uid, entry.pw_gid

    def wrap(self, argv):
        if not ROOT:
            return list(argv)
        return ['setpriv', f'--reuid={self.uid}', f'--regid={self.gid}', '--init-groups', '--', *argv]

    def close(self):
        if ROOT:
            subprocess.run(['userdel', self.name], check=False, stderr=subprocess.DEVNULL)


def remove_stale_accounts():
    if ROOT:
        for entry in pwd.getpwall():
            if entry.pw_name.startswith('lcue2e') and not Path(entry.pw_dir).exists():
                subprocess.run(['userdel', entry.pw_name], check=False, stderr=subprocess.DEVNULL)


class Sandbox:
    def __init__(self, work, label, node, *, guard=False, user=None):
        self.root = work / label
        self.root.mkdir(mode=0o755)
        self.home, self.project, self.tmp = self.root / 'home', self.root / 'project', self.root / 'tmp'
        self.records, self.prefix, self.fakebin = self.root / 'records', self.root / 'opt/lcu', self.root / 'fakebin'
        self.app = self.root / 'app/chatgpt'
        self.account = Account(self.home, user)
        for path in (self.home, self.project, self.tmp, self.records, self.prefix):
            path.mkdir(parents=True, mode=0o755)
            os.chown(path, self.account.uid, self.account.gid)
        self.home.chmod(0o700)
        fake = make_fake_app(self.app, self.records, node)
        for name in ('codex', 'claude', 'pi', 'omp', 'hermes'):
            write(self.fakebin / name, fake(name), 0o755)
        self.guard = self.root / 'guard' if guard else None
        if guard:
            self.guard_log = self.root / 'guard.log'
            write(self.guard_log, '', 0o666)
            shim = f'#!/bin/sh\necho "python blocked: $0 $*" >> {self.guard_log}\nexit 127\n'
            for name in ('python', 'python3', *(f'python3.{minor}' for minor in range(6, 16))):
                write(self.guard / name, shim, 0o755)
        self.extracted = {}

    def source(self, impl):
        """The extracted release archive (the installer's source directory)."""
        if impl.archive not in self.extracted:
            destination = self.root / f'dist-{impl.label}'
            destination.mkdir(mode=0o755)
            shutil.copy2(impl.archive, destination)
            shutil.copy2(impl.archive.with_name(impl.archive.name + '.sha256'), destination)
            with tarfile.open(impl.archive) as archive:
                archive.extractall(destination, filter='tar')
            self.extracted[impl.archive] = destination / impl.name
        return self.extracted[impl.archive]

    def env(self, extra=None):
        path = ([str(self.guard)] if self.guard else []) + [str(self.fakebin), SYSTEM_PATH]
        env = {'PATH': ':'.join(path), 'HOME': str(self.home), 'USER': self.account.name, 'LOGNAME': self.account.name,
               'LANG': 'C.UTF-8', 'TMPDIR': str(self.tmp), 'LCU_NO_UPDATE_CHECK': '1'}
        env.update(extra or {})
        return env

    def command(self, argv):
        argv = self.account.wrap([str(part) for part in argv])
        if self.guard and ROOT and shutil.which('unshare'):
            # Also hide every python* binary behind the logging shim, so an absolute path cannot bypass PATH.
            targets = sorted({os.path.realpath(path) for directory in ('/usr/bin', '/usr/local/bin', '/bin', '/usr/sbin')
                              for path in Path(directory).glob('python*') if path.is_file()})
            script = ''.join(f'mount --bind {self.guard / "python3"} {shlex.quote(t)} && ' for t in targets) + 'exec "$@"'
            argv = ['unshare', '--mount', '--propagation', 'private', 'sh', '-c', script, 'sh', *argv]
        return argv

    def run(self, argv, *, extra=None, stdin=None, cwd=None, timeout=180, stdout=None):
        started = time.monotonic()
        try:
            return self._run(argv, extra, stdin, cwd, timeout, stdout)
        finally:
            if os.environ.get('E2E_VERBOSE'):
                log(f'  {time.monotonic() - started:6.2f}s {shlex.join(str(a) for a in argv)[:160]}')

    def _run(self, argv, extra, stdin, cwd, timeout, stdout):
        try:
            result = subprocess.run(self.command(argv), input=stdin.encode() if stdin is not None else None,
                                    stdin=subprocess.DEVNULL if stdin is None else None,
                                    stdout=stdout or subprocess.PIPE, stderr=subprocess.PIPE,
                                    env=self.env(extra), cwd=cwd or self.home, timeout=timeout)
        except subprocess.TimeoutExpired:
            return 'timeout', '', ''
        return result.returncode, (result.stdout or b'').decode(errors='replace'), result.stderr.decode(errors='replace')

    def lcu(self, *args, prefix=None, **options):
        return self.run([(prefix or self.prefix) / 'current/bin/lcu', *args], **options)

    def install(self, impl, *args, prefix=None):
        return self.run([self.source(impl) / 'scripts/install.sh', '--prefix', prefix or self.prefix,
                         '--existing-app', self.app, '--skip-system', '--offline', *args])

    def take_records(self):
        """Launch records and command log written since the last call, then clear them."""
        launches = [json.loads(path.read_text()) for path in sorted(self.records.glob('launch-*.json'))]
        commands_file = self.records / 'commands.jsonl'
        commands = [json.loads(line) for line in commands_file.read_text().splitlines()] if commands_file.exists() else []
        for entry in commands:
            entry['argv'] = [parse_json(arg) for arg in entry.get('argv', [])]
            if 'env' in entry:
                entry['env'] = {key: parse_json(value) for key, value in entry['env'].items()}
        for path in self.records.iterdir():
            path.unlink()
        return launches, commands

    def wipe(self, *paths):
        for path in paths:
            for child in path.iterdir():
                shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink()

    def close(self):
        self.account.close()


# ---------------------------------------------------------------- data, normalization and comparison

UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
CODE_SUFFIXES = ('.mjs', '.js', '.cjs', '.ts', '.py')


class Normalizer:
    def __init__(self, sandbox, impls):
        self.rules = [(re.escape(str(sandbox.root.resolve())), '<SB>'), (re.escape(str(sandbox.root)), '<SB>'),
                      (r'<SB>/tmp/[^/\s"\'\\]+', '<SB>/tmp/<T>'), (r'releases/[^/\s"\'\\]+-[0-9a-f]{12}', 'releases/<REL>'),
                      (r'dist-(old|new|broken)\w*', 'dist-<IMPL>'), (re.escape(sandbox.account.name), '<USER>'),
                      (UUID.pattern, '<UUID>'), (r'\.[0-9a-f]{16}\.lock', '.<HASH>.lock')]
        for impl in impls:
            self.rules.append((re.escape(impl.name), 'lcu-<VER>-linux-' + ARCH))
            self.rules.append((r'(?<![\w.])' + re.escape(impl.version) + r'(?![\w.])', '<LCUVER>'))

    def __call__(self, value):
        if isinstance(value, str):
            for pattern, replacement in self.rules:
                value = re.sub(pattern, replacement, value)
            return value
        if isinstance(value, dict):
            return {self(key): self(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self(item) for item in value]
        return value


def parse_file(path):
    data = path.read_bytes()
    try:
        text = data.decode()
    except UnicodeDecodeError:
        return {'sha256': hashlib.sha256(data).hexdigest()}
    if path.suffix == '.toml':
        edits = [json.loads(line[len('# e2e-edit '):]) for line in text.splitlines() if line.startswith('# e2e-edit ')]
        try:
            return {'toml': tomllib.loads(text), 'app-server-edits': edits}
        except tomllib.TOMLDecodeError as exc:
            return {'invalid-toml': str(exc), 'text': text}
    if path.suffix in ('.json', '.jsonl') or text.lstrip()[:1] in ('{', '['):
        try:
            return {'json': [json.loads(line) for line in text.splitlines() if line.strip()]
                    if path.suffix == '.jsonl' else json.loads(text)}
        except json.JSONDecodeError:
            pass
    if path.suffix in CODE_SUFFIXES:
        return {'code': re.sub(r'\s+', '', text)}  # generated code: compare tokens, not spacing
    return {'lines': text.splitlines()}


def adapter_copies(release):
    """sha256 -> path of every file in the installed release's adapters/, for files setup copies verbatim."""
    base = Path(release) / 'adapters'
    return {hashlib.sha256(path.read_bytes()).hexdigest(): str(path.relative_to(base))
            for path in sorted(base.rglob('*')) if path.is_file() and not path.is_symlink()}


def snapshot(root, label, copies=None):
    """Every file, link and empty directory under root as parsed data, keyed by path. A file that is a byte-for-byte
    copy of one of the release's own adapter files is recorded by that source path: each release ships its own
    adapters, and they change independently of the port (a newer Hermes plugin on main is not a setup difference)."""
    copies = copies or {}
    found = {}
    if not root.exists():
        return found
    for path in sorted(root.rglob('*')):
        key = f'{label}/{path.relative_to(root)}'
        if path.is_symlink():
            found[key] = {'link': os.readlink(path)}
        elif path.name.startswith('lcu-native-host') or path.name == '.lcu-browser-plugin':
            found[key] = {'mode': oct(path.stat().st_mode & 0o777)}  # LCU's own relay code and cache key
        elif path.is_file():
            source = copies.get(hashlib.sha256(path.read_bytes()).hexdigest())
            found[key] = {'mode': oct(path.stat().st_mode & 0o777),
                          **({'copy-of-adapter': source} if source else parse_file(path))}
        elif path.is_dir() and not any(path.iterdir()):
            found[key] = {'empty-dir': True}
    return found


# Files the port renamed on purpose. Each OLD path ending in the first name is compared with the NEW path
# ending in the second; anything else under either name still shows as a difference. Not applied when OLD
# and NEW are the same archive (the self-test).
EXPECTED_RENAMES = (
    # The Chrome native-host relay: Python's lcu-native-host.py became lcu-native-host.mjs, run by the same
    # `lcu-native-host` sh launcher on the recorded Node (docs/releases/0.10.0.md).
    ('/lcu-native-host.py', '/lcu-native-host.mjs'),
)


def expected_renames(old):
    """OLD data with the EXPECTED_RENAMES applied to its keys, so NEW is compared under its own names."""
    if isinstance(old, dict):
        renamed = {}
        for key, value in old.items():
            for before, after in EXPECTED_RENAMES:
                if isinstance(key, str) and key.endswith(before):
                    key = key[:-len(before)] + after
            renamed[key] = expected_renames(value)
        return renamed
    return [expected_renames(item) for item in old] if isinstance(old, list) else old


# Data the port added on purpose: a NEW-only key whose path ends in the first item and whose value equals the
# second is not a difference. Anything else under the key still shows.
EXPECTED_ADDITIONS = (
    # `lcu status --json` reports the cross-turn Computer Use setting, off by default (docs/releases/0.11.0.md).
    ('/status-json-body/cross_turn', {'enabled': False, 'source': None}),
)


# The Claude Code `lcu-approve` mod setup copied into HOME. `lcu update` refreshes it from the new release
# (docs/INSTALLATION.md#upgrades-and-rollback), and a `--runtime-only` reinstall never runs setup, so after an
# update and after the rollback it holds the release's own copy, not OLD's.
CLAUDE_MOD = 'HOME/.claude/skills/lcu-approve/'
CLAUDE_MOD_SETUP_FILES = ('lcu.json',)  # written by setup beside the shipped files, not shipped


def expected_mod(files, release, normalize):
    """`files` with the lcu-approve mod's shipped files replaced by those of the release at `release` (the
    extracted archive), as lcu/claude_mod.mjs copies them: without its tests, keeping the installed file's mode
    (new files are written 0600)."""
    source = release / 'adapters/claude-mod/lcu-approve'
    shipped = {}
    for path in sorted(source.rglob('*')):
        name = str(path.relative_to(source))
        if path.is_file() and name.split('/')[0] != 'tests' and path.name != '.DS_Store':
            shipped[CLAUDE_MOD + name] = normalize(parse_file(path))
    expected = {key: value for key, value in files.items()
                if not key.startswith(CLAUDE_MOD) or key[len(CLAUDE_MOD):] in CLAUDE_MOD_SETUP_FILES}
    for key, data in shipped.items():
        expected[key] = {'mode': files.get(key, {}).get('mode', oct(0o600)), **data}
    return expected


def diff(old, new, path='', out=None):
    out = [] if out is None else out
    if isinstance(old, dict) and isinstance(new, dict):
        for key in sorted(set(old) | set(new), key=str):
            if key not in new:
                out.append(f'{path}/{key}: only OLD = {short(old[key])}')
            elif key not in old:
                if any(f'{path}/{key}'.endswith(suffix) and new[key] == value for suffix, value in EXPECTED_ADDITIONS):
                    continue
                out.append(f'{path}/{key}: only NEW = {short(new[key])}')
            else:
                diff(old[key], new[key], f'{path}/{key}', out)
    elif isinstance(old, list) and isinstance(new, list) and len(old) == len(new):
        for index, (a, b) in enumerate(zip(old, new)):
            diff(a, b, f'{path}[{index}]', out)
    elif old != new:
        out.append(f'{path}: OLD = {short(old)} | NEW = {short(new)}')
    return out


def short(value, limit=300):
    text = json.dumps(value, sort_keys=True) if not isinstance(value, str) else repr(value)
    return text if len(text) <= limit else text[:limit] + '...'


def status_projection(stdout):
    """`lcu status --json` without free-text fields (wording may change)."""
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return {'unparsable': True}

    def strip(value):
        if isinstance(value, dict):
            return {k: strip(v) for k, v in value.items() if k not in ('warning', 'message', 'error')}
        return [strip(v) for v in value] if isinstance(value, list) else value
    return strip(data)


# ---------------------------------------------------------------- checks: each returns data to compare

SETUP_CASES = {
    'codex': [['--agent', 'codex']],
    'codex-direct-auto-audio': [['--agent', 'codex', '--session', 'direct', '--approval', 'auto', '--audio']],
    'codex-existing-config': [['--agent', 'codex', '--session', 'direct']],
    'claude-direct': [['--agent', 'claude-code', '--session', 'direct']],
    'claude-chrome-auto': [['--agent', 'claude', '--chrome', '--approval', 'auto']],
    'claude-project': [['--agent', 'claude-code', '--scope', 'project', '--project', '{project}']],
    'claude-auto-then-ask': [['--agent', 'claude-code', '--approval', 'auto'],
                             ['--agent', 'claude-code', '--approval', 'ask', '--no-chrome']],
    'pi': [['--agent', 'pi']],
    'pi-project': [['--agent', 'pi', '--scope', 'project', '--project', '{project}', '--session', 'direct']],
    'omp-auto': [['--agent', 'omp', '--approval', 'auto']],
    'hermes-chrome': [['--agent', 'hermes', '--chrome', '--session', 'direct']],
    'all-direct': [['--agent', 'all', '--session', 'direct']],
    'export': [['--export', '{home}/exported']],
}
EXISTING_CODEX = '# kept\nmodel = "x"\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["a"]\n'


class InstallFailed(Exception):
    pass


def installed(sandbox, impl):
    code, out, err = sandbox.install(impl, '--runtime-only')
    if code != 0:
        raise InstallFailed(f'{impl.label} runtime-only install exited {code}: {(out + err)[-1500:]}')


def check_setup(sandbox, impl):
    installed(sandbox, impl)
    sandbox.take_records()
    data = {}
    for name, runs in SETUP_CASES.items():
        sandbox.wipe(sandbox.home, sandbox.project)
        if name == 'codex-existing-config':
            write(sandbox.home / '.codex/config.toml', EXISTING_CODEX)
            subprocess.run(['chown', '-R', f'{sandbox.account.uid}:{sandbox.account.gid}', sandbox.home / '.codex'])
        exits = []
        for args in runs:
            args = [a.format(project=sandbox.project, home=sandbox.home) for a in args]
            exits.append(sandbox.lcu('setup', *args, '--yes')[0])
        _, commands = sandbox.take_records()
        copies = adapter_copies((sandbox.prefix / 'current').resolve())
        data[name] = {'exit': exits, 'commands': commands,
                      'files': {**snapshot(sandbox.home, 'HOME', copies), **snapshot(sandbox.project, 'PROJECT', copies)}}
    return data


def run_pty(sandbox, argv):
    controller, terminal = pty.openpty()
    try:
        result = subprocess.run(sandbox.command(argv), stdin=terminal, stdout=terminal, stderr=subprocess.DEVNULL,
                                env=sandbox.env(), cwd=sandbox.home, timeout=60)
        return result.returncode
    except subprocess.TimeoutExpired:
        return 'timeout'
    finally:
        os.close(controller)
        os.close(terminal)


def check_exit(sandbox, impl):
    installed(sandbox, impl)
    data = {}
    lcu = sandbox.prefix / 'current/bin/lcu'
    session, shim = lcu.with_name('lcu-session'), lcu.with_name('lcu-codex-sandbox')
    user, project = sandbox.account.name, sandbox.project
    cases = {
        'help': [lcu, '--help'], '-h': [lcu, '-h'], 'chrome-help': [lcu, '--chrome', '--help'],
        'version': [lcu, '--version'], 'unknown-command': [lcu, 'bogus'], 'double-chrome': [lcu, '--chrome', '--chrome'],
        'with-browser-host': [lcu, '--with-browser-host'], 'launch-devnull': [lcu],
        'setup-bad-flag': [lcu, 'setup', '--bogus'], 'setup-unknown-agent': [lcu, 'setup', '--agent', 'nope', '--yes'],
        'setup-list-agents': [lcu, 'setup', '--list-agents'], 'setup-no-agent': [lcu, 'setup'],
        'setup-chrome-conflict': [lcu, 'setup', '--agent', 'codex', '--chrome', '--no-chrome', '--yes'],
        'setup-project-missing': [lcu, 'setup', '--agent', 'codex', '--scope', 'project', '--yes'],
        'setup-omp-project': [lcu, 'setup', '--agent', 'omp', '--scope', 'project', '--project', project, '--yes'],
        'setup-export-relative': [lcu, 'setup', '--export', 'relative'], 'setup-bad-scope': [lcu, 'setup', '--scope', 'x'],
        'setup-reconcile-agent': [lcu, 'setup', '--reconcile', '--agent', 'codex'],
        'status': [lcu, 'status'], 'status-json': [lcu, 'status', '--json'], 'status-bad': [lcu, 'status', '--bogus'],
        'doctor': [lcu, 'doctor', '--non-interactive'], 'doctor-help': [lcu, 'doctor', '--help'],
        'doctor-bad': [lcu, 'doctor', '--bogus'], 'prune-dry': [lcu, 'prune'], 'prune-bad': [lcu, 'prune', '--keep', 'x'],
        'origins-list': [lcu, 'origins', 'list', '--json'], 'origins-forget-missing': [lcu, 'origins', 'forget'],
        'apps': [lcu, 'apps', 'list'], 'browser-status': [lcu, 'browser', 'status'], 'browser-bad': [lcu, 'browser', 'x'],
        'update-notice': [lcu, 'update', '--notice'], 'update-bad': [lcu, 'update', '--bogus'],
        'update-conflict': [lcu, 'update', '--check', '--notice'],
        'session-help': [session, '--help'], 'session-no-command': [session, '--user', user],
        'session-no-desktop': [session, '--user', user, '--', 'true'], 'session-other-user': [session, '--user', 'root', '--', 'true'],
        'session-unknown-user': [session, '--user', 'no-such-user-e2e', '--', 'true'],
        'sandbox-shim-unconfigured': [shim, '--help'],
    }
    for name, argv in cases.items():
        code, stdout, _ = sandbox.run(argv)
        data[name] = code
        if name == 'status-json':
            data['status-json-body'] = status_projection(stdout)
    data['launch-tty'] = run_pty(sandbox, [lcu])
    moved = sandbox.app.with_name('moved')
    sandbox.app.rename(moved)
    try:
        for name, argv in {'version': [lcu, '--version'], 'help': [lcu, '--help'], 'launch': [lcu],
                           'status-json': [lcu, 'status', '--json'], 'doctor': [lcu, 'doctor', '--non-interactive'],
                           'setup': [lcu, 'setup', '--agent', 'claude-code', '--session', 'direct', '--yes']}.items():
            data['missing-app-' + name] = sandbox.run(argv)[0]
    finally:
        moved.rename(sandbox.app)
    installer = sandbox.source(impl) / 'scripts/install.sh'
    fresh = sandbox.root / 'opt/fresh'
    fresh.mkdir()
    os.chown(fresh, sandbox.account.uid, sandbox.account.gid)
    common = ['--prefix', fresh, '--skip-system', '--offline', '--existing-app', sandbox.app]
    for name, argv in {'help': ['--help'], 'relative-prefix': ['--prefix', 'relative', '--runtime-only'],
                       'offline-without-skip-system': ['--prefix', fresh, '--offline', '--runtime-only', '--existing-app', sandbox.app],
                       'app-package': [*common, '--runtime-only', '--app-package', sandbox.root],
                       'missing-app': ['--prefix', fresh, '--skip-system', '--offline', '--runtime-only', '--existing-app', '/nonexistent'],
                       'runtime-only-with-agent': [*common, '--runtime-only', '--agent', 'codex'],
                       'unknown-agent': [*common, '--agent', 'nope', '--yes'],
                       'no-selection': [*common]}.items():
        data['installer-' + name] = sandbox.run([installer, *argv])[0]
    return data


LAUNCH_CASES = {
    'plain': {}, 'chrome': {'args': ['--chrome']}, 'audio': {'args': ['--audio']},
    'audio-chrome': {'args': ['--audio', '--chrome']},
    'discovery-compat': {'args': ['--mcp-discovery-compat'], 'stdin': DISCOVER + MCP_INIT},
    'sandbox-off': {'env': {'LCU_NODE_REPL_SANDBOX': 'off'}}, 'sandbox-host': {'env': {'LCU_NODE_REPL_SANDBOX': 'host'}},
    'translation-off': {'env': {'LCU_LINUX_INPUT_TRANSLATION': 'off'}},
    'caller-env': {'env': {'CODEX_HOME': '/custom/codex', 'BUILD_FLAVOR': 'dev', 'NODE_OPTIONS': '--no-warnings',
                           'NODE_REPL_TRUSTED_SERVICES': '{"sky":"@oai/sky/service","extra":"x"}',
                           'CUA_REPL_ENABLED_SURFACES': 'computer,browser', 'NODE_REPL_REQUEST_META': '{"a":1}',
                           'NODE_REPL_NODE_MODULE_DIRS': '/extra/modules', 'SKY_ENABLE_AUDIO': '0'}},
    'custom-sky-services': {'env': {'NODE_REPL_TRUSTED_SERVICES': '{"sky":"/custom/sky.js"}'}},
    'empty-codex-home': {'env': {'CODEX_HOME': ''}},
    'unreadable-cwd': {'cwd': 'locked'}, 'stdout-file': {'stdout': 'file'},
}


def launch(sandbox, argv, case):
    cwd = None
    if case.get('cwd') == 'locked':
        cwd = sandbox.root / 'locked'
        cwd.mkdir(exist_ok=True)
        os.chown(cwd, sandbox.account.uid, sandbox.account.gid)
        cwd.chmod(0o300)  # enterable, not readable: LCU moves to /
    sink = None
    if case.get('stdout') == 'file':
        sink = open(sandbox.root / 'stdout.txt', 'wb+')
    code, stdout, _ = sandbox.run([*argv, *case.get('args', [])], extra=case.get('env'),
                                  stdin=case.get('stdin', MCP_INIT), cwd=cwd, stdout=sink)
    if sink:
        sink.seek(0)
        stdout = sink.read().decode(errors='replace')
        sink.close()
    lines = []
    for line in stdout.splitlines():
        try:
            lines.append(json.loads(line))
        except json.JSONDecodeError:
            lines.append({'text': line})
    launches, commands = sandbox.take_records()
    for record in launches:  # JSON-valued variables are parsed by the runtime: compare them as data
        record['env'] = {key: parse_json(value) for key, value in record['env'].items()}
    return {'exit': code, 'stdout': lines, 'launches': launches, 'commands': commands}


def parse_json(value):
    if value[:1] in ('{', '['):
        try:
            return {'json': json.loads(value)}
        except json.JSONDecodeError:
            pass
    return value


def check_launch(sandbox, impl):
    installed(sandbox, impl)
    sandbox.take_records()
    return {name: launch(sandbox, [sandbox.prefix / 'current/bin/lcu'], case) for name, case in LAUNCH_CASES.items()}


# ---------------------------------------------------------------- assertion checks (NEW only)

# Runs OLD's own `lcu update` code with only the two network fetches replaced by the local NEW archive:
# 0.9.7 has no way to point update at a local release.
UPDATE_DRIVER = r'''
import hashlib, shutil, sys
from pathlib import Path
root, archive, version = Path(sys.argv[1]).resolve(), Path(sys.argv[2]), sys.argv[3]
sys.dont_write_bytecode = True
sys.path.insert(0, str(root))
from lcu import update, update_apply
info = {'version': version, 'tag': 'v' + version, 'release_url': archive.as_uri(), 'severity': 'normal'}
update.fetch_latest = lambda: info
update.newer = lambda root, found: bool(found)  # also lets a same-version self-test proceed
def fetch(url, destination=None):
    if url.endswith('.sha256'):
        return archive.with_name(archive.name + '.sha256').read_bytes()
    shutil.copyfile(archive, destination)
    return hashlib.sha256(destination.read_bytes()).hexdigest()
update_apply._fetch = fetch
from lcu.runtime import main
main(root, ['update', '--yes'])
'''


def registered_commands(home):
    """The `lcu` MCP registrations of Claude Code and Codex, as argv lists."""
    found = {}
    claude = home / '.claude.json'
    if claude.exists():
        server = json.loads(claude.read_text()).get('mcpServers', {}).get('lcu')
        if server:
            found['claude-code'] = [server['command'], *server.get('args', [])]
    codex = home / '.codex/config.toml'
    if codex.exists():
        server = tomllib.loads(codex.read_text()).get('mcp_servers', {}).get('lcu')
        if server:
            found['codex'] = [server['command'], *server.get('args', [])]
    return found


def launch_registered(sandbox, argv):
    """Start a registration's command like a harness would and wait until the original runtime was reached."""
    process = subprocess.Popen(sandbox.command(argv), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=sandbox.env(), cwd=sandbox.home)
    threading.Thread(target=process.stdout.read, daemon=True).start()
    threading.Thread(target=process.stderr.read, daemon=True).start()
    process.stdin.write(MCP_INIT.encode())
    process.stdin.flush()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and not any(
            '"tools/list"' in path.read_text() for path in sandbox.records.glob('launch-*.json')):
        time.sleep(0.2)
    process.stdin.close()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
    launches, _ = sandbox.take_records()
    for record in launches:  # as in launch(): JSON-valued variables are compared as data, not spacing
        record['env'] = {key: parse_json(value) for key, value in record['env'].items()}
    return [{k: v for k, v in record.items() if k != 'stdin'} for record in launches]


def check_upgrade(sandbox, old, new, mode):
    """Install OLD, let OLD's `lcu update` install NEW, verify, then roll back by reinstalling OLD."""
    failures = []
    normalize = Normalizer(sandbox, [old, new])
    agent = mode == 'agent'
    args = ['--agent', 'claude-code', '--agent', 'codex', '--session', 'direct', '--yes'] if agent else ['--runtime-only']
    code, _, err = sandbox.install(old, *args)
    if code != 0:
        return [f'OLD install failed ({code}): {err[-800:]}']
    sandbox.take_records()

    def observe():
        sandbox.take_records()
        state = {'status': sandbox.lcu('status', '--json'), 'doctor': sandbox.lcu('doctor', '--non-interactive')[0],
                 'version': json.loads((sandbox.prefix / 'current/bundle.json').read_text())['version']}
        sandbox.take_records()
        if agent:
            commands = registered_commands(sandbox.home)
            state['registrations'] = commands
            state['missing-paths'] = [part for argv in commands.values() for part in argv
                                      if part.startswith('/') and not Path(part).exists()]
            state['launch'] = normalize(launch_registered(sandbox, commands.get('claude-code', ['false'])))
            state['files'] = {key: value for key, value in normalize(snapshot(sandbox.home, 'HOME')).items()
                              if not re.match(r'HOME/(\.cache/lcu|\.local/state/lcu/logs)/', key)}  # caches, logs
        else:
            state['launch'] = normalize(launch(sandbox, [sandbox.prefix / 'current/bin/lcu'], {}))
        return state

    def compare(before, after, stage, version):
        if after['version'] != version:
            failures.append(f'{stage}: current release is {after["version"]}, expected {version}')
        if after['status'][0] != 0:
            failures.append(f'{stage}: lcu status --json exited {after["status"][0]}')
        elif status_projection(after['status'][1]).get('lcu_version') != version:
            failures.append(f'{stage}: lcu status reports {status_projection(after["status"][1]).get("lcu_version")}')
        if after['doctor'] != before['doctor']:
            failures.append(f'{stage}: lcu doctor exited {after["doctor"]}, before the upgrade {before["doctor"]}')
        if not (after['launch'] if agent else after['launch']['launches']):
            failures.append(f'{stage}: the MCP launch did not reach the original runtime')
        failures.extend(f'{stage}: launch {line}' for line in diff(before['launch'], after['launch']))
        if agent:
            failures.extend(f'{stage}: registered path missing: {path}' for path in after['missing-paths'])
            renamed = version == new.version and old.archive != new.archive  # the self-test compares OLD with itself
            files = expected_renames(before['files']) if renamed else before['files']
            files = expected_mod(files, sandbox.source(new), normalize)  # refreshed by the update, kept by rollback
            failures.extend(f'{stage}: agent files {line}' for line in diff(files, after['files']))

    before = observe()
    if agent and (not before['registrations'] or before['missing-paths'] or not before['launch']):
        failures.append(f'OLD baseline is not usable: {short(before["registrations"])} {before["missing-paths"]}')
    if agent and not any(key.startswith(CLAUDE_MOD) for key in before['files']):
        failures.append('OLD setup did not install the lcu-approve mod')
    old_release = (sandbox.prefix / 'current').resolve()
    driver = sandbox.root / 'update_driver.py'
    write(driver, UPDATE_DRIVER)
    new_archive = sandbox.source(new).parent / new.archive.name
    code, out, err = sandbox.run(['python3', '-I', driver, sandbox.prefix / 'current', new_archive, new.version])
    if code != 0:
        return failures + [f'OLD lcu update to NEW exited {code}: {(out + err)[-1500:]}']
    if not old_release.is_dir():
        failures.append('the previous release directory was removed by the update')
    compare(before, observe(), 'after update', new.version)
    code, _, err = sandbox.install(old, '--runtime-only')
    if code != 0:
        return failures + [f'rollback (reinstalling OLD) failed ({code}): {err[-800:]}']
    compare(before, observe(), 'after rollback', old.version)
    if agent:
        failures.extend(f'after rollback: {line}' for line in mod_interface(sandbox))
    return failures


def mod_interface(sandbox):
    """What the lcu-approve mod left in HOME needs from the current release: the relay's host-only approval tools,
    `lcu update --notice --json --announce=SESSION` (JSON on stdout) and `lcu apps --json` (not a usage error)."""
    failures = []
    relay = (sandbox.prefix / 'current/adapters/claude.mjs').read_text()
    failures.extend(f'the Claude relay does not list {tool}' for tool in ('approval_request', 'approval_choice')
                    if f"'{tool}'" not in relay)
    code, out, err = sandbox.lcu('update', '--notice', '--json', '--announce=e2e-session')
    try:
        json.loads(out)
    except json.JSONDecodeError:
        code = code or 'non-JSON output'
    if code:
        failures.append(f'lcu update --notice --json --announce failed ({code}): {(out + err)[-400:]}')
    code, out, err = sandbox.lcu('apps', '--json')
    if code == 2 or 'usage' in (out + err).lower():
        failures.append(f'lcu apps --json is not a command ({code}): {(out + err)[-400:]}')
    return failures


def check_nopython(sandbox, impl):
    """Install with agent setup, launch, and run status with no Python reachable."""
    failures = []
    code, out, err = sandbox.install(impl, '--agent', 'claude-code', '--agent', 'codex', '--agent', 'pi',
                                     '--session', 'direct', '--yes')
    if code != 0:
        failures.append(f'install + setup exited {code}: {(out + err)[-600:]}')
    else:
        result = launch(sandbox, [sandbox.prefix / 'current/bin/lcu'], {})
        if result['exit'] != 0 or not result['launches']:
            failures.append(f'launch exited {result["exit"]} with {len(result["launches"])} launch records')
        for args in (['status', '--json'], ['--version'], ['--help'], ['doctor', '--non-interactive']):
            sandbox.lcu(*args)
        sandbox.run([sandbox.prefix / 'current/bin/lcu-session', '--help'])
    blocked = sandbox.guard_log.read_text().splitlines()
    if blocked:
        failures.append(f'{len(blocked)} Python invocation(s): ' + '; '.join(sorted(set(blocked))[:5]))
    return failures


STARTUP = (('lcu --version', 'lcu', ['--version']), ('lcu-session --help', 'lcu-session', ['--help']),
           ('lcu-codex-sandbox --help', 'lcu-codex-sandbox', ['--help']))
STARTUP_RATIO, STARTUP_SLACK = 1.10, 0.005  # NEW median may exceed OLD median by at most 10% + 5 ms


def check_startup(sandbox, old, new, runs):
    prefixes = {}
    for impl in (old, new):
        prefix = sandbox.root / 'opt' / impl.label
        prefix.mkdir(parents=True)
        os.chown(prefix, sandbox.account.uid, sandbox.account.gid)
        code, _, err = sandbox.install(impl, '--runtime-only', prefix=prefix)
        if code != 0:
            return [f'{impl.label} install failed ({code}): {err[-500:]}'], {}
        prefixes[impl.label] = prefix
    timings, failures = {}, []
    for title, binary, args in STARTUP:
        samples = {old.label: [], new.label: []}
        for index in range(runs + 2):
            for impl in ((old, new) if index % 2 else (new, old)):
                argv = sandbox.command([prefixes[impl.label] / 'current/bin' / binary, *args])
                started = time.perf_counter()
                subprocess.run(argv, env=sandbox.env(), cwd=sandbox.home, stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
                if index >= 2:  # two warm-up rounds
                    samples[impl.label].append(time.perf_counter() - started)
        a, b = statistics.median(samples[old.label]), statistics.median(samples[new.label])
        timings[title] = {'old_ms': round(a * 1000, 1), 'new_ms': round(b * 1000, 1)}
        if b > a * STARTUP_RATIO + STARTUP_SLACK:
            failures.append(f'{title}: NEW median {b * 1000:.1f} ms > OLD {a * 1000:.1f} ms x {STARTUP_RATIO} + '
                            f'{STARTUP_SLACK * 1000:.0f} ms')
    return failures, timings


# ---------------------------------------------------------------- driver

class Run:
    def __init__(self, work, node, runs, dump=None):
        self.work, self.node, self.runs, self.count, self.dump = work, node, runs, 0, dump
        self.tag = os.urandom(2).hex()

    def sandbox(self, label, **options):
        self.count += 1
        return Sandbox(self.work, f'{label}-{self.count}', self.node, **options)

    def compared(self, check, old, new):
        """Run a data check on OLD and NEW, one after the other, in sandboxes at the same path with the same
        account name (so path-derived names agree); return difference lines."""
        results = []
        self.count += 1
        label, user = f'{check}-{self.count}', f'lcue2e{self.tag}{self.count}'
        for impl in (old, new):
            sandbox = Sandbox(self.work, label, self.node, user=user)
            try:
                data = {'setup': check_setup, 'exit': check_exit, 'launch': check_launch}[check](sandbox, impl)
                results.append(Normalizer(sandbox, [old, new])(data))
                if self.dump:
                    self.dump.mkdir(parents=True, exist_ok=True)
                    (self.dump / f'{check}-{impl.label}.json').write_text(json.dumps(results[-1], indent=1, sort_keys=True))
            except InstallFailed as exc:
                return [str(exc)]
            finally:
                sandbox.close()
                sandbox.root.rename(sandbox.root.with_name(f'{label}-{impl.label}'))
        return diff(expected_renames(results[0]) if old.archive != new.archive else results[0], results[1])

    def check(self, name, old, new):
        """(status, lines): status is PASS, FAIL or SKIP."""
        if name in ('setup', 'exit', 'launch'):
            if name == 'setup' and not ROOT:
                return 'SKIP', ['setup writes to the account home; run as root (or with sudo) for a disposable account']
            lines = self.compared(name, old, new)
            return ('FAIL' if lines else 'PASS'), lines
        if name == 'upgrade':
            lines = []
            for mode in ('runtime-only', 'agent'):
                if mode == 'agent' and not ROOT:
                    lines.append('agent mode skipped: needs root for a disposable account')
                    continue
                sandbox = self.sandbox(f'upgrade-{mode}')
                try:
                    lines += [f'{mode}: {line}' for line in check_upgrade(sandbox, old, new, mode)]
                finally:
                    sandbox.close()
            return ('FAIL' if any(not line.startswith('agent mode skipped') for line in lines) else 'PASS'), lines
        if name == 'nopython':
            if not ROOT:
                return 'SKIP', ['setup writes to the account home; run as root (or with sudo) for a disposable account']
            sandbox = self.sandbox(f'nopython-{new.label}', guard=True)
            try:
                lines = check_nopython(sandbox, new)
            finally:
                sandbox.close()
            return ('FAIL' if lines else 'PASS'), lines
        if name == 'startup':
            sandbox = self.sandbox('startup')
            try:
                failures, timings = check_startup(sandbox, old, new, self.runs)
            finally:
                sandbox.close()
            return ('FAIL' if failures else 'PASS'), [json.dumps(timings), *failures]
        raise SystemExit(f'Unknown check: {name}')


def report(results):
    for name, (status, lines) in results.items():
        print(f'{status:4} {name}')
        for line in lines[:60]:
            print(f'     {line}')
        if len(lines) > 60:
            print(f'     ... {len(lines) - 60} more')


def make_broken(old_source, destination):
    """OLD with one written config value, one exit code and one launch env var changed."""
    shutil.copytree(old_source, destination, symlinks=True)
    edits = (('lcu/harness_setup.py', "'version': '0.1.0'", "'version': '0.1.9'"),
             ('lcu/status.py', 'raise SystemExit(1) from None', 'raise SystemExit(3) from None'),
             ('lcu/runtime.py', "'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS', '1000'",
              "'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS', '1500'"))
    for relative, before, after in edits:
        path = destination / relative
        text = path.read_text()
        if text.count(before) != 1:
            raise SystemExit(f'self-test: cannot break {relative}')
        path.write_text(text.replace(before, after))
    return destination


def self_test(run, old_source, cache, old_archive):
    old = Impl('old', old_archive)
    twin = Impl('new', old_archive)
    broken = Impl('broken', build_archive(make_broken(old_source, run.work / 'broken-src'), cache))
    outcomes = {}
    for name in ('setup', 'exit', 'launch', 'upgrade', 'startup'):
        outcomes[f'OLD vs OLD: {name}'] = run.check(name, old, twin)
    expectations = {'setup': "'0.1.9'", 'exit': 'status-json', 'launch': 'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS'}
    for name, marker in expectations.items():
        status, lines = run.check(name, old, broken)
        found = status == 'FAIL' and any(marker.strip("'") in line for line in lines)
        outcomes[f'OLD vs broken: {name} reports {marker}'] = ('PASS' if found else 'FAIL', lines)
    if ROOT and shutil.which('unshare'):
        sandbox = run.sandbox('guard', guard=True)
        try:
            code = sandbox.run(['/usr/bin/python3', '-c', 'pass'])[0]
            logged = sandbox.guard_log.read_text()
        finally:
            sandbox.close()
        outcomes['guard: absolute /usr/bin/python3 is blocked'] = ('PASS' if code == 127 and logged else 'FAIL',
                                                                   [f'exit {code}, log {logged!r}'])
    status, lines = run.check('nopython', old, twin)
    outcomes['guard: Python-based OLD fails nopython'] = ('PASS' if status == 'FAIL' else
                                                         ('SKIP' if status == 'SKIP' else 'FAIL'), lines)
    return outcomes


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('checks', nargs='*', help=f'any of {", ".join(CHECKS)} (default: all)')
    parser.add_argument('--old', default=None, help='OLD tree: a directory or git ref (default v0.9.7, else origin/main)')
    parser.add_argument('--new', default=str(REPO), help='NEW tree: a directory or git ref (default: this worktree)')
    parser.add_argument('--old-archive', type=Path, help='use this built OLD archive instead of building --old')
    parser.add_argument('--new-archive', type=Path, help='use this built NEW archive instead of building --new')
    parser.add_argument('--cache', type=Path, default=Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache') / 'lcu-e2e')
    parser.add_argument('--runs', type=int, default=15, help='startup samples per command and implementation')
    parser.add_argument('--keep', action='store_true', help='keep the work directory')
    parser.add_argument('--dump', type=Path, help='write the normalized data of each compared check here')
    parser.add_argument('--self-test', action='store_true', help='validate the harness: OLD vs OLD and OLD vs a broken OLD')
    args = parser.parse_args()
    checks = args.checks or list(CHECKS)
    if set(checks) - set(CHECKS):
        parser.error(f'unknown check; choose from {", ".join(CHECKS)}')
    node = shutil.which('node')
    if not node:
        raise SystemExit('node is required on PATH (it stands in for the app\'s cua_node)')
    node = os.path.realpath(node)
    os.umask(0o022)  # release archives record file modes; build and extract them as a release build would
    remove_stale_accounts()
    work = Path(tempfile.mkdtemp(prefix='lcu-e2e-', dir=os.environ.get('E2E_WORK_PARENT', '/tmp')))
    work.chmod(0o755)
    log(f'work directory: {work} ({"root: disposable accounts" if ROOT else "not root: current account"})')
    try:
        old_spec = args.old
        if old_spec is None:
            known = subprocess.run(['git', '-C', str(REPO), 'rev-parse', '-q', '--verify', 'v0.9.7^{commit}'],
                                   capture_output=True).returncode == 0
            old_spec = 'v0.9.7' if known else 'origin/main'
        old_source = tree_from_spec(old_spec, work / 'old-src') if not args.old_archive or args.self_test else None
        old_archive = args.old_archive or build_archive(old_source, args.cache)
        run = Run(work, node, args.runs, args.dump)
        if args.self_test:
            results = self_test(run, old_source, args.cache, old_archive)
        else:
            new_archive = args.new_archive or build_archive(tree_from_spec(args.new, work / 'new-src'), args.cache)
            old, new = Impl('old', old_archive), Impl('new', new_archive)
            log(f'OLD {old.version}: {old.archive}\nNEW {new.version}: {new.archive}')
            results = {}
            for name in checks:
                log(f'running {name}')
                results[name] = run.check(name, old, new)
        report(results)
        failed = any(status == 'FAIL' for status, _ in results.values())
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
