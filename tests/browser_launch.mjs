import { readFile, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// This standard profile belongs to the disposable unprivileged container user.
// It matches the unchanged native-host installer's Chromium manifest location.
const release = process.env.LCU_BROWSER_RELEASE;
if (!release?.startsWith('/')) throw new Error('Expected an absolute LCU_BROWSER_RELEASE');
const { chromium } = await import(`${release}/app/resources/cua_node/lib/node_modules/playwright-core/index.mjs`);
const browserKind = process.env.LCU_BROWSER_KIND ?? 'chromium';
const profile = `${process.env.HOME}/.config/${browserKind === 'chrome' ? 'lcu-chrome-direct-fixture' : 'chromium'}`;
const extension = process.env.LCU_BROWSER_EXTENSION;
if (!process.env.HOME || !extension || !['chrome', 'chromium'].includes(browserKind)) {
  throw new Error('Expected an isolated browser home and extension directory');
}
let context;
let browser;
let browserProcess;
process.on('exit', () => browserProcess?.kill('SIGTERM'));
if (browserKind === 'chrome') {
  // Playwright's launcher suppresses external extension startup. Start an
  // ordinary sandboxed Chrome, then observe its own DevTools endpoint.
  await unlink(`${profile}/DevToolsActivePort`).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  browserProcess = spawn('/usr/bin/google-chrome-stable', [
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--no-first-run', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  browserProcess.stderr.on('data', chunk => process.stderr.write(chunk));
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      port = Number((await readFile(`${profile}/DevToolsActivePort`, 'utf8')).split('\n')[0]);
      if (port > 0) break;
    } catch {}
    if (browserProcess.exitCode !== null) throw new Error(`Chrome exited: ${browserProcess.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!port) throw new Error('Chrome did not open its loopback DevTools endpoint');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  context = browser.contexts()[0];
} else {
  context = await chromium.launchPersistentContext(profile, {
    headless: false, chromiumSandbox: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  browser = context.browser();
}
const officialWorker = worker => worker.url().startsWith('chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/');
const worker = context.serviceWorkers().find(officialWorker)
  ?? await context.waitForEvent('serviceworker', { predicate: officialWorker, timeout: 45000 });
// Exercise LCU's relay from a fresh extension header state on every run.
// Clear only the disposable fixture profile's locally stored decision.
await worker.evaluate(() => chrome.storage.local.remove('AGENT_REQUEST_HEADER_ENABLED'));
let nativeDiagnostic;
if (process.env.LCU_BROWSER_NATIVE_DIAGNOSTIC === '1') {
  nativeDiagnostic = await worker.evaluate(() => new Promise(resolve => {
    const port = chrome.runtime.connectNative('com.openai.codexextension');
    let complete = false;
    port.onDisconnect.addListener(() => {
      if (!complete) {
        complete = true;
        resolve({ connected: false, error: chrome.runtime.lastError?.message ?? null });
      }
    });
    setTimeout(() => {
      if (!complete) {
        complete = true;
        resolve({ connected: true });
        port.disconnect();
      }
    }, 3000);
  }));
}
const page = context.pages()[0] ?? await context.newPage();
const browserVersion = browser?.version() ?? 'unavailable';
const userAgent = await page.evaluate(() => navigator.userAgent);
const extensionManifest = JSON.parse(await readFile(`${extension}/manifest.json`, 'utf8'));
await writeFile('/tmp/lcu-browser-ready', JSON.stringify({
  browserKind, browserVersion, userAgent,
  extensionVersion: extensionManifest.version,
  extensionServiceWorker: worker.url(),
  ...(nativeDiagnostic ? { nativeDiagnostic } : {}),
}));
process.on('SIGTERM', () => {
  browserProcess?.kill('SIGTERM');
  Promise.resolve(browserKind === 'chrome' ? browser?.close() : context.close())
    .finally(() => process.exit());
});
await new Promise(() => {});
