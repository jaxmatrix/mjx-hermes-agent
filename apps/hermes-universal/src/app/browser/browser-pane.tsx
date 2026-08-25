import { useEffect, useRef, useState } from 'react'

import { BrowserBar } from '@/app/browser/browser-bar'
import { BrowserConsolePanel } from '@/app/browser/browser-console-panel'
import { PREVIEW_BROWSER_ATTR, registerBrowserNav } from '@/app/browser/browser-nav'
import { MobileBrowserOverlay } from '@/app/browser/mobile-browser-overlay'
import { isLoopbackUrl } from '@/app/context-menu/target'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import type { Translations } from '@/i18n/types'
import { openGuest, setGuestBounds, setGuestVisible, subscribeGuest } from '@/lib/browser/host'
import { writeClipboardText } from '@/lib/clipboard'
import { openExternalLink } from '@/lib/external-link'
import { requestPreviewRestart } from '@/lib/gateway-rpc'
import { IS_MOBILE } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import {
  $browserCapabilities,
  $browserConsoleOpen,
  $browserRestoredTab,
  $browserState,
  applyGuestState,
  browserBack,
  browserForward,
  browserReload,
  browserStop,
  ensureBrowserCapabilities,
  markGuestOpen,
  takePendingNavigation
} from '@/store/browser'
import { $browserConsole, appendBrowserConsole, drainBrowserConsole, isModuleMimeFailure } from '@/store/browser-console'
import { $guestOccluded } from '@/store/browser-occlusion'
import { notify, notifyError } from '@/store/notifications'
import { $activeStoredSessionId } from '@/store/session'

/**
 * The pane the guest sits over.
 *
 * Nothing here DRAWS the page: the guest is a native view the compositor paints
 * above this DOM. What this component owns is the rect (measured here, pushed to
 * Rust), the chrome around it, and every state where there is no page —
 * unsupported platform, restored-but-not-resumed, a load error.
 */

const BOUNDS_EPSILON = 0.5

export function BrowserPane() {
  const page = useStore($browserState)
  const caps = useStore($browserCapabilities)
  const occluded = useStore($guestOccluded)
  const consoleOpen = useStore($browserConsoleOpen)
  const restored = useStore($browserRestoredTab)
  const viewport = useRef<HTMLDivElement | null>(null)
  const shell = useRef<HTMLDivElement | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    void ensureBrowserCapabilities().then(resolved => setReady(resolved.host !== 'none'))
  }, [])

  // The nav handle, so ⌘R reloads the PAGE while focus is in the pane and the
  // WINDOW while it is not.
  useEffect(() => {
    const element = shell.current

    if (!element) {
      return
    }

    return registerBrowserNav(element, {
      back: () => void browserBack(),
      forward: () => void browserForward(),
      reload: () => void browserReload(),
      stop: () => void browserStop()
    })
  }, [])

  useEffect(() => {
    if (!ready) {
      return
    }

    const element = viewport.current

    if (!element) {
      return
    }

    let disposed = false
    let off: (() => void) | undefined
    let frame = 0
    let last = { height: 0, width: 0, x: 0, y: 0 }

    const measure = () => {
      const rect = element.getBoundingClientRect()
      const next = { height: rect.height, width: rect.width, x: rect.left, y: rect.top }

      if (
        Math.abs(next.x - last.x) < BOUNDS_EPSILON &&
        Math.abs(next.y - last.y) < BOUNDS_EPSILON &&
        Math.abs(next.width - last.width) < BOUNDS_EPSILON &&
        Math.abs(next.height - last.height) < BOUNDS_EPSILON
      ) {
        return
      }

      last = next
      void setGuestBounds(next).catch(() => undefined)
    }

    // rAF-coalesced: a drag-resize fires the observer far more often than the
    // compositor can use, and each callback is an IPC round-trip.
    const schedule = () => {
      if (frame) {
        return
      }

      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }

    const observer = new ResizeObserver(schedule)

    observer.observe(element)
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)

    void (async () => {
      // Subscribe BEFORE opening, or the first `nav`/`load` is dropped — the
      // same rule `voice_open` and `ws_open` state.
      off = await subscribeGuest({
        closed: () => markGuestOpen(false),
        // The guest's own menu asking the host for something. Fully untrusted:
        // it is authored by whatever page is loaded, so only two verbs are
        // honoured and both re-validate their argument.
        command: event => void handleGuestCommand(event.command),
        console: event => appendBrowserConsole(event.entries ?? []),
        error: event => {
          $browserState.set({ ...$browserState.get(), error: event, loading: false })
        },
        load: event => {
          if (event.phase === 'started') {
            $browserState.set({ ...$browserState.get(), error: null, loading: true })

            return
          }

          // ONE drain after every load, panel open or not: a Vite app served as
          // text/html leaves its only evidence in the console, and without this
          // the pane can say nothing more useful than "failed to load".
          void drainBrowserConsole().then(promoteMimeFailure)
        },
        nav: applyGuestState
      })

      if (disposed) {
        off?.()

        return
      }

      const rect = element.getBoundingClientRect()
      const bounds = { height: rect.height, width: rect.width, x: rect.left, y: rect.top }
      const pending = takePendingNavigation()

      last = bounds

      try {
        applyGuestState(await openGuest(pending ?? 'about:blank', bounds))
        markGuestOpen(true)
      } catch {
        // The refusal card below is the report; there is nothing to retry here.
      }
    })()

    return () => {
      disposed = true
      off?.()
      observer.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)

      if (frame) {
        cancelAnimationFrame(frame)
      }

      // Unmounting hides the guest; it does NOT destroy it. Fronting another
      // preview tab must not throw away the page the user was reading.
      void setGuestVisible(false).catch(() => undefined)
    }
  }, [ready])

  // Poll while the panel is open — there is no console hook on a Tauri webview.
  useEffect(() => {
    if (!consoleOpen || caps?.console !== 'poll') {
      return
    }

    const timer = setInterval(() => void drainBrowserConsole(), 250)

    return () => clearInterval(timer)
  }, [caps?.console, consoleOpen])

  if (caps && caps.host === 'none') {
    return <Refusal notes={caps.notes} url={page.url || restored?.url} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-preview-browser="" ref={shell} tabIndex={-1}>
      {/* The phone gets an OVERLAY over the page rather than a bar above it —
          see mobile-browser-overlay.tsx for why there is no address field. */}
      {IS_MOBILE ? null : <BrowserBar />}

      <div
        className="relative min-h-0 flex-1 bg-(--ui-bg-primary)"
        // 448's marker: a see-through browser is unreadable, and a native child
        // view does not participate in the window's compositing anyway — so
        // this is also what stops the pane's CHROME from disagreeing with its
        // CONTENT.
        data-glass-opaque=""
        onMouseDown={event => {
          // Unhandled, mouse buttons 3/4 walk the HOST document's history — and
          // the host document is the whole app.
          if (event.button === 3 || event.button === 4) {
            event.preventDefault()
            void (event.button === 3 ? browserBack() : browserForward())
          }
        }}
        ref={viewport}
        {...{ [PREVIEW_BROWSER_ATTR]: '' }}
      >
        {IS_MOBILE ? <MobileBrowserOverlay /> : null}
        {occluded ? <Placeholder title={page.title} url={page.url} /> : null}
        {!page.url && restored ? <Resume title={restored.title} url={restored.url} /> : null}
        {page.error ? <LoadError /> : null}
      </div>

      {consoleOpen && !IS_MOBILE ? <BrowserConsolePanel /> : null}
    </div>
  )
}

async function handleGuestCommand(raw: string): Promise<void> {
  const [verb, query] = raw.split('?')
  const params = new URLSearchParams(query ?? '')

  if (verb === 'open') {
    const url = params.get('url') ?? ''

    // Through the same funnel every other link takes, so the http(s)-only rule
    // is stated once.
    if (/^https?:\/\//i.test(url)) {
      await openExternalLink(url)
    }

    return
  }

  if (verb === 'copy') {
    await writeClipboardText(params.get('text') ?? '')
  }
}

/**
 * The Vite-served-as-text/html case.
 *
 * A static file server handed a `<script type="module">` as `text/html`, the
 * page is blank, and the only evidence anywhere is a console line. Promoting it
 * to a load error is what turns "Preview failed to load" into "Preview app
 * failed to boot" — the sentence that tells the user to start the dev server.
 */
function promoteMimeFailure(): void {
  const page = $browserState.get()

  if (page.error) {
    return
  }

  const culprit = $browserConsole.get().slice(-25).find(isModuleMimeFailure)

  if (!culprit) {
    return
  }

  $browserState.set({
    ...page,
    error: { description: culprit.text, kind: 'engine', url: page.url }
  })
}

/** While a dialog or menu is above the guest, the pane must not become a hole. */
function Placeholder({ title, url }: { title: string; url: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-(--ui-bg-primary) text-xs opacity-70">
      <span className="max-w-[80%] truncate font-medium">{title || url}</span>
      <span className="max-w-[80%] truncate opacity-70">{url}</span>
    </div>
  )
}

/**
 * A restored tab is remembered CLOSED. A restored url can be an authenticated
 * page, a paywall or a 20 MB SPA, and paying that on every launch — on a phone,
 * in cellular bytes — is a cost nobody asked for. Desktop reopens it; this is a
 * deliberate divergence.
 */
function Resume({ title, url }: { title: string; url: string }) {
  const { t } = useI18n()

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-xs">
      <span className="max-w-full truncate font-medium">{title || url}</span>
      <button
        className="rounded-md border border-(--ui-stroke-tertiary) px-2 py-1 hover:bg-(--ui-control-hover-background)"
        onClick={() => void import('@/store/browser').then(m => m.openInAppBrowser(url))}
        type="button"
      >
        {t.browser.resume}
      </button>
    </div>
  )
}

function LoadError() {
  const { t } = useI18n()
  const page = useStore($browserState)
  const error = page.error

  if (!error) {
    return null
  }

  const title = errorTitle(t, error.description)
  // Quiet on a local gateway, and quiet for a non-loopback host that failed for
  // ordinary reasons: the explainer only earns its place when the address names
  // a machine we are NOT on.
  const loopbackNote = page.reach && !page.reach.leased && page.reach.note === 'gateway-not-ssh'

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-xs">
      <Codicon name="warning" size="1rem" />
      <span className="font-medium">{title}</span>
      <span className="max-w-full truncate opacity-70">{error.description}</span>
      {loopbackNote ? <span className="max-w-[36ch] opacity-70">{t.preview.web.remoteLoopback}</span> : null}
      <div className="flex gap-2">
        <button
          className="rounded-md border border-(--ui-stroke-tertiary) px-2 py-1 hover:bg-(--ui-control-hover-background)"
          onClick={() => void browserReload()}
          type="button"
        >
          {t.preview.web.tryAgain}
        </button>
        {/* Only for a LOOPBACK address: "restart the server" is meaningless for
            a site that is simply down, and offering it there would be a button
            that cannot work. */}
        {isLoopbackUrl(page.url) ? <RestartServerButton /> : null}
      </div>
    </div>
  )
}

/**
 * "Ask Hermes to restart the server" — the affordance that turns a blank
 * preview into a fixed one.
 *
 * It sends the CONSOLE as context, which is the whole reason the drain runs
 * after every load even with the panel closed: the module-script/MIME line is
 * what tells the agent which dev server failed to start.
 */
function RestartServerButton() {
  const { t } = useI18n()
  const page = useStore($browserState)
  const sessionId = useStore($activeStoredSessionId)
  const [busy, setBusy] = useState(false)

  if (!sessionId) {
    return null
  }

  return (
    <button
      className="rounded-md border border-(--ui-stroke-tertiary) px-2 py-1 hover:bg-(--ui-control-hover-background) disabled:opacity-50"
      disabled={busy}
      onClick={async () => {
        setBusy(true)

        try {
          const context = $browserConsole
            .get()
            .slice(-40)
            .map(entry => `[${entry.level}] ${entry.text}`)
            .join('\n')

          const taskId = await requestPreviewRestart({ context, sessionId, url: page.url })

          notify({ message: t.preview.web.restartingMessage, title: t.preview.web.restartingTitle })
          appendBrowserConsole([{ at: Date.now(), level: 'info', text: t.preview.web.lookingRestart(taskId) }])
        } catch (error) {
          notifyError(error, t.preview.web.restartFailed)
        } finally {
          setBusy(false)
        }
      }}
      type="button"
    >
      {busy ? t.preview.web.restarting : t.preview.web.askRestart}
    </button>
  )
}

function errorTitle(t: Translations, description: string): string {
  const text = description.toLowerCase()

  if (text.includes('module script') || text.includes('mime type')) {
    return t.preview.web.appFailedToBoot
  }

  if (text.includes('refused') || text.includes('not found') || text.includes('connect')) {
    return t.preview.web.serverNotFound
  }

  return t.preview.web.failedToLoad
}

function Refusal({ notes, url }: { notes: string[]; url?: string }) {
  const { t } = useI18n()

  return (
    <div
      className={cn('flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs', IS_MOBILE && 'px-6')}
      data-glass-opaque=""
    >
      <Codicon name="globe" size="1rem" />
      <span className="font-medium">{t.browser.unsupportedTitle}</span>
      {notes.map(note => (
        <span className="max-w-[40ch] opacity-70" key={note}>
          {note}
        </span>
      ))}
      {url ? (
        <button
          className="rounded-md border border-(--ui-stroke-tertiary) px-2 py-1 hover:bg-(--ui-control-hover-background)"
          onClick={() => void openExternalLink(url)}
          type="button"
        >
          {t.browser.openExternally}
        </button>
      ) : null}
    </div>
  )
}
