import { useEffect, useState } from 'react'

import { EmptyState, LoadingState, SettingsContent } from '@/app/settings/primitives'
import { SidebarTrigger } from '@/app/shell/sidebar'
import { Button } from '@/components/ui/button'
import { getDefaultCwd, getRepoStatus } from '@/hermes'
import { useI18n } from '@/i18n'
import { GitBranch, Refresh } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { RepoStatus, RepoStatusFile } from '@/types/hermes'

import { DiffSheet } from './diff-sheet'

// Git status letter + tone for a changed file (read-only, remote).
function fileStatus(file: RepoStatusFile): { letter: string; tone: string } {
  if (file.conflicted) {
    return { letter: 'C', tone: 'text-destructive' }
  }
  if (file.untracked) {
    return { letter: 'U', tone: 'text-primary' }
  }
  return { letter: 'M', tone: 'text-muted-foreground' }
}

export function ReviewScreen() {
  const { t } = useI18n()
  const r = t.review
  const [repoRoot, setRepoRoot] = useState('')
  const [status, setStatus] = useState<RepoStatus | null | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [diffFile, setDiffFile] = useState<string | null>(null)

  const load = async () => {
    setStatus(undefined)
    setFailed(false)
    try {
      const cwd = repoRoot || (await getDefaultCwd().catch(() => ({ cwd: '/' }))).cwd || '/'
      setRepoRoot(cwd)
      setStatus(await getRepoStatus(cwd))
    } catch {
      setFailed(true)
    }
  }

  useEffect(() => void load(), [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border p-3">
        <SidebarTrigger className="md:hidden" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-foreground">{r.title}</h1>
          {status && (
            <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              <GitBranch className="size-3.5" />
              {status.branch ?? '—'}
              {status.changed > 0 && <span>· {r.changed(status.changed)}</span>}
            </p>
          )}
        </div>
        <Button aria-label={t.common.refresh} onClick={() => void load()} size="icon-sm" variant="ghost">
          <Refresh className="size-5" />
        </Button>
      </header>

      {failed ? (
        <SettingsContent>
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="text-sm text-muted-foreground">{r.loadFailed}</span>
            <Button onClick={() => void load()} size="sm">
              {t.common.retry}
            </Button>
          </div>
        </SettingsContent>
      ) : status === undefined ? (
        <LoadingState label={r.loading} />
      ) : status === null ? (
        <SettingsContent>
          <EmptyState title={r.noRepo} />
        </SettingsContent>
      ) : status.files.length === 0 ? (
        <SettingsContent>
          <EmptyState title={r.noChanges} />
        </SettingsContent>
      ) : (
        <SettingsContent>
          <div className="pt-1">
            {status.files.map(file => {
              const st = fileStatus(file)
              return (
                <button
                  key={file.path}
                  className="flex w-full items-center gap-3 border-b border-border/60 py-3 text-left last:border-b-0"
                  onClick={() => setDiffFile(file.path)}
                  type="button"
                >
                  <span className={cn('w-4 shrink-0 text-center font-mono text-xs font-semibold', st.tone)}>{st.letter}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{file.path}</span>
                </button>
              )
            })}
          </div>
        </SettingsContent>
      )}

      <DiffSheet file={diffFile} onOpenChange={open => !open && setDiffFile(null)} repoRoot={repoRoot} />
    </div>
  )
}
