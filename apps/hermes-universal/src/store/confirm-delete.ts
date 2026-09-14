import { translateNow } from '@/i18n'

import { confirm } from './confirm'

/**
 * "Delete <thing>?" — the app's own destructive confirmation, as one call.
 *
 * Desktop exposes this as `useConfirmDelete`, a hook wrapping its confirm bus.
 * There is no hook state to hold here: `confirm()` is already callable from a
 * plain handler and `<ConfirmHost/>` is mounted per window, so a hook would be a
 * component-only wrapper around something that works anywhere.
 */
export async function confirmDelete(name: string, description?: string): Promise<boolean> {
  return (
    (await confirm({
      confirmLabel: translateNow('common.delete'),
      description,
      destructive: true,
      title: translateNow('common.deleteNamed', name)
    })) === true
  )
}
