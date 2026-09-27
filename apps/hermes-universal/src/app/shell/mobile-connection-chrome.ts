/**
 * Chat top-bar connection chrome: orange while reconnecting after a live
 * session, green flash for 1s when the socket opens again.
 */

export type MobileConnectionChromeStatus = 'idle' | 'reconnecting' | 'reconnected'

export const RECONNECTED_FLASH_MS = 1000

/** Sync status from gateway facts (no flash timer). */
export function connectionChromeBase(input: {
  gatewayState: string
  hasConnected: boolean
}): Exclude<MobileConnectionChromeStatus, 'reconnected'> {
  if (input.hasConnected && input.gatewayState !== 'open') {
    return 'reconnecting'
  }

  return 'idle'
}

/**
 * Pure step for tests / reducers: given prior chrome status + new base,
 * return next status. `now`/`flashUntil` implement the 1s green flash.
 */
export function stepConnectionChrome(input: {
  base: Exclude<MobileConnectionChromeStatus, 'reconnected'>
  flashUntil: number | null
  now: number
  prevBase: Exclude<MobileConnectionChromeStatus, 'reconnected'>
}): { flashUntil: number | null; status: MobileConnectionChromeStatus } {
  if (input.base === 'reconnecting') {
    return { flashUntil: null, status: 'reconnecting' }
  }

  // Transition reconnecting → idle (socket open again): start green flash.
  if (input.prevBase === 'reconnecting') {
    return {
      flashUntil: input.now + RECONNECTED_FLASH_MS,
      status: 'reconnected'
    }
  }

  if (input.flashUntil != null && input.now < input.flashUntil) {
    return { flashUntil: input.flashUntil, status: 'reconnected' }
  }

  return { flashUntil: null, status: 'idle' }
}
