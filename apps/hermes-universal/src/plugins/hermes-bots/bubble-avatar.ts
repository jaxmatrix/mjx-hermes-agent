/**
 * Resolve a bot chat bubble's roster face from the same `$botMeta` + owner key
 * the Bots pane uses — so the strip paints the profile-creation avatar, not a
 * generic robot glyph.
 */

import { avatarColor, botAppearance } from './avatar'
import { isBackfilledFacePng } from './avatar-image'
import { $botMeta } from './data'
import type { AvatarAppearance, BotMeta } from './types'

import { $botChatScopes } from '@/store/session-states'

export interface BotBubbleFace extends AvatarAppearance {
  /** Profile name passed to `BotFace` (eyes / seed / primary defaults). */
  name: string
  /** Resolved fill colour (never null — matches roster `avatarColor(...)`). */
  fill: string
  /** Photo data URL when present and not a backfilled face PNG. */
  photo: null | string
}

export interface BotChatBubbleHint {
  connectionId?: string
  profile?: string
}

/** Strip `bot:` and split `connectionId::profile` from a workspace owner key. */
export function parseBotWorkspaceOwnerKey(
  ownerKey: null | string | undefined
): null | { connectionId?: string; profile: string } {
  const raw = String(ownerKey || '').trim()

  if (!raw.startsWith('bot:')) {
    return null
  }

  const rest = raw.slice(4)
  const sep = rest.indexOf('::')

  if (sep < 0) {
    const profile = rest.trim() || 'default'

    return { profile }
  }

  const connectionId = rest.slice(0, sep).trim() || undefined
  const profile = rest.slice(sep + 2).trim() || 'default'

  return connectionId ? { connectionId, profile } : { profile }
}

function metaForBot(connectionId: string | undefined, profile: string, metaByName: Record<string, BotMeta>): BotMeta | null {
  if (connectionId) {
    const routed = metaByName[`${connectionId}::${profile}`]

    if (routed) {
      return routed
    }
  }

  return metaByName[profile] || null
}

/**
 * Appearance for a bot-scoped chat bubble. Always returns a face when a profile
 * name can be inferred (deterministic shape/color when meta is missing).
 */
export function appearanceForBotChat(
  storedSessionId: null | string | undefined,
  hint?: BotChatBubbleHint | null
): BotBubbleFace | null {
  const scope = storedSessionId ? $botChatScopes.get()[storedSessionId] : undefined
  const fromOwner = parseBotWorkspaceOwnerKey(scope?.workspaceOwnerKey)
  const profile = (fromOwner?.profile || hint?.profile || '').trim() || 'default'
  const connectionId = fromOwner?.connectionId || hint?.connectionId || undefined
  const meta = metaForBot(connectionId, profile, $botMeta.get())
  const appearance = botAppearance(profile, meta)
  const photo = appearance.image && !isBackfilledFacePng(appearance.image) ? appearance.image : null

  return {
    ...appearance,
    image: photo,
    name: profile,
    fill: avatarColor(appearance.color, profile),
    photo
  }
}
