import { join } from 'node:path';

/** Give test children only the host paths and locale needed to start. */
export function isolatedEnv(home, extras = {}) {
  const env = {};
  for (const key of ['PATH', 'TMPDIR', 'LANG']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    ...extras,
  };
}
