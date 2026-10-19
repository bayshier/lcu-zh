// What the panes draw. Pure functions of their data, so no side effect can sit in a render closure:
// every Button's press is handled by the `ui.press` hook of the mod that draws them.
import { plainWarning } from './data'
import type { AppRow, SessionRow } from './data'

export const KEY_PREFIX = 'lcu-approve:'
export const APPS_PREFIX = `${KEY_PREFIX}apps:`
export const LABEL_SESSION = 'Allow this conversation'
export const LABEL_ALWAYS = 'Always allow'
export const LABEL_DENY = 'Deny'

export type Approval = {
  id: string
  message: string
  app: string
  label: string
  scopes: string[]
  riskLevel: string
  warning?: string
}

export type Notice = { tone: 'ok' | 'error'; text: string }

export type AppsState = {
  isLoaded: boolean
  always: AppRow[]
  session: SessionRow[]
  notice?: Notice
  busy?: string
  nonce: number
  unavailable?: string
}

export const INITIAL_APPS: AppsState = { isLoaded: false, always: [], session: [], nonce: 0 }

const noop = () => {}

// A pane's body rows: the request, and what the panel lists. Past the cap the pane scrolls.
export const approvalRows = (approval: Approval) => (approval.riskLevel === 'high' ? 11 : 8)
export const APPS_MAX_ROWS = 26
export const appsRows = (state: AppsState) => {
  const kept = state.always.filter(app => app.installed).length
  const gone = state.always.length - kept
  const listed = 11 + kept + (gone ? 2 + gone : 0) + Math.max(1, state.session.length) + (state.notice || state.busy ? 1 : 0)
  return Math.min(APPS_MAX_ROWS, listed)
}

const esc = (text: string) => text.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)

// The app's icon: the picture itself on a terminal that draws images, a tile with the app's initial and
// the picture over it on the app; nothing where no picture could be made.
function Icon({ ui, surface, name, icon }: { ui: any; surface: string; name: string; icon?: string }) {
  if (surface === 'terminal') {
    const { Image } = ui
    return icon ? <Image source={{ png: icon }} columns={6} rows={3} alt=" " /> : null
  }
  const { Svg } = ui
  const initial = esc([...name.trim()][0]?.toUpperCase() ?? '?')
  const picture = icon
    ? `<image href="data:image/png;base64,${icon}" xlink:href="data:image/png;base64,${icon}" x="0" y="0" width="48" height="48"/>`
    : ''
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 48 48" width="48" height="48">' +
    '<rect width="48" height="48" rx="11" fill="#8a8a8a" fill-opacity="0.28"/>' +
    `<text x="24" y="32" font-size="22" font-family="sans-serif" text-anchor="middle" fill="#8a8a8a">${initial}</text>${picture}</svg>`
  return <Svg source={source} alt={`${name} icon`} width={48} height={48} />
}

function AppTitle({ ui, name, bundleId }: { ui: any; name: string; bundleId: string }) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold>{name}</Text>
      {bundleId !== name && <Text dimColor>{bundleId}</Text>}
    </Box>
  )
}

const RiskBadge = ({ ui }: { ui: any }) => {
  const { Text } = ui
  return <Text bold inverse color="yellow"> High risk </Text>
}

// The approval request: the app, one sentence, the risk when high, the choices.
export function ApprovalView({ ui, surface, approval, icon, graphics = true }: { ui: any; surface: string; approval: Approval; icon?: string; graphics?: boolean }) {
  const { Box, Text, Button } = ui
  const isHigh = approval.riskLevel === 'high'
  // A terminal that cannot draw the picture gets no icon cell, so the name starts at the pane's edge.
  const shownIcon = surface === 'terminal' && !graphics ? undefined : icon
  const key = (choice: string) => `${KEY_PREFIX}${approval.id}:${choice}`
  return (
    <Box flexDirection="column" gap={1} paddingY={surface === 'terminal' ? 0 : 1}>
      <Box flexDirection="row" gap={surface === 'terminal' && !shownIcon ? 0 : 2} alignItems="center">
        <Icon ui={ui} surface={surface} name={approval.label} icon={shownIcon} />
        <AppTitle ui={ui} name={approval.label} bundleId={approval.app} />
      </Box>
      <Text>{`Computer use will be able to see and control ${approval.label}.`}</Text>
      {isHigh && (
        <Box flexDirection="column">
          <RiskBadge ui={ui} />
          {approval.warning && <Text color="yellow">{plainWarning(approval.warning)}</Text>}
        </Box>
      )}
      <Box flexDirection="row" gap={1}>
        <Button key={key('session')} variant="primary" autoFocus hotkey="a" onPress={noop}>
          {LABEL_SESSION}
        </Button>
        {approval.scopes.includes('always') && (
          <Button key={key('always')} variant="secondary" hotkey="l" onPress={noop}>
            {LABEL_ALWAYS}
          </Button>
        )}
        <Button key={key('deny')} role="dismiss" hotkey="d" onPress={noop}>
          {LABEL_DENY}
        </Button>
      </Box>
    </Box>
  )
}

// One line per app: name, the dim bundle id, the badges, Revoke at the right.
function AppRowView({ ui, name, bundleId, children }: { ui: any; name: string; bundleId: string; children: any }) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="row" gap={2} alignItems="center">
      <Box flexShrink={0}>
        <Text bold>{name}</Text>
      </Box>
      {bundleId !== name && (
        <Box flexShrink={1}>
          <Text dimColor wrap="truncate-end">{bundleId}</Text>
        </Box>
      )}
      <Box flexGrow={1} />
      {children}
    </Box>
  )
}

// The approved apps: the always-allowed list with Revoke, this conversation's grants, an Allow field.
// The pane's body scrolls when it is taller than the pane.
export function AppsView({ ui, state }: { ui: any; state: AppsState }) {
  const { Box, Text, Button, Input } = ui
  const busy = Boolean(state.busy)
  const present = state.always.filter(app => app.installed)
  const missing = state.always.filter(app => !app.installed)
  const row = (app: AppRow) => (
    <AppRowView key={app.bundleId} ui={ui} name={app.name} bundleId={app.bundleId}>
      {app.risk === 'high' && <RiskBadge ui={ui} />}
      {app.blocked && <Text color="red">Blocked by Computer use</Text>}
      <Button key={`${APPS_PREFIX}revoke:${app.bundleId}`} onPress={noop}>Revoke</Button>
    </AppRowView>
  )
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>Approved apps</Text>
        <Box flexDirection="row" gap={2} alignItems="center">
          <Box flexGrow={1}>
            <Text dimColor>Computer use can control these apps without asking.</Text>
          </Box>
          <Button key={`${APPS_PREFIX}refresh`} onPress={noop}>Refresh</Button>
        </Box>
      </Box>
      {state.unavailable ? (
        <Text color="yellow">{state.unavailable}</Text>
      ) : !state.isLoaded ? (
        <Text dimColor>Loading...</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text bold dimColor>{`Always allowed (${present.length})`}</Text>
            {present.length === 0 && <Text dimColor>None. Allow one below.</Text>}
            {present.map(row)}
          </Box>
          {missing.length > 0 && (
            <Box flexDirection="column">
              <Text bold dimColor>{`Not installed (${missing.length})`}</Text>
              {missing.map(row)}
            </Box>
          )}
          <Box flexDirection="column">
            <Text bold dimColor>{`This conversation (${state.session.length})`}</Text>
            {state.session.length === 0 && <Text dimColor>None.</Text>}
            {state.session.map(app => (
              <AppRowView key={app.bundleId} ui={ui} name={app.name} bundleId={app.bundleId}>
                {app.risk === 'high' && <RiskBadge ui={ui} />}
                <Text dimColor>Ends with this conversation</Text>
              </AppRowView>
            ))}
          </Box>
          <Input
            key={`${APPS_PREFIX}allow:${state.nonce}`}
            label="Allow an app"
            placeholder="App name, bundle id or path"
            submitLabel="allow"
            onSubmit={noop}
          />
        </Box>
      )}
      {(state.busy || state.notice) && (
        <Text color={state.busy ? undefined : state.notice?.tone === 'error' ? 'red' : 'green'} dimColor={busy}>
          {state.busy ?? state.notice?.text}
        </Text>
      )}
    </Box>
  )
}
