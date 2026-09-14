import { evalInGuest } from '@/lib/browser/host'
import { atom } from '@/store/atom'

/**
 * The guest's console.
 *
 * Two sources, one ring. Android pushes (`WebChromeClient.onConsoleMessage`);
 * every other engine is POLLED, because there is no console hook on a Tauri
 * webview at all — the injected guest script keeps its own ring and this drains
 * it by eval.
 *
 * The drain is not just for the panel. It runs once after every load whether
 * the panel is open or not, because that single drain is what makes the
 * Vite-served-as-text/html failure legible: the only evidence is a console line,
 * and without it the pane can only say "failed to load".
 */

export interface BrowserConsoleEntry {
  level: string
  text: string
  source?: string
  line?: number
  at: number
}

/** 500 entries is desktop's ring size; the oldest fall off the front. */
const RING = 500

export const $browserConsole = atom<BrowserConsoleEntry[]>([])

export function appendBrowserConsole(entries: readonly unknown[]): void {
  const parsed = entries.filter(isEntry)

  if (!parsed.length) {
    return
  }

  $browserConsole.set([...$browserConsole.get(), ...parsed].slice(-RING))
}

export function clearBrowserConsole(): void {
  $browserConsole.set([])
}

function isEntry(value: unknown): value is BrowserConsoleEntry {
  return !!value && typeof value === 'object' && typeof (value as BrowserConsoleEntry).text === 'string'
}

/**
 * Pull whatever the injected ring has accumulated. A no-op on a guest that has
 * no ring yet (a page still booting), and never throws at the caller.
 */
export async function drainBrowserConsole(): Promise<void> {
  try {
    const raw = await evalInGuest('JSON.stringify(window.__hermesGuest ? __hermesGuest.drain() : [])', 2_000)
    const entries = JSON.parse(unwrapJson(raw)) as unknown

    if (Array.isArray(entries)) {
      appendBrowserConsole(entries)
    }
  } catch {
    // A guest that is gone, still booting, or refusing scripts owes us nothing.
  }
}

/**
 * `eval_with_callback` hands back a JSON *value*; ours is a JSON string
 * containing JSON, so it unwraps twice. Shared with the reader and the actor
 * because all three ride the same door.
 */
export function unwrapJson(raw: string): string {
  try {
    const once = JSON.parse(raw) as unknown

    return typeof once === 'string' ? once : raw
  } catch {
    return raw
  }
}

/**
 * The Vite case, and the reason the post-load drain exists.
 *
 * A static file server handed a `<script type="module">` as `text/html`, the
 * page is blank, and the ONLY evidence anywhere is this console line. Promoting
 * it turns "Preview failed to load" into "Preview app failed to boot", which is
 * the sentence that tells the user to start the dev server.
 */
export function isModuleMimeFailure(entry: BrowserConsoleEntry): boolean {
  if (entry.level !== 'error') {
    return false
  }

  const text = entry.text.toLowerCase()

  return text.includes('failed to load module script') && text.includes('mime type')
}
