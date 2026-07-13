import { Dialog as DialogPrimitive } from 'radix-ui'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { X } from '@/lib/icons'
import { cn } from '@/lib/utils'

// Adapted from apps/desktop/src/components/ui/dialog.tsx. Same export set + props
// (showCloseButton / fitContent / banner / bannerTone) so ported desktop dialogs
// are drop-in. Differences: keyed to the A2 named-token contract (bg-card /
// border-border / text-muted-foreground) instead of the desktop conversation/
// chrome tokens, and mobile-width sizing. The close label is i18n'd (t.common.close).

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-[120] pointer-events-auto bg-black/40 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
        className
      )}
      data-slot="dialog-overlay"
      {...props}
    />
  )
}

type DialogBannerTone = 'error' | 'warn' | 'info'

// Tinted, edge-to-edge bottom banner per tone (see DialogContent's `banner`).
const DIALOG_BANNER_TONES: Record<DialogBannerTone, string> = {
  error: 'bg-destructive/12 text-destructive',
  warn: 'bg-primary/12 text-primary',
  info: 'bg-muted text-foreground'
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  fitContent = false,
  banner,
  bannerTone = 'error',
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  // Size to content (capped) instead of the default max-w-lg.
  fitContent?: boolean
  // Dialog-level notice rendered flush to the bottom edge. Falsy → none.
  banner?: React.ReactNode
  bannerTone?: DialogBannerTone
}) {
  const { t } = useI18n()
  const widthClass = fitContent ? 'w-auto max-w-[92vw]' : 'w-full max-w-[calc(100%-2rem)] sm:max-w-lg'

  const closeButton = showCloseButton ? (
    <DialogPrimitive.Close asChild data-slot="dialog-close-button">
      <Button
        aria-label={t.common.close}
        className="absolute right-2 top-2 z-20 text-muted-foreground hover:bg-accent hover:text-foreground"
        size="icon-sm"
        variant="ghost"
      >
        <X className="size-4" />
        <span className="sr-only">{t.common.close}</span>
      </Button>
    </DialogPrimitive.Close>
  ) : null

  if (banner) {
    return (
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[130] pointer-events-auto flex max-h-[85vh] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-card text-sm text-foreground shadow-lg duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            widthClass,
            className,
            'gap-0'
          )}
          data-slot="dialog-content"
          {...props}
        >
          <div className="relative z-10 overflow-hidden rounded-lg border border-b-0 border-border bg-card">
            <div className="grid max-h-[calc(85vh-5rem)] min-h-0 gap-3 overflow-y-auto p-4">{children}</div>
          </div>
          <div
            className={cn(
              'relative z-0 -mt-[var(--radius-lg)] px-4 pb-2.5 pt-[calc(var(--radius-lg)+0.625rem)] text-center text-sm leading-relaxed',
              DIALOG_BANNER_TONES[bannerTone]
            )}
            data-slot="dialog-banner"
            role={bannerTone === 'error' ? 'alert' : 'status'}
          >
            {banner}
          </div>
          {closeButton}
        </DialogPrimitive.Content>
      </DialogPortal>
    )
  }

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-[130] pointer-events-auto grid max-h-[85vh] -translate-x-1/2 -translate-y-1/2 gap-3 overflow-y-auto rounded-lg border border-border bg-card p-4 text-sm text-foreground shadow-lg duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          widthClass,
          className
        )}
        data-slot="dialog-content"
        {...props}
      >
        {children}
        {closeButton}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div className={cn('flex flex-col gap-1 text-center sm:text-left', className)} data-slot="dialog-header" {...props} />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      data-slot="dialog-footer"
      {...props}
    />
  )
}

function DialogTitle({
  className,
  icon: Icon,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title> & {
  // Pass an icon (from @/lib/icons) for the canonical primary-tinted header glyph.
  icon?: React.ComponentType<{ className?: string }>
}) {
  return (
    <DialogPrimitive.Title
      className={cn('text-base font-semibold tracking-tight text-foreground', Icon && 'flex items-center gap-2', className)}
      data-slot="dialog-title"
      {...props}
    >
      {Icon ? <Icon className="size-4 shrink-0 text-primary" /> : null}
      {children}
    </DialogPrimitive.Title>
  )
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-sm leading-normal text-muted-foreground', className)}
      data-slot="dialog-description"
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger
}
