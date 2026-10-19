import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { BUNDLE_ID, CONFIG_FILE, DEFAULT_LCU, ICON_PIXELS, ICON_TTL_MS, NOTICE_TIMEOUT_MS, drawsImages, firstLine, noticeToast, ok, parseAllowed, parseNotice, plainWarning } from './data'
import type { AppRow, AppsData, SessionRow, UpdateNotice } from './data'
import {
  APPS_PREFIX, AppsView, ApprovalView, INITIAL_APPS, KEY_PREFIX, LABEL_ALWAYS, LABEL_DENY, LABEL_SESSION,
  appsRows, approvalRows,
} from './views'
import type { Approval, AppsState } from './views'

// The MCP server name `lcu setup` registers.
const SERVER = 'lcu'
const REQUEST_TOOL = 'approval_request'
const CHOICE_TOOL = 'approval_choice'
const ASK_HEADER = 'Computer use'
const APPROVAL_TITLE = 'Computer use approval'
const APPS_COMMAND = 'computer-use-apps'
const APPS_PANE = 'lcu-approved-apps'

type Choice = 'session' | 'always' | 'deny' | 'cancel'

// Panes on screen, by pane id: the request and the app's icon, if one could be made.
const shown = new Map<string, { approval: Approval; icon?: string; graphics: boolean }>()

const apps = atom({ plugin: 'lcu-approve', key: 'apps' } as const, INITIAL_APPS)

type McpResult = { isError?: boolean; content?: { type: string; text?: string }[] }

const textOf = (result: McpResult) =>
  (result.content ?? []).map(item => item.text ?? '').join('')

// Update notices: per session (the classic event's session_id), what was last announced and when the cache
// was last asked. Whether to announce at all is `lcu update --notice --announce`'s decision (once per session
// and release, at most once a day per release across the account), so the toast follows it.
const NOTICE_RECHECK_MS = 600000
const DEFAULT_SESSION = 'default'
const noticeSessions = new Map<string, { announced?: string; lastCheck?: number }>()

const paneId = (approval: Approval) => `lcu-approval-${approval.id}`

export const register: Register = on => {
  on('classic.Elicitation', async ($, e, next) => {
    if (e.mcp_server_name !== SERVER) return next(e)
    // Nobody to ask in a headless run: the engine answers for itself. The desktop app can report no
    // surfaces while it still places panes, so an empty list alone does not mean headless.
    const surfaces = await $.session.surfaces()
    if (surfaces.length === 0 && !(await placesPanes($))) return next(e)

    let approval: Approval
    try {
      const reply = (await $.mcp.call(SERVER, REQUEST_TOOL, { message: e.message })) as McpResult
      // Not a native-app approval (or LCU has no such pending request): leave the engine's form.
      if (reply.isError) return next(e)
      approval = JSON.parse(textOf(reply)) as Approval
    } catch {
      return next(e)
    }

    // The desktop app flags a session as needing input only for a permission request: the engine's
    // question card is one, a pane is not. So the app gets the card, even with a terminal attached too.
    // Asked from a timer, a dispatch of its own, so this hook does not wait on the person.
    if (surfaces.includes('desktop')) {
      $.clock.after(0, () => askAndRecord($, approval))
      return { block: 'Answered by the lcu-approve mod' }
    }

    // The icon is made here, in an event hook: a render closure cannot run a process.
    const icon = await appIcon($, approval.app).catch(() => undefined)
    const graphics = await terminalDrawsImages($)

    // No hook stays pending while the person decides: a pending hook keeps the desktop surface from
    // delivering the pane's presses. The pane's button (or Esc) records the choice with LCU, whose
    // relay keeps the runtime's elicitation open until then; this hook only blocks the engine's form.
    if (!(await showPane($, approval, icon, graphics))) {
      // A narrow terminal seats no pane: ask from a timer, which is a dispatch of its own.
      $.clock.after(0, () => askAndRecord($, approval))
    }
    return { block: 'Answered by the lcu-approve mod' }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId === APPS_PANE) {
      const state = await read($, apps)
      return <AppsView ui={$.ui.resolve(e)} state={state} />
    }
    const entry = shown.get(e.requestId)
    if (!entry) return next(e)
    // Presses are handled by the `ui.press` hook below, with that dispatch's own `$`.
    return <ApprovalView ui={$.ui.resolve(e)} surface={e.surface} approval={entry.approval} icon={entry.icon} graphics={entry.graphics} />
  })

  // A button press: record the choice with LCU from this dispatch, then take the pane down.
  on('ui.press', async ($, e, next) => {
    if (e.plugin !== $.plugin.name || !String(e.element).startsWith(KEY_PREFIX)) return next(e)
    const element = String(e.element)
    if (element.startsWith(APPS_PREFIX)) {
      await pressApps($, element.slice(APPS_PREFIX.length))
      return { element: e.element }
    }
    const rest = element.slice(KEY_PREFIX.length)
    const id = rest.slice(0, rest.lastIndexOf(':'))
    const choice = rest.slice(rest.lastIndexOf(':') + 1)
    const pane = `lcu-approval-${id}`
    const entry = shown.get(pane)
    if (entry) {
      shown.delete(pane)
      await finish($, entry.approval, choice as Choice)
    }
    return { element: e.element }
  })

  // The Allow field of the approved-apps panel.
  on('ui.input', async ($, e, next) => {
    if (e.plugin !== $.plugin.name || !String(e.element).startsWith(`${APPS_PREFIX}allow:`)) return next(e)
    const name = e.value.trim()
    if (e.kind === 'submit' && name) {
      await update($, apps, state => ({ ...state, nonce: state.nonce + 1 }))
      await runLcu($, ['allow', name], `Allowing ${name}. Confirm with Touch ID or your password...`)
    }
    return { element: e.element, value: e.value }
  })

  // Esc or the close mark dismisses the pane: that is a cancel.
  on('ui.close', async ($, e, next) => {
    const entry = shown.get(e.id)
    if (entry && e.origin.kind === 'person') {
      shown.delete(e.id)
      await record($, entry.approval.id, 'cancel')
      $.ui.toast(`Approval for ${entry.approval.label} dismissed`)
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: APPS_COMMAND,
      description: 'Show the apps Computer use may control, and allow or revoke them',
    })
    return next(e)
  })

  // An update notice from the cache `lcu update --notice` keeps: the model gets the message as session
  // context (`session.start` cannot carry any; the classic SessionStart hook can), the person one toast.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    const state = sessionState(e)
    state.lastCheck = await now($)
    const notice = await updateNotice($, sessionId(e))
    if (!notice) return result
    state.announced = notice.latest ?? notice.message
    await toast($, notice)
    return { ...result, additionalContext: [...(result.additionalContext ?? []), notice.message] }
  })

  // A release published while the session is open: the cache refreshes in the background, so the first
  // prompt and then at most one check per NOTICE_RECHECK_MS reads it; each version is announced once per
  // session, and once a day across the account.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    try {
      const state = sessionState(e)
      const at = await now($)
      if (state.lastCheck !== undefined && at - state.lastCheck < NOTICE_RECHECK_MS) return result
      state.lastCheck = at
      const notice = await updateNotice($, sessionId(e))
      if (!notice) return result
      const version = notice.latest ?? notice.message
      if (version === state.announced) return result
      state.announced = version
      await toast($, notice)
      return { ...result, additionalContext: [...(result.additionalContext ?? []), notice.message] }
    } catch {
      return result
    }
  })

  on('command.run', { command: APPS_COMMAND }, async $ => {
    await refresh($)
    await openApps($)
    return { text: 'Approved apps panel opened.' }
  })

  // The approval tools are for this mod alone: the model gets a refusal,
  // and the mod's own calls need no permission card.
  for (const name of [REQUEST_TOOL, CHOICE_TOOL]) {
    const tool = `mcp__${SERVER}__${name}`
    on('tool.call', { tool }, async ($, e, next) => {
      if (next.origin.plugin !== $.plugin.name) {
        return { deny: `${name} is a host-only LCU tool.` }
      }
      return next(e)
    })
    on('tool.check', { tool }, async ($, e, next) => {
      if (next.origin.plugin !== $.plugin.name) return next(e)
      return { decision: 'allow', reason: 'LCU approval mod' }
    })
  }
}

const now = async ($: any): Promise<number> => {
  try {
    const t = await $.clock.now()
    return typeof t === 'number' ? t : Date.now()
  } catch {
    return Date.now()
  }
}

const sessionId = (e: any): string | undefined =>
  typeof e?.session_id === 'string' && e.session_id ? e.session_id : undefined

const sessionState = (e: any) => {
  const id = sessionId(e) ?? DEFAULT_SESSION
  let state = noticeSessions.get(id)
  if (!state) noticeSessions.set(id, (state = {}))
  return state
}

async function toast($: any, notice: UpdateNotice) {
  if ((await $.session.surfaces().catch(() => [])).length === 0) return
  $.ui.toast(noticeToast(notice))
}

// `lcu update --notice --json --announce[=SESSION_ID]`: cache only, never blocks on the network, and prints
// `{}` when this session was already told or the release was announced on the account within a day. Any
// failure means no notice.
export async function updateNotice($: any, session?: string): Promise<UpdateNotice | undefined> {
  try {
    const { path } = await findLcu($)
    if (!path) return undefined
    const argv = [path, 'update', '--notice', '--json', session ? `--announce=${session}` : '--announce']
    const run = await $.process.run(argv, { timeoutMs: NOTICE_TIMEOUT_MS })
    if (!ok(run)) return undefined
    return parseNotice(run.stdout)
  } catch {
    return undefined
  }
}

export async function terminalDrawsImages($: any): Promise<boolean> {
  const get = (value: Promise<unknown>) => value.then(v => (typeof v === 'string' ? v : undefined), () => undefined)
  return drawsImages({
    TMUX: await get($.env.get('TMUX')),
    KITTY_WINDOW_ID: await get($.env.get('KITTY_WINDOW_ID')),
    GHOSTTY_RESOURCES_DIR: await get($.env.get('GHOSTTY_RESOURCES_DIR')),
    TERM: await get($.env.get('TERM')),
    TERM_PROGRAM: await get($.env.get('TERM_PROGRAM')),
  })
}

// The lcu executable: the path `lcu setup` wrote beside the mod, else the stable install location.
export async function findLcu($: any): Promise<{ path?: string; tried: string[] }> {
  const tried: string[] = []
  try {
    const config = JSON.parse(await $.fs.read(`${$.plugin.root}/${CONFIG_FILE}`))
    if (typeof config.lcu === 'string' && config.lcu) tried.push(config.lcu)
  } catch {
    // No install-time path.
  }
  const home = await $.env.get('HOME')
  if (home) tried.push(`${home}/${DEFAULT_LCU}`)
  for (const path of tried) {
    if (await $.fs.exists(path).catch(() => false)) return { path, tried }
  }
  return { tried }
}

export async function appPath($: any, bundleId: string): Promise<string | undefined> {
  if (!BUNDLE_ID.test(bundleId)) return undefined
  const found = await $.process.run(['/usr/bin/mdfind', `kMDItemCFBundleIdentifier == '${bundleId}'`], { timeoutMs: 4000 })
  const paths = found.stdout.split('\n').filter((line: string) => line.endsWith('.app'))
  return paths.find((path: string) => !path.includes('/Volumes/')) ?? paths[0]
}

const displayName = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.app$/, '')

// This conversation's grants: the session file the runtime keeps, keyed by the Claude session id.
async function sessionGrants($: any): Promise<SessionRow[]> {
  const id = await $.session.id()
  const codex = (await $.env.get('CODEX_HOME')) || `${await $.env.get('HOME')}/.codex`
  const file = `${codex}/computer-use/sessions/${id}.toml`
  if (!/^[A-Za-z0-9._-]+$/.test(String(id)) || !(await $.fs.exists(file).catch(() => false))) return []
  const ids = parseAllowed(await $.fs.read(file))
  const rows: SessionRow[] = []
  for (const bundleId of ids) {
    const path = await appPath($, bundleId).catch(() => undefined)
    const risk = await $.store.get(`risk:${bundleId}`)
    rows.push({ name: path ? displayName(path) : bundleId, bundleId, risk: typeof risk === 'string' ? risk : undefined })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadApps($: any, lcu: string): Promise<AppsData> {
  const run = await $.process.run([lcu, 'apps', '--json'], { timeoutMs: 20000 })
  if (!ok(run)) throw new Error(firstLine(run.stderr) || `lcu apps exited ${run.exitCode}`)
  let always: AppRow[]
  try {
    always = JSON.parse(run.stdout).apps
  } catch {
    throw new Error('lcu apps --json printed something unreadable')
  }
  return { always, session: await sessionGrants($).catch(() => []) }
}

// The app's icon as base64 PNG, or undefined: converted once with sips and kept in the store.
export async function appIcon($: any, bundleId: string, timeoutMs = 3500): Promise<string | undefined> {
  const key = `icon:${bundleId}`
  const cached = (await $.store.get(key)) as { png?: string; at?: number } | undefined
  if (cached?.png) return cached.png
  if (cached && typeof cached.at === 'number' && Date.now() - cached.at < ICON_TTL_MS) return undefined
  let timer: { cancel: () => void } | undefined
  const gave = new Promise<undefined>(resolve => { timer = $.clock.after(timeoutMs, () => resolve(undefined)) })
  const png = await Promise.race([convertIcon($, bundleId).catch(() => undefined), gave])
  timer?.cancel()
  await $.store.set(key, png ? { png } : { at: Date.now() }).catch(() => {})
  return png
}

async function convertIcon($: any, bundleId: string): Promise<string | undefined> {
  const app = await appPath($, bundleId)
  if (!app) return undefined
  const made = await $.process.run(['/usr/bin/mktemp', '-d'], { timeoutMs: 2000 })
  const dir = made.stdout.trim()
  if (!ok(made) || !dir.startsWith('/')) return undefined
  try {
    const out = `${dir}/icon.png`
    let source: string | undefined
    const named = await $.process.run(['/usr/bin/plutil', '-extract', 'CFBundleIconFile', 'raw', '-o', '-', `${app}/Contents/Info.plist`], { timeoutMs: 2000 })
    if (ok(named) && named.stdout.trim()) {
      const file = named.stdout.trim()
      source = `${app}/Contents/Resources/${file.endsWith('.icns') ? file : `${file}.icns`}`
      if (!(await $.fs.exists(source).catch(() => false))) source = undefined
    }
    if (source) {
      const sips = await $.process.run(['/usr/bin/sips', '-s', 'format', 'png', '-Z', ICON_PIXELS, source, '--out', out], { timeoutMs: 3000 })
      if (!ok(sips)) source = undefined
    }
    if (!source) {
      // Asset-catalog icons have no .icns: ask the system for the icon.
      // JXA does not bridge NSBitmapImageFileTypePNG, so pass its value (4); the name gives TIFF.
      const script = 'ObjC.import("AppKit");var i=$.NSWorkspace.sharedWorkspace.iconForFile(' + JSON.stringify(app) +
        ');var r=$.NSBitmapImageRep.imageRepWithData(i.TIFFRepresentation);' +
        'r.representationUsingTypeProperties(4,$({})).writeToFileAtomically(' + JSON.stringify(`${dir}/full.png`) + ',true)'
      const drawn = await $.process.run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', script], { timeoutMs: 3000 })
      if (!ok(drawn)) return undefined
      const small = await $.process.run(['/usr/bin/sips', '-s', 'format', 'png', '-Z', ICON_PIXELS, `${dir}/full.png`, '--out', out], { timeoutMs: 3000 })
      if (!ok(small)) return undefined
    }
    const { base64 } = await $.fs.read(out, { as: 'bytes' })
    // A picture the surface would refuse would replace the whole pane with the engine's own.
    return typeof base64 === 'string' && base64.startsWith('iVBORw0KGgo') ? base64 : undefined
  } finally {
    await $.process.run(['/bin/rm', '-rf', dir], { timeoutMs: 2000 }).catch(() => {})
  }
}

async function openApps($: any): Promise<void> {
  const state = await read($, apps)
  await $.ui.open({
    id: APPS_PANE,
    title: 'Approved apps',
    focus: true,
    closeOnEscape: true,
    rows: appsRows(state),
  })
}

// Read the lists again; a failure leaves the panel saying so.
async function refresh($: any): Promise<void> {
  const { path, tried } = await findLcu($)
  if (!path) {
    const where = tried.length ? tried.join(' or ') : '~/.local/share/lcu/current/bin/lcu'
    await update($, apps, state => ({
      ...state, isLoaded: true, always: [], session: [],
      unavailable: `The lcu command was not found at ${where}. Run lcu setup --agent claude-code again.`,
    }))
    return
  }
  try {
    const data = await loadApps($, path)
    await update($, apps, state => ({ ...state, ...data, isLoaded: true, unavailable: undefined }))
  } catch (error) {
    const text = `Could not list the apps: ${(error as Error).message}`
    await update($, apps, state => ({
      ...state, isLoaded: true, unavailable: state.always.length || state.session.length ? undefined : text,
      notice: { tone: 'error', text },
    }))
  }
}

async function pressApps($: any, action: string): Promise<void> {
  if (action === 'refresh') {
    await update($, apps, state => ({ ...state, notice: undefined }))
    await refresh($)
    return
  }
  if (action.startsWith('revoke:')) {
    const bundleId = action.slice('revoke:'.length)
    await runLcu($, ['revoke', bundleId], `Revoking ${bundleId}. Confirm with Touch ID or your password...`)
  }
}

// Run `lcu apps <args>`, which asks macOS for Touch ID or the password itself; show what it says.
async function runLcu($: any, args: string[], working: string): Promise<void> {
  if ((await read($, apps)).busy) return
  const { path } = await findLcu($)
  if (!path) {
    await refresh($)
    return
  }
  await update($, apps, (state: AppsState) => ({ ...state, busy: working, notice: undefined }))
  let notice: AppsState['notice']
  try {
    const run = await $.process.run([path, 'apps', ...args], { timeoutMs: 180000 })
    notice = run.exitCode === 0
      ? { tone: 'ok', text: firstLine(run.stdout) || 'Done.' }
      : { tone: 'error', text: firstLine(run.stderr).replace(/^lcu apps: /, '') || `lcu apps exited ${run.exitCode}` }
  } catch (error) {
    notice = { tone: 'error', text: `Could not run lcu: ${(error as Error).message}` }
  }
  $.ui.toast(notice.text)
  await update($, apps, (state: AppsState) => ({ ...state, busy: undefined, notice }))
  await refresh($)
  await openApps($)
}

// Tell LCU what the person chose; false when LCU refused it.
async function record($: any, id: string, choice: Choice): Promise<boolean> {
  try {
    const reply = (await $.mcp.call(SERVER, CHOICE_TOOL, { id, choice })) as McpResult
    if (!reply.isError) return true
    report($, `LCU refused the choice: ${textOf(reply)}`)
  } catch (error) {
    report($, `could not send the choice to LCU: ${String(error)}`)
  }
  return false
}

// A failure the person should see, and the debug log keeps.
function report($: any, text: string): void {
  $.ui.log(`lcu-approve: ${text}`, { to: 'debug' })
  $.ui.toast(`Computer use approval: ${text}`)
}

const CONFIRMATION: Record<Choice, (name: string) => string> = {
  session: name => `${name} allowed for this conversation`,
  always: name => `${name} always allowed`,
  deny: name => `${name} denied`,
  cancel: name => `Approval for ${name} dismissed`,
}

// Record the person's choice, confirm it, then take the pane down. A refused record means the request ended.
async function finish($: any, approval: Approval, choice: Choice): Promise<void> {
  const recorded = await record($, approval.id, choice)
  const id = paneId(approval)
  await $.ui.close({ id }).catch(() => {})
  if (!recorded) return
  if (choice === 'session' || choice === 'always') {
    if (approval.riskLevel === 'high') await $.store.set(`risk:${approval.app}`, 'high').catch(() => {})
  }
  $.ui.toast(CONFIRMATION[choice](approval.label))
}

// Whether a pane would be drawn, asked before LCU's request is claimed so a headless run stays the engine's.
async function placesPanes($: any): Promise<boolean> {
  const id = 'lcu-approval-probe'
  try {
    return (await $.ui.open({ id })).isPlaced === true
  } catch {
    return false
  } finally {
    await $.ui.close({ id }).catch(() => {})
  }
}

// Open the pane; false when it waits undrawn (a narrow terminal) and the person needs another prompt.
async function showPane($: any, approval: Approval, icon: string | undefined, graphics: boolean): Promise<boolean> {
  const id = paneId(approval)
  shown.set(id, { approval, icon, graphics })
  try {
    const opened = await $.ui.open({
      id,
      title: APPROVAL_TITLE,
      focus: true,
      closeOnEscape: true,
      holdToasts: true,
      rows: approvalRows(approval),
    })
    if (opened.isPlaced) return true
  } catch {
    // Fall through to the question dialog.
  }
  shown.delete(id)
  await $.ui.close({ id }).catch(() => {})
  return false
}

// What a dismissed card (its close mark, or Skip) resolves the question with.
const DISMISSED = '[User dismissed'

// The question: the app, the risk when high. The desktop app draws only this text and the option labels.
function askQuestion(approval: Approval): string {
  const sentence = `Computer use will be able to see and control ${approval.label} (${approval.app}).`
  if (approval.riskLevel !== 'high') return `${sentence} Allow it?`
  const warning = approval.warning ? ` ${plainWarning(approval.warning)}` : ''
  return `\u26a0\ufe0f High risk \u2014 ${sentence}${warning} Allow it?`
}

// The engine's question dialog: the desktop app's card, and a terminal where no pane is seated.
async function askAndRecord($: any, approval: Approval): Promise<void> {
  const options = [LABEL_SESSION, ...(approval.scopes.includes('always') ? [LABEL_ALWAYS] : []), LABEL_DENY]
  const started = await now($)
  let choice: Choice = 'cancel'
  try {
    const answer: string = await $.ui.ask(askQuestion(approval), { options, header: ASK_HEADER })
    // A dismissed card resolves with a note instead of rejecting: a cancel, as Esc on the pane.
    if (!String(answer).startsWith(DISMISSED)) {
      choice = 'deny'
      // A person cannot answer in under a few hundred milliseconds; anything faster was not a person.
      if ((await now($)) - started >= 400) {
        if (answer === LABEL_SESSION) choice = 'session'
        else if (answer === LABEL_ALWAYS && options.includes(LABEL_ALWAYS)) choice = 'always'
      }
    }
  } catch {
    // Dismissed.
  }
  if (await record($, approval.id, choice)) {
    if ((choice === 'session' || choice === 'always') && approval.riskLevel === 'high') {
      await $.store.set(`risk:${approval.app}`, 'high').catch(() => {})
    }
    $.ui.toast(CONFIRMATION[choice](approval.label))
  }
}
