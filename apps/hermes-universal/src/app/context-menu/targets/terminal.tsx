import type { ContextMenuItemContext, ContextMenuSection } from '@/app/context-menu/registry'
import { registerContextTarget } from '@/app/context-menu/registry'
import type { TerminalMenuHandle } from '@/app/right-pane/terminal/context-menu'
import { terminalMenuHandleFor } from '@/app/right-pane/terminal/context-menu'
import { readClipboardText, writeClipboardText } from '@/lib/clipboard'
import { formatCombo } from '@/lib/keybinds/combo'

// The terminal target, at `order` 10 — BEFORE `dom`, and that ordering is
// load-bearing rather than cosmetic. xterm mirrors its canvas selection into a
// real hidden `<textarea>` so the webview's own copy paths see something
// (`terminal/selection.ts`), which means the DOM resolver would happily call a
// right-click on the terminal "an editable" and offer edit verbs that act on
// xterm's scratch buffer.

export function terminalContextSections({
  clipboardHasText,
  close,
  data,
  t
}: ContextMenuItemContext<TerminalMenuHandle>): ContextMenuSection[] {
  const selection = data.getSelection()

  const rows: ContextMenuSection = [
    {
      disabled: selection.length === 0,
      icon: 'copy',
      key: 'terminal-copy',
      label: t.common.copy,
      onSelect: () => {
        close()
        void writeClipboardText(selection).catch(() => {
          /* a refused copy is a no-op */
        })
      },
      shortcut: formatCombo('mod+shift+c')
    }
  ]

  // No Paste row AT ALL on the read-only agent mirror: that tab has no PTY, so
  // the verb could only ever be a no-op.
  if (data.paste) {
    const paste = data.paste

    rows.push({
      disabled: !clipboardHasText,
      icon: 'clippy',
      key: 'terminal-paste',
      label: t.contextMenu.edit.paste,
      onSelect: () => {
        close()
        void readClipboardText().then(text => text && paste(text))
      },
      shortcut: formatCombo('mod+shift+v')
    })
  }

  return [
    rows,
    [
      {
        icon: 'list-selection',
        key: 'terminal-select-all',
        label: t.contextMenu.edit.selectAll,
        onSelect: () => {
          close()
          data.selectAll()
        }
      }
    ]
  ]
}

registerContextTarget<TerminalMenuHandle>({
  classify: ({ element }) => terminalMenuHandleFor(element),
  items: terminalContextSections,
  kind: 'terminal',
  order: 10
})
