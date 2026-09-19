/**
 * Electron's `hermes:connection:applied`: the primary was re-homed without a
 * reload, and the boot hook answers with `softSwitch` — wipe, then re-dial the
 * primary in place. It carries no payload; the hook asks the bridge where the
 * primary now is.
 *
 * Electron sends it after a Settings apply. Here the primary is the connection
 * the window is on (a phone has no launch backend), so whatever moves that
 * pointer emits, in the WebView whose pointer moved: each has its own bridge
 * and its own primary socket.
 *
 * A leaf, so the stores that move the pointer can import it without reaching
 * the bridge.
 */

const listeners = new Set<() => void>()

export function onConnectionApplied(callback: () => void): () => void {
  listeners.add(callback)

  return () => void listeners.delete(callback)
}

/** This window's primary now lives elsewhere. Call AFTER the pointer moved. */
export function emitConnectionApplied(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // One listener failing must not keep the re-home from the others.
    }
  }
}
