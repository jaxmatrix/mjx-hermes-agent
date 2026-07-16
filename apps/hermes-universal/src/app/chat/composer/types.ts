// Composer types (adapted, trimmed) for hermes-universal. The desktop ChatBar
// takes ~20 host-injected callbacks (Electron file pickers, steer RPC, dropped
// items, per-session model menu). Universal's composer owns its own gateway
// wiring and staged attachments, so the surface here is much smaller: a single
// `onSubmit` that routes the composed text to the gateway (see chat-screen.tsx).

export type VoiceStatus = 'idle' | 'recording' | 'transcribing'

export interface VoiceActivityState {
  elapsedSeconds: number
  level: number
  status: VoiceStatus
}

export interface ChatBarProps {
  /**
   * Route the fully-composed prompt (attachment refs spliced in) to the gateway.
   * Returns a transient notice string to surface in the composer (e.g. the
   * client-side `/skin` result), or void for a normal send/queue.
   */
  onSubmit: (text: string) => string | void
  /** Interrupt the running turn. Universal has no interrupt RPC yet — the Stop
   *  button is a visual stub (FIXME(chat-port)). */
  onCancel?: () => void
}
