import { useEffect, useState } from 'react'

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
import { deleteSession, listSessions, setSessionArchived } from '@/hermes'
import { useI18n } from '@/i18n'
import { Archive, Trash } from '@/lib/icons'
import { notify, notifyError } from '@/store/notifications'
import type { SessionInfo } from '@/types/hermes'

import { EmptyState, ListRow, LoadingState, SettingsContent } from './primitives'

// Archived chats (Jc11): list archived sessions with unarchive + permanent
// delete. Self-contained (own fetch) — the main session store only tracks the
// active list.
export function ArchivedSection() {
  const { t } = useI18n()
  const s = t.settings.sessions
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<SessionInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await listSessions(50, 0, 'only', 'recent')
        if (!cancelled) {
          setSessions(res.sessions)
        }
      } catch (err) {
        if (!cancelled) {
          setFailed(true)
        }
        notifyError(err, s.failedLoad)
      }
    })()
    return () => void (cancelled = true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, [])

  const drop = (id: string) => setSessions(list => (list ? list.filter(x => x.id !== id) : list))

  const unarchive = async (id: string) => {
    setBusy(id)
    try {
      await setSessionArchived(id, false)
      drop(id)
      notify({ kind: 'success', message: s.restored })
    } catch (err) {
      notifyError(err, s.unarchiveFailed)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (id: string) => {
    setConfirm(null)
    setBusy(id)
    try {
      await deleteSession(id)
      drop(id)
    } catch (err) {
      notifyError(err, s.deleteFailed)
    } finally {
      setBusy(null)
    }
  }

  const titleOf = (session: SessionInfo) => session.title || session.preview || session.id.slice(0, 8)

  if (!sessions && !failed) {
    return <LoadingState label={s.loading} />
  }

  return (
    <SettingsContent>
      <p className="pt-3 pb-1 text-xs text-muted-foreground">{s.archivedIntro}</p>

      {sessions && sessions.length === 0 ? (
        <EmptyState description={s.emptyArchivedDesc} title={s.emptyArchivedTitle} />
      ) : (
        (sessions ?? []).map(session => (
          <ListRow
            key={session.id}
            description={s.messages(session.message_count)}
            title={<span className="truncate">{titleOf(session)}</span>}
            action={
              <div className="flex items-center gap-1">
                <Button aria-label={s.unarchive} disabled={busy === session.id} onClick={() => void unarchive(session.id)} size="icon-sm" variant="ghost">
                  <Archive className="size-4" />
                </Button>
                <Button
                  aria-label={s.deletePermanently}
                  disabled={busy === session.id}
                  onClick={() => setConfirm(session)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash className="size-4" />
                </Button>
              </div>
            }
          />
        ))
      )}

      <Dialog onOpenChange={open => !open && setConfirm(null)} open={confirm !== null}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{s.deletePermanently}</DialogTitle>
            <DialogDescription>{confirm ? s.deleteConfirm(titleOf(confirm)) : ''}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">{t.common.cancel}</Button>
            </DialogClose>
            <Button onClick={() => confirm && void remove(confirm.id)} variant="destructive">
              {s.deletePermanently}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsContent>
  )
}
