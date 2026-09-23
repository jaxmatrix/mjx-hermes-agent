/**
 * `hermesDesktop.terminal` over Rust `pty_*` — Electron `hermes:terminal:*`.
 *
 * Electron generates the session id on the main side and pushes
 * `hermes:terminal:{id}:data|exit` after `start` returns. Tauri’s PTY is the
 * inverse (client picks the id, must subscribe before `pty_spawn`), so this
 * bridge owns the id, listens first, and buffers frames until `onData` /
 * `onExit` attach — matching how `use-terminal-session` wires the stream.
 */

import type { HermesTerminalExit, HermesTerminalSession } from '@/global'

type Bridge = NonNullable<typeof window.hermesDesktop>
type TerminalApi = Bridge['terminal']

type DataCb = (payload: string) => void
type ExitCb = (payload: HermesTerminalExit) => void

interface Session {
  cwd: string
  decoder: TextDecoder
  shell: string
  dataListeners: Set<DataCb>
  exitListeners: Set<ExitCb>
  pendingData: string[]
  pendingExit: HermesTerminalExit | null
  unlistens: Array<() => void>
}

const sessions = new Map<string, Session>()

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

function tearDown(id: string): void {
  const session = sessions.get(id)

  if (!session) {
    return
  }

  for (const stop of session.unlistens) {
    stop()
  }

  sessions.delete(id)
}

async function bindEvents(id: string, session: Session): Promise<void> {
  const { listen } = await import('@tauri-apps/api/event')

  const onData = await listen<number[]>(`pty://${id}/data`, event => {
    const text = session.decoder.decode(Uint8Array.from(event.payload ?? []), { stream: true })

    if (!text) {
      return
    }

    if (session.dataListeners.size === 0) {
      session.pendingData.push(text)

      return
    }

    for (const cb of session.dataListeners) {
      cb(text)
    }
  })

  const onExit = await listen(`pty://${id}/exit`, () => {
    // Rust emits a unit payload — no exit code/signal from portable-pty.
    const payload: HermesTerminalExit = { code: null, signal: null }

    session.pendingExit = payload

    if (session.exitListeners.size === 0) {
      return
    }

    for (const cb of session.exitListeners) {
      cb(payload)
    }
  })

  session.unlistens.push(onData, onExit)
}

const start: TerminalApi['start'] = async (options = {}) => {
  const id = crypto.randomUUID()
  const cols = Math.max(2, Math.floor(Number(options.cols) || 80))
  const rows = Math.max(2, Math.floor(Number(options.rows) || 24))
  const cwd = String(options.cwd ?? '').trim()

  const session: Session = {
    cwd,
    decoder: new TextDecoder(),
    shell: 'shell',
    dataListeners: new Set(),
    exitListeners: new Set(),
    pendingData: [],
    pendingExit: null,
    unlistens: []
  }

  sessions.set(id, session)

  try {
    await bindEvents(id, session)

    const spawned = await invokeNative<{ shell?: string }>('pty_spawn', {
      id,
      cols,
      rows,
      cwd: cwd || null
    })

    session.shell = spawned?.shell?.trim() || 'shell'
  } catch (error) {
    tearDown(id)
    throw error
  }

  const result: HermesTerminalSession = { cwd, id, shell: session.shell }

  return result
}

const attach: TerminalApi['attach'] = async id => sessions.has(id)

const write: TerminalApi['write'] = async (id, data) => {
  if (!sessions.has(id)) {
    return false
  }

  try {
    await invokeNative('pty_write', { id, data: String(data ?? '') })

    return true
  } catch {
    return false
  }
}

const resize: TerminalApi['resize'] = async (id, size = { cols: 80, rows: 24 }) => {
  if (!sessions.has(id)) {
    return false
  }

  const cols = Math.max(2, Math.floor(Number(size.cols) || 80))
  const rows = Math.max(2, Math.floor(Number(size.rows) || 24))

  try {
    await invokeNative('pty_resize', { id, cols, rows })

    return true
  } catch {
    return false
  }
}

const cwd: TerminalApi['cwd'] = async id => {
  // No `pty_cwd` yet — OSC 7/9 in the renderer covers live probes; spawn cwd
  // is the best we can return without reading /proc from Rust.
  const session = sessions.get(id)

  return session?.cwd?.trim() ? session.cwd : null
}

const dispose: TerminalApi['dispose'] = async id => {
  if (!sessions.has(id)) {
    return false
  }

  tearDown(id)

  try {
    await invokeNative('pty_kill', { id })
  } catch {
    // Already reaped by the reader thread after exit — still a successful dispose.
  }

  return true
}

const onData: TerminalApi['onData'] = (id, callback) => {
  const session = sessions.get(id)

  if (!session) {
    return () => undefined
  }

  session.dataListeners.add(callback)

  if (session.pendingData.length > 0) {
    const pending = session.pendingData.splice(0)

    for (const chunk of pending) {
      callback(chunk)
    }
  }

  return () => {
    session.dataListeners.delete(callback)
  }
}

const onExit: TerminalApi['onExit'] = (id, callback) => {
  const session = sessions.get(id)

  if (!session) {
    return () => undefined
  }

  session.exitListeners.add(callback)

  if (session.pendingExit) {
    callback(session.pendingExit)
  }

  return () => {
    session.exitListeners.delete(callback)
  }
}

export const terminalBridge: Pick<Bridge, 'terminal'> = {
  terminal: {
    attach,
    cwd,
    dispose,
    onData,
    onExit,
    resize,
    start,
    write
  }
}

/** Test seam — drop every tracked session (does not kill OS processes). */
export function __resetTerminalSessionsForTests(): void {
  for (const id of [...sessions.keys()]) {
    tearDown(id)
  }
}
