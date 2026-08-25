import { useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { writeClipboardText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $browserConsole, clearBrowserConsole, type BrowserConsoleEntry } from '@/store/browser-console'
import { requestComposerInsert } from '@/app/chat/composer/focus'
import { notify } from '@/store/notifications'

/**
 * The guest's console, as a deck at the bottom of the pane.
 *
 * It exists mostly to make a dev-server failure ACTIONABLE: the select /
 * copy / send-to-chat trio is what turns "the preview is blank" into a message
 * the agent can work from. Every string it needs was already in `i18n/en.ts`
 * and had no consumer until now.
 */
export function BrowserConsolePanel() {
  const { t } = useI18n()
  const entries = useStore($browserConsole)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const toggle = (index: number) => {
    const next = new Set(selected)

    if (next.has(index)) {
      next.delete(index)
    } else {
      next.add(index)
    }

    setSelected(next)
  }

  const textOf = (rows: BrowserConsoleEntry[]) => rows.map(row => `[${row.level}] ${row.text}`).join('\n')

  const chosen = entries.filter((_, index) => selected.has(index))

  return (
    <div className="flex max-h-[40%] min-h-24 flex-col border-t border-subtle bg-layer-1" data-glass-opaque="">
      <div className="flex items-center gap-1 border-b border-subtle px-2 py-1 text-[0.6875rem]">
        <span className="font-medium">{t.preview.console.title}</span>
        <span className="opacity-60">{t.preview.console.messages(entries.length)}</span>
        <div className="ml-auto flex items-center gap-1">
          {chosen.length ? <span className="opacity-60">{t.preview.console.selected(chosen.length)}</span> : null}
          <PanelButton
            label={t.preview.console.sendToChat}
            onSelect={() => {
              const rows = chosen.length ? chosen : entries

              if (!rows.length) {
                return
              }

              requestComposerInsert(`${t.preview.console.promptHeader}\n\n\`\`\`\n${textOf(rows)}\n\`\`\``, { mode: 'block' })
              notify({ message: t.preview.console.sentMessage(rows.length), title: t.preview.console.sentTitle })
            }}
          />
          <PanelButton
            label={chosen.length ? t.preview.console.copySelected : t.preview.console.copyAll}
            onSelect={() => void writeClipboardText(textOf(chosen.length ? chosen : entries))}
          />
          <PanelButton label={t.preview.console.clear} onSelect={clearBrowserConsole} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto font-mono text-[0.6875rem]">
        {entries.length === 0 ? (
          <p className="p-2 opacity-60">{t.preview.console.empty}</p>
        ) : (
          entries.map((entry, index) => (
            <button
              aria-label={selected.has(index) ? t.preview.console.deselect : t.preview.console.select}
              className={cn(
                'flex w-full gap-2 px-2 py-0.5 text-left hover:bg-layer-2',
                selected.has(index) && 'bg-layer-2',
                entry.level === 'error' && 'text-red-400',
                entry.level === 'warn' && 'text-amber-400'
              )}
              key={`${entry.at}-${index}`}
              onClick={() => toggle(index)}
              type="button"
            >
              <span className="shrink-0 opacity-50">{entry.level}</span>
              <span className="min-w-0 break-all">{entry.text}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

function PanelButton({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <button
      className="rounded px-1 py-0.5 opacity-70 hover:bg-layer-2 hover:opacity-100"
      onClick={onSelect}
      title={label}
      type="button"
    >
      <Codicon name="copy" size="0.6875rem" />
      <span className="sr-only">{label}</span>
    </button>
  )
}
