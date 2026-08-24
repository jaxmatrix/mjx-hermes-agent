/**
 * The store around the translucency book: what is persisted, what is pushed
 * down to Rust, and what is announced to the other WebViews.
 *
 * The module runs side effects at import — the first paint, the capability
 * probe, the peer listener — so every test imports a FRESH copy after seeding
 * localStorage, rather than trying to reset one shared instance.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Platform from '@/lib/platform'
import type { TranslucencyBook } from '@/lib/translucency-model'
import type * as Store from '@/store/translucency'

const invoke = vi.fn()
const broadcastToPeers = vi.fn()
let peerHandler: ((payload: unknown) => void) | null = null
let glassBacked = true

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof Platform>()),
  IS_MAC: true,
  IS_TAURI: true,
  PLATFORM: 'macos'
}))
vi.mock('@/lib/webview-broadcast', () => ({
  broadcastToPeers: (...args: unknown[]) => broadcastToPeers(...args),
  onPeerBroadcast: (_event: string, handle: (payload: unknown) => void) => {
    peerHandler = handle

    return () => undefined
  }
}))
// Only `isGlassBackedWindow` is consumed, and `store/windows` drags in the whole
// window/layout graph — a leaf mock keeps this a unit test.
vi.mock('@/store/windows', () => ({ isGlassBackedWindow: () => glassBacked }))

const OUTCOME = { effectiveGlass: true, material: 'applied', note: null, opacity: 'applied' }

async function load(): Promise<typeof Store> {
  vi.resetModules()
  peerHandler = null

  const module = await import('@/store/translucency')

  // The capability probe is fired at import; let it settle so tests see the
  // steady state rather than the optimistic first frame.
  await vi.advanceTimersByTimeAsync(0)

  return module
}

function caps(glass: 'supported' | 'unsupported', platform = 'macos'): unknown {
  return {
    glass,
    materials: glass === 'supported' ? ['under-window', 'popover', 'titlebar', 'header'] : [],
    notes: [],
    osBuild: null,
    platform,
    translucency: 'supported'
  }
}

/** `appearance_capabilities` first, then every `appearance_set_glass`. */
function answer(capabilities: unknown = caps('supported')): void {
  invoke.mockImplementation((command: string) =>
    command === 'appearance_capabilities' ? Promise.resolve(capabilities) : Promise.resolve(OUTCOME)
  )
}

const glassCalls = (): unknown[] =>
  invoke.mock.calls
    .filter(call => call[0] === 'appearance_set_glass')
    .map(call => (call[1] as { state: unknown }).state)

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  document.documentElement.removeAttribute('style')
  invoke.mockReset()
  broadcastToPeers.mockReset()
  glassBacked = true
  answer()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('migration from the bare-number key', () => {
  it('reads a v1 profile that was never touched as glass, on', async () => {
    localStorage.setItem('hermes.translucency', '0')

    const store = await load()

    expect(store.$translucencyBook.get().mode).toBe('glass')
  })

  it('keeps a TUNED v1 profile on clear, in BOTH appearances', async () => {
    localStorage.setItem('hermes.translucency', '40')

    const store = await load()

    expect(store.$translucencyBook.get()).toEqual({ base: { intensity: 40 }, dark: {}, light: {}, mode: 'clear' })
    expect(store.$translucency.get().intensity).toBe(40)

    store.setGlassAppearance('light')

    expect(store.$translucency.get().intensity).toBe(40)
  })

  it('leaves the legacy key alone — it is the downgrade path', async () => {
    localStorage.setItem('hermes.translucency', '40')

    const store = await load()

    store.setTranslucency(10)
    store.flushPendingTranslucency()

    expect(localStorage.getItem('hermes.translucency')).toBe('40')
    expect(localStorage.getItem('hermes.translucency.v2')).toContain('"mode":"clear"')
  })

  it('prefers a v2 book over the legacy number', async () => {
    localStorage.setItem('hermes.translucency', '40')
    localStorage.setItem(
      'hermes.translucency.v2',
      JSON.stringify({ base: {}, dark: { intensity: 7 }, light: {}, mode: 'glass' } satisfies TranslucencyBook)
    )

    const store = await load()

    expect(store.$translucency.get()).toMatchObject({ intensity: 7, mode: 'glass' })
  })

  it('survives a corrupt book', async () => {
    localStorage.setItem('hermes.translucency.v2', '{not json')

    const store = await load()

    expect(store.$translucencyBook.get().mode).toBe('glass')
  })
})

describe('persistence', () => {
  it('debounces the write and lands the value the drag ENDED on', async () => {
    const store = await load()

    for (const value of [5, 10, 15, 20, 25, 30]) {
      store.setTranslucency(value)
    }

    expect(localStorage.getItem('hermes.translucency.v2')).toBeNull()

    await vi.runAllTimersAsync()

    expect(JSON.parse(localStorage.getItem('hermes.translucency.v2') ?? 'null')).toMatchObject({
      dark: { intensity: 30 }
    })
  })

  it('flushes a pending write rather than losing it, and is a no-op with nothing pending', async () => {
    const store = await load()

    store.flushPendingTranslucency()

    expect(localStorage.getItem('hermes.translucency.v2')).toBeNull()

    store.setTranslucency(42)
    store.flushPendingTranslucency()

    expect(JSON.parse(localStorage.getItem('hermes.translucency.v2') ?? 'null')).toMatchObject({
      dark: { intensity: 42 }
    })
  })

  it('writes only the appearance being painted', async () => {
    const store = await load()

    store.setGlassAppearance('light')
    store.setTranslucency(80)
    store.flushPendingTranslucency()

    expect(store.$translucencyBook.get().light).toEqual({ intensity: 80 })
    expect(store.$translucencyBook.get().dark).toEqual({})
  })
})

describe('the native push', () => {
  it('sends NOTHING for a tint drag under glass — the lever is a CSS colour', async () => {
    const store = await load()

    store.setTranslucencyMode('glass')
    store.setTranslucency(30)
    await vi.runAllTimersAsync()

    const before = glassCalls().length

    for (let value = 31; value <= 90; value += 1) {
      store.setTranslucency(value)
    }

    await vi.runAllTimersAsync()

    expect(glassCalls().length).toBe(before)
  })

  it('sends every tick under clear, where the lever IS the window opacity', async () => {
    const store = await load()

    store.setTranslucencyMode('clear')
    store.setTranslucency(10)
    await vi.runAllTimersAsync()

    const before = glassCalls().length

    store.setTranslucency(11)
    store.setTranslucency(12)
    await vi.runAllTimersAsync()

    expect(glassCalls().length).toBe(before + 2)
  })

  it('costs zero IPC to change the scope — it moves no native property', async () => {
    const store = await load()

    store.setTranslucencyMode('glass')
    store.setTranslucency(30)
    await vi.runAllTimersAsync()

    const before = glassCalls().length

    store.setTranslucencyScope('sidebar')
    await vi.runAllTimersAsync()

    expect(glassCalls().length).toBe(before)
    expect(store.$translucency.get().scope).toBe('sidebar')
  })

  it('re-pushes on an appearance switch without persisting one', async () => {
    localStorage.setItem(
      'hermes.translucency.v2',
      JSON.stringify({ base: {}, dark: { intensity: 10 }, light: { intensity: 90 }, mode: 'clear' })
    )

    const store = await load()

    store.setTranslucency(10)
    await vi.runAllTimersAsync()

    const written = localStorage.getItem('hermes.translucency.v2')
    const before = glassCalls().length

    store.setGlassAppearance('light')
    await vi.runAllTimersAsync()

    expect(glassCalls().length).toBe(before + 1)
    expect(glassCalls().at(-1)).toMatchObject({ intensity: 90 })
    // An appearance switch is not an edit.
    expect(localStorage.getItem('hermes.translucency.v2')).toBe(written)
  })

  it('stays silent in a window that hosts no field of its own', async () => {
    glassBacked = false

    const store = await load()

    store.setTranslucencyMode('clear')
    store.setTranslucency(40)
    await vi.runAllTimersAsync()

    expect(glassCalls()).toEqual([])
  })

  it('re-asserts the persisted preference at startup', async () => {
    localStorage.setItem('hermes.translucency', '40')

    const store = await load()

    expect(glassCalls()).toEqual([])

    store.initTranslucency()
    await vi.runAllTimersAsync()

    expect(glassCalls()).toEqual([{ fade: 0, intensity: 40, material: 'titlebar', mode: 'clear' }])
  })
})

describe('refusals', () => {
  it('drops to clear when the platform says the material is unsupported', async () => {
    invoke.mockImplementation((command: string) =>
      command === 'appearance_capabilities'
        ? Promise.resolve(caps('supported'))
        : Promise.resolve({ ...OUTCOME, effectiveGlass: false, material: 'unsupported', note: 'no material' })
    )

    const store = await load()

    store.setTranslucencyMode('glass')
    store.setTranslucency(30)
    await vi.runAllTimersAsync()

    expect(store.$translucencyBook.get().mode).toBe('clear')
    expect(document.documentElement.dataset.hermesGlass).toBeUndefined()
  })

  it('lets a LATE refusal be overruled by a newer success', async () => {
    const first: { resolve?: (value: unknown) => void } = {}
    let call = 0

    invoke.mockImplementation((command: string) => {
      if (command === 'appearance_capabilities') {
        return Promise.resolve(caps('supported'))
      }

      call += 1

      if (call === 1) {
        return new Promise(resolve => {
          first.resolve = resolve
        })
      }

      return Promise.resolve(OUTCOME)
    })

    const store = await load()

    store.setTranslucencyMode('glass')
    store.setTranslucency(30)
    store.setTranslucency(0)
    store.setTranslucency(60)
    await vi.runAllTimersAsync()

    // The first push finally answers "no material" — long after a later one
    // succeeded. It must not undo it.
    first.resolve?.({ ...OUTCOME, effectiveGlass: false, material: 'unsupported' })
    await vi.runAllTimersAsync()

    expect(store.$translucencyBook.get().mode).toBe('glass')
  })

  it('degrades an unsupported mode from the capability answer alone', async () => {
    localStorage.setItem(
      'hermes.translucency.v2',
      JSON.stringify({ base: {}, dark: {}, light: {}, mode: 'glass' } satisfies TranslucencyBook)
    )
    answer(caps('unsupported', 'linux'))

    const store = await load()

    expect(store.$glassCapabilities.get()?.glass).toBe('unsupported')
    expect(store.$translucencyBook.get().mode).toBe('clear')
  })
})

describe('cross-window propagation', () => {
  it('announces a local change once the write settles', async () => {
    const store = await load()

    store.setTranslucency(30)
    store.setTranslucency(31)

    expect(broadcastToPeers).not.toHaveBeenCalled()

    await vi.runAllTimersAsync()

    expect(broadcastToPeers).toHaveBeenCalledTimes(1)
    expect(broadcastToPeers.mock.calls[0][0]).toBe('translucency://changed')
  })

  it('adopts a peer book and does NOT bounce it back', async () => {
    const store = await load()

    await vi.runAllTimersAsync()
    broadcastToPeers.mockClear()

    peerHandler?.({ book: { base: {}, dark: { intensity: 77 }, light: {}, mode: 'glass' }, origin: 'other' })
    await vi.runAllTimersAsync()

    expect(store.$translucency.get().intensity).toBe(77)
    expect(broadcastToPeers).not.toHaveBeenCalled()
  })

  it('applies an adopted book to this window own native surface', async () => {
    const store = await load()

    await vi.runAllTimersAsync()

    const before = glassCalls().length

    peerHandler?.({ book: { base: {}, dark: { intensity: 5 }, light: {}, mode: 'clear' }, origin: 'other' })
    await vi.runAllTimersAsync()

    expect(glassCalls().length).toBeGreaterThan(before)
    expect(store.$translucency.get().mode).toBe('clear')
  })
})

describe('peek', () => {
  it('holds while a control is held and never wedges below zero', async () => {
    const store = await load()

    store.endTranslucencyPeek()
    store.endTranslucencyPeek()

    expect(store.$translucencyPeek.get()).toBe(false)

    store.beginTranslucencyPeek()

    expect(store.$translucencyPeek.get()).toBe(true)
    expect(document.documentElement.dataset.hermesTranslucencyPeek).toBe('')

    store.endTranslucencyPeek()

    expect(store.$translucencyPeek.get()).toBe(false)
    expect(document.documentElement.dataset.hermesTranslucencyPeek).toBeUndefined()
  })

  it('pulses for a click, and reset clears every hold', async () => {
    const store = await load()

    store.pulseTranslucencyPeek()

    expect(store.$translucencyPeek.get()).toBe(true)

    await vi.runAllTimersAsync()

    expect(store.$translucencyPeek.get()).toBe(false)

    store.beginTranslucencyPeek()
    store.beginTranslucencyPeek()
    store.resetTranslucencyPeek()

    expect(store.$translucencyPeek.get()).toBe(false)
  })
})
