// Install LCU's `lcu-approve` mod for Claude Code.
//
// The mod shows the computer-use runtime's per-app approval as a native pane (or question dialog) in the terminal
// and in the Claude app's Code tab, where the host cannot render the runtime's MCP form. It is a plugin folder
// under the `skills` directory, which Claude Code loads without a hot-reload question and watches for changes:
// `~/.claude/skills/lcu-approve` for user scope and `<project>/.claude/skills/lcu-approve` for project scope.
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

import { applyChanges, change, json, readFile } from './setup.mjs';

export const NAME = 'lcu-approve';
const SOURCE = join('adapters/claude-mod', NAME);
const MANIFEST = '.claude-plugin/plugin.json';
// Written beside the mod at install time: where the `lcu` command of this installation is.
const CONFIG = 'lcu.json';

/** Every file and directory under `root`, deepest first. */
const walk = (root) => readdirSync(root, { recursive: true }).map((name) => join(root, name)).sort().reverse();

/** `{relative path: bytes}` of the mod shipped in a release. */
function sourceFiles(releaseRoot) {
  const root = join(releaseRoot, SOURCE);
  if (!existsSync(join(root, MANIFEST))) throw new Error(`LCU Claude mod missing: ${root}. Reinstall LCU into this release prefix, then rerun setup.`);
  const files = {};
  // The mod's own tests (run by `claude plugin test`) stay in the repository.
  for (const path of walk(root).reverse()) {
    const name = relative(root, path);
    if (statSync(path).isFile() && name.split(sep)[0] !== 'tests' && basename(path) !== '.DS_Store') files[name] = readFileSync(path);
  }
  return files;
}

/** The stable `lcu` path of an installation: through `current` when the release sits in a prefix. */
function lcuCommand(releaseRoot) {
  const root = basename(dirname(releaseRoot)) === 'releases' ? join(dirname(dirname(releaseRoot)), 'current') : releaseRoot;
  return join(root, 'bin', 'lcu');
}

export const destination = (home, project = null) => join(project ? join(project, '.claude') : join(home, '.claude'), 'skills', NAME);

/** True when the folder holds LCU's mod (never touch a plugin of that name that is not ours). */
export function owned(path) {
  try {
    return JSON.parse(readFileSync(join(path, MANIFEST), 'utf8'))?.name === NAME;
  } catch {
    return false;
  }
}

/** Copy the mod into the selected scope's skills folder; returns the folder. */
export function install(home, releaseRoot, { project = null } = {}) {
  const target = destination(home, project);
  if (existsSync(target) && !owned(target)) throw new Error(`${target} exists and is not the LCU mod; move it aside, then rerun setup.`);
  const files = sourceFiles(releaseRoot);
  // The approved-apps panel runs `lcu apps`; this is where it finds the command.
  files[CONFIG] = Buffer.from(json({ lcu: lcuCommand(releaseRoot) }));
  applyChanges(Object.entries(files).map(([name, data]) => change(join(target, name), readFile(join(target, name)), data)));
  // Drop files an earlier release shipped and this one does not.
  if (existsSync(target) && statSync(target).isDirectory()) {
    for (const path of walk(target)) {
      const info = lstatSync(path);
      if (info.isFile() && !Object.hasOwn(files, relative(target, path))) rmSync(path);
      else if (info.isDirectory() && !readdirSync(path).length) rmdirSync(path);
    }
  }
  return target;
}

/** Remove the mod from the selected scope; returns whether anything was removed. */
export function remove(home, { project = null } = {}) {
  const target = destination(home, project);
  if (!existsSync(target)) return false;
  if (!owned(target)) throw new Error(`${target} is not the LCU mod; left in place.`);
  rmSync(target, { recursive: true });
  return true;
}
