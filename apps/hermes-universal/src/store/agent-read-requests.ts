/**
 * The agent's blocking GUI bridges: `terminal.read`, `window.read`,
 * `preview.read` (MJXHRM-472) and the drive pair `preview.act` / `tour`
 * (MJXHRM-444).
 *
 * These arrive as server→client REQUESTS now (MJXHRM-520,
 * `tui_gateway/server_requests.py`), not as events. The backend is BLOCKED on
 * the answer — the tool is parked in `server_requests.send()` until a response
 * frame with the request's id comes back — so ignoring one does not merely lose
 * a feature, it stalls the agent until the request's deadline. This module
 * therefore ALWAYS answers, with an empty string when nothing can, which both
 * read tools document as "nothing on screen".
 *
 * What the request wire changed, beyond the frame shape:
 *
 *  - No `request_id` in the payload. The correlation IS the request id, and the
 *    answer is a JSON-RPC RESPONSE on it rather than a fresh `*.respond` call —
 *    so it goes back over the socket that asked, and the `*.respond` methods
 *    (which the backend no longer implements) are gone.
 *  - No `*.expire` frames, and so no local `pending` set. The backend withdraws
 *    a request it has given up on with `request.cancel`, and the shared
 *    channel's `respond` is idempotent, so a reader that resolves late answers
 *    into a settled request and is dropped on the floor by the channel instead
 *    of needing to be tracked here.
 *
 * Universal has no browser preview (store/preview.ts is files-only), so no
 * preview reader/actor is registered today; `window.read` DOES have one on
 * desktop (store/window-below.ts) and `tour` has a driver on every platform
 * including Android and iOS (store/tour-bridge.ts). Registering is the whole
 * seam: the feature that gains the capability calls `registerPreviewReader` /
 * `registerWindowBelowReader` / `registerPreviewActor` / `registerTourDriver`
 * and nothing here changes.
 *
 * READ and DRIVE answer "unregistered" differently, and that asymmetry is a
 * correctness requirement rather than a nicety (MJXHRM-472). An empty READ
 * answer is honest. An empty DRIVE answer is not: `drive_preview_tool.py` /
 * `tour_tool.py` render it as "timed out, or no GUI window answered", which
 * tells the model to open a preview and try again on a client that structurally
 * cannot — so the drive pair answers a shaped `{success: false, error}`.
 */

import { readActiveTerminal } from '@/app/right-pane/terminal/buffer'
import type { ServerRequest } from '@/gateway'

/** Windowing the read_preview tool asks for. Both are optional — the tool omits
 *  them entirely when it wants the whole page. */
export interface PreviewReadOptions {
  count?: number
  start?: number
}

/** Returns whatever the preview surface knows; it is JSON-stringified onto the
 *  wire, and `null` means "nothing open". */
export type PreviewReader = (options: PreviewReadOptions) => Promise<unknown> | unknown

/** Returns a description of the OS window under the app, or `null` when the
 *  platform can't enumerate windows. */
export type WindowBelowReader = () => Promise<unknown> | unknown

/**
 * One `drive_preview` tool call: an action verb plus whatever arguments that
 * verb takes. Deliberately loose — the verb set (`click`, `type`, `scroll`,
 * `key`, …) is the backend tool's and grows there, so a closed union here would
 * silently drop the next verb the agent learns instead of letting the actor
 * report that it does not know it. The answer is JSON-stringified onto the wire
 * and the tool reads it as the interaction's outcome: what was acted on, the
 * live url/title, and a refreshed element inventory.
 */
export interface PreviewActRequest {
  action: string
  amount?: number
  full?: boolean
  key?: string
  /** The tool's `limit` argument — named `max` on the wire. */
  max?: number
  ref?: string
  selector?: string
  submit?: boolean
  text?: string
  to?: string
}

/**
 * Which session asked.
 *
 * The request names its session in `params.session_id`, and a driver needs it
 * to apply the "act only in the session the user is looking at" rule. Passing
 * it as a context argument keeps one source of truth where an ambient "current
 * request session" atom would be a second (MJXHRM-447).
 */
export interface AgentRequestContext {
  sessionId: null | string
}

export type PreviewActor = (request: PreviewActRequest, ctx: AgentRequestContext) => Promise<unknown> | unknown

/** One `tour` tool call. `action` is `targets`/`show`/`start`/`next`/`prev`/
 *  `stop`; `surface` picks the app chrome or the preview pane. The answer names
 *  the matched targets and the active step, or the selector that did not
 *  match — the error IS the useful answer here, so a driver should report a bad
 *  selector rather than throwing (a throw answers empty, which reads as "the
 *  tour ran and found nothing"). */
export interface TourRequest {
  action: string
  selector?: string
  side?: string
  step_index?: number
  steps?: Record<string, unknown>[]
  surface?: string
  text?: string
  title?: string
}

export type TourDriver = (request: TourRequest, ctx: AgentRequestContext) => Promise<unknown> | unknown

let previewReader: null | PreviewReader = null
let windowBelowReader: null | WindowBelowReader = null
let previewActor: null | PreviewActor = null
let tourDriver: null | TourDriver = null

/** Register THE preview reader; returns an idempotent unregister. */
export function registerPreviewReader(reader: PreviewReader): () => void {
  previewReader = reader

  return () => {
    if (previewReader === reader) {
      previewReader = null
    }
  }
}

/** Register THE window-below reader; returns an idempotent unregister. */
export function registerWindowBelowReader(reader: WindowBelowReader): () => void {
  windowBelowReader = reader

  return () => {
    if (windowBelowReader === reader) {
      windowBelowReader = null
    }
  }
}

/** Register THE preview actor (MJXHRM-472); returns an idempotent unregister. */
export function registerPreviewActor(actor: PreviewActor): () => void {
  previewActor = actor

  return () => {
    if (previewActor === actor) {
      previewActor = null
    }
  }
}

/** Register THE tour driver (MJXHRM-473); returns an idempotent unregister. */
export function registerTourDriver(driver: TourDriver): () => void {
  tourDriver = driver

  return () => {
    if (tourDriver === driver) {
      tourDriver = null
    }
  }
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Answer a READ request with a JSON string ('' = nothing / unavailable).
 *
 * `ValueResult` — the declared result for every one of these methods — is
 * `{value: string}`, and '' is what both read tools document as "nothing on
 * screen". A reader that throws (a surface still booting, enumeration
 * unsupported on this compositor) answers empty too, rather than leaving the
 * tool to wait out its deadline.
 */
async function answerRead(request: ServerRequest, read: () => Promise<unknown> | unknown): Promise<void> {
  let text = ''

  try {
    const result = await read()

    text = result == null ? '' : JSON.stringify(result)
  } catch {
    // Empty, deliberately: an honest "nothing" beats a stalled agent.
  }

  request.respond({ value: text })
}

/**
 * The answer a DRIVE request gets when nothing is registered to satisfy it.
 *
 * Not an empty string. Both tools treat an empty answer as "the action timed
 * out, or no GUI window answered" (`tools/drive_preview_tool.py`,
 * `tools/tour_tool.py`) and tell the model to open a preview / retry — which is
 * a lie on a client that structurally cannot do either, and buys a retry loop.
 * A JSON object passes through the tool verbatim (`json.dumps(json.loads(raw))`),
 * so this text is what the model actually reads.
 *
 * These are agent-facing wire strings, not UI copy — deliberately not i18n'd,
 * exactly like desktop's equivalents in `desktop-bridge.ts`.
 */
const PREVIEW_ACT_UNSUPPORTED =
  'This Hermes client has no in-app browser pane, so there is no page to act on. ' +
  'Nothing was clicked or typed. Use the browser_* tools for an automated browser, ' +
  'or ask the user to do it in their own browser.'

const TOUR_UNSUPPORTED =
  'This Hermes client cannot run guided tours (no tour engine on this surface). ' +
  'Nothing was highlighted. Describe the steps in chat instead.'

/**
 * Run a registered driver, or report honestly that there is none.
 *
 * Unlike the READ pair, an unanswered/empty DRIVE answer is indistinguishable
 * from "it ran and did nothing", so every branch returns a shaped result:
 * `{success: false, error}` when unregistered or when the driver throws (a
 * driver that throws is desktop's behaviour too), and whatever the driver
 * returned otherwise.
 */
async function drive<T>(
  request: ServerRequest,
  driver: null | ((call: T, ctx: AgentRequestContext) => Promise<unknown> | unknown),
  call: T,
  unsupported: string,
  ctx: AgentRequestContext
): Promise<void> {
  let result: unknown

  if (!driver) {
    result = { error: unsupported, success: false }
  } else {
    try {
      result = (await driver(call, ctx)) ?? { error: unsupported, success: false }
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error), success: false }
    }
  }

  request.respond({ value: JSON.stringify(result) })
}

/** The five bridge methods this module owns. */
const BRIDGE_METHODS = new Set(['preview.act', 'preview.read', 'terminal.read', 'tour', 'window.read'])

/**
 * Answer one GUI-bridge request, or decline it (`false`) so the channel can.
 *
 * `activeSessionKey` is what the DRIVE pair checks itself against: every
 * mounted WebView sees the same request, so a window that is not looking at the
 * named session stays SILENT rather than answering — answering would race the
 * window that owns the surface (desktop applies the identical rule in its
 * `gateway-event/server-requests.ts`). Staying silent is safe because the
 * window that IS looking answers, and the backend withdraws if none does.
 */
export function answerAgentBridgeRequest(request: ServerRequest, activeSessionKey: null | string): boolean {
  if (!BRIDGE_METHODS.has(request.method)) {
    return false
  }

  const params = request.params
  const sessionId = str(params.session_id)
  const ctx: AgentRequestContext = { sessionId: sessionId || null }
  const options: PreviewReadOptions = { count: num(params.count), start: num(params.start) }

  switch (request.method) {
    case 'preview.read': {
      const reader = previewReader

      void answerRead(request, () => reader?.(options) ?? null)

      return true
    }

    case 'terminal.read':
      // No registry seam here, unlike the other four: the terminal's reader is
      // resolved per-read from `$activeTerminalId`, so which terminal the agent
      // sees is always the tab the user is looking at (buffer.ts).
      void answerRead(request, () => readActiveTerminal(options))

      return true
    case 'window.read': {
      const reader = windowBelowReader

      void answerRead(request, () => reader?.() ?? null)

      return true
    }

    case 'preview.act': {
      if (sessionId && sessionId !== activeSessionKey) {
        return true
      }

      // The whole params minus the envelope key: the tool's arguments ARE the
      // request, so forwarding them wholesale means a verb or argument added
      // backend-side reaches a registered actor without a change here.
      const { session_id: _ignored, ...call } = params

      void drive(request, previewActor, call as unknown as PreviewActRequest, PREVIEW_ACT_UNSUPPORTED, ctx)

      return true
    }

    case 'tour': {
      if (sessionId && sessionId !== activeSessionKey) {
        return true
      }

      const { session_id: _ignored, ...call } = params

      void drive(request, tourDriver, call as unknown as TourRequest, TOUR_UNSUPPORTED, ctx)

      return true
    }

    default:
      return false
  }
}

/** Test seam — drops every registered reader/driver. */
export function __resetAgentReadRequests(): void {
  previewReader = null
  windowBelowReader = null
  previewActor = null
  tourDriver = null
}
