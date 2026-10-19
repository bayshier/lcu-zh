// Where the adapters' local diagnostic log lives and its retention policy (mirrors adapters/diagnostics.mjs).
import { homedir } from 'node:os';
import { join } from 'node:path';

export const RETENTION_DAYS = 7;
export const MAX_TOTAL_MB = 20;
export const MAX_FILE_MB = 2;

/** The log directory: LCU_LOG_DIR, else the platform's per-user log or state directory. */
export function directory({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.LCU_LOG_DIR) return env.LCU_LOG_DIR;
  if (platform === 'darwin') return join(home, 'Library/Logs/LCU');
  return join(env.XDG_STATE_HOME || join(home, '.local/state'), 'lcu/logs');
}

export const enabled = ({ env = process.env } = {}) => env.LCU_DIAGNOSTIC_LOG !== '0';

/** Machine-readable diagnostic log settings for `lcu status --json`. */
export function status(options = {}) {
  return { dir: directory(options), enabled: enabled(options), retention_days: RETENTION_DAYS,
    max_total_mb: MAX_TOTAL_MB, max_file_mb: MAX_FILE_MB };
}

/** One line naming the directory and the policy, for `lcu status` and `lcu doctor`. */
export function summary(options = {}) {
  const state = status(options);
  if (!state.enabled) return 'Diagnostic log: off (LCU_DIAGNOSTIC_LOG=0).';
  return `Diagnostic log: ${state.dir} (metadata only; kept ${RETENTION_DAYS} days, at most ${MAX_TOTAL_MB} MB in ` +
    `total and ${MAX_FILE_MB} MB per file; LCU_DIAGNOSTIC_LOG=0 turns it off).`;
}
