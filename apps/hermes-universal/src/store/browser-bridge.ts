import { treePanesWithPrefix } from '@/components/pane-shell/tree/store'
import { normalizeBrowserAddress } from '@/lib/browser-address'
import { readActiveBrowserPage } from '@/lib/browser/reader'
import { TILE_PANE_PREFIX, storedIdFromTilePane } from '@/lib/pane-ids'
import {
  registerPreviewActor,
  registerPreviewReader,
  type AgentRequestContext,
  type PreviewActRequest
} from '@/store/agent-read-requests'
import { $browserState, $browserSupported, closeInAppBrowser, ensureBrowserCapabilities, openInAppBrowser } from '@/store/browser'
import { $chatBubbles } from '@/store/chat-bubbles'
import { addGatewayEventListener } from '@/store/gateway'
import { previewFile } from '@/store/preview-open'
import { $focusedStoredSessionId } from '@/store/session-states'
import { $activeStoredSessionId } from '@/store/session'
import { ownsPersistedAppState } from '@/store/windows'

/**
 * The agent's half of the in-app browser: `preview.open` / `preview.close`, and
 * the reader/actor registrations.
 *
 * This takes its OWN `addGatewayEventListener` rather than a case in the event
 * router, because these frames are about the APP, not one conversation:
 * `routeGatewayEvent` fails closed on a session with no slice, and a session
 * the user has merely opened in another window has none — while a background
 * session they have TILED does. The gate below is the honest question and it is
 * ours to ask.
 */

/**
 * "Is the user looking at this session anywhere?"
 *
 * Desktop honours `preview.open` for any session on screen — the primary chat
 * or an open tile — and drops it for one visible nowhere. Offer, don't hijack.
 *
 * Named as a seam because it is the fourth place this app needs "visible
 * somewhere" and the first three each derived it locally.
 */
export function sessionIsOnScreen(storedId: null | string | undefined): boolean {
  if (!storedId) {
    return false
  }

  if (storedId === $activeStoredSessionId.get() || storedId === $focusedStoredSessionId.get()) {
    return true
  }

  if (treePanesWithPrefix(TILE_PANE_PREFIX).some(pane => storedIdFromTilePane(pane) === storedId)) {
    return true
  }

  // The phone's parallel-chat bubbles are a fourth kind of "on screen".
  return $chatBubbles.get().some(bubble => bubble.storedSessionId === storedId)
}

interface PreviewOpenPayload {
  label?: string
  url?: string
}

function handlePreviewOpen(payload: PreviewOpenPayload): void {
  const target = String(payload.url ?? '').trim()

  if (!target) {
    return
  }

  // `open_preview`'s schema accepts "a web URL, a localhost URL, or a FILE
  // PATH", and the gateway's normalizer passes paths through untouched. A path
  // belongs in the file tab, which already exists — cheaper than a second
  // normalizer and it makes the tool fully honoured rather than half.
  if (!normalizeBrowserAddress(target)) {
    previewFile(target)

    return
  }

  void openInAppBrowser(target, payload.label)
}

function handlePreviewClose(payload: { url?: string }): void {
  const asked = String(payload.url ?? '').trim()

  if (!asked) {
    closeInAppBrowser()

    return
  }

  const page = $browserState.get()

  // An UNMATCHED close is a no-op. A missed match must not wipe the rail: the
  // agent is naming a url it opened, and if that is not what is showing then
  // the user has moved on and closing it would take the page out from under
  // them.
  if (page.url === asked || normalizeBrowserAddress(asked) === page.url) {
    closeInAppBrowser()
  }
}

/**
 * Register the reader, the actor and the gateway listener.
 *
 * Guarded on the PRIMARY window: the registry holds one reader, and two windows
 * racing would make the answer depend on boot order — the rule
 * `store/window-below.ts` already states.
 */
export function installBrowserBridge(): () => void {
  if (!ownsPersistedAppState()) {
    return () => {}
  }

  const offReader = registerPreviewReader(options => readActiveBrowserPage(options))

  const offActor = registerPreviewActor(async (request: PreviewActRequest, ctx: AgentRequestContext) => {
    // Offer, don't hijack — and answer IMMEDIATELY rather than burning the
    // gateway's 45 s budget on a refusal.
    if (!sessionIsOnScreen(ctx.sessionId)) {
      return {
        action: request.action,
        error: 'The in-app browser only takes actions in the session the user is looking at.',
        success: false
      }
    }

    const caps = await ensureBrowserCapabilities()

    if (caps.host === 'none' || !$browserSupported.get()) {
      // Fall through to the router's canned "no in-app browser pane" answer,
      // which is already the exact sentence the tool documents.
      return null
    }

    // Imported lazily: `engine.js?raw` is ~10 KB of source that nothing on the
    // boot path needs, and `src/entry-graph.test.ts` pins that it stays off it.
    const { actInGuest } = await import('@/lib/browser-act/actor')

    return actInGuest(request)
  })

  const offEvents = addGatewayEventListener(event => {
    const payload = (event.payload ?? {}) as Record<string, unknown>

    switch (event.type) {
      case 'preview.close':
        handlePreviewClose(payload as { url?: string })
        break

      case 'preview.open':
        if (sessionIsOnScreen(event.session_id)) {
          handlePreviewOpen(payload as PreviewOpenPayload)
        }
        break

      default:
        break
    }
  })

  return () => {
    offReader()
    offActor()
    offEvents()
  }
}
