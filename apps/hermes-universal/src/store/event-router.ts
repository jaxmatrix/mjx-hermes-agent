/**
 * THE gateway event router — the single consumer of the event stream.
 *
 * Every frame the gateway sends is attributed: `tui_gateway/server.py`'s
 * `_event_frame` stamps `session_id` unconditionally, and N concurrent sessions
 * multiplex over one socket. So the client's only job is to demux honestly:
 * resolve which session owns an event, fold it into THAT session's slice, and
 * fire side effects at the right scope.
 *
 * Two rules make cross-session bleed structurally impossible rather than merely
 * guarded (MJX-132):
 *
 *  1. Ownership is resolved against `$activeSessionKey`, which is NEVER null.
 *     The previous code compared against `$sessionId`, which is null on a draft
 *     chat — so its "does this event belong to me?" test silently passed for
 *     every foreign session, and a background turn painted into the empty chat
 *     the user was looking at.
 *  2. Unknown sessions FAIL CLOSED. The one exception is a blocking prompt: the
 *     Python side is parked in `_block` waiting for a response, so dropping one
 *     hangs that agent until it times out.
 */

// Side-effect import: wires live-tail reconciliation and the crash journal to
// the session store. It has no call site of its own, and the router is the
// module guaranteed to be loaded whenever a turn can run.
import '@/store/turn-hydration'

import { burstVibeHearts } from '@/components/chat/vibe-hearts'
import type { GatewayEvent } from '@/gateway'
import { translateNow } from '@/i18n'
import { coerceText } from '@/lib/chat-messages'
import { coerceThinkingText } from '@/lib/chat-runtime'
import { type GatewayToolPayload, toolIdFromPayload } from '@/lib/chat-tool-parts'
import { playCompletionSound } from '@/lib/completion-sound'
import { resolveGatewayEventSessionId } from '@/lib/gateway-events'
import { triggerHaptic } from '@/lib/haptics'
import { queryClient } from '@/lib/query-client'
import { invalidateSlashCompletions } from '@/lib/slash-completion-cache'
import { type DeltaChannel, flushDeltas, queueDelta, setStreamBatchSink } from '@/lib/stream-batch'
import { prettyName } from '@/lib/text'
import { stopSpeaking } from '@/lib/tts'
import { type AgentNoticePayload, clearAgentNotice, nativeNoticeInput, showAgentNotice } from '@/store/agent-notices'
import { reconcileApprovalModeForProfile } from '@/store/approval-mode'
import { ackApprovalReceived, readApprovalPayload } from '@/store/approvals'
import { clearBillingBlock, surfaceBillingBlock } from '@/store/billing-block'
import { noteMissedSteer } from '@/store/chat'
import { normalizeQuestions, readChoices, readLockedAnswers } from '@/store/clarify'
import { routeCompactionEvent } from '@/store/compaction'
import { addGatewayEventListener, requestGateway } from '@/store/gateway'
import {
  notifyCronChanged,
  notifyPairingChanged,
  notifyPetChanged,
  notifyPlatformsChanged,
  notifySessionsChanged,
  type PetChangeMeta,
  setChangeEventsAvailable
} from '@/store/live-sync'
import { readMcpSetupRequest } from '@/store/mcp-setup'
import { dispatchNativeNotification } from '@/store/native-notifications'
import { notify } from '@/store/notifications'
import { applyBridgeLayoutPreset, revealBridgePane } from '@/store/pane-focus'
import { flashPetActivity, setPetActivity } from '@/store/pet'
import { $activeGatewayProfile } from '@/store/profile'
import {
  clearAllPrompts,
  clearSessionClarify,
  clearSessionMcpSetup,
  clearSessionSecret,
  clearSessionSudo,
  sessionAwaitingInput,
  sessionMcpSetupRequest,
  sessionSecretRequest,
  sessionSudoRequest,
  setSessionApproval,
  setSessionClarify,
  setSessionMcpSetup,
  setSessionSecret,
  setSessionSudo
} from '@/store/prompts'
import { applyReactionEvent } from '@/store/reactions'
import { EMPTY_USAGE, reduceSessionState } from '@/store/session-reducer'
import {
  $activeSessionKey,
  $sessionStates,
  ensureSessionSlice,
  runtimeKeyForStoredSession,
  updateSession
} from '@/store/session-state-types'
import { pruneFinishedSessionSubagents, upsertSubagent } from '@/store/subagents'
import { recordToolDiff } from '@/store/tool-diffs'
import { routeTurnEvent, startTurnReconciler } from '@/store/turn-lifecycle'
// Leaf import (not the `@/themes` barrel) to keep the ThemeProvider module graph
// out of the gateway event hot path — same reason desktop does it.
import { ingestBackendSkin } from '@/themes/backend-sync'
import type { HermesSkin } from '@/themes/skin-contract'
import type { ContextBreakdown, MessageReaction } from '@/types/hermes'

// Self-register at import. Nothing else consumes the gateway's event stream, so
// if this module is loaded but not listening the app silently receives nothing —
// too important to depend on some UI module happening to be in the import graph.
// `store/gateway.ts` deliberately does NOT import this file (a static import
// there reorders module init and trips the `@/hermes` `_apiProfile` TDZ cycle in
// tests), which is why registration is pushed rather than pulled.
addGatewayEventListener(event => routeGatewayEvent(event))

// The session that owns the current unscoped stream — pinned on message.start,
// released on message.complete/error (see lib/gateway-events).
let unscopedStreamSessionId: null | string = null

/** Forget the unscoped-stream pin. Called on chat reset, session promote,
 *  gateway reconnect and profile switch — anywhere the stream's owner is no
 *  longer meaningful. */
export function resetUnscopedStreamPin(): void {
  unscopedStreamSessionId = null
}

/** Events that are about the app, not about one conversation — they are handled
 *  whether or not their session is known to us. */
const GLOBAL_EVENT_TYPES = new Set([
  'cron.changed',
  'gateway.ready',
  // Agent notices (credits usage / depleted / restored) describe the ACCOUNT, not
  // a conversation. The gateway still stamps them with whichever session happened
  // to trigger them, so routing them per-session would let the fail-closed
  // unknown-session guard swallow the very notice that says the account is out of
  // money. Handled globally, exactly as desktop shows them regardless of focus.
  'notification.clear',
  'notification.show',
  'pairing.changed',
  'pet.changed',
  'platforms.changed',
  'session.title',
  'sessions.changed',
  'skin.changed'
])

/** The change watcher's broadcasts (`tui_gateway/server.py`
 *  `_broadcast_watched_changes`), mapped to the live-sync tick each one bumps.
 *  `pet.changed` is handled on its own — it is the only one with a payload. */
const CHANGE_EVENT_NOTIFIERS: Record<string, (() => void) | undefined> = {
  'cron.changed': notifyCronChanged,
  'pairing.changed': notifyPairingChanged,
  'platforms.changed': notifyPlatformsChanged,
  'sessions.changed': notifySessionsChanged
}

/** Blocking prompts: never dropped, because the agent is parked waiting. */
const BLOCKING_PROMPT_TYPES = new Set([
  'approval.request',
  'clarify.request',
  // `setup_mcp` parks the run loop for TEN minutes (`_block(..., timeout=600)`),
  // the longest of any bridge. It belongs in this set for the same reason the
  // other four do: without it the fail-closed guard below drops the frame for a
  // session this client has no slice for — a background turn, a cold reattach —
  // and the agent waits out the whole budget with nothing on screen to answer.
  'mcp.setup.request',
  'secret.request',
  'sudo.request'
])

/** The batched streaming channels, by event type. */
const DELTA_CHANNELS: Record<string, DeltaChannel | undefined> = {
  'message.delta': 'assistant',
  'reasoning.delta': 'reasoning',
  'thinking.delta': 'reasoning'
}

// A flushed batch goes back through the SAME reducer a single delta would have,
// as one coalesced delta — so batching stays a scheduling concern and never
// becomes a second copy of the append logic. The text was already coerced per
// chunk at queue time, hence `reasoning.batch` rather than `reasoning.delta`.
setStreamBatchSink((key, channel, text) => {
  const type = channel === 'assistant' ? 'message.delta' : 'reasoning.batch'

  updateSession(key, state => reduceSessionState(state, { type } as GatewayEvent, { text }))
})

/**
 * Pull the live context breakdown for the statusbar label after a settled turn.
 * The ContextUsagePanel fetches its own breakdown on open; this only feeds the
 * label. Best-effort — keep the prior value on failure.
 */
async function refreshSessionUsage(key: string): Promise<void> {
  const sessionId = $sessionStates.get()[key]?.runtimeSessionId

  if (!sessionId) {
    return
  }

  try {
    const b = await requestGateway<ContextBreakdown>('session.context_breakdown', { session_id: sessionId })

    updateSession(key, state => ({
      ...state,
      // MERGED over whatever the turn's live `session.usage` ticks left behind.
      // This used to spread only `EMPTY_USAGE`, so the settle zeroed `calls`,
      // `input` and `output` — the breakdown RPC does not report them — and the
      // context panel's fallback row read 0 calls on every finished turn.
      usage: {
        ...EMPTY_USAGE,
        ...state.usage,
        context_max: b.context_max,
        context_percent: b.context_percent,
        context_used: b.context_used,
        total: b.context_used ?? 0
      }
    }))
  } catch {
    /* leave the prior usage in place */
  }
}

// See the tool.complete case: lazy to avoid an event-router ↔ workspace-events cycle.
async function notifyWorkspaceChangeFromTool(payload: Record<string, unknown>): Promise<void> {
  const { notifyWorkspaceChanged, toolChangedPath, toolMayMutateFiles } = await import('@/store/workspace-events')

  if (toolMayMutateFiles(payload)) {
    notifyWorkspaceChanged(toolChangedPath(payload))
  }
}

/** Live auto-title push (the titler runs async, after the turn). Patches the
 *  owning session's live title and the sidebar list entry. */
function applySessionTitle(payload: Record<string, unknown>): void {
  const sid = coerceText(payload.session_id)
  const title = coerceText(payload.title).trim()

  if (!title) {
    return
  }

  // `session.title` carries a STORED id, so resolve through the reverse index
  // rather than comparing it to a runtime id (which never matched — the old code
  // tested `sid === $sessionId.get()`, so the live title landed on the wrong
  // chat or, more often, on none).
  const key = sid ? runtimeKeyForStoredSession(sid) : $activeSessionKey.get()

  if (key) {
    updateSession(key, state => ({ ...state, liveTitle: title }))
  }

  if (sid) {
    // Dynamic import — store/session imports this graph, so a static import
    // here would cycle.
    void import('@/store/session')
      .then(m => m.setSessions(prev => prev.map(s => (s.id === sid ? { ...s, title } : s))))
      .catch(() => {})
  }
}

/** Fold one gateway event into the session that owns it. */
export function routeGatewayEvent(event: GatewayEvent): void {
  // Arm reconnect reconciliation on the first frame rather than at import.
  // A socket that drops mid-turn and comes back is the window where a terminal
  // frame goes missing, and this is the first moment we know there is a socket
  // at all — modules that import the router without ever seeing an event (the
  // store tests, which partially mock `@/store/gateway`) never subscribe.
  startTurnReconciler()

  const payload = (event.payload ?? {}) as Record<string, unknown>

  if (GLOBAL_EVENT_TYPES.has(event.type)) {
    const notifyChanged = CHANGE_EVENT_NOTIFIERS[event.type]

    if (notifyChanged) {
      // A watched on-disk signature moved. Bump the tick the former pollers now
      // subscribe to (store/live-sync.ts) — the payload is empty for all of
      // these, the event itself IS the information.
      notifyChanged()
    } else if (event.type === 'pet.changed') {
      // The one change event with a payload: `pet.info.meta`-shaped, so the pet
      // can skip the heavy spritesheet refetch when it already says enabled=false.
      notifyPetChanged(payload as unknown as PetChangeMeta)
    } else if (event.type === 'session.title') {
      applySessionTitle(payload)
    } else if (event.type === 'notification.show') {
      // Driver-agnostic agent notice (credits usage / grant / depleted /
      // restored from `agent/credits_tracker.py`). The Ink TUI renders these in
      // its status bar; we render them as toasts. The notice key doubles as the
      // toast id, so the escalating 50→75→90 credits line replaces in place
      // instead of stacking.
      const notice = payload as AgentNoticePayload

      showAgentNotice(notice)

      // The urgent pair (access paused / restored) also breaks through as a
      // native OS notification when Hermes is backgrounded; dispatch is gated by
      // the user's notification prefs + the backgrounded check.
      const native = nativeNoticeInput(notice, translateNow('notifications.native.creditsTitle'))

      if (native) {
        dispatchNativeNotification(native)
      }

      // A credits crossing moves the account balance. Settings → Billing polls
      // `billing.state` every 30s; nudge it so the page reflects the crossing
      // immediately instead of up to 30s late.
      if (notice.key?.startsWith('credits.')) {
        void queryClient.invalidateQueries({ queryKey: ['billing', 'state'] })
      }
    } else if (event.type === 'notification.clear') {
      // Key-matched dismissal (e.g. credits restored clears the depleted
      // notice). notify() keys the toast by the notice key, so this maps
      // straight to dismissNotification(key).
      clearAgentNotice((payload as AgentNoticePayload).key)
    } else if (event.type === 'gateway.ready') {
      // Does this backend broadcast change events at all? Consumers drop to a
      // slow backstop poll when it does and keep the legacy cadence when it
      // doesn't, so an older gateway never goes dark.
      setChangeEventsAvailable((payload as { change_events?: boolean }).change_events === true)
      // Seed the active skin into the theme registry WITHOUT applying, so a fresh
      // connect never overrides the user's persisted theme. Note the shape: here
      // the skin is nested, on `skin.changed` the payload IS the skin.
      ingestBackendSkin((payload as { skin?: HermesSkin }).skin, { apply: false })
    } else if (event.type === 'skin.changed') {
      // A runtime switch — Hermes activating a skin it authored, or `/skin` on
      // another surface. This one repaints.
      ingestBackendSkin(payload as HermesSkin, { apply: true })
    }

    return
  }

  // Resolve the owning session. `activeSessionId` is the never-null map KEY, so
  // the fallback for an unscoped stream event can never resolve to nothing.
  const route = resolveGatewayEventSessionId({
    activeSessionId: $activeSessionKey.get(),
    eventType: event.type,
    explicitSessionId: event.session_id || '',
    unscopedStreamSessionId
  })

  unscopedStreamSessionId = route.nextUnscopedStreamSessionId

  if (route.drop || !route.sessionId) {
    return
  }

  const key = route.sessionId
  const isBlockingPrompt = BLOCKING_PROMPT_TYPES.has(event.type)

  if (!(key in $sessionStates.get())) {
    // Fail closed — except for a blocking prompt, whose agent is parked in
    // `_block` and would hang until timeout if we ignored it.
    if (!isBlockingPrompt) {
      return
    }

    ensureSessionSlice(key)
  }

  const isActive = key === $activeSessionKey.get()

  // The in-flight TURN is folded before anything else, including the batched
  // deltas below — a consumer reacting to a transcript write (the crash journal,
  // the compaction gate) must see the turn state that matches the frame it is
  // reacting to, not the one from the frame before. Cheap: the fold returns the
  // same record unless something actually changed (store/turn-lifecycle.ts).
  routeTurnEvent(key, event)
  // Compaction is silent on the wire — no `message.start`, no visible output —
  // so its start/end is inferred from `status.update` kinds plus the first real
  // output that follows (store/compaction.ts). Folded here, before the delta
  // short-circuit, because that first output is usually a delta.
  routeCompactionEvent(key, event.type, payload)

  // Streaming text is BATCHED (lib/stream-batch) — one React commit per flush
  // window instead of one per token, which matters most when several sessions
  // stream at once. Everything else applies immediately, so any non-delta event
  // must flush this session's queue first: otherwise a queued token would land
  // after the tool row that actually came after it.
  const channel = DELTA_CHANNELS[event.type]

  if (channel) {
    if (isActive && channel === 'reasoning') {
      setPetActivity({ reasoning: true }) // pet: thinking pose
    }

    queueDelta(key, channel, channel === 'reasoning' ? coerceThinkingText(payload.text) : coerceText(payload.text))

    return
  }

  flushDeltas(key)

  // --- Per-session blocking prompts ----------------------------------------
  switch (event.type) {
    case 'approval.request': {
      // One reader for the event and for the `approval.pending` /
      // `pending_approval` replays — they are the same payload
      // (`_approval_request_payload`), and a client that parsed them
      // differently would answer a replayed approval with a different
      // request_id than the live one.
      const approval = readApprovalPayload(payload)

      setSessionApproval(key, approval)
      // Session-scoped: `approval.received` resolves through `_sess()`, so it
      // needs the runtime id the gateway knows, which is this event's session.
      void ackApprovalReceived(key, approval.requestId)
      dispatchNativeNotification({
        kind: 'approval',
        title: translateNow('notifications.native.approvalTitle'),
        body: coerceText(payload.command) || coerceText(payload.description),
        sessionId: key
      })
      void triggerHaptic('warning')

      break
    }

    case 'clarify.request': {
      // The gateway sends `question` + `choices` — NOT `prompt`; the other keys
      // are tolerated only as a fallback.
      const requestId = coerceText(payload.request_id)
      // A BATCH clarify (2–5 independent questions, `tools/clarify_tool.py`)
      // carries `questions[]` and NO top-level `question` at all. Testing only
      // for `question` dropped the whole event on the floor: nothing wrote the
      // prompt store, nothing ever called `clarify.respond`, and the agent sat
      // in the backend's `_block` for the full clarify deadline with the UI
      // showing a contentless "needs input" dot. The tool advertises the batch
      // form in its schema on EVERY session, so any model could hang any turn.
      const questions = normalizeQuestions(payload.questions)
      const question = coerceText(payload.question) || coerceText(payload.prompt) || coerceText(payload.message)

      if (requestId && (question || questions.length > 0)) {
        // Normalized here, not in the panel: this is the PRIMARY source for the
        // choice list (`tool.start` ships no args), so a blank / multi-line /
        // 4KB entry from a sloppy tool call would reach the renderer unguarded.
        setSessionClarify(
          key,
          questions.length > 0
            ? {
                requestId,
                question: '',
                choices: null,
                questions,
                // Present only on a resume replay of a partly-answered batch
                // (`_pending_clarify_request_payload`), never on a live event.
                lockedAnswers: readLockedAnswers(payload.answers)
              }
            : {
                requestId,
                question,
                choices: readChoices('gateway', question, payload.choices),
                ...(payload.multi_select === true ? { multiSelect: true } : {})
              }
        )
        dispatchNativeNotification({
          kind: 'input',
          title: translateNow('notifications.native.inputTitle'),
          body: questions.length > 0 ? questions.map(entry => entry.question).join(' · ') : question,
          sessionId: key
        })
        void triggerHaptic('warning')
      }

      break
    }

    // Shape-gated like `clarify.request` above: the payload is
    // `{server, action, reason, request_id}` (`_block("mcp.setup.request", …)`),
    // and a frame missing either identifier is unrenderable rather than
    // half-renderable — see `readMcpSetupRequest`.
    case 'mcp.setup.request': {
      const request = readMcpSetupRequest(payload)

      if (request) {
        setSessionMcpSetup(key, request)
        dispatchNativeNotification({
          kind: 'input',
          title: translateNow('notifications.native.inputTitle'),
          body: request.reason || prettyName(request.server),
          sessionId: key
        })
        void triggerHaptic('warning')
      }

      break
    }

    case 'sudo.request':
      setSessionSudo(key, {
        requestId: coerceText(payload.request_id),
        prompt: coerceText(payload.prompt) || coerceText(payload.command) || 'Enter your sudo password'
      })

      break

    case 'secret.request':
      setSessionSecret(key, {
        requestId: coerceText(payload.request_id),
        envVar: coerceText(payload.env_var),
        prompt: coerceText(payload.prompt) || coerceText(payload.message)
      })

      break
    // The gateway TELLS us when a blocking prompt dies. `_block()` emits
    // `<name>.expire` for every request type whose responder is `allow_expired`
    // (`tui_gateway/server.py`) the moment its wait gives up and the tool is
    // handed an empty answer. Nothing here consumed it, so the bar sat there
    // over a tool that had already been cancelled — and, worse,
    // `$activeSessionAwaitingInput` kept calling the turn "parked on the user",
    // which is exactly what makes Esc refuse to interrupt (see the clarify clear
    // on `tool.complete` below, which fixed the same thing one prompt over).
    //
    // Matched on request_id so a SECOND prompt that arrived while the first was
    // expiring is never torn down with it. `sudo.request` / `secret.request` are
    // the only two of the six expiring types with a UI here; `clarify.expire` is
    // deliberately NOT handled — `tool.complete` already clears that request,
    // and dropping it out from under a live inline panel would strand it on its
    // loading spinner in the one case the event exists for (a reconnect that ate
    // `tool.complete`), where the panel today still routes a late answer into
    // the composer.
    case 'secret.expire': {
      const requestId = coerceText(payload.request_id)

      if (requestId && sessionSecretRequest(key).get()?.requestId === requestId) {
        clearSessionSecret(key)
      }

      break
    }

    case 'sudo.expire': {
      const requestId = coerceText(payload.request_id)

      if (requestId && sessionSudoRequest(key).get()?.requestId === requestId) {
        clearSessionSudo(key)
      }

      break
    }

    // Unlike `clarify.expire` (deliberately unhandled — see above), this one IS
    // consumed. The reasoning that keeps a clarify panel alive on its spinner
    // does not transfer: a clarify's late answer still routes somewhere useful
    // (the composer drafts it as a follow-up), whereas an expired setup card can
    // only offer to install a server the agent has already given up waiting for,
    // and every button on it would run a real install against a tool that has
    // already returned `unanswered`. Ten minutes is also long enough that the
    // `tool.complete` clear below can be a long way off on a slow reconnect.
    case 'mcp.setup.expire': {
      const requestId = coerceText(payload.request_id)

      if (requestId && sessionMcpSetupRequest(key).get()?.requestId === requestId) {
        clearSessionMcpSetup(key)
      }

      break
    }

    case 'message.start':
      // A fresh turn on this session optimistically clears its billing wall; if
      // credits are still exhausted the next failure re-raises it.
      clearBillingBlock(key)

      // Retire the previous turn's settled subagents from the spawn tree.
      // Nothing else removes a row short of leaving the session, so without
      // this a long-lived session's tree grows for every subagent it ever ran.
      // Background subagents still running are kept — they outlive the turn
      // that spawned them and must keep receiving progress events.
      pruneFinishedSessionSubagents(key)

      break

    // A correction the gateway ACCEPTED as a deferred steer and never got to
    // deliver: the turn ended before another tool batch ran, so the words are
    // requeued as a fresh turn instead. Scoped to the session that emitted it —
    // the bubble to move lives in THAT transcript, not the visible one.
    case 'steer.missed':
      noteMissedSteer(key, coerceText(payload.text))

      break

    case 'message.complete':
      clearAllPrompts(key)

      // Structured billing wall forwarded by the gateway (out of credits /
      // payment required) — `tui_gateway/server.py` attaches the descriptor built
      // by `agent/billing_links.py` as `payload.billing`. Cached + toasted by the
      // store; detection stays backend-only, we never re-classify error prose.
      if (payload.billing) {
        surfaceBillingBlock(key, payload.billing)
      }

      dispatchNativeNotification({
        kind: 'turnDone',
        title: translateNow('notifications.native.turnDoneTitle'),
        body: translateNow('notifications.native.turnDoneBody'),
        sessionId: key
      })
      // A turn finishing is worth hearing whichever session produced it — that
      // is the point of running several at once. (Gated by $hapticsMuted.)
      playCompletionSound()
      // Scoped to the session that settled, so a background completion can't
      // overwrite the visible chat's context-usage readout.
      void refreshSessionUsage(key)

      break
    /**
     * `status.update` is TWO things on one event name, and only one of them is
     * transient narration.
     *
     * `_status_update` (`tui_gateway/server.py`) tags the frame with the kind
     * its producer used. `status` / `lifecycle` / `compacting` / `goal` are the
     * agent talking about what it is doing right now — the reducer folds those
     * into `statusLine`, the chat renders them while busy, and each one
     * overwrites the last. That is correct for narration and WRONG for the one
     * kind that is not narration.
     *
     * `warn` is `AIAgent._emit_warning` (`run_agent.py`) — the channel for
     * "the main turn can continue but the user needs to know something
     * important failed", and it is DEDUPED at the source precisely because the
     * backend expects each one to be seen once and remembered. The whole family
     * arrives here: the mid-turn uncompressed-context overflow guardrail when
     * compression is disabled ("use /compact or enable compression",
     * `_warn_uncompressed_context_overflow`), compression blocked by cooldown
     * or anti-thrashing, a compression timeout or commit overrun, an auxiliary
     * task failure, and the session turn-lease timeout — the one message that
     * explains why a submitted turn was never processed.
     *
     * Every one of them was folded into `statusLine` and gone by the next
     * frame, so the actionable half of each ("run /compact", "send it again")
     * was unreachable. Raise them as sticky warning toasts instead: `warning`
     * has no auto-dismiss duration (`store/notifications.ts`), so the user
     * dismisses it, not a timer.
     *
     * NOT under the `isActive` gate below: a background session warning that it
     * is about to stop answering is exactly the one the user cannot see for
     * themselves. Keyed per session so a newer warning for the same session
     * replaces the older one in place instead of stacking — the backend's dedup
     * means a fresh frame is a fresh problem.
     */
    case 'status.update': {
      if (coerceText(payload.kind) === 'warn') {
        const text = coerceText(payload.text).trim()

        if (text) {
          notify({ id: `agent-warn:${key}`, kind: 'warning', message: text })
        }
      }

      break
    }

    case 'error':
      clearAllPrompts(key)
      dispatchNativeNotification({
        kind: 'turnError',
        title: translateNow('notifications.native.turnErrorTitle'),
        body: coerceText(payload.message),
        sessionId: key
      })

      break
    case 'tool.complete': {
      // Live side-channel diff: the gateway renders the edit diff itself and
      // ships it on tool.complete (server.py `_on_tool_complete`). The renderer
      // prefers this over one parsed out of the result, keyed by the SAME id the
      // part adopted in upsertToolPart.
      const inlineDiff = coerceText(payload.inline_diff)

      if (inlineDiff.trim()) {
        recordToolDiff(toolIdFromPayload(payload as GatewayToolPayload), inlineDiff)
      }

      // The agent just created/deleted/renamed a skill, which adds or removes
      // its `/name` command. Drop the composer's cached `/` list so the new
      // skill is offerable now rather than after the hour-long TTL.
      if (payload.name === 'skill_manage') {
        invalidateSlashCompletions()
      }

      // The clarify tool RETURNING is its request's terminal event, and the one
      // signal every ending shares: answered, timed out (`_block` gives up and
      // returns ""), or released by `session.interrupt`'s `_clear_pending`.
      // Only the answered path cleared the request (`respondClarify`), so the
      // other two left a phantom parked clarify until `message.complete` — and
      // `$activeSessionAwaitingInput` is what makes Esc decline to interrupt a
      // turn that is "waiting on the user", so Esc stayed dead for the rest of a
      // turn whose question had already expired. The settled row renders from
      // its own result, so nothing on screen still needs the request.
      if (payload.name === 'clarify') {
        clearSessionClarify(key)
      }

      // Same terminal-event reasoning for the setup card: the tool returning is
      // the one signal shared by answered, timed out and interrupted. Only the
      // answered path clears the request itself, so without this an interrupted
      // turn leaves a phantom card that `$activeSessionAwaitingInput` keeps
      // calling "parked on the user" — which is what makes Esc refuse to
      // interrupt for the rest of the turn.
      if (payload.name === 'setup_mcp') {
        clearSessionMcpSetup(key)
      }

      // A file-mutating tool just finished — nudge the git-mirroring surfaces
      // (coding rail, review pane, file tree) to refresh. Event-driven, not
      // polled: fires exactly when the agent touches the tree.
      void notifyWorkspaceChangeFromTool(payload)

      break
    }

    // The agent revealed a pane through its own `focus_pane` tool, in response
    // to an explicit user request. ACTIVE session only — desktop's
    // `isActiveEvent` gate, i.e. "offer, don't hijack": a background turn must
    // never move the focus of the chat the user is looking at.
    //
    // Fire-and-forget: `tools/desktop_ui.py::emit` has no respond method, so an
    // unknown pane id is simply not revealed (`revealBridgePane` returns false)
    // and the tool has already told the agent `{"success": true}`. The enum is
    // closed backend-side, so an unknown id means a version skew, not a typo.
    case 'pane.reveal': {
      if (isActive) {
        revealBridgePane(typeof payload.pane === 'string' ? payload.pane : '')
      }

      break
    }

    // The agent applied a layout preset through its own `apply_layout` tool.
    // Same contract as pane.reveal, and the preset resolves against the SAME
    // layouts registry the picker reads — so core, plugin and user-saved
    // presets are all addressable.
    case 'layout.apply': {
      if (isActive) {
        applyBridgeLayoutPreset(typeof payload.preset === 'string' ? payload.preset : '')
      }

      break
    }

    // The agent reacted to a message through its own `react_to_message` tool.
    // Already persisted server-side — this only paints it now rather than at
    // the next resume. Scoped to the session that emitted it, like every other
    // transcript write above: a background agent's tapback belongs on ITS
    // transcript, not on whichever chat happens to be open.
    case 'message.reaction': {
      const rowId = payload.row_id

      if (typeof rowId === 'number') {
        applyReactionEvent(
          key,
          rowId,
          payload.role === 'assistant' ? 'assistant' : 'user',
          Array.isArray(payload.reactions) ? (payload.reactions as MessageReaction[]) : []
        )
      }

      break
    }

    default:
      // Subagent lifecycle (spawn/start/thinking/tool/progress/complete) feeds
      // the Agents view's spawn tree, keyed by the session that OWNS it — the
      // old code keyed every tree on the active session (or the literal
      // 'active'), so a background session's agents showed up under whichever
      // chat happened to be open.
      if (event.type.startsWith('subagent.')) {
        const createIfMissing = event.type === 'subagent.spawn_requested' || event.type === 'subagent.start'
        upsertSubagent(key, payload, createIfMissing, event.type)
      }

      break
  }

  // --- The transcript ------------------------------------------------------
  updateSession(key, state => reduceSessionState(state, event, payload))

  // --- ACTIVE-session-only presentation ------------------------------------
  // The pet, TTS and the workspace cwd describe what the user is looking at, so
  // they follow the active session rather than the one that emitted the event.
  if (!isActive) {
    return
  }

  switch (event.type) {
    case 'message.start':
      setPetActivity({ busy: true }) // pet: working pose
      stopSpeaking() // interrupt any TTS from the previous turn

      break

    /**
     * The live approval indicator.
     *
     * `approvals.mode` is gateway-global config, and `$approvalModes` is a cache
     * the statusbar item fills ONCE when it mounts (`syncApprovalModeForProfile`
     * in `app/shell/approval-mode-menu.tsx`). Every other writer is a local
     * action — this app's own `/approvals` run or its Settings save — so a mode
     * changed anywhere else (the TUI, the web dashboard, `PUT /api/config`, a
     * second Hermes window) left the zap glyph showing the mode from mount time
     * for the rest of the session, i.e. it claimed approvals were on while the
     * backend auto-approved every dangerous command.
     *
     * The backend now pushes for exactly this: `broadcast_session_info()`
     * (`tui_gateway/server.py`) re-emits `session.info` to every live session
     * whenever `approvals.mode` moves, mid-turn included. `_session_info` stamps
     * `approval_mode` (the persisted mode) and `yolo` (the EFFECTIVE bypass —
     * that mode OR the frozen env OR the per-session flag) on every frame.
     *
     * Scoped like desktop's `handleSessionInfoEvent`: only the ACTIVE session's
     * frame may reconcile the foreground cache, since the cache is keyed by
     * gateway profile and background sessions can belong to another one.
     */
    case 'session.info':
      if (typeof payload.approval_mode === 'string') {
        reconcileApprovalModeForProfile($activeGatewayProfile.get(), payload.approval_mode)
      }

      if (typeof payload.yolo === 'boolean') {
        // `$yoloActive` is what `/yolo` toggles against, so an un-synced copy
        // makes the first press after connecting a no-op (it flips a stale
        // `false` to `true` while the backend was already bypassing). Lazy
        // import: `store/session` imports this module's graph — same reason
        // `applySessionTitle` above defers it.
        const yolo = payload.yolo

        void import('@/store/session').then(m => m.setYoloActive(yolo)).catch(() => {})
      }

      break

    case 'reasoning.available':

    case 'reasoning.delta':

    // The whole MoA family is thinking, not tool work — including the two
    // progress frames, which are the only sign of life during a fan-out that
    // emits no reference bodies until every reference has returned.
    case 'moa.aggregating':

    case 'moa.phase':

    case 'moa.progress':

    case 'moa.reference':
      setPetActivity({ reasoning: true }) // pet: thinking pose

      break

    case 'tool.start':

    case 'tool.progress':

    case 'tool.generating':
      setPetActivity({ reasoning: false, toolRunning: true }) // pet: working pose

      break

    case 'tool.complete':
      setPetActivity({ toolRunning: false })

      break

    case 'message.complete':
      setPetActivity({ busy: false, reasoning: false, toolRunning: false }) // pet: idle/roam
      // Auto-TTS is driven by `useAutoSpeakReplies` (guarded against a running
      // voice conversation + the shared dedupe cursor). Reading it here too
      // would speak every reply twice during a conversation (MJX-96).

      break

    case 'approval.request':

    case 'clarify.request':

    case 'mcp.setup.request':

    case 'secret.request':

    case 'sudo.request':
      setPetActivity({ awaitingInput: true }) // pet: waiting pose (blocked on user)

      break

    case 'mcp.setup.expire':

    case 'secret.expire':

    case 'sudo.expire':
      // The waiting pose is set by the four `*.request` events above and dropped
      // when one is ANSWERED (`clearAwaitingInputPose` in store/chat.ts). A
      // prompt that died unanswered took its bar with it a moment ago, so the
      // pet would otherwise keep waiting for input nobody will ever give. Guard
      // on the aggregate: this session may still have another prompt open.
      if (!sessionAwaitingInput(key).get()) {
        setPetActivity({ awaitingInput: false })
      }

      break

    case 'error':
      // pet: crying pose, auto-decaying back to normal after 5s.
      setPetActivity({ busy: false, reasoning: false, toolRunning: false })
      flashPetActivity({ error: true }, 5000)

      break

    // Core-detected affection (ily / <3 / good bot) on the user's message. It
    // belongs in this half of the router precisely because it's presentation:
    // the `isActive` gate above is desktop's `isActiveEvent`, so a background
    // turn stays quiet instead of bursting hearts over the chat on screen.
    case 'reaction':
      if ((coerceText(payload.kind) || 'vibe') === 'vibe') {
        burstVibeHearts()
      }

      break

    default:
      break
  }
}
