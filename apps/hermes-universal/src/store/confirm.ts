import { atom } from '@/store/atom'

/**
 * What the user chose. `false` = cancelled (Esc, Cancel, backdrop, or a second
 * `confirm()` superseding this one), `true` = confirmed, `'secondary'` = took
 * the third way out — only reachable when the request asked for one.
 */
export type ConfirmAnswer = 'secondary' | boolean

export interface ConfirmRequest {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  /** Label for a third, non-destructive way out. Present → the promise can
   *  resolve `'secondary'`; absent → it resolves a plain boolean. */
  secondaryLabel?: string
}

export interface PendingConfirm extends ConfirmRequest {
  resolve: (answer: ConfirmAnswer) => void
}

export const $confirmRequest = atom<null | PendingConfirm>(null)

// Imperative front door to ConfirmDialog, for handlers that want the answer
// inline the way window.confirm gave it — `if (!ok) return`. A surface that
// wants the busy → done beat or an inline error should mount <ConfirmDialog>
// itself and hand it the async onConfirm.
//
// The resolved value is a superset of desktop's `boolean`, so ported desktop
// handlers (`if (!ok) return`, `if (!(await confirm({…})))`) paste unchanged —
// none of them passes `secondaryLabel`, so none of them can be handed the third
// answer. A caller that DOES ask for the third button must match on
// `=== 'secondary'` rather than truthiness, since `'secondary'` is truthy.
export function confirm(request: ConfirmRequest): Promise<ConfirmAnswer> {
  // One modal at a time: a second ask supersedes the first, which answers no.
  settleConfirm(false)

  return new Promise<ConfirmAnswer>(resolve => {
    $confirmRequest.set({ ...request, resolve })
  })
}

/** Answer the open request, if there still is one. Idempotent. */
export function settleConfirm(answer: ConfirmAnswer): void {
  const pending = $confirmRequest.get()

  if (!pending) {
    return
  }

  $confirmRequest.set(null)
  pending.resolve(answer)
}
