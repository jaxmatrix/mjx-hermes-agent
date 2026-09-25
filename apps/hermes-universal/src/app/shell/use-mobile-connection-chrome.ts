import { useEffect, useRef, useState } from 'react'

import { useStore } from '@/store/atom'
import { $hasConnected } from '@/store/connection'
import { $gatewayState } from '@/store/session'

import {
  connectionChromeBase,
  RECONNECTED_FLASH_MS,
  type MobileConnectionChromeStatus
} from './mobile-connection-chrome'

/**
 * Live connection chrome status for the phone chat top bar.
 * Orange while reconnecting after hasConnected; green for 1s on recovery.
 */
export function useMobileConnectionChrome(): MobileConnectionChromeStatus {
  const gatewayState = useStore($gatewayState)
  const hasConnected = useStore($hasConnected)
  const base = connectionChromeBase({ gatewayState, hasConnected })
  const wasReconnecting = useRef(false)
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    if (base === 'reconnecting') {
      wasReconnecting.current = true
      setFlash(false)

      return
    }

    if (!wasReconnecting.current) {
      return
    }

    wasReconnecting.current = false
    setFlash(true)
    const id = window.setTimeout(() => setFlash(false), RECONNECTED_FLASH_MS)

    return () => window.clearTimeout(id)
  }, [base])

  if (base === 'reconnecting') {
    return 'reconnecting'
  }

  if (flash) {
    return 'reconnected'
  }

  return 'idle'
}
