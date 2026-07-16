import type { ReactNode } from 'react'

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useI18n } from '@/i18n'
import { notify } from '@/store/notifications'

// Right-click menu for a tree row. Rename/delete/reveal-in-file-manager are
// deferred (no remote `/api/fs` mutation endpoint; no local FS on the remote +
// mobile client), so this is copy-path only (webview clipboard).

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function toRelativePath(path: string, root?: null | string): string {
  if (!root) return path
  const r = root.replace(/[\\/]+$/, '')
  return path.startsWith(r) ? path.slice(r.length).replace(/^[\\/]+/, '') || path : path
}

export function FileContextMenu({
  children,
  path,
  relativeTo
}: {
  children: ReactNode
  path: string
  relativeTo?: null | string
}) {
  const { t } = useI18n()
  const menu = t.fileMenu

  const copy = (text: string) => {
    void copyToClipboard(text).then(ok => {
      if (ok) notify({ kind: 'success', message: menu.pathCopied })
    })
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => copy(path)}>{menu.copyPath}</ContextMenuItem>
        {relativeTo && (
          <ContextMenuItem onSelect={() => copy(toRelativePath(path, relativeTo))}>
            {menu.copyRelativePath}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
