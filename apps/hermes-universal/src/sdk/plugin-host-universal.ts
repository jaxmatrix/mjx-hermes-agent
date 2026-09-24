/**
 * Universal-only host doors and state atoms. Mutates the desktop `host` object
 * in place so `@hermes/plugin-sdk` stays one instance (alias.test).
 */
import { computed, type ReadableAtom } from 'nanostores'

import { attachToSession } from '@/app/chat/attachments'
import { sessionClarifyRequest } from '@/store/clarify'
import { $connectionReady } from '@/store/connection-ready'
import { $liveSessionStatuses } from '@/store/live-session-registry'
import { sessionMcpSetupRequest } from '@/store/mcp-setup'
import { pluginConnectionSource } from '@/store/plugin-connection-source'
import {
  openCreatedPluginSession,
  openPluginSession,
  type PluginCreatedSession,
  type PluginOpenSessionOptions as StoreOpenOptions
} from '@/store/plugin-open-session'
import {
  type BindSessionOptions,
  type BindSessionResult,
  bindSessionSlice,
  releaseSessionSlice
} from '@/store/plugin-session-bind'
import {
  sessionApprovalRequest,
  sessionSecretRequest,
  sessionSudoRequest
} from '@/store/prompts'
import { refreshSessions } from '@/store/session-lifecycle'
import { setSessionOwnerLabels } from '@/store/session-owner-label'
import { $sessionKeyStates } from '@/store/session-state-types'

import { host } from './index'

export interface PluginSessionSummary {
  runtimeSessionId: string
  storedSessionId: string
}

export interface PluginSessionPromptsView {
  approval: ReturnType<typeof sessionApprovalRequest> extends ReadableAtom<infer T> ? T : never
  clarify: ReturnType<typeof sessionClarifyRequest> extends ReadableAtom<infer T> ? T : never
  mcpSetup: ReturnType<typeof sessionMcpSetupRequest> extends ReadableAtom<infer T> ? T : never
  secret: ReturnType<typeof sessionSecretRequest> extends ReadableAtom<infer T> ? T : never
  sudo: ReturnType<typeof sessionSudoRequest> extends ReadableAtom<infer T> ? T : never
}

const $pluginSessionIndex = computed($sessionKeyStates, states => {
  const rows: PluginSessionSummary[] = []

  for (const slice of Object.values(states)) {
    if (!slice.storedSessionId) {
      continue
    }

    rows.push({
      runtimeSessionId: slice.runtimeSessionId ?? '',
      storedSessionId: slice.storedSessionId
    })
  }

  return rows
})

const sessionPromptsCache = new Map<string, ReadableAtom<PluginSessionPromptsView>>()

function sessionPrompts(sessionKey: string): ReadableAtom<PluginSessionPromptsView> {
  const key = sessionKey.trim()
  let atomLike = sessionPromptsCache.get(key)

  if (!atomLike) {
    atomLike = computed(
      [
        sessionApprovalRequest(key),
        sessionClarifyRequest(key),
        sessionMcpSetupRequest(key),
        sessionSecretRequest(key),
        sessionSudoRequest(key)
      ],
      (approval, clarify, mcpSetup, secret, sudo) => ({
        approval,
        clarify,
        mcpSetup,
        secret,
        sudo
      })
    )
    sessionPromptsCache.set(key, atomLike)
  }

  return atomLike
}

function sessionMessages(sessionKey: string) {
  return $sessionKeyStates.get()[sessionKey]?.messages ?? []
}

function isUniversalOpenSession(options: Record<string, unknown>): boolean {
  return options.target !== undefined || options.focus !== undefined || options.hidden !== undefined
}

let installed = false

/**
 * Mutate desktop `host` with universal doors. Deferred past module evaluation
 * because `sdk/index` → contrib → `sdk/runtime` → `sdk/universal` → this file
 * → `sdk/index` is a cycle: reading `host.openSession` at module scope hits
 * the incomplete export (TDZ / undefined) and takes down every suite that
 * loads the runtime SDK.
 */
export function installUniversalHost(): void {
  if (installed) {
    return
  }

  // Still mid-cycle — caller will retry (microtask / installPluginSdk).
  if (typeof host?.openSession !== 'function') {
    return
  }

  installed = true

  const legacyOpenSession = host.openSession.bind(host)

  Object.assign(host.state, {
    liveSessions: $liveSessionStatuses,
    ready: $connectionReady,
    sessions: $pluginSessionIndex
  })

  Object.assign(host, {
    agents: () => pluginConnectionSource().agents(),
    connections: () => pluginConnectionSource().connections(),
    attachToSession,
    bindSession: (storedSessionId: string, options: BindSessionOptions = {}): Promise<BindSessionResult> =>
      bindSessionSlice(storedSessionId, options),
    openCreatedSession: (
      created: PluginCreatedSession,
      options: { focus?: boolean; target?: StoreOpenOptions['target'] } = {}
    ) => openCreatedPluginSession(created, options),
    openSession: async (storedSessionId: string, options: Record<string, unknown> = {}) => {
      if (isUniversalOpenSession(options)) {
        return openPluginSession(storedSessionId, options as StoreOpenOptions)
      }

      await legacyOpenSession(storedSessionId, options as Parameters<typeof legacyOpenSession>[1])

      return undefined
    },
    refreshSessions: () => refreshSessions(),
    releaseSession: (storedSessionId: string) => releaseSessionSlice(storedSessionId),
    sessionMessages,
    sessionPrompts,
    setSessionOwnerLabels
  })
}

installUniversalHost()
queueMicrotask(installUniversalHost)

export type UniversalHost = typeof host & {
  agents: () => ReturnType<typeof pluginConnectionSource> extends { agents: infer A } ? A : never
  connections: () => ReturnType<typeof pluginConnectionSource> extends { connections: infer C } ? C : never
  attachToSession: typeof attachToSession
  bindSession: (storedSessionId: string, options?: BindSessionOptions) => Promise<BindSessionResult>
  openCreatedSession: (
    created: PluginCreatedSession,
    options?: { focus?: boolean; target?: StoreOpenOptions['target'] }
  ) => ReturnType<typeof openCreatedPluginSession>
  openSession: (
    storedSessionId: string,
    options?: Record<string, unknown>
  ) => Promise<unknown>
  refreshSessions: () => Promise<void>
  releaseSession: (storedSessionId: string) => void
  sessionMessages: typeof sessionMessages
  sessionPrompts: typeof sessionPrompts
  setSessionOwnerLabels: typeof setSessionOwnerLabels
  state: typeof host.state & {
    liveSessions: typeof $liveSessionStatuses
    ready: typeof $connectionReady
    sessions: typeof $pluginSessionIndex
  }
}

/** Typed view of the mutated desktop `host` (Object.assign above). */
export const universalHost = host as UniversalHost
