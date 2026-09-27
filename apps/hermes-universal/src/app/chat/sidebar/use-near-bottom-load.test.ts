import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { isNearScrollBottom, useNearBottomLoad } from './use-near-bottom-load'

function el(over: Partial<{ clientHeight: number; scrollHeight: number; scrollTop: number }> = {}) {
  return { clientHeight: 400, scrollHeight: 1000, scrollTop: 0, ...over }
}

describe('isNearScrollBottom', () => {
  it('is false when far from the bottom', () => {
    expect(isNearScrollBottom(el({ scrollTop: 100 }))).toBe(false)
  })

  it('is true within the default 120px threshold', () => {
    // 400 + 480 = 880; 1000 - 120 = 880
    expect(isNearScrollBottom(el({ scrollTop: 480 }))).toBe(true)
  })

  it('respects a custom threshold', () => {
    expect(isNearScrollBottom(el({ scrollTop: 500 }), 50)).toBe(false)
    expect(isNearScrollBottom(el({ scrollTop: 560 }), 50)).toBe(true)
  })
})

describe('useNearBottomLoad', () => {
  it('fires once per arm; loadGeneration re-arms client windowing', () => {
    const onLoadMore = vi.fn()
    const { result, rerender } = renderHook(
      ({ gen }: { gen: number }) =>
        useNearBottomLoad({ hasMore: true, loadGeneration: gen, loading: false, onLoadMore }),
      { initialProps: { gen: 0 } }
    )

    act(() => {
      result.current({ currentTarget: el({ scrollTop: 500 }) as HTMLElement })
    })
    expect(onLoadMore).toHaveBeenCalledTimes(1)

    act(() => {
      result.current({ currentTarget: el({ scrollTop: 500 }) as HTMLElement })
    })
    expect(onLoadMore).toHaveBeenCalledTimes(1)

    rerender({ gen: 1 })

    act(() => {
      result.current({ currentTarget: el({ scrollTop: 500 }) as HTMLElement })
    })
    expect(onLoadMore).toHaveBeenCalledTimes(2)
  })

  it('does not fire when loading or when there is nothing more', () => {
    const onLoadMore = vi.fn()
    const loading = renderHook(() => useNearBottomLoad({ hasMore: true, loading: true, onLoadMore }))
    const done = renderHook(() => useNearBottomLoad({ hasMore: false, loading: false, onLoadMore }))

    act(() => {
      loading.result.current({ currentTarget: el({ scrollTop: 900 }) as HTMLElement })
      done.result.current({ currentTarget: el({ scrollTop: 900 }) as HTMLElement })
    })

    expect(onLoadMore).not.toHaveBeenCalled()
  })

  it('re-arms after loading clears', () => {
    const onLoadMore = vi.fn()
    const { result, rerender } = renderHook(
      ({ loading }: { loading: boolean }) => useNearBottomLoad({ hasMore: true, loading, onLoadMore }),
      { initialProps: { loading: false } }
    )

    act(() => {
      result.current({ currentTarget: el({ scrollTop: 500 }) as HTMLElement })
    })
    expect(onLoadMore).toHaveBeenCalledTimes(1)

    rerender({ loading: true })
    rerender({ loading: false })

    act(() => {
      result.current({ currentTarget: el({ scrollTop: 500 }) as HTMLElement })
    })
    expect(onLoadMore).toHaveBeenCalledTimes(2)
  })
})
