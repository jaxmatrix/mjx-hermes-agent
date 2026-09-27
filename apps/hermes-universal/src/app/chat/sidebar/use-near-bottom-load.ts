/**
 * Near-bottom auto-page for a scrollport — pet gallery pattern, reusable for
 * the sessions sidebar. Fires `onLoadMore` once per "floor"; re-arms when
 * `loading` clears or `loadGeneration` advances so a deeper page can trigger
 * again (client windowing without a loading flag).
 */

import { useCallback, useEffect, useRef } from 'react'

const DEFAULT_THRESHOLD_PX = 120

export interface NearBottomLoadOptions {
  hasMore: boolean
  loading: boolean
  onLoadMore: () => void
  thresholdPx?: number
  /** Bump when a client-only window grows so the hook re-arms without `loading`. */
  loadGeneration?: number | string
}

/** Pure predicate for tests and non-React call sites. */
export function isNearScrollBottom(
  el: Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>,
  thresholdPx: number = DEFAULT_THRESHOLD_PX
): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - thresholdPx
}

export function useNearBottomLoad({
  hasMore,
  loading,
  onLoadMore,
  thresholdPx = DEFAULT_THRESHOLD_PX,
  loadGeneration
}: NearBottomLoadOptions): (event: { currentTarget: HTMLElement }) => void {
  const armedRef = useRef(true)
  const onLoadMoreRef = useRef(onLoadMore)
  onLoadMoreRef.current = onLoadMore

  useEffect(() => {
    if (!loading) {
      armedRef.current = true
    }
  }, [loading, loadGeneration])

  return useCallback(
    (event: { currentTarget: HTMLElement }) => {
      if (!hasMore || loading || !armedRef.current) {
        return
      }

      if (!isNearScrollBottom(event.currentTarget, thresholdPx)) {
        return
      }

      armedRef.current = false
      onLoadMoreRef.current()
    },
    [hasMore, loading, thresholdPx]
  )
}
