/**
 * IME-aware Enter handling, shared by every text field whose bare Enter
 * performs an action (submit, rename, commit, adopt, …). Ported from
 * apps/desktop/src/lib/ime.ts so the shared sample plugins, which import
 * `isSubmitEnter` from the plugin SDK, compile against both apps.
 *
 * CJK/IME users press Enter to *commit a composition* — the candidate text
 * they are still assembling — and that keystroke must never double as the
 * field's submit shortcut. Browsers signal an in-flight composition two ways:
 *
 * - `isComposing` on the (native) keyboard event — the standard signal.
 * - legacy `keyCode === 229` (VK_PROCESSKEY) — Chromium and Safari still
 *   stamp it on keydowns at composition boundaries, including the commit
 *   Enter that can arrive *after* `compositionend` with `isComposing`
 *   already false.
 *
 * The chat composers keep their own richer stale-flag handling
 * (`lib/ime-composition.ts`); everything simpler belongs here.
 *
 * Accepts both React synthetic events (composition state lives on
 * `nativeEvent`) and plain DOM `KeyboardEvent`s (state lives on the event
 * itself), so window-level listeners can share the policy too.
 */
export interface ImeAwareKeyEvent {
  key: string
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: {
    isComposing?: boolean
    keyCode?: number
  }
}

/** Whether this keyboard event belongs to an active IME composition. */
export function isImeComposing(event: ImeAwareKeyEvent): boolean {
  const native = event.nativeEvent ?? event

  return Boolean(native.isComposing || event.isComposing) || native.keyCode === 229 || event.keyCode === 229
}

/** Enter pressed as a real submit — not an IME composition commit. */
export function isSubmitEnter(event: ImeAwareKeyEvent): boolean {
  return event.key === 'Enter' && !isImeComposing(event)
}
