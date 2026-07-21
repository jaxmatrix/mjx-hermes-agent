export { useStore } from '@nanostores/react'
// The store engine. Re-exports real nanostores (+ @nanostores/react's useStore)
// behind the `@/store/atom` seam that mobile stores/components import, so ported
// desktop stores get computed/map/action/onMount unchanged. This replaced a
// hand-rolled useSyncExternalStore shim; the public API (atom/useStore) is a
// strict superset, so no consumer changed.
export { atom, batched, computed, keepMount, map, onMount, onSet, onStop, task } from 'nanostores'
export type { Atom, MapStore, ReadableAtom, StoreValue, WritableAtom } from 'nanostores'
