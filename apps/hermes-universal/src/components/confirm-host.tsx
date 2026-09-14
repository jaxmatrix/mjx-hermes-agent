import { useEffect, useState } from 'react'

import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useStore } from '@/store/atom'
import { $confirmRequest, type PendingConfirm, settleConfirm } from '@/store/confirm'

/**
 * The one mount point for `confirm()` from `@/store/confirm`.
 *
 * Mounted once per WINDOW from `app.tsx`, beside `CloseConfirm`, for the reason
 * that file's header spells out: a shell-level mount only reaches the shell that
 * renders it, so a phone (`MobileShell`), a narrow window (`AppShell`), the
 * detached tile window and the Android activity root would each need their own —
 * and whichever was missed would park a promise nothing on screen could answer.
 *
 * Satellite/detached windows are separate webviews, so each gets its OWN module
 * instance of `store/confirm` and its own host. A `confirm()` raised by code
 * running in a satellite therefore draws in THAT satellite, which is where the
 * click that raised it happened. Nothing crosses the window boundary.
 */
export function ConfirmHost() {
  const request = useStore($confirmRequest)
  // The atom clears the moment the question is answered, but Radix still has a
  // close animation to play — hold the copy so the dialog doesn't blank mid-fade.
  const [shown, setShown] = useState<null | PendingConfirm>(request)

  useEffect(() => {
    if (request) {
      setShown(request)
    }
  }, [request])

  if (!shown) {
    return null
  }

  return (
    <ConfirmDialog
      cancelLabel={shown.cancelLabel}
      confirmLabel={shown.confirmLabel}
      description={shown.description}
      destructive={shown.destructive}
      // The caller does the work once it has its answer, so there is nothing
      // here to keep the dialog open for.
      dismissOnConfirm
      onClose={() => settleConfirm(false)}
      onConfirm={() => settleConfirm(true)}
      open={request !== null}
      secondaryAction={
        shown.secondaryLabel
          ? {
              label: shown.secondaryLabel,
              // ConfirmDialog calls onClose right after this, which would settle
              // `false` over the top — but settleConfirm is idempotent and this
              // call already cleared the atom, so the second one is a no-op.
              onClick: () => settleConfirm('secondary')
            }
          : undefined
      }
      title={shown.title}
    />
  )
}
