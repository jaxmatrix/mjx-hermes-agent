import { getStarmapGraph } from '@/hermes'
import { atom } from '@/store/atom'
import type { StarmapGraph } from '@/types/hermes'

// On-demand cache for the memory graph. The scan touches the skills catalog +
// usage ledger + memory files, so it's fetched only when the view opens (and on
// explicit refresh). Ported from apps/desktop/src/store/starmap.ts (per-profile
// eviction dropped — mobile is single-profile).
export const $starmapGraph = atom<StarmapGraph | null>(null)
export const $starmapLoading = atom(false)
export const $starmapError = atom<null | string>(null)

let inflight: Promise<void> | null = null

export async function loadStarmapGraph(force = false): Promise<void> {
  if (inflight) {
    return inflight
  }
  if ($starmapGraph.get() && !force) {
    return
  }

  $starmapLoading.set(true)
  $starmapError.set(null)

  inflight = (async () => {
    try {
      $starmapGraph.set(await getStarmapGraph())
    } catch (err) {
      $starmapError.set(err instanceof Error ? err.message : String(err))
    } finally {
      $starmapLoading.set(false)
      inflight = null
    }
  })()

  return inflight
}

/** Drop one node from the cached graph immediately; return a rollback. */
export function evictStarmapNode(id: string): () => void {
  const prev = $starmapGraph.get()
  if (!prev) {
    return () => {}
  }
  $starmapGraph.set({
    ...prev,
    nodes: prev.nodes.filter(node => node.id !== id),
    edges: prev.edges.filter(edge => edge.source !== id && edge.target !== id)
  })
  return () => $starmapGraph.set(prev)
}
