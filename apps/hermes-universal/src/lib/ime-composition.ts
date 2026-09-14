/**
 * Recovery for a composition flag that got stuck true.
 *
 * Both composers track an IME preedit in a `composingRef` fed by
 * `compositionstart` / `compositionend`, and swallow Enter while it is set. A
 * MISSED `compositionend` — a focus jump, an input-source switch, or a
 * programmatic DOM swap mid-preedit — wedges that ref, and the wedged flag
 * silently swallows every Enter (and, on the docked composer, the Send button's
 * submit guard) until the component remounts. For CJK typists, where even ASCII
 * runs through composition, that reads as "Enter has no effect and nothing
 * reaches the gateway" (desktop 39e7607794, 587788405a).
 *
 * Desktop heals this by trusting `KeyboardEvent.isComposing`: Chromium stamps
 * it on every keydown of a genuine composition, so a `false` there means the
 * ref is stale. Universal's desktop webview is WebKitGTK, which the edit
 * composer's own guard already notes does not set that flag as reliably — and a
 * heal that trusts an absent flag would clear the ref MID-composition and send
 * half-composed text, which is strictly worse than the wedge it fixes.
 *
 * So the heal arms itself per engine: the flag only becomes evidence once this
 * process has SEEN the engine stamp `isComposing` during a composition it
 * already knew about. On Chromium that happens on the first keydown of the
 * first composition; on an engine that never stamps it, the heal never arms and
 * behaviour is exactly what it is today.
 */
export interface MutableFlag {
  current: boolean
}

export function reconcileCompositionFlag(
  composing: MutableFlag,
  flagTrusted: MutableFlag,
  nativeIsComposing: boolean
): void {
  if (!composing.current) {
    return
  }

  if (nativeIsComposing) {
    // A composition we know is live, and the engine agrees — from here on its
    // `false` carries information.
    flagTrusted.current = true

    return
  }

  if (flagTrusted.current) {
    composing.current = false
  }
}

/**
 * An Enter that is an IME commit rather than a send.
 *
 * The macOS Chinese IME (and some third-party Windows IMEs) emit Enter with the
 * legacy `keyCode` 229 (`VK_PROCESSKEY`) after `compositionend` has already
 * fired, so `isComposing` is false by then. Letting it through sends the
 * message before the committed text is fully in the DOM.
 */
export function isImeCommitEnter(event: { key: string; keyCode: number }): boolean {
  return event.key === 'Enter' && event.keyCode === 229
}
