/**
 * `@hermes/plugin-sdk` as universal serves it: desktop's barrel, verbatim, plus
 * what only universal has.
 */
import './plugin-host-universal'

import { host } from './index'
import type { UniversalHost } from './plugin-host-universal'

export * from './index'
export type { UniversalHost } from './plugin-host-universal'

/**
 * Same object as desktop `host` (mutated in place by `installUniversalHost`).
 * Typed here — not in `plugin-host-universal` — so that module never reads the
 * `host` binding during the index↔runtime↔universal cycle (Android TDZ).
 */
export const universalHost: UniversalHost = host as unknown as UniversalHost

export { SessionThread } from '@/app/chat/session-thread'
export { CONTEXT_MENU_ITEMS_AREA } from '@/app/context-menu/contrib'
export { registerContextTarget } from '@/app/context-menu/registry'
export { startPointerDrag } from '@/lib/pointer-drag'
export { createTap, isCoarsePointer } from '@/lib/touch'
export { confirm } from '@/store/confirm'
export { confirmDelete } from '@/store/confirm-delete'
export { holdKeepAwake } from '@/store/keep-awake'
export { livePollIntervalMs } from '@/store/live-poll'
export {
  type PluginAgent,
  type PluginAgentRoster,
  type PluginConnection,
  setPluginConnectionSource
} from '@/store/plugin-connection-source'
export type {
  PluginCreatedSession,
  PluginOpenSessionResult,
  PluginOpenSessionOptions as UniversalOpenSessionOptions
} from '@/store/plugin-open-session'
