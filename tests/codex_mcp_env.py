"""Observe which environment variables a Codex CLI passes to an MCP server it starts.

Codex filters the MCP child's environment, so `LCU_NODE_REPL_SANDBOX=host codex` never reaches `lcu`.
An isolated Codex CLI (own HOME and CODEX_HOME, scripted local provider, no account) starts the recording
fixture of tests/codex_sandbox_state.py directly and behind `adapters/codex.mjs`. One LCU variable is set in the
CLI's own environment and another under `[mcp_servers.lcu.env]`; the fixture reports which arrived.

    python3 tests/codex_mcp_env.py --cli "$(command -v codex)"
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from codex_sandbox_state import FIXTURE, RELAY, quote, serve  # noqa: E402


def observe(cli, node, relay):
    with tempfile.TemporaryDirectory(prefix='lcu-codex-env-') as temporary:
        work = Path(temporary).resolve()
        home, project, log = work / 'home', work / 'project', work / 'calls.jsonl'
        (home / '.codex').mkdir(parents=True)
        project.mkdir()
        server = serve()
        args = [str(RELAY), node, str(FIXTURE)] if relay else [str(FIXTURE)]
        try:
            (home / '.codex/config.toml').write_text('\n'.join([
                'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
                'model_provider = "fixture"', 'model = "fixture"', '',
                '[mcp_servers.lcu]', f'command = {quote(node)}',
                f'args = [{", ".join(quote(a) for a in args)}]', 'startup_timeout_sec = 20',
                'default_tools_approval_mode = "approve"', '',
                '[mcp_servers.lcu.env]', f'LCU_FIXTURE_LOG = {quote(log)}',
                'LCU_LINUX_INPUT_TRANSLATION = "off"', '',
                '[model_providers.fixture]', 'name = "Local fixture"',
                f'base_url = "http://127.0.0.1:{server.server_port}/v1"', 'wire_api = "responses"',
                'requires_openai_auth = false', '']), encoding='utf-8')
            env = {'HOME': str(home), 'CODEX_HOME': str(home / '.codex'), 'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
                   'TMPDIR': str(work), 'NO_COLOR': '1', 'LC_ALL': 'C.UTF-8', 'LCU_NODE_REPL_SANDBOX': 'host'}
            subprocess.run([str(cli), 'exec', '--skip-git-repo-check', '-C', str(project),
                            'Call the lcu js tool once, then finish.'], cwd=project, env=env,
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
        finally:
            server.shutdown()
            server.server_close()
        records = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        calls = [r for r in records if r['name'] == 'js']
        received = calls[0]['env'] if calls else 'no call reached the server'
        return {'registration': 'relay' if relay else 'direct',
                'set in the Codex process environment (LCU_NODE_REPL_SANDBOX)':
                    received.get('LCU_NODE_REPL_SANDBOX') if isinstance(received, dict) else received,
                'set under [mcp_servers.lcu.env] (LCU_LINUX_INPUT_TRANSLATION)':
                    received.get('LCU_LINUX_INPUT_TRANSLATION') if isinstance(received, dict) else received}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--cli', required=True, type=Path, help='the exact codex executable to test')
    args = parser.parse_args()
    node = shutil.which('node')
    if not node:
        parser.error('node must be on PATH')
    cli = args.cli.expanduser().resolve()
    version = subprocess.run([str(cli), '--version'], capture_output=True, text=True, timeout=20).stdout.strip()
    print(json.dumps({'cli': version, 'cases': [observe(cli, node, relay) for relay in (False, True)]}, indent=2))


if __name__ == '__main__':
    main()
