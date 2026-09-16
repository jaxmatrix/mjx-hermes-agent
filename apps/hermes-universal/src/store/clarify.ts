/**
 * Clarify-choice hygiene.
 *
 * The pending request itself lives in `store/prompts.ts` alongside the other
 * blocking prompts (that is what makes it survive a session rekey — see
 * MJXHRM-207). What lives HERE is the part desktop keeps in its own
 * `store/clarify.ts`: making a choice list safe to render, and answering a
 * clarify without answering it.
 *
 * Choices come from a model's tool call, so they are only as well-formed as the
 * model made them. A blank entry renders an unlabelled button, a multi-line one
 * breaks the single-row layout, and a 4KB one pushes the panel off screen —
 * none of which the panel can recover from once rendered.
 */

import { notifyError } from '@/store/notifications'
import { clearSessionClarify, sessionClarifyRequest } from '@/store/prompts'
import { respondToServerRequest } from '@/store/server-requests'

/** Longest a choice may be and still read as a button label rather than prose. */
const MAX_CHOICE_LENGTH = 200

/**
 * The backend labels the agent's recommended option by appending this to the
 * FIRST choice (`tools/clarify_tool.py::mark_recommended`) — there is no
 * `recommended` field on the wire, the label is baked into the choice string
 * itself and `strip_recommended` takes it back off the answer server-side.
 *
 * So the renderer never writes it: it only styles it, and discounts it when
 * measuring a choice so a long option is not dropped for length the label
 * added. The answer goes back VERBATIM, label and all — the tool strips it
 * before the model ever sees it.
 */
export const RECOMMENDED_LABEL = '(Recommended)'

/** The choice without its recommendation label, for measuring and rendering. */
export const bareChoice = (choice: string): string =>
  choice.endsWith(RECOMMENDED_LABEL) ? choice.slice(0, -RECOMMENDED_LABEL.length).trim() : choice

/**
 * The choices worth rendering. Anything blank, over-long, or multi-line is
 * dropped rather than rendered badly; an empty result means "free text only",
 * which the panel already handles.
 */
export function normalizeChoices(choices: unknown): string[] {
  if (!Array.isArray(choices)) {
    return []
  }

  return choices.filter(
    (choice): choice is string =>
      typeof choice === 'string' &&
      choice.trim().length > 0 &&
      bareChoice(choice).length <= MAX_CHOICE_LENGTH &&
      !choice.includes('\n')
  )
}

/**
 * One question of a batch clarify.
 *
 * `qid` is the gateway's wire id (`q0`..`qN`, `tui_gateway/server.py`'s
 * `_batch_clarify`), NOT the model's own `id` — `clarify.respond` keys the
 * per-question lock by it and answers a `4002` to anything else.
 */
export interface ClarifyQuestion {
  qid: string
  question: string
  choices: string[] | null
  multiSelect: boolean
}

/**
 * The `questions[]` of a batch `clarify.request`, made safe to render.
 *
 * Same hygiene as `normalizeChoices` one level up: an entry with no `qid` can
 * never be answered (the lock would 4002), and one with no question text
 * renders an unlabelled block, so both are dropped. `multi_select` is only
 * honored alongside surviving choices — there is nothing to multi-pick from in
 * a free-text question. An empty result means "not a batch", and the caller
 * falls back to the single-question shape rather than mounting an
 * unanswerable form.
 */
export function normalizeQuestions(questions: unknown): ClarifyQuestion[] {
  if (!Array.isArray(questions)) {
    return []
  }

  const normalized: ClarifyQuestion[] = []

  for (const entry of questions) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }

    const row = entry as Record<string, unknown>
    const qid = typeof row.qid === 'string' ? row.qid.trim() : ''
    const question = typeof row.question === 'string' ? row.question.trim() : ''

    if (!qid || !question) {
      continue
    }

    const choices = normalizeChoices(row.choices)

    normalized.push({
      choices: choices.length > 0 ? choices : null,
      multiSelect: row.multi_select === true && choices.length > 0,
      qid,
      question
    })
  }

  return normalized
}

/**
 * The per-question answers the gateway has already locked, as replayed on a
 * reconnect (`answers` on the resumed `clarify.request` payload —
 * `_pending_clarify_request_payload`). Non-string values are dropped rather
 * than staged as `[object Object]`.
 */
export function readLockedAnswers(answers: unknown): Record<string, string> | undefined {
  if (typeof answers !== 'object' || answers === null) {
    return undefined
  }

  const locked = Object.fromEntries(
    Object.entries(answers as Record<string, unknown>).filter(
      (pair): pair is [string, string] => typeof pair[1] === 'string'
    )
  )

  return Object.keys(locked).length > 0 ? locked : undefined
}

/**
 * Say so when a payload HAD choices and none survived.
 *
 * Silently degrading to a free-text box looks identical to a question the model
 * never offered options for, so a malformed tool call would be invisible.
 */
export function warnDroppedChoices(source: 'gateway' | 'tool_args', question: string, rawChoices: unknown): void {
  console.warn('[clarify] choices dropped after normalization', { source, question, rawChoices })
}

/** Normalize, warning when a non-empty payload normalized away to nothing. */
export function readChoices(source: 'gateway' | 'tool_args', question: string, rawChoices: unknown): string[] | null {
  const choices = normalizeChoices(rawChoices)

  if (rawChoices != null && choices.length === 0 && question) {
    warnDroppedChoices(source, question, rawChoices)
  }

  return choices.length > 0 ? choices : null
}

/**
 * The pending request this tool row is asking about — or null when the row and
 * the request are about different questions.
 *
 * A transcript can hold an OLD clarify row whose `tool.complete` never landed
 * (a disconnect ate it) while a NEW clarify is parked on the session. Both rows
 * would otherwise read the same store entry and offer to answer it. The question
 * is the only field the row and the request share, so it is the tie-break — and
 * a row with no question of its own (nothing but `tool.start`'s id ever reached
 * it) yields to the request rather than rendering blank.
 */
export function matchClarifyRequest<T extends { question: string }>(
  request: null | T | undefined,
  rowQuestion: string
): null | T {
  if (!request) {
    return null
  }

  return rowQuestion && request.question && rowQuestion !== request.question ? null : request
}

// `applyResumedClarify` lived here and is GONE (MJXHRM-520). It read
// `session.resume`'s `pending_prompt`, a field the merged backend no longer
// sends — grep `tui_gateway/` and there is nothing — so it had silently been a
// no-op: a cold-opened parked session rebuilt neither the clarify row nor the
// store entry, and the agent waited out its timeout with a contentless "needs
// input" dot on screen. The replacement is not a fixed version of it but a
// different mechanism entirely: the backend re-delivers still-open questions as
// `open_requests` on the resume/activate/events.since result, and the shared
// channel hands each one back to the request router with `replayed: true`. That
// path rebuilds both halves through the same code a live request takes, which
// is why there is nothing left to do here.

/** Is a clarify parked on this session right now? Imperative, for the composer. */
export const hasClarifyRequest = (key: null | string | undefined): boolean =>
  Boolean(key && sessionClarifyRequest(key).get())

/**
 * Answer the pending clarify with the empty string — the same thing the card's
 * own Skip button sends, and what the user typing a real message into the
 * composer means: "none of these".
 *
 * The request is cleared FIRST so a second Enter can't answer twice, and the
 * failure never rejects: this is fire-and-forget beside the real send, and a
 * failed skip must not swallow the message the user was actually sending.
 * `true` when there was something to skip.
 *
 * But it must not be SILENT either (MJXHRM-418). "The tool times out on its
 * own" is not a guarantee: `_clarify_timeout_seconds()` returns None for a
 * configured timeout <= 0, and `_block(timeout=None)` then waits forever,
 * released only by a real answer or `session.interrupt`. With the card already
 * torn down there is nothing left that could ever answer it — the same dead end
 * the optimistic responders had, minus the five-minute floor. So a skip that
 * did not land puts the question BACK and says so, and the next Enter retries it.
 *
 * The answer now goes back as the RESPONSE to the server request that asked
 * (MJXHRM-520) rather than through the removed `clarify.respond` method, so it
 * cannot fail in transit the way an RPC could: it is written to the socket the
 * question arrived on, and the shared channel swallows a write into a dead
 * generation because the backend re-delivers or withdraws the request itself.
 * What CAN happen is that there is nothing open under that id any more — the
 * prompt expired, or another surface answered it — and that is the case worth
 * telling the user about, because the card they were looking at is gone and the
 * agent moved on without their answer.
 */
export async function skipClarifyRequest(key: null | string | undefined): Promise<boolean> {
  const request = key ? sessionClarifyRequest(key).get() : null

  if (!key || !request) {
    return false
  }

  clearSessionClarify(key)

  if (!respondToServerRequest(request.requestId, { answer: '' })) {
    notifyError(
      new Error('that question was already withdrawn'),
      'The question could not be skipped — it had already expired'
    )
  }

  return true
}
