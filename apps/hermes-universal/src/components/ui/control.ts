import { cva, type VariantProps } from 'class-variance-authority'

// Adapted from apps/desktop/src/components/ui/control.ts. Single source of truth
// for form-control chrome (Input, and later Textarea/SelectTrigger). The desktop
// version defers its visual chrome to a `desktop-input-chrome` CSS class; here we
// inline it with the A2 named-token contract (border-input / bg-background /
// ring-ring). Sizing is touch-tuned and the default is >=16px text so focusing
// an input never triggers the Android WebView's auto-zoom.
export const controlVariants = cva(
  'w-full min-w-0 rounded-md border border-input bg-background text-foreground outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20',
  {
    variants: {
      size: {
        xs: 'px-2 py-1 text-sm',
        sm: 'px-2.5 py-1.5 text-sm',
        default: 'px-3 py-2.5 text-base',
        lg: 'px-3.5 py-3 text-base'
      }
    },
    defaultVariants: {
      size: 'default'
    }
  }
)

export type ControlVariantProps = VariantProps<typeof controlVariants>
