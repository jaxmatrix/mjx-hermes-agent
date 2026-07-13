import type { ReactNode } from 'react'

import { useI18n } from '@/i18n'

import { ListRow, SettingsContent } from './primitives'

// Read-only keyboard-shortcuts reference (K16, soft-keyboard adapted). Mobile
// doesn't ship a configurable keymap — touch users use buttons — but a few
// hardware-keyboard shortcuts work in the composer; this documents them.
function Keys({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground">{children}</kbd>
  )
}

export function ShortcutsSection() {
  const { t } = useI18n()
  const s = t.shortcuts

  const rows: { label: string; keys: ReactNode }[] = [
    { label: s.sendMessage, keys: <Keys>⌘/Ctrl + ↵</Keys> },
    { label: s.newLine, keys: <Keys>↵</Keys> },
    { label: s.history, keys: <Keys>↑ / ↓</Keys> },
    { label: s.dismiss, keys: <Keys>Esc</Keys> }
  ]

  return (
    <SettingsContent>
      <p className="pt-3 pb-1 text-xs text-muted-foreground">{s.intro}</p>
      <div className="pt-1">
        {rows.map(row => (
          <ListRow action={row.keys} key={row.label} title={row.label} />
        ))}
      </div>
    </SettingsContent>
  )
}
