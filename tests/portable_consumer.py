"""Exercise the exported generic MCP command as the target account."""
import json
import os
from pathlib import Path
import sys

from mcp_client import Client, text


export = Path(sys.argv[1])
server = json.loads((export / 'mcp.json').read_text())['mcpServers']['lcu']
resources = Path('/opt/lcu/current/app/resources/cua_node/lib/node_modules')
original = resources / '@oai/cua-repl/instructions/server.md'
env = dict(os.environ, LCU_PREFIX='/opt/lcu', LCU_SESSION_MODE='direct',
           CUA_REPL_ENABLED_SURFACES='computer')
client = Client([server['command'], *server['args']], env=env)
try:
    assert client.initialization['instructions'] == original.read_text().rstrip()
    names = {tool['name'] for tool in client.call('tools/list', {})['tools']}
    assert {'js', 'js_reset', 'js_add_node_module_dir', 'turn_ended'} <= names
    client.js('nodeRepl.write(6 * 7);')
    assert text(client.js('nodeRepl.write(6 * 7);')) == '42'
finally:
    client.close()
print('PASS: exported generic MCP contract executes as the target account')
