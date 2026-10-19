import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

if sys.platform == 'win32':
    raise unittest.SkipTest('macOS acceptance drives POSIX terminals')

import pty
import select


SPEC = importlib.util.spec_from_file_location(
    'macos_audio_acceptance', Path(__file__).with_name('macos_audio_acceptance.py'))
audio = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audio)

PI_SPEC = importlib.util.spec_from_file_location(
    'macos_pi_stop_acceptance', Path(__file__).with_name('macos_pi_stop_acceptance.py'))
pi_stop = importlib.util.module_from_spec(PI_SPEC)
PI_SPEC.loader.exec_module(pi_stop)


class AudioApprovalTests(unittest.TestCase):
    def setUp(self):
        self.metadata = {'session_id': 'guest-session', 'turn_id': 'generated-tone-turn'}
        self.events = []
        self.handler = audio.audio_approval_handler(self.metadata, self.events)
        self.params = {
            'mode': 'form',
            'message': 'Allow Computer Use to record computer audio?',
            'requestedSchema': {'type': 'object', 'properties': {}},
            '_meta': {
                'codex_approval_kind': 'mcp_tool_call',
                'codex_request_type': 'approval_request',
                'connector_id': 'computer-use',
                'tool_name': 'start_audio_recording',
                'tool_params': {},
                'persist': ['session'],
                'riskLevel': 'high',
                'x-codex-turn-metadata': self.metadata,
            },
        }

    def test_accepts_only_original_guest_computer_audio_approval(self):
        result = self.handler('elicitation/create', self.params)

        self.assertEqual(result, {'action': 'accept', 'content': {}})
        self.assertEqual(self.events, [self.metadata])

    def test_rejects_other_scope_and_does_not_record_an_acceptance(self):
        for location, key, value in (
                ('top', 'message', 'Allow microphone recording?'),
                ('meta', 'tool_name', 'get_app_state'),
                ('meta', 'tool_params', {'app': 'com.apple.TextEdit'}),
                ('meta', 'persist', ['always']),
                ('meta', 'riskLevel', 'low'),
                ('meta', 'x-codex-turn-metadata', {'session_id': 'other', 'turn_id': 'turn'})):
            with self.subTest(key=key):
                params = {**self.params}
                if location == 'meta':
                    params['_meta'] = {**self.params['_meta'], key: value}
                else:
                    params[key] = value
                with self.assertRaises(AssertionError):
                    self.handler('elicitation/create', params)
        self.assertEqual(self.events, [])


class PiToolResultTests(unittest.TestCase):
    def test_stale_marker_from_an_earlier_tool_cannot_satisfy_current_call(self):
        request = {'messages': [
            {'role': 'tool', 'tool_call_id': 'pi-stop-step-2',
             'content': 'pi-initial-state-ready'},
            {'role': 'tool', 'tool_call_id': 'pi-stop-step-3',
             'content': 'Original app state failed: cgWindowNotFound'},
        ]}

        with self.assertRaisesRegex(AssertionError, "cgWindowNotFound"):
            pi_stop.assert_tool_result(request, 'pi-stop-step-3', 'pi-initial-state-ready')

    def test_reports_exact_tool_result_first_line_and_explicit_error_state(self):
        request = {'messages': [
            {'role': 'tool', 'tool_call_id': 'pi-stop-step-3',
             'content': 'pi-initial-native-ready\nadditional result', 'isError': False},
        ]}

        result = pi_stop.assert_tool_result(
            request, 'pi-stop-step-3', 'pi-initial-native-ready')

        self.assertEqual(result['first_line'], 'pi-initial-native-ready')
        self.assertFalse(result['explicit_error'])

    def test_explicit_tool_error_is_rejected_even_if_it_contains_marker(self):
        request = {'messages': [
            {'role': 'tool', 'tool_call_id': 'pi-stop-step-3',
             'content': 'pi-initial-native-ready', 'is_error': True},
        ]}

        with self.assertRaisesRegex(AssertionError, 'explicit tool error'):
            pi_stop.assert_tool_result(request, 'pi-stop-step-3', 'pi-initial-native-ready')


class PiAgentEndWaitTests(unittest.TestCase):
    def test_wait_drains_pty_while_waiting_for_agent_end_observer(self):
        with tempfile.TemporaryDirectory(prefix='lcu-pi-agent-end-test-') as temporary:
            observer = Path(temporary) / 'agent-ends.jsonl'
            master, slave = pty.openpty()
            captured = bytearray()
            child = subprocess.Popen(
                [sys.executable, '-c',
                 'import os, pathlib, sys; os.write(1, b"x" * 1048576); '
                 'pathlib.Path(sys.argv[1]).write_text("{}\\n")', str(observer)],
                stdin=slave, stdout=slave, stderr=slave, close_fds=True,
                start_new_session=True)
            os.close(slave)

            def drain(timeout=0.1):
                ready, _, _ = select.select([master], [], [], timeout)
                if ready:
                    try:
                        captured.extend(os.read(master, 65536))
                    except OSError:
                        pass

            try:
                pi_stop.wait_agent_ends(observer, 1, 5, child, drain)
                child.wait(timeout=5)
                # Bytes the child wrote just before exiting can still be in the pty buffer.
                while True:
                    ready, _, _ = select.select([master], [], [], 0.1)
                    if not ready:
                        break
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    captured.extend(chunk)
                self.assertGreaterEqual(len(captured), 1_048_576)
                self.assertEqual(observer.read_text(encoding='utf-8').splitlines(), ['{}'])
            finally:
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=5)
                os.close(master)


if __name__ == '__main__':
    unittest.main()
