// Optional approval mode: add or remove only LCU's own harness approval entries.
//
// `auto` lets each selected harness run LCU's model-visible computer-use tools (`js`, `js_reset`) without its
// own per-call prompt. Entries name those tools exactly, never the whole server. LCU records what `auto`
// changed (per config path, profile and scope; a Codex config value LCU replaced) in `approval.json` beside
// `setup.json`, and `ask` reverses exactly that. An entry LCU did not add, even one identical to what `auto`
// writes, is never removed; it is left alone and reported.
//
// Native-app and Chrome approvals come from the original runtime and are not affected. Chrome site approvals
// stay exact-origin only.
import { dirname, join } from 'node:path';

import { selectedCodexHome } from './codex_hooks.mjs';
import { applyChanges, atomicWrite, change, checked, json, member, parseJson, readFile, seams, setupStatePath, spacedJson } from './setup.mjs';
import { parse as parseToml } from './toml.mjs';

const MODES = ['ask', 'auto'];
// The tools the model sees. Approval entries name exactly these, never the whole server, so a tool LCU adds
// later (especially one that requires the user) is not allowed by an earlier `auto`. The other tools of the
// server are host-only.
export const MODEL_TOOLS = ['js', 'js_reset'];
// Claude Code: exact permission rules. Host-only tools also stay denied (deny takes precedence over allow).
export const CLAUDE_RULES = MODEL_TOOLS.map((tool) => `mcp__lcu__${tool}`);
// Earlier versions added this server-wide rule; `auto` replaces it, `ask` still removes it.
const LEGACY_CLAUDE_RULE = 'mcp__lcu';
// Codex: per-tool `approval_mode` under `[mcp_servers.lcu.tools.<tool>]`. Earlier versions wrote the
// server-wide `default_tools_approval_mode = "approve"`.
const CODEX_KEY = 'default_tools_approval_mode';
const CODEX_VALUE = 'approve';
const NOTHING_TO_CONFIGURE = {
  pi: 'Pi has no permission system; nothing to configure',
  hermes: 'Hermes gates only plugin tools through a pre_tool_call hook, which LCU does not register; nothing to configure',
};
const KEEP = 'keep'; // codexPlan: leave the stored record as it is

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sortKeys = (value) => (Array.isArray(value) ? value.map(sortKeys)
  : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])])) : value);

/** LCU's own record of what approval mode changed, beside setup.json. */
export const recordPath = (home) => join(dirname(setupStatePath(home)), 'approval.json');

export function loadRecord(home) {
  const path = recordPath(home);
  const data = readFile(path);
  if (data === null) return {};
  let record;
  try {
    record = JSON.parse(data);
  } catch {
    record = null;
  }
  if (!isObject(record) || !Object.values(record).every(isObject)) {
    throw new Error(`Malformed LCU approval record at ${path}; check it, then delete it and rerun setup.`);
  }
  return record;
}

export const saveRecord = (home, record) => atomicWrite(recordPath(home), Buffer.from(json(sortKeys(record))));

/** Store (or, with null, forget) what LCU changed for one config location. */
function commit(home, key, value) {
  const record = loadRecord(home);
  if (value === null) {
    if (!(key in record)) return;
    delete record[key];
  } else record[key] = value;
  saveRecord(home, record);
}

function codexConfigPath(home, scope, project, env) {
  if (scope === 'project') return join(project, '.codex/config.toml');
  return join(selectedCodexHome({ ...env, HOME: env.HOME ?? String(home) }), 'config.toml');
}

/** `{default, tools}`: the server-wide default and the per-tool approval modes in `[mcp_servers.lcu]`. */
function codexState(path) {
  const data = readFile(path);
  if (data === null) return { default: null, tools: {} };
  const table = parseToml(new TextDecoder('utf-8', { fatal: true }).decode(data)).mcp_servers?.lcu;
  if (!isObject(table)) return { default: null, tools: {} };
  const tools = {};
  for (const tool of MODEL_TOOLS) {
    const mode = isObject(table.tools) && isObject(table.tools[tool]) ? table.tools[tool].approval_mode : undefined;
    if (typeof mode === 'string') tools[tool] = mode;
  }
  return { default: typeof table[CODEX_KEY] === 'string' ? table[CODEX_KEY] : null, tools };
}

/** Merge a `codexPlan` policy over the host contract, combining their `tools` tables. */
export function mergeCodexPolicy(host, policy) {
  const { tools: policyTools, ...rest } = policy;
  const merged = { ...host, ...rest };
  if (policyTools && Object.keys(policyTools).length) {
    const tools = Object.fromEntries(Object.entries(host.tools ?? {}).map(([name, entry]) => [name, { ...entry }]));
    for (const [name, entry] of Object.entries(policyTools)) tools[name] = { ...(tools[name] ?? {}), ...entry };
    merged.tools = tools;
  }
  return merged;
}

/**
 * Decide the approval keys registration writes for `[mcp_servers.lcu]`. Registration replaces that whole table
 * (it is LCU's own), so values the user set there must be carried through explicitly. `auto` approves exactly
 * the model-visible tools through their own `approval_mode`; a tool the user already configured is kept as
 * theirs. The server-wide default is never written; a record left by an earlier version (`prior`) is migrated
 * away: `auto` and `ask` restore the user's old default. Returns `{policy, key, record, restored, migrated}`:
 * `record` is what to store once registration succeeds (null forgets it, KEEP leaves it).
 */
export function codexPlan(mode, home, { scope, project, env }) {
  const path = codexConfigPath(home, scope, project, env);
  const key = `codex|${path}`;
  let state;
  let record;
  try {
    state = codexState(path);
    record = loadRecord(home);
  } catch (error) {
    if (mode === null || mode === undefined) return { policy: {}, key, record: KEEP };
    throw new Error(`Cannot read the Codex config at ${path}: ${error.message}`);
  }
  let { default: fallback } = state;
  const { tools } = state;
  const recorded = record[key];
  const legacy = recorded !== undefined && !('tools' in recorded);
  const added = new Set(recorded === undefined || legacy ? [] : recorded.tools ?? []);
  let restored = null;
  if (legacy && (mode === 'auto' || mode === 'ask') && (fallback === CODEX_VALUE || fallback === null)) {
    // LCU's old server-wide approve: put the user's own value back.
    restored = typeof recorded.prior === 'string' ? recorded.prior : null;
    fallback = restored;
  }
  const result = { ...tools };
  let next;
  if (mode === 'auto') {
    for (const tool of MODEL_TOOLS) {
      if (!(tool in tools) || (added.has(tool) && tools[tool] === CODEX_VALUE)) {
        result[tool] = CODEX_VALUE;
        added.add(tool);
      } else added.delete(tool); // the user's own setting
    }
    next = added.size ? { tools: [...added].sort() } : null;
  } else if (mode === 'ask' && recorded !== undefined) {
    for (const tool of added) if (tools[tool] === CODEX_VALUE) delete result[tool];
    next = null;
  } else {
    // Not recorded (or no explicit mode): whatever is there belongs to the user.
    next = KEEP;
  }
  const policy = {};
  if (fallback !== null) policy[CODEX_KEY] = fallback;
  if (Object.keys(result).length) {
    policy.tools = Object.fromEntries(Object.entries(result).map(([tool, value]) => [tool, { approval_mode: value }]));
  }
  return { policy, key, record: next, restored, migrated: legacy };
}

const claudeSettingsPath = (home, project) => (project ? join(project, '.claude/settings.local.json') : join(home, '.claude/settings.json'));

function applyClaude(mode, home, project) {
  const path = claudeSettingsPath(home, project);
  const key = `claude-code|${path}`;
  const record = loadRecord(home);
  const before = readFile(path);
  if (before === null && mode !== 'auto') {
    commit(home, key, null);
    return 'unchanged (no settings file)';
  }
  const settings = parseJson(before);
  if (!isObject(settings)) throw new Error(`Claude settings must be an object: ${path}`);
  const permissions = member(settings, 'permissions', {}, `Claude permissions must be an object: ${path}`);
  const allow = Object.hasOwn(permissions, 'allow') ? permissions.allow : [];
  if (!Array.isArray(allow) || allow.some((rule) => typeof rule !== 'string')) throw new Error(`Claude allow rules must be a string array: ${path}`);
  const ours = [...CLAUDE_RULES, LEGACY_CLAUDE_RULE];
  // Only an entry LCU recorded adding is LCU's to remove.
  const added = new Set(key in record ? (record[key].added ?? []).filter((rule) => allow.includes(rule)) : []);
  let rules = [...allow];
  let note = '';
  let outcome;
  let removed = [];
  if (mode === 'auto') {
    const migrated = added.has(LEGACY_CLAUDE_RULE);
    if (migrated) {
      rules = rules.filter((rule) => rule !== LEGACY_CLAUDE_RULE);
      added.delete(LEGACY_CLAUDE_RULE);
    }
    if (rules.includes(LEGACY_CLAUDE_RULE)) note = `; kept your own \`${LEGACY_CLAUDE_RULE}\` rule, which LCU did not add`;
    else {
      for (const rule of CLAUDE_RULES) {
        if (!rules.includes(rule)) {
          rules.push(rule);
          added.add(rule);
        }
      }
    }
    outcome = rules.some((rule) => !allow.includes(rule)) ? 'added' : migrated ? 'replaced' : 'unchanged';
    if (migrated) note = `; replaced the server-wide \`${LEGACY_CLAUDE_RULE}\` rule LCU added earlier`;
  } else {
    removed = allow.filter((rule) => added.has(rule));
    rules = allow.filter((rule) => !added.has(rule));
    outcome = removed.length ? 'removed' : 'unchanged';
    const kept = rules.filter((rule) => ours.includes(rule));
    if (kept.length) note = `; kept your own ${kept.map((rule) => `\`${rule}\``).join(', ')}, which LCU did not add`;
  }
  if (rules.length !== allow.length || rules.some((rule, index) => rule !== allow[index])) {
    if (rules.length) permissions.allow = rules;
    else {
      delete permissions.allow;
      if (!Object.keys(permissions).length) delete settings.permissions;
    }
    applyChanges([change(path, before, json(settings))]);
  }
  commit(home, key, mode === 'auto' && added.size ? { added: [...added].sort() } : null);
  const shown = (mode !== 'auto' && removed.length ? removed : CLAUDE_RULES).map((rule) => `\`${rule}\``).join(', ');
  return `${outcome} ${shown} in permissions.allow (${path})${note}`;
}

function omp(executable, env, home, ...args) {
  return checked('omp config', executable, ['config', ...args], { cwd: home, env, timeout: 60_000 }).stdout;
}

const ompKey = (home, env) => `omp|${home}|${spacedJson(Object.fromEntries(['OMP_PROFILE', 'PI_CODING_AGENT_DIR']
  .filter((name) => env[name]).map((name) => [name, env[name]])))}`;

function applyOmp(mode, home, env) {
  const executable = seams.which('omp', env.PATH);
  if (!executable) throw new Error('Oh My Pi is not on the target account PATH. Install OMP, then rerun setup.');
  const key = ompKey(home, env);
  const added = new Set(loadRecord(home)[key]?.added ?? []);
  let current;
  try {
    current = JSON.parse(omp(executable, env, home, 'get', 'tools.approval', '--json')).value;
  } catch (error) {
    if (/omp config exited|could not run/.test(error.message)) throw error;
    throw new Error('omp config returned an unexpected tools.approval value');
  }
  if (current === undefined) throw new Error('omp config returned an unexpected tools.approval value');
  if (!isObject(current)) throw new Error('OMP tools.approval must be a mapping of tool names to policies');
  const updated = { ...current };
  const notes = [];
  for (const tool of MODEL_TOOLS) {
    if (mode === 'auto') {
      if (!(tool in updated)) {
        updated[tool] = 'allow';
        added.add(tool);
        notes.push(`added \`${tool}: allow\``);
      } else if (updated[tool] !== 'allow') {
        added.delete(tool);
        notes.push(`kept your \`${tool}: ${updated[tool]}\``);
      }
    } else if (added.has(tool) && updated[tool] === 'allow') {
      delete updated[tool];
      notes.push(`removed \`${tool}: allow\``);
    } else if (tool in updated) notes.push(`kept your \`${tool}: ${updated[tool]}\`, which LCU did not add`);
  }
  if (JSON.stringify(sortKeys(updated)) !== JSON.stringify(sortKeys(current))) {
    if (Object.keys(updated).length) omp(executable, env, home, 'set', 'tools.approval', spacedJson(sortKeys(updated)));
    else omp(executable, env, home, 'reset', 'tools.approval');
  }
  commit(home, key, mode === 'auto' && added.size ? { added: [...added].sort() } : null);
  return notes.length ? `${notes.join(', ')} in tools.approval` : 'unchanged';
}

/**
 * Apply an approval mode for one harness; returns a short description. `plan` is the `codexPlan` computed
 * before registration, which is when the previous Codex value is still readable.
 */
export function apply(mode, name, home, { scope, project, env, plan = null }) {
  if (!MODES.includes(mode)) throw new Error(`Unknown approval mode: ${mode}`);
  if (name === 'claude-code') return applyClaude(mode, home, scope === 'project' ? project : null);
  if (name === 'omp') return applyOmp(mode, home, env);
  if (name === 'codex') {
    plan ??= codexPlan(mode, home, { scope, project, env });
    if (plan.record !== KEEP) commit(home, plan.key, plan.record);
    if (mode === 'auto') {
      return 'registered `approval_mode = "approve"` for the `js` and `js_reset` tools of `[mcp_servers.lcu]`' +
        (plan.migrated ? '; replaced the server-wide default LCU added earlier' : '');
    }
    return typeof plan.restored === 'string'
      ? `restored your previous \`default_tools_approval_mode = "${plan.restored}"\` for \`[mcp_servers.lcu]\``
      : 'registered `[mcp_servers.lcu]` without an `approval_mode` LCU added';
  }
  return NOTHING_TO_CONFIGURE[name];
}
