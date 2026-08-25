import { Globe } from 'lucide-react'

import { PREVIEW_BROWSER_ATTR } from '@/app/browser/browser-nav'
import { PALETTE_AREA } from '@/app/command-palette/contrib'
import { CONTEXT_MENU_ITEMS_AREA } from '@/app/context-menu/contrib'
import {
  type ContextMenuItemContext,
  type ContextMenuSection,
  registerContextTarget
} from '@/app/context-menu/registry'
import { $contextMenu } from '@/app/context-menu/store'
import { isWebUrl, resolveDomTarget } from '@/app/context-menu/target'
import { registry } from '@/contrib/registry'
import { writeClipboardText } from '@/lib/clipboard'
import { openExternalLink } from '@/lib/external-link'
import {
  $browserState,
  $browserSupported,
  browserBack,
  browserForward,
  browserReload,
  openInAppBrowser,
  toggleInAppBrowser
} from '@/store/browser'
import { claimGuestOcclusion } from '@/store/browser-occlusion'

/**
 * The in-app browser's contributions: two rows in MJXHRM-478's menu, one row in
 * the ⌘K palette, and one thing this deliberately does NOT do.
 *
 * 1. A `webview` target kind (order 20, the slot 478 reserved) for a gesture on
 *    the browser pane's own surface — its chrome, its empty state, the
 *    placeholder while a dialog is above it.
 * 2. An "Open in in-app browser" row on any web link, anywhere in the app.
 *
 * It does NOT try to serve a right-click INSIDE the guest. A right-click there
 * never produces a `contextmenu` event in the host document, so 478's
 * window-level listener never fires and its classifier is never called — and
 * giving the guest a push channel for it would be exactly the IPC surface the
 * navigation guard exists to avoid. The guest draws its OWN menu instead, in
 * the injected script, from the same verbs. (Reconciliation C5, option (a).)
 */

export interface GuestSurfaceHit {
  url: string
}

export function registerBrowserContributions(): () => void {
  const offTarget = registerContextTarget<GuestSurfaceHit>({
    items: ({ close, data, t }): ContextMenuSection[] => {
      const page = $browserState.get()

      return [
        [
          {
            disabled: !page.canBack,
            icon: 'arrow-left',
            label: t.browser.back,
            onSelect: () => {
              close()
              void browserBack()
            }
          },
          {
            disabled: !page.canForward,
            icon: 'arrow-right',
            label: t.browser.forward,
            onSelect: () => {
              close()
              void browserForward()
            }
          },
          {
            icon: 'refresh',
            label: t.browser.reload,
            onSelect: () => {
              close()
              void browserReload()
            }
          }
        ],
        [
          {
            disabled: !data.url,
            icon: 'copy',
            label: t.browser.copyUrl,
            onSelect: () => {
              close()
              void writeClipboardText(data.url)
            }
          },
          {
            disabled: !data.url,
            icon: 'link-external',
            label: t.browser.openExternally,
            onSelect: () => {
              close()
              void openExternalLink(data.url)
            }
          }
        ]
      ]
    },
    kind: 'webview',
    // 478 reserves `order < 100` for core and names 20 as this kind's slot;
    // `dom` sits last at 100 because it is TOTAL.
    order: 20,
    classify: gesture => {
      const pane = gesture.element?.closest?.(`[${PREVIEW_BROWSER_ATTR}]`)

      return pane ? { url: $browserState.get().url } : null
    }
  })

  const offRow = registry.register({
    area: CONTEXT_MENU_ITEMS_AREA,
    data: {
      provide: ({ close, gesture, t }: ContextMenuItemContext) => {
        // The link the gesture landed on, read the same way 478 reads it.
        const link = resolveDomTarget(gesture.element).linkUrl

        if (!link || !isWebUrl(link) || !$browserSupported.get()) {
          return []
        }

        return [
          [
            {
              icon: 'globe',
              // 478 declared this key before its consumer existed, so this is a
              // ROW, not a locale sweep.
              label: t.contextMenu.link.openInApp,
              onSelect: () => {
                close()
                void openInAppBrowser(link)
              }
            }
          ]
        ]
      },
      // Not on the `webview` kind: a link inside the pane's own chrome is our
      // address bar, and re-opening it in the pane it is already in is a no-op
      // row.
      targets: ['dom']
    },
    id: 'browser.openInApp',
    order: -10,
    source: 'core'
  })

  const offPalette = registry.register({
    area: PALETTE_AREA,
    data: {
      // The row shows the LIVE combo for the keybind, so rebinding ⌘⇧L is
      // reflected here without a second source of truth.
      action: 'view.toggleBrowser',
      icon: Globe,
      id: 'browser.open',
      keywords: ['browser', 'web', 'url', 'preview', 'internet'],
      labelKey: 'browser.paletteOpen',
      run: () => void toggleInAppBrowser()
    },
    id: 'browser.open',
    order: -500,
    source: 'core'
  })

  // The app-wide context menu is opened from a STORE, not from a component
  // every menu shares, so the guest is hidden by subscribing to the atom rather
  // than by asking 478's coordinator to call in (reconciliation C4). Strictly
  // better than a call site, too: it covers a menu opened by ANY of the
  // per-surface Radix menus, not just the coordinator's own.
  let releaseMenu: null | (() => void) = null

  const offMenu = $contextMenu.subscribe(menu => {
    if (menu && !releaseMenu) {
      releaseMenu = claimGuestOcclusion('context-menu')

      return
    }

    if (!menu && releaseMenu) {
      releaseMenu()
      releaseMenu = null
    }
  })

  return () => {
    offTarget()
    offRow()
    offPalette()
    offMenu()
    releaseMenu?.()
    releaseMenu = null
  }
}
