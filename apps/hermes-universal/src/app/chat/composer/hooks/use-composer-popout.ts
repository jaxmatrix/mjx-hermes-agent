import { type RefObject, useCallback, useEffect } from 'react'

import { IS_DESKTOP } from '@/lib/platform'
import { useStore } from '@/store/atom'
import {
  $composerPopoutPosition,
  $composerPoppedOut,
  readPopoutBounds,
  setComposerPopoutPosition,
  setComposerPoppedOut
} from '@/store/composer-popout'
import { triggerHaptic } from '@/store/haptics'

import { useComposerPopoutGestures } from './use-popout-drag'

interface UseComposerPopoutOptions {
  composerRef: RefObject<HTMLFormElement | null>
}

/**
 * Pop-out engine: the docked↔floating state (a shared, persisted atom), the
 * dock/float/toggle actions, the drag gestures, and the on-screen re-clamp.
 *
 * Ported from desktop, simplified: universal is a single window with a single
 * composer, so the secondary-window / multi-composer-scope guards are dropped
 * (`popoutAllowed` is always true).
 */
export function useComposerPopout({ composerRef }: UseComposerPopoutOptions) {
  // Desktop-only: a floating composer + peel-up gesture make no sense on a phone
  // (they'd fight touch scroll / typing), so mobile keeps the docked composer.
  const popoutAllowed = IS_DESKTOP
  const poppedOut = useStore($composerPoppedOut) && popoutAllowed
  const popoutPosition = useStore($composerPopoutPosition)

  const handleComposerPopOut = useCallback(() => {
    void triggerHaptic('select')
    setComposerPoppedOut(true)
  }, [])

  const handleComposerDock = useCallback(() => {
    void triggerHaptic('success')
    setComposerPoppedOut(false)
  }, [])

  // Double-click the grab area toggles dock/float. Undocking restores the last
  // position (the persisted atom is never cleared on dock).
  const handleComposerToggle = useCallback(() => {
    poppedOut ? handleComposerDock() : handleComposerPopOut()
  }, [handleComposerDock, handleComposerPopOut, poppedOut])

  const {
    dockProximity,
    dragging,
    onPointerDown: onComposerGesturePointerDown
  } = useComposerPopoutGestures({
    composerRef,
    onDock: handleComposerDock,
    onPopOut: handleComposerPopOut,
    poppedOut,
    position: popoutPosition
  })

  // Keep the floating box on-screen: re-clamp with the real measured size when it
  // pops out and on every window resize — so a position persisted on a bigger
  // window, or a now-shrunk window, can never strand it.
  useEffect(() => {
    if (!poppedOut) {
      return undefined
    }

    const reclamp = (persist: boolean) => {
      const el = composerRef.current
      const size = el ? { height: el.offsetHeight, width: el.offsetWidth } : undefined
      setComposerPopoutPosition($composerPopoutPosition.get(), { area: readPopoutBounds(el), persist, size })
    }

    reclamp(true)
    const raf = requestAnimationFrame(() => reclamp(true))
    const onResize = () => reclamp(false)
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [composerRef, poppedOut])

  return {
    dockProximity,
    dragging,
    handleComposerToggle,
    onComposerGesturePointerDown,
    popoutAllowed,
    popoutPosition,
    poppedOut
  }
}
