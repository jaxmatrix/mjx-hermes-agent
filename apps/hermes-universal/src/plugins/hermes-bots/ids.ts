/**
 * Every id, name and wire string Bot Mode mints, in one place.
 *
 * These are CONTRACTS, not conveniences: `Bot Chat` is the exact title the
 * gateway keys its teammate-protocol injection on (`agent/system_prompt.py`),
 * and `Group: <name>` is what `session.list` resolves a member session by. A
 * typo here is not a rendering bug, it is a bot that never learns it is a bot.
 *
 * The wire strings are deliberately NOT localised. They are read by a model,
 * not by a person, and translating them would change every agent's behaviour
 * with the app's language setting.
 */

/** The canonical per-bot private chat. Matched EXACTLY, server-side. */
export const BOT_CHAT_TITLE = 'Bot Chat'

const GROUP_TITLE_PREFIX = 'Group: '

/** One member's side of a room. Also matched exactly by the hide sweep. */
export const groupSessionTitle = (roomName: string): string => `${GROUP_TITLE_PREFIX}${roomName}`

/** True for a title this plugin mints — the hide sweep's second guard. */
export const isOwnedSessionTitle = (title: string): boolean =>
  title === BOT_CHAT_TITLE || title.startsWith(GROUP_TITLE_PREFIX)

/**
 * The @tag for a profile.
 *
 * `default` is the user's own agent and reads as "Hermes" everywhere; tagging
 * it `@default` would be both ugly and ambiguous with the word.
 */
export const botHandle = (profile: string): string => (profile === 'default' ? 'hermes' : profile)

/** Display name for a profile, before any `ui_meta.title` override. */
export const botDisplayName = (profile: string): string => (profile === 'default' ? 'Hermes' : profile)

/** `@radar` — what a composer inserts and a prompt carries. */
export const botMentionTag = (profile: string): string => `@${botHandle(profile)}`

/**
 * A member's key inside a room record.
 *
 * LOCAL members stay BARE (`radar`, not `radar@local`) so a room written by an
 * older client — or by desktop — keeps resolving. Only a member on another
 * connection is source-qualified.
 */
export const groupMemberKey = (profile: string, connectionId?: null | string): string =>
  connectionId && connectionId !== 'local' ? `${profile}@${connectionId}` : profile

/** The reserved thread every room starts with. */
export const MAIN_THREAD = 'main'

const HEX = '0123456789abcdef'

function randomHex(chars: number): string {
  const bytes = new Uint8Array(Math.ceil(chars / 2))

  globalThis.crypto.getRandomValues(bytes)

  let out = ''

  for (const byte of bytes) {
    out += HEX[byte >> 4] + HEX[byte & 15]
  }

  return out.slice(0, chars)
}

/** A fresh room id. Opaque, NOT the name — renaming a room is a one-field write
 *  here, where desktop had to re-key the room, its memberships and its
 *  watermarks (`group-chat-identity-edit.test.mjs`). */
export const newRoomId = (): string => `r_${randomHex(12)}`

/** A fresh thread id. */
export const newThreadId = (): string => `t_${randomHex(8)}`

/**
 * The id a v0 (desktop) room migrates to — DERIVED, so two clients migrating
 * the same room independently agree.
 *
 * A 64-bit FNV-1a over the room name and its sorted member list, not sha-256:
 * `crypto.subtle.digest` is async and this has to run inside a pure merge. The
 * property that matters is agreement between clients, not preimage resistance,
 * and a collision here merges two rooms that already share a name and a roster.
 */
export function derivedRoomId(name: string, members: readonly string[]): string {
  const seed = `${name} ${[...members].sort().join(' ')}`

  // FNV-1a over 64 bits, kept in two 32-bit halves because JS has no unsigned
  // 64-bit multiply. `Math.imul` keeps each half exact.
  let hi = 0xcbf2_9ce4
  let lo = 0x8422_2325

  for (let i = 0; i < seed.length; i++) {
    lo ^= seed.charCodeAt(i) & 0xff

    const loLow = lo & 0xffff
    const loHigh = lo >>> 16
    const low = Math.imul(loLow, 0x1b3)
    const high = Math.imul(loHigh, 0x1b3)

    const nextLo = (low + ((high & 0xffff) << 16)) >>> 0
    const carry = ((low >>> 16) + high) >>> 16

    hi = (Math.imul(hi, 0x1b3) + Math.imul(lo, 0x100) + carry) >>> 0
    lo = nextLo
  }

  const hex = (value: number) => value.toString(16).padStart(8, '0')

  return `r_${(hex(hi) + hex(lo)).slice(0, 12)}`
}
