"""Prepare a disposable Claude Code hook probe; never launch Claude here."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys


EVENTS = ('PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'MessageDisplay',
          'Stop', 'StopFailure', 'SessionEnd')


def record(path):
    payload = json.load(sys.stdin)
    event = payload.get('hook_event_name')
    session = payload.get('session_id')
    if event not in EVENTS or not isinstance(session, str):
        return
    record = {'event': event, 'session_id': session}
    for key in ('turn_id', 'tool_use_id'):
        value = payload.get(key)
        if isinstance(value, str):
            record[key] = value
    line = (json.dumps(record) + '\n').encode()
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(descriptor, line)
    finally:
        os.close(descriptor)


def prepare(release, output):
    release = release.resolve(strict=True)
    runtime = release / 'bin/lcu'
    if not runtime.is_file() or not os.access(runtime, os.X_OK):
        raise ValueError(f'Installed LCU runtime is missing: {runtime}')
    output = output.absolute()
    output.mkdir(mode=0o700)
    project = output / 'project'
    project.mkdir()
    claude = project / '.claude'
    claude.mkdir()
    recorder = output / 'record_hook.py'
    shutil.copyfile(__file__, recorder)
    log = output / 'events.jsonl'
    hooks = {}
    for event in EVENTS:
        group = {'hooks': [{'type': 'command', 'command': sys.executable,
                            'args': [str(recorder), 'record', str(log)]}]}
        if event in ('PreToolUse', 'PostToolUse', 'PostToolUseFailure'):
            group['matcher'] = 'mcp__lcu__js|mcp__lcu__js_reset'
        hooks[event] = [group]
    (claude / 'settings.json').write_text(json.dumps({
        'hooks': hooks,
        'permissions': {'deny': ['mcp__lcu__turn_ended', 'mcp__lcu__js_add_node_module_dir']},
    }, indent=2) + '\n')
    (project / '.mcp.json').write_text(json.dumps({'mcpServers': {'lcu': {
        'type': 'stdio', 'command': str(runtime), 'args': []}}}, indent=2) + '\n')
    print(f'Disposable Claude project: {project}')
    print(f'Event log (event names and session IDs only): {log}')
    print('In your own interactive shell, change to this project and intentionally start the guarded `clod` launcher.')
    print('The probe does not launch Claude or access personal authentication.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    setup = sub.add_parser('prepare')
    setup.add_argument('--release', type=Path, required=True)
    setup.add_argument('--output', type=Path, required=True)
    capture = sub.add_parser('record')
    capture.add_argument('log', type=Path)
    args = parser.parse_args(argv)
    if args.action == 'prepare':
        prepare(args.release, args.output)
    else:
        record(args.log)


if __name__ == '__main__':
    main()
