import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue({ delivered: 0, dropped: 0 }) }))
vi.mock('./notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('./windows', () => ({ openAppRoute: vi.fn(), ownsPersistedAppState: () => true }))
vi.mock('@/app/chat/composer/focus', () => ({
  requestComposerFocus: vi.fn(),
  requestComposerInsert: vi.fn()
}))

import { requestComposerInsert } from '@/app/chat/composer/focus'

import {
  __resetDeepLinkRoutes,
  type DeepLinkRoute,
  handleHermesDeepLinkUrl,
  navigateDeepLinkPath,
  registerDeepLinkRoute
} from './deep-link'
import { registerBuiltinDeepLinkRoutes } from './deep-link-builtins'
import { $mcpInstallRequest } from './mcp-deeplink-install'
import { notify, notifyError } from './notifications'
import { openAppRoute } from './windows'

beforeEach(() => {
  __resetDeepLinkRoutes()
  $mcpInstallRequest.set(null)
  vi.mocked(notify).mockClear()
  vi.mocked(notifyError).mockClear()
  vi.mocked(openAppRoute).mockClear()
  vi.mocked(requestComposerInsert).mockClear()
})

const route = (kind: string, name: string | undefined, seen: string[]): DeepLinkRoute => ({
  handle: () => {
    seen.push(`${kind}/${name ?? '*'}`)

    return true
  },
  kind,
  name
})

describe('the route registry', () => {
  it('prefers an exact (kind, name) over a kind wildcard over a total wildcard', () => {
    const seen: string[] = []
    registerDeepLinkRoute(route('*', undefined, seen))
    registerDeepLinkRoute(route('bot', undefined, seen))
    registerDeepLinkRoute(route('bot', 'room-1', seen))

    handleHermesDeepLinkUrl('hermes://bot/room-1')
    handleHermesDeepLinkUrl('hermes://bot/room-2')
    handleHermesDeepLinkUrl('hermes://unclaimed/thing')

    expect(seen).toEqual(['bot/room-1', 'bot/*', '*/*'])
  })

  it('falls through to the next candidate when a route declines', () => {
    const seen: string[] = []
    registerDeepLinkRoute({ handle: () => false, kind: 'bot', name: 'room-1' })
    registerDeepLinkRoute(route('bot', undefined, seen))

    expect(handleHermesDeepLinkUrl('hermes://bot/room-1')).toBe(true)
    expect(seen).toEqual(['bot/*'])
  })

  it('unregisters idempotently — a stale handle cannot unhook the live route', () => {
    const seen: string[] = []
    const disposeFirst = registerDeepLinkRoute({ handle: () => false, kind: 'bot' })

    // A re-registration replaces the entry; disposing the OLD handle afterwards
    // must be a no-op, not a removal of the new one.
    registerDeepLinkRoute(route('bot', undefined, seen))
    disposeFirst()

    expect(handleHermesDeepLinkUrl('hermes://bot/anything')).toBe(true)
    expect(seen).toEqual(['bot/*'])
  })

  it('removes its own route when disposed', () => {
    const dispose = registerDeepLinkRoute({ handle: () => true, kind: 'bot' })
    dispose()

    expect(handleHermesDeepLinkUrl('hermes://bot/anything')).toBe(false)
  })

  it('reports a duplicate claim instead of shadowing it silently', () => {
    registerDeepLinkRoute({ handle: () => true, kind: 'bot', name: 'x' })
    expect(notifyError).not.toHaveBeenCalled()

    registerDeepLinkRoute({ handle: () => true, kind: 'bot', name: 'x' })
    expect(notifyError).toHaveBeenCalledTimes(1)
  })

  it('returns false for a link nothing claims', () => {
    expect(handleHermesDeepLinkUrl('hermes://nobody/home')).toBe(false)
  })

  it('says nothing about a foreign scheme, and does say something about a broken hermes link', () => {
    expect(handleHermesDeepLinkUrl('cursor://x/mcp/install')).toBe(false)
    expect(handleHermesDeepLinkUrl('not a url')).toBe(false)
    expect(notify).not.toHaveBeenCalled()

    // An app EVENT name typed into a browser bar lands here.
    expect(handleHermesDeepLinkUrl('hermes://deep-link-open')).toBe(false)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }))
  })
})

describe('navigateDeepLinkPath', () => {
  it('navigates a reserved head, keeping the sub-path and the query', () => {
    expect(navigateDeepLinkPath('/settings/plugins?focus=install')).toBe(true)
    expect(openAppRoute).toHaveBeenCalledWith('/settings/plugins?focus=install')
  })

  // THE guard. Universal's session route is `/<id>` at the root, so an unknown
  // head is not a 404 — it is a hydrate attempt for a session by that name.
  it('refuses an unregistered head and does NOT call openAppRoute', () => {
    expect(navigateDeepLinkPath('/nope-not-a-route')).toBe(false)
    expect(openAppRoute).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning' }))
  })

  it('refuses an unsafe path before resolving anything', () => {
    expect(navigateDeepLinkPath('/a/..%2Fb')).toBe(false)
    expect(openAppRoute).not.toHaveBeenCalled()
  })

  it('routes an open/ deep link through the same guard', () => {
    expect(handleHermesDeepLinkUrl('hermes://open/skills?tab=mcp')).toBe(true)
    expect(openAppRoute).toHaveBeenCalledWith('/skills?tab=mcp')

    vi.mocked(openAppRoute).mockClear()

    expect(handleHermesDeepLinkUrl('hermes://open/nope-not-a-route')).toBe(false)
    expect(openAppRoute).not.toHaveBeenCalled()
  })
})

// ── moved from mcp-deeplink-install.test.ts (MJXHRM-454) ─────────────────────
// The same assertions, now running through the REGISTRY — which is what proves
// `mcp/install` is a registered route rather than a hardcoded special case.

describe('the built-in routes', () => {
  const config = { url: 'https://mcp.example.com/mcp' }
  const encoded = btoa(JSON.stringify(config))

  // The REAL registrations, through the real registry — so these cases prove
  // the wiring rather than a stand-in table written for the test.
  beforeEach(() => {
    registerBuiltinDeepLinkRoutes()
  })

  it('parks a valid MCP install link as a PENDING request — never an install', () => {
    expect(handleHermesDeepLinkUrl(`hermes://mcp/install?name=example&config=${encoded}`)).toBe(true)
    expect($mcpInstallRequest.get()).toEqual({ config, name: 'example', transport: 'http' })
    expect(notify).not.toHaveBeenCalled()
  })

  it('tolerates a trailing slash on the route', () => {
    expect(handleHermesDeepLinkUrl(`hermes://mcp/install/?name=example&config=${encoded}`)).toBe(true)
    expect($mcpInstallRequest.get()?.name).toBe('example')
  })

  // Fixtures that disagree: every one is a URL a real listener will see, and
  // none of them is an MCP install.
  it.each([
    'cursor://anysphere.cursor-deeplink/mcp/install?name=x&config=e30=',
    'https://mcp.example.com/mcp/install?name=x',
    'hermes://mcp/uninstall?name=x',
    'hermes://mcp?name=x'
  ])('ignores %s', url => {
    expect(handleHermesDeepLinkUrl(url)).toBe(false)
    expect($mcpInstallRequest.get()).toBeNull()
  })

  it('consumes the link but toasts — and parks nothing — when the payload is rejected', () => {
    expect(handleHermesDeepLinkUrl('hermes://mcp/install?name=../etc/passwd&config=e30=')).toBe(true)
    expect($mcpInstallRequest.get()).toBeNull()
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }))
  })

  it('inserts a blueprint command into the composer WITHOUT submitting it', () => {
    expect(handleHermesDeepLinkUrl('hermes://blueprint/ship-it?repo=hermes&note=two%20words')).toBe(true)
    expect(requestComposerInsert).toHaveBeenCalledWith('/blueprint ship-it repo=hermes note="two words"', {
      mode: 'block',
      target: 'main'
    })
  })
})
