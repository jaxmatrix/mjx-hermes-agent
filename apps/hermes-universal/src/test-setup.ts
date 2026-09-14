// Vitest global setup — adds the jest-dom matchers (toBeInTheDocument,
// toHaveClass, …) to Vitest's expect.
import '@testing-library/jest-dom/vitest'

import { configureQueryClientForTests } from '@/lib/query-client'

// A dozen test files render against the app's SHARED React Query client — they
// have to, because the cache writers close over that instance. Its production
// defaults carry React Query's retry ladder, which stretches any REJECTED query
// to ~7s and blows Vitest's 5s testTimeout, so no test could assert a
// failed-load state. Disabled once here, where no file can forget it.
configureQueryClientForTests()

// Node 26 defines its own `localStorage` accessor on the global object, which
// returns `undefined` unless the process was started with --localstorage-file
// (it warns: "localStorage is not available because --localstorage-file was
// not provided"). In the jsdom environment `globalThis` IS the window, so that
// accessor shadows jsdom's Storage and every `localStorage.getItem(...)` in a
// test throws "Cannot read properties of undefined". Install a real in-memory
// Storage when the global resolves to nothing, before any test module reads it.
// apps/desktop/vitest.setup.ts installs the Map-backed version of this shim.
// It is left alone deliberately: nothing in that app enumerates storage keys,
// so the bug below cannot bite there — port this if that ever changes.
if (typeof (globalThis as unknown as { localStorage?: Storage }).localStorage === 'undefined') {
  // The entries live as own enumerable properties OF the storage object, not in
  // a side Map. `Object.keys(localStorage)` is part of the Web Storage contract
  // (Storage exposes its keys as named properties) and real code reads it that
  // way — the stale-surface-grant boot sweep in store/windows.ts finds every
  // grant with it. A Map-backed literal enumerates as `[]`, so under Node 26 the
  // sweep swept nothing while jsdom's Storage made it work everywhere else.
  const storage = {} as Storage & Record<string, string>

  // Non-enumerable so the API never reads back as stored keys; writable and
  // configurable so a test can still `vi.spyOn(localStorage, 'getItem')`.
  const method = (value: unknown) => ({ configurable: true, value, writable: true })

  Object.defineProperties(storage, {
    clear: method(() => {
      for (const k of Object.keys(storage)) {
        delete storage[k]
      }
    }),
    // `typeof === 'string'`, not `in`: every stored value is stringified on the
    // way in, so this is what tells a real entry from one of these methods.
    getItem: method((k: string) => (typeof storage[String(k)] === 'string' ? storage[String(k)] : null)),
    key: method((i: number) => Object.keys(storage)[i] ?? null),
    length: { configurable: true, get: () => Object.keys(storage).length },
    removeItem: method((k: string) => void delete storage[String(k)]),
    setItem: method((k: string, v: string) => void (storage[String(k)] = String(v)))
  })

  for (const target of [globalThis, (globalThis as unknown as { window?: Window }).window].filter(Boolean)) {
    Object.defineProperty(target, 'localStorage', {
      configurable: true,
      value: storage,
      writable: true
    })
  }
}

// jsdom lacks these DOM APIs that Radix primitives (dropdown/dialog/…) call
// while opening. Stub them so component tests can drive those overlays.
if (typeof Element !== 'undefined') {
  Element.prototype.hasPointerCapture ??= () => false

  Element.prototype.setPointerCapture ??= () => {}

  Element.prototype.releasePointerCapture ??= () => {}

  Element.prototype.scrollIntoView ??= () => {}
}

// jsdom has no ResizeObserver, and several chat components construct one in a
// layout effect (expandable-block, user-message clamp, tool windows). A no-op
// stub is enough: jsdom never lays anything out, so a real implementation would
// only ever report zeroes anyway.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver
}
