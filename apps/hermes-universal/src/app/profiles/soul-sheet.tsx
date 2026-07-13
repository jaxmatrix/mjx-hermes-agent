import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { getProfileSoul, updateProfileSoul } from '@/hermes'
import { useI18n } from '@/i18n'
import { notify, notifyError } from '@/store/notifications'

// SOUL.md (persona) editor for a profile, in a bottom sheet. Loads on open,
// saves via updateProfileSoul.
export function SoulSheet({
  name,
  onOpenChange,
  open
}: {
  name: string | null
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const { t } = useI18n()
  const p = t.profiles
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !name) {
      return
    }
    let cancelled = false
    setLoading(true)
    void getProfileSoul(name)
      .then(soul => !cancelled && setContent(soul.content ?? ''))
      .catch(err => !cancelled && notifyError(err, p.failedLoadSoul))
      .finally(() => !cancelled && setLoading(false))
    return () => void (cancelled = true)
  }, [open, name, p.failedLoadSoul])

  const save = async () => {
    if (!name) {
      return
    }
    setSaving(true)
    try {
      await updateProfileSoul(name, content)
      notify({ kind: 'success', message: p.soulSaved })
      onOpenChange(false)
    } catch (err) {
      notifyError(err, p.failedSaveSoul)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="max-h-[min(42rem,92vh)] gap-3 overflow-y-auto rounded-t-xl p-4" side="bottom">
        <SheetHeader className="p-0">
          <SheetTitle>{name ? `SOUL.md · ${name}` : 'SOUL.md'}</SheetTitle>
          <SheetDescription>{p.soulDesc}</SheetDescription>
        </SheetHeader>
        <Textarea
          className="min-h-64 font-mono"
          disabled={loading}
          onChange={e => setContent(e.target.value)}
          placeholder={loading ? p.loadingSoul : p.emptySoul}
          value={content}
        />
        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => onOpenChange(false)} variant="ghost">
            {t.common.cancel}
          </Button>
          <Button className="flex-1" disabled={saving || loading} onClick={() => void save()}>
            {p.saveSoul}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
