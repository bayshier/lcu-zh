// `lcu doctor`: check the original desktop provider and guide first-use permissions.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

import * as capture from './capture.mjs';
import { summary as diagnosticLogSummary } from './diagnostic_log.mjs';
import { MAC_HELPER, macSocketPathProblem, plistStrings } from './platforms.mjs';
import { unshimmedEnv } from './sandbox_shim.mjs';
import { changedSinceInstall, report as reportTestedPair } from './tested.mjs';
import { ask, say, warn } from './terminal.mjs';

const MAC_ACCESSIBILITY_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const MAC_SCREEN_CAPTURE_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

const PROBE = String.raw`
import { handleRpc } from '@oai/sky/service';
const report = {};
function errorInfo(error) {
  const detail = {};
  if (Number.isInteger(error?.code)) detail.code = error.code;
  if (typeof error?.errorName === 'string') detail.name = error.errorName;
  if (typeof error?.message === 'string') detail.message = error.message.replace(/\s+/g, ' ').slice(0, 240);
  return detail;
}
async function call(method, args = []) {
  try { return {ok: true, value: await handleRpc({type: 'execute', method, args})}; }
  catch (error) { return {ok: false, error: errorInfo(error)}; }
}
try {
  const setup = await handleRpc({type: 'setup'});
  report.target = setup.target;
  if (setup.target === 'linux') {
    const windows = await call('list_windows');
    report.windows = windows.ok && Array.isArray(windows.value)
      ? {ok: true, count: windows.value.length}
      : windows.ok ? {ok: false, error: {message: 'Original runtime returned an invalid window list.'}}
        : {ok: false, error: windows.error};
    if (report.windows.ok) {
      const screenshots = await call('get_screenshot');
      if (!screenshots.ok) {
        report.screenshot = {ok: false, error: screenshots.error};
      } else {
        const images = screenshots.value;
        const valid = Array.isArray(images) && images.length > 0 && images.every(
          image => image && typeof image.data_url === 'string' && image.data_url.startsWith('data:image/'));
        report.screenshot = {ok: valid, count: Array.isArray(images) ? images.length : 0,
          error: valid ? undefined : {message: 'Original runtime returned no usable screenshot.'}};
        // The original API owns its normal temporary capture files. This probe
        // emits no image data and creates no additional screenshot copy.
        if (Array.isArray(images)) for (const image of images) image.data_url = '';
      }
    } else {
      report.screenshot = {ok: false, skipped: true};
    }
  } else if (setup.target === 'windows') {
    const windows = await call('list_windows');
    report.windows = windows.ok && Array.isArray(windows.value)
      ? {ok: true, count: windows.value.length}
      : windows.ok ? {ok: false, error: {message: 'Original runtime returned an invalid window list.'}}
        : {ok: false, error: windows.error};
    report.screenshot = {ok: false, unverified: true};
  } else if (setup.target === 'mac') {
    const methods = Array.isArray(setup.methods) ? setup.methods : [];
    const needed = ['list_apps', 'get_app_state'];
    report.provider = {ok: needed.every(method => methods.includes(method)), methods: methods.filter(
      method => needed.includes(method))};
    report.permissions = {ok: false, unverified: true};
  } else {
    report.provider = {ok: false, error: {message: 'Unsupported original runtime target.'}};
  }
} catch (error) {
  report.provider = {ok: false, error: errorInfo(error)};
}
console.log(JSON.stringify(report));
`;

/** The runtime checks, prompts and host calls doctor makes, replaceable in tests. */
export const host = {
  probe: (runtime, env, target) => probe(runtime, env, target),
  run: (command, args, options) => capture.run(command, args, options),
  sandboxWorks: (env) => linuxSandboxWorks(env),
  interactive: () => process.stdin.isTTY === true,
  ask,
  openSettings(url, label) {
    const result = spawnSync('open', [url], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 10_000 });
    if (result.error || result.status !== 0) {
      say(`Could not open ${label}: ${result.error?.message ?? `exit status ${result.status}`}`, `Open it manually: ${label}`);
    }
  },
};

function bundleDisplayName(bundle, fallback) {
  try {
    const info = plistStrings(readFileSync(join(bundle, 'Contents/Info.plist')));
    for (const key of ['CFBundleDisplayName', 'CFBundleName']) if (typeof info[key] === 'string' && info[key].trim()) return info[key].trim();
  } catch {
    // the fallback below
  }
  return fallback;
}

/** `{accessibility: [name, path], screen_capture: [name, path]}`, read from the selected app and its helper. */
export function macPermissionTargets(app) {
  const helper = join(app, 'Contents', MAC_HELPER);
  return { accessibility: [bundleDisplayName(helper, basename(helper)), helper], screen_capture: [bundleDisplayName(app, basename(app)), app] };
}

/** The original provider's readiness report. */
export function probe(runtime, env, target, { timeout = 25_000 } = {}) {
  const result = host.run(env.NODE_REPL_NODE_PATH, ['--input-type=module', '-e', PROBE],
    { cwd: join(runtime, target === 'windows' ? 'bin' : 'lib'), env, timeout });
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().replaceAll('\n', ' ').slice(0, 240);
    throw new Error(detail || `Original provider exited with status ${result.status ?? result.signal}.`);
  }
  const lines = result.stdout.split('\n').filter((line) => line.trim());
  if (!lines.length) throw new Error('Original provider returned no readiness result.');
  let report;
  try {
    report = JSON.parse(lines.at(-1));
  } catch {
    throw new Error('Original provider returned an unreadable readiness result.');
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('Original provider returned an invalid readiness result.');
  const expected = { linux: 'linux', mac: 'mac', darwin: 'mac', windows: 'windows' }[target];
  if (report.target !== expected) throw new Error(`Original provider target mismatch: expected ${expected}, received ${report.target}.`);
  return report;
}

function failureText(check) {
  const { code, name, message } = check.error ?? {};
  if (code === -10009 || name === 'permissionsNotGranted') {
    return 'The original runtime reports that a required permission is not granted; it does not identify which macOS permission.';
  }
  if (code === -10014 || name === 'permissionsPending') return 'The original runtime is waiting for a permission decision.';
  if (message) return `Original runtime: ${message}`;
  return 'The original runtime did not complete this check.';
}

function macInstructions(app) {
  const { accessibility, screen_capture: screen } = macPermissionTargets(app);
  say('macOS privacy status is not available to this CLI. The original Mac API requires',
    'its connected agent approval before it can inspect an app, so LCU will not inspect one here.',
    'Review these entries in System Settings > Privacy & Security:',
    `  Accessibility: ${accessibility[0]} (${accessibility[1]})`,
    `  Screen & System Audio Recording, or Screen Recording: ${screen[0]} (${screen[1]})`,
    'macOS may not list an app until its first approved use. LCU never grants access or opens Settings on its own.');
}

async function macGuidance(app, retry) {
  macInstructions(app);
  say('', 'Choose a settings pane, retry the installed-runtime check, or finish:', '  [a] Open Accessibility settings',
    '  [s] Open Screen & System Audio Recording settings', '  [r] Recheck original runtime metadata', '  [Enter] Finish');
  for (;;) {
    const choice = (await host.ask('Choice [a/s/r/Enter]: ')).trim().toLowerCase();
    if (choice === 'a' || choice === '1') host.openSettings(MAC_ACCESSIBILITY_SETTINGS, 'System Settings > Privacy & Security > Accessibility');
    else if (choice === 's' || choice === '2') {
      host.openSettings(MAC_SCREEN_CAPTURE_SETTINGS, 'System Settings > Privacy & Security > Screen & System Audio Recording');
    } else if (choice === 'r') {
      try {
        printMacStatus(retry());
      } catch (error) {
        say(`Original runtime check failed: ${error.message}`, 'This is a runtime/backend failure, not proof that a macOS permission is missing.');
      }
    } else if (['', 'q', 'done'].includes(choice)) break;
    else say('Choose a, s, r, or press Enter to finish.');
  }
  say('Next: reconnect your agent, open a harmless window such as a blank TextEdit document, and ask it',
    'to inspect that window with LCU and return a screenshot. Approve the original app request and macOS prompts.');
}

function printMacStatus(report) {
  const provider = report.provider ?? {};
  if (provider.ok) say('Original Mac provider loaded; app listing and app-state methods are available.');
  else say(`Original Mac provider check failed. ${failureText(provider)}`);
  say('macOS privacy permissions: not verified by LCU.');
  return Boolean(provider.ok);
}

/** `[works, detail]`: the check the original node_repl makes, whether `codex sandbox` can confine a command here. */
export function linuxSandboxWorks(env) {
  env = unshimmedEnv(env);
  const codex = env.CODEX_CLI_PATH;
  if (!codex) return [false, 'no Codex executable'];
  const scratch = mkdtempSync(join(tmpdir(), 'lcu-sandbox-probe-'));
  let result;
  try {
    result = host.run(codex, ['sandbox', '-c', 'shell_environment_policy.inherit="all"', '-c', 'default_permissions="node_repl"',
      '-c', 'permissions.node_repl={filesystem = {":root" = "read"}, network = {enabled = false}}',
      '--', '/bin/sh', '-c', 'test -r /etc/os-release || exit 10; touch "$1" && exit 11; exit 12',
      'node-repl-sandbox-probe', join(scratch, 'write-must-fail')], { cwd: scratch, env, timeout: 30_000 });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (result.error) return [false, result.error.message.slice(0, 200)];
  if (result.status === 12) return [true, ''];
  const detail = (result.stderr ?? '').split(/\s+/).filter(Boolean).join(' ').slice(0, 200);
  return [false, `exit ${result.status ?? result.signal}${detail ? `: ${detail}` : ''}`];
}

export function printLinuxSandboxStatus(env, { works = host.sandboxWorks } = {}) {
  const mode = (env.LCU_NODE_REPL_SANDBOX ?? '').trim().toLowerCase();
  if (mode === 'host') {
    say('JavaScript sandbox: LCU_NODE_REPL_SANDBOX=host leaves the original runtime behavior. Where bubblewrap works it also ' +
      'confines the Sky desktop service, which then cannot reach X11.');
    return;
  }
  if (mode === 'off') {
    say("JavaScript sandbox: OFF (LCU_NODE_REPL_SANDBOX=off). The kernel that runs the model's JavaScript is not sandboxed, " +
      'unless the agent host asks for one.');
    return;
  }
  const [working, detail] = works(env);
  if (!working) {
    say(`JavaScript sandbox: NOT AVAILABLE here (bubblewrap cannot start a sandbox${detail ? `; ${detail}` : ''}). The kernel that ` +
      "runs the model's JavaScript is not sandboxed on this machine; it has your account's access to files, network and " +
      'processes. Containers and hosts that restrict user namespaces behave this way.');
  } else if (!('LCU_SANDBOX_SHIM' in env)) {
    say("JavaScript sandbox: available, but LCU's launcher shim is missing from this release, so the original runtime " +
      'confines the Sky desktop service too and desktop control will fail.');
  } else {
    say("JavaScript sandbox: active. The kernel that runs the model's JavaScript is confined (read-only filesystem, no " +
      'network; subprocesses it starts are confined too); only the trusted Sky desktop service runs outside it. An agent ' +
      'host that sends a disabled sandbox state gets none.');
  }
}

function printLinuxStatus(report) {
  const windows = report.windows ?? {};
  const screenshot = report.screenshot ?? {};
  say(windows.ok ? `Window listing: passed (${windows.count ?? 0} windows).` : `Window listing: could not verify. ${failureText(windows)}`);
  if (screenshot.ok) say(`Screenshot capture: passed (${screenshot.count ?? 0} images); returned image data was discarded by LCU.`);
  else if (screenshot.skipped) say('Screenshot capture: not checked because window listing failed.');
  else say(`Screenshot capture: could not verify. ${failureText(screenshot)}`);
  return Boolean(windows.ok && screenshot.ok);
}

async function linuxGuidance(report, retry) {
  for (;;) {
    if (printLinuxStatus(report)) {
      say('Computer use is ready for the first agent call.');
      return true;
    }
    say('A failed check can be a desktop-service problem; this result alone does not identify a missing permission.',
      '  [r] Retry the original checks', '  [Enter] Finish');
    if ((await host.ask('Choice [r/Enter]: ')).trim().toLowerCase() !== 'r') {
      say('Desktop readiness remains incomplete. Rerun lcu doctor after resolving the issue.');
      return false;
    }
    try {
      report = retry();
    } catch (error) {
      report = { windows: { ok: false, error: { message: error.message } }, screenshot: { ok: false, skipped: true } };
    }
  }
}

function printWindowsStatus(report) {
  const windows = report.windows ?? {};
  say(windows.ok ? `Original window listing: passed (${windows.count ?? 0} windows).`
    : `Original window listing: could not verify. ${failureText(windows)}`);
  say('Screenshot and Windows permission readiness are not verified by this check.');
  return Boolean(windows.ok);
}

const USAGE = 'Usage: lcu doctor [--non-interactive] [--require-ready]';
const HELP = `${USAGE}

Check the original desktop provider and guide first-use permissions.

  --non-interactive  Check without prompts or opening System Settings
  --require-ready    Exit nonzero unless this platform can verify desktop readiness`;

/** `lcu doctor ARGV`; `resolved` and `env` are the selected app and the runtime environment (resolved when absent). */
export async function main(root, argv, { resolved, env } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { 'non-interactive': { type: 'boolean' }, 'require-ready': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' } } }));
  } catch (error) {
    warn(`lcu doctor: ${error.message}`, "Run 'lcu doctor --help' for usage.");
    return 2;
  }
  if (values.help) {
    say(HELP);
    return 0;
  }
  if (!resolved || !env) {
    const runtime = await import('./runtime.mjs');
    resolved = runtime.paths(root);
    env = runtime.environment(root, resolved);
  }
  const { app, runtime, metadata } = resolved;
  const descriptor = JSON.parse(readFileSync(join(root, 'installation.json'), 'utf8'));
  const platformName = descriptor.platform ?? 'linux';
  const target = platformName === 'darwin' ? 'mac' : platformName;
  const interactive = host.interactive() && !values['non-interactive'];
  const requireReady = Boolean(values['require-ready']);
  say(`Original app: ChatGPT ${metadata.version} (CUA ${metadata.runtime}).`);
  await reportTestedPair(root, { metadata, write: (text) => say(text.trimEnd()) });
  const changed = changedSinceInstall(descriptor, metadata);
  if (changed) say(`Warning: ${changed}`);
  const updateLine = await import('./update.mjs').then((update) => update.statusLine?.(root), () => null).catch(() => null);
  if (updateLine) say(updateLine);
  say(diagnosticLogSummary());
  if (target === 'mac' && process.platform === 'darwin') {
    // The helper runs on this host; a test or tool inspecting a macOS install elsewhere has no home to check.
    const problem = macSocketPathProblem();
    if (problem) {
      say(problem);
      return 2;
    }
  }
  if (target === 'linux') printLinuxSandboxStatus(env);
  if (target === 'linux' && (!env.DISPLAY || !env.DBUS_SESSION_BUS_ADDRESS)) {
    say('Window listing: could not verify. A live X11 DISPLAY and DBUS_SESSION_BUS_ADDRESS are required. ' +
      'Use lcu-session or run inside the desktop session.', 'Screenshot capture: not checked because window listing could not start.');
    return 2;
  }
  const check = () => host.probe(runtime, env, target);
  let report;
  try {
    report = check();
  } catch (error) {
    say(`Original provider check failed: ${error.message}`);
    if (target === 'mac') {
      say('This is a runtime/backend failure; it does not prove that a macOS permission is missing.');
      if (interactive) {
        await macGuidance(app, check);
        return 2;
      }
      macInstructions(app);
      say('Next: reconnect your agent and make the first approved LCU screenshot call to verify access.');
    }
    return 2;
  }
  if (target === 'linux') {
    let ready;
    if (interactive) ready = await linuxGuidance(report, check);
    else {
      ready = printLinuxStatus(report);
      if (ready) say('Computer use is ready for the first agent call.');
    }
    return ready ? 0 : 2;
  }
  if (target === 'windows') {
    const ok = printWindowsStatus(report);
    if (requireReady) {
      say('Next: verify an approved screenshot call through the connected agent.');
      return 2;
    }
    return ok ? 0 : 2;
  }
  if (target === 'mac') {
    const ok = printMacStatus(report);
    if (interactive) await macGuidance(app, check);
    else {
      macInstructions(app);
      say('Next: reconnect your agent and make the first approved LCU screenshot call to verify access.');
    }
    if (requireReady) {
      say('macOS permission grants cannot be verified by this check; readiness stays unconfirmed.');
      return 2;
    }
    return ok ? 0 : 2;
  }
  say(`Original desktop provider: could not verify. ${failureText(report.provider ?? {})}`);
  return 2;
}
