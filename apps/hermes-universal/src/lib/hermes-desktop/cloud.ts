/**
 * `hermesDesktop.cloud`: Hermes Cloud's portal sign-in, agent discovery and the
 * silent per-agent sign-in, over Rust's `portal_*` commands (`src-tauri/src/
 * cloud.rs`). The portal session lives in Rust's portal webview and the agent
 * session in its cookie jar; neither crosses into this page.
 *
 * Electron marks "the portal session is gone" by tagging the error
 * (`needsCloudLogin`), and desktop's panel flips back to signed-out on it. Rust
 * answers discovery with `needsLogin` instead, so that answer becomes the tagged
 * error here. Every other failure is Rust's text, which can quote an address,
 * and is replaced by desktop's own copy for the step.
 */

import type { DesktopCloudAgent, DesktopCloudOrg } from '@/global'
import { ownWords } from '@/lib/error-text'
import { IS_NATIVE_MOBILE } from '@/lib/platform'

import { settingsCopy } from './registry'

type Bridge = NonNullable<typeof window.hermesDesktop>

interface PortalStatus {
  portalBaseUrl: string
  signedIn: boolean
}

interface PortalOrg {
  id: string
  isPersonal: boolean
  name: string
  role: string
  slug?: null | string
}

interface PortalDiscovery {
  agents: (Omit<DesktopCloudAgent, 'dashboardUrl'> & { dashboardUrl?: null | string })[]
  needsLogin: boolean
  needsOrgSelection: boolean
  org?: null | PortalOrg
  orgs: PortalOrg[]
}

async function portal<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

/** Universal's own cloud panel reads this atom; keep it true to what Rust said. */
async function publishSignedIn(signedIn: boolean): Promise<void> {
  // Dynamic: the cloud store reaches `@/hermes`.
  const { $portalSignedIn } = await import('@/store/cloud')

  $portalSignedIn.set(signedIn)
}

function needsCloudLogin(): Error {
  return Object.assign(new Error(settingsCopy().gateway.cloudNeedsSignIn), { needsCloudLogin: true })
}

const org = (value: PortalOrg): DesktopCloudOrg => ({ ...value, slug: value.slug ?? null })

export const cloudBridge: Pick<Bridge, 'cloud'> = {
  cloud: {
    status: () => portal<PortalStatus>('portal_status'),

    login: async () => {
      // On a phone Rust navigates THIS webview to the portal and back, which ends
      // this page: the marker is what reopens the cloud panel after the reload
      // (`store/cloud.ts`, `resumePortalSignIn`). The call may never return.
      if (IS_NATIVE_MOBILE) {
        const { savePendingPortal } = await import('@/store/gateway-restore')

        savePendingPortal()
      }

      const status = await portal<PortalStatus>('portal_login').catch(error => {
        throw ownWords(error, settingsCopy().gateway.cloudSignInFailed)
      })

      await publishSignedIn(status.signedIn)

      return { ...status, ok: true }
    },

    logout: async () => {
      await portal<void>('portal_logout').catch(error => {
        throw ownWords(error, settingsCopy().gateway.signOutFailed)
      })

      const status = await portal<PortalStatus>('portal_status')

      await publishSignedIn(status.signedIn)

      return { ...status, ok: true }
    },

    discover: async scope => {
      const found = await portal<PortalDiscovery>('portal_discover_agents', {
        org: typeof scope === 'string' && scope ? scope : null
      }).catch(error => {
        throw ownWords(error, settingsCopy().gateway.cloudDiscoverFailed)
      })

      if (found.needsLogin) {
        await publishSignedIn(false)

        throw needsCloudLogin()
      }

      if (found.needsOrgSelection) {
        return { needsOrgSelection: true, orgs: found.orgs.map(org) }
      }

      return {
        agents: found.agents.map(agent => ({ ...agent, dashboardUrl: agent.dashboardUrl ?? null })),
        org: found.org ? org(found.org) : null
      }
    },

    agentSignIn: async dashboardUrl => {
      // Electron checks first: without a portal session the cascade would stop on
      // a prompt nobody can see.
      if (!(await portal<PortalStatus>('portal_status')).signedIn) {
        await publishSignedIn(false)

        throw needsCloudLogin()
      }

      const { portalAgentSignIn } = await import('@/lib/auth')

      const result = await portalAgentSignIn(String(dashboardUrl ?? '')).catch(error => {
        throw ownWords(error, settingsCopy().gateway.cloudConnectFailed)
      })

      return { baseUrl: result.baseUrl, connected: result.connected === true }
    }
  }
}
