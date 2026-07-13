import { useEffect, useState } from 'react'

import { EmptyState, LoadingState, SettingsContent } from '@/app/settings/primitives'
import { SidebarTrigger } from '@/app/shell/sidebar'
import { Button } from '@/components/ui/button'
import { getDefaultCwd, readDir } from '@/hermes'
import { useI18n } from '@/i18n'
import { ChevronLeft, File, Folder } from '@/lib/icons'
import type { FsEntry } from '@/types/hermes'

import { FilePreviewSheet } from './file-preview-sheet'

const parentOf = (path: string) => {
  const parts = path.replace(/\/+$/, '').split('/')
  parts.pop()
  return parts.join('/') || '/'
}

export function FilesScreen() {
  const { t } = useI18n()
  const f = t.files
  const [cwd, setCwd] = useState<string>('')
  const [entries, setEntries] = useState<FsEntry[] | null>(null)
  const [error, setError] = useState(false)
  const [preview, setPreview] = useState<FsEntry | null>(null)

  const open = async (path: string) => {
    setEntries(null)
    setError(false)
    try {
      const res = await readDir(path)
      // Directories first, then files, each alphabetical.
      const sorted = [...res.entries].sort((a, b) =>
        a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1
      )
      setEntries(sorted)
      setCwd(path)
    } catch {
      setError(true)
    }
  }

  useEffect(() => {
    void (async () => {
      const start = await getDefaultCwd().catch(() => ({ cwd: '/' }))
      void open(start.cwd || '/')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, [])

  const atRoot = cwd === '/' || cwd === ''

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border p-3">
        <SidebarTrigger className="md:hidden" />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{f.title}</h1>
      </header>

      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button aria-label={f.parent} disabled={atRoot} onClick={() => void open(parentOf(cwd))} size="icon-sm" variant="ghost">
          <ChevronLeft className="size-5" />
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{cwd || '/'}</span>
      </div>

      {entries === null && !error ? (
        <LoadingState label={f.loading} />
      ) : error ? (
        <SettingsContent>
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="text-sm text-muted-foreground">{f.loadFailed}</span>
            <Button onClick={() => void open(cwd || '/')} size="sm">
              {t.common.retry}
            </Button>
          </div>
        </SettingsContent>
      ) : entries && entries.length === 0 ? (
        <SettingsContent>
          <EmptyState title={f.empty} />
        </SettingsContent>
      ) : (
        <SettingsContent>
          <div className="pt-1">
            {(entries ?? []).map(entry => {
              const Icon = entry.isDirectory ? Folder : File
              return (
                <button
                  key={entry.path}
                  className="flex w-full items-center gap-3 border-b border-border/60 py-3 text-left last:border-b-0"
                  onClick={() => (entry.isDirectory ? void open(entry.path) : setPreview(entry))}
                  type="button"
                >
                  <Icon className={`size-5 shrink-0 ${entry.isDirectory ? 'text-primary' : 'text-muted-foreground'}`} />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{entry.name}</span>
                </button>
              )
            })}
          </div>
        </SettingsContent>
      )}

      <FilePreviewSheet entry={preview} onOpenChange={open2 => !open2 && setPreview(null)} />
    </div>
  )
}
