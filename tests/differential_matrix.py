"""Compare original surface/browser-mode configuration and first-use delivery.

Transport errors are preserved as evidence, never counted as successful browser
operation. Real browser operations need a provider and are tested separately.
"""
import argparse
import json
import os
from pathlib import Path
import re

from mcp_client import Client, text


def exercise(command, output):
    results = {}
    home = Path(output).parent / 'matrix-home'
    home.mkdir(exist_ok=True)
    for surfaces in ('computer', 'browser', 'browser,computer'):
        for browser in ('codex-app', 'training', 'cloud', 'orbit'):
            env = dict(os.environ, HOME=str(home), CUA_REPL_ENABLED_SURFACES=surfaces,
                       CUA_REPL_BROWSER_ENV=browser, BROWSER_USE_AVAILABLE_BACKENDS='chrome,cdp')
            client = Client(command, env=env)
            key = surfaces + ':' + browser
            try:
                item = {'initialization': client.initialization, 'tools': client.call('tools/list', {})['tools']}
                result = client.call('tools/call', {'name':'js', 'arguments':{
                    'code':'nodeRepl.write(JSON.stringify(Object.keys(cua).sort()));', 'timeout_ms':10000}})
                item['first_use'] = result
                if not result.get('isError'):
                    # The last text chunk is the deliberately JSON-encoded method list;
                    # preceding text retains the original complete first-use docs.
                    blocks = [block['text'] for block in result['content'] if block['type'] == 'text']
                    methods = json.loads(blocks[-1])
                    if 'computer' in surfaces:
                        assert 'getApp' in methods and 'listWindows' in methods, (key, methods)
                    if 'browser' in surfaces:
                        assert 'getBrowser' in methods and 'getTab' in methods, (key, methods)
                    item['methods'] = methods
                results[key] = item
            finally:
                client.close()
                Path(output).write_text(json.dumps(results, indent=2))
    print(f'Captured {len(results)} configuration modes; browser operations are not implied')


def compare(first, second):
    a,b = (json.loads(Path(path).read_text()) for path in (first,second))
    assert a.keys() == b.keys()
    for mode in a:
        for section in ('initialization','tools','methods'):
            assert a[mode].get(section) == b[mode].get(section), (mode,section)
        def normalize(value):
            value = dict(value)
            if '_meta' in value:
                metadata = dict(value['_meta'])
                duration = metadata.pop('codex/nodeReplExecutionDurationMs', None)
                assert duration is None or isinstance(duration, (int, float)) and duration >= 0
                value['_meta'] = metadata
            # Rust/Node errors can carry runtime root paths, not API behavior.
            encoded = json.dumps(value)
            encoded = re.sub(r'/(?:[^\s"\\]+/)*lib/node_modules/', '<modules>/', encoded)
            return encoded
        assert normalize(a[mode]['first_use']) == normalize(b[mode]['first_use']), mode
    failed = [mode for mode in a if a[mode]['first_use'].get('isError')]
    print(f'PASS: {len(a)} original configuration modes match; first-use errors={failed}; no provider-operation claim')


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='mode',required=True)
    ex=sub.add_parser('exercise');ex.add_argument('output');ex.add_argument('command',nargs=argparse.REMAINDER)
    co=sub.add_parser('compare');co.add_argument('first');co.add_argument('second')
    args=parser.parse_args()
    if args.mode=='exercise':exercise(args.command,args.output)
    else:compare(args.first,args.second)
