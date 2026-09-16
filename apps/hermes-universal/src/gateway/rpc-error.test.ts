/**
 * What a rejected RPC carries, and why the accessor is structural.
 *
 * Universal swapped its vendored client for `@hermes/shared`'s (MJXHRM-530),
 * which rejects with `JsonRpcGatewayError` rather than the app's own
 * `GatewayRpcError`. Every "is this backend too old?" probe and every store that
 * branches on a numeric gateway code reads the code through
 * `gatewayRpcErrorCode`, so if that accessor narrowed on one class the swap
 * would have silently turned all 49 of those call sites into prose-matching —
 * a regression with no failing test and no visible symptom until a user hit a
 * degraded surface that never recovered.
 */

import { JsonRpcGatewayError } from '@hermes/shared'
import { describe, expect, it } from 'vitest'

import { GatewayRpcError, gatewayRpcErrorCode, JSON_RPC_METHOD_NOT_FOUND } from './rpc-error'

describe('gatewayRpcErrorCode', () => {
  // The rejection the TRANSPORT actually produces now. This is the case that
  // silently broke when the client was swapped.
  it('reads the code off the shared client’s error class', () => {
    const error = new JsonRpcGatewayError('unknown method: projects.list', { code: JSON_RPC_METHOD_NOT_FOUND })

    expect(gatewayRpcErrorCode(error)).toBe(JSON_RPC_METHOD_NOT_FOUND)
  })

  // The app's own class is still constructed by a dozen test files standing in
  // for a gateway rejection, so both have to stay legible to one accessor.
  it('reads the code off the app’s own error class', () => {
    expect(gatewayRpcErrorCode(new GatewayRpcError('session busy', 4009))).toBe(4009)
  })

  // null, NOT 0 — a caller reading this must be able to tell "the gateway did
  // not say" from any real code, or it answers questions it cannot answer.
  it('reports no code when the frame omitted one', () => {
    expect(gatewayRpcErrorCode(new JsonRpcGatewayError('boom'))).toBeNull()
    expect(gatewayRpcErrorCode(new GatewayRpcError('boom', null))).toBeNull()
  })

  it('reports no code for a rejection that never came off the wire', () => {
    expect(gatewayRpcErrorCode(new Error('socket closed'))).toBeNull()
    expect(gatewayRpcErrorCode('not an error')).toBeNull()
    expect(gatewayRpcErrorCode(null)).toBeNull()
  })

  /**
   * An aborted request rejects with a `DOMException`, which carries a LEGACY
   * numeric `code` of its own (`AbortError` is 20). A purely structural read
   * would report 20 as though the gateway had sent it — a code the gateway
   * cannot produce, handed to callers that branch on numbers.
   *
   * Asserted on the ABORT case specifically rather than "some DOMException",
   * because that is the one the channel actually throws (`json-rpc-channel.ts`
   * rejects with `new DOMException('Aborted', 'AbortError')`).
   */
  it('does not mistake an aborted request’s DOMException code for a gateway code', () => {
    const aborted = new DOMException('Aborted', 'AbortError')

    // Guard the premise: if the platform ever stopped putting a number here,
    // this test would pass for the wrong reason.
    expect(typeof (aborted as unknown as { code: unknown }).code).toBe('number')
    expect(gatewayRpcErrorCode(aborted)).toBeNull()
  })
})
