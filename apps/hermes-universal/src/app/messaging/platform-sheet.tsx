import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { notify } from '@/store/notifications'
import { savePlatformEnv, testPlatform } from '@/store/messaging'
import type { MessagingPlatformInfo } from '@/types/hermes'

type FieldCopy = Record<string, { label?: string; help?: string; placeholder?: string }>

export function PlatformSheet({
  onOpenChange,
  open,
  platform
}: {
  onOpenChange: (open: boolean) => void
  open: boolean
  platform: MessagingPlatformInfo | null
}) {
  const { t } = useI18n()
  const m = t.messaging
  const fieldCopy = m.fieldCopy as FieldCopy
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (open) {
      setEdits({})
    }
  }, [open, platform])

  if (!platform) {
    return null
  }

  const save = async () => {
    const env = Object.fromEntries(Object.entries(edits).filter(([, v]) => v.trim()))
    if (Object.keys(env).length === 0) {
      onOpenChange(false)
      return
    }
    setSaving(true)
    const ok = await savePlatformEnv(platform.id, env)
    setSaving(false)
    if (ok) {
      notify({ kind: 'success', message: m.setupSaved(platform.name) })
      notify({ kind: 'info', message: m.restartToReconnect })
      onOpenChange(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const res = await testPlatform(platform.id)
      notify({ kind: res.ok ? 'success' : 'warning', message: res.message })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="max-h-[min(42rem,92vh)] gap-3 overflow-y-auto rounded-t-xl p-4" side="bottom">
        <SheetHeader className="p-0">
          <SheetTitle>{platform.name}</SheetTitle>
          <SheetDescription>{platform.description}</SheetDescription>
        </SheetHeader>

        {platform.docs_url && (
          <Button className="w-full" onClick={() => void openExternalLink(platform.docs_url)} size="sm" variant="outline">
            {m.openSetupGuide}
          </Button>
        )}

        {platform.env_vars.length === 0 ? (
          <p className="text-xs text-muted-foreground">{m.noTokenNeeded}</p>
        ) : (
          platform.env_vars.map(env => {
            const copy = fieldCopy[env.key]
            const label = copy?.label ?? env.prompt ?? env.description ?? env.key
            const help = copy?.help ?? env.description
            const placeholder = env.is_set ? m.replaceValue : (copy?.placeholder ?? env.prompt ?? m.replaceValue)
            return (
              <label className="block" key={env.key}>
                <span className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  {label}
                  {env.required ? <span className="text-primary">{m.required}</span> : null}
                </span>
                <Input
                  onChange={e => setEdits(c => ({ ...c, [env.key]: e.target.value }))}
                  placeholder={placeholder}
                  type="password"
                  value={edits[env.key] ?? ''}
                />
                {help && <span className="mt-1 block text-xs text-muted-foreground">{help}</span>}
              </label>
            )
          })
        )}

        <div className="flex gap-2">
          <Button className="flex-1" disabled={testing} onClick={() => void test()} variant="ghost">
            Test
          </Button>
          <Button className="flex-1" disabled={saving} onClick={() => void save()}>
            {m.saveChanges}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
