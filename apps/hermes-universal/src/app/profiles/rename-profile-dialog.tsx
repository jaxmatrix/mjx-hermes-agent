import { useEffect, useState } from 'react'

import { ActionStatus } from '@/components/ui/action-status'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { renameProfile } from '@/hermes'
import { useI18n } from '@/i18n'
import { AlertTriangle } from '@/lib/icons'
import { isValidProfileName } from '@/lib/profile-name'
import { cn } from '@/lib/utils'

// Self-contained rename (owns the renameProfile call) so every caller just
// reacts via onRenamed. Unchanged name is a no-op close.
export function RenameProfileDialog({
  currentName,
  isDefault = false,
  onClose,
  onRenamed,
  open
}: {
  currentName: string
  /** Default profile: the backend sets a presentation-only `display_name`
   *  (profile.yaml) instead of moving the directory, so the canonical id stays
   *  "default" and the value is free text — no slug rules, Unicode fine.
   *  Ported from apps/desktop/src/app/profiles/rename-profile-dialog.tsx. */
  isDefault?: boolean
  onClose: () => void
  onRenamed?: (name: string) => Promise<void> | void
  open: boolean
}) {
  const { t } = useI18n()
  const p = t.profiles
  const [name, setName] = useState(currentName)
  const [status, setStatus] = useState<'done' | 'idle' | 'saving'>('idle')
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    // Display-name mode starts blank — "default" is the id, not a name.
    setName(isDefault ? '' : currentName)
    setError(null)
    setStatus('idle')
  }, [currentName, isDefault, open])

  const trimmed = name.trim()
  const unchanged = !isDefault && trimmed === currentName
  const invalid = trimmed !== '' && !unchanged && !isDefault && !isValidProfileName(trimmed)
  const busy = status === 'saving' || status === 'done'

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    if (unchanged) {
      onClose()

      return
    }

    if (!trimmed || invalid) {
      setError(invalid ? p.invalidName(p.nameHint) : p.nameRequired)

      return
    }

    setStatus('saving')
    setError(null)

    try {
      await renameProfile(currentName, trimmed)
      await onRenamed?.(trimmed)
      setStatus('done')
      window.setTimeout(onClose, 800)
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : p.failedRename)
    }
  }

  return (
    <Dialog onOpenChange={value => !value && !busy && onClose()} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isDefault ? p.displayNameTitle : p.renameTitle}</DialogTitle>
          <DialogDescription>
            {isDefault ? (
              p.displayNameDesc
            ) : (
              <>
                {p.renameDescPrefix}
                <span className="font-mono">~/.local/bin</span>
                {p.renameDescSuffix}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-3" onSubmit={handleSubmit}>
          <div className="grid gap-1.5">
            <label className="text-xs font-medium" htmlFor="rename-profile-name">
              {isDefault ? p.displayNameLabel : p.newNameLabel}
            </label>
            <Input
              aria-invalid={invalid}
              autoFocus
              id="rename-profile-name"
              onChange={event => setName(event.target.value)}
              value={name}
            />
            {!isDefault && (
              <p className={cn('text-[0.66rem] leading-4', invalid ? 'text-destructive' : 'text-muted-foreground')}>
                {p.nameHint}
              </p>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <DialogFooter>
            <Button disabled={busy} onClick={onClose} type="button" variant="ghost">
              {t.common.cancel}
            </Button>
            <Button disabled={busy || invalid || unchanged} type="submit">
              <ActionStatus busy={p.renaming} done={p.renamed} idle={p.rename} state={status} />
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
