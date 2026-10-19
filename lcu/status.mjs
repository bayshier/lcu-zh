// `lcu status`: the installed LCU release, the selected app, and whether the pair is tested.
const { existsSync} = process.getBuiltinModule('node:fs');
const { join } = process.getBuiltinModule('node:path');
const { parseArgs } = process.getBuiltinModule('node:util');

import * as diagnosticLog from './diagnostic_log.mjs';
import { accountHome, readJson } from './fsutil.mjs';
import { readCrossTurn } from './cross_turn.mjs';
import { paths } from './runtime.mjs';
import { loadSetupState, setupStatePath } from './setup.mjs';
import { say, warn } from './terminal.mjs';
import * as tested from './tested.mjs';
import * as update from './update.mjs';


/** The signed-in account's remembered opt-ins, or null when none are saved or readable. */
function savedSetup() {
  try {
    const home = accountHome();
    return existsSync(setupStatePath(home)) ? loadSetupState(home) : null;
  } catch {
    return null;
  }
}

/** `{enabled, source}` of the cross-turn setting (off when unreadable). */
function crossTurn() {
  try {
    const { enabled, source } = readCrossTurn(accountHome());
    return { enabled, source };
  } catch {
    return { enabled: false, source: null };
  }
}

/** Machine-readable status for one release; throws when the app cannot be read. */
export async function collect(root) {
  const descriptorPath = join(root, 'installation.json');
  if (!existsSync(descriptorPath)) throw new Error(`No application is selected for this release: ${descriptorPath} is missing.`);
  const descriptor = readJson(descriptorPath);
  const bundle = join(root, 'bundle.json');
  const version = existsSync(bundle) ? readJson(bundle).version : 'source-checkout';
  const resolved = paths(root, descriptor);
  const observed = await tested.observe(root, descriptor, resolved.metadata);
  const saved = savedSetup();
  return {
    lcu_version: version,
    release: root,
    platform: observed.platform,
    architecture: observed.architecture,
    app: { path: resolved.app, version: observed.appVersion, runtime: observed.runtime },
    compatibility: tested.assess(root, observed),
    changed_since_install: tested.changedSinceInstall(descriptor, { version: observed.appVersion, runtime: observed.runtime }),
    setup: saved,
    pending: saved ? saved.pending : [],
    cross_turn: crossTurn(),
    update: update.cachedNotice(root),
    diagnostic_log: diagnosticLog.status(),
  };
}

const USAGE = 'Usage: lcu status [-h] [--json]\n\nReport the installed LCU release, the selected app and whether the pair is tested.\n\n' +
  '  --json  print one JSON object instead of text\n';

/** `lcu status ARGV` for the release `root`; returns the exit status. */
export async function main(root, argv = []) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }));
  } catch (error) {
    warn(`lcu status: ${error.message}`, "Run 'lcu status --help' for usage.");
    return 2;
  }
  if (values.help) {
    say(USAGE.trimEnd());
    return 0;
  }
  let status;
  try {
    status = await collect(root);
  } catch (error) {
    if (values.json) say(JSON.stringify({ error: error.message }));
    else warn(`lcu status: ${error.message}`);
    return 1;
  }
  if (values.json) {
    say(JSON.stringify(status, null, 2));
    return 0;
  }
  const { app, setup: saved } = status;
  const lines = [`LCU ${status.lcu_version} (${status.platform} ${status.architecture}).`,
    `Original app: ChatGPT ${app.version} (CUA ${app.runtime}) at ${app.path}.`, ...tested.statusLines(status.compatibility)];
  if (status.changed_since_install) lines.push(`Warning: ${status.changed_since_install}`);
  if (saved) {
    lines.push(`Saved setup: chrome ${saved.chrome ? 'on' : 'off'}, audio ${saved.audio ? 'on' : 'off'}, approval ${saved.approval}.`);
    if (saved.pending.length) {
      lines.push(`Pending harnesses (not installed yet; \`lcu setup --reconcile\` registers them): ${saved.pending.join(', ')}.`);
    }
  }
  lines.push(`Cross-turn Computer Use: ${status.cross_turn.enabled ? `on${status.cross_turn.source ? ` (${status.cross_turn.source})` : ''}` : 'off'}.`);
  if (status.update) lines.push(update.statusLine(root));
  lines.push(diagnosticLog.summary());
  say(...lines);
  return 0;
}
