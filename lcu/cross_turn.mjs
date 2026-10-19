// `lcu cross-turn`: keep Computer Use available across turns, including turns started by background events.
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fstatSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { AppsError, authenticate } from './apps.mjs';
import { accountHome } from './fsutil.mjs';
import { json, readFile, regularPath, stateDirectory } from './setup.mjs';
import { say, warn } from './terminal.mjs';

/** What the setting does not change: macOS and Windows have per-app approval; the Linux runtime has none (see docs/ADAPTERS.md). */
export const approvalNote = (platform = process.platform) => (platform !== 'linux' ? 'Per-app approvals still apply.'
  : "Your harness's tool approvals are unchanged; this platform's runtime has no per-app approval.");
export const question = (platform = process.platform) => 'Keep Computer Use available across turns, including turns started by ' +
  `background events instead of your message? ${approvalNote(platform)} [y/N] `;
const UNATTENDED_WARNING = 'Warning: --unattended skips the owner prompt and is for disposable sandbox machines only. ' +
  'Anyone running as this account can already change this setting, so it guards against accidents, not against a determined agent.';

/** A problem to show the user. */
export class CrossTurnError extends Error {}

/** The setting file (state directory shared with setup.json); refuses symlinks on its path like setup does. */
export const crossTurnPath = (home = accountHome()) => regularPath(join(stateDirectory(home), 'cross-turn.json'));

/**
 * `{enabled, source, configured, path, problem}`. A missing file is off and not configured. A damaged one is off,
 * configured (setup never asks about it) and carries `problem`; it is only replaced when the user changes the setting.
 */
export function readCrossTurn(home = accountHome()) {
  const path = crossTurnPath(home);
  const off = { enabled: false, source: null, configured: false, path, problem: null };
  let data;
  try {
    data = readFile(path);
  } catch (error) {
    return { ...off, configured: true, problem: `cannot read ${path}: ${error.message}; treating it as off.` };
  }
  if (data === null) return off;
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^﻿/, ''));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.enabled !== 'boolean') {
    return { ...off, configured: true, problem: `${path} is not a valid cross-turn setting (expected {"enabled": true|false}); ` +
      'treating it as off. Run `lcu cross-turn on` or `lcu cross-turn off` to replace it.' };
  }
  return { ...off, enabled: parsed.enabled, source: typeof parsed.source === 'string' ? parsed.source : null, configured: true };
}

/** Replace `path` with a new private (0600) file: synced temporary file in the same directory, then an atomic rename. */
export function writePrivate(path, data, { writeAll = writeFileSync } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.cross-turn-${randomBytes(6).toString('hex')}`);
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeAll(fd, data);
      fsyncSync(fd);
      // A full disk or a file-size limit can cut a write short; never rename a truncated file into place.
      if (fstatSync(fd).size !== data.length) throw new Error('the file was written incompletely');
    } finally {
      closeSync(fd);
    }
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Turn the setting on or off. `on` asks the owner to authenticate on macOS (through `auth`) unless `unattended`;
 * other platforms have no owner prompt. Nothing is prompted or written when it would not change anything.
 * Returns `{changed, enabled, source, note}`; throws CrossTurnError (nothing was changed).
 */
export async function setCrossTurn(home, enable, { root, unattended = false, auth = authenticate, platform = process.platform, write = writePrivate } = {}) {
  const current = readCrossTurn(home);
  if (current.enabled === enable && current.configured && !current.problem) {
    return { changed: false, enabled: enable, source: current.source, note: null };
  }
  const owner = platform === 'darwin';
  let source = owner ? 'owner' : 'cli';
  let note = null;
  if (enable) {
    if (unattended) {
      source = 'unattended';
      note = UNATTENDED_WARNING;
    } else if (owner) {
      try {
        await auth(root, 'keep Computer Use available across turns, including turns started by background events');
      } catch (error) {
        if (error instanceof AppsError) throw new CrossTurnError(error.message);
        throw error;
      }
    } else {
      note = 'This platform has no owner prompt, so the setting was turned on directly.';
    }
  }
  try {
    write(crossTurnPath(home), Buffer.from(json({ enabled: enable, source, changed_at: new Date().toISOString() })));
  } catch (error) {
    throw new CrossTurnError(`cannot write ${crossTurnPath(home)}: ${error.message}. Nothing was changed.`);
  }
  return { changed: true, enabled: enable, source, note };
}

export const USAGE = 'lcu cross-turn [status|on|off] [--json] [--unattended]';
const HELP = `Usage: ${USAGE}

Keep Computer Use available across turns, including turns started by background events instead of your message.
Off by default. On macOS and Windows per-app approvals still apply; the Linux runtime has no per-app approval and harness tool
approvals are unchanged.

  status          show whether it is on, who set it and where it is stored (the default)
  on              turn it on (macOS asks for Touch ID or your password; Linux and Windows have no owner prompt)
  off             turn it off (no prompt)
  --json          print one JSON object
  --unattended    with on: skip the owner prompt and record "unattended"; for disposable sandbox machines only`;

const view = (state, extra = {}) => ({ enabled: state.enabled, source: state.source, configured: state.configured, file: state.path,
  ...(state.problem ? { problem: state.problem } : {}), ...extra });

/** `lcu cross-turn ARGV`; returns the exit status. */
export async function main(root, argv, { platform = process.platform, home, auth = authenticate, write } = {}) {
  let values;
  let action;
  try {
    let positionals;
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true,
      options: { json: { type: 'boolean' }, unattended: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }));
    action = positionals[0] ?? 'status';
    if (positionals.length > 1) throw new Error(`Unexpected argument '${positionals[1]}'.`);
    if (!['status', 'on', 'off'].includes(action)) throw new Error(`Unknown action '${action}'; use status, on or off.`);
    if (values.unattended && action !== 'on') throw new Error('--unattended only applies to `on`.');
  } catch (error) {
    warn(`lcu cross-turn: ${error.message}`, "Run 'lcu cross-turn --help' for usage.");
    return 2;
  }
  if (values.help) {
    say(HELP);
    return 0;
  }
  try {
    home ??= accountHome();
    if (action === 'status') {
      const state = readCrossTurn(home);
      if (values.json) say(JSON.stringify(view(state), null, 2));
      else {
        if (state.problem) warn(`lcu cross-turn: ${state.problem}`);
        say(`Cross-turn Computer Use is ${state.enabled ? 'on' : 'off'}${state.enabled && state.source ? ` (set by ${state.source})` : ''}.`,
          `Setting: ${state.path}`);
      }
      return 0;
    }
    const done = await setCrossTurn(home, action === 'on', { root, unattended: Boolean(values.unattended), auth, platform, write });
    if (done.note) warn(done.note);
    if (values.json) say(JSON.stringify(view(readCrossTurn(home), { changed: done.changed }), null, 2));
    else if (done.changed) say(`Cross-turn Computer Use is now ${done.enabled ? 'on' : 'off'}. Running sessions pick this up on the next turn.`);
    else say(`Cross-turn Computer Use is already ${done.enabled ? 'on' : 'off'}.`);
    return 0;
  } catch (error) {
    warn(`lcu cross-turn: ${error.message}`);
    return 1;
  }
}
