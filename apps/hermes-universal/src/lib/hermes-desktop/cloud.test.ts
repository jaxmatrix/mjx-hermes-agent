import { beforeEach, describe, expect, it, vi } from 'vitest'

// `hermesDesktop.cloud` over Rust's `portal_*`: desktop's result shapes, its
// `needsCloudLogin` tag, the phone's one-way door, and no Rust text in an error.

const rust = vi.hoisted(() => ({
  answers: {} as Record<string, unknown>,
  calls: [] as [string, unknown][]
}))

const mobile = vi.hoisted(() => ({ native: false }))
const savePendingPortal = vi.hoisted(() => vi.fn())
const signedIn = vi.hoisted(() => ({ set: vi.fn() }))
const portalAgentSignIn = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => {
    rust.calls.push([command, args])

    const answer = rust.answers[command]

    if (answer instanceof Error || typeof answer === 'string') {
      throw answer
    }

    return answer
  })
}))
vi.mock('@/lib/platform', () => ({
  get IS_NATIVE_MOBILE() {
    return mobile.native
  }
}))
vi.mock('@/store/gateway-restore', () => ({ savePendingPortal }))
vi.mock('@/store/cloud', () => ({ $portalSignedIn: signedIn }))
vi.mock('@/lib/auth', () => ({ portalAgentSignIn }))

import { cloudBridge } from './cloud'

const { cloud } = cloudBridge

const STATUS = { portalBaseUrl: 'https://portal.test', signedIn: true }

beforeEach(() => {
  vi.clearAllMocks()
  rust.answers = { portal_login: STATUS, portal_logout: undefined, portal_status: STATUS }
  rust.calls = []
  mobile.native = false
})

describe('cloud.status / login / logout', () => {
  it('answers the portal session as Rust holds it', async () => {
    expect(await cloud.status()).toEqual(STATUS)
  })

  it('signs in, and keeps universal’s own cloud panel true to it', async () => {
    expect(await cloud.login()).toEqual({ ...STATUS, ok: true })
    expect(signedIn.set).toHaveBeenCalledExactlyOnceWith(true)
    expect(savePendingPortal).not.toHaveBeenCalled()
  })

  it('parks the resume marker first on a phone, where the login page ends this one', async () => {
    mobile.native = true
    rust.answers.portal_login = new Promise(() => {})

    void cloud.login()

    await vi.waitFor(() => expect(rust.calls.map(([command]) => command)).toEqual(['portal_login']))
    expect(savePendingPortal).toHaveBeenCalledOnce()
  })

  it('reports a failed sign-in in desktop’s words, not Rust’s', async () => {
    rust.answers.portal_login = 'bad portal URL: https://portal.test/login'

    await expect(cloud.login()).rejects.toThrow(/^(?!.*portal\.test)/)
  })

  it('signs out and reports what the portal now says', async () => {
    rust.answers.portal_status = { ...STATUS, signedIn: false }

    expect(await cloud.logout()).toEqual({ ok: true, portalBaseUrl: 'https://portal.test', signedIn: false })
    expect(rust.calls.map(([command]) => command)).toEqual(['portal_logout', 'portal_status'])
    expect(signedIn.set).toHaveBeenCalledExactlyOnceWith(false)
  })
})

describe('cloud.discover', () => {
  const agent = { dashboardGatewayState: 'active', id: 'a1', name: 'Atlas', status: 'running' }
  const org = { id: 'o1', isPersonal: false, name: 'Acme', role: 'OWNER' }

  it('lists agents with the org Rust resolved, in desktop’s shape', async () => {
    rust.answers.portal_discover_agents = {
      agents: [agent],
      needsLogin: false,
      needsOrgSelection: false,
      org,
      orgs: []
    }

    expect(await cloud.discover('acme')).toEqual({
      agents: [{ ...agent, dashboardUrl: null }],
      org: { ...org, slug: null }
    })
    expect(rust.calls).toEqual([['portal_discover_agents', { org: 'acme' }]])
  })

  it('asks for an org when the account has several', async () => {
    rust.answers.portal_discover_agents = { agents: [], needsLogin: false, needsOrgSelection: true, orgs: [org] }

    expect(await cloud.discover()).toEqual({ needsOrgSelection: true, orgs: [{ ...org, slug: null }] })
    expect(rust.calls).toEqual([['portal_discover_agents', { org: null }]])
  })

  it('tags a lapsed portal session the way desktop’s panel looks for', async () => {
    rust.answers.portal_discover_agents = { agents: [], needsLogin: true, needsOrgSelection: false, orgs: [] }

    const lapsed = await cloud.discover().catch(error => error)

    expect(lapsed).toBeInstanceOf(Error)
    expect('needsCloudLogin' in lapsed).toBe(true)
    expect(signedIn.set).toHaveBeenCalledExactlyOnceWith(false)
  })
})

describe('cloud.agentSignIn', () => {
  it('runs the silent per-agent sign-in and answers where its session landed', async () => {
    portalAgentSignIn.mockResolvedValueOnce({ baseUrl: 'https://atlas.cloud.test', connected: true })

    expect(await cloud.agentSignIn('https://atlas.cloud.test/')).toEqual({
      baseUrl: 'https://atlas.cloud.test',
      connected: true
    })
  })

  it('does not start a cascade nobody can see without a portal session', async () => {
    rust.answers.portal_status = { ...STATUS, signedIn: false }

    const lapsed = await cloud.agentSignIn('https://atlas.cloud.test').catch(error => error)

    expect('needsCloudLogin' in lapsed).toBe(true)
    expect(portalAgentSignIn).not.toHaveBeenCalled()
  })

  it('never quotes the agent’s address in a failure', async () => {
    portalAgentSignIn.mockRejectedValueOnce('agent auth/login failed: https://atlas.cloud.test/auth/login')

    const failed = await cloud.agentSignIn('https://atlas.cloud.test').catch(error => error)

    expect(failed.message).not.toContain('atlas.cloud.test')
  })
})
