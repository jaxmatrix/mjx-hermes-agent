import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useI18n } from '@/i18n'
import { notify } from '@/store/notifications'
import { installMcp, loadMcpCatalog } from '@/store/mcp'
import type { McpCatalogEntry } from '@/types/hermes'

// Browse the MCP catalog + install an entry (with any required env). OAuth
// entries can't complete sign-in from the phone (the browser opens on the
// gateway host) — they show a "finish on desktop" note. FIXME(K2): MCP OAuth.
const isOAuth = (entry: McpCatalogEntry) => /oauth/i.test(entry.auth_type)

export function McpCatalogSheet({ onInstalled, onOpenChange, open }: { onInstalled: () => void; onOpenChange: (open: boolean) => void; open: boolean }) {
  const { t } = useI18n()
  const m = t.skills.mcp
  const [entries, setEntries] = useState<McpCatalogEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [env, setEnv] = useState<Record<string, string>>({})
  const [installing, setInstalling] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    setEntries(null)
    setFailed(false)
    setExpanded(null)
    setEnv({})
    let cancelled = false
    void loadMcpCatalog()
      .then(list => !cancelled && setEntries(list.filter(e => !e.installed)))
      .catch(() => !cancelled && setFailed(true))
    return () => void (cancelled = true)
  }, [open])

  const install = async (entry: McpCatalogEntry) => {
    setInstalling(entry.name)
    const values = Object.fromEntries(entry.required_env.map(e => [e.name, env[e.name] ?? '']).filter(([, v]) => v))
    const ok = await installMcp(entry.name, values, m.reloadFailed)
    setInstalling(null)
    if (ok) {
      notify({ kind: 'success', message: m.installedOk(entry.name) })
      onInstalled()
      onOpenChange(false)
    }
  }

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="max-h-[min(42rem,92vh)] gap-3 overflow-y-auto rounded-t-xl p-4" side="bottom">
        <SheetHeader className="p-0">
          <SheetTitle>{m.browseCatalog}</SheetTitle>
          <SheetDescription>{m.noServersDesc}</SheetDescription>
        </SheetHeader>

        {entries === null && !failed ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{m.loading}</p>
        ) : failed ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{m.catalogFailed}</p>
        ) : entries && entries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{m.noCatalog}</p>
        ) : (
          (entries ?? []).map(entry => {
            const open_ = expanded === entry.name
            return (
              <div className="rounded-lg border border-border p-3" key={entry.name}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{entry.name}</div>
                    <div className="text-xs text-muted-foreground">{entry.description}</div>
                  </div>
                  <Button
                    disabled={installing === entry.name}
                    onClick={() => (entry.required_env.length > 0 ? setExpanded(open_ ? null : entry.name) : void install(entry))}
                    size="sm"
                    variant="outline"
                  >
                    {installing === entry.name ? m.installing : m.install}
                  </Button>
                </div>

                {isOAuth(entry) && <p className="mt-2 text-xs text-primary">{m.authNote}</p>}

                {open_ && entry.required_env.length > 0 && (
                  <div className="mt-3 flex flex-col gap-2">
                    <div className="text-xs font-medium text-muted-foreground">{m.needsEnv}</div>
                    {entry.required_env.map(field => (
                      <Input
                        key={field.name}
                        onChange={e => setEnv(c => ({ ...c, [field.name]: e.target.value }))}
                        placeholder={field.prompt || field.name}
                        type="password"
                        value={env[field.name] ?? ''}
                      />
                    ))}
                    <Button disabled={installing === entry.name} onClick={() => void install(entry)} size="sm">
                      {m.install}
                    </Button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </SheetContent>
    </Sheet>
  )
}
