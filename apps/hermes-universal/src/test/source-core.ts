// A fake Rust core for the source the app is on (MJXHRM-602): ONE book, shared
// by every fake window of a test, behind the same commands and the same event
// the real one speaks (`src-tauri/src/connections/source.rs` + `mod.rs`). Its
// rules are that file's, restated — launch decided once, a commit takes the
// next `seq`, a removed row moves the source to the primary, a save that edits
// its dial fields re-commits it for a re-dial (announced BEFORE the save
// returns, and returned as `source`), a seed that lands after launch asks
// launch again — so a test can interleave windows against them.
//
// What a test controls: WHEN a window hears an announcement (`hold` / `deliver`)
// and WHEN a window's `connections_resolve` answers (`holdResolve`).

import { deferred } from './deferred'

export interface CoreSource {
  connectionId: null | string
  seq: number
  dialSeq: number
}

export interface CoreRow {
  id: string
  kind: 'cloud' | 'local' | 'remote' | 'ssh'
  label?: string
  url?: string
  authMode?: 'none' | 'oauth' | 'token'
  host?: string
  user?: string
  port?: number
}

/** `registry.rs`'s `dial_fields`: what a live socket depends on. Never the label. */
function dialFields(row: CoreRow): string {
  const url = row.kind === 'remote' || row.kind === 'cloud' ? (row.url ?? `https://${row.id}.test`) : ''

  return JSON.stringify([row.kind, url, row.authMode ?? 'none', row.host ?? '', row.user ?? '', row.port ?? 22])
}

type Handler = (event: { payload: unknown }) => void

interface CoreWindow {
  handlers: Set<Handler>
  held: null | unknown[]
  resolves: Map<string, Promise<void>>
}

export const CHANGED_EVENT = 'hermes://connections-changed'

export function createSourceCore(init: {
  rows: (CoreRow | string)[]
  lastUsed?: string
  launchMode?: 'last-used' | 'primary'
  primary?: string
  /** No document yet: the first `connections_migrate` seeds it from the
   *  pre-registry target, as Rust's does. Until then there are no rows. */
  unseeded?: boolean
}) {
  const rows = new Map<string, CoreRow>(
    init.rows
      .map(row => (typeof row === 'string' ? { id: row, kind: 'remote' as const } : row))
      .map(row => [row.id, row])
  )

  const first = () => [...rows.keys()][0] ?? 'local'
  const windows = new Map<string, CoreWindow>()
  const resumed = new Set<string>()
  const calls: { command: string; window: string }[] = []
  const saves: Record<string, unknown>[] = []
  let primary = init.primary ?? first()
  let lastUsed = init.lastUsed ?? primary
  let launchMode = init.launchMode ?? 'last-used'
  let current: CoreSource | null = null
  let seeded = !init.unseeded
  const seedRows = init.unseeded ? new Map(rows) : null

  if (init.unseeded) {
    rows.clear()
  }

  const windowOf = (id: string): CoreWindow => {
    let held = windows.get(id)

    if (!held) {
      held = { handlers: new Set(), held: null, resolves: new Map() }
      windows.set(id, held)
    }

    return held
  }

  const emit = (payload: unknown) => {
    for (const target of windows.values()) {
      if (target.held) {
        target.held.push(payload)
      } else {
        for (const handler of [...target.handlers]) {
          handler({ payload })
        }
      }
    }
  }

  const advance = (connectionId: null | string, redial: boolean): CoreSource => {
    const seq = (current?.seq ?? 0) + 1
    const moved = !current || current.connectionId !== connectionId

    current = { connectionId, dialSeq: moved || redial ? seq : (current?.dialSeq ?? seq), seq }
    emit({ reason: 'source', ...current })

    return current
  }

  const launchTarget = (): null | string => {
    const last = rows.has(lastUsed) ? lastUsed : primary
    const target = launchMode === 'primary' ? primary : last

    return rows.has(target) ? target : null
  }

  const repair = () => {
    primary = rows.has(primary) ? primary : first()
    lastUsed = rows.has(lastUsed) ? lastUsed : primary
  }

  const view = () => ({
    connections: [...rows.values()].map((row, order) => ({
      hasSshKey: false,
      hasSshPassphrase: false,
      hasSshPassword: false,
      hasToken: false,
      headerNames: [],
      id: row.id,
      kind: row.kind,
      label: row.label ?? row.id,
      legacy: false,
      order,
      ...(row.kind === 'remote' || row.kind === 'cloud'
        ? { authMode: row.authMode ?? 'none', url: row.url ?? `https://${row.id}.test` }
        : {})
    })),
    keyringAvailable: true,
    lastUsed,
    launchMode,
    localSupported: true,
    primary,
    readOnly: false,
    version: 2
  })

  const notFound = (id: string) => ({ kind: 'not-found', message: `no gateway with id "${id}"` })

  async function invoke(window: string, command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const connectionId = String(args.connectionId ?? '')

    calls.push({ command, window })

    switch (command) {
      case 'connections_list':
        return view()
      case 'connections_migrate': {
        // Idempotent once a document exists. The seed makes its one row the
        // primary and the last-used; a window that asked where the app is
        // BEFORE it is told where launch really lands (`reseeded`).
        if (!seeded) {
          seeded = true

          for (const [id, row] of seedRows ?? []) {
            rows.set(id, row)
          }

          const target = (args.legacyTarget ?? null) as { url?: string } | null

          const seed = [...rows.values()].find(
            row => target?.url && (row.url ?? `https://${row.id}.test`) === target.url
          )

          if (seed) {
            primary = seed.id
            lastUsed = seed.id
          }

          repair()

          if (current && launchTarget() !== current.connectionId) {
            advance(launchTarget(), false)
          }
        }

        return view()
      }

      case 'connections_current_source':
        if (!current) {
          current = { connectionId: launchTarget(), dialSeq: 1, seq: 1 }

          // Rust's: only into a document that exists, and only when it moved.
          if (seeded && current.connectionId && current.connectionId !== lastUsed) {
            lastUsed = current.connectionId
          }
        }

        return { ...current }

      case 'connections_commit_source':
        if (!rows.has(connectionId)) {
          throw notFound(connectionId)
        }

        lastUsed = connectionId

        return { ...advance(connectionId, false) }

      case 'connections_set_last_used':
        if (!rows.has(connectionId)) {
          throw notFound(connectionId)
        }

        lastUsed = connectionId

        return view()
      case 'connections_resolve': {
        await windowOf(window).resolves.get(connectionId)

        const row = rows.get(connectionId)

        if (!row) {
          throw notFound(connectionId)
        }

        const tunnelled = row.kind === 'local' || row.kind === 'ssh'

        return {
          connectionId,
          dialConnectionId: connectionId,
          headerNames: [],
          kind: row.kind,
          label: row.label ?? row.id,
          mode: row.kind,
          profile: args.profile ?? undefined,
          scopeKey: `conn:${connectionId}::${String(args.profile ?? 'default')}`,
          tokenAttached: false,
          ...(tunnelled
            ? { remoteHost: `me@${row.id}` }
            : { authMode: row.authMode ?? 'none', baseUrl: row.url ?? `https://${row.id}.test` })
        }
      }

      case 'connections_remove': {
        if (!rows.delete(connectionId)) {
          throw notFound(connectionId)
        }

        repair()

        if (current?.connectionId === connectionId) {
          advance(rows.has(primary) ? primary : null, false)
        }

        emit({ connectionId, reason: 'removed' })

        return view()
      }

      case 'connections_save': {
        const input = (args.input ?? {}) as Partial<CoreRow> & Record<string, unknown>

        saves.push(input)

        const existing = input.id ? rows.get(input.id) : undefined

        if (input.id && !existing) {
          throw notFound(input.id)
        }

        // What the editor does not send is inherited (`normalize_connection_input`).
        const id = existing?.id ?? String(input.label ?? 'gateway').toLowerCase()
        const next: CoreRow = { ...existing, id, kind: input.kind ?? existing?.kind ?? 'remote' }

        for (const key of ['authMode', 'host', 'label', 'port', 'url', 'user'] as const) {
          if (input[key] !== undefined) {
            Object.assign(next, { [key]: input[key] })
          }
        }

        const changed = !existing || dialFields(existing) !== dialFields(next)

        rows.set(id, next)

        // Rust's order: the re-commit is announced (`redial_source`) before
        // `saved` is, and both before the command returns.
        const source = changed && current?.connectionId === id ? { ...advance(id, true) } : undefined

        emit({ connectionId: id, reason: 'saved' })

        return { connectionId: id, dialFieldsChanged: changed, droppedHeaders: [], registry: view(), source }
      }

      case 'connections_claim_resume': {
        const marker = String(args.marker)
        const won = !resumed.has(marker)

        resumed.add(marker)

        return won
      }

      default:
        return undefined
    }
  }

  return {
    calls,
    /** How often a command was invoked, by one window or by all of them. */
    count: (command: string, window?: string) =>
      calls.filter(call => call.command === command && (!window || call.window === window)).length,
    current: () => (current ? { ...current } : null),
    /** Let a window hear what it was held from, in the order it was said — all
     *  of it, or only the next `count` announcements (it stays held). */
    deliver(window: string, count?: number): void {
      const target = windowOf(window)
      const queued = (target.held ?? []).splice(0, count ?? Infinity)

      if (count === undefined) {
        target.held = null
      }

      for (const payload of queued) {
        for (const handler of [...target.handlers]) {
          handler({ payload })
        }
      }
    },
    /** A row's dial fields were edited by a window no test drives (a settings
     *  Activity): the same `connections_save`, so the same re-commit. */
    editRow(connectionId: string, fields: Partial<CoreRow> = {}): Promise<unknown> {
      const row = rows.get(connectionId)

      return invoke('elsewhere', 'connections_save', {
        input: { url: `https://${connectionId}-moved.test`, ...fields, id: connectionId, kind: row?.kind }
      })
    },
    /** A row as the core holds it. */
    row: (connectionId: string) => rows.get(connectionId),
    /** Queue a window's announcements until `deliver`. */
    hold(window: string): void {
      windowOf(window).held ??= []
    },
    /** Keep one window's `connections_resolve` of a row pending until opened. */
    holdResolve(window: string, connectionId: string): () => void {
      const gate = deferred()

      windowOf(window).resolves.set(connectionId, gate.promise)

      return () => {
        windowOf(window).resolves.delete(connectionId)
        gate.resolve()
      }
    },
    invoke,
    lastUsed: () => lastUsed,
    /** Every `connections_save` input, as the webview sent it. */
    saves,
    listen(window: string, event: string, handler: Handler): () => void {
      if (event !== CHANGED_EVENT) {
        return () => {}
      }

      windowOf(window).handlers.add(handler)

      return () => void windowOf(window).handlers.delete(handler)
    }
  }
}

export type SourceCore = ReturnType<typeof createSourceCore>
