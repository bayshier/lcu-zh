export type LcuApproveApp = {
  name: string
  bundleId: string
  installed: boolean
  risk: string
  blocked: boolean
}

export type LcuApproveGrant = { name: string; bundleId: string; risk?: string }

export type LcuApproveNotice = { tone: 'ok' | 'error'; text: string }

// What the approved-apps panel draws from.
export type LcuApproveAppsState = {
  isLoaded: boolean
  always: LcuApproveApp[]
  session: LcuApproveGrant[]
  notice?: LcuApproveNotice
  busy?: string
  nonce: number
  unavailable?: string
}

declare module 'claude-code' {
  interface PluginState {
    'lcu-approve': { apps: LcuApproveAppsState }
  }
}
