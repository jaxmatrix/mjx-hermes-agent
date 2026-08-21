import { useEffect, useState } from 'react'

import { deleteEnvVar, getEnvVars, revealEnvVar, setEnvVar } from '@/hermes'
import { useI18n } from '@/i18n'
import { type IconComponent } from '@/lib/icons'
import { asText, includesQuery } from '@/lib/text'
import { confirm } from '@/store/confirm'
import { notify, notifyError } from '@/store/notifications'
import type { EnvVarInfo } from '@/types/hermes'

import { redactedValue, withoutKey } from './helpers'
import { Pill } from './primitives'
import type { EnvRowProps } from './types'

// Shared filter used by every credential surface (Providers + Keys pages):
// category gate first, then a free-text match across key name + description.
// Ported from apps/desktop/src/app/settings/env-credentials.tsx.
export function filterEnv(info: EnvVarInfo, key: string, q: string, cat: string, extra?: string): boolean {
  if (asText(info.category) !== cat) {
    return false
  }

  if (!q) {
    return true
  }

  return (
    key.toLowerCase().includes(q) ||
    includesQuery(info.description, q) ||
    Boolean(extra && extra.toLowerCase().includes(q))
  )
}

export function SettingsCategoryHeading({ count, icon: Icon, title }: CategoryHeadingProps) {
  return (
    <div className="mb-3 flex items-center gap-2 text-[length:var(--conversation-text-font-size)] font-medium">
      <Icon className="size-4 text-muted-foreground" />
      <span>{title}</span>
      {count && <Pill>{count}</Pill>}
    </div>
  )
}

// Owns the env-var fetch + the edit/reveal/save/delete lifecycle so multiple
// credential pages (Providers, Keys) share one source of truth and one set of
// mutation handlers instead of duplicating the plumbing.
//
// `scopeProfile` is the settings "Applies to" override — a profile whose .env
// this hook reads and writes INSTEAD of the app-wide active one. Omitting it
// keeps the pre-existing behaviour exactly (no `?profile=` on the wire), which
// is what the Providers page wants: desktop scopes Keys, not Providers.
export function useEnvCredentials(scopeProfile?: null | string): UseEnvCredentials {
  const { t } = useI18n()
  const credentials = t.settings.credentials
  const toolsets = t.settings.toolsets
  const [vars, setVars] = useState<Record<string, EnvVarInfo> | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)

  // A scope change re-targets every row, so drop the fetched rows AND the local
  // drafts/reveals: profile A's typed key must never be savable into profile B.
  useEffect(() => {
    let cancelled = false

    setVars(null)
    setEdits({})
    setRevealed({})

    void (async () => {
      try {
        const next = await getEnvVars(scopeProfile ?? undefined)

        if (!cancelled) {
          setVars(next)
        }
      } catch (err) {
        notifyError(err, t.settings.keys.failedLoad)
      }
    })()

    return () => void (cancelled = true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads per scope; copy is stable
  }, [scopeProfile])

  function patchVar(key: string, patch: Partial<Pick<EnvVarInfo, 'is_set' | 'redacted_value'>>) {
    setVars(c => (c ? { ...c, [key]: { ...c[key], ...patch } } : c))
  }

  function clearLocalState(key: string) {
    setEdits(c => withoutKey(c, key))
    setRevealed(c => withoutKey(c, key))
  }

  async function handleSave(key: string) {
    const value = edits[key]

    if (!value) {
      return
    }

    setSaving(key)

    try {
      await setEnvVar(key, value, scopeProfile ?? undefined)
      patchVar(key, { is_set: true, redacted_value: redactedValue(value) })
      clearLocalState(key)
      notify({ kind: 'success', title: toolsets.savedTitle, message: toolsets.savedMessage(key) })
    } catch (err) {
      notifyError(err, toolsets.failedSave(key))
    } finally {
      setSaving(null)
    }
  }

  // Direct save for a known value (no edit-state round-trip) — used by the
  // onboarding-style key form, which owns its own input. Returns a result so
  // the form can surface inline errors instead of only toasting.
  async function saveValue(key: string, value: string): Promise<{ message?: string; ok: boolean }> {
    const trimmed = value.trim()

    if (!trimmed) {
      return { message: credentials.enterValueFirst, ok: false }
    }

    setSaving(key)

    try {
      await setEnvVar(key, trimmed, scopeProfile ?? undefined)
      patchVar(key, { is_set: true, redacted_value: redactedValue(trimmed) })
      clearLocalState(key)
      notify({ kind: 'success', message: toolsets.savedMessage(key), title: toolsets.savedTitle })

      return { ok: true }
    } catch (err) {
      notifyError(err, toolsets.failedSave(key))

      return { message: err instanceof Error ? err.message : credentials.couldNotSave, ok: false }
    } finally {
      setSaving(null)
    }
  }

  async function handleClear(key: string) {
    if (!(await confirm({ destructive: true, title: toolsets.removeConfirm(key) }))) {
      return
    }

    setSaving(key)

    try {
      await deleteEnvVar(key, scopeProfile ?? undefined)
      patchVar(key, { is_set: false, redacted_value: null })
      clearLocalState(key)
      notify({ kind: 'success', title: toolsets.removedTitle, message: toolsets.removedMessage(key) })
    } catch (err) {
      notifyError(err, toolsets.failedRemove(key))
    } finally {
      setSaving(null)
    }
  }

  async function handleReveal(key: string) {
    if (revealed[key]) {
      setRevealed(c => withoutKey(c, key))

      return
    }

    try {
      const result = await revealEnvVar(key, scopeProfile ?? undefined)
      setRevealed(c => ({ ...c, [key]: result.value }))
    } catch (err) {
      notifyError(err, toolsets.failedReveal(key))
    }
  }

  return {
    saveValue,
    vars,
    rowProps: {
      edits,
      revealed,
      saving,
      setEdits,
      onSave: handleSave,
      onClear: handleClear,
      onReveal: handleReveal
    }
  }
}

interface CategoryHeadingProps {
  count?: string
  icon: IconComponent
  title: string
}

interface UseEnvCredentials {
  rowProps: Omit<EnvRowProps, 'varKey' | 'info'>
  saveValue: (key: string, value: string) => Promise<{ message?: string; ok: boolean }>
  vars: Record<string, EnvVarInfo> | null
}
