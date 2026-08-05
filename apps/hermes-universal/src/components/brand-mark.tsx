import nousGirl from '@/assets/brand/nous-girl.jpg'
import { cn } from '@/lib/utils'

// Brand badge: nous-girl mark on a white tile, identical in light/dark.
// Fills the tile (softly rounded); size via className (default size-14).
//
// Ported from apps/desktop/src/components/brand-mark.tsx. The desktop copy
// resolves the file out of its `public/` dir via `import.meta.env.BASE_URL`;
// universal has no public dir, so the asset is imported the way the rest of the
// app does it (see billing/tier-art.tsx) and Vite fingerprints it into the
// bundle — which also keeps it working from the `tauri://` origin on mobile.
export function BrandMark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'inline-flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white',
        className
      )}
      {...props}
    >
      <img alt="" className="size-full object-contain" src={nousGirl} />
    </span>
  )
}
