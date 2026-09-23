import { Button } from '@/components/ui/button'
import { ErrorIcon } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { TabConnection } from '@/store/tab-connection'

/**
 * The one banner both hosts render for a tab whose backend is not there
 * (MJXHRM-591, invariants 39 and 40).
 *
 * It sits at the BOTTOM of the chat, across the whole width — the owner's
 * framing, and the right one: a chat that cannot send is still a chat you read,
 * so the failure belongs where the composer is rather than over the transcript.
 * The chat itself wears a red inner border (see `chat-screen`), which is what
 * makes a tab in a four-pane layout findable at a glance.
 *
 * ONE component, two hosts: the desktop tile and the mobile chat mount the same
 * element, because two of these would drift the moment either state gained a
 * verb. Two states, and their verbs are deliberately different:
 *
 *  * LOST offers Retry. The connection is this tab's and it may come back; the
 *    client is already climbing, and this is the user's way to jump the queue.
 *  * UNAVAILABLE offers Close, and nothing else (the action list is exactly
 *    `['close']`). The backend behind this tab changed, or was never reachable
 *    from this device — there is nothing to retry, and a Retry here would ask
 *    the user to keep pulling a lever with nothing on the end of it.
 */
export function ChatConnectionBanner({
  className,
  label,
  onClose,
  onRetry,
  state
}: {
  className?: string
  /** The connection's name, for the lost copy. */
  label: string
  onClose?: () => void
  onRetry?: () => void
  state: TabConnection
}) {
  const { t } = useI18n()
  const copy = t.chatConnection

  if (state.kind === 'ok') {
    return null
  }

  const unavailable = state.kind === 'unavailable'
  const title = unavailable ? copy.changedTitle : copy.lostTitle

  const message = unavailable
    ? state.reason === 'unsupported-platform'
      ? copy.notOnThisDevice
      : copy.changedMessage
    : copy.lostMessage(label)

  return (
    <div
      className={cn(
        // Full width, at the bottom of the chat: an error box taking the whole
        // horizontal line, not a chip tucked into a corner.
        'flex w-full items-start gap-2 rounded-(--radius) border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive',
        className
      )}
      data-testid="chat-connection-banner"
      role="alert"
    >
      <ErrorIcon className="mt-0.5 shrink-0" size="0.9rem" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[0.78rem] font-medium leading-4">{title}</span>
        <span className="min-w-0 text-[0.73rem] leading-4 text-destructive/85">{message}</span>
      </div>
      {/* The verbs. `me-` / `ms-` nowhere here: the row is a flex line, so RTL
          mirrors it without a single physical offset. */}
      {!unavailable && onRetry && (
        <Button className="shrink-0" onClick={onRetry} size="micro" type="button" variant="text">
          {copy.retry}
        </Button>
      )}
      {unavailable && onClose && (
        <Button className="shrink-0" onClick={onClose} size="micro" type="button" variant="text">
          {copy.close}
        </Button>
      )}
    </div>
  )
}

/**
 * The transcript area when the connection is down and nothing was cached.
 *
 * The owner chose this over an empty chat: a blank transcript under a red
 * banner reads as "this conversation is empty", which is a lie about the
 * conversation rather than a statement about the connection. Shown ONLY when
 * there is no cached tail — an empty conversation on a live connection keeps
 * whatever the app does today.
 */
export function TranscriptUnavailable({ className }: { className?: string }) {
  const { t } = useI18n()

  return (
    <div
      className={cn('grid h-full place-items-center px-6 text-center', className)}
      data-testid="transcript-unavailable"
    >
      <p className="max-w-xs text-[0.8rem] leading-5 text-muted-foreground">{t.chatConnection.reconnectToLoad}</p>
    </div>
  )
}
