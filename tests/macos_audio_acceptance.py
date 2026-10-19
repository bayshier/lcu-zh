"""Run a generated-tone audio acceptance check inside the disposable UTM guest.

This script refuses to record unless it runs as the documented guest account on
Apple Virtualization hardware. It compares disabled method exposure and an
approved generated-tone capture through the direct original MCP server and LCU.
It does not launch the ChatGPT UI or make a provider request.
"""

import argparse
import array
import base64
import hashlib
import io
import json
import math
import os
import re
from pathlib import Path
import platform
import plistlib
import pwd
import subprocess
import sys
import tempfile
import time
import uuid
import wave

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lcu_node import codex_cli  # noqa: E402
from mcp_client import Client, text  # noqa: E402


def require_disposable_guest(expected_user: str) -> str:
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise SystemExit('Refusing capture: this acceptance test is for the Apple Silicon macOS guest.')
    username = pwd.getpwuid(os.getuid()).pw_name
    if username != expected_user:
        raise SystemExit(f'Refusing capture: expected disposable guest user {expected_user!r}, got {username!r}.')
    model = subprocess.run(['/usr/sbin/sysctl', '-n', 'hw.model'], check=True,
                           capture_output=True, text=True).stdout.strip()
    if not model.startswith('VirtualMac'):
        raise SystemExit(f'Refusing capture: expected Apple Virtualization VM hardware, got {model!r}.')
    return model


def environment(home: Path, app: Path, *, audio: bool) -> dict[str, str]:
    # Ask the selected LCU release (LCU_MODULE_ROOT) so the original and
    # LCU children use the same app-selected codex executable path.
    resources = app / 'Contents/Resources'
    runtime = resources / 'cua_node'
    codex = codex_cli(resources)
    modules = runtime / 'lib/node_modules'
    plugins = resources / 'plugins'
    helper = modules / '@oai/sky/Codex Computer Use.app'
    codex_home = home / '.codex'
    codex_home.mkdir(parents=True)
    env = {
        # Preserve the disposable guest account's real HOME: original macOS
        # native-pipe resolves the installed helper socket under os.homedir().
        # Isolate Codex state and scratch paths separately.
        'HOME': str(Path.home()),
        'CODEX_HOME': str(codex_home),
        'PATH': os.pathsep.join((str(Path(sys.executable).parent), str(runtime / 'bin'),
                                 '/usr/bin', '/bin')),
        'LANG': 'C.UTF-8',
        'TMPDIR': str(home),
        'CUA_REPL_ENABLED_SURFACES': 'computer',
        'SKY_CUA_SERVICE_PATH': str(helper),
        'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS': '1000',
        'CUA_REPL_NODE_REPL_PATH': str(runtime / 'bin/node_repl'),
        'NODE_REPL_NODE_PATH': str(runtime / 'bin/node'),
        'NODE_REPL_NODE_MODULE_DIRS': str(modules),
        'NODE_REPL_TRUSTED_CODE_PATHS': os.pathsep.join((str(codex_home), str(modules), str(plugins))),
        'CODEX_CLI_PATH': str(codex),
        'NODE_REPL_DISABLE_ANALYTICS': '1',
        'NODE_REPL_REQUEST_META': json.dumps({'x-codex-turn-metadata': {
            'session_id': f'lcu-audio-{uuid.uuid4()}', 'turn_id': str(uuid.uuid4())}}),
    }
    if audio:
        env['SKY_ENABLE_AUDIO'] = '1'
        env['NODE_REPL_ENABLE_AUDIO'] = '1'
    return env


def methods(command: list[str], env: dict[str, str]) -> set[str]:
    client = Client(command, env=env, capabilities={'elicitation': {}})
    try:
        client.js('await cua.getState();')
        result = client.js('nodeRepl.write(JSON.stringify(Object.keys(cua.computer).sort()));')
        return set(json.loads(text(result)))
    finally:
        client.close()


def make_tone(path: Path, *, sample_rate: int = 48000, seconds: float = 3.0,
              frequency: float = 440.0) -> None:
    amplitude = 0.25 * 32767
    frames = array.array('h', (
        int(amplitude * math.sin(2 * math.pi * frequency * i / sample_rate))
        for i in range(int(sample_rate * seconds))))
    if sys.byteorder != 'little':
        frames.byteswap()
    with wave.open(str(path), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(frames.tobytes())


def estimate_tone(raw: bytes) -> dict:
    with wave.open(io.BytesIO(raw), 'rb') as recording:
        channels = recording.getnchannels()
        sample_width = recording.getsampwidth()
        sample_rate = recording.getframerate()
        frame_count = recording.getnframes()
        if sample_width != 2:
            raise AssertionError(f'Expected PCM16 WAV, got {sample_width * 8}-bit samples.')
        samples = array.array('h', recording.readframes(frame_count))
    if sys.byteorder != 'little':
        samples.byteswap()
    if channels < 1 or len(samples) != frame_count * channels:
        raise AssertionError('WAV channel/frame count is invalid.')
    mono = [sum(samples[i:i + channels]) / channels for i in range(0, len(samples), channels)]
    peak = max((abs(sample) for sample in mono), default=0)
    if frame_count < sample_rate // 2 or peak < 128:
        raise AssertionError(f'Recording is too short or silent: frames={frame_count}, peak={peak}.')
    # Ignore attack/tail transients and count only positive crossings near the
    # middle of the generated steady tone.
    start = len(mono) // 5
    end = len(mono) * 4 // 5
    crossings = sum(1 for left, right in zip(mono[start:end - 1], mono[start + 1:end])
                    if left <= 0 < right)
    measured = crossings * sample_rate / max(1, end - start - 1)
    duration = frame_count / sample_rate
    if abs(measured - 440.0) > 30.0:
        raise AssertionError(f'Generated 440 Hz signal not recovered; estimated {measured:.1f} Hz.')
    return {'channels': channels, 'sample_width_bits': 16, 'sample_rate_hz': sample_rate,
            'frames': frame_count, 'duration_seconds': round(duration, 4),
            'peak_sample': round(peak), 'estimated_tone_hz': round(measured, 1),
            'sha256': hashlib.sha256(raw).hexdigest()}


def inspect_original_audio_source(resources: Path) -> dict:
    sky = resources / 'cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src'
    implementation = sky / 'targets/mac/audio_recording.js'
    declaration = sky / 'types/window/StartAudioRecording.d.ts'
    source = implementation.read_text(encoding='utf-8')
    types = declaration.read_text(encoding='utf-8')
    input_type = re.search(r'export type Input = \{([^}]*)\};', types, re.DOTALL)
    if not input_type:
        raise AssertionError('Selected original Sky has no inspectable Mac audio input schema.')
    fields = re.findall(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:', input_type.group(1), re.MULTILINE)
    if fields != ['max_duration_ms'] or 'loopback audio' not in types.lower():
        raise AssertionError('Selected original Sky audio API no longer describes loopback capture with only a duration option; inspect before recording.')
    if ('requestComputerAudioApproval' not in source or 'startAudioRecording' not in source or
            'maxDurationMilliseconds' not in source):
        raise AssertionError('Selected original Mac implementation does not match the inspected computer-audio approval and helper path.')
    return {
        'implementation': str(implementation),
        'implementation_sha256': hashlib.sha256(implementation.read_bytes()).hexdigest(),
        'declaration': str(declaration),
        'declaration_sha256': hashlib.sha256(declaration.read_bytes()).hexdigest(),
        'input_fields': fields,
        'loopback_documented': True,
        'original_computer_audio_approval': True,
        'native_input_device_selected_by_LCU': False,
    }


def audio_approval_handler(expected_metadata: dict, events: list[dict]):
    def handle(method: str, params: dict) -> dict:
        if method != 'elicitation/create':
            raise AssertionError(f'Unexpected original host request: {method}')
        meta = params.get('_meta', {})
        if not isinstance(meta, dict):
            raise AssertionError('Original computer-audio approval metadata is malformed.')
        context = meta.get('x-codex-turn-metadata', {})
        if isinstance(context, str):
            context = json.loads(context)
        if not isinstance(context, dict):
            raise AssertionError('Original computer-audio approval metadata is malformed.')
        exact = (params.get('mode') == 'form' and
                 params.get('message') == 'Allow Computer Use to record computer audio?' and
                 params.get('requestedSchema') == {'type': 'object', 'properties': {}} and
                 meta.get('codex_approval_kind') == 'mcp_tool_call' and
                 meta.get('codex_request_type') == 'approval_request' and
                 meta.get('connector_id') == 'computer-use' and
                 meta.get('tool_name') == 'start_audio_recording' and
                 meta.get('tool_params') == {} and
                 meta.get('persist') == ['session'] and
                 meta.get('riskLevel') == 'high' and
                 context.get('session_id') == expected_metadata.get('session_id') and
                 context.get('turn_id') == expected_metadata.get('turn_id'))
        if not exact:
            raise AssertionError('Refusing an unexpected or differently scoped computer-audio approval request.')
        events.append({'session_id': context['session_id'], 'turn_id': context['turn_id']})
        # Audio approval has session persistence only in original Sky. Accept
        # this one generated-tone test request without adding persistence.
        return {'action': 'accept', 'content': {}}
    return handle


def record(command: list[str], env: dict[str, str], tone: Path, side: str) -> dict:
    expected_metadata = json.loads(env['NODE_REPL_REQUEST_META'])['x-codex-turn-metadata']
    approval_events: list[dict] = []
    client = Client(command, env=env, capabilities={'elicitation': {}},
                     request_handler=audio_approval_handler(expected_metadata, approval_events))
    player = None
    try:
        client.js('await cua.getState();')
        names = set(json.loads(text(client.js(
            'nodeRepl.write(JSON.stringify(Object.keys(cua.computer).sort()));'))))
        required = {'start_audio_recording', 'stop_audio_recording'}
        if not required <= names:
            raise AssertionError(f'Opt-in MCP child is missing original audio methods: {sorted(required - names)}')
        client.js('await cua.computer.start_audio_recording({max_duration_ms:8000});')
        print(json.dumps({'progress': 'recording_started', 'side': side}), flush=True)
        time.sleep(0.3)
        player = subprocess.Popen(['/usr/bin/afplay', '-v', '0.75', str(tone)],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            _, error = player.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            player.kill()
            player.communicate()
            raise AssertionError('Guest afplay tone fixture did not finish.')
        if player.returncode:
            raise AssertionError(f'Guest afplay failed: {error.decode(errors="replace")}')
        player = None
        print(json.dumps({'progress': 'generated_tone_played', 'side': side}), flush=True)
        time.sleep(0.2)
        stopped = client.js(
            'var lcuAudio=await cua.computer.stop_audio_recording(); '
            'nodeRepl.write(JSON.stringify({data_url:lcuAudio.data_url,byte_length:lcuAudio.bytes.length}));')
        payload = json.loads(text(stopped))
        if not payload['data_url'].startswith('data:audio/wav;base64,'):
            raise AssertionError(f'Unexpected original recording URL: {payload["data_url"][:48]!r}')
        raw = base64.b64decode(payload['data_url'].split(',', 1)[1], validate=True)
        if len(raw) != payload['byte_length']:
            raise AssertionError('Original result byte count differs from its WAV payload.')
        print(json.dumps({'progress': 'recording_stopped', 'side': side, 'bytes': len(raw)}), flush=True)
        summary = estimate_tone(raw)
        delivered = client.js('await nodeRepl.emitAudio(lcuAudio.data_url);')
        blocks = [block for block in delivered.get('content', []) if block.get('type') == 'audio']
        if len(blocks) != 1 or blocks[0].get('mimeType') not in ('audio/wav', 'audio/x-wav'):
            raise AssertionError('The original MCP result did not contain one WAV audio block.')
        emitted = base64.b64decode(blocks[0]['data'], validate=True)
        if emitted != raw:
            raise AssertionError('Original MCP audio block differs from recorded WAV bytes.')
        print(json.dumps({'progress': 'audio_verified', 'side': side, 'capture': summary}), flush=True)
        client.js('await cua.computer.stop_audio_recording();', error=True)
        if len(approval_events) != 1:
            raise AssertionError(f'Expected one original computer-audio approval, got {len(approval_events)}.')
        return {'capture': summary, 'original_audio_approval_prompts': len(approval_events),
                'mcp_audio_bytes_match': True,
                'provider_audio_request': False}
    finally:
        if player is not None and player.poll() is None:
            player.kill()
            player.wait()
        client.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=Path('/Applications/ChatGPT.app'))
    parser.add_argument('--release', type=Path, required=True,
                        help='Installed LCU release root with bin/lcu; use current symlink.')
    parser.add_argument('--expected-user', default='lcutest',
                        help='Disposable guest short name recorded in the guest verification document.')
    args = parser.parse_args()
    model = require_disposable_guest(args.expected_user)
    app = args.app.resolve(strict=True)
    release = args.release.resolve(strict=True)
    os.environ['LCU_MODULE_ROOT'] = str(release)

    resources = app / 'Contents/Resources'
    runtime = resources / 'cua_node'
    node = runtime / 'bin/node'
    entry = runtime / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs'
    lcu = release / 'bin/lcu'
    if not node.is_file() or not entry.is_file() or not lcu.is_file():
        parser.error('Selected original runtime or LCU executable is missing.')
    version = plistlib.loads((app / 'Contents/Info.plist').read_bytes()).get('CFBundleShortVersionString')
    signature = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)],
                               capture_output=True, text=True)
    if signature.returncode:
        parser.error(f'Selected original app failed read-only signature verification: {signature.stderr.strip()}')

    original = [str(node), str(entry)]
    off_required = {'start_audio_recording', 'stop_audio_recording'}
    report = {'guest_model': model, 'guest_user': args.expected_user,
              'app_version': version, 'results': {}}
    report['original_audio_source'] = inspect_original_audio_source(resources)
    print(json.dumps({'progress': 'original_audio_source_verified',
                      'source': report['original_audio_source']}), flush=True)
    with tempfile.TemporaryDirectory(prefix='lcu-macos-audio-', dir='/private/tmp') as temporary:
        root = Path(temporary)
        tone = root / 'generated-440hz.wav'
        make_tone(tone)
        for label, command in (('original', original), ('lcu', [str(lcu)])):
            with tempfile.TemporaryDirectory(prefix=f'{label}-off-', dir=root) as home:
                observed = methods(command, environment(Path(home), app, audio=False))
                if off_required & observed:
                    raise AssertionError(f'{label} exposes original audio methods while opt-in is off.')
                print(json.dumps({'progress': 'audio_opt_out_verified', 'side': label}), flush=True)
            with tempfile.TemporaryDirectory(prefix=f'{label}-on-', dir=root) as home:
                env = environment(Path(home), app, audio=(label == 'original'))
                on_command = command + (['--audio'] if label == 'lcu' else [])
                report['results'][label] = record(on_command, env, tone, label)
                print(json.dumps({'progress': 'audio_capture_passed', 'side': label,
                                  'result': report['results'][label]}), flush=True)
    report['result'] = 'passed'
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
