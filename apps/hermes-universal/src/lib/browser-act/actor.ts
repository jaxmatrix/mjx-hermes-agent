import ENGINE_SOURCE from '@/lib/browser-act/engine.js?raw'
import { ACT_HOST_VERBS, type ActResult } from '@/lib/browser-act/types'
import { evalInGuest } from '@/lib/browser/host'
import { $browserState, browserBack, browserForward, browserReload } from '@/store/browser'
import { unwrapJson } from '@/store/browser-console'

/**
 * The bridge behind `drive_preview` and `annotate_preview`.
 *
 * The gateway blocks 45 s with no probe, so every branch here answers well
 * inside that and the refusals answer immediately. Nothing throws at the agent:
 * a shaped `{success:false, error}` is always cheaper for a model to act on
 * than an exception it cannot see (rule 8).
 */

/** Must match `VERSION` in engine.js. */
export const ENGINE_VERSION = 1

/** Long enough for `elements` on a 3,000-node page. */
const ACT_TIMEOUT_MS = 10_000

/** A mutating verb changes the page; the rescan is what makes the answer a
 *  delta the agent can act on rather than a stale one. */
const SETTLE_MS = 350

const MUTATING = new Set(['click', 'press', 'type'])

let injectedFor: null | string = null

function documentKey(): string {
  return $browserState.get().url
}

/**
 * Inject once per document, and probe first.
 *
 * The probe is one eval of ~2 ms against an injection of ~15 ms, and the
 * document identity is not something the host can otherwise know — a page that
 * navigated itself has a new realm and no `__hermesAct` in it.
 */
export async function ensureEngine(): Promise<void> {
  const key = documentKey()

  if (injectedFor === key) {
    const alive = await probe()

    if (alive) {
      return
    }
  }

  await evalInGuest(ENGINE_SOURCE, 5_000)
  injectedFor = key
}

async function probe(): Promise<boolean> {
  try {
    const raw = await evalInGuest(
      `JSON.stringify(!!(window.__hermesAct && window.__hermesAct.v === ${ENGINE_VERSION}))`,
      2_000
    )

    return JSON.parse(unwrapJson(raw)) === true
  } catch {
    return false
  }
}

export interface ActRequest {
  action: string
  amount?: number
  full?: boolean
  key?: string
  max?: number
  ref?: string
  selector?: string
  submit?: boolean
  text?: string
  to?: string
}

function shaped(action: string, error: string): ActResult {
  const page = $browserState.get()

  return { action, error, success: false, title: page.title, url: page.url }
}

/**
 * Run one verb against the guest.
 *
 * `back`/`forward`/`reload` go to the HOST, never to the in-page engine: they
 * are pane navigation, and a navigation retires every ref — which is what
 * `stale` says.
 */
export async function actInGuest(request: ActRequest): Promise<ActResult> {
  const action = String(request.action || '')

  if ((ACT_HOST_VERBS as readonly string[]).includes(action)) {
    return driveHost(action)
  }

  try {
    await ensureEngine()

    const raw = await evalInGuest(
      `JSON.stringify(window.__hermesAct.run(${JSON.stringify(request)}))`,
      ACT_TIMEOUT_MS
    )

    const result = JSON.parse(unwrapJson(raw)) as ActResult

    if (!result || typeof result !== 'object') {
      return shaped(action, 'The page returned nothing the in-app browser could read.')
    }

    if (request.ref) {
      result.ref = request.ref
    }

    // Only a MUTATING verb pays the settle and the rescan; a bare `elements`
    // pays nothing, which is what keeps a read loop cheap.
    if (MUTATING.has(action) && result.success) {
      await sleep(SETTLE_MS)

      const rescan = await rescanElements(request.max)

      if (rescan?.delta) {
        result.delta = rescan.delta
      } else if (rescan?.elements) {
        result.elements = rescan.elements
      }
    }

    return result
  } catch (error) {
    return shaped(action, error instanceof Error ? error.message : String(error))
  }
}

async function rescanElements(max?: number): Promise<ActResult | null> {
  try {
    const raw = await evalInGuest(
      `JSON.stringify(window.__hermesAct.run(${JSON.stringify({ action: 'elements', max })}))`,
      ACT_TIMEOUT_MS
    )

    return JSON.parse(unwrapJson(raw)) as ActResult
  } catch {
    return null
  }
}

async function driveHost(action: string): Promise<ActResult> {
  if (action === 'back') {
    await browserBack()
  } else if (action === 'forward') {
    await browserForward()
  } else {
    await browserReload()
  }

  // The document is about to be replaced, so every ref the agent holds is
  // already retired. Saying so beats letting the next `click` fail.
  injectedFor = null

  const page = $browserState.get()

  return { action, stale: true, success: true, title: page.title, url: page.url }
}

/** `annotate_preview`'s verbs ride the same engine. */
export function annotateInGuest(request: ActRequest): Promise<ActResult> {
  return actInGuest(request)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Test seam: forget which document the engine was injected into. */
export function __resetActEngine(): void {
  injectedFor = null
}
