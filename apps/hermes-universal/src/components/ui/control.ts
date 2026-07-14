import { cva, type VariantProps } from 'class-variance-authority'

// Single source of truth for form-control chrome (Input, Textarea, SelectTrigger).
// Ported from desktop's `control.ts`: 2.5px radius + a hairline `.desktop-input-chrome`
// (translucent fill, near-invisible border, recessed inset, NO Material focus ring).
// Font-size is responsive so phones keep >=16px (avoids the Android WebView's
// focus auto-zoom) while desktop (>=sm) gets desktop's tight 12px.
export const controlVariants = cva(
  'desktop-input-chrome w-full min-w-0 rounded-[2.5px] border leading-tight text-foreground outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        xs: 'px-2 py-1 text-sm sm:px-2 sm:py-0.5 sm:text-[0.6875rem] sm:leading-4',
        sm: 'px-2.5 py-1.5 text-sm sm:px-2 sm:py-1 sm:text-xs sm:leading-4',
        default: 'px-3 py-2 text-base sm:px-2.5 sm:py-1.5 sm:text-xs sm:leading-4',
        lg: 'px-3.5 py-3 text-base sm:px-3 sm:py-2 sm:text-sm sm:leading-5'
      }
    },
    defaultVariants: {
      size: 'default'
    }
  }
)

export type ControlVariantProps = VariantProps<typeof controlVariants>
