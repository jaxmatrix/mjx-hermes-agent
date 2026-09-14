import { type Codec, persistentAtom } from '@/lib/persisted'

/**
 * How much of a session each sidebar row shows.
 *
 * Ported from desktop `store/session-list-density.ts`. Orthogonal to
 * `$sidebarRowMeta`, which picks WHICH chips ride on the title line — this picks
 * how many LINES the row gets:
 *
 *  - `compact`     the one-line row exactly as it shipped.
 *  - `comfortable` adds one deterministic metadata line (branch · model · counts).
 *  - `detailed`    adds the session's opening request beneath that.
 */
export type SessionListDensity = 'comfortable' | 'compact' | 'detailed'

const STORAGE_KEY = 'hermes.sessionListDensity'

// Compact is the pre-density row exactly as it shipped, so existing users see no
// change until they opt into a denser-information mode themselves.
const densityCodec: Codec<SessionListDensity> = {
  decode: raw => (raw === 'comfortable' || raw === 'detailed' ? raw : 'compact'),
  encode: value => value
}

export const $sessionListDensity = persistentAtom<SessionListDensity>(STORAGE_KEY, 'compact', densityCodec)

export function setSessionListDensity(density: SessionListDensity) {
  $sessionListDensity.set(density)
}
