"""Exercise Pi's real /lcu stop command against the original macOS runtime.

Run only in the task-owned macOS guest. Pi talks to a local scripted
OpenAI-compatible endpoint; the only native target is a generated TextEdit
document. The script drives Pi's actual PTY UI, including both selection
dialogs, and makes no external model/provider request.
"""

import argparse
import fcntl
import hashlib
import json
import os
import platform
import plistlib
import pty
import re
import pwd
import select
import signal
import struct
import subprocess
import sys
import termios
import threading
import time
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lcu_node import codex_cli  # noqa: E402


APP_ID = 'com.apple.TextEdit'
INITIAL_MARKER = 'Generated Pi Stop fixture.\n'
RECOVERY_MARKER = 'LCU Pi Stop recovery oracle\n'


RUN_STARTED = time.monotonic()


def mark(phase: str, **details) -> None:
    print(json.dumps({'progress': phase,
                      'elapsed_seconds': round(time.monotonic() - RUN_STARTED, 2),
                      **details}, sort_keys=True), flush=True)


def chunk(model: str, delta: dict, finish_reason: str | None = None) -> dict:
    return {'id': 'lcu-pi-macos-stop', 'object': 'chat.completion.chunk', 'created': 1,
            'model': model,
            'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish_reason}]}


def sse(response, model: str, delta: dict, finish_reason: str) -> None:
    response.send_response(200)
    response.send_header('content-type', 'text/event-stream')
    response.send_header('cache-control', 'no-cache')
    response.end_headers()
    response.wfile.write(f'data: {json.dumps(chunk(model, delta))}\n\n'.encode())
    response.wfile.write(f'data: {json.dumps(chunk(model, {}, finish_reason))}\n\n'.encode())
    response.wfile.write(b'data: [DONE]\n\n')
    response.wfile.flush()


class Provider:
    def __init__(self):
        self.lock = threading.Lock()
        self.requests: list[dict] = []
        self.request_events: dict[int, threading.Event] = {}
        self.release_held = threading.Event()

    def record(self, body: dict) -> int:
        with self.lock:
            self.requests.append(body)
            index = len(self.requests)
            self.request_events.setdefault(index, threading.Event()).set()
            return index

    def wait_request(self, index: int, timeout: float = 45) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if len(self.requests) >= index:
                    return self.requests[index - 1]
            time.sleep(.02)
        raise AssertionError(f'Local scripted provider did not receive request {index}.')


def provider_server(provider: Provider):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            return

        def do_POST(self):
            if self.path != '/v1/chat/completions':
                self.send_error(404)
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get('content-length', '0'))))
                index = provider.record(body)
                model = body.get('model', 'scripted')
                if index in (1, 2, 3, 4, 6, 7, 8, 9, 10):
                    if index == 4 and not provider.release_held.wait(120):
                        self.send_error(504, 'test controller did not release the held fixture response')
                        return
                    code = {
                        1: 'await cua.getState(); nodeRepl.write("pi-initial-desktop-ready");',
                        2: 'await cua.computer.get_app_state({app:"com.apple.TextEdit"}); nodeRepl.write("pi-initial-state-ready");',
                        3: f'await cua.computer.type_text({{app:"com.apple.TextEdit",text:{json.dumps(INITIAL_MARKER)}}}); nodeRepl.write("pi-initial-native-ready");',
                        4: f'await cua.computer.type_text({{app:"com.apple.TextEdit",text:{json.dumps("SHOULD-NOT-APPEAR\\n")}}}); nodeRepl.write("unexpected-after-stop");',
                        6: 'await cua.getState(); nodeRepl.write("pi-new-turn-desktop-ready");',
                        7: 'await cua.computer.get_app_state({app:"com.apple.TextEdit"}); nodeRepl.write("pi-new-turn-state-ready");',
                        8: 'await cua.computer.press_key({app:"com.apple.TextEdit",key:"super+a"}); nodeRepl.write("pi-new-turn-selection-ready");',
                        9: f'await cua.computer.type_text({{app:"com.apple.TextEdit",text:{json.dumps(RECOVERY_MARKER)}}}); nodeRepl.write("pi-recovery-write-ready");',
                        10: 'await cua.computer.press_key({app:"com.apple.TextEdit",key:"super+s"}); nodeRepl.write("pi-recovery-save-ready");',
                    }[index]
                    delta = {'role': 'assistant', 'tool_calls': [{
                        'index': 0, 'id': f'pi-stop-step-{index}', 'type': 'function',
                        'function': {'name': 'js', 'arguments': json.dumps({'code': code})},
                    }]}
                    sse(self, model, delta, 'tool_calls')
                    return
                sse(self, model, {'role': 'assistant', 'content':
                    'Stopped turn checked.' if index == 5 else 'Recovery fixture saved.'}, 'stop')
            except (BrokenPipeError, ConnectionResetError):
                return

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def tool_result_for(request: dict, tool_call_id: str, marker: str) -> dict:
    """Return exactly the result for one provider tool call, not stale history."""
    messages = request.get('messages')
    if not isinstance(messages, list):
        raise AssertionError('Local provider request has no messages list.')
    matches = [message for message in messages
               if isinstance(message, dict) and message.get('role') == 'tool' and
               message.get('tool_call_id') == tool_call_id]
    if len(matches) != 1:
        raise AssertionError(f'Expected exactly one result for {tool_call_id}; got {len(matches)}.')
    message = matches[0]
    content = message.get('content')
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = '\n'.join(item['text'] for item in content
                          if isinstance(item, dict) and isinstance(item.get('text'), str))
    else:
        text = ''
    explicit_error = message.get('isError', message.get('is_error'))
    first_line = text.strip().splitlines()[0][:300] if text.strip() else ''
    if explicit_error is True or message.get('error'):
        raise AssertionError(
            f'{tool_call_id} returned an explicit tool error; first line: {first_line!r}; '
            f'explicit isError: {explicit_error!r}.')
    return {'tool_call_id': tool_call_id,
            'first_line': first_line,
            'explicit_error': explicit_error if isinstance(explicit_error, bool) else None,
            'completion_marker_present': marker in text}


def assert_tool_result(request: dict, tool_call_id: str, marker: str) -> dict:
    result = tool_result_for(request, tool_call_id, marker)
    if not result['completion_marker_present']:
        raise AssertionError(
            f'{tool_call_id} result did not contain its completion marker; '
            f"first line: {result['first_line']!r}; explicit isError: {result['explicit_error']!r}.")
    return result


def wait_file(path: Path, child: subprocess.Popen, drain, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and not path.is_file():
        if child.poll() is not None:
            raise AssertionError(f'Pi exited before its session observer wrote {path.name}; exit={child.returncode}.')
        drain(.1)
    if not path.is_file():
        raise AssertionError(f'Pi session observer did not write {path.name}.')


def wait_agent_ends(path: Path, expected: int, timeout: float,
                    child: subprocess.Popen, drain) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            lines = path.read_text(encoding='utf-8').splitlines()
        except FileNotFoundError:
            lines = []
        if len(lines) >= expected:
            return
        if child.poll() is not None:
            raise AssertionError(
                f'Pi exited before its agent_end cleanup observer recorded turn {expected}; '
                f'exit={child.returncode}; events={len(lines)}.')
        drain(.1)
    raise AssertionError(f'Pi agent_end cleanup observer did not record turn {expected}.')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, default=Path.home() / 'lcu-installed/current')
    parser.add_argument('--app', type=Path, default=Path('/Applications/ChatGPT.app'))
    parser.add_argument('--pi', type=Path, required=True, help='Installed Pi CLI executable.')
    parser.add_argument('--expected-user', default='lcuverify')
    parser.add_argument('--run-native-stop', action='store_true',
                        help='Required confirmation that native actions run only in the disposable guest.')
    parser.add_argument('--grant-textedit-always', action='store_true',
                        help='Allow the exact generated TextEdit fixture if original consent is requested.')
    args = parser.parse_args()
    if not args.run_native_stop:
        parser.error('Pass --run-native-stop only inside the task-owned disposable guest.')
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise SystemExit('Refusing native actions: expected the Apple Silicon macOS guest.')
    user = pwd.getpwuid(os.getuid()).pw_name
    if user != args.expected_user:
        raise SystemExit(f'Refusing native actions: expected {args.expected_user!r}, got {user!r}.')
    model = subprocess.run(['/usr/sbin/sysctl', '-n', 'hw.model'], check=True,
                           capture_output=True, text=True, timeout=5).stdout.strip()
    if not model.startswith('VirtualMac'):
        raise SystemExit(f'Refusing native actions: expected Apple Virtualization hardware, got {model!r}.')

    release = args.release.resolve(strict=True)
    app = args.app.resolve(strict=True)
    pi = args.pi.resolve(strict=True)
    os.environ['LCU_MODULE_ROOT'] = str(release)

    resources = app / 'Contents/Resources'
    runtime = resources / 'cua_node'
    codex = codex_cli(resources)
    lcu = release / 'bin/lcu'
    extension = release / 'adapters/pi/index.ts'
    for path in (lcu, extension, runtime / 'bin/node', runtime / 'bin/node_repl', pi):
        if not path.is_file():
            raise SystemExit(f'Required locally installed file is missing: {path}')
    signature = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)],
                               capture_output=True, text=True, timeout=30)
    if signature.returncode:
        raise SystemExit(f'Original app signature check failed: {signature.stderr.strip()}')

    from tempfile import TemporaryDirectory
    with TemporaryDirectory(prefix='lcu-pi-stop-', dir='/private/tmp') as temporary:
        root = Path(temporary)
        agent_dir = root / 'pi-agent'
        codex_home = root / 'codex-home'
        agent_dir.mkdir(mode=0o700)
        codex_home.mkdir(mode=0o700)
        document = root / 'generated-pi-stop-fixture.txt'
        document.write_text('Generated Pi Stop fixture.\n')
        subprocess.run(['/usr/bin/open', '-a', 'TextEdit', str(document)], check=True, timeout=10)
        ready = root / 'pi-session-ready'
        agent_ends = root / 'pi-agent-ends.jsonl'
        observer = root / 'pi-acceptance-observer.mjs'
        ui_trace = Path('/private/tmp/lcu-native-mac-acceptance-20260928/pi-stop-ui-trace.jsonl')
        pty_log = Path('/private/tmp/lcu-native-mac-acceptance-20260928/pi-stop-ui-pty.bin')
        pty_log.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        ui_trace.unlink(missing_ok=True)
        os.chmod(ui_trace.parent, 0o700)
        instrumented_extension = extension.with_name(f'.lcu-pi-stop-{os.getpid()}.ts')
        adapter_source = extension.read_text(encoding='utf-8')
        adapter_source = adapter_source.replace(
            "import { randomUUID } from 'node:crypto';",
            "import { appendFileSync } from 'node:fs';\nimport { randomUUID } from 'node:crypto';",
            1)
        status_call = (
            "    const status = await client.controlStatus(turn) as {\n"
            "      computerUse?: { activeApplications?: Array<{ name?: string; bundleIdentifier?: string }> };\n"
            "    };"
        )
        status_instrumented = (
            "    if (process.env.LCU_PI_UI_TRACE) appendFileSync(process.env.LCU_PI_UI_TRACE, "
            "JSON.stringify({ event: 'control_status_started', hasHostControl: client.hasHostControl, "
            "sessionIdPresent: Boolean(turn.sessionId), turnIdPresent: Boolean(turn.turnId), "
            "lcuMcpCommandPresent: Boolean(process.env.LCU_MCP_COMMAND) }) + '\\n');\n"
            "    const statusStartedAt = Date.now();\n"
            "    let status: { computerUse?: { activeApplications?: Array<{ name?: string; bundleIdentifier?: string }> } };\n"
            "    try {\n"
            "      status = await client.controlStatus(turn) as {\n"
            "        computerUse?: { activeApplications?: Array<{ name?: string; bundleIdentifier?: string }> };\n"
            "      };\n"
            "    } catch (error) {\n"
            "      if (process.env.LCU_PI_UI_TRACE) appendFileSync(process.env.LCU_PI_UI_TRACE, "
            "JSON.stringify({ event: 'control_status_error', elapsed_ms: Date.now() - statusStartedAt, "
            "error_class: error instanceof Error ? error.name : typeof error, "
            "error_is_not_connected: error instanceof Error && error.message.includes('Trusted macOS control service is not connected') }) + '\\n');\n"
            "      throw error;\n"
            "    }\n"
            "    if (process.env.LCU_PI_UI_TRACE) appendFileSync(process.env.LCU_PI_UI_TRACE, "
            "JSON.stringify({ event: 'control_status_completed', elapsed_ms: Date.now() - statusStartedAt }) + '\\n');\n"
        )
        if status_call not in adapter_source:
            raise AssertionError('Pi Stop status instrumentation anchor changed.')
        adapter_source = adapter_source.replace(status_call, status_instrumented, 1)
        status_anchor = "    const apps = Array.isArray(status?.computerUse?.activeApplications)"
        status_trace = (
            "    if (process.env.LCU_PI_UI_TRACE) appendFileSync(process.env.LCU_PI_UI_TRACE, "
            "JSON.stringify({ event: 'control_status', activeApplicationCount: "
            "Array.isArray(status?.computerUse?.activeApplications) ? status.computerUse.activeApplications.length : 0, "
            "texteditApplications: (Array.isArray(status?.computerUse?.activeApplications) "
            "? status.computerUse.activeApplications : []).filter(app => app?.bundleIdentifier === "
            "'com.apple.TextEdit').map(app => ({ name: app.name, bundleIdentifier: app.bundleIdentifier })) }) + '\\n');\n"
        )
        if status_anchor not in adapter_source:
            raise AssertionError('Pi Stop adapter instrumentation anchor changed.')
        adapter_source = adapter_source.replace(status_anchor, status_trace + status_anchor, 1)
        select_anchor = "    const selected = await ctx.ui.select('Stop computer use for an app', labels);"
        select_trace = (
            "    if (process.env.LCU_PI_UI_TRACE) appendFileSync(process.env.LCU_PI_UI_TRACE, "
            "JSON.stringify({ event: 'select_invoked', title: 'Stop computer use for an app', "
            "texteditLabels: labels.filter(label => label.includes('(com.apple.TextEdit)')) }) + '\\n');\n"
        )
        if select_anchor not in adapter_source:
            raise AssertionError('Pi Stop select instrumentation anchor changed.')
        adapter_source = adapter_source.replace(select_anchor, select_trace + select_anchor, 1)
        instrumented_extension.write_text(adapter_source, encoding='utf-8')
        os.chmod(instrumented_extension, 0o600)
        observer.write_text(
            'import { appendFileSync, writeFileSync } from "node:fs";\n'
            'export default function(pi) {\n'
            f'  pi.on("session_start", () => writeFileSync({json.dumps(str(ready))}, "ready"));\n'
            f'  pi.on("agent_end", event => appendFileSync({json.dumps(str(agent_ends))}, JSON.stringify({{ stopReason: event.messages?.at(-1)?.stopReason ?? null }}) + "\\n"));\n'
            '}\n')
        provider = Provider()
        server, server_thread = provider_server(provider)
        port = server.server_address[1]
        (agent_dir / 'models.json').write_text(json.dumps({'providers': {'fixture': {
            'baseUrl': f'http://127.0.0.1:{port}/v1', 'api': 'openai-completions',
            'apiKey': 'local-fixture-only',
            'models': [{'id': 'scripted', 'name': 'Scripted local fixture', 'reasoning': False,
                        'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
                        'contextWindow': 128000, 'maxTokens': 512}],
        }}}))
        env = {
            'HOME': os.environ['HOME'],
            'PI_CODING_AGENT_DIR': str(agent_dir), 'PI_OFFLINE': '1',
            'NODE_REPL_DISABLE_ANALYTICS': '1', 'BROWSER_USE_DISABLE_AMBIENT_NETWORK': '1',
            'LCU_MCP_COMMAND': json.dumps([str(lcu)]),
            'CODEX_HOME': str(codex_home),
            'LCU_PI_UI_TRACE': str(ui_trace),
            'PATH': os.pathsep.join((str(Path(sys.executable).parent), str(pi.parent),
                                     str(runtime / 'bin'), '/usr/bin', '/bin')),
            'LANG': 'C.UTF-8', 'TMPDIR': str(root),
            'CUA_REPL_ENABLED_SURFACES': 'computer', 'CUA_REPL_BROWSER_ENV': 'codex-app',
            'CUA_REPL_NODE_REPL_PATH': str(runtime / 'bin/node_repl'),
            'NODE_REPL_NODE_PATH': str(runtime / 'bin/node'),
            'NODE_REPL_NODE_MODULE_DIRS': str(runtime / 'lib/node_modules'),
            'NODE_REPL_TRUSTED_CODE_PATHS': os.pathsep.join((str(codex_home),
                str(runtime / 'lib/node_modules'), str(resources / 'plugins'))),
            'CODEX_CLI_PATH': str(codex),
            'SKY_CUA_SERVICE_PATH': str(runtime / 'lib/node_modules/@oai/sky/Codex Computer Use.app'),
        }
        env = {key: value for key, value in env.items() if value}
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 120, 0, 0))
        command = [str(pi), '--offline', '--no-session', '--no-builtin-tools', '--no-extensions',
                   '--no-skills', '--no-context-files', '--extension', str(instrumented_extension),
                   '--extension', str(observer),
                   '--provider', 'fixture', '--model', 'scripted']
        child = None
        output = bytearray()
        pty_log_stream = pty_log.open('wb')
        os.chmod(pty_log, 0o600)
        deadline = time.monotonic() + 180

        def drain(timeout: float = .2) -> None:
            ready, _, _ = select.select([master], [], [], timeout)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                    output.extend(chunk)
                    pty_log_stream.write(chunk)
                    pty_log_stream.flush()
                except OSError:
                    pass

        failure_until_needle: str | None = None

        def until(needle: str, timeout: float = 30) -> None:
            nonlocal failure_until_needle
            failure_until_needle = needle
            end = min(deadline, time.monotonic() + timeout)
            encoded = needle.encode()
            while encoded not in output and time.monotonic() < end:
                if child.poll() is not None:
                    raise AssertionError(f'Pi exited before {needle!r}; exit={child.returncode}; tail={output[-2000:]!r}')
                drain(.1)
            if encoded not in output:
                raise AssertionError(f'Pi did not show {needle!r}; tail={output[-3000:]!r}')
            failure_until_needle = None

        def key(value: bytes, settle: float = .2) -> None:
            os.write(master, value)
            time.sleep(settle)
            drain(.05)

        try:
            child = subprocess.Popen(command, cwd=root, env=env, stdin=slave, stdout=slave,
                                     stderr=slave, close_fds=True, start_new_session=True)
            os.close(slave)
            wait_file(ready, child, drain, 60)
            mark('pi_tui_ready')
            key(b'run generated TextEdit fixture\r')
            initial_deadline = time.monotonic() + 70
            approval_selected = False
            while time.monotonic() < initial_deadline:
                with provider.lock:
                    have_fourth_request = len(provider.requests) >= 4
                    fourth_request = provider.requests[3] if have_fourth_request else None
                if have_fourth_request:
                    break
                if (args.grant_textedit_always and not approval_selected and
                        b'Always allow' in output):
                    # Pi displays the original native-app choice list in order:
                    # once, session, always, decline. Select the exact persistent
                    # choice only when that original approval dialog is visible.
                    key(b'\x1b[B\x1b[B\r')
                    approval_selected = True
                    continue
                if child.poll() is not None:
                    raise AssertionError(f'Pi exited before the first native tool completed; exit={child.returncode}; tail={output[-2000:]!r}')
                drain(.1)
            else:
                if b'Always allow' in output and not args.grant_textedit_always:
                    raise AssertionError('Original TextEdit approval was requested but persistent consent was not authorized.')
                raise AssertionError(f'Pi did not finish the first native action; tail={output[-2500:]!r}')
            if not fourth_request:
                raise AssertionError('Local provider did not receive the post-action request.')
            with provider.lock:
                first_request = provider.requests[0]
                state_result, action_result = provider.requests[2:4]
            advertised_tools = first_request.get('tools', [])
            advertised_tool_names = sorted({
                tool.get('function', {}).get('name')
                for tool in advertised_tools if isinstance(tool, dict) and
                isinstance(tool.get('function'), dict) and
                isinstance(tool['function'].get('name'), str)
            })
            result_summary = {
                'initial_provider_tool_names': advertised_tool_names,
                'desktop_tool_result': assert_tool_result(
                    state_result, 'pi-stop-step-1', 'pi-initial-desktop-ready'),
                'state_tool_result': assert_tool_result(
                    action_result, 'pi-stop-step-2', 'pi-initial-state-ready'),
                'native_action_tool_result': assert_tool_result(
                    fourth_request, 'pi-stop-step-3', 'pi-initial-native-ready'),
            }
            mark('pi_initial_native_action_completed', tool_results=result_summary)
            # Pi's extension command dispatcher executes registered commands
            # immediately during streaming. Keep the local provider's response
            # held so the real /lcu stop command sees the active Pi turn.
            key(b'/lcu stop\r')
            until('Stop computer use for an app', 50)
            mark('pi_stop_menu_title_observed')
            until('TextEdit (com.apple.TextEdit)', 15)
            mark('pi_textedit_choice_observed')
            key(b'\r')
            until('Requested Computer Use Stop for TextEdit.', 50)
            mark('pi_real_stop_command_accepted')
            provider.release_held.set()

            until('Stopped turn checked.', 45)
            fifth = provider.wait_request(5, 10)
            messages = json.dumps(fifth.get('messages', []), ensure_ascii=False).lower()
            stopped = ('explicitly stopped by the user for this turn' in messages and
                       'computer use can be used again in the next assistant turn' in messages)
            if not stopped:
                raise AssertionError('The real Pi same-turn action did not receive the original stopped-session response.')
            mark('pi_same_turn_stop_rejected')

            wait_agent_ends(agent_ends, 1, 30, child, drain)

            key(b'continue generated recovery fixture\r')
            provider.wait_request(6, 30)
            mark('pi_fresh_turn_native_action_started')
            until('Recovery fixture saved.', 60)
            eleventh = provider.wait_request(11, 10)
            recovery_tool_results = []
            recovery_calls = (
                (6, 'pi-new-turn-desktop-ready'),
                (7, 'pi-new-turn-state-ready'),
                (8, 'pi-new-turn-selection-ready'),
                (9, 'pi-recovery-write-ready'),
                (10, 'pi-recovery-save-ready'),
            )
            with provider.lock:
                recovery_result_requests = list(provider.requests[6:11])
            if len(recovery_result_requests) != len(recovery_calls):
                raise AssertionError(
                    f'Expected five completed recovery tool-result requests; got '
                    f'{len(recovery_result_requests)} at provider index {len(provider.requests)}.')
            for request, (call_number, marker) in zip(recovery_result_requests, recovery_calls):
                recovery_tool_results.append(assert_tool_result(
                    request, f'pi-stop-step-{call_number}', marker))
            mark('pi_recovery_native_calls_completed', tool_results=recovery_tool_results)
            wait_agent_ends(agent_ends, 2, 130, child, drain)
            expected = RECOVERY_MARKER.encode('utf-8')
            end = time.monotonic() + 8
            while time.monotonic() < end and document.read_bytes() != expected:
                time.sleep(.05)
            if document.read_bytes() != expected:
                raise AssertionError('Independent TextEdit file oracle did not match the fresh-turn Pi save.')
            if child.poll() is not None:
                raise AssertionError('Pi exited before acceptance completed.')
            mark('pi_fresh_turn_file_oracle_passed', bytes=len(expected))
            print(json.dumps({
                'stage': 'macos-pi-real-stop-ui', 'result': 'passed',
                'pi_version': subprocess.run([str(pi), '--version'], check=True,
                    capture_output=True, text=True, timeout=10, env=env).stdout.strip(),
                'release': str(release), 'app_version': plistlib.loads(
                    (app / 'Contents/Info.plist').read_bytes()).get('CFBundleShortVersionString'),
                'provider_scope': '127.0.0.1 loopback fixture only',
                'pi_ui_trace': [json.loads(line) for line in ui_trace.read_text(encoding='utf-8').splitlines()
                                if line.strip()] if ui_trace.is_file() else [],
                'pty_log_sha256': hashlib.sha256(pty_log.read_bytes()).hexdigest(),
                'provider_requests': len(provider.requests),
                'last_provider_index': len(provider.requests),
                'stop_command': 'real Pi /lcu stop and ctx.ui.select',
                'always_approval_selected_if_shown': approval_selected,
                'same_turn_original_stop_rejected': stopped,
                'fresh_turn_file_bytes': len(expected), 'fresh_turn_file_match': True,
                'phases': {
                    'session_start_observed': True,
                    'initial_get_state': True,
                    'initial_textedit_state': True,
                    'initial_native_action': True,
                    'real_stop_command_accepted': True,
                    'same_turn_stopped_response': True,
                    'agent_end_observed_before_recovery': True,
                    'fresh_turn_save_oracle': True,
                },
            }, sort_keys=True), flush=True)
        except BaseException as error:
            trace_events = []
            if ui_trace.is_file():
                for line in ui_trace.read_text(encoding='utf-8', errors='replace').splitlines():
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(event, dict) and event.get('event') in (
                            'control_status_started', 'control_status_error', 'control_status_completed'):
                        trace_events.append({
                            'event': event.get('event'),
                            'hasHostControl': event.get('hasHostControl'),
                            'sessionIdPresent': event.get('sessionIdPresent'),
                            'turnIdPresent': event.get('turnIdPresent'),
                            'lcuMcpCommandPresent': event.get('lcuMcpCommandPresent'),
                            'elapsed_ms': event.get('elapsed_ms'),
                            'error_class': event.get('error_class'),
                            'error_is_not_connected': event.get('error_is_not_connected'),
                            'activeApplicationCount': event.get('activeApplicationCount'),
                            'texteditApplications': event.get('texteditApplications', []),
                        })
                    elif isinstance(event, dict) and event.get('event') == 'select_invoked':
                        trace_events.append({
                            'event': 'select_invoked',
                            'title': event.get('title'),
                            'texteditLabels': event.get('texteditLabels', []),
                        })
            print(json.dumps({
                'stage': 'macos-pi-real-stop-ui', 'result': 'failed',
                'error_class': type(error).__name__,
                'tool_result_error': (str(error).replace('\n', ' ')[:512]
                    if isinstance(error, AssertionError) and
                    re.match(r'^pi-stop-step-(?:[1-3]|[6-9]|10) ', str(error)) else None),
                'last_provider_index': len(provider.requests) if provider is not None else 0,
                'failing_until_needle': failure_until_needle,
                'pi_ui_trace': trace_events,
                'pty_log_sha256': hashlib.sha256(pty_log.read_bytes()).hexdigest()
                    if pty_log.is_file() else None,
                'pty_log_bytes': pty_log.stat().st_size if pty_log.is_file() else 0,
            }, sort_keys=True), flush=True)
            raise
        finally:
            provider.release_held.set()
            server.shutdown()
            server.server_close()
            if child is not None and child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    child.wait(timeout=5)
            os.close(master)
            pty_log_stream.close()
            instrumented_extension.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
