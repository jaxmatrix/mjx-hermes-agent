/**
 * WHAT A TAB POINTS AT — the rules tiles and bubbles share (MJXHRM-591,
 * invariant 44).
 *
 * The desktop keeps its open chats in a layout tree (pane ids, anchors, docks,
 * the pane mirror); the phone keeps them in an ordered strip of bubbles. Those
 * two stores have almost nothing in common and are deliberately not merged —
 * merging them would drag the layout mirror onto the phone path for no gain.
 *
 * What they DO share is the part that can drift: what a tab points at, how that
 * is encoded into its identity, how it is persisted, and how a per-profile blob
 * from before connections is migrated into it. Those rules live here, once, so
 * "a bubble is addressed by its ref, never by a bare stored id" cannot become
 * true on one surface and false on the other.
 *
 * The key scheme itself is `store/session-state-types`: a tab's identity IS the
 * scoped stored key, which is the bare id for the local connection's default
 * profile — so a single-source install's pane ids, storage and logs are
 * byte-identical to what they were.
 */

import { readJson, writeJson } from '@/lib/storage'
import { normalizeProfileKey } from '@/store/profile'
import {
  DEFAULT_SESSION_PROFILE,
  LOCAL_SESSION_SCOPE,
  parseSessionKey,
  type SessionRef,
  storedKeyFor
} from '@/store/session-state-types'

/** Where a tab points: its connection, its profile and its stored session. */
export type TabRef = SessionRef

/** The tab's identity — the ref, encoded. */
export const tabKeyFor = (ref: TabRef): string => storedKeyFor(ref.connectionId, ref.profile, ref.storedSessionId)

/** The ref a persisted or live tab record carries. */
export const tabRefOf = (record: TabRef): TabRef => ({
  connectionId: record.connectionId,
  profile: record.profile,
  storedSessionId: record.storedSessionId
})

/** The ref a tab KEY names. A key is the ref encoded, so this is exact — and it
 *  is how a caller holding only a key (a pane id, a route) recovers one. */
export function refFromTabKey(tabKey: string): TabRef {
  const parsed = parseSessionKey(tabKey)

  return {
    connectionId: parsed.connectionId,
    profile: parsed.profile ?? DEFAULT_SESSION_PROFILE,
    storedSessionId: parsed.id
  }
}

export const sameTabRef = (a: TabRef, b: TabRef): boolean =>
  a.connectionId === b.connectionId && a.profile === b.profile && a.storedSessionId === b.storedSessionId

/**
 * Where a tab for a bare stored id belongs.
 *
 * A caller holding a row (a sidebar entry, a waiting prompt, a deep link) knows
 * which connection that row came from — `store/session-sources` tags every
 * merged row with its owner. This is that lookup, INJECTED rather than imported
 * so the tab layer stays dependency-light, and resolved ONCE, when the tab
 * opens: nothing re-reads it afterwards, which is what makes a tab
 * self-contained rather than usually right.
 */
let refResolver: ((storedSessionId: string) => TabRef) | null = null

export function setTabRefResolver(resolve: (storedSessionId: string) => TabRef): void {
  refResolver = resolve
}

export function tabRefFor(storedSessionId: string): TabRef {
  return (
    refResolver?.(storedSessionId) ?? {
      connectionId: LOCAL_SESSION_SCOPE,
      profile: DEFAULT_SESSION_PROFILE,
      storedSessionId
    }
  )
}

/**
 * Read a pre-connection, PROFILE-KEYED blob once, and delete it.
 *
 * Both surfaces persisted their tabs as `Record<profile, …>` and swapped the
 * visible set on a profile switch. Neither does now — a tab carries its own
 * connection and stays put — so both migrate the same way: every entry under
 * profile P belonged to the connection the app was pointed at, which is the
 * registry's primary, and it keeps the profile it sat under.
 *
 * Returns `null` when there is nothing to migrate, so a caller can tell "no v1"
 * from "an empty v1". ONE-WAY: the legacy key is removed here, so a later read
 * cannot resurrect the profile-keyed shape.
 */
export function takeProfileKeyedTabs(legacyKey: string): null | { entry: unknown; profile: string }[] {
  const parsed = readJson<unknown>(legacyKey)

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }

  const out: { entry: unknown; profile: string }[] = []

  for (const [profile, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      continue
    }

    for (const entry of list) {
      out.push({ entry, profile: normalizeProfileKey(profile) })
    }
  }

  writeJson(legacyKey, null)

  return out
}
