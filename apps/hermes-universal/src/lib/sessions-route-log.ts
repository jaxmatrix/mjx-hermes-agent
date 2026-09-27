/**
 * WebView breadcrumbs for the phone Sessions route. Prefix is stable so
 * `scripts/adb-debug.mjs logcat` (chromiumConsole + hermes) can filter them.
 * Host only — never tokens or full URLs with query.
 */
import { $activeConnection } from '@/store/active-connection'

function activeConnectionHost(): string {
  const base = $activeConnection.get()?.connection?.baseUrl

  if (!base) {
    return '(none)'
  }

  try {
    return new URL(base).host
  } catch {
    return '(bad-url)'
  }
}

export function logSessionsRoute(event: string, detail: Record<string, unknown> = {}): void {
  const active = $activeConnection.get()

  console.warn('[hermes-sessions]', event, {
    connectionId: active?.connectionId ?? null,
    host: activeConnectionHost(),
    ...detail
  })
}
