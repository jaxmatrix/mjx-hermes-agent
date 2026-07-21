'use client'

import { type FC, useEffect, useState } from 'react'

import { ZoomableImage } from '@/components/chat/zoomable-image'
import { useI18n } from '@/i18n'
import { generatedImageFromResult } from '@/lib/generated-images'
import { mediaExternalUrl } from '@/lib/media'
import { cn } from '@/lib/utils'

// Ported (simplified) from apps/desktop/src/components/chat/generated-image-result.tsx.
//
// FLAG(chat-port): universal's gateway emitting image bytes / host paths for the
// `image_generate` tool is UNVERIFIED. This renderer paints the image when the
// tool result carries an inline (data:/http) source or a media path that
// resolves via `mediaExternalUrl`. The desktop version additionally read local
// files through `window.hermesDesktop.readFileDataUrl` and proxied remote-gateway
// media — both Electron-only, so they're dropped here. If universal only returns
// non-resolvable sandbox paths, the frame will fail to load and render nothing
// (the agent's prose carries the explanation), matching desktop's failure mode.
//
// Also simplified: the desktop diffusion-canvas placeholder + download/lightbox
// toolbar are replaced by a lightweight pulse placeholder and the shared
// click-to-zoom `ZoomableImage`.

const ASPECT_HINTS: Record<string, number> = {
  landscape: 16 / 9,
  square: 1,
  portrait: 9 / 16
}

function hintedRatio(aspectRatio?: string): number {
  return (
    ASPECT_HINTS[
      String(aspectRatio ?? '')
        .toLowerCase()
        .trim()
    ] ?? ASPECT_HINTS.landscape
  )
}

function isInlineSrc(path: string): boolean {
  return /^(?:https?|data):/i.test(path)
}

export const GeneratedImage: FC<{ aspectRatio?: string; result?: unknown }> = ({ aspectRatio, result }) => {
  const { t } = useI18n()
  const image = result === undefined ? null : generatedImageFromResult(result)
  const pending = result === undefined

  const [ratio, setRatio] = useState(() => hintedRatio(aspectRatio))
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => setRatio(hintedRatio(aspectRatio)), [aspectRatio])

  useEffect(() => {
    setLoaded(false)
    setFailed(false)
  }, [image])

  // Completed but no usable image (generation failed): the agent's prose carries
  // the explanation, so render nothing here.
  if (!pending && !image) {
    return null
  }

  const src = image ? (isInlineSrc(image) ? image : mediaExternalUrl(image)) : ''

  if (failed) {
    return null
  }

  const frameStyle = {
    aspectRatio: ratio,
    width: `min(calc(var(--image-preview-height, 20rem) * ${ratio}), var(--image-preview-max-width, 32rem), 100%)`
  }

  // Pending (no source yet): a sized pulse frame so the resolved image lands in
  // the same box with no layout shift.
  if (!src) {
    return (
      <span
        aria-label={t.assistant.tool.renderingImage}
        aria-live="polite"
        className="block max-w-full animate-pulse overflow-hidden rounded-2xl bg-muted/60"
        data-slot="aui_generated-image"
        role="status"
        style={frameStyle}
      />
    )
  }

  return (
    <span
      className={cn(
        'block max-w-full overflow-hidden rounded-2xl transition-[background] duration-500',
        !loaded && 'animate-pulse bg-muted/60'
      )}
      data-slot="aui_generated-image"
      style={frameStyle}
    >
      <ZoomableImage
        alt="Generated image"
        className={cn(
          'size-full object-contain opacity-0 transition-opacity duration-500 ease-out',
          loaded && 'opacity-100'
        )}
        onError={() => setFailed(true)}
        onLoad={event => {
          const { naturalHeight, naturalWidth } = event.currentTarget

          if (naturalWidth && naturalHeight) {
            setRatio(naturalWidth / naturalHeight)
          }

          setLoaded(true)
        }}
        src={src}
      />
    </span>
  )
}
