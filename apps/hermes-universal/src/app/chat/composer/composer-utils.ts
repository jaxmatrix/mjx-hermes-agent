// Composer layout constants + small helpers, ported (trimmed) from the desktop
// composer's composer-utils.ts. The draft-persist / queue-edit / slash-chip-kind
// helpers there are tied to desktop-only stores and are dropped here.

export const COMPOSER_STACK_BREAKPOINT_PX = 320

// Above the stack breakpoint but still cramped: the model pill sheds its label
// for its chevron icon (freeing ~120px) so the controls stop crowding the input
// before the whole row has to stack. Progressive collapse: full pill → icon
// pill → stacked.
export const COMPOSER_COMPACT_PILL_PX = 440

// A single editor line is ~28px (--composer-input-min-height 1.625rem + 0.5rem
// vertical padding). Anything taller means the text wrapped to a second line,
// which is when the composer should expand to the stacked layout.
export const COMPOSER_SINGLE_LINE_MAX_PX = 36

export const COMPOSER_FADE_BACKGROUND =
  'linear-gradient(to bottom, transparent, color-mix(in srgb, var(--dt-background) 10%, transparent))'

export const pickPlaceholder = (pool: readonly string[]) => pool[Math.floor(Math.random() * pool.length)]

/** A `/` query is at its arg stage once it's past the command name. */
export const slashArgStage = (query: string) => query.includes(' ')

/** The `/command` token of a slash query (`personality x` → `/personality`). */
export const slashCommandToken = (query: string) => `/${query.split(/\s+/, 1)[0]?.toLowerCase() ?? ''}`
