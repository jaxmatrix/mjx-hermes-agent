import { Codecs, persistentAtom } from '@/lib/persisted'

// Shell layout state. `panesFlipped` mirrors desktop's `@/store/layout`: it
// swaps the sessions ↔ file-browser sides of the sidebar chrome. The titlebar's
// swap button drives it now; the left/right sidebar rework (a later step) reads
// it to actually reorder the panes.
export const $panesFlipped = persistentAtom<boolean>('hermes.panesFlipped', false, Codecs.bool)

export function togglePanesFlipped(): void {
  $panesFlipped.set(!$panesFlipped.get())
}
