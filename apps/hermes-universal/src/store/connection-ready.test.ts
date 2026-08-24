import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({ getStatus: vi.fn(), setApiRequestProfile: vi.fn() }))

import { $connection, $connectionPhase, $hasConnected } from './connection'
import { $connectionReady } from './connection-ready'
import { $gatewayState } from './gateway'
import { $restoring } from './gateway-restore'
import { $gatewaySwitching } from './gateway-switch'

const CONNECTION = { baseUrl: 'https://gw.test', mode: 'remote' } as never

/** Every flag in the state that means "usable". Each case below moves ONE. */
function makeReady() {
  $connection.set(CONNECTION)
  $connectionPhase.set('ready')
  $gatewayState.set('open')
  $hasConnected.set(true)
  $gatewaySwitching.set(false)
  $restoring.set(false)
}

beforeEach(makeReady)

describe('$connectionReady', () => {
  it('is true only when all six agree', () => {
    expect($connectionReady.get()).toBe(true)
  })

  // Rule 12 forbids a seventh FLAG, not a derivation — and the point of the
  // derivation is that no single one of these can be dropped from it.
  it.each([
    ['no connection', () => $connection.set(null)],
    ['the probe has not settled', () => $connectionPhase.set('probing')],
    ['the socket is not open', () => $gatewayState.set('connecting')],
    ['nothing has connected this session', () => $hasConnected.set(false)],
    ['a gateway switch is in flight', () => $gatewaySwitching.set(true)],
    ['the boot restore has not finished', () => $restoring.set(true)]
  ])('is false when %s', (_label, break_) => {
    break_()

    expect($connectionReady.get()).toBe(false)
  })

  it('recomputes rather than latching, so a reconnect turns it back on', () => {
    $gatewayState.set('closed')
    expect($connectionReady.get()).toBe(false)

    $gatewayState.set('open')
    expect($connectionReady.get()).toBe(true)
  })
})
