import { useEffect, useState } from 'react'

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { getFileDiff } from '@/hermes'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

// Per-line color for a unified diff.
function lineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'text-[var(--ui-good)]'
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'text-destructive'
  }
  if (line.startsWith('@@')) {
    return 'text-primary'
  }
  return 'text-muted-foreground'
}

export function DiffSheet({
  file,
  onOpenChange,
  repoRoot
}: {
  file: string | null
  onOpenChange: (open: boolean) => void
  repoRoot: string
}) {
  const { t } = useI18n()
  const [diff, setDiff] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!file) {
      return
    }
    setDiff(null)
    setFailed(false)
    let cancelled = false
    void getFileDiff(repoRoot, file)
      .then(res => !cancelled && setDiff(res.diff))
      .catch(() => !cancelled && setFailed(true))
    return () => void (cancelled = true)
  }, [file, repoRoot])

  return (
    <Sheet onOpenChange={onOpenChange} open={file !== null}>
      <SheetContent className="max-h-[min(46rem,92vh)] gap-2 overflow-y-auto rounded-t-xl p-4" side="bottom">
        <SheetHeader className="p-0">
          <SheetTitle className="truncate font-mono text-sm">{file}</SheetTitle>
        </SheetHeader>

        {failed ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t.review.loadFailed}</p>
        ) : diff === null ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t.review.loading}</p>
        ) : diff.trim() === '' ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t.review.noChanges}</p>
        ) : (
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-[0.7rem] leading-relaxed">
            {diff.split('\n').map((line, i) => (
              <div className={cn('whitespace-pre', lineClass(line))} key={i}>
                {line || ' '}
              </div>
            ))}
          </pre>
        )}
      </SheetContent>
    </Sheet>
  )
}
