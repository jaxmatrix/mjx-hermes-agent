import { useStore } from '@nanostores/react'

import { BrowserPane } from '@/app/browser/browser-pane'
import { $restartPreviewServer } from '@/app/contrib/panes'
import { $browserGuestTabId } from '@/store/browser'
import { $previewReloadRequest, $previewTabs } from '@/store/preview'

import { PreviewPane } from './preview-pane'

interface PreviewTilePaneProps {
  /** The `$previewTabs` id this pane renders. */
  tabId: string
}

/**
 * One preview, as a layout-tree pane. The tab strip — its label, close verbs,
 * drag/stack/split and ⌘W — belongs to the ZONE (see `preview-tile.tsx`), so
 * this renders only the body and a preview tab behaves like every other tab.
 *
 * The console / DevTools toggles live in the pane's own browser bar beside the
 * address (`preview-browser-bar`); the restart handler arrives through the atom
 * bridge the old rail wrapper used, since the mirror renders this pane with no
 * props to thread.
 *
 * UNIVERSAL'S ONE DELTA (this file is protected): a `url` tab renders the Rust
 * guest, not `PreviewPane`. Desktop draws a url tab with an Electron `<webview>`,
 * which a Tauri webview has no element for — it would be desktop's bar over a
 * spinner that never ends. The guest is the Tauri seam (`app/browser/`,
 * `store/browser.ts`), and there is ONE of it, bound to the focused url tab: any
 * other url tab is only a location and draws nothing until focus hands it the
 * guest. Every other target kind is desktop's pane, untouched.
 */
export function PreviewTilePane({ tabId }: PreviewTilePaneProps) {
  const previewReloadRequest = useStore($previewReloadRequest)
  const previewTabs = useStore($previewTabs)
  const restartPreviewServer = useStore($restartPreviewServer)
  const guestTabId = useStore($browserGuestTabId)
  const target = previewTabs.find(tab => tab.id === tabId)?.target

  // The tab closed while this pane was still mounted (the mirror disposes it a
  // tick later).
  if (!target) {
    return null
  }

  // Asked of the tab list, not of `target`: narrowing `target` here would turn
  // desktop's own `kind === 'url'` test below into a type error.
  if (previewTabs.some(tab => tab.id === tabId && tab.target.kind === 'url')) {
    return guestTabId === tabId ? <BrowserPane /> : null
  }

  return (
    <PreviewPane
      embedded
      onRestartServer={target.kind === 'url' ? (restartPreviewServer ?? undefined) : undefined}
      reloadRequest={previewReloadRequest}
      tabId={tabId}
      target={target}
    />
  )
}
