// Responsive horizontal gutter for primary content bodies (settings right side,
// etc.). Ratio-based so it scales with the window, but clamped so it never
// collapses on narrow widths or runs away on ultrawide displays.
//
// NOTE: these must stay literal strings — Tailwind's scanner only picks up
// complete class names, so do not build them via template interpolation.
// Ported from apps/desktop/src/app/layout-constants.ts.
export const PAGE_INSET_X = 'px-[clamp(1.25rem,4vw,4rem)]'

// Readable cap for overlay "inner page" bodies (settings). Pair with
// `mx-auto w-full` to center within the pane. Literal string for the scanner.
export const PAGE_MAX_W = 'max-w-[75rem]'
