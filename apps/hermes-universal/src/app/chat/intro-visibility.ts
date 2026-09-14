import { isDraftKey } from '@/store/session-state-types'

/**
 * Whether the empty-chat intro splash renders on ONE chat surface.
 *
 * The splash belongs to a fresh draft in the main window and nothing else: a
 * satellite or tile window is a scratch surface, a session that exists already
 * owns the view, and any transcript at all means the conversation started.
 *
 * `enabled` is the user's Appearance toggle and outranks every other clause:
 * turning the splash off never depends on which surface asks.
 *
 * Ported from desktop `app/chat/intro-visibility.ts`, with two of its eight
 * clauses re-expressed in universal's own model rather than duplicated:
 *
 * - Desktop's `primary && !auxiliaryWindow` pair is universal's
 *   `isSecondaryWindow()` — one predicate covering both the tile/pop-out window
 *   and the satellite (HUD, wake) webviews (`store/windows.ts`). Mobile carries
 *   no `?win=` flag, so a phone is the primary window for free.
 *
 * - Desktop's `freshDraftReady && !routedSessionView && !selectedSessionId &&
 *   !activeSessionId` quartet is a lifecycle latch plus three "is a session
 *   selected" reads, all answering one question: is this surface an unsaved new
 *   chat? Universal answers it directly — a slice's KEY is `draft:N` until the
 *   gateway hands back a runtime id (`store/session-state-types.ts`). So
 *   `isDraftKey` replaces all four, and it is strictly better on the case
 *   desktop's latch has to be careful about: a stored session mid-resume keys as
 *   `hydrating:<id>`, never a draft key, so the splash cannot flash during a
 *   cold-open hydrate. A cached tail (MJXHRM-480) also fails `transcriptEmpty`.
 *
 * `sessionKey` is the surface's OWN key (`useSessionView().$runtimeId`), which
 * is what makes the decision per tile: an empty draft tile keeps its splash
 * while the tile beside it shows a transcript. A null key is "this surface does
 * not know which session it is yet" — never a fresh draft, so no splash.
 */
export function shouldShowIntro(input: {
  enabled: boolean
  primaryWindow: boolean
  sessionKey: null | string
  transcriptEmpty: boolean
}): boolean {
  return (
    input.enabled &&
    input.primaryWindow &&
    input.sessionKey !== null &&
    isDraftKey(input.sessionKey) &&
    input.transcriptEmpty
  )
}
