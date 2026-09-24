import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown> | undefined][],
  listeners: new Map<string, (payload: unknown) => void>()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    native.calls.push([command, args])

    if (command === 'pty_spawn') {
      return { shell: '/bin/zsh' }
    }

    return true
  })
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    native.listeners.set(event, payload => handler({ payload }))

    return () => {
      native.listeners.delete(event)
    }
  })
}))

import { __resetTerminalSessionsForTests, terminalBridge } from './terminal'

beforeEach(() => {
  native.calls = []
  native.listeners.clear()
  __resetTerminalSessionsForTests()
})

describe('hermesDesktop.terminal', () => {
  it('start listens before spawn and returns an Electron-shaped session', async () => {
    const session = await terminalBridge.terminal.start({ cols: 100, cwd: '/tmp', rows: 40 })

    expect(session).toMatchObject({ cwd: '/tmp', shell: '/bin/zsh' })
    expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

    expect(native.listeners.has(`pty://${session.id}/data`)).toBe(true)
    expect(native.listeners.has(`pty://${session.id}/exit`)).toBe(true)
    expect(native.calls[0]).toEqual(['pty_spawn', { id: session.id, cols: 100, rows: 40, cwd: '/tmp' }])
  })

  it('buffers data until onData attaches, then flushes', async () => {
    const session = await terminalBridge.terminal.start()
    const emit = native.listeners.get(`pty://${session.id}/data`)!

    emit(Array.from(new TextEncoder().encode('hello')))

    const seen: string[] = []
    const stop = terminalBridge.terminal.onData(session.id, chunk => seen.push(chunk))

    expect(seen).toEqual(['hello'])

    emit(Array.from(new TextEncoder().encode(' world')))
    expect(seen).toEqual(['hello', ' world'])

    stop()
  })

  it('write / resize / attach / dispose drive pty_*', async () => {
    const session = await terminalBridge.terminal.start({ cwd: '/work' })

    await expect(terminalBridge.terminal.attach(session.id)).resolves.toBe(true)
    await expect(terminalBridge.terminal.write(session.id, 'ls\n')).resolves.toBe(true)
    await expect(terminalBridge.terminal.resize(session.id, { cols: 80, rows: 24 })).resolves.toBe(true)
    await expect(terminalBridge.terminal.cwd(session.id)).resolves.toBe('/work')
    await expect(terminalBridge.terminal.dispose(session.id)).resolves.toBe(true)
    await expect(terminalBridge.terminal.attach(session.id)).resolves.toBe(false)

    expect(native.calls.slice(1)).toEqual([
      ['pty_write', { id: session.id, data: 'ls\n' }],
      ['pty_resize', { id: session.id, cols: 80, rows: 24 }],
      ['pty_kill', { id: session.id }]
    ])
  })

  it('onExit delivers a null code/signal payload', async () => {
    const session = await terminalBridge.terminal.start()
    const payloads: unknown[] = []

    terminalBridge.terminal.onExit(session.id, payload => payloads.push(payload))
    native.listeners.get(`pty://${session.id}/exit`)!(undefined)

    expect(payloads).toEqual([{ code: null, signal: null }])
  })
})
