/**
 * Stable open primary gateway for projects.* unit tests.
 *
 * Production routes project RPCs through `activeGateway().request` (not
 * `requestGateway` from gateway-client). Tests that only stubbed the client
 * helper hit `Active Hermes profile changed while connecting`.
 */

import { atom } from 'nanostores'
import { vi } from 'vitest'

export function createOpenGatewayHarness(request: ReturnType<typeof vi.fn> = vi.fn()) {
  const gateway = { connectionState: 'open' as const, request }

  return {
    gateway,
    request,
    gatewayModule: {
      $gateway: atom(null),
      activeGateway: vi.fn(() => gateway),
      ensureActiveGatewayOpen: vi.fn(async () => gateway)
    }
  }
}
