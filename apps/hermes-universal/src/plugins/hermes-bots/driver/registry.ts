/**
 * The runner plug point.
 *
 * One slot, module-level, replaceable — the same registration-hook shape the
 * app uses for its own swappable seams (`setSessionRequestRouter`,
 * `setPluginConnectionSource`). The default is the webview runner; a native
 * build installs the Rust one, and a test installs a fake.
 *
 * `setRoomTurnRunner` returns a RESTORE disposer rather than a clear: a test
 * that installs a fake and forgets to restore would otherwise leave every later
 * test driving nothing, which fails somewhere else entirely.
 */

import type { RoomTurnRunner } from './types'

/** Answers `busy` to everything — never a silent success. Used only before the
 *  plugin has installed a real runner, which is a window of a few milliseconds
 *  at load and is exactly when a stray drive would be a bug. */
const NULL_RUNNER: RoomTurnRunner = {
  id: 'none',
  run: async () => ({ status: 'error' as const, message: 'no room turn runner installed' }),
  survivesSuspension: false
}

let current: RoomTurnRunner = NULL_RUNNER

export function setRoomTurnRunner(runner: RoomTurnRunner): () => void {
  const previous = current

  current = runner

  return () => {
    current = previous
  }
}

export const currentRunner = (): RoomTurnRunner => current
