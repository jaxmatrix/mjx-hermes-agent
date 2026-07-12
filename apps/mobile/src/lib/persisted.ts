import { atom, type WritableAtom } from '@/store/atom'

import { readKey, writeKey } from './persist'

// A nanostore that auto-persists. Ported near-verbatim from the desktop app
// (apps/desktop/src/lib/persisted.ts). Reads its seed from localStorage through
// the ./persist choke point and writes back on every change — no per-atom
// subscribe boilerplate.
//
//   export const $foo = persistentAtom('hermes.mobile.foo', false, Codecs.bool)
//
// FIXME(D2): plain localStorage — use secure storage (Android Keystore) for any
// sensitive keys. This helper is for non-secret UI prefs only.

// Maps a value to/from its stored string form. `decode` only ever sees a real
// stored string (absence falls back); `encode` returning null removes the key.
export interface Codec<T> {
  decode(raw: string): T
  encode(value: T): null | string
}

export const Codecs = {
  bool: { decode: raw => raw === 'true', encode: (value: boolean) => String(value) } as Codec<boolean>,
  nullableText: { decode: raw => raw, encode: value => value } as Codec<null | string>,
  text: { decode: raw => raw, encode: (value: string) => value } as Codec<string>,
  // Drops non-strings and empties; empty array → key removed.
  stringArray: {
    decode: raw => {
      const parsed = JSON.parse(raw) as unknown

      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : []
    },
    encode: value => (value.length === 0 ? null : JSON.stringify(value))
  } as Codec<string[]>,
  // Keeps only string values.
  stringRecord: {
    decode: raw => {
      const parsed = JSON.parse(raw) as unknown

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {}
      }

      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
    },
    encode: value => JSON.stringify(value)
  } as Codec<Record<string, string>>,
  /** JSON with an optional sanitizer for untrusted persisted shapes. */
  json<T>(sanitize?: (value: unknown) => T): Codec<T> {
    return {
      decode: raw => {
        const parsed = JSON.parse(raw) as unknown

        return sanitize ? sanitize(parsed) : (parsed as T)
      },
      encode: value => JSON.stringify(value)
    }
  }
}

export function persistentAtom<T>(key: string, fallback: T, codec: Codec<T> = Codecs.json<T>()): WritableAtom<T> {
  const raw = readKey(key)
  let initial = fallback

  if (raw !== null) {
    try {
      initial = codec.decode(raw)
    } catch {
      initial = fallback
    }
  }

  const $value = atom<T>(initial)

  $value.subscribe(value => writeKey(key, codec.encode(value)))

  return $value
}
