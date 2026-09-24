/**
 * `hermesDesktop.introReveal` — first-run film overlay.
 *
 * Electron SoT: `intro-reveal-window.ts`. Rust: `intro_reveal.rs`
 * (`sat-intro` + `hermes://intro-reveal-*` events).
 */

import { IS_DESKTOP } from '@/lib/platform'

type Bridge = NonNullable<typeof window.hermesDesktop>
type IntroReveal = NonNullable<Bridge['introReveal']>

const coreApi = () => import('@tauri-apps/api/core')
const eventApi = () => import('@tauri-apps/api/event')

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await coreApi()

  return invoke<T>(command, args)
}

const open: IntroReveal['open'] = async payload => {
  try {
    return await invokeNative<{ ok: boolean }>('intro_reveal_open', {
      payload: payload ?? null
    })
  } catch {
    return { ok: false }
  }
}

const close: IntroReveal['close'] = async payload => {
  try {
    return await invokeNative<{ ok: boolean }>('intro_reveal_close', {
      payload: payload ?? null
    })
  } catch {
    return { ok: false }
  }
}

const skip: IntroReveal['skip'] = () => {
  void invokeNative('intro_reveal_skip', {}).catch(() => undefined)
}

const ready: IntroReveal['ready'] = () => {
  void invokeNative('intro_reveal_ready', {}).catch(() => undefined)
}

function listenEvent(event: string, callback: () => void): () => void {
  let stop: (() => void) | undefined
  let cancelled = false

  void eventApi()
    .then(({ listen }) => {
      if (cancelled) {
        return undefined
      }

      return listen(event, () => callback())
    })
    .then(unlisten => {
      if (!unlisten) {
        return
      }

      if (cancelled) {
        unlisten()
      } else {
        stop = unlisten
      }
    })
    .catch(() => undefined)

  return () => {
    cancelled = true
    stop?.()
  }
}

const onSkip: IntroReveal['onSkip'] = callback => listenEvent('hermes://intro-reveal-skip', callback)

const onClosed: IntroReveal['onClosed'] = callback => listenEvent('hermes://intro-reveal-closed', callback)

export const introRevealBridge: Pick<Bridge, 'introReveal'> | Record<string, never> = IS_DESKTOP
  ? {
      introReveal: { open, close, skip, ready, onSkip, onClosed }
    }
  : {}
