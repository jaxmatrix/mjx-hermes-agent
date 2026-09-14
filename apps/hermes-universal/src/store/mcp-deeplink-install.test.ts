import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./notifications', () => ({ notify: vi.fn() }))

import { $mcpInstallRequest, requestMcpInstallFromDeepLink } from './mcp-deeplink-install'
import { notify } from './notifications'


beforeEach(() => {
  $mcpInstallRequest.set(null)
  vi.mocked(notify).mockClear()
})

// The deep-link ROUTING cases live in `deep-link.test.ts` now: `mcp/install` is
// a registered route on the shared registry (MJXHRM-455), so asserting it there
// proves the wiring rather than a special case. What stays here is the payload
// validation, which is this module's own job.

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
