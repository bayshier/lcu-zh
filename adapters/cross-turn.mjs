import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/** Where `lcu cross-turn` records the setting: beside setup.json, in lcu/setup.mjs's state directory. */
export function crossTurnSettingPath(home = homedir(), platform = process.platform) {
  // Deterministic for the platform asked about; on the running platform it equals lcu/setup.mjs's join().
  return platform === 'win32'
    ? win32.join(home, 'AppData', 'Local', 'LCU', 'cross-turn.json')
    : posix.join(home, '.local', 'state', 'lcu', 'cross-turn.json');
}

/**
 * Whether cross-turn Computer Use is on. Anything but a regular file with `enabled: true` is off; never throws.
 * Decodes like lcu/cross_turn.mjs: strict UTF-8, an optional leading BOM, an object (not array) with a boolean `enabled`.
 */
export function crossTurnEnabled(path = crossTurnSettingPath()) {
  try {
    if (!lstatSync(path).isFile()) return false;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)).replace(/^\uFEFF/, '');
    const setting = JSON.parse(text);
    return setting !== null && typeof setting === 'object' && !Array.isArray(setting) &&
      typeof setting.enabled === 'boolean' && setting.enabled;
  } catch {
    return false;
  }
}
