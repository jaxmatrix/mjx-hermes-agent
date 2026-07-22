import { useEffect, useRef, useState } from 'react'

import { Paw } from '@/lib/icons'
import { loadPetThumb } from '@/store/pet-gallery'

// Idle-frame preview for one pet, via the (cached, queued) pet.thumb RPC. Falls
// back to a paw glyph while loading or on failure.
//
// The fetch is gated on the card entering the viewport — the petdex catalog runs to
// thousands of entries, so loading on mount meant one RPC per row the instant the
// picker opened, which saturated the gateway's handler pool and froze the app
// (MJX-14). Mirrors desktop `components/pet/pet-thumb.tsx`.
export function PetThumb({ slug, url }: { slug: string; url?: string }) {
  const [dataUri, setDataUri] = useState<string | null>(null)
  const boxRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const el = boxRef.current

    if (!el || dataUri) {
      return
    }

    let cancelled = false

    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          observer.disconnect()
          void loadPetThumb(slug, url).then(uri => !cancelled && uri && setDataUri(uri))
        }
      },
      { rootMargin: '120px' }
    )

    observer.observe(el)

    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [slug, url, dataUri])

  return (
    <span
      className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-muted"
      ref={boxRef}
    >
      {dataUri ? (
        <img
          alt=""
          className="size-full [image-rendering:pixelated] object-contain"
          decoding="async"
          loading="lazy"
          src={dataUri}
        />
      ) : (
        <Paw className="size-5 text-muted-foreground" />
      )}
    </span>
  )
}
