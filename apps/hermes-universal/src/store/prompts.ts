import { atom, computed, type ReadableAtom } from 'nanostores'

import {
  $approval,
  $clarify,
  $secret,
  $sudo,
  type ApprovalRequest,
  type ClarifyRequest,
  type SecretRequest,
  type SudoRequest
} from '@/store/chat'

// The active PRIMARY turn is parked waiting on the user (a clarify / approval /
// sudo / secret prompt is open). The main composer's Esc handling reads this to
// avoid interrupting a turn that's actually waiting for input.
export const $activeSessionAwaitingInput = computed(
  [$clarify, $approval, $sudo, $secret],
  (clarify, approval, sudo, secret) => Boolean(clarify || approval || sudo || secret)
)

// ---------------------------------------------------------------------------
// Per-session (TILE) blocking prompts. The PRIMARY chat keeps the global
// `$approval`/`$clarify`/`$sudo`/`$secret` atoms above; a tiled/background
// session's blocking prompt lands here keyed by its RUNTIME id so its own
// `PromptOverlays({sessionId})` can render it instead of stalling. Mirrors
// desktop's `keyedPromptStore`.
// ---------------------------------------------------------------------------

interface KeyedPromptStore<T> {
  /** The whole map (used to compute cross-session aggregates). */
  $all: ReadableAtom<Record<string, T>>
  /** Drop every session's request. */
  clearAll: () => void
  /** A per-id readable atom (memoized) — the request for that session, or null. */
  forId: (id: string) => ReadableAtom<T | null>
  /** Set (or clear, when null) the request for a session. */
  set: (id: string, value: T | null) => void
}

function keyedPromptStore<T>(): KeyedPromptStore<T> {
  const $all = atom<Record<string, T>>({})
  const perId = new Map<string, ReadableAtom<T | null>>()

  return {
    $all,
    clearAll() {
      if (Object.keys($all.get()).length > 0) {
        $all.set({})
      }
    },
    forId(id) {
      const existing = perId.get(id)

      if (existing) {
        return existing
      }

      const derived = computed($all, all => all[id] ?? null)
      perId.set(id, derived)

      return derived
    },
    set(id, value) {
      const current = $all.get()

      if (value === null) {
        if (id in current) {
          const { [id]: _dropped, ...rest } = current
          $all.set(rest)
        }

        return
      }

      $all.set({ ...current, [id]: value })
    }
  }
}

const approvalStore = keyedPromptStore<ApprovalRequest>()
const clarifyStore = keyedPromptStore<ClarifyRequest>()
const sudoStore = keyedPromptStore<SudoRequest>()
const secretStore = keyedPromptStore<SecretRequest>()

export const sessionApprovalRequest = (id: string) => approvalStore.forId(id)
export const sessionClarifyRequest = (id: string) => clarifyStore.forId(id)
export const sessionSudoRequest = (id: string) => sudoStore.forId(id)
export const sessionSecretRequest = (id: string) => secretStore.forId(id)

export const setSessionApproval = (id: string, req: ApprovalRequest | null) => approvalStore.set(id, req)
export const setSessionClarify = (id: string, req: ClarifyRequest | null) => clarifyStore.set(id, req)
export const setSessionSudo = (id: string, req: SudoRequest | null) => sudoStore.set(id, req)
export const setSessionSecret = (id: string, req: SecretRequest | null) => secretStore.set(id, req)

export const clearSessionApproval = (id: string) => approvalStore.set(id, null)
export const clearSessionClarify = (id: string) => clarifyStore.set(id, null)
export const clearSessionSudo = (id: string) => sudoStore.set(id, null)
export const clearSessionSecret = (id: string) => secretStore.set(id, null)

/** All per-session blocking prompts cleared — for one session (id) or all. */
export function clearAllPrompts(id?: string): void {
  if (id) {
    clearSessionApproval(id)
    clearSessionClarify(id)
    clearSessionSudo(id)
    clearSessionSecret(id)

    return
  }

  approvalStore.clearAll()
  clarifyStore.clearAll()
  sudoStore.clearAll()
  secretStore.clearAll()
}

/** Whether a specific (tiled) session's turn is parked on a blocking prompt. */
export function sessionAwaitingInput(id: string): ReadableAtom<boolean> {
  return computed(
    [approvalStore.forId(id), clarifyStore.forId(id), sudoStore.forId(id), secretStore.forId(id)],
    (approval, clarify, sudo, secret) => Boolean(approval || clarify || sudo || secret)
  )
}
