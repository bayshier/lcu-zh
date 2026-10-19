import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOW_ENV, KNOWN_AGENT_HOSTS, agentHostReason, appBundleOf, declineAgentHostApp, findHostApps,
} from '../host-guard.mjs';

const processes = table => pid => table[pid];
const ids = bundle => ({
  '/Applications/Claude.app': 'com.anthropic.claudefordesktop',
  '/Applications/Zed.app': 'dev.zed.Zed',
  '/Applications/ChatGPT.app': 'com.openai.chat',
}[bundle]);

const nativeApproval = app => ({
  mode: 'form',
  message: 'Allow Computer Use to use "X"?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', tool_params: { app } },
});

test('appBundleOf returns the outermost app bundle', () => {
  assert.equal(appBundleOf('/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/h'),
    '/Applications/Claude.app');
  assert.equal(appBundleOf('/usr/bin/zsh'), undefined);
  assert.equal(appBundleOf(undefined), undefined);
});

test('findHostApps collects ancestor bundles and skips the runtime own bundle', () => {
  const lookup = processes({
    100: { ppid: 90, path: '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node' },
    90: { ppid: 80, path: '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node' },
    80: { ppid: 75, path: '/Users/x/Library/claude-code/claude.app/Contents/MacOS/claude' },
    75: { ppid: 70, path: '/bin/zsh' },
    70: { ppid: 60, path: '/Applications/Zed.app/Contents/MacOS/zed' },
    60: { ppid: 1, path: '/Applications/Claude.app/Contents/MacOS/Claude' },
  });
  const bundleId = bundle => bundle.endsWith('claude.app') ? 'com.anthropic.claude-code' : ids(bundle);
  assert.deepEqual(findHostApps({
    pid: 100, execPath: '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node', lookup, bundleId,
  }).map(host => host.bundleId), ['com.anthropic.claude-code', 'dev.zed.Zed', 'com.anthropic.claudefordesktop']);
});

test('findHostApps uses the outer bundle of a nested helper process', () => {
  const lookup = processes({
    10: { ppid: 9, path: '/opt/node' },
    9: { ppid: 1, path: '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper' },
  });
  assert.deepEqual(findHostApps({ pid: 10, execPath: '/opt/node', lookup, bundleId: ids }).map(h => h.bundleId),
    ['com.anthropic.claudefordesktop']);
});

test('findHostApps returns nothing for missing processes, cycles, absent bundle ids and plain chains', () => {
  const opts = { pid: 5, execPath: '/opt/node', bundleId: ids };
  assert.deepEqual(findHostApps({ ...opts, lookup: processes({}) }), []);
  assert.deepEqual(findHostApps({ ...opts, lookup: processes({
    5: { ppid: 4, path: '/opt/node' }, 4: { ppid: 5, path: '/bin/zsh' } }) }), []);
  assert.deepEqual(findHostApps({ ...opts, lookup: processes({
    5: { ppid: 4, path: '/opt/node' }, 4: { ppid: 1, path: '/bin/zsh' } }) }), []);
  assert.deepEqual(findHostApps({ ...opts, bundleId: () => undefined, lookup: processes({
    5: { ppid: 4, path: '/opt/node' }, 4: { ppid: 1, path: '/Applications/Zed.app/Contents/MacOS/zed' } }) }), []);
  assert.deepEqual(findHostApps({ ...opts, lookup: () => { throw new Error('ps failed'); } }), []);
});

test('known agent hosts and the detected host are refused, other apps are not', () => {
  for (const id of ['com.anthropic.claudefordesktop', 'com.anthropic.claude-code', 'com.openai.codex', 'com.apple.Terminal', 'com.googlecode.iterm2',
    'com.mitchellh.ghostty', 'dev.warp.Warp-Stable', 'com.github.wez.wezterm', 'org.alacritty',
    'net.kovidgoyal.kitty', 'co.zeit.hyper']) {
    assert.ok(agentHostReason(id, { hosts: [], env: {} }), id);
  }
  assert.ok(agentHostReason('COM.APPLE.TERMINAL', { hosts: [], env: {} }));
  for (const editor of ['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders', 'com.todesktop.230313mzl4w4u92',
    'com.exafunction.windsurf', 'com.google.antigravity', 'dev.zed.Zed']) {
    assert.equal(KNOWN_AGENT_HOSTS.has(editor), false, editor);
    assert.equal(agentHostReason(editor, { hosts: [], env: {} }), undefined, editor);
    assert.equal(agentHostReason(editor, { hosts: [{ bundleId: editor, name: 'Editor' }], env: {} }), 'Editor');
  }
  assert.equal(KNOWN_AGENT_HOSTS.has('dev.zed.Zed'), false);
  assert.equal(agentHostReason('dev.zed.Zed', { hosts: [], env: {} }), undefined);
  assert.equal(agentHostReason('dev.zed.Zed', { hosts: [{ bundleId: 'dev.zed.Zed', name: 'Zed' }], env: {} }), 'Zed');
  assert.equal(agentHostReason('com.apple.Notes', { hosts: [{ bundleId: 'dev.zed.Zed', name: 'Zed' }], env: {} }),
    undefined);
});

test('the escape hatch disables the guard only when set to 1', () => {
  assert.equal(agentHostReason('com.apple.Terminal', { hosts: [], env: { [ALLOW_ENV]: '1' } }), undefined);
  assert.ok(agentHostReason('com.apple.Terminal', { hosts: [], env: { [ALLOW_ENV]: '0' } }));
});

test('declineAgentHostApp answers decline only for native-app approvals of agent hosts', t => {
  t.mock.method(console, 'error', () => {});
  const hosts = [{ bundleId: 'dev.zed.Zed', name: 'Zed' }];
  assert.deepEqual(declineAgentHostApp(nativeApproval('com.apple.Terminal'), { hosts, env: {} }),
    { action: 'decline' });
  assert.deepEqual(declineAgentHostApp(nativeApproval('dev.zed.Zed'), { hosts, env: {} }), { action: 'decline' });
  assert.match(console.error.mock.calls.at(-1).arguments[0],
    /does not allow computer use to control the app hosting this agent \(Zed\)/);
  assert.equal(declineAgentHostApp(nativeApproval('com.apple.Notes'), { hosts, env: {} }), undefined);
  assert.equal(declineAgentHostApp({ ...nativeApproval('com.apple.Terminal'),
    _meta: { connector_id: 'browser-use', tool_params: { app: 'com.apple.Terminal' } } }, { hosts, env: {} }),
  undefined);
  assert.equal(declineAgentHostApp({ message: 'x' }, { hosts, env: {} }), undefined);
  assert.equal(declineAgentHostApp(undefined, { hosts, env: {} }), undefined);
  assert.equal(declineAgentHostApp(nativeApproval('com.apple.Terminal'), { hosts, env: { [ALLOW_ENV]: '1' } }),
    undefined);
});
