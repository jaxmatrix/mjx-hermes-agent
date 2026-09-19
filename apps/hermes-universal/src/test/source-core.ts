// A fake Rust core for the source the app is on (MJXHRM-602): ONE book, shared
// by every fake window of a test, behind the same commands and the same event
// the real one speaks (`src-tauri/src/connections/source.rs` + `mod.rs`). Its
// rules are that file's, restated — launch decided once, a commit takes the
// next `seq`, a removed row moves the source to the primary, an edited one
// re-commits it for a re-dial — so a test can interleave windows against them.
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
      ...(row.kind === 'remote' || row.kind === 'cloud' ? { url: row.url ?? `https://${row.id}.test` } : {})
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

      case 'connections_migrate':
        return view()

      case 'connections_current_source':
        if (!current) {
          current = { connectionId: launchTarget(), dialSeq: 1, seq: 1 }
          lastUsed = current.connectionId ?? lastUsed
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
            : { authMode: 'none', baseUrl: row.url ?? `https://${row.id}.test` })
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
        // Secrets and labels only: `editRow` is the dial-field edit.
        const input = (args.input ?? {}) as Record<string, unknown>

        saves.push(input)
        emit({ connectionId: input.id, reason: 'saved' })

        return { connectionId: input.id, dialFieldsChanged: false, droppedHeaders: [], registry: view() }
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
    /** A row's dial fields were edited (`connections_save`): re-dial if the app is on it. */
    editRow(connectionId: string): void {
      if (current?.connectionId === connectionId) {
        advance(connectionId, true)
      }

      emit({ connectionId, reason: 'saved' })
    },
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
