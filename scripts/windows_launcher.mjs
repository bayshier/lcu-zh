// Stable account-local launcher for the selected thin Windows release.
//
// The installer writes `<prefix>\lcu.cmd`, which runs the recorded app Node on this file. The selected
// release's `lcu` then runs in this same process, so no second Node starts.
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The release `current.json` selects, after checking it stays inside `<prefix>\releases`. */
function selectedRelease(prefixPath) {
  const prefix = realpathSync(prefixPath);
  const name = JSON.parse(readFileSync(join(prefix, 'current.json'), 'utf8'))?.release;
  if (typeof name !== 'string' || !name || /[/\\\x00-\x1f]/.test(name) || name === '.' || name === '..') {
    throw new Error('Invalid selected Windows release name.');
  }
  const release = join(prefix, 'releases', name);
  if (lstatSync(release).isSymbolicLink() || dirname(realpathSync(release)) !== realpathSync(join(prefix, 'releases'))) {
    throw new Error('Selected Windows release leaves the managed prefix.');
  }
  let complete = false;
  try {
    complete = statSync(join(release, 'lcu/runtime.mjs')).isFile();
  } catch {
    // reported below
  }
  if (!complete) throw new Error('Selected Windows release is incomplete.');
  return release;
}

const here = fileURLToPath(import.meta.url);
if (realpathSync(process.argv[1]) === here) {
  try {
    const release = selectedRelease(dirname(here));
    const { cli } = await import(pathToFileURL(join(release, 'lcu/runtime.mjs')).href);
    await cli(realpathSync(release), process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`LCU Windows launcher: ${error.message}\n`);
    process.exitCode = 1;
  }
}
