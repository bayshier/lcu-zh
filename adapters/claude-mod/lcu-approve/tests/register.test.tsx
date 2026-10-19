import { expect, mock, test } from 'claude-code/testing'

import { plainWarning } from '../hooks/data'

const APPROVAL = {
  id: 'abc',
  message: 'Allow Computer Use to use "Zed"?',
  app: 'dev.zed.Zed',
  label: 'Zed',
  scopes: ['session', 'always'],
  riskLevel: 'high',
  warning: 'Allowing ChatGPT to use this app introduces new risks.',
}

const ok = (value: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(value) }] } })

// Stand in for LCU beneath the mod: record what the mod sends, answer like the relay.
function lcu(on: any, { approval = APPROVAL, surfaces = ['terminal'], placed = true, opened = [] as string[] } = {}) {
  const calls: { tool: string; args: any }[] = []
  on('session.surfaces', () => ({ value: surfaces }))
  on('classic.Elicitation', () => ({}))
  on('ui.close', () => ({ value: undefined }))
  on('ui.open', (_$: any, e: any) => {
    opened.push(e.id)
    return { value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  // `$.mcp.call(server, tool, args)` reaches the bottom as one `mcp.call` event.
  on('mcp.call', async (_$: any, e: any) => {
    expect(e.server).toBe('lcu')
    if (e.tool === 'approval_request') {
      calls.push({ tool: 'request', args: e.args })
      return ok(approval)
    }
    calls.push({ tool: 'choice', args: e.args })
    return ok({ ok: true })
  })
  return calls
}

// Stand in for the engine's question dialog: keep each question, answer after a person's pause.
function asker(on: any, clock: any, answer = 'Deny') {
  const questions: any[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$: any, e: any) => {
    const [question] = e.questions
    questions.push(question)
    await clock.advance(1000)
    return { result: { questions: e.questions, answers: { [question.question]: answer } } } as any
  })
  return questions
}

// Let the mod's hook run until LCU has seen the call.
async function until(clock: any, seen: () => boolean) {
  for (let tick = 0; tick < 400 && !seen(); tick++) await clock.advance(5)
}

const ELICITATION = { mcp_server_name: 'lcu', message: APPROVAL.message }

async function openPane($: any, clock: any, calls: any[]) {
  const result: any = await $.classic.Elicitation(ELICITATION as any)
  await until(clock, () => calls.some(call => call.tool === 'request'))
  const ui = await $.ui.mount({
    plugin: 'lcu-approve',
    surface: 'terminal',
    component: 'Pane',
    requestId: `lcu-approval-${APPROVAL.id}`,
    props: { title: 'Computer use approval', isFocused: true, bodyColumns: 100, placement: 'inline' } as any,
  })
  return { result, ui }
}

test('the hook blocks at once; a pane press then records the choice with LCU', async ($, on) => {
  const clock = mock.clock(on)
  const calls = lcu(on)
  // The hook returns without a press: nothing waits on the person.
  const { result, ui } = await openPane($, clock, calls)
  expect(result.block).toBeDefined()
  expect(calls.map(call => call.tool)).toEqual(['request'])
  expect((await ui.findAll({ type: 'Button' })).map(button => button.text)).toEqual([
    'Allow this conversation', 'Always allow', 'Deny',
  ])
  expect(await ui.find({ type: 'Text', text: /new risks/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ChatGPT/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Allowing computer use to control this app/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Computer use will be able to see and control Zed.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'dev.zed.Zed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /High risk/ })).toBeDefined()
  await ui.press({ key: 'lcu-approve:abc:always' })
  expect(calls.filter(call => call.tool === 'choice').map(call => call.args.choice)).toEqual(['always'])
  expect(calls.find(call => call.tool === 'choice')?.args.id).toBe(APPROVAL.id)
})

test('the pane leaves out Always allow when the runtime did not offer it', async ($, on) => {
  const clock = mock.clock(on)
  const calls = lcu(on, { approval: { ...APPROVAL, scopes: ['session'], riskLevel: 'low', warning: undefined as any } })
  const { ui } = await openPane($, clock, calls)
  expect((await ui.findAll({ type: 'Button' })).map(button => button.text)).toEqual(['Allow this conversation', 'Deny'])
  await ui.press({ key: 'lcu-approve:abc:deny' })
  expect(calls.filter(call => call.tool === 'choice').map(call => call.args.choice)).toEqual(['deny'])
})

test('a pane on a narrow terminal is replaced by the question dialog, asked after the hook returned', async ($, on) => {
  const clock = mock.clock(on)
  const calls = lcu(on, { placed: false })
  const questions = asker(on, clock)
  const result: any = await $.classic.Elicitation(ELICITATION as any)
  expect(result.block).toBeDefined()
  expect(calls.map(call => call.tool)).toEqual(['request'])
  await until(clock, () => calls.some(call => call.tool === 'choice'))
  expect(questions.length).toBe(1)
  expect(calls.filter(call => call.tool === 'choice').length).toBe(1)
})

test('an elicitation LCU does not recognize is left to the engine', async ($, on) => {
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('classic.Elicitation', () => ({}))
  on('mcp.call', () => ({ value: { isError: true, content: [{ type: 'text', text: 'none' }] } }))
  const result: any = await $.classic.Elicitation(ELICITATION as any)
  expect(result.block).toBeUndefined()
})

test('a session that reports no surfaces but places panes still gets the pane', async ($, on) => {
  const clock = mock.clock(on)
  const calls = lcu(on, { surfaces: [] })
  const result: any = await $.classic.Elicitation(ELICITATION as any)
  await until(clock, () => calls.some(call => call.tool === 'request'))
  expect(result.block).toBeDefined()
  expect(calls.map(call => call.tool)).toEqual(['request'])
})

test('another server, and a headless run, are left to the engine', async ($, on) => {
  const calls = lcu(on, { surfaces: [], placed: false })
  const headless: any = await $.classic.Elicitation(ELICITATION as any)
  expect(headless.block).toBeUndefined()
  const other: any = await $.classic.Elicitation({ mcp_server_name: 'other', message: 'Hi?' } as any)
  expect(other.block).toBeUndefined()
  expect(calls).toEqual([])
})

test('the model may not call the host-only tools', async ($, on) => {
  for (const name of ['approval_request', 'approval_choice']) {
    const denied: any = await $.tool.call({ tool: `mcp__lcu__${name}`, tool_use_id: 'toolu_01abc' } as any)
    expect(JSON.stringify(denied)).toContain('host-only')
  }
})

// The host beneath the mod: processes, files, the store, the session, toasts.
function host(on: any, { files = {} as Record<string, string>, processes = (argv: string[]): any => undefined, session = 'sess-1', terminal = 'ghostty' } = {}) {
  const ran: string[][] = []
  const toasts: string[] = []
  const store = new Map<string, unknown>()
  on('process.run', (_$: any, e: any) => {
    ran.push([...e.argv])
    const made = processes([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', ...(made ?? {}) } }
  })
  // A file the setup wrote beside the mod is named `lcu.json` here, wherever the mod's folder is.
  const key = (path: string) => (path.endsWith('/lcu.json') ? 'lcu.json' : path)
  on('fs.exists', (_$: any, e: any) => ({ value: key(e.path) in files }))
  on('fs.read', (_$: any, e: any) =>
    key(e.path) in files
      ? { value: e.as === 'bytes' ? { base64: files[key(e.path)] } : files[key(e.path)] }
      : { deny: `no such file: ${e.path}` })
  on('env.get', (_$: any, e: any) => ({ value: ({ HOME: '/home/me', TERM_PROGRAM: terminal } as Record<string, string>)[e.name] }))
  on('session.id', () => ({ value: session }))
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_$: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  return { ran, toasts, store }
}

const LCU = '/home/me/.local/share/lcu/current/bin/lcu'
const ZED_ICON = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const iconProcesses = (argv: string[]) => {
  if (argv[0] === '/usr/bin/mdfind') return { stdout: '/Applications/Zed.app\n' }
  if (argv[0] === '/usr/bin/mktemp') return { stdout: '/tmp/icons\n' }
  if (argv[0] === '/usr/bin/plutil') return { stdout: 'Zed\n' }
}
const ICON_FILES = { '/Applications/Zed.app/Contents/Resources/Zed.icns': '', '/tmp/icons/icon.png': ZED_ICON }

test('the approval shows the app icon made with sips, on a terminal and on the app, and caches it', async ($, on) => {
  const clock = mock.clock(on)
  const calls = lcu(on)
  const { ran, store } = host(on, { files: ICON_FILES, processes: iconProcesses })
  const { ui } = await openPane($, clock, calls)
  expect(ran.some(argv => argv[0] === '/usr/bin/sips' && argv.includes('/Applications/Zed.app/Contents/Resources/Zed.icns'))).toBe(true)
  expect(ran.at(-1)).toEqual(['/bin/rm', '-rf', '/tmp/icons'])
  expect(store.get('icon:dev.zed.Zed')).toEqual({ png: ZED_ICON })
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  const app = await $.ui.mount({
    plugin: 'lcu-approve', surface: 'desktop', component: 'Pane', requestId: `lcu-approval-${APPROVAL.id}`,
    props: { title: 'Computer use approval', isFocused: true, bodyColumns: 100, placement: 'dock' } as any,
  })
  expect(await app.find({ type: 'Svg' })).toBeDefined()
  expect(await app.find({ type: 'Image' })).toBeUndefined()
  const before = ran.length
  await $.classic.Elicitation(ELICITATION as any)
  await until(clock, () => calls.filter(call => call.tool === 'request').length === 2)
  expect(ran.slice(before).filter(argv => argv[0] === '/usr/bin/sips')).toEqual([])
})

test('an app without an .icns gets its icon from the system as PNG', async ($, on) => {
  const clock = mock.clock(on)
  const calls = lcu(on)
  const { ran, store } = host(on, {
    files: { '/tmp/icons/icon.png': ZED_ICON },
    processes: (argv: string[]) => argv[0] === '/usr/bin/plutil' ? { exitCode: 1 } : iconProcesses(argv),
  })
  const { ui } = await openPane($, clock, calls)
  const drawn = ran.find(argv => argv[0] === '/usr/bin/osascript')
  expect(drawn?.at(-1)).toContain('representationUsingTypeProperties(4,')
  const small = ran.find(argv => argv[0] === '/usr/bin/sips') ?? []
  expect(small.slice(0, 5)).toEqual(['/usr/bin/sips', '-s', 'format', 'png', '-Z'])
  expect(small.slice(-3)).toEqual(['/tmp/icons/full.png', '--out', '/tmp/icons/icon.png'])
  expect(store.get('icon:dev.zed.Zed')).toEqual({ png: ZED_ICON })
  expect(await ui.find({ type: 'Image' })).toBeDefined()
})

test('an approval without an icon still opens; the primary, secondary and dismiss buttons keep their order', async ($, on) => {
  const clock = mock.clock(on)
  const calls = lcu(on)
  host(on, { processes: () => ({ exitCode: 1 }) })
  const { ui } = await openPane($, clock, calls)
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.map(button => button.text)).toEqual(['Allow this conversation', 'Always allow', 'Deny'])
})

test('a press confirms with a toast and takes the pane down', async ($, on) => {
  const clock = mock.clock(on)
  const calls = lcu(on)
  const { toasts } = host(on)
  const { ui } = await openPane($, clock, calls)
  await ui.press({ key: 'lcu-approve:abc:session' })
  expect(toasts).toEqual(['Zed allowed for this conversation'])
})

test('the toast says what was chosen', async ($, on) => {
  const clock = mock.clock(on)
  const calls = lcu(on)
  const { toasts } = host(on)
  const { ui } = await openPane($, clock, calls)
  await ui.press({ key: 'lcu-approve:abc:deny' })
  expect(toasts).toEqual(['Zed denied'])
})

const APPS_JSON = JSON.stringify({
  file: '/x/ComputerUseAppApprovals.json',
  apps: [
    { name: 'Safari', bundleId: 'com.apple.Safari', installed: true, risk: 'high', blocked: false },
    { name: 'Zed', bundleId: 'dev.zed.Zed', installed: true, risk: 'normal', blocked: false },
    { name: 'org.gone.App', bundleId: 'org.gone.App', installed: false, risk: 'normal', blocked: false },
  ],
})
const SESSION_FILE = '/home/me/.codex/computer-use/sessions/sess-1.toml'

function appsHost(on: any, extra: { files?: Record<string, string>; bare?: true; processes?: (argv: string[]) => any } = {}) {
  on('session.start', () => ({ cwd: '/work' }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: undefined }))
  return host(on, {
    files: extra.bare ? {} : { [LCU]: '', [SESSION_FILE]: '[apps]\nallowed = [\n  "com.apple.calculator",\n]\n', ...extra.files },
    processes: argv => {
      if (argv[0] === LCU && argv[2] === '--json') return { stdout: APPS_JSON }
      if (argv[0] === '/usr/bin/mdfind') return { stdout: '/System/Applications/Calculator.app\n' }
      return extra.processes?.(argv)
    },
  })
}

async function openApps($: any, surface: 'terminal' | 'desktop' = 'desktop') {
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true } as any)
  await $.command.run({ command: 'computer-use-apps' } as any)
  return $.ui.mount({
    plugin: 'lcu-approve', surface, component: 'Pane', requestId: 'lcu-approved-apps',
    props: { title: 'Approved apps', isFocused: true, bodyColumns: 100, placement: 'inline' } as any,
  })
}

test('the apps panel lists the always-allowed apps and this conversation\'s grants', async ($, on) => {
  const { ran } = appsHost(on)
  const ui = await openApps($)
  expect(ran).toContainEqual([LCU, 'apps', '--json'])
  const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
  expect(texts).toEqual(expect.arrayContaining([
    'Always allowed (2)', 'Not installed (1)', 'org.gone.App', 'Safari', 'com.apple.Safari', ' High risk ', 'Zed', 'dev.zed.Zed',
    'This conversation (1)', 'Calculator', 'com.apple.calculator', 'Ends with this conversation',
  ]))
  expect((await ui.findAll({ type: 'Button' })).map(button => button.text)).toEqual(['Refresh', 'Revoke', 'Revoke', 'Revoke'])
})

test('Revoke runs lcu apps revoke, toasts its message and lists again', async ($, on) => {
  const { ran, toasts } = appsHost(on, {
    processes: argv => argv[2] === 'revoke' ? { stdout: 'Removed: Zed (dev.zed.Zed). Computer Use asks again.\n' } : undefined,
  })
  const ui = await openApps($)
  ran.length = 0
  await ui.press({ key: 'lcu-approve:apps:revoke:dev.zed.Zed' })
  expect(ran.filter(argv => argv[0] === LCU)).toEqual([[LCU, 'apps', 'revoke', 'dev.zed.Zed'], [LCU, 'apps', '--json']])
  expect(toasts).toEqual(['Removed: Zed (dev.zed.Zed). Computer Use asks again.'])
  expect(await ui.find({ type: 'Text', text: /Removed: Zed/ })).toBeDefined()
})

test('the Allow field runs lcu apps allow and shows a failure as it came', async ($, on) => {
  const { ran, toasts } = appsHost(on, {
    processes: argv => argv[2] === 'allow' ? { exitCode: 1, stderr: 'lcu apps: authentication was cancelled or failed. Nothing was changed.\n' } : undefined,
  })
  const ui = await openApps($)
  ran.length = 0
  await ui.input({ key: 'lcu-approve:apps:allow:0', text: ' Notes ' })
  expect(ran.filter(argv => argv[2] === 'allow')).toEqual([[LCU, 'apps', 'allow', 'Notes']])
  expect(toasts.at(-1)).toBe('authentication was cancelled or failed. Nothing was changed.')
  expect(await ui.find({ type: 'Text', text: /authentication was cancelled/ })).toBeDefined()
})

test('Refresh lists again without changing anything', async ($, on) => {
  const { ran } = appsHost(on)
  const ui = await openApps($)
  ran.length = 0
  await ui.press({ key: 'lcu-approve:apps:refresh' })
  expect(ran.filter(argv => argv[0] === LCU)).toEqual([[LCU, 'apps', '--json']])
})

test('the apps panel says so when lcu is not installed, and runs nothing', async ($, on) => {
  const { ran } = appsHost(on, { bare: true })
  const ui = await openApps($, 'terminal')
  expect(ran).toEqual([])
  expect(await ui.find({ type: 'Text', text: /lcu command was not found at \/home\/me\/\.local\/share\/lcu\/current\/bin\/lcu/ })).toBeDefined()
})

test('the lcu path setup wrote beside the mod wins over the default', async ($, on) => {
  const { ran } = appsHost(on, {
    files: { 'lcu.json': '{"lcu":"/opt/lcu/bin/lcu"}', '/opt/lcu/bin/lcu': '' },
    processes: argv => (argv[0] === '/opt/lcu/bin/lcu' ? { stdout: APPS_JSON } : undefined),
  })
  await openApps($)
  expect(ran.find(argv => argv.includes('--json'))?.[0]).toBe('/opt/lcu/bin/lcu')
})

test('the panel never offers to revoke a conversation grant', async ($, on) => {
  appsHost(on)
  const ui = await openApps($)
  expect((await ui.findAll({ type: 'Button' })).map(button => button.key ?? button.text).join()).not.toContain('calculator')
})

test('the warning is shown without the runtime\'s product name', async () => {
  expect(plainWarning('Allowing ChatGPT to use this app introduces new risks. Carefully monitor ChatGPT while it uses this app. ChatGPT may err.'))
    .toBe('Allowing computer use to control this app introduces new risks. Carefully monitor the agent while it uses this app. the agent may err.')
})

test('the ask fallback shows the warning without the product name', async ($, on) => {
  const clock = mock.clock(on)
  const calls = lcu(on, { placed: false })
  const questions = asker(on, clock)
  await $.classic.Elicitation(ELICITATION as any)
  await until(clock, () => calls.some(call => call.tool === 'choice'))
  expect(questions[0].question).toBe(
    '\u26a0\ufe0f High risk \u2014 Computer use will be able to see and control Zed (dev.zed.Zed). ' +
    'Allowing computer use to control this app introduces new risks. Allow it?')
  expect(questions[0].header).toBe('Computer use')
  expect(questions[0].options.map((option: any) => option.label)).toEqual(['Allow this conversation', 'Always allow', 'Deny'])
})

// The desktop app flags the session only for a permission request, which the question card is.
const DESKTOP = { approval: { ...APPROVAL, scopes: ['session'], riskLevel: 'low', warning: undefined as any }, surfaces: ['desktop'] }

test('on the desktop app the question card asks, and no pane opens', async ($, on) => {
  const clock = mock.clock(on)
  const opened: string[] = []
  const calls = lcu(on, { ...DESKTOP, opened })
  const { toasts } = host(on)
  const questions = asker(on, clock, 'Allow this conversation')
  const result: any = await $.classic.Elicitation(ELICITATION as any)
  expect(result.block).toBeDefined()
  await until(clock, () => calls.some(call => call.tool === 'choice'))
  expect(opened).toEqual([])
  expect(questions.map(question => question.question)).toEqual([
    'Computer use will be able to see and control Zed (dev.zed.Zed). Allow it?',
  ])
  expect(questions[0].options.map((option: any) => option.label)).toEqual(['Allow this conversation', 'Deny'])
  expect(calls.filter(call => call.tool === 'choice').map(call => call.args.choice)).toEqual(['session'])
  expect(toasts).toEqual(['Zed allowed for this conversation'])
})

test('with a terminal attached as well, the desktop app still gets the question card', async ($, on) => {
  const clock = mock.clock(on)
  const opened: string[] = []
  const calls = lcu(on, { ...DESKTOP, surfaces: ['terminal', 'desktop'], opened })
  const questions = asker(on, clock, 'Deny')
  await $.classic.Elicitation(ELICITATION as any)
  await until(clock, () => calls.some(call => call.tool === 'choice'))
  expect(opened).toEqual([])
  expect(questions.length).toBe(1)
  expect(calls.filter(call => call.tool === 'choice').map(call => call.args.choice)).toEqual(['deny'])
})

test('a terminal alone gets the pane, not the question card', async ($, on) => {
  const clock = mock.clock(on)
  const opened: string[] = []
  const calls = lcu(on, { opened })
  const questions = asker(on, clock)
  await $.classic.Elicitation(ELICITATION as any)
  await until(clock, () => calls.some(call => call.tool === 'request'))
  await clock.advance(2000)
  expect(opened).toContain(`lcu-approval-${APPROVAL.id}`)
  expect(questions).toEqual([])
  expect(calls.map(call => call.tool)).toEqual(['request'])
})

test('a dismissed question card is a cancel; typed text is a deny', async ($, on) => {
  const clock = mock.clock(on)
  const answers = ['[User dismissed \u2014 do not proceed, wait for next instruction]', 'something else']
  const calls = lcu(on, DESKTOP)
  const { toasts } = host(on)
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$: any, e: any) => {
    const [question] = e.questions
    await clock.advance(1000)
    return { result: { questions: e.questions, answers: { [question.question]: answers.shift() } } } as any
  })
  for (let n = 1; n <= 2; n++) {
    await $.classic.Elicitation(ELICITATION as any)
    await until(clock, () => calls.filter(call => call.tool === 'choice').length === n)
  }
  expect(calls.filter(call => call.tool === 'choice').map(call => call.args.choice)).toEqual(['cancel', 'deny'])
  expect(toasts).toEqual(['Approval for Zed dismissed', 'Zed denied'])
})

test('a too-fast answer on the question card is a deny', async ($, on) => {
  const clock = mock.clock(on)
  const calls = lcu(on, DESKTOP)
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$: any, e: any) => {
    const [question] = e.questions
    return { result: { questions: e.questions, answers: { [question.question]: 'Allow this conversation' } } } as any
  })
  await $.classic.Elicitation(ELICITATION as any)
  await until(clock, () => calls.some(call => call.tool === 'choice'))
  expect(calls.filter(call => call.tool === 'choice').map(call => call.args.choice)).toEqual(['deny'])
})

test('not installed apps are grouped after the installed ones and stay revocable', async ($, on) => {
  appsHost(on)
  const ui = await openApps($)
  const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
  expect(texts.indexOf('Not installed (1)')).toBeGreaterThan(texts.indexOf('Zed'))
  expect(texts.indexOf('org.gone.App')).toBeGreaterThan(texts.indexOf('Not installed (1)'))
  expect(texts).not.toContain('Not installed')
  expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toContain('lcu-approve:apps:revoke:org.gone.App')
})

test('a terminal that cannot draw pictures gets no icon cell before the name', async ($, on) => {
  const clock = mock.clock(on)
  const calls = lcu(on)
  const { store } = host(on, { files: ICON_FILES, processes: iconProcesses, terminal: 'Apple_Terminal' })
  const { ui } = await openPane($, clock, calls)
  expect(store.get('icon:dev.zed.Zed')).toEqual({ png: ZED_ICON })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
})

const NOTICE = {
  current: '0.9.1', latest: '0.9.2', severity: 'normal', release_url: 'https://example.test/r', command: LCU,
  message: 'LCU 0.9.2 is available (installed: 0.9.1). Tell the user and offer to run `lcu update`.',
}

function noticeHost(on: any, processes: (argv: string[]) => any, surfaces: string[] = ['terminal'], files: Record<string, string> = { [LCU]: '' }) {
  on('classic.SessionStart', () => ({}))
  on('session.surfaces', () => ({ value: surfaces }))
  return host(on, { files, processes })
}

const noticeRun = (stdout: string) => (argv: string[]) => (argv[1] === 'update' ? { stdout } : undefined)

test('an update notice becomes session context and one toast', async ($, on) => {
  const { ran, toasts } = noticeHost(on, noticeRun(JSON.stringify(NOTICE)))
  const result: any = await $.classic.SessionStart({ source: 'startup' } as any)
  expect(ran.find(argv => argv[1] === 'update')?.slice(0, 4)).toEqual([LCU, 'update', '--notice', '--json'])
  expect(ran.find(argv => argv[1] === 'update')?.[4]).toMatch(/^--announce/)
  expect(result.additionalContext).toEqual([NOTICE.message])
  expect(toasts).toEqual(['LCU 0.9.2 is available \u2014 ask Claude to update it, or run lcu update'])
})

test('the session id goes to lcu, which applies the account-wide cooldown', async ($, on) => {
  const { ran } = noticeHost(on, noticeRun(JSON.stringify(NOTICE)))
  await $.classic.SessionStart({ source: 'startup', session_id: 's1' } as any)
  expect(ran.find(argv => argv[1] === 'update')).toEqual([LCU, 'update', '--notice', '--json', '--announce=s1'])
})

test('a release lcu already announced on the account today: no context, no toast', async ($, on) => {
  const { toasts } = noticeHost(on, argv => (argv[1] === 'update' ? { stdout: argv[4] === '--announce=s2' ? '{}' : JSON.stringify(NOTICE) } : undefined))
  const first: any = await $.classic.SessionStart({ source: 'startup', session_id: 's1' } as any)
  const second: any = await $.classic.SessionStart({ source: 'startup', session_id: 's2' } as any)
  expect(first.additionalContext).toEqual([NOTICE.message])
  expect(second.additionalContext).toBeUndefined()
  expect(toasts.length).toBe(1)
})

test('a headless run gets the context without a toast', async ($, on) => {
  const { toasts } = noticeHost(on, noticeRun(JSON.stringify(NOTICE)), [])
  const result: any = await $.classic.SessionStart({ source: 'startup' } as any)
  expect(result.additionalContext).toEqual([NOTICE.message])
  expect(toasts).toEqual([])
})

test('a security notice toast is prefixed', async ($, on) => {
  const { toasts } = noticeHost(on, noticeRun(JSON.stringify({ ...NOTICE, severity: 'security' })))
  await $.classic.SessionStart({ source: 'startup' } as any)
  expect(toasts[0].startsWith('Security update: LCU 0.9.2')).toBe(true)
})

const quiet: [string, (argv: string[]) => any][] = [
  ['no update known', noticeRun('{}')],
  ['garbage output', noticeRun('not json')],
  ['a non-object', noticeRun('[1]')],
  ['a failing command', argv => (argv[1] === 'update' ? { exitCode: 3, stderr: 'boom' } : undefined)],
  ['a command that cannot run', () => { throw new Error('no processes') }],
]
for (const [name, processes] of quiet) {
  test(`${name}: no context, no toast, no throw`, async ($, on) => {
    const { toasts } = noticeHost(on, processes)
    const result: any = await $.classic.SessionStart({ source: 'startup' } as any)
    expect(result.additionalContext).toBeUndefined()
    expect(toasts).toEqual([])
  })
}

test('without lcu installed nothing is run for the notice', async ($, on) => {
  const { ran } = noticeHost(on, noticeRun(JSON.stringify(NOTICE)), ['terminal'], {})
  await $.classic.SessionStart({ source: 'startup' } as any)
  expect(ran.some(argv => argv[1] === 'update')).toBe(false)
})

// Prompts after the session started: the first checks, later ones at most every ten minutes.
const MIN = 60000
function promptHost(on: any, processes: (argv: string[]) => any) {
  on('classic.UserPromptSubmit', () => ({}))
  return noticeHost(on, processes)
}
const prompt = ($: any, session_id = 's1') => $.classic.UserPromptSubmit({ prompt: 'hi', session_id } as any)
const checks = (ran: string[][]) => ran.filter(argv => argv[1] === 'update').length
const NEWER = { ...NOTICE, latest: '0.9.3', message: 'LCU 0.9.3 is available.' }

test('the first prompt checks for a notice', async ($, on) => {
  const { ran, toasts } = promptHost(on, noticeRun(JSON.stringify(NOTICE)))
  const result: any = await prompt($)
  expect(checks(ran)).toBe(1)
  expect(result.additionalContext).toEqual([NOTICE.message])
  expect(toasts.length).toBe(1)
})

test('a prompt within ten minutes of a check does not run the command', async ($, on) => {
  const clock = mock.clock(on)
  const { ran } = promptHost(on, noticeRun('{}'))
  await prompt($)
  await clock.advance(9 * MIN)
  await prompt($)
  expect(checks(ran)).toBe(1)
  await clock.advance(2 * MIN)
  await prompt($)
  expect(checks(ran)).toBe(2)
})

test('a version announced at session start is not repeated', async ($, on) => {
  const clock = mock.clock(on)
  const { ran } = promptHost(on, noticeRun(JSON.stringify(NOTICE)))
  await $.classic.SessionStart({ source: 'startup', session_id: 's1' } as any)
  await clock.advance(11 * MIN)
  const result: any = await prompt($)
  expect(checks(ran)).toBe(2)
  expect(result.additionalContext).toBeUndefined()
})

test('after the cooldown lcu announces again: a session told nothing yet gets it once', async ($, on) => {
  const clock = mock.clock(on)
  let out = '{}'
  const { toasts } = promptHost(on, argv => (argv[1] === 'update' ? { stdout: out } : undefined))
  await $.classic.SessionStart({ source: 'startup', session_id: 's1' } as any)
  out = JSON.stringify(NOTICE)
  await clock.advance(11 * MIN)
  expect(((await prompt($)) as any).additionalContext).toEqual([NOTICE.message])
  expect(toasts.length).toBe(1)
  await clock.advance(11 * MIN)
  expect(((await prompt($)) as any).additionalContext).toBeUndefined()
  expect(toasts.length).toBe(1)
})

test('a newer version is announced once', async ($, on) => {
  const clock = mock.clock(on)
  let out = JSON.stringify(NOTICE)
  const { toasts } = promptHost(on, argv => (argv[1] === 'update' ? { stdout: out } : undefined))
  await $.classic.SessionStart({ source: 'startup', session_id: 's1' } as any)
  out = JSON.stringify(NEWER)
  await clock.advance(11 * MIN)
  const result: any = await prompt($)
  expect(result.additionalContext).toEqual([NEWER.message])
  expect(toasts.length).toBe(2)
  await clock.advance(11 * MIN)
  expect(((await prompt($)) as any).additionalContext).toBeUndefined()
})

test('sessions are independent', async ($, on) => {
  const { ran } = promptHost(on, noticeRun(JSON.stringify(NOTICE)))
  const a: any = await prompt($, 'a')
  const b: any = await prompt($, 'b')
  expect(checks(ran)).toBe(2)
  expect(a.additionalContext).toEqual([NOTICE.message])
  expect(b.additionalContext).toEqual([NOTICE.message])
})

test('a failing check on a prompt gives nothing and does not throw', async ($, on) => {
  const { toasts } = promptHost(on, () => { throw new Error('no processes') })
  const result: any = await prompt($)
  expect(result.additionalContext).toBeUndefined()
  expect(toasts).toEqual([])
})
