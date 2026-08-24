import {
  copyImageFrom,
  editableCommand,
  editableSelectionText,
  isComposing,
  saveImageFrom,
  withEditableFocus
} from '@/app/context-menu/actions'
import type {
  ContextMenuItemContext,
  ContextMenuItemSpec,
  ContextMenuSection
} from '@/app/context-menu/registry'
import { registerContextTarget } from '@/app/context-menu/registry'
import type { ContextMenuDomTarget } from '@/app/context-menu/target'
import { isWebUrl, resolveDomTarget } from '@/app/context-menu/target'
import { SETTINGS_ROUTE } from '@/app/routes'
import type { Translations } from '@/i18n/types'
import { writeClipboardText } from '@/lib/clipboard'
import { openExternalLink } from '@/lib/external-link'
import { formatCombo } from '@/lib/keybinds/combo'
import { mediaExternalUrl } from '@/lib/media'
import { IS_DESKTOP } from '@/lib/platform'
import { openCommandPalette } from '@/store/command-palette'
import { startNewSession } from '@/store/new-session'
import { notifyError } from '@/store/notifications'
import { toggleStatusbarVisible } from '@/store/statusbar-prefs'
import { runUpdateCheck } from '@/store/updates'
import { canOpenNewWindow, openAppRoute, openNewWindow } from '@/store/windows'

// The `dom` target: the app's own DOM, and the LAST classifier by design.
//
// It is TOTAL — every gesture that reached the coordinator lands here if nothing
// with a lower `order` claimed it — which is why nothing may register after it
// and why a gesture that owns nothing still gets a menu (the shell verbs below)
// rather than an empty one.

function linkSection(target: ContextMenuDomTarget, t: Translations, close: () => void): ContextMenuSection {
  if (!target.linkUrl) {
    return []
  }

  return [
    {
      icon: 'link-external',
      key: 'link-open',
      label: t.contextMenu.link.openExternal,
      onSelect: () => {
        close()
        void openExternalLink(target.linkUrl)
      }
    },
    {
      icon: 'copy',
      key: 'link-copy',
      label: t.contextMenu.link.copyUrl,
      onSelect: () => {
        close()
        void writeClipboardText(target.linkUrl).catch(() => {
          /* a refused copy is a no-op, not a dialog */
        })
      }
    }
  ]
}

function imageSection(
  target: ContextMenuDomTarget,
  gestureElement: Element | null,
  t: Translations,
  close: () => void
): ContextMenuSection {
  if (!target.onImage || !target.imageUrl) {
    return []
  }

  const element = gestureElement?.closest('img')
  const image = element instanceof HTMLImageElement ? element : null
  const src = target.imageUrl
  const rows: ContextMenuItemSpec[] = []

  // Both image commands are hidden, not disabled, off desktop: the clipboard
  // plugin implements no image write on Android/iOS and `plugin-dialog` has no
  // save picker there, so the rows could only ever fail. "Open in external
  // browser" + "Copy image address" carry the intent instead.
  if (IS_DESKTOP) {
    rows.push({
      icon: 'file-media',
      key: 'image-copy',
      label: t.contextMenu.image.copyImage,
      onSelect: () => {
        close()
        void copyImageFrom(src, image).catch(error => notifyError(error, t.contextMenu.image.copyFailed))
      }
    })
  }

  rows.push({
    icon: 'copy',
    key: 'image-copy-address',
    label: t.contextMenu.image.copyImageAddress,
    onSelect: () => {
      close()
      void writeClipboardText(src).catch(() => {
        /* nothing to say */
      })
    }
  })

  if (IS_DESKTOP) {
    rows.push({
      icon: 'save',
      key: 'image-save',
      label: t.contextMenu.image.saveImageAs,
      onSelect: () => {
        close()
        void saveImageFrom(src).catch(error => notifyError(error, t.contextMenu.image.saveFailed))
      }
    })
  }

  rows.push({
    icon: 'link-external',
    key: 'image-open',
    label: t.contextMenu.link.openExternal,
    onSelect: () => {
      close()
      void openExternalLink(isWebUrl(src) ? src : mediaExternalUrl(src))
    }
  })

  return rows
}

/**
 * Spelling suggestions (v2 — `native.spelling` is never populated in v1).
 *
 * The section is written now so the engine adapter that eventually fills it is
 * purely additive: no JS changes when a WebKitGTK / WKWebView / WebView2 bridge
 * lands. `Add to dictionary` is deliberately NOT here — a row that can never
 * enable is worse than an absent one.
 */
function spellingSection(context: ContextMenuItemContext<ContextMenuDomTarget>): ContextMenuSection {
  const spelling = context.native?.spelling

  if (!spelling) {
    return []
  }

  return spelling.suggestions.slice(0, 5).map(word => ({
    key: `spell-${word}`,
    label: word,
    onSelect: () => {
      withEditableFocus(context.data.editable, () => {
        document.execCommand('insertText', false, word)
      })
    }
  }))
}

function editSection(
  context: ContextMenuItemContext<ContextMenuDomTarget>
): { edit: ContextMenuSection; selectAll: ContextMenuSection } {
  const { clipboardHasText, data, t } = context

  if (!data.editable) {
    return { edit: [], selectAll: [] }
  }

  const field =
    data.editable instanceof HTMLInputElement || data.editable instanceof HTMLTextAreaElement ? data.editable : null

  const fieldText = field ? field.value : (data.editable.textContent ?? '')
  const hasSelection = editableSelectionText(data).length > 0
  const composing = isComposing()

  const run = (command: 'copy' | 'cut' | 'paste' | 'selectAll') => () => {
    withEditableFocus(data.editable, () => {
      void editableCommand(command, data)
    })
  }

  return {
    edit: [
      {
        disabled: !hasSelection || composing,
        key: 'edit-cut',
        label: t.contextMenu.edit.cut,
        onSelect: run('cut'),
        shortcut: formatCombo('mod+x')
      },
      {
        disabled: !hasSelection,
        key: 'edit-copy',
        label: t.common.copy,
        onSelect: run('copy'),
        shortcut: formatCombo('mod+c')
      },
      {
        disabled: !clipboardHasText || composing,
        key: 'edit-paste',
        label: t.contextMenu.edit.paste,
        onSelect: run('paste'),
        shortcut: formatCombo('mod+v')
      }
    ],
    // Its own section on purpose (desktop's split): select-all is a different
    // kind of verb, and grouping it with cut/copy makes it read as a clipboard
    // action.
    selectAll: [
      {
        disabled: fieldText.length === 0,
        key: 'edit-select-all',
        label: t.contextMenu.edit.selectAll,
        onSelect: run('selectAll'),
        shortcut: formatCombo('mod+a')
      }
    ]
  }
}

function selectionSection(target: ContextMenuDomTarget, t: Translations, close: () => void): ContextMenuSection {
  if (target.editable || !target.selectionText) {
    return []
  }

  return [
    {
      icon: 'copy',
      key: 'selection-copy',
      label: t.common.copy,
      onSelect: () => {
        close()
        void writeClipboardText(target.selectionText).catch(() => {
          /* nothing to say */
        })
      },
      shortcut: formatCombo('mod+c')
    }
  ]
}

/**
 * What a right-click on bare chrome offers.
 *
 * Never an empty menu: a gesture that reached the app and produced nothing reads
 * as a broken app, and these are the five verbs the shell has anyway.
 */
function shellSections(t: Translations, close: () => void): ContextMenuSection[] {
  const first: ContextMenuSection = [
    {
      icon: 'add',
      key: 'shell-new-chat',
      label: t.commandCenter.nav.newChat.title,
      onSelect: () => {
        close()
        startNewSession()
      }
    }
  ]

  if (canOpenNewWindow()) {
    first.push({
      icon: 'multiple-windows',
      key: 'shell-new-window',
      label: t.keybinds.actions['session.newWindow'],
      onSelect: () => {
        close()
        void openNewWindow()
      }
    })
  }

  first.push({
    icon: 'search',
    key: 'shell-palette',
    label: t.commandCenter.paletteTitle,
    onSelect: () => {
      close()
      openCommandPalette()
    }
  })

  const second: ContextMenuSection = [
    {
      icon: 'layout-statusbar',
      key: 'shell-statusbar',
      label: t.keybinds.actions['view.toggleStatusbar'],
      onSelect: () => {
        close()
        toggleStatusbarVisible()
      }
    },
    {
      icon: 'settings-gear',
      key: 'shell-settings',
      label: t.commandCenter.settings,
      onSelect: () => {
        close()
        openAppRoute(SETTINGS_ROUTE)
      }
    }
  ]

  // Hidden rather than shown-and-dead where there is no updater to ask.
  const third: ContextMenuSection = IS_DESKTOP
    ? [
        {
          icon: 'cloud-download',
          key: 'shell-updates',
          label: t.contextMenu.checkForUpdates,
          onSelect: () => {
            close()
            void runUpdateCheck(true)
          }
        }
      ]
    : []

  return [first, second, third]
}

export function domContextSections(context: ContextMenuItemContext<ContextMenuDomTarget>): ContextMenuSection[] {
  const { close, data, gesture, t } = context
  const edits = editSection(context)

  const sections = [
    linkSection(data, t, close),
    imageSection(data, gesture.element, t, close),
    spellingSection(context),
    edits.edit,
    edits.selectAll,
    selectionSection(data, t, close)
  ]

  return sections.some(section => section.length > 0) ? sections : shellSections(t, close)
}

registerContextTarget<ContextMenuDomTarget>({
  classify: ({ element }) => resolveDomTarget(element),
  items: domContextSections,
  kind: 'dom',
  order: 100
})
