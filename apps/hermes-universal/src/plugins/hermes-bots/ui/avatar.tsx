/**
 * A bot's face — ONE memoised SVG string, and nothing else.
 *
 * Desktop generated its faces procedurally, animated them at 15 fps with a
 * `requestAnimationFrame` loop, and re-scanned the whole document (through
 * shadow roots) once a second to find the faces it should be animating. That is
 * ~600 lines of trigonometry plus a permanent CPU floor on a screen the user is
 * usually not even looking at. None of it is ported.
 *
 * `blobatar` produces the same family of faces deterministically from the name,
 * so the memo key is `(name, shape, color)` and the cache is a plain Map. If
 * animation is ever wanted it is ONE `createBudgetedLoop` over the rows an
 * `IntersectionObserver` reports — never a document walk. Named as an upgrade,
 * not built.
 */

import { blobatarSvg, hexToOklch, useValue } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'

import type { RosterRow } from '../model/roster'
import { $roomImages } from '../store/atoms'
import { getAvatar } from '../store/rpc'

/**
 * The silhouettes blobatar can produce, in its own order.
 *
 * `BotMeta.shape` stores a NAME rather than the 0–1 trait position blobatar
 * takes, because a name survives a version bump that reorders the band table
 * while a raw position would silently become a different face.
 */
export const BOT_SHAPES = [
  'round',
  'boxy',
  'organic',
  'cloud',
  'sun',
  'nub',
  'capsule',
  'triangle',
  'hexagon',
  'droplet'
] as const

/** Name → the middle of that silhouette's band, so it lands squarely on it. */
function shapeTrait(shape: string): number | undefined {
  const index = BOT_SHAPES.indexOf(shape as (typeof BOT_SHAPES)[number])

  return index < 0 ? undefined : (index + 0.5) / BOT_SHAPES.length
}

/** ~1 KB per entry. 64 bots is far past any real roster. */
const MEMO_LIMIT = 64
const svgCache = new Map<string, string>()

export function blobFor(name: string, shape?: string, color?: string): string {
  const key = `${name}|${shape ?? ''}|${color ?? ''}`
  const cached = svgCache.get(key)

  if (cached) {
    return cached
  }

  const trait = shape ? shapeTrait(shape) : undefined
  // `color` is a hex in the record because that is what a picker produces;
  // blobatar locks colour by HUE, so the conversion happens here rather than
  // storing a number nobody can read back.
  const hue = color ? hexToOklch(color)?.h : undefined

  const svg = blobatarSvg(name, {
    ...(hue === undefined ? {} : { hue }),
    ...(trait === undefined ? {} : { traits: { shape: trait } })
  })

  if (svgCache.size >= MEMO_LIMIT) {
    svgCache.delete(svgCache.keys().next().value!)
  }

  svgCache.set(key, svg)

  return svg
}

/** Server-side avatars, cached per name for this session. Bounded by the
 *  roster, which is bounded by how many agents a user has. */
const assetCache = new Map<string, null | string>()

export function BotAvatar({ row, size = 28 }: { row: RosterRow; size?: number }) {
  const [asset, setAsset] = useState<null | string>(() => assetCache.get(row.key) ?? null)

  useEffect(() => {
    // Only when the roster says there IS one — the flag exists so a roster can
    // probe cheaply without a call per row.
    if (!row.hasAvatar || assetCache.has(row.key)) {
      return
    }

    let live = true

    void getAvatar(row.profile, row.connectionId ? { connectionId: row.connectionId, profile: row.profile } : undefined)
      .then(result => {
        const src = result.found && result.data ? result.data : null

        assetCache.set(row.key, src)

        if (live) {
          setAsset(src)
        }
      })
      // A face is a face: an asset that will not load falls through to the
      // generated one rather than leaving a hole.
      .catch(() => assetCache.set(row.key, null))

    return () => {
      live = false
    }
  }, [row.hasAvatar, row.key, row.profile, row.connectionId])

  if (asset) {
    return (
      <img
        alt=""
        className="shrink-0 rounded-full object-cover"
        data-glass-opaque=""
        height={size}
        src={asset}
        width={size}
      />
    )
  }

  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full"
      dangerouslySetInnerHTML={{ __html: blobFor(row.profile, row.meta.shape, row.meta.color) }}
      style={{ height: size, width: size }}
    />
  )
}

/** A room's face: its device-local picture, or the initials of its name.
 *
 *  There is no server carrier for a room picture — `profiles.set_asset` takes
 *  only `avatar`, and only for a profile — so another machine renders the
 *  initials tile. The picker row says so rather than letting the user believe
 *  they set it everywhere. */
export function RoomAvatar({ name, roomId, size = 28 }: { name: string; roomId: string; size?: number }) {
  const images = useValue($roomImages)
  const image = images[roomId]

  if (image) {
    return (
      <img alt="" className="shrink-0 rounded-md object-cover" data-glass-opaque="" height={size} src={image} width={size} />
    )
  }

  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map(word => word[0]?.toUpperCase() ?? '')
    .join('')

  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-md bg-muted text-[0.625rem] font-medium text-muted-foreground"
      style={{ height: size, width: size }}
    >
      {initials || '#'}
    </span>
  )
}
