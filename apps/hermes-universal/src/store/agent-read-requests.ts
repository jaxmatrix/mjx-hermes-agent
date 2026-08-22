/**
 * The agent's blocking client-side requests — `preview.read.request`,
 * `window.read.request`, `terminal.read.request` (MJXHRM-472), and
 * (MJXHRM-444) `preview.act.request` / `tour.request`.
 *
 * This is the one event family where the gateway is BLOCKED on the client:
 * `_block()` parks the tool for 45s (read_preview) / 30s (read_window_below)
 * and only wakes on a matching `*.read.respond`. Ignoring the frame therefore
 * doesn't merely lose a feature, it stalls the agent for the whole timeout —
 * so this module ALWAYS answers, with an empty string when nothing can, which
 * both tools read as "nothing on screen".
 *
 * Universal has no browser preview (store/preview.ts is files-only), so no
 * preview handler is registered today; `window.read` DOES have one
 * (store/window-below.ts, installed at boot). Registering is the whole seam:
 * the feature that gains the capability calls `registerPreviewReader` /
 * `registerWindowBelowReader` / `registerPreviewActor` (MJXHRM-447) /
 * `registerTourDriver` (MJXHRM-473) and nothing here changes.
 *
 * READ and DRIVE answer unregistered differently (MJXHRM-472). An empty READ
 * answer is honest — both read tools document it as "nothing on screen". An
 * empty DRIVE answer is not: `drive_preview_tool.py` / `tour_tool.py` render it
 * as "timed out, or no GUI window answered", which tells the model to open a
 * preview and try again on a client that structurally cannot. So the drive pair
 * answers a shaped `{success: false, error}` instead — see `drive()` below.
 *
 * The two 08-20 additions are the same lifecycle with a different payload. The
 * read pair carries a read WINDOW (two optional ints); `preview.act` and `tour`
 * carry the agent's whole tool call — an action verb plus the arguments for it
 * — because they DRIVE the surface rather than read it. Both are already in the
 * gateway's `_block` expire allowlist (server.py), so their `.expire` frames
 * arrive today and would have been dropped on the floor.
 *
 * Self-registers on the gateway stream rather than riding the event router:
 * these frames are about the APP, not about one conversation, and the router
 * fails closed on a session it doesn't know (store/event-router.ts).
 */

import { readActiveTerminal } from '@/app/right-pane/terminal/buffer'
import type { GatewayEvent } from '@/gateway'
import {
  type AgentReadRespondResult,
  respondPreviewAct,
  respondPreviewRead,
  respondTerminalRead,
  respondTour,
  respondWindowRead
} from '@/lib/gateway-rpc'
import { addGatewayEventListener } from '@/store/gateway'

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

export type PreviewActor = (request: PreviewActRequest) => Promise<unknown> | unknown

/** One `tour` tool call. `action` is `targets`/`show`/`start`/`next`/`prev`/
 *  `stop`; `surface` picks the app chrome or the preview pane. The answer names
 *  the matched targets and the active step, or the selector that did not
 *  match — the error IS the useful answer here, so an actor should report a bad
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

export type TourDriver = (request: TourRequest) => Promise<unknown> | unknown

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

// Requests still worth answering. An `*.read.expire` frame drops its id so a
// reader that resolves after the tool already gave up doesn't send a pointless
// respond. Bounded by the number of in-flight reads — one per live tool call.
const pending = new Set<string>()

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

async function answer(
  requestId: string,
  read: () => Promise<unknown> | unknown,
  respond: (requestId: string, text: string) => Promise<AgentReadRespondResult>
): Promise<void> {
  pending.add(requestId)

  let text = ''

  try {
    const result = await read()

    text = result == null ? '' : JSON.stringify(result)
  } catch {
    // A reader that throws (a surface still booting, enumeration unsupported on
    // this compositor) answers empty rather than leaving the tool to time out.
  }

  // False when the request expired while the reader was running.
  if (!pending.delete(requestId)) {
    return
  }

  try {
    await respond(requestId, text)
  } catch {
    // The socket went away; the tool's own timeout is the backstop.
  }
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
 * from "it ran and did nothing", so every branch here returns a shaped result:
 * `{success: false, error}` when unregistered or when the driver throws (a
 * driver that throws is desktop's behaviour too), and whatever the driver
 * returned otherwise.
 */
async function drive<T>(
  driver: null | ((request: T) => Promise<unknown> | unknown),
  request: T,
  unsupported: string
): Promise<unknown> {
  if (!driver) {
    return { error: unsupported, success: false }
  }

  try {
    return (await driver(request)) ?? { error: unsupported, success: false }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), success: false }
  }
}

function routeAgentReadRequest(event: GatewayEvent): void {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const requestId = typeof payload.request_id === 'string' ? payload.request_id : ''

  switch (event.type) {
    case 'preview.read.request': {
      if (!requestId) {
        return
      }

      const reader = previewReader
      const options: PreviewReadOptions = { count: num(payload.count), start: num(payload.start) }

      void answer(requestId, () => reader?.(options) ?? null, respondPreviewRead)

      break
    }

    case 'terminal.read.request': {
      if (!requestId) {
        return
      }

      const options: PreviewReadOptions = { count: num(payload.count), start: num(payload.start) }

      // No registry seam here, unlike the other four: the terminal's reader is
      // resolved per-read from `$activeTerminalId`, so which terminal the agent
      // sees is always the tab the user is looking at (buffer.ts).
      void answer(requestId, () => readActiveTerminal(options), respondTerminalRead)

      break
    }

    case 'window.read.request': {
      if (!requestId) {
        return
      }

      const reader = windowBelowReader

      void answer(requestId, () => reader?.() ?? null, respondWindowRead)

      break
    }

    case 'preview.act.request': {
      if (!requestId) {
        return
      }

      const actor = previewActor
      // The whole frame minus its envelope key: the tool's arguments ARE the
      // request, and forwarding them wholesale means a verb or argument added
      // backend-side reaches a registered actor without a change here.
      const { request_id: _ignored, ...request } = payload

      void answer(
        requestId,
        () => drive(actor, request as unknown as PreviewActRequest, PREVIEW_ACT_UNSUPPORTED),
        respondPreviewAct
      )

      break
    }

    case 'tour.request': {
      if (!requestId) {
        return
      }

      const tour = tourDriver
      const { request_id: _ignored, ...request } = payload

      void answer(requestId, () => drive(tour, request as unknown as TourRequest, TOUR_UNSUPPORTED), respondTour)

      break
    }

    case 'preview.act.expire':

    case 'preview.read.expire':

    case 'terminal.read.expire':

    case 'tour.expire':

    case 'window.read.expire':
      pending.delete(requestId)

      break

    default:
      break
  }
}

addGatewayEventListener(routeAgentReadRequest)

/** Test seam — drops registered readers and any in-flight request. */
export function __resetAgentReadRequests(): void {
  previewReader = null
  windowBelowReader = null
  previewActor = null
  tourDriver = null
  pending.clear()
}
