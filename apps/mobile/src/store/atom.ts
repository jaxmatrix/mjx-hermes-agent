import { useSyncExternalStore } from 'react'

// Minimal nanostores-compatible atom (dependency-free, backed by React's
// useSyncExternalStore). Mirrors the desktop's `$atom.get()` / `useStore($atom)`
// pattern so ported stores read the same. Swap for real nanostores later if we
// need computed/map stores.

export interface ReadableAtom<T> {
  get(): T
  listen(cb: (value: T) => void): () => void
  subscribe(cb: (value: T) => void): () => void
}

export interface WritableAtom<T> extends ReadableAtom<T> {
  set(value: T): void
}

export function atom<T>(initial: T): WritableAtom<T> {
  let value = initial
  const listeners = new Set<(value: T) => void>()

  const store: WritableAtom<T> = {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return
      value = next
      for (const listener of [...listeners]) listener(value)
    },
    listen(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    subscribe(cb) {
      cb(value)
      return store.listen(cb)
    }
  }

  return store
}

export function useStore<T>(store: ReadableAtom<T>): T {
  return useSyncExternalStore(
    cb => store.listen(cb),
    () => store.get(),
    () => store.get()
  )
}
