import type { ActionItemSpec } from '@/components/ui/actions-menu'
import type { Translations } from '@/i18n/types'

// The pluggable target registry.
//
// The coordinator owns the GESTURE; it owns none of the answers. Every kind of
// thing a gesture can land on — the DOM, the terminal, MJXHRM-447's guest
// webview, a plugin's canvas — registers a classifier and an item provider here
// and the coordinator never learns that it exists.
//
// Shape copied from the app's other single-slot registries (`registerPreviewReader`
// et al., 00-arch §3.10): one provider per kind, re-registering replaces, and
// unregister nulls the slot only if it is still this provider.

/** Everything a classifier and an item provider may read about the gesture. */
export interface ContextGesture {
  /** Viewport coordinates of the gesture. */
  x: number
  y: number
  /** How it was opened — a provider may want a different item set on a phone. */
  source: 'keyboard' | 'longpress' | 'mouse'
  /** The deepest `Element` under the point, or null (canvas / synthetic). */
  element: Element | null
}

/** What the open menu holds for one target kind. `data` is the classifier's own shape. */
export interface ContextTargetMatch<T = unknown> {
  kind: string
  data: T
}

/** Facts only the platform can see, delivered AFTER the menu is open (v2). */
export interface NativeContextFacts {
  /** The gesture this answer belongs to — a stale answer can never flag a newer menu. */
  gestureId: number
  spelling: null | { misspelledWord: string; suggestions: string[] }
  /** True when the engine can hand us image bytes the DOM cannot. */
  imageBytes: boolean
}

export interface ContextMenuItemContext<T = unknown> {
  data: T
  gesture: ContextGesture
  /** Late fact 1 — false until the clipboard probe lands. */
  clipboardHasText: boolean
  /** Late fact 2 — null until (and unless) the native bridge answers. */
  native: NativeContextFacts | null
  /** Close the menu. An action that touches focus MUST go through `withEditableFocus`. */
  close: () => void
  /** Localised strings. */
  t: Translations
}

/** Reuses `ActionItemSpec` so a right-click row and a kebab row cannot drift. */
export interface ContextMenuItemSpec extends ActionItemSpec {
  /** Rendered faded on the right — DISPLAY ONLY; the engine already runs the chord. */
  shortcut?: string
}

/** One section = one visual group. A separator is drawn before every section
 *  after the first, and the array index IS the key — positional by construction. */
export type ContextMenuSection = ContextMenuItemSpec[]

export interface ContextTargetProvider<T = unknown> {
  /** Unique kind. Re-registering the same kind REPLACES it. */
  kind: string
  /**
   * Ascending; the first non-null `classify` wins. Built-ins reserve `order < 100`
   * (`terminal` 10, MJXHRM-447's `webview` 20) and `dom` sits last at 100 because
   * it is TOTAL — it matches every gesture, so anything registered after it is
   * unreachable and anything registered before it can swallow the app menu.
   */
  order: number
  /** Cheap, synchronous, no I/O — it runs inside the gesture. Return null to pass. */
  classify: (gesture: ContextGesture) => null | T
  /** Called at MENU BUILD time, never at register time (rule 28 — `when()` is not reactive). */
  items: (context: ContextMenuItemContext<T>) => ContextMenuSection[]
}

const providers = new Map<string, ContextTargetProvider<never>>()

/** Register (or replace) the provider for one target kind. Idempotent unregister. */
export function registerContextTarget<T>(provider: ContextTargetProvider<T>): () => void {
  const entry = provider as unknown as ContextTargetProvider<never>

  providers.set(provider.kind, entry)

  return () => {
    if (providers.get(provider.kind) === entry) {
      providers.delete(provider.kind)
    }
  }
}

/**
 * First match by ascending `order`, or null.
 *
 * Never throws: a classifier that does is skipped, its kind is reported through
 * `onError`, and the next provider is tried. `dom` is total, so a menu always
 * has something to open with even when a plugin's classifier is broken.
 */
export function classifyGesture(
  gesture: ContextGesture,
  onError?: (kind: string) => void
): ContextTargetMatch | null {
  const ordered = [...providers.values()].sort((a, b) => a.order - b.order)

  for (const provider of ordered) {
    let data: unknown

    try {
      data = provider.classify(gesture)
    } catch {
      onError?.(provider.kind)

      continue
    }

    if (data !== null && data !== undefined) {
      return { data, kind: provider.kind }
    }
  }

  return null
}

/** The provider for a kind, so the coordinator can build its sections. */
export function contextTargetProvider(kind: string): ContextTargetProvider<never> | undefined {
  return providers.get(kind)
}

/** Test seam. */
export function __resetContextTargets(): void {
  providers.clear()
}
