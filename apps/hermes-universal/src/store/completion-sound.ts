import { type Codec, persistentAtom } from '@/lib/persisted'

// Selected turn-end completion cue. Ported from apps/desktop/src/store/completion-sound.ts,
// adapted to universal's persistentAtom seam.

export const DEFAULT_COMPLETION_SOUND_VARIANT_ID = 1

// Range mirrors COMPLETION_SOUND_VARIANTS in lib/completion-sound.ts. Validating
// by range (not membership) keeps this store free of a dependency on the lib,
// which imports the atom back — a membership check would close that cycle.
const VARIANT_COUNT = 14

export function resolveCompletionSoundVariantId(variantId: number): number {
  return Number.isInteger(variantId) && variantId >= 1 && variantId <= VARIANT_COUNT
    ? variantId
    : DEFAULT_COMPLETION_SOUND_VARIANT_ID
}

const variantCodec: Codec<number> = {
  decode: raw => resolveCompletionSoundVariantId(Number.parseInt(raw, 10)),
  encode: value => String(value)
}

export const $completionSoundVariantId = persistentAtom<number>(
  'hermes.completionSoundVariantId',
  DEFAULT_COMPLETION_SOUND_VARIANT_ID,
  variantCodec
)

export function setCompletionSoundVariantId(variantId: number) {
  $completionSoundVariantId.set(resolveCompletionSoundVariantId(variantId))
}
