"""Run OMP against the disposable GTK fixture with the original Linux LCU runtime.

The OMP process runs on the host in a temporary HOME/profile. Its OpenAI
compatible endpoint must be a host-local credential-injecting proxy. The LCU
MCP subprocess runs through docker exec in the prestarted network-none GTK
fixture. The fixture's Target.txt is the independent result oracle.

Required environment: OMP_BIN, OMP_FIXTURE_CONTAINER, OMP_MODEL and
OMP_PROXY_BASE_URL.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import hashlib
import ipaddress
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
import uuid

ROOT = Path(__file__).resolve().parents[1]
from lcu_node import call  # noqa: E402


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--omp', default=os.environ.get('OMP_BIN'),
                        help='isolated official OMP binary; defaults to OMP_BIN')
    parser.add_argument('--container', default=os.environ.get('OMP_FIXTURE_CONTAINER'),
                        help='prestarted network-none Linux GTK fixture container')
    parser.add_argument('--model', default=os.environ.get('OMP_MODEL'),
                        help='provider/model accepted by the credential proxy')
    parser.add_argument('--proxy-base-url', default=os.environ.get('OMP_PROXY_BASE_URL'),
                        help='host-loopback OpenAI-compatible proxy URL; no key is read here')
    parser.add_argument('--container-user', default='lcutester')
    parser.add_argument('--docker-host', default=os.environ.get('LCU_DOCKER_HOST'),
                        help='explicit Docker socket URL for an isolated fixture daemon')
    parser.add_argument('--lcu-runtime', default='/tmp/lcu-runtime')
    parser.add_argument('--output-dir', default='/tmp/lcu-desktop-output')
    parser.add_argument('--evidence-file', default=os.environ.get('OMP_EVIDENCE_FILE'),
                        help='write JSON evidence here; keep outside the repository')
    args = parser.parse_args()
    missing = [name for name in ('omp', 'container', 'model', 'proxy_base_url')
               if not getattr(args, name)]
    if missing:
        parser.error('missing required settings: ' + ', '.join(missing))
    return args


def validate_proxy_url(value):
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise SystemExit('OMP proxy URL must be an HTTP(S) URL on a loopback host')
    if parsed.username or parsed.password or parsed.fragment:
        raise SystemExit('OMP proxy URL must not embed credentials or a fragment')
    host = parsed.hostname.lower()
    loopback = host == 'localhost'
    if not loopback:
        try:
            loopback = ipaddress.ip_address(host).is_loopback
        except ValueError:
            loopback = False
    if not loopback:
        raise SystemExit('OMP proxy URL must use localhost or a loopback IP address')
    return parsed


def run(args):
    omp = Path(args.omp).resolve()
    if not omp.is_file():
        raise SystemExit(f'OMP binary not found: {omp}')
    version = subprocess.run([str(omp), '--version'], text=True, capture_output=True,
                             timeout=30, check=True).stdout.strip()
    with omp.open('rb') as binary:
        digest = hashlib.file_digest(binary, 'sha256').hexdigest()
    proxy_url = validate_proxy_url(args.proxy_base_url)
    docker = shutil.which('docker')
    node = shutil.which('node')
    if not docker or not node:
        raise SystemExit('docker and node must be available on the host')

    temp_parent = '/private/tmp' if sys.platform == 'darwin' else tempfile.gettempdir()
    with tempfile.TemporaryDirectory(prefix='lcu-omp-real-gtk-', dir=temp_parent) as temp:
        root = Path(temp)
        home = root / 'home'
        profile = home / '.omp/profiles/lcu-gtk/agent'
        profile.mkdir(parents=True)
        for name in ('config', 'data', 'cache', 'cwd', 'session'):
            (root / name).mkdir()
        provider = args.proxy_base_url.rstrip('/')
        cli_model = args.model if '/' in args.model else f'openai/{args.model}'
        (profile / 'models.yml').write_text(
            'providers:\n'
            '  openai:\n'
            '    api: openai-completions\n'
            f'    baseUrl: {provider}\n'
            '    apiKey: local-fixture-proxy\n'
            '    models:\n'
            f'      - id: {args.model.rsplit("/", 1)[-1]}\n'
            '        contextWindow: 200000\n'
            '        maxTokens: 8192\n'
            '        supportsTools: true\n'
            '        compat:\n'
            '          supportsDeveloperRole: false\n', encoding='utf-8')
        profile_name = 'lcu-gtk'
        env = {
            'PATH': os.pathsep.join([str(omp.parent), str(Path(node).resolve().parent),
                                     str(Path(docker).resolve().parent), '/usr/bin', '/bin']),
            'HOME': str(home),
            'TMPDIR': str(root),
            'XDG_CONFIG_HOME': str(root / 'config'),
            'XDG_DATA_HOME': str(root / 'data'),
            'XDG_CACHE_HOME': str(root / 'cache'),
            'OMP_PROFILE': profile_name,
            'PI_CODING_AGENT_DIR': str(profile),
            'OPENAI_API_KEY': 'local-fixture-proxy',
            'NO_COLOR': '1',
            'NO_PROXY': 'localhost,127.0.0.1',
            'no_proxy': 'localhost,127.0.0.1',
        }
        docker_command = [docker] + (['--host', args.docker_host] if args.docker_host else [])
        command = [*docker_command, 'exec', '-i', '-u', args.container_user,
                   args.container, args.lcu_runtime]
        call('harness_setup', 'configureOmp', home, command, ROOT, {'scope': 'user', 'env': env})

        marker = 'omp-lcu-' + uuid.uuid4().hex[:12]
        prompt = (f'Use the original Computer Use tools. In the window '
                  f'named LCU Target, first call await cua.getState() and use the '
                  f'returned original Computer Use instructions. Enter exactly {marker} '
                  f'in the Draft text field, '
                  f'click Save draft, and verify the saved status. Do not interact with '
                  f'LCU Other or any other window.')
        run = subprocess.run(
            [str(omp), '--print', '--no-session', '--tools=js,js_reset',
             '--thinking=low', '--cwd', str(root / 'cwd'),
             '--session-dir', str(root / 'session'), '--model', cli_model,
             '--api-key', 'local-fixture-proxy', prompt],
            cwd=root / 'cwd', env=env, text=True, capture_output=True, timeout=240)
        target = subprocess.run([*docker_command, 'exec', args.container, 'cat',
                                 f'{args.output_dir}/Target.txt'],
                                text=True, capture_output=True, timeout=30)
        other = subprocess.run([*docker_command, 'exec', args.container, 'test', '-e',
                                f'{args.output_dir}/Other.txt'],
                               capture_output=True, timeout=30)
        if other.returncode not in (0, 1) or (other.returncode == 1 and other.stderr):
            raise AssertionError(f'Could not query the GTK Other oracle: exit={other.returncode}; '
                                 f'{other.stderr.decode(errors="replace")}')
        evidence = {
            'host': 'oh-my-pi', 'version': version, 'binary_sha256': digest,
            'model': args.model, 'container': args.container, 'marker': marker,
            'omp_exit_code': run.returncode, 'omp_stdout': run.stdout,
            'omp_stderr': run.stderr,
            'target_exit_code': target.returncode, 'target_stdout': target.stdout,
            'other_exists': other.returncode == 0,
            'proxy_origin': proxy_url.netloc,
        }
        if args.evidence_file:
            evidence_path = Path(args.evidence_file).expanduser().resolve()
            evidence_path.parent.mkdir(parents=True, exist_ok=True)
            evidence_path.write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')
            print(f'OMP evidence written to {evidence_path}')
        if run.returncode:
            raise AssertionError(f'OMP exited {run.returncode}:\n{run.stderr}\n{run.stdout}')
        if target.returncode:
            raise AssertionError(f'GTK Target oracle missing: {target.stderr}')
        if target.stdout != marker:
            raise AssertionError(f'GTK Target oracle mismatch: {target.stdout!r} != {marker!r}')
        if other.returncode == 0:
            raise AssertionError('OMP changed LCU Other; expected it to remain untouched')
        print(f'OMP {version} actual-harness GTK flow verified: Target.txt={marker}; Other.txt absent.')


if __name__ == '__main__':
    run(parse_args())
