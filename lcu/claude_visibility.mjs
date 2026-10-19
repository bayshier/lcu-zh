// Keep the original CUA host-only tools out of Claude Code's model context and add LCU's lifecycle hooks.
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { applyChanges, change, json, member, parseJson, readFile } from './setup.mjs';

export const HOST_ONLY = ['mcp__lcu__turn_ended', 'mcp__lcu__js_add_node_module_dir', 'mcp__lcu__set_turn_context'];
// The approval tools the lcu-approve mod calls. They cannot be in `permissions.deny` (a denied MCP tool leaves the
// tool list, so the mod's `$.mcp.call` would fail) and are never allowed; the relay refuses any call without a
// mod (`toolu_plugin_`) tool-use id.
export const MOD_ONLY = ['mcp__lcu__approval_request', 'mcp__lcu__approval_choice'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const turnEnded = (hookEventName, sessionId) => ({ hooks: [{ type: 'mcp_tool', server: 'lcu', tool: 'turn_ended',
  input: { hook_event_name: hookEventName, session_id: sessionId, turn_id: '${prompt_id}' } }] });
const LIFECYCLE = {
  PreToolUse: { matcher: 'mcp__lcu__js|mcp__lcu__js_reset', hooks: [{ type: 'mcp_tool', server: 'lcu', tool: 'set_turn_context',
    input: { session_id: '${session_id}', turn_id: '${prompt_id}', tool_use_id: '${tool_use_id}', agent_id: '${agent_id}' } }] },
  Stop: turnEnded('Stop', '${session_id}'),
  StopFailure: turnEnded('Interrupt', '${session_id}'),
  SubagentStop: turnEnded('SubagentStop', '${agent_id}'),
};

function installLifecycleHooks(settings) {
  const hooks = member(settings, 'hooks', {}, 'Claude hooks must be an object');
  for (const [event, group] of Object.entries(LIFECYCLE)) {
    const groups = member(hooks, event, [], `Claude ${event} hooks must be an array of objects`);
    for (const existing of groups) {
      if (!isObject(existing)) throw new Error(`Claude ${event} hooks must be an array of objects`);
      if ('matcher' in existing && typeof existing.matcher !== 'string') throw new Error(`Claude ${event} hook matcher must be a string`);
      if (!Array.isArray(existing.hooks) || !existing.hooks.every(isObject)) throw new Error(`Claude ${event} hook entries must be an array of objects`);
    }
    const present = groups.some((existing) => existing.matcher === group.matcher &&
      existing.hooks.some((hook) => isDeepStrictEqual(hook, group.hooks[0])));
    if (!present) groups.push(structuredClone(group));
  }
}

/** Add exact deny rules and the lifecycle hooks at the selected Claude Code scope, preserving other settings. */
export function install(home, { project = null } = {}) {
  const path = project ? join(project, '.claude/settings.local.json') : join(home, '.claude/settings.json');
  const before = readFile(path);
  const settings = parseJson(before);
  if (!isObject(settings)) throw new Error(`Claude settings must be an object: ${path}`);
  const permissions = member(settings, 'permissions', {}, `Claude permissions must be an object: ${path}`);
  const deny = member(permissions, 'deny', [], `Claude deny rules must be a string array: ${path}`);
  if (deny.some((rule) => typeof rule !== 'string')) throw new Error(`Claude deny rules must be a string array: ${path}`);
  for (const rule of HOST_ONLY) if (!deny.includes(rule)) deny.push(rule);
  installLifecycleHooks(settings);
  if (before === null || !isDeepStrictEqual(parseJson(before), settings)) applyChanges([change(path, before, json(settings))]);
  return path;
}
