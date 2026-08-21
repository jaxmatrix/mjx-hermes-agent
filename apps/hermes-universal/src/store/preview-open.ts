import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { $currentCwd } from '@/store/chat'
import { setCurrentSessionPreviewTarget } from '@/store/preview'

/**
 * Open a path in the right pane's file viewer — the app's ONE route from "a
 * path appeared somewhere" to a real tab.
 *
 * It lived as two byte-identical copies (`app/contrib/panes` and
 * `app/shell/sidebar`) that the file tree and the mobile workspace each reached
 * for, and a third caller — the tool row's spillover reference — would have
 * made three.
 *
 * Its own module rather than `store/preview`: reading the cwd means importing
 * `store/chat`, and putting that edge on the tab store would drag the whole
 * session graph into every module that only wanted a tab list.
 */
export function previewFile(path: string): void {
  void normalizeOrLocalPreviewTarget(path, $currentCwd.get() || undefined)
    .then(target => {
      if (target) {
        setCurrentSessionPreviewTarget(target, 'file-browser', path)
      }
    })
    .catch(() => undefined)
}
