import { type Codec, Codecs, persistentAtom } from '@/lib/persisted'

// Inline-embed consent (mirrors desktop `store/embed-consent.ts`). `$embedMode`
// gates whether external/generated embeds auto-load; `$embedAllowed` is the
// per-service allowlist built when the user says "always" for one. Client-side
// only. NOTE: universal has no media/generated-image embed rendering yet (G7) —
// this preference ships + persists and is honored wherever embeds render.
export type EmbedMode = 'ask' | 'always' | 'off'

const modeCodec: Codec<EmbedMode> = {
  decode: raw => (raw === 'always' || raw === 'off' ? raw : 'ask'),
  encode: value => value
}

export const $embedMode = persistentAtom<EmbedMode>('hermes.embedMode', 'ask', modeCodec)
export const $embedAllowed = persistentAtom<string[]>('hermes.embedAllowed', [], Codecs.stringArray)

export const setEmbedMode = (mode: EmbedMode) => $embedMode.set(mode)
export const clearEmbedAllowed = () => $embedAllowed.set([])

/** Grant a provider a standing "always allow" (persisted allowlist). */
export function allowProvider(provider: string) {
  const current = $embedAllowed.get()

  if (!current.includes(provider)) {
    $embedAllowed.set([...current, provider])
  }
}
