// Deterministic per-CONNECTION color, so a tab bound to a background connection
// is glanceable without reading a word (MJXHRM-591). Colour, never a text chip:
// a tab strip has room for a 3 px bar and a list row for a dot, and neither
// costs a translation.
//
// Mirrors `lib/profile-color.ts` — same hash, same saturation/lightness, same
// "the default is neutral" rule — so a connection hue and a profile hue read as
// one palette. The LOCAL connection is the neutral one: it is the connection a
// single-source user has, and tagging it would put a colour on every tab in an
// app that has only one backend.
//
// Nothing is persisted: the hue is a pure function of the connection id, so the
// same connection reads the same colour in every window and across restarts.
// (A user-pickable colour would be a registry field; the owner chose the
// deterministic hue, Design v1.1 §1.)

import { LOCAL_CONNECTION_ID } from '@/lib/backend-scope'

const CONNECTION_TAG_SATURATION = 68
const CONNECTION_TAG_LIGHTNESS = 58

function hashString(value: string): number {
  let hash = 0

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }

  return hash
}

/** An `hsl()` string for a connection, or null for the local/unknown one
 *  (rendered neutral / untagged). */
export function connectionColor(connectionId: null | string | undefined): null | string {
  const key = (connectionId ?? '').trim()

  if (!key || key === LOCAL_CONNECTION_ID) {
    return null
  }

  const hue = hashString(key) % 360

  return `hsl(${hue} ${CONNECTION_TAG_SATURATION}% ${CONNECTION_TAG_LIGHTNESS}%)`
}

/** Translucent fill derived from a connection colour, for a bar or a dot's halo. */
export function connectionColorSoft(color: string, percent = 16): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`
}
