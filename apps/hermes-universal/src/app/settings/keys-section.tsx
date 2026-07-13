import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { deleteEnvVar, getEnvVars, revealEnvVar, setEnvVar } from '@/hermes'
import { useI18n } from '@/i18n'
import { Eye, EyeOff, Search, Trash } from '@/lib/icons'
import { includesQuery } from '@/lib/text'
import { notify, notifyError } from '@/store/notifications'
import type { EnvVarInfo } from '@/types/hermes'

import { providerGroup as prefixGroup, redactedValue, withoutKey } from './helpers'
import { ListRow, LoadingState, SettingsContent } from './primitives'

// Keys/credentials (Jc10): env-var list grouped by provider, with set / replace /
// reveal / clear. Ported+leaned from desktop env-credentials.tsx + credential-key-ui.tsx;
// window.confirm swapped for a mobile Dialog. OAuth provider connect is Track D2.

type Vars = Record<string, EnvVarInfo>

function groupOf(key: string, info: EnvVarInfo): string {
  return info.provider_label || prefixGroup(key)
}

export function KeysSection() {
  const { t } = useI18n()
  const [vars, setVars] = useState<Vars | null>(null)
  const [failed, setFailed] = useState(false)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const next = await getEnvVars()
        if (!cancelled) {
          setVars(next)
        }
      } catch (err) {
        if (!cancelled) {
          setFailed(true)
        }
        notifyError(err, t.settings.keys.failedLoad)
      }
    })()
    return () => void (cancelled = true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, [])

  const patch = (key: string, next: Partial<EnvVarInfo>) =>
    setVars(c => (c ? { ...c, [key]: { ...c[key], ...next } } : c))

  const save = async (key: string) => {
    const value = edits[key]?.trim()
    if (!value) {
      return
    }
    setBusy(key)
    try {
      await setEnvVar(key, value)
      patch(key, { is_set: true, redacted_value: redactedValue(value) })
      setEdits(c => withoutKey(c, key))
      setRevealed(c => withoutKey(c, key))
    } catch (err) {
      notifyError(err, t.settings.credentials.couldNotSave)
    } finally {
      setBusy(null)
    }
  }

  const reveal = async (key: string) => {
    if (revealed[key]) {
      setRevealed(c => withoutKey(c, key))
      return
    }
    try {
      const result = await revealEnvVar(key)
      setRevealed(c => ({ ...c, [key]: result.value }))
    } catch (err) {
      notifyError(err, t.settings.credentials.couldNotSave)
    }
  }

  const clear = async (key: string) => {
    setConfirmKey(null)
    setBusy(key)
    try {
      await deleteEnvVar(key)
      patch(key, { is_set: false, redacted_value: null })
      setRevealed(c => withoutKey(c, key))
      notify({ kind: 'success', message: t.settings.envActions.clear })
    } catch (err) {
      notifyError(err, t.settings.credentials.couldNotSave)
    } finally {
      setBusy(null)
    }
  }

  const groups = useMemo(() => {
    if (!vars) {
      return []
    }
    const q = query.trim().toLowerCase()
    const byGroup = new Map<string, [string, EnvVarInfo][]>()
    for (const [key, info] of Object.entries(vars)) {
      if (info.channel_managed) {
        continue // Messaging page owns these.
      }
      if (q && !key.toLowerCase().includes(q) && !includesQuery(info.description, q)) {
        continue
      }
      const name = groupOf(key, info)
      const list = byGroup.get(name) ?? []
      list.push([key, info])
      byGroup.set(name, list)
    }
    return [...byGroup.entries()].sort(([a], [b]) =>
      a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)
    )
  }, [vars, query])

  if (!vars && !failed) {
    return <LoadingState label={t.settings.keys.loading} />
  }

  return (
    <SettingsContent>
      <div className="relative pt-3 pb-1">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-[calc(50%-0.375rem)] text-muted-foreground" />
        <Input
          className="pl-9"
          onChange={e => setQuery(e.target.value)}
          placeholder={t.settings.searchPlaceholder.keys}
          value={query}
        />
      </div>

      {groups.length === 0 ? (
        <p className="px-1 py-10 text-center text-sm text-muted-foreground">{t.settings.keys.empty}</p>
      ) : (
        groups.map(([name, entries]) => (
          <div className="mt-4" key={name}>
            <div className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{name}</div>
            {entries.map(([key, info]) => (
              <ListRow
                key={key}
                description={info.description}
                hint={info.is_set ? (revealed[key] ?? info.redacted_value ?? '••••') : undefined}
                title={<span className="font-mono text-xs">{key}</span>}
                wide
                action={
                  <div className="flex items-center gap-2">
                    <Input
                      onChange={e => setEdits(c => ({ ...c, [key]: e.target.value }))}
                      placeholder={info.is_set ? t.settings.envActions.replace : t.settings.credentials.pasteKey}
                      type="password"
                      value={edits[key] ?? ''}
                    />
                    <Button
                      disabled={busy === key || !edits[key]?.trim()}
                      onClick={() => void save(key)}
                      size="sm"
                    >
                      {info.is_set ? t.settings.envActions.replace : t.settings.envActions.set}
                    </Button>
                    {info.is_set && (
                      <>
                        <Button aria-label={t.settings.envActions.revealValue} onClick={() => void reveal(key)} size="icon-sm" variant="ghost">
                          {revealed[key] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </Button>
                        <Button
                          aria-label={t.settings.envActions.clear}
                          disabled={busy === key}
                          onClick={() => setConfirmKey(key)}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <Trash className="size-4" />
                        </Button>
                      </>
                    )}
                  </div>
                }
              />
            ))}
          </div>
        ))
      )}

      <Dialog onOpenChange={open => !open && setConfirmKey(null)} open={confirmKey !== null}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.settings.envActions.clear}</DialogTitle>
            <DialogDescription>
              <span className="font-mono text-xs">{confirmKey}</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">{t.common.cancel}</Button>
            </DialogClose>
            <Button onClick={() => confirmKey && void clear(confirmKey)} variant="destructive">
              {t.settings.envActions.clear}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsContent>
  )
}
