import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))
vi.mock('./notifications', () => ({ notify: vi.fn() }))

import { $mcpInstallRequest, handleHermesDeepLinkUrl, requestMcpInstallFromDeepLink } from './mcp-deeplink-install'
import { notify } from './notifications'

const config = { url: 'https://mcp.example.com/mcp' }
const encoded = btoa(JSON.stringify(config))
const link = (query: string) => `hermes://mcp/install?${query}`

beforeEach(() => {
  $mcpInstallRequest.set(null)
  vi.mocked(notify).mockClear()
})

describe('handleHermesDeepLinkUrl', () => {
  it('parks a valid install link as a PENDING request — never an install', () => {
    expect(handleHermesDeepLinkUrl(link(`name=example&config=${encoded}`))).toBe(true)
    expect($mcpInstallRequest.get()).toEqual({ name: 'example', config, transport: 'http' })
    expect(notify).not.toHaveBeenCalled()
  })

  // Fixtures that disagree: every one of these is a URL a real listener will
  // see, and none of them is ours. Consuming any would mean a foreign scheme
  // (or another app's route) could open the install dialog.
  it.each([
    'cursor://anysphere.cursor-deeplink/mcp/install?name=x&config=e30=',
    'https://mcp.example.com/mcp/install?name=x',
    'hermes://plugin/install?repo=owner/repo',
    'hermes://mcp/uninstall?name=x',
    'hermes://mcp?name=x',
    'not a url at all'
  ])('ignores %s', url => {
    expect(handleHermesDeepLinkUrl(url)).toBe(false)
    expect($mcpInstallRequest.get()).toBeNull()
    expect(notify).not.toHaveBeenCalled()
  })

  it('tolerates a trailing slash on the route', () => {
    expect(handleHermesDeepLinkUrl(`hermes://mcp/install/?name=example&config=${encoded}`)).toBe(true)
    expect($mcpInstallRequest.get()?.name).toBe('example')
  })

  it('consumes the link but toasts — and parks nothing — when the payload is rejected', () => {
    expect(handleHermesDeepLinkUrl(link('name=../etc/passwd&config=e30='))).toBe(true)
    expect($mcpInstallRequest.get()).toBeNull()
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }))
  })
})

describe('requestMcpInstallFromDeepLink', () => {
  it('rejects a stdio+url ambiguous config rather than showing only the url', () => {
    const ambiguous = btoa(JSON.stringify({ url: 'https://x.example/mcp', command: 'curl' }))
    requestMcpInstallFromDeepLink({ name: 'sneaky', config: ambiguous })

    expect($mcpInstallRequest.get()).toBeNull()
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }))
  })

  it('flags a command-only config as stdio so the dialog can warn', () => {
    requestMcpInstallFromDeepLink({ name: 'fs', config: btoa(JSON.stringify({ command: 'npx' })) })

    expect($mcpInstallRequest.get()?.transport).toBe('stdio')
  })
})
