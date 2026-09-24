/**
 * ONE-WAY migration of universal's persisted session tabs into the format
 * desktop's `store/session-states` reads (MJXHRM-602).
 *
 * Universal kept its open tabs as ONE FLAT LIST under `hermes.sessionTiles.v3`
 * (each entry carrying its own connection and profile), with an older
 * profile-keyed `hermes.sessionTiles.v2` behind it. Desktop's module reads
 * `hermes.desktop.sessionTiles.v2` — per-profile buckets, a tile identified by
 * its stored session id alone — so without this every existing user's open tabs
 * would silently vanish on the first launch after the resync.
 *
 * DEPENDENCY-FREE on purpose: desktop's module reads storage at MODULE
 * EVALUATION, so this runs as the first import of `main.tsx` and must not pull
 * in anything that could evaluate `store/session-states` ahead of it. The few
 * helpers it needs are inlined; the test pins each to the module it mirrors.
 */

export const UNIVERSAL_TILES_KEY = 'hermes.sessionTiles.v3'
export const UNIVERSAL_LEGACY_TILES_KEY = 'hermes.sessionTiles.v2'
export const DESKTOP_TILES_KEY = 'hermes.desktop.sessionTiles.v2'

const TILE_PANE_PREFIX = 'session-tile:'
const DRAFT_TILE_KEY = 'draft'
const PLACEHOLDER_PREFIXES = ['draft:', 'hydrating:']
// `local` names the local source, but it was also universal's fallback for a tab
// whose connection was never resolved — so it cannot be trusted as a route.
const LOCAL_CONNECTION_ID = 'local'

/** Mirrors `normalizeProfileKey` in `store/profile`. */
export function migratedProfileKey(profile: unknown): string {
  return (typeof profile === 'string' ? profile.trim() : '') || 'default'
}

/** The stored session id a universal tab key (`<id>` or `@conn|profile|id`,
 *  each part URI-encoded) names, or null when the key names no stored session. */
function storedIdOfTabKey(tabKey: string): null | string {
  if (!tabKey.startsWith('@')) {
    return tabKey || null
  }

  const parts = tabKey.slice(1).split('|')

  if (parts.length < 3) {
    return null
  }

  try {
    return decodeURIComponent(parts[2]) || null
  } catch {
    return null
  }
}

const tabKeyOf = (connectionId: string, profile: string, storedSessionId: string): string =>
  connectionId === LOCAL_CONNECTION_ID && profile === 'default'
    ? storedSessionId
    : `@${[connectionId, profile, storedSessionId].map(encodeURIComponent).join('|')}`

/**
 * A universal pane id in desktop's spelling: `session-tile:<tabKey>` becomes
 * `session-tile:<storedSessionId>`. Null for the draft pane, for a key that
 * names no stored session, and for a tab `survives` rejects; any pane that is
 * not a session tile passes through untouched.
 */
export function migrateTilePaneId(paneId: string, survives: (tabKey: string) => boolean = () => true): null | string {
  if (!paneId.startsWith(TILE_PANE_PREFIX)) {
    return paneId
  }

  const tabKey = paneId.slice(TILE_PANE_PREFIX.length)
  const storedSessionId = tabKey === DRAFT_TILE_KEY ? null : storedIdOfTabKey(tabKey)

  return storedSessionId && survives(tabKey) ? `${TILE_PANE_PREFIX}${storedSessionId}` : null
}

interface Incoming {
  anchor?: string
  before?: null | string
  bucket: string
  connectionId: string
  dir?: string
  profile: string
  storedSessionId: string
  tabKey: string
}

function parseIncoming(value: unknown, profile: unknown, withConnection: boolean): Incoming | null {
  const raw = value as null | Record<string, unknown>

  if (!raw || typeof raw !== 'object' || typeof raw.storedSessionId !== 'string') {
    return null
  }

  const storedSessionId = raw.storedSessionId

  if (
    !storedSessionId ||
    storedSessionId === DRAFT_TILE_KEY ||
    PLACEHOLDER_PREFIXES.some(prefix => storedSessionId.startsWith(prefix))
  ) {
    return null
  }

  const bucket = migratedProfileKey(profile)

  const connectionId =
    (withConnection && typeof raw.connectionId === 'string' ? raw.connectionId.trim() : '') || LOCAL_CONNECTION_ID

  return {
    anchor: typeof raw.anchor === 'string' ? raw.anchor : undefined,
    before: typeof raw.before === 'string' || raw.before === null ? raw.before : undefined,
    bucket,
    connectionId,
    dir: typeof raw.dir === 'string' ? raw.dir : undefined,
    profile: bucket,
    storedSessionId,
    // A v2 tab's pane id was its bare stored id.
    tabKey: withConnection ? tabKeyOf(connectionId, bucket, storedSessionId) : storedSessionId
  }
}

function parseJson(raw: null | string | undefined): unknown {
  if (typeof raw !== 'string') {
    return null
  }

  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export interface PersistedTilesMigration {
  /** The value for desktop's key — the input, untouched, when nothing moved. */
  desktop: null | string
  changed: boolean
  migrated: number
  /** Tabs dropped because their stored session was already open. */
  droppedDuplicates: number
}

/** Pure and total: malformed JSON and unexpected shapes are skipped, never thrown. */
export function migratePersistedTiles(input: {
  desktop?: null | string
  v2?: null | string
  v3?: null | string
}): PersistedTilesMigration {
  const incoming: Incoming[] = []
  const v3 = parseJson(input.v3)
  const v2 = parseJson(input.v2)

  if (Array.isArray(v3)) {
    for (const entry of v3) {
      const tile = parseIncoming(entry, (entry as null | Record<string, unknown>)?.profile, true)

      if (tile) {
        incoming.push(tile)
      }
    }
  }

  if (isRecord(v2)) {
    for (const [profile, list] of Object.entries(v2)) {
      for (const entry of Array.isArray(list) ? list : []) {
        const tile = parseIncoming(entry, profile, false)

        if (tile) {
          incoming.push(tile)
        }
      }
    }
  }

  // Desktop's own state wins and is carried over verbatim: a stored session it
  // already has open is never reopened, moved or re-routed by a migrated tab.
  const parsedDesktop = parseJson(input.desktop)
  const buckets = new Map<string, unknown>(isRecord(parsedDesktop) ? Object.entries(parsedDesktop) : [])
  const seen = new Set<string>()

  for (const list of buckets.values()) {
    for (const tile of Array.isArray(list) ? list : []) {
      if (isRecord(tile) && typeof tile.storedSessionId === 'string') {
        seen.add(tile.storedSessionId)
      }
    }
  }

  const kept: Incoming[] = []
  let droppedDuplicates = 0

  for (const tile of incoming) {
    if (seen.has(tile.storedSessionId)) {
      droppedDuplicates += 1
    } else {
      seen.add(tile.storedSessionId)
      kept.push(tile)
    }
  }

  if (kept.length === 0) {
    return { changed: false, desktop: input.desktop ?? null, droppedDuplicates, migrated: 0 }
  }

  const surviving = new Set(kept.map(tile => tile.tabKey))
  const paneId = (id: string) => migrateTilePaneId(id, tabKey => surviving.has(tabKey)) ?? undefined

  for (const tile of kept) {
    const existing = buckets.get(tile.bucket)

    buckets.set(tile.bucket, [
      ...(Array.isArray(existing) ? existing : []),
      {
        anchor: tile.anchor === undefined ? undefined : paneId(tile.anchor),
        before: typeof tile.before === 'string' ? paneId(tile.before) : tile.before,
        dir: tile.dir,
        ...(tile.connectionId !== LOCAL_CONNECTION_ID
          ? { ownerRoute: { connectionId: tile.connectionId, profile: tile.profile } }
          : {}),
        storedSessionId: tile.storedSessionId,
        workspaceMode: 'sessions'
      }
    ])
  }

  return {
    changed: true,
    desktop: JSON.stringify(Object.fromEntries(buckets)),
    droppedDuplicates,
    migrated: kept.length
  }
}

/** Read universal's keys, fold them into desktop's, retire them. Storage is
 *  best-effort: a failed write leaves universal's keys for the next launch. */
export function runPersistedTilesMigration(storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>): void {
  try {
    const v3 = storage.getItem(UNIVERSAL_TILES_KEY)
    const v2 = storage.getItem(UNIVERSAL_LEGACY_TILES_KEY)

    if (v3 === null && v2 === null) {
      return
    }

    const result = migratePersistedTiles({ desktop: storage.getItem(DESKTOP_TILES_KEY), v2, v3 })

    if (result.changed && result.desktop !== null) {
      storage.setItem(DESKTOP_TILES_KEY, result.desktop)
    }

    storage.removeItem(UNIVERSAL_TILES_KEY)
    storage.removeItem(UNIVERSAL_LEGACY_TILES_KEY)

    if (result.droppedDuplicates > 0) {
      console.warn('[tiles] migration dropped duplicate tabs', { count: result.droppedDuplicates })
    }
  } catch {
    // Restricted contexts (private mode, disabled storage) have nothing to migrate.
  }
}

if (typeof window !== 'undefined') {
  try {
    runPersistedTilesMigration(window.localStorage)
  } catch {
    // `localStorage` itself can throw on access.
  }
}
