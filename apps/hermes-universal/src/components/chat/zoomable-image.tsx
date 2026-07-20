import type { ComponentProps } from 'react'

import { Zoomable } from '@/components/ui/zoomable'
import { cn } from '@/lib/utils'

// Adapter for the desktop `ZoomableImage`. Desktop shipped a bespoke lightbox;
// universal already has a generic click-to-expand `Zoomable` (pan/zoom overlay),
// so `ZoomableImage` is a thin wrapper: an <img> that opens in the shared
// viewer. Keeps the tool renderer's `<ZoomableImage src alt className />` call
// site identical to desktop.
interface ZoomableImageProps extends ComponentProps<'img'> {
  src: string
  alt: string
  /** Classes for the wrapper around the trigger image (desktop parity). */
  containerClassName?: string
}

export function ZoomableImage({ alt, className, containerClassName, src, ...props }: ZoomableImageProps) {
  const image = <img alt={alt} className={cn('block w-full', className)} src={src} {...props} />

  return (
    <Zoomable
      className={containerClassName}
      label={alt}
      overlay={<img alt={alt} className="max-h-full max-w-full object-contain" src={src} />}
    >
      {image}
    </Zoomable>
  )
}
