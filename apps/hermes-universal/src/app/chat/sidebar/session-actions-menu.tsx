import type * as React from 'react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { notify, notifyError } from '@/store/notifications'
import { renameSessionLocal } from '@/store/session'

// Row action set (ported/adapted from desktop `session-actions-menu.tsx`).
// Shared by the kebab DropdownMenu and the right-click ContextMenu.
// FIXME(sidebar): Export (H4), Branch-from (H5), and Open-in-new-window
// (single-window on universal) are intentionally omitted — gated to their tracks.

interface SessionActions {
  sessionId: string
  title: string
  pinned?: boolean
  onPin?: () => void
  onArchive?: () => void
  onDelete?: () => void
}

type MenuItemComponent = typeof DropdownMenuItem | typeof ContextMenuItem

interface ItemSpec {
  className?: string
  disabled: boolean
  icon: string
  label: string
  onSelect: (event: Event) => void
  variant?: 'destructive'
}

function useSessionActions({ sessionId, title, pinned = false, onPin, onArchive, onDelete }: SessionActions) {
  const { t } = useI18n()
  const r = t.sidebar.row
  const [renameOpen, setRenameOpen] = useState(false)

  const specs: ItemSpec[] = [
    {
      disabled: !onPin,
      icon: 'pin',
      label: pinned ? r.unpin : r.pin,
      onSelect: () => {
        void triggerHaptic('selection')
        onPin?.()
      }
    },
    {
      disabled: !sessionId,
      icon: 'copy',
      label: r.copyId,
      onSelect: () => {
        void navigator.clipboard?.writeText(sessionId).catch(err => notifyError(err, r.copyIdFailed))
      }
    },
    {
      disabled: !sessionId,
      icon: 'edit',
      label: r.rename,
      onSelect: () => {
        void triggerHaptic('selection')
        setRenameOpen(true)
      }
    },
    {
      disabled: !onArchive,
      icon: 'archive',
      label: r.archive,
      onSelect: () => {
        void triggerHaptic('selection')
        onArchive?.()
      }
    },
    {
      className: 'text-destructive focus:text-destructive',
      disabled: !onDelete,
      icon: 'trash',
      label: t.common.delete,
      onSelect: () => {
        void triggerHaptic('warning')
        onDelete?.()
      },
      variant: 'destructive'
    }
  ]

  const renderItems = (Item: MenuItemComponent) => (
    <>
      {specs.map(({ className, disabled, icon, label, onSelect, variant }) => (
        <Item className={className} disabled={disabled} key={label} onSelect={onSelect} variant={variant}>
          <Codicon name={icon} size="0.875rem" />
          <span>{label}</span>
        </Item>
      ))}
    </>
  )

  const renameDialog = (
    <RenameSessionDialog currentTitle={title} onOpenChange={setRenameOpen} open={renameOpen} sessionId={sessionId} />
  )

  return { renameDialog, renderItems }
}

interface SessionActionsMenuProps extends SessionActions {
  children: React.ReactNode
}

export function SessionActionsMenu({ children, ...actions }: SessionActionsMenuProps) {
  const { t } = useI18n()
  const { renameDialog, renderItems } = useSessionActions(actions)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label={t.sidebar.row.actionsFor(actions.title)} className="w-40">
          {renderItems(DropdownMenuItem)}
        </DropdownMenuContent>
      </DropdownMenu>
      {renameDialog}
    </>
  )
}

interface SessionContextMenuProps extends SessionActions {
  children: React.ReactNode
}

export function SessionContextMenu({ children, ...actions }: SessionContextMenuProps) {
  const { t } = useI18n()
  const { renameDialog, renderItems } = useSessionActions(actions)

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent aria-label={t.sidebar.row.actionsFor(actions.title)} className="w-40">
          {renderItems(ContextMenuItem)}
        </ContextMenuContent>
      </ContextMenu>
      {renameDialog}
    </>
  )
}

interface RenameSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  currentTitle: string
}

function RenameSessionDialog({ open, onOpenChange, sessionId, currentTitle }: RenameSessionDialogProps) {
  const { t } = useI18n()
  const r = t.sidebar.row
  const [value, setValue] = useState(currentTitle)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue(currentTitle)
      window.setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [currentTitle, open])

  const submit = async () => {
    const next = value.trim()

    if (!sessionId || submitting || next === currentTitle.trim()) {
      onOpenChange(false)
      return
    }

    setSubmitting(true)
    try {
      await renameSessionLocal(sessionId, next)
      notify({ durationMs: 2_000, kind: 'success', message: r.renamed })
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{r.renameTitle}</DialogTitle>
          <DialogDescription>{r.renameDesc}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          disabled={submitting}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            } else if (event.key === 'Escape') {
              onOpenChange(false)
            }
          }}
          placeholder={r.untitledPlaceholder}
          ref={inputRef}
          value={value}
        />
        <DialogFooter>
          <Button disabled={submitting} onClick={() => onOpenChange(false)} type="button" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button disabled={submitting} onClick={() => void submit()} type="button">
            {t.common.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
