/**
 * Whether the phone root should mount MobileShell (vs Connect / Connecting).
 *
 * SoftSwitch (applyConnection → emitConnectionApplied) opens the socket and
 * publishes `$activeConnection` without going through the legacy connect*
 * paths that alone used to set `$connectionPhase === 'ready'`. Gate on the
 * facts softSwitch actually establishes.
 *
 * Once the user has connected at least once (`hasConnected`), keep the shell
 * mounted across mid-session socket drops and soft switches — the top bar
 * shows reconnect status instead of swapping to GatewayConnectingScreen.
 * Cold restore (`restoring`) and first-run (never connected) still leave.
 */
export function isMobileShellLive(input: {
  activeConnection: unknown
  gatewayState: string
  hasConnected: boolean
  restoring: boolean
  /** Retained for callers; soft-switch is covered by `hasConnected`. */
  switching: boolean
}): boolean {
  if (input.restoring) {
    return false
  }

  if (input.gatewayState === 'open' && input.activeConnection != null) {
    return true
  }

  return input.hasConnected
}
