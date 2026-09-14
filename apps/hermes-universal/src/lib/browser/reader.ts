import { evalInGuest } from '@/lib/browser/host'
import { $browserState } from '@/store/browser'
import { unwrapJson } from '@/store/browser-console'
import { $activePreviewTarget, isArtifactTab, isBrowserTab } from '@/store/preview'

/**
 * The page reader behind `read_preview`.
 *
 * The SHAPE is the agent-facing contract — the same field names, the same cap
 * and the same `note` sentences the Electron desktop app produces — so the
 * gateway-side tool behaves identically against either client. Do not rename a
 * field here to something tidier.
 */

/** Default AND hard cap. The text crosses the gateway into model context. */
export const PREVIEW_READ_MAX_CHARS = 24_000

export interface PreviewReadResult {
  end: number
  kind: string
  note?: string
  path?: string
  start: number
  text: string
  title: string
  total_chars: number
  url: string
}

export interface PreviewReadOptions {
  count?: number
  start?: number
}

/** Verbatim from desktop's reader: clamp, clamp, clamp. */
export function windowText(total: number, options: PreviewReadOptions): { from: number; to: number } {
  const from = clamp(Math.floor(options.start ?? 0), 0, total)
  const want = clamp(Math.floor(options.count ?? PREVIEW_READ_MAX_CHARS), 1, PREVIEW_READ_MAX_CHARS)

  return { from, to: clamp(from + want, from, total) }
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) {
    return low
  }

  return Math.min(Math.max(value, low), high)
}

const NOT_LOADED = 'The page has not finished loading — retry in a moment.'
const FILE_TAB = 'File preview — read the file itself with read_file.'
const ARTIFACT_TAB = 'Generated artifact — its content is in the conversation that produced it.'

/**
 * Answer about the tab the USER is looking at.
 *
 * Deliberately not session-scoped: `read_preview` documents itself as reading
 * the preview on screen. Only the ACTOR needs the "offer, don't hijack" gate,
 * because only the actor changes something.
 *
 * NEVER throws and never answers `''` for a tab that exists — a guest still
 * booting, a just-navigated document and an eval timeout all fall through to
 * the identity answer with a `note` naming the right next step (rule 8).
 */
export async function readActiveBrowserPage(
  options: PreviewReadOptions = {}
): Promise<null | PreviewReadResult> {
  const target = $activePreviewTarget.get()

  if (!target) {
    // The one honest null: there is no preview at all, and the tool reports
    // that cleanly on its own.
    return null
  }

  if (isArtifactTab(target.path)) {
    return identity('artifact', '', target.name, ARTIFACT_TAB, target.path)
  }

  if (!isBrowserTab(target.path)) {
    return identity('file', '', target.name, FILE_TAB, target.path)
  }

  const page = $browserState.get()

  try {
    // The window is applied IN THE PAGE. `innerText` can be megabytes and the
    // eval door would otherwise carry all of it across IPC only to slice it —
    // while `total_chars` still reports the FULL length so the agent can page.
    const raw = await evalInGuest(
      `(() => { try { const b = document.body; const t = b ? b.innerText : '';` +
        ` const from = Math.min(Math.max(${Math.floor(options.start ?? 0)}, 0), t.length);` +
        ` const want = Math.min(Math.max(${Math.floor(options.count ?? PREVIEW_READ_MAX_CHARS)}, 1), ${PREVIEW_READ_MAX_CHARS});` +
        ` return JSON.stringify({ u: location.href, ti: document.title, n: t.length, f: from, s: t.slice(from, from + want) })` +
        ` } catch (e) { return '{}' } })()`,
      5_000
    )

    const probe = JSON.parse(unwrapJson(raw)) as {
      f?: number
      n?: number
      s?: string
      ti?: string
      u?: string
    }

    if (typeof probe.s !== 'string' || typeof probe.n !== 'number') {
      return identity('url', page.url, page.title, NOT_LOADED)
    }

    const start = probe.f ?? 0

    return {
      end: start + probe.s.length,
      kind: 'url',
      start,
      text: probe.s,
      title: probe.ti ?? page.title,
      total_chars: probe.n,
      url: probe.u ?? page.url
    }
  } catch {
    return identity('url', page.url, page.title, NOT_LOADED)
  }
}

function identity(kind: string, url: string, title: string, note: string, path?: string): PreviewReadResult {
  return { end: 0, kind, note, path, start: 0, text: '', title, total_chars: 0, url }
}

/** `innerText`, deliberately — not `textContent`. The agent should read what a
 *  person sees, which is the whole reason this contract is text and not HTML. */
