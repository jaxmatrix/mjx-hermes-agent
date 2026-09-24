/**
 * Leaf route path constants — no pane-shell / windows imports.
 *
 * `store/windows.ts` needs these strings without pulling `@/app/routes` (which
 * imports the pane tree, which imports windows — a cycle that left `modeLayout`
 * in its TDZ under Vitest). Keep navigators that also reveal panes in
 * `routes.ts`; anything that only needs the path string imports from here.
 */

export const SESSION_ROUTE_PREFIX = '/'
export const NEW_CHAT_ROUTE = '/'
export const SETTINGS_ROUTE = '/settings'
export const GATEWAY_SETTINGS_ROUTE = '/settings?tab=gateway'
export const COMMAND_CENTER_ROUTE = '/command-center'
export const SESSION_IMPORT_ROUTE = '/session-import'
export const CAPABILITIES_ROUTE = '/capabilities'
export const MESSAGING_ROUTE = '/messaging'
export const WEBHOOKS_ROUTE = '/webhooks'
export const ARTIFACTS_ROUTE = '/artifacts'
export const CRON_ROUTE = '/cron'
export const SKILLS_ROUTE = '/skills'
export const PROFILES_ROUTE = '/profiles'
export const AGENTS_ROUTE = '/agents'
export const STARMAP_ROUTE = '/starmap'

export function mcpServerRoute(server: string): string {
  return `/capabilities?tab=connectors&server=${encodeURIComponent(server.trim())}`
}
