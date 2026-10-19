// Install the original Codex turn lifecycle hooks for LCU through Codex's own config writer.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { withAppServer } from './app_server.mjs';
import { readJson, shellQuote } from './fsutil.mjs';
import { applyChanges, change, member, readFile, regularPath, seams, spacedJson, windowsCommandLine } from './setup.mjs';
import { parse as parseToml } from './toml.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const decode = (data) => new TextDecoder('utf-8', { fatal: true }).decode(data ?? Buffer.alloc(0));

const originalPlugin = (hostRoot) => join(hostRoot, 'plugins/unified-computer-use');

/** The original plugin's lifecycle hooks, addressed to LCU's server. */
export function originalHooks(hostRoot) {
  const events = readJson(join(originalPlugin(hostRoot), '.codex-plugin/plugin.json')).hooks.hooks;
  const names = Object.keys(events).sort();
  if (!isDeepStrictEqual(names, ['Interrupt', 'Stop', 'SubagentStop'])) throw new Error('Upstream lifecycle events changed; review before installation.');
  for (const groups of Object.values(events)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.type !== 'mcp_tool' || hook.server !== 'cua_repl' || hook.tool !== 'turn_ended') {
          throw new Error('Upstream lifecycle contract changed; review before installation.');
        }
        hook.server = 'lcu';
      }
    }
  }
  return events;
}

const NOTICE_EVENTS = ['SessionStart', 'UserPromptSubmit'];
const NOTICE_SUFFIXES = Object.fromEntries(NOTICE_EVENTS.map((event) => [event, ` update --notice --hook ${event}`]));
const NOTICE_MATCHER = 'startup|resume';

/**
 * LCU's own command hook for `event` (harness integration, not an original lifecycle hook). `update --notice
 * --hook EVENT` prints Codex's `hookSpecificOutput.additionalContext` for the model once per session and
 * release, and at most once a day per release across the account; it is cache-only, exits 0 and prints nothing
 * otherwise. SessionStart runs on startup and resume, UserPromptSubmit on every prompt (no matcher, no status
 * message: it must stay quiet). Hook trust applies as for any other hook.
 */
export function noticeHook(lcu, event = 'SessionStart') {
  lcu = String(lcu);
  const suffix = NOTICE_SUFFIXES[event];
  const hook = { type: 'command', command: shellQuote(lcu) + suffix, commandWindows: windowsCommandLine([lcu]) + suffix };
  if (event === 'SessionStart') return { matcher: NOTICE_MATCHER, hooks: [{ ...hook, timeout: 10, statusMessage: 'Checking for LCU updates' }] };
  return { hooks: [{ ...hook, timeout: 5 }] };
}

/** The first word of a POSIX shell command line, or null when its quoting is unbalanced. */
function firstWord(command) {
  let word = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '\\' && '\\"$`\n'.includes(command[index + 1] ?? '')) word += command[++index];
      else word += char;
    } else if (/\s/.test(char)) {
      if (started) return word;
    } else {
      started = true;
      if (char === "'" || char === '"') quote = char;
      else if (char === '\\') {
        if (index + 1 >= command.length) return null;
        word += command[++index];
      } else word += char;
    }
  }
  return quote ? null : word;
}

/** True for a group made only of LCU update-notice command hooks (ours to replace or remove). */
export function isNoticeGroup(group, event) {
  const hooks = isObject(group) ? group.hooks : null;
  const suffixes = event === undefined ? Object.values(NOTICE_SUFFIXES) : [NOTICE_SUFFIXES[event]];
  return Array.isArray(hooks) && hooks.length > 0 && hooks.every((hook) => {
    if (!isObject(hook) || hook.type !== 'command') return false;
    const command = String(hook.command ?? '');
    if (!suffixes.some((suffix) => command.endsWith(suffix))) return false;
    const program = firstWord(command);
    // An unbalanced quote in someone else's hook: not ours.
    return program !== null && ['lcu', 'lcu.cmd'].includes(basename(program));
  });
}

const fileJson = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** Native plugin files, mirroring the original unified-computer-use plugin (which has no skill). */
export function exportFiles(command, hostRoot) {
  const original = originalPlugin(hostRoot);
  const manifest = readJson(join(original, '.codex-plugin/plugin.json'));
  Object.assign(manifest, { name: 'lcu', description: 'Computer use through the locally installed Codex runtime.' });
  manifest.hooks.hooks = originalHooks(hostRoot);
  const descriptor = readJson(join(original, '.mcp.json'));
  const server = descriptor.mcpServers.cua_repl;
  delete descriptor.mcpServers.cua_repl;
  descriptor.mcpServers.lcu = { ...server, command: command[0], args: command.slice(1), enabled: true };
  const contract = {
    hooks: manifest.hooks.hooks,
    requestMetadata: 'Forward each real session_id and turn_id as x-codex-turn-metadata in MCP request _meta.',
    lifecycle: 'Call lcu.turn_ended when the host stops or interrupts a turn, including a subagent turn; substitute the original hook input variables with real host identifiers. Keep the MCP connection alive until cleanup finishes.',
    unsupportedHosts: 'Installing MCP alone does not supply turn lifecycle hooks. A host without equivalent hooks must implement this contract before claiming Codex lifecycle parity.',
    codexTrust: 'Codex requires trust for these exact hooks. Use lcu setup --agent codex or review and trust them in Codex; this export does not bypass hook trust.',
  };
  return { '.codex-plugin/plugin.json': fileJson(manifest), '.mcp.json': fileJson(descriptor), 'lifecycle-contract.json': fileJson(contract) };
}

/**
 * The native CLI's `CODEX_HOME ?? join(homedir, '.codex')`. The pinned Codex host keeps an explicitly empty
 * CODEX_HOME verbatim (an unusable relative path), so that is refused instead of silently replaced.
 */
export function selectedCodexHome(env) {
  if (env.CODEX_HOME === '') throw new Error('CODEX_HOME is set but empty; unset it or set an absolute path');
  return env.CODEX_HOME ? env.CODEX_HOME : join(env.HOME, '.codex');
}

/**
 * Refuse an installed Codex CLI that cannot parse the original MCP hook type. Registration also works before
 * Codex CLI is installed. The probe has an empty home and never starts a model or loads account configuration.
 */
export function requireCliHookSupport(env) {
  if (env.CODEX_HOME === '') throw new Error('CODEX_HOME is set but empty; unset it or set an absolute path');
  const executable = seams.which('codex', env.PATH);
  if (!executable) return;
  const home = mkdtempSync(join(tmpdir(), 'lcu-codex-hook-probe-'));
  try {
    writeFileSync(join(home, 'config.toml'), '[hooks]\n' +
      'Stop = [{ hooks = [{ type = "mcp_tool", server = "lcu", tool = "turn_ended", input = { session_id = "s", turn_id = "t" } }] }]\n');
    const safeEnv = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SystemRoot', 'SYSTEMROOT', 'PATHEXT']
      .filter((key) => key in env).map((key) => [key, env[key]]));
    Object.assign(safeEnv, { HOME: home, CODEX_HOME: home });
    const options = { cwd: home, env: safeEnv };
    const version = seams.run(executable, ['--version'], { ...options, timeout: 10_000 });
    const result = seams.run(executable, ['mcp', 'list'], { ...options, timeout: 20_000 });
    const error = version.error ?? result.error;
    if (error) throw new Error(`Cannot check installed Codex CLI hook support: ${error.message}`);
    if (result.status !== 0) {
      let detail = (result.stderr || result.stdout || '').split(/\s+/).filter(Boolean).join(' ');
      if (detail) detail = ` Codex reported: ${detail.slice(-1000)}. `;
      throw new Error(`Installed Codex CLI ${executable} (${version.stdout.trim() || 'unknown version'}) ` +
        `cannot load the original MCP lifecycle hooks.${detail} ` +
        'Update this standalone Codex CLI to the latest public release with MCP tool hook support (official npm ' +
        'package: `npm install -g @openai/codex@latest`), then rerun `lcu setup --agent codex`.');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const trusted = (key, hash) => ({ keyPath: `hooks.state.${spacedJson(key)}.trusted_hash`, value: hash, mergeStrategy: 'replace' });

/**
 * Add the original lifecycle hooks (and LCU's update-notice hooks for `noticeCommand`, removed when it is null)
 * to the Codex config at `configPath`, preserving its scope and unrelated hooks, and trust only those exact
 * hooks. The pinned native API writes user config only, so a disposable CODEX_HOME lets it edit either scope
 * without creating CLI state in the user's project. Project hook trust is stored in the selected user config.
 * The target config and trust are committed through concurrent-edit guards.
 */
export async function installHooks(cli, configPath, cwd, env, hostRoot, noticeCommand = null) {
  configPath = regularPath(configPath);
  const before = readFile(configPath);
  const current = parseToml(decode(before));
  const trustPath = regularPath(join(selectedCodexHome(env), 'config.toml'));
  const trustBefore = trustPath === configPath ? before : readFile(trustPath);
  parseToml(decode(trustBefore));
  const hooks = structuredClone(current.hooks ?? {});
  const expected = originalHooks(hostRoot);
  for (const [event, original] of Object.entries(expected)) {
    const groups = member(hooks, event, [], `Invalid existing Codex hook list: ${event}`);
    for (const group of groups) {
      const ours = (group.hooks ?? []).some((hook) => hook.server === 'lcu' && hook.tool === 'turn_ended');
      if (ours && !original.some((item) => isDeepStrictEqual(item, group))) {
        throw new Error(`Existing LCU ${event} hook differs from upstream; review it before setup.`);
      }
    }
    for (const group of original) if (!groups.some((item) => isDeepStrictEqual(item, group))) groups.push(group);
  }
  // LCU-owned update notices: replaced when present, removed when noticeCommand is null.
  const notices = {};
  const noticeEdits = [];
  for (const event of NOTICE_EVENTS) {
    const existing = hooks[event] ?? [];
    if (!Array.isArray(existing)) throw new Error(`Invalid existing Codex hook list: ${event}`);
    const kept = existing.filter((group) => !isNoticeGroup(group, event));
    if (noticeCommand) {
      notices[event] = noticeHook(noticeCommand, event);
      kept.push(notices[event]);
    }
    if (!isDeepStrictEqual(kept, existing)) {
      hooks[event] = kept;
      noticeEdits.push({ keyPath: `hooks.${event}`, value: kept, mergeStrategy: 'replace' });
    }
  }
  // macOS temporary paths can use /var while Codex reports /private/var; match the writer's canonical path.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'lcu-codex-config-')));
  let after;
  let trustedConfig;
  try {
    const config = join(scratch, 'config.toml');
    writeFileSync(config, before ?? '');
    // The scratch home keeps account credentials and project layers out of this configuration-only process.
    // No model turn or hook is executed.
    await withAppServer(cli, scratch, { ...env, HOME: scratch, CODEX_HOME: scratch }, async (server) => {
      const edits = Object.keys(expected).map((event) => ({ keyPath: `hooks.${event}`, value: hooks[event], mergeStrategy: 'replace' }));
      await server.call('config/batchWrite', { edits: [...edits, ...noticeEdits] });
      // Match the exact source path; unrelated and plugin hooks are not trusted.
      const listed = await server.call('hooks/list', { cwds: [scratch] });
      const keyFor = (hook) => {
        if (!hook.key.startsWith(config)) throw new Error('Upstream hook key format changed.');
        return configPath + hook.key.slice(config.length);
      };
      const trust = [];
      for (const entry of listed.data) {
        if (entry.errors.length) throw new Error(`Codex could not read lifecycle hooks: ${JSON.stringify(entry.errors)}`);
        for (const hook of entry.hooks) {
          if (hook.sourcePath === config && ['stop', 'interrupt', 'subagentStop'].includes(hook.eventName) &&
              hook.server === 'lcu' && hook.tool === 'turn_ended') trust.push(trusted(keyFor(hook), hook.currentHash));
        }
      }
      const count = Object.values(expected).flat().reduce((total, group) => total + group.hooks.length, 0);
      if (trust.length !== count) throw new Error('Codex did not discover exactly the original LCU lifecycle hooks.');
      for (const [event, notice] of Object.entries(notices)) {
        // Trust only the exact LCU notice command at this source path.
        const eventName = event[0].toLowerCase() + event.slice(1);
        const found = listed.data.flatMap((entry) => entry.hooks).filter((hook) => hook.sourcePath === config &&
          hook.eventName === eventName && hook.command === notice.hooks[0].command);
        if (found.length !== 1) throw new Error(`Codex did not discover exactly the LCU ${event} update notice hook.`);
        trust.push(trusted(keyFor(found[0]), found[0].currentHash));
      }
      after = readFileSync(config);
      // Native Codex ignores project-provided hook trust; store only these path-specific approvals in the real
      // user's config.
      if (trustPath !== configPath) writeFileSync(config, trustBefore ?? '');
      await server.call('config/batchWrite', { edits: trust });
    });
    trustedConfig = readFileSync(config);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const changes = [change(configPath, before, trustPath === configPath ? trustedConfig : after)];
  if (trustPath !== configPath) changes.push(change(trustPath, trustBefore, trustedConfig));
  applyChanges(changes);
  return configPath;
}
