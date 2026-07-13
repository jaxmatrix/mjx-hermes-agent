import { useEffect, useState } from 'react'

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { readFileText } from '@/hermes'
import { useI18n } from '@/i18n'
import { mediaExternalUrl } from '@/lib/media'
import type { FsEntry, ReadFileTextResult } from '@/types/hermes'

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i

export function FilePreviewSheet({ entry, onOpenChange }: { entry: FsEntry | null; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n()
  const f = t.files
  const isImage = Boolean(entry && IMAGE_RE.test(entry.name))
  const [data, setData] = useState<ReadFileTextResult | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!entry || isImage) {
      return
    }
    setData(null)
    setFailed(false)
    let cancelled = false
    void readFileText(entry.path)
      .then(res => !cancelled && setData(res))
      .catch(() => !cancelled && setFailed(true))
    return () => void (cancelled = true)
  }, [entry, isImage])

  return (
    <Sheet onOpenChange={onOpenChange} open={entry !== null}>
      <SheetContent className="max-h-[min(44rem,92vh)] gap-3 overflow-y-auto rounded-t-xl p-4" side="bottom">
        <SheetHeader className="p-0">
          <SheetTitle className="truncate font-mono text-sm">{entry?.name}</SheetTitle>
        </SheetHeader>

        {isImage && entry ? (
          <img alt={entry.name} className="mx-auto max-h-[70vh] max-w-full rounded-lg" src={mediaExternalUrl(entry.path)} />
        ) : failed ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{f.previewFailed}</p>
        ) : data === null ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{f.loading}</p>
        ) : data.binary ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{f.binaryFile}</p>
        ) : (
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {data.text}
          </pre>
        )}
      </SheetContent>
    </Sheet>
  )
}
