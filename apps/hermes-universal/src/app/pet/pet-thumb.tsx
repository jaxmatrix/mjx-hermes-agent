import { useEffect, useState } from 'react'

import { Paw } from '@/lib/icons'
import { loadPetThumb } from '@/store/pet-gallery'

// Lazily loads a pet's thumbnail via the pet.thumb RPC (cached). Falls back to a
// paw glyph while loading or on failure.
export function PetThumb({ slug, url }: { slug: string; url?: string }) {
  const [dataUri, setDataUri] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadPetThumb(slug, url).then(uri => !cancelled && setDataUri(uri))
    return () => void (cancelled = true)
  }, [slug, url])

  return (
    <span className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-muted">
      {dataUri ? (
        <img alt="" className="size-full [image-rendering:pixelated] object-contain" src={dataUri} />
      ) : (
        <Paw className="size-5 text-muted-foreground" />
      )}
    </span>
  )
}
