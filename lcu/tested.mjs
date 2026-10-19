// Report whether the selected app and CUA runtime are a pair LCU's own tests covered.
//
// App versions are date stamps and the CUA runtime is 0.0.x, so neither version signals compatibility.
// `tested-versions.json` lists the exact pairs the checked-in verification records prove. An untested pair
// produces a warning and nothing else: LCU never refuses an app because its version is not listed.
// This module is on the launch path (`nativeInput`), so builtins come from process.getBuiltinModule.
const { readFileSync } = process.getBuiltinModule('node:fs');
const { join } = process.getBuiltinModule('node:path');

export const RECORD = 'tested-versions.json';
// Toolkits whose window-targeted input a tested app version handles itself, so LCU's Linux input translation
// (docs/STANDALONE-ADAPTATIONS.md) is not applied to them for that exact pair.
const NATIVE_INPUT_TOOLKITS = ['gtk4', 'qt-scroll'];
const FIELDS = ['platform', 'architecture', 'app_version', 'runtime', 'lcu_version'];

const validEntry = (entry) => entry && typeof entry === 'object' && !Array.isArray(entry) &&
  FIELDS.every((field) => typeof entry[field] === 'string' && entry[field]) &&
  (!('app_sha256' in entry) || (typeof entry.app_sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.app_sha256))) &&
  (!('native_input' in entry) || (Array.isArray(entry.native_input) &&
    entry.native_input.every((item) => NATIVE_INPUT_TOOLKITS.includes(item))));

/** `{entries, problem}`: a missing or malformed record is a problem, not an error. */
export function loadEntries(root) {
  const path = join(root, RECORD);
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: null, problem: `the tested-versions record is missing (${path})` };
    return { entries: null, problem: `the tested-versions record is unreadable (${path}: ${error.message})` };
  }
  const entries = data?.format === 1 ? data.entries : undefined;
  if (!Array.isArray(entries)) return { entries: null, problem: `the tested-versions record has an unsupported format (${path})` };
  if (!entries.every(validEntry)) return { entries: null, problem: `the tested-versions record has an invalid entry (${path})` };
  return { entries, problem: null };
}

const samePair = (entry, { platform, architecture, appVersion, runtime }) => entry.platform === platform &&
  entry.architecture === architecture && entry.app_version === appVersion && entry.runtime === runtime;

/**
 * Compare one observed app/runtime pair with the record. `status` is `tested` (exact pair listed), `untested`
 * (record present, pair not listed) or `unknown` (no usable record); `tested` is true, false or null to match.
 * The keys are those of `lcu status --json`.
 */
export function assess(root, { platform, architecture, appVersion, runtime }) {
  const result = { status: 'unknown', tested: null, platform, architecture, app_version: appVersion, runtime,
    tested_with_lcu: null, app_sha256: null, evidence: null, tested_pairs: [], warning: null };
  const { entries, problem } = loadEntries(root);
  if (!entries) {
    result.warning = `LCU cannot tell whether ChatGPT ${appVersion} with CUA ${runtime} is a tested pair: ${problem}. ` +
      'LCU will still use it.';
    return result;
  }
  const sameTarget = entries.filter((entry) => entry.platform === platform && entry.architecture === architecture);
  result.tested_pairs = sameTarget.map((entry) => ({ app_version: entry.app_version, runtime: entry.runtime, lcu_version: entry.lcu_version }));
  const match = sameTarget.find((entry) => samePair(entry, { platform, architecture, appVersion, runtime }));
  if (match) {
    return { ...result, status: 'tested', tested: true, tested_with_lcu: match.lcu_version,
      app_sha256: match.app_sha256 ?? null, evidence: match.evidence ?? null };
  }
  const listed = result.tested_pairs.map((pair) => `ChatGPT ${pair.app_version} with CUA ${pair.runtime}`).join('; ');
  return { ...result, status: 'untested', tested: false,
    warning: `ChatGPT ${appVersion} with CUA ${runtime} is not a pair LCU has tested on ${platform} ${architecture}. ` +
      'LCU will still use it, but behavior has not been verified. ' +
      (listed ? `Tested: ${listed}.` : 'No pair is recorded for this platform and architecture.') };
}

/** Toolkits the exact tested pair handles natively; empty for any untested or unknown pair. */
export function nativeInput(root, pair) {
  const match = (loadEntries(root).entries ?? []).find((entry) => samePair(entry, pair));
  return match?.native_input ?? [];
}

/**
 * The selected app's `{platform, architecture, appVersion, runtime}` in a release. The version and runtime come
 * from the installed app itself, so an app updated in place after installation is judged by what is installed now.
 */
export async function observe(root, descriptor, metadata) {
  descriptor ??= JSON.parse(readFileSync(join(root, 'installation.json'), 'utf8'));
  metadata ??= (await import('./runtime.mjs')).paths(root, descriptor).metadata;
  return { platform: descriptor.platform ?? 'linux', architecture: descriptor.architecture,
    appVersion: metadata.version, runtime: metadata.runtime };
}

/** A description of an app that differs from the one recorded at install, or null. */
export function changedSinceInstall(descriptor, metadata) {
  const recorded = [descriptor.package_version, descriptor.runtime];
  const observed = [metadata.version, metadata.runtime];
  if (!recorded.every((value) => typeof value === 'string' && value) ||
      (recorded[0] === observed[0] && recorded[1] === observed[1])) return null;
  return `The app on disk (ChatGPT ${observed[0]}, CUA ${observed[1]}) differs from the one recorded when LCU ` +
    `was installed (ChatGPT ${recorded[0]}, CUA ${recorded[1]}). Agents that started before the change ` +
    'may be running a mix of old and new files: stop them, restart them, and rerun the LCU installer to update the record.';
}

const assessRelease = async (root, descriptor, metadata) => assess(root, await observe(root, descriptor, metadata));

/** Plain-text lines for setup, install and doctor output; the last is a warning when untested. */
export function statusLines(result) {
  if (result.status === 'tested') {
    return [`Tested pair: yes (ChatGPT ${result.app_version} with CUA ${result.runtime}; tested with LCU ${result.tested_with_lcu}).`];
  }
  return [`Tested pair: ${result.status === 'untested' ? 'no' : 'unknown'}.`, `Warning: ${result.warning}`];
}

/** Print the tested-pair status for a release; never throws and never blocks. */
export async function report(root, { descriptor, metadata, write = (text) => process.stdout.write(text) } = {}) {
  let lines;
  try {
    lines = statusLines(await assessRelease(root, descriptor, metadata));
  } catch (error) {
    lines = [`Tested pair: unknown (the selected app could not be read: ${error.message}).`];
  }
  write(`${lines.join('\n')}\n`);
}
