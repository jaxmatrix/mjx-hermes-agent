/**
 * The `drive_preview` / `annotate_preview` answer shapes.
 *
 * These names are the AGENT-facing contract, matched to what the Electron
 * desktop app produces so the gateway-side tool reads one shape from either
 * client. `snake_case` does not appear here because the drive bridge never used
 * it — `preview.read` does, and that lives in `lib/browser/reader.ts`.
 */

export interface ElementEntry {
  ref: string
  role: string
  label: string
  value?: string
  disabled?: boolean
}

/**
 * Every look after the first is a DELTA, not a re-sent inventory: the refs are
 * stable across a re-render that destroys and rebuilds the element (they are
 * matched by role + accessible name + position among siblings), so re-sending
 * two hundred unchanged rows would be the bulk of the answer and none of the
 * information.
 */
export interface ElementDelta {
  added: ElementEntry[]
  changed: Array<{ ref: string } & Partial<Pick<ElementEntry, 'disabled' | 'label' | 'value'>>>
  removed: string[]
  rebound: string[]
  same: number
}

export interface ActResult {
  success: boolean
  action: string
  url: string
  title: string
  ref?: string
  error?: string
  /** First look at a page, or `full: true`. */
  elements?: ElementEntry[]
  /** Every look after that. */
  delta?: ElementDelta
  /** Refs retired by a navigation. */
  stale?: true
}

/** The wire verbs `annotate_preview` sends (`pin` / `hold` / `unpin`). */
export type AnnotateVerb = 'hold' | 'pin' | 'unpin'

export const ACT_HOST_VERBS = ['back', 'forward', 'reload'] as const
export const ACT_ANNOTATE_VERBS: readonly AnnotateVerb[] = ['pin', 'hold', 'unpin']
