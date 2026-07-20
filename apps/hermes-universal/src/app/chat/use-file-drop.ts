import { getCurrentWebview } from '@tauri-apps/api/webview'
import { useEffect, useState } from 'react'

import { stageAttachmentFromPath, stagedToComposerAttachment } from '@/app/chat/attachments'
import { IS_DESKTOP } from '@/lib/platform'
import { mainComposerScope } from '@/store/composer'
import { triggerHaptic } from '@/lib/haptics'

// OS file drag-and-drop into the chat (desktop parity). Tauri v2 intercepts
// external file drops at the window level (HTML5 drop events are suppressed
// while `dragDropEnabled` is on) and delivers absolute paths via
// `onDragDropEvent`. Each dropped path flows through the same read → file.attach
// pipeline the picker uses (stageAttachmentFromPath). Desktop-only; mobile has
// no cross-app file DnD and the listener is a no-op there anyway.
export function useFileDrop(): { dragActive: boolean } {
  const [dragActive, setDragActive] = useState(false)

  useEffect(() => {
    if (!IS_DESKTOP) return

    let disposed = false
    const unlistenPromise = getCurrentWebview().onDragDropEvent(event => {
      const payload = event.payload

      if (payload.type === 'enter' || payload.type === 'over') {
        setDragActive(true)
        return
      }

      if (payload.type === 'leave') {
        setDragActive(false)
        return
      }

      if (payload.type === 'drop') {
        setDragActive(false)
        void (async () => {
          let staged = false
          for (const path of payload.paths) {
            const attachment = await stageAttachmentFromPath(path)
            if (attachment) {
              mainComposerScope.add(stagedToComposerAttachment(attachment))
              staged = true
            }
          }
          if (staged) void triggerHaptic('selection')
        })()
      }
    })

    return () => {
      disposed = true
      void unlistenPromise.then(unlisten => {
        if (disposed) unlisten()
      })
    }
  }, [])

  return { dragActive }
}
