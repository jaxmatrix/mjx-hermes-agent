/**
 * MJXHRM-452 — "Open in terminal".
 *
 * Hands the session's project directory to the OS terminal — the shell the user
 * has configured, OUTSIDE the app. Not the in-app terminal rail
 * (`store/terminals.ts`), which is a portable-pty session in a Hermes pane.
 *
 * Two guards carry the whole feature: it is desktop-only (a phone has no
 * terminal emulator, and the native command is not registered on mobile), and a
 * session can outlive the directory it was started in — a deleted worktree, an
 * unmounted volume, a remote profile's path that does not exist on THIS machine.
 * The directory check itself is native, so what these pin is that a missing cwd
 * never reaches it and that a native failure is reported rather than swallowed
 * as success.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async (..._args: unknown[]) => undefined as unknown)
const platform = vi.hoisted(() => ({ desktop: true }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof Platform>()),
  get IS_DESKTOP() {
    return platform.desktop
  }
}))

import type * as Platform from '@/lib/platform'

import { canOpenInTerminal, openPathInTerminal } from './open-in-terminal'

beforeEach(() => {
  invoke.mockClear()
  invoke.mockResolvedValue(undefined)
  platform.desktop = true
})

describe('canOpenInTerminal', () => {
  it('offers the row on desktop for a session with a directory', () => {
    expect(canOpenInTerminal('/home/b/project')).toBe(true)
  })

  it('withholds it for a detached chat with no directory', () => {
    expect(canOpenInTerminal(null)).toBe(false)
    expect(canOpenInTerminal(undefined)).toBe(false)
    expect(canOpenInTerminal('')).toBe(false)
  })

  it('withholds it off desktop, where there is no terminal to open', () => {
    platform.desktop = false

    expect(canOpenInTerminal('/home/b/project')).toBe(false)
  })
})

describe('openPathInTerminal', () => {
  it('hands the directory to the native command', async () => {
    await expect(openPathInTerminal('/home/b/project')).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('open_in_terminal', { cwd: '/home/b/project' })
  })

  it('reports a native failure instead of claiming a window opened', async () => {
    // The native side validates the directory, so this is the real shape of
    // "the worktree is gone": a rejected invoke, not a thrown-away success.
    invoke.mockRejectedValue(new Error('not a directory on this machine: /gone'))

    await expect(openPathInTerminal('/gone')).resolves.toBe(false)
  })

  it('never invokes without a directory, or off desktop', async () => {
    await expect(openPathInTerminal(null)).resolves.toBe(false)

    platform.desktop = false
    await expect(openPathInTerminal('/home/b/project')).resolves.toBe(false)

    expect(invoke).not.toHaveBeenCalled()
  })
})
