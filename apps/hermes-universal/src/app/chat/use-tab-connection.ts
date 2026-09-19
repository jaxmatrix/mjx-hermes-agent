import { useMemo } from 'react'

import { readTranscriptTail } from '@/lib/transcript-tail-cache'
import { useStore } from '@/store/atom'
import { $connectionClients, isAmbientConnection, retryConnectionClient } from '@/store/connection-clients'
import { $connectionsRegistry } from '@/store/connections'
import { $sessionKeyTabs, closeSessionTile, tileKeyFor } from '@/store/session-key-states'
import { $sessionKeyStates, scopedStoredKey } from '@/store/session-state-types'
import { type TabConnection, tabConnectionFor } from '@/store/tab-connection'

/**
 * Everything a chat surface needs to say about its own backend (MJXHRM-591).
 *
 * One hook, both hosts: the desktop tile and the mobile chat render the same
 * banner from the same answer, so neither can drift into its own idea of what
 * "lost" means. It reads the tab's OWN connection — never the active one — and
 * the verbs it hands back act on that connection too.
 */
export function useTabConnection(sessionKey: string): {
  close: () => void
  /** The connection's name, for the copy. */
  label: string
  retry: () => void
  state: TabConnection
  /** Nothing was ever cached for this tab, so a lost connection leaves the
   *  transcript genuinely empty rather than merely stale. */
  transcriptEmpty: boolean
} {
  const clients = useStore($connectionClients)
  const tiles = useStore($sessionKeyTabs)
  const states = useStore($sessionKeyStates)
  const registry = useStore($connectionsRegistry)

  return useMemo(() => {
    const slice = states[sessionKey]
    const connectionId = slice?.connectionId ?? null

    const ref =
      connectionId && slice?.storedSessionId
        ? { connectionId, profile: slice.profile ?? 'default', storedSessionId: slice.storedSessionId }
        : null

    const tileKey = ref ? tileKeyFor(ref) : null
    const tile = tileKey ? tiles.find(open => open.tileKey === tileKey) : undefined

    const state = tabConnectionFor({
      ambient: connectionId ? isAmbientConnection(connectionId) : true,
      client: connectionId ? clients[connectionId] : undefined,
      connectionId,
      tile
    })

    // The tail cache is the reason this tab is not simply blank when its
    // connection goes: a painted tail is pixels, and pixels are exactly what a
    // lost connection still has. Only when there are none does the placeholder
    // earn its place.
    const cached =
      slice?.storedSessionId && slice.messages.length === 0
        ? readTranscriptTail(scopedStoredKey(sessionKey, slice.storedSessionId))
        : null

    return {
      close: () => {
        if (tileKey) {
          closeSessionTile(tileKey)
        }
      },
      label: registry.connections.find(one => one.id === connectionId)?.label ?? connectionId ?? '',
      retry: () => {
        if (connectionId) {
          retryConnectionClient(connectionId)
        }
      },
      state,
      transcriptEmpty: (slice?.messages.length ?? 0) === 0 && !cached?.length
    }
  }, [clients, registry, sessionKey, states, tiles])
}
