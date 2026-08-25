/**
 * Cross-machine bot DMs.
 *
 * Three transports deliver the same wire text; only ONE of them is client work:
 *
 *  - a LOCAL DM is the gateway's own teammate protocol — the bot runs
 *    `hermes … chat` on its terminal tool. Zero client code.
 *  - `hermes peer dm` is gateway→gateway REST run by the agent itself. Zero
 *    client code.
 *  - a CROSS-CONNECTION @mention is this file: find the remote bot's canonical
 *    chat on ITS machine, submit into it, and wait for the reply — all over
 *    MJXHRM-446's per-connection socket, so the window's own gateway never
 *    switches and the statusbar profile never moves.
 *
 * Deliberately NOT ported: desktop's SOUL.md protocol backfill. It wrote prose
 * into a user's SOUL, raced across clients, and its reverse transition was never
 * traced even on desktop. When `profiles.list` does not report
 * `bot_mode_protocol`, the UI says agent-to-agent messages are unsupported on
 * that gateway — which is the honest answer (rule 9).
 */

import { host } from '@hermes/plugin-sdk'

import { REMOTE_DM_TIMEOUT_MS } from '../driver/types'
import { BOT_CHAT_TITLE, botDisplayName, botHandle } from '../ids'
import { resolveCanonicalChat } from '../model/canonical'
import { decodeBotMeta } from '../model/meta'
import type { RosterRow } from '../model/roster'

import { type AgentRoute, createSession, findBotChat, listProfiles, submitPrompt, writeBotMeta } from './rpc'

/** The one wire format all three transports share. Agent-facing, never i18n'd. */
export const dmWireText = (from: string, text: string): string =>
  `Message from 🤖 ${botDisplayName(from)} (@${botHandle(from)}): ${text}`

/** The transcript directive a DM renders as in an ordinary chat. Falls back to
 *  plain text when the plugin is disabled, which is the point of using the
 *  directive area rather than a new transcript message type. */
export const dmDirective = (from: string, room?: string): string =>
  `::bot-dm{from=${botHandle(from)}${room ? ` room=${room}` : ''}}`

export type DmResult =
  | { error: string; ok: false; reason: 'no-chat' | 'refused' | 'timeout' | 'unreachable' }
  | { ok: true; storedId: string }

/**
 * Deliver a message to a bot on ANOTHER connection.
 *
 * The canonical-chat ladder runs on the REMOTE machine's record, through the
 * same pure decision function the local path uses — one definition of what a
 * bot's chat is, wherever it lives.
 */
export async function sendRemoteDm(
  target: { connectionId: string; profile: string },
  from: string,
  text: string
): Promise<DmResult> {
  const route: AgentRoute = { connectionId: target.connectionId, profile: target.profile }

  let storedId: null | string = null

  try {
    const roster = await listProfiles({ route })
    const row = roster.profiles?.find(profile => profile.name === target.profile)
    const meta = decodeBotMeta(row?.ui_meta)

    let lookup: Awaited<ReturnType<typeof findBotChat>> | null = null

    try {
      lookup = await findBotChat(route)
    } catch {
      lookup = null
    }

    const found = lookup?.sessions?.[0]

    const action = resolveCanonicalChat({
      lookup: found ? { id: found.id, resolvedId: found.resolved_id, title: found.title } : null,
      pin: meta.chat ?? null
    })

    if (action.kind === 'create') {
      const created = await createSession({ title: BOT_CHAT_TITLE }, route)

      storedId = created.session_id ?? null

      if (storedId) {
        // Pin it on the REMOTE profile, so the next DM — from any machine —
        // lands in the same conversation instead of minting another.
        await writeBotMeta(target.profile, { ...meta, chat: storedId, v: 1 }, route)
      }
    } else if (action.kind !== 'retry') {
      storedId = action.storedId
    }

    if (!storedId) {
      return { error: 'no canonical chat on that machine', ok: false, reason: 'no-chat' }
    }

    await submitPrompt(storedId, dmWireText(from, text), route)

    return { ok: true, storedId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    // MJXHRM-446 answers a SHAPED refusal rather than an empty success, so an
    // unreachable machine is reported as unreachable — not as a message that
    // silently went nowhere.
    return {
      error: message,
      ok: false,
      reason: message.includes('AGENT_ROUTING_UNAVAILABLE') ? 'unreachable' : 'refused'
    }
  }
}

/**
 * Wait for a remote bot's reply.
 *
 * This is the ONE place a poll survives, and it survives for a reason worth
 * stating: a remote connection has no event stream this window subscribes to,
 * so there is nothing to wait ON. The interval is capability-gated all the same,
 * and the ceiling is the same 180 s a local member turn gets.
 */
export async function awaitRemoteReply(
  target: { connectionId: string; profile: string },
  storedId: string,
  before: number,
  signal: AbortSignal
): Promise<null | string> {
  const deadline = Date.now() + REMOTE_DM_TIMEOUT_MS

  while (Date.now() < deadline && !signal.aborted) {
    await new Promise(resolve => setTimeout(resolve, 2_000))

    if (signal.aborted) {
      return null
    }

    const bound = await host.bindSession(storedId, { profile: target.profile, withHistory: true })

    if (!bound.ok) {
      continue
    }

    const messages = bound.messages ?? []
    const reply = messages.slice(before).reverse().find(message => message.role === 'assistant')

    if (reply) {
      return reply.text
    }
  }

  return null
}

/** Rows the roster shows as reachable-but-remote. */
export const remoteRows = (roster: readonly RosterRow[]): RosterRow[] => roster.filter(row => Boolean(row.connectionId))
