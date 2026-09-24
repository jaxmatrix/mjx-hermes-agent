/**
 * Pause the wake-word listener while voice chat holds the mic. Desktop keeps this
 * logic inside `use-composer-voice`; universal voice surfaces import from here.
 */

import { requestGateway } from '@/store/gateway-client'
import { resumeWakeAfterVoice } from '@/store/wake-word'

let wakePaused = false
let wakePauseBarrier: Promise<void> | null = null

export async function pauseWakeForVoice(): Promise<void> {
  wakePaused = true

  const barrier = (async () => {
    try {
      await requestGateway('wake.pause', {})
    } catch {
      // No wake listener / older backend — nothing held the mic.
    }
  })()

  wakePauseBarrier = barrier

  return barrier
}

export function resumeWakeIfPaused(): void {
  if (!wakePaused) {
    return
  }

  wakePaused = false
  wakePauseBarrier = null
  void resumeWakeAfterVoice()
}
