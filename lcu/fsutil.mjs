// Small filesystem and quoting helpers shared by the LCU modules.

const { lstatSync, readFileSync, realpathSync, statSync } = process.getBuiltinModule('node:fs');
const { userInfo } = process.getBuiltinModule('node:os');
const { dirname, isAbsolute, resolve, sep } = process.getBuiltinModule('node:path');

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
/** `lstat`, or null when the path cannot be read. */
export const lstat = (path) => { try { return lstatSync(path); } catch { return null; } };
/** A regular file or directory, following symbolic links. */
export const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
export const isDirectory = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };
/** A regular file that is not itself a symbolic link. */
export const isRegular = (path) => { try { return lstatSync(path).isFile(); } catch { return false; } };
export const isLink = (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
/** The resolved real path, or the absolute path when it does not exist. */
export const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
/** `path` is `root` or below it (both already resolved). */
export const within = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
/** One POSIX shell word, quoted only when it needs to be. */
export const shellQuote = (arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : quoteAlways(arg));
/** One POSIX shell word, always single-quoted (for generated scripts). */
export const quoteAlways = (text) => `'${text.replaceAll("'", "'\"'\"'")}'`;

/**
 * The calling account's home, the one its agents use. Without root, `$HOME` when it is an absolute, existing
 * directory owned by this account with no symbolic link on its path and no parent traversal; otherwise the user
 * database's home. Root always gets the user database's home (setup then requires --user). Windows: USERPROFILE.
 */
export function accountHome(env = process.env, own = userInfo) {
  if (process.platform === 'win32') return env.USERPROFILE || own().homedir;
  const home = env.HOME;
  const uid = process.getuid();
  if (uid !== 0 && home && isAbsolute(home) && !home.split('/').includes('..') && !/[\x00-\x1f]/.test(home)) {
    const path = resolve(home);
    const info = lstat(path);
    if (info?.isDirectory() && info.uid === uid) {
      let linked = false;
      for (let item = dirname(path); item !== dirname(item); item = dirname(item)) {
        if (lstat(item)?.isSymbolicLink() !== false) { linked = true; break; }
      }
      if (!linked) return path;
    }
  }
  return own().homedir;
}
