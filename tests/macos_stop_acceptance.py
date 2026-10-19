"""Exercise original macOS per-app Stop through the installed helper.

Run only inside the task-owned Apple Virtualization guest. This makes real
TextEdit actions in a generated temporary document. It starts no model/provider
request. Use --grant-textedit-always only when the disposable guest should gain
the original persistent TextEdit approval needed to verify that Stop preserves
it in a later test turn.
"""

import argparse
import json
import os
from pathlib import Path
import platform
import plistlib
import pwd
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
from lcu_node import codex_cli  # noqa: E402
from mcp_client import Client, text  # noqa: E402


APP_ID = 'com.apple.TextEdit'
STOPPED_MESSAGE = ('explicitly stopped by the user for this turn',
                   'computer use can be used again in the next assistant turn')


def require_guest(expected_user: str) -> str:
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise SystemExit('Refusing native actions: expected the Apple Silicon macOS guest.')
    username = pwd.getpwuid(os.getuid()).pw_name
    if username != expected_user:
        raise SystemExit(f'Refusing native actions: expected guest user {expected_user!r}, got {username!r}.')
    model = subprocess.run(['/usr/sbin/sysctl', '-n', 'hw.model'], check=True,
                           capture_output=True, text=True).stdout.strip()
    if not model.startswith('VirtualMac'):
        raise SystemExit(f'Refusing native actions: expected Apple Virtualization hardware, got {model!r}.')
    return model


def tool_call(client: Client, name: str, arguments: dict,
              metadata: dict, *, timeout: int = 45) -> dict:
    request_metadata = {**metadata, 'call_id': str(client.sequence + 1)}
    return client.call('tools/call', {
        'name': name,
        'arguments': arguments,
        '_meta': {'x-codex-turn-metadata': request_metadata},
    }, timeout=timeout)


def control_request(address: Path, request: dict, *, timeout: float = 45) -> dict:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(str(address))
        connection.sendall(json.dumps(request, separators=(',', ':')).encode() + b'\n')
        response = bytearray()
        while len(response) <= 1024 * 1024:
            byte = connection.recv(4096)
            if not byte:
                break
            response.extend(byte)
            newline = response.find(b'\n')
            if newline >= 0:
                return json.loads(response[:newline])
    raise RuntimeError('Original macOS control host returned no complete response.')


def metadata_from_runtime(client: Client) -> dict:
    result = client.js(
        'nodeRepl.write(JSON.stringify(nodeRepl.requestMeta?.["x-codex-turn-metadata"]));')
    raw = text(result).strip()
    metadata = json.loads(raw)
    if isinstance(metadata, str):
        metadata = json.loads(metadata)
    if (not isinstance(metadata, dict) or not isinstance(metadata.get('session_id'), str) or
            not metadata['session_id'].strip() or not isinstance(metadata.get('turn_id'), str) or
            not metadata['turn_id'].strip()):
        raise AssertionError(f'Original runtime supplied invalid request metadata: {raw[:512]!r}')
    return metadata


def approval_handler(expected_session: str, *, allow_persistent: bool, events: list[dict]):
    def handle(method: str, params: dict) -> dict:
        if method != 'elicitation/create':
            raise AssertionError(f'Unexpected original host request: {method}')
        meta = params.get('_meta', {})
        context = meta.get('x-codex-turn-metadata', {})
        if isinstance(context, str):
            context = json.loads(context)
        exact = (params.get('mode') == 'form' and meta.get('codex_approval_kind') == 'mcp_tool_call' and
                 meta.get('connector_id') == 'computer-use' and meta.get('tool_params') == {'app': APP_ID} and
                 context.get('session_id') == expected_session and
                 params.get('requestedSchema') == {'type': 'object', 'properties': {}})
        if not exact:
            raise AssertionError('Refusing an unexpected or differently scoped native approval request.')
        events.append({'turn_id': context.get('turn_id'), 'message': params.get('message')})
        if allow_persistent and 'always' in meta.get('persist', []):
            return {'action': 'accept', 'content': {}, '_meta': {'persist': 'always'}}
        return {'action': 'cancel'}
    return handle


def wait_for_socket(path: Path, timeout: float = 8) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            return
        time.sleep(0.05)
    raise AssertionError('The LCU original macOS host did not bind its private control socket.')


def wait_for_file(path: Path, worker: threading.Thread, timeout: float = 8) -> None:
    """Wait for the original JS call's explicit between-native-RPC milestone."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and worker.is_alive():
        if path.is_file():
            return
        time.sleep(0.02)
    raise AssertionError(f'Original JS call did not reach the inter-RPC milestone: {path.name}')


def wait_for_file_bytes(path: Path, expected: bytes, timeout: float = 8) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if path.read_bytes() == expected:
                return
        except FileNotFoundError:
            pass
        time.sleep(0.05)
    raise AssertionError('Independent TextEdit file oracle did not reach the expected UTF-8 bytes.')


def progress(report: dict, phase: str) -> None:
    print(json.dumps({'progress': phase, 'phases': report['phases']}), flush=True)


def wait_for_target(address: Path, session_id: str, turn_id: str,
                    worker: threading.Thread, timeout: float = 8) -> dict:
    """Wait for trusted service context plus original status on a fresh turn."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline and worker.is_alive():
        try:
            last = control_request(address, {
                'type': 'status', 'session_id': session_id, 'turn_id': turn_id}, timeout=6)
            apps = last.get('result', {}).get('computerUse', {}).get('activeApplications', [])
            if (last.get('ok') is True and
                    any(item.get('bundleIdentifier') == APP_ID for item in apps)):
                return last
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
            pass
        time.sleep(0.05)
    raise AssertionError('No original status proved the fresh-turn TextEdit execute context '
                         f'while its MCP call remained pending; last={last!r}')


def environment(test_tmp: Path, app: Path, control_path: Path) -> dict[str, str]:
    resources = app / 'Contents/Resources'
    codex = codex_cli(resources)
    runtime = resources / 'cua_node'
    modules = runtime / 'lib/node_modules'
    plugins = resources / 'plugins'
    codex_home = test_tmp / 'codex-home'
    codex_home.mkdir()
    # Keep HOME pointed at the disposable guest account: the original signed
    # helper's native-pipe registration and its guest TCC grants are user-scoped.
    return {
        'HOME': os.environ.get('HOME', str(Path.home())),
        'CODEX_HOME': str(codex_home),
        'PATH': os.pathsep.join((str(Path(sys.executable).parent), str(runtime / 'bin'),
                                 '/usr/bin', '/bin')),
        'LANG': 'C.UTF-8',
        'TMPDIR': str(test_tmp),
        'CUA_REPL_ENABLED_SURFACES': 'computer',
        'CUA_REPL_BROWSER_ENV': 'codex-app',
        'CUA_REPL_NODE_REPL_PATH': str(runtime / 'bin/node_repl'),
        'NODE_REPL_NODE_PATH': str(runtime / 'bin/node'),
        'NODE_REPL_NODE_MODULE_DIRS': str(modules),
        'NODE_REPL_TRUSTED_CODE_PATHS': os.pathsep.join((str(codex_home), str(modules), str(plugins))),
        'NODE_REPL_DISABLE_ANALYTICS': '1',
        'BROWSER_USE_DISABLE_AMBIENT_NETWORK': '1',
        'CODEX_CLI_PATH': str(codex),
        'SKY_CUA_SERVICE_PATH': str(runtime / 'lib/node_modules/@oai/sky/Codex Computer Use.app'),
        'LCU_MAC_CONTROL_SOCKET': str(control_path),
    }


def native_call(client: Client, code: str, metadata: dict, *, timeout: int = 45) -> dict:
    return tool_call(client, 'js', {'code': code}, metadata, timeout=timeout)


def require_stopped_result(result: dict, phase: str) -> None:
    description = json.dumps(result, sort_keys=True)
    if not result.get('isError') or not all(phrase in description.lower() for phrase in STOPPED_MESSAGE):
        raise AssertionError(f'{phase} did not return the original stopped-for-this-turn response: {description[:4000]}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=Path('/Applications/ChatGPT.app'))
    parser.add_argument('--release', type=Path,
                        default=Path.home() / 'lcu-installed/current',
                        help='Installed LCU release root; defaults to the documented guest install.')
    parser.add_argument('--expected-user', default='lcutest')
    parser.add_argument('--run-native-stop', action='store_true',
                        help='Required confirmation that actions will run only in the disposable guest.')
    parser.add_argument('--grant-textedit-always', action='store_true',
                        help='Accept the exact original TextEdit approval once with persistent scope in this guest.')
    parser.add_argument('--skip-pending-native-stop', action='store_true',
                        help='Skip only the long in-flight native action; run new-turn and between-RPC checks.')
    args = parser.parse_args()
    if not args.run_native_stop:
        parser.error('Pass --run-native-stop only when running in the task-owned disposable guest.')
    guest_model = require_guest(args.expected_user)
    app = args.app.resolve(strict=True)
    release = args.release.resolve(strict=True)
    os.environ['LCU_MODULE_ROOT'] = str(release)

    resources = app / 'Contents/Resources'
    runtime = resources / 'cua_node'
    helper = runtime / 'lib/node_modules/@oai/sky/Codex Computer Use.app'
    node = runtime / 'bin/node'
    entry = runtime / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs'
    lcu = release / 'bin/lcu'
    if not all(path.is_file() for path in (node, entry, lcu)) or not helper.is_dir():
        parser.error('The selected original helper/runtime or installed LCU executable is missing.')
    signature = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)],
                               capture_output=True, text=True)
    if signature.returncode:
        parser.error(f'The selected original app signature check failed: {signature.stderr.strip()}')
    version = plistlib.loads((app / 'Contents/Info.plist').read_bytes()).get('CFBundleShortVersionString')

    report = {'guest_model': guest_model, 'guest_user': args.expected_user,
              'app_version': version, 'target_app': APP_ID,
              'model_or_provider_requests': 0, 'phases': {}}
    approval_events: list[dict] = []
    cleanup_events: list[dict] = []
    with tempfile.TemporaryDirectory(prefix='lcu-stop-acceptance-', dir='/private/tmp') as temporary:
        test_tmp = Path(temporary)
        control_path = test_tmp / 'control.sock'
        env = environment(test_tmp, app, control_path)
        # Read the actual LCU child connection metadata through the original
        # runtime. Replay that exact object without inventing model, call, or
        # thread claims; the following test turn gets a fresh ID.
        env.pop('NODE_REPL_REQUEST_META', None)
        env['LCU_MAC_CONTROL_SOCKET'] = str(control_path)
        document = test_tmp / 'generated-lcu-stop-fixture.txt'
        document.write_text('Disposable LCU Stop fixture.\nThis generated file may be edited during the test.\n')
        subprocess.run(['/usr/bin/open', '-a', 'TextEdit', str(document)], check=True, timeout=10)
        time.sleep(1)
        client = Client([str(lcu)], env=env,
                        capabilities={'elicitation': {}},
                        request_handler=approval_handler('', allow_persistent=False, events=approval_events))
        client_closed = False
        skip_turn_cleanup = False
        try:
            # The original runtime attaches its platform guide to the first
            # JS result. Warm it once before reading a machine-readable value.
            tools = client.call('tools/list', {})['tools']
            turn_tool = next((item for item in tools if item.get('name') == 'turn_ended'), None)
            turn_schema = turn_tool.get('inputSchema', {}) if isinstance(turn_tool, dict) else {}
            turn_properties = turn_schema.get('properties', {}) if isinstance(turn_schema, dict) else {}
            report['phases']['original_turn_ended_tool_schema'] = {
                'present': isinstance(turn_tool, dict),
                'required': sorted(turn_schema.get('required', [])) if isinstance(turn_schema, dict) else [],
                'properties': sorted(turn_properties) if isinstance(turn_properties, dict) else [],
            }
            if not {'hook_event_name', 'session_id', 'turn_id'} <= set(turn_properties):
                raise AssertionError('Original turn_ended tool schema lacks the scoped Stop/turn fields.')
            warmup = text(client.js('nodeRepl.write("ready");'))
            if not warmup.endswith('ready'):
                raise AssertionError(f'Original pure-JS warmup returned an unexpected result: {warmup[-512:]!r}')
            if 'macOS' not in warmup and 'macOS' not in json.dumps(tools):
                raise AssertionError('The original macOS guide was not present in tools or the first JS result.')
            report['phases']['original_pure_js_warmup'] = 'passed'
            progress(report, 'original_pure_js_warmup')
            metadata = metadata_from_runtime(client)
            metadata = {**metadata, 'session_id': str(uuid.uuid4()),
                        'turn_id': str(uuid.uuid4())}
            report['fixture_metadata'] = {
                'session_id_is_uuid': True,
                'turn_id_is_uuid': True,
                'call_id_source': 'next JSON-RPC request ID, encoded as string',
            }
            # Rebind exact-session approval checks after reading original requestMeta.
            client.request_handler = approval_handler(metadata['session_id'],
                allow_persistent=args.grant_textedit_always, events=approval_events)
            session_id = metadata['session_id']
            first_turn = metadata['turn_id']
            active_turns = {first_turn}

            def end_turn(turn_id: str) -> None:
                if turn_id not in active_turns:
                    return
                ended = client.call('tools/call', {'name': 'turn_ended', 'arguments': {
                    'hook_event_name': 'Stop', 'session_id': session_id,
                    'turn_id': turn_id}}, timeout=30)
                if ended.get('isError'):
                    raise AssertionError(f'Original turn-ended cleanup failed: {json.dumps(ended)[:2000]}')
                cleanup_events.append({
                    'hook_event_name': 'Stop',
                    'session_id_matches_expected': session_id == metadata['session_id'],
                    'turn_id_was_active': turn_id in active_turns,
                    'mcp_is_error': bool(ended.get('isError')),
                    'response_content_types': [item.get('type') for item in ended.get('content', [])
                                               if isinstance(item, dict)],
                })
                report['phases']['last_turn_cleanup'] = cleanup_events[-1]
                active_turns.discard(turn_id)

            wait_for_socket(control_path)

            desktop_state = native_call(client,
                'await cua.getState(); nodeRepl.write("desktop-state-ready");', metadata)
            if (desktop_state.get('isError') or
                    not text(desktop_state).endswith('desktop-state-ready')):
                raise AssertionError(f'Original desktop state request failed: {json.dumps(desktop_state)[:4000]}')
            report['phases']['original_desktop_state'] = 'passed'
            progress(report, 'original_desktop_state')

            # Keep one original API call in each JS entrypoint. The original
            # first-access guide recommends reading that result before the
            # next action; keep the TextEdit state call separate and report
            # only its documented return shape, never its accessibility text.
            textedit_state = native_call(client,
                f'await (async()=>{{const state=await cua.computer.get_app_state({{app:"TextEdit"}}); '
                'nodeRepl.write(JSON.stringify({type:typeof state, keys:Object.keys(state??{}).sort(), '
                'app:state?.app, screenshot:state?.screenshot===null?"null":typeof state?.screenshot, '
                'text:typeof state?.text}));})();', metadata)
            if textedit_state.get('isError'):
                raise AssertionError(f'Original TextEdit state request failed: {json.dumps(textedit_state)[:4000]}')
            try:
                state_shape = json.loads(text(textedit_state).strip().splitlines()[-1])
            except (IndexError, json.JSONDecodeError) as exc:
                raise AssertionError('Original TextEdit state did not return its safe shape marker.') from exc
            state_app = state_shape.get('app')
            is_textedit = state_app == APP_ID
            identity_check = {'selector_matches_bundle_id': is_textedit}
            if isinstance(state_app, str) and Path(state_app).is_absolute() and state_app.endswith('.app'):
                info_path = Path(state_app) / 'Contents/Info.plist'
                identity_check['info_plist_exists'] = info_path.is_file()
                try:
                    state_bundle = plistlib.loads(
                        info_path.read_bytes()).get('CFBundleIdentifier')
                    identity_check['info_plist_bundle_id'] = state_bundle
                except (OSError, plistlib.InvalidFileException) as exc:
                    state_bundle = None
                    identity_check['info_plist_read_error'] = type(exc).__name__
                is_textedit = state_bundle == APP_ID
                identity_check['bundle_id_matches'] = is_textedit
            shape_checks = {
                'is_object': state_shape.get('type') == 'object',
                'has_expected_keys': state_shape.get('keys') == ['app', 'screenshot', 'text'],
                'is_textedit': is_textedit,
                'text_is_string': state_shape.get('text') == 'string',
                'screenshot_type_valid': state_shape.get('screenshot') in ('null', 'object'),
            }
            if not all(shape_checks.values()):
                raise AssertionError(f'Original TextEdit state returned an unexpected shape: '
                                     f'{state_shape!r}; shape_checks={shape_checks!r}; '
                                     f'identity_check={identity_check!r}')
            report['phases']['original_textedit_state'] = state_shape
            progress(report, 'original_textedit_state')
            status = control_request(control_path, {
                'type': 'status', 'session_id': session_id, 'turn_id': first_turn})
            apps = status.get('result', {}).get('computerUse', {}).get('activeApplications', [])
            if status.get('ok') is not True or not any(item.get('bundleIdentifier') == APP_ID for item in apps):
                raise AssertionError(f'Original status did not report the targeted TextEdit app: {status}')
            report['phases']['original_status'] = 'passed'
            progress(report, 'original_status')
            end_turn(first_turn)
            report['phases']['first_turn_cleanup'] = 'passed'
            progress(report, 'first_turn_cleanup')

            if not args.skip_pending_native_stop:
                # Use a fresh, distinct test turn so the host status below proves
                # this pending original execute request supplied its own context.
                pending_turn = dict(metadata)
                pending_turn['turn_id'] = str(uuid.uuid4())
                active_turns.add(pending_turn['turn_id'])
                # Original Computer Use requires app state in each new turn
                # before it accepts an action for that app.
                pending_state = native_call(client,
                    f'await cua.computer.get_app_state({{app:{json.dumps(APP_ID)}}}); '
                    'nodeRepl.write("pending-turn-app-state-ready");', pending_turn)
                if (pending_state.get('isError') or
                        not text(pending_state).rstrip().endswith('pending-turn-app-state-ready')):
                    raise AssertionError('TextEdit state was not initialized for the pending Stop turn: '
                                         f'{json.dumps(pending_state)[:2000]}')
                # Keep a native type_text MCP call outstanding while Stop is
                # sent. The original status proves trusted app context exists;
                # it does not prove the native keystroke has started.
                pending_text = 'LCU-STOP-PENDING-FIXTURE-0123456789\n' * 100
                pending_code = (f'await cua.computer.type_text({{app:{json.dumps(APP_ID)},'
                                f'text:{json.dumps(pending_text)}}}); nodeRepl.write("completed");')
                pending_results: list[dict] = []
                pending_errors: list[BaseException] = []

                def send_pending_action() -> None:
                    try:
                        pending_results.append(native_call(client, pending_code, pending_turn, timeout=45))
                    except BaseException as error:
                        pending_errors.append(error)

                pending_worker = threading.Thread(target=send_pending_action, daemon=True)
                pending_worker.start()
                dispatch_status = wait_for_target(control_path, session_id,
                                                  pending_turn['turn_id'], pending_worker)
                target_apps = dispatch_status['result']['computerUse']['activeApplications']
                target_app = next(item for item in target_apps
                                  if item.get('bundleIdentifier') == APP_ID)
                if not isinstance(target_app.get('name'), str) or not target_app['name'].strip():
                    raise AssertionError(f'Original native status omitted the app name required by Pi Stop: {target_app!r}')
                if not pending_worker.is_alive():
                    raise AssertionError('The original native action returned before Stop could target it.')
                progress(report, 'pending_native_action_observed')
                stop_started = time.monotonic()
                accepted = control_request(control_path, {
                    'type': 'stop', 'session_id': session_id,
                    'turn_id': pending_turn['turn_id'], 'app': APP_ID})
                if accepted.get('ok') is not True or accepted.get('result') != {
                        'accepted': True, 'applicationId': APP_ID}:
                    raise AssertionError(f'Original AppStop did not accept the pending action: {accepted}')
                pending_alive_at_ack = pending_worker.is_alive()
                report['phases']['stop_during_native_action_accepted'] = {
                    'result': accepted['result'],
                    'elapsed_ms': round((time.monotonic() - stop_started) * 1000),
                    'pending_mcp_call_alive_at_ack': pending_alive_at_ack,
                }
                progress(report, 'stop_during_native_action_accepted')
                pending_worker.join(timeout=45)
                pending_outcome = 'still_pending_after_45s' if pending_worker.is_alive() else 'returned'
                if pending_errors:
                    pending_outcome = 'client_error:' + type(pending_errors[0]).__name__
                elif pending_results:
                    pending_outcome = ('original_stopped_error' if pending_results[0].get('isError') and
                        all(phrase in json.dumps(pending_results[0]).lower() for phrase in STOPPED_MESSAGE)
                        else 'other_error' if pending_results[0].get('isError') else 'completed')
                report['phases']['pending_native_action_outcome'] = pending_outcome
                progress(report, 'pending_native_action_outcome')
                # A client timeout or a worker that remains alive leaves the
                # JSON-RPC stream ambiguous. Do not send a second call on that
                # stream; close this disposable LCU process and report the
                # observed outcome instead of manufacturing a follow-up result.
                if pending_worker.is_alive() or pending_errors:
                    skip_turn_cleanup = True
                    active_turns.clear()
                    client.close()
                    client_closed = True
                    pending_worker.join(timeout=10)
                    report['phases']['pending_stream_cleanup'] = {
                        'client_closed_before_any_follow_up_call': True,
                        'worker_still_alive_after_close': pending_worker.is_alive(),
                        'explicit_turn_ended_skipped': True,
                    }
                    progress(report, 'pending_stream_cleanup')
                    raise AssertionError('The pending MCP call did not return cleanly after Stop; '
                                         'closed its client without sending another RPC.')
                after_pending_stop = native_call(client,
                    f'await cua.computer.type_text({{app:{json.dumps(APP_ID)},text:"AFTER-PENDING-STOP\\n"}}); '
                    'nodeRepl.write("unexpectedly-completed");', pending_turn, timeout=30)
                require_stopped_result(after_pending_stop, 'next native action after pending Stop')
                report['phases']['stop_during_native_action'] = {
                    'accepted_while_pending_call_observed': True,
                    'pending_call_alive_at_ack': pending_alive_at_ack,
                    'pending_call_outcome': pending_outcome,
                    'next_same_turn_action_rejected': True,
                    'fresh_turn_original_status_observed': True,
                    'target_application': {
                        'fields': sorted(target_app), 'name': target_app['name'],
                        'bundleIdentifier': target_app['bundleIdentifier'],
                    },
                }
                progress(report, 'stop_during_native_action')
                end_turn(pending_turn['turn_id'])
            else:
                report['phases']['stop_during_native_action'] = (
                    'skipped for isolated between-RPC and recovery run; prior run observed AppStop accepted '
                    'but its pending MCP call timed out')

            # Complete one original native action, Stop the same active host
            # turn between MCP calls, then require the next native action in
            # that same turn to receive the original stopped-turn result.
            between_turn = dict(metadata)
            between_turn['turn_id'] = str(uuid.uuid4())
            active_turns.add(between_turn['turn_id'])
            between_state = native_call(client,
                f'await cua.computer.get_app_state({{app:{json.dumps(APP_ID)}}}); '
                'nodeRepl.write("between-turn-app-state-ready");', between_turn)
            if (between_state.get('isError') or
                    not text(between_state).rstrip().endswith('between-turn-app-state-ready')):
                raise AssertionError('TextEdit state was not initialized for the between-call Stop turn: '
                                     f'{json.dumps(between_state)[:2000]}')
            before_stop = native_call(client,
                'await cua.computer.type_text({app:"TextEdit",text:"BEFORE-STOP-BOUNDARY\\n"}); '
                'nodeRepl.write("first-native-call-returned");', between_turn, timeout=45)
            if before_stop.get('isError') or not text(before_stop).rstrip().endswith('first-native-call-returned'):
                raise AssertionError('The completed native call did not return before inter-call Stop: '
                                     f'{json.dumps(before_stop)[:2000]}')
            report['phases']['between_rpc_first_native_call'] = 'returned before Stop'
            progress(report, 'between_rpc_first_native_call')
            dispatch_status = control_request(control_path, {
                'type': 'status', 'session_id': session_id,
                'turn_id': between_turn['turn_id']})
            apps = dispatch_status.get('result', {}).get('computerUse', {}).get('activeApplications', [])
            target_app = next((item for item in apps if item.get('bundleIdentifier') == APP_ID), None)
            if dispatch_status.get('ok') is not True or target_app is None:
                raise AssertionError('Original status did not retain the active app across completed calls.')
            if not isinstance(target_app.get('name'), str) or not target_app['name'].strip():
                raise AssertionError('Original status omitted the app name needed by the Pi Stop selector.')
            second_stop = control_request(control_path, {
                'type': 'stop', 'session_id': session_id,
                'turn_id': between_turn['turn_id'], 'app': APP_ID})
            if second_stop.get('ok') is not True:
                raise AssertionError(f'Original AppStop failed between native calls: {second_stop}')
            report['phases']['stop_between_native_calls_accepted'] = second_stop.get('result')
            progress(report, 'stop_between_native_calls_accepted')
            after_stop = native_call(client,
                f'await cua.computer.type_text({{app:{json.dumps(APP_ID)},text:"AFTER-STOP-BOUNDARY\\n"}}); '
                'nodeRepl.write("unexpectedly-completed");', between_turn, timeout=30)
            require_stopped_result(after_stop, 'next native action in stopped turn')
            report['phases']['stop_between_native_calls'] = 'passed: original stopped-for-this-turn response'
            progress(report, 'stop_between_native_calls')
            end_turn(between_turn['turn_id'])

            # Verify recovery only after the new-turn Stop cleanup. The
            # independent disk oracle and approval counter must both pass.
            recovery_turn = dict(metadata)
            recovery_turn['turn_id'] = str(uuid.uuid4())
            active_turns.add(recovery_turn['turn_id'])
            meta_result = native_call(client,
                'await (async()=>{const m=nodeRepl.requestMeta?.["x-codex-turn-metadata"]; '
                'nodeRepl.write(typeof m==="string"?m:JSON.stringify(m));})();', recovery_turn)
            try:
                runtime_metadata = json.loads(text(meta_result).strip().splitlines()[-1])
                if isinstance(runtime_metadata, str):
                    runtime_metadata = json.loads(runtime_metadata)
            except (IndexError, json.JSONDecodeError):
                runtime_metadata = None
            report['phases']['fresh_turn_metadata_probe'] = {
                'js_call_is_error': bool(meta_result.get('isError')),
                'metadata_is_object': isinstance(runtime_metadata, dict),
                'session_id_matches': (isinstance(runtime_metadata, dict) and
                                      runtime_metadata.get('session_id') == session_id),
                'turn_id_matches_recovery': (isinstance(runtime_metadata, dict) and
                                             runtime_metadata.get('turn_id') == recovery_turn['turn_id']),
                'turn_id_differs_from_stopped': (isinstance(runtime_metadata, dict) and
                                                  runtime_metadata.get('turn_id') != between_turn['turn_id']),
                'call_id_matches_rpc_id': (isinstance(runtime_metadata, dict) and
                                           runtime_metadata.get('call_id') == str(client.sequence)),
            }
            progress(report, 'fresh_turn_metadata_probe')
            before_approvals = len(approval_events)
            oracle_marker = 'LCU Stop acceptance native file oracle\n'
            for code, expected_marker in (
                ('await cua.getState(); nodeRepl.write("new-turn-ready");', 'new-turn-ready'),
                (f'await cua.computer.get_app_state({{app:{json.dumps(APP_ID)}}}); nodeRepl.write("state-ready");', 'state-ready'),
                (f'await cua.computer.press_key({{app:{json.dumps(APP_ID)},key:"super+a"}}); nodeRepl.write("selection-ready");', 'selection-ready'),
                (f'await cua.computer.type_text({{app:{json.dumps(APP_ID)},text:{json.dumps(oracle_marker)}}}); nodeRepl.write("write-ready");', 'write-ready'),
                (f'await cua.computer.press_key({{app:{json.dumps(APP_ID)},key:"super+s"}}); nodeRepl.write("save-ready");', 'save-ready'),
            ):
                continued = native_call(client, code, recovery_turn)
                if continued.get('isError') or not text(continued).rstrip().endswith(expected_marker):
                    raise AssertionError('A new turn after Stop failed during its native recovery call; '
                                         f'marker={expected_marker}, result={json.dumps(continued)[:2000]}')
            if len(approval_events) != before_approvals:
                raise AssertionError('A new turn after Stop requested fresh TextEdit approval.')
            wait_for_file_bytes(document, oracle_marker.encode('utf-8'))
            report['phases']['new_turn_and_approval_retained'] = 'passed after between-RPC Stop'
            report['phases']['independent_file_oracle'] = {
                'path': str(document), 'utf8_bytes': len(document.read_bytes()),
                'content_match': True,
            }
            end_turn(recovery_turn['turn_id'])
            progress(report, 'new_turn_and_approval_retained')
        finally:
            pending_worker = locals().get('pending_worker')
            pending_errors = locals().get('pending_errors', [])
            pending_stream_unsafe = (pending_worker is not None and
                                     (pending_worker.is_alive() or bool(pending_errors)))
            if pending_stream_unsafe:
                # This covers failures before the normal post-join guard too,
                # such as a status/control timeout while the worker is active.
                # Closing this disposable process is the only safe cleanup;
                # another JSON-RPC request could race the still-pending reader.
                skip_turn_cleanup = True
                active_turns.clear()
                if not client_closed:
                    client.close()
                    client_closed = True
                pending_worker.join(timeout=10)
                report['phases']['pending_stream_cleanup'] = {
                    'client_closed_before_any_follow_up_call': True,
                    'worker_still_alive_after_close': pending_worker.is_alive(),
                    'explicit_turn_ended_skipped': True,
                }
                progress(report, 'pending_stream_cleanup')
            if not skip_turn_cleanup:
                for turn_id in list(locals().get('active_turns', ())):
                    try:
                        end_turn(turn_id)
                    except Exception as cleanup_error:
                        report.setdefault('cleanup_errors', []).append(type(cleanup_error).__name__)
            if not client_closed:
                client.close()
    report['approval_prompts'] = len(approval_events)
    report['turn_cleanup_events'] = cleanup_events
    report['persistent_test_approval_added'] = bool(args.grant_textedit_always and approval_events)
    report['generated_fixture_only'] = True
    report['result'] = 'passed'
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
