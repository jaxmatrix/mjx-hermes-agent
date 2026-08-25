/**
 * BOT MODE — every gateway profile as a named agent with a face, a durable
 * private chat, group rooms, threads and routines.
 *
 * In-tree and first-party, but written against `@hermes/plugin-sdk` ONLY (the
 * eslint fence over `src/plugins/**` enforces it). That is the point: Bot Mode
 * is the SDK's most demanding consumer, so building it through the SDK is what
 * proves the SDK — the moment it reaches for `@/store/…` every missing door
 * stops being visible.
 *
 * `register()` makes ZERO network calls. A plugin that dials on load makes every
 * cold start slower for users who never open it; the roster is fetched when the
 * BOTS pane first becomes visible, and `host.paneVisibility` is already that
 * signal.
 */

import {
  COMPOSER_AREAS,
  type ComposerAtCompletionSource,
  CONTEXT_MENU_ITEMS_AREA,
  type ContextMenuItemsContribution,
  type HermesPlugin,
  host,
  type KeybindContribution,
  KEYBINDS_AREA,
  livePollIntervalMs,
  PALETTE_AREA,
  type PaletteContribution,
  registerDeepLinkRoute,
  TRANSCRIPT_DIRECTIVE_AREA,
  type TranscriptDirectiveContribution
} from '@hermes/plugin-sdk'

import { setRoomTurnRunner } from './driver/registry'
import { createWebviewRunner } from './driver/webview-runner'
import { bundles } from './i18n'
import { botHandle, botMentionTag } from './ids'
import { isPassText, matchHandles } from './model/mentions'
import { visibleRoster } from './model/roster'
import { $rooms, $roster, $selectedBot, $showHidden, hydrateCaches, watchCaches } from './store/atoms'
import { openBotChat, refreshRoster, sweepHiddenSessions } from './store/bots'
import { pauseRooms, resumeRooms } from './store/rooms'
import { submitPrompt } from './store/rpc'
import { botRowVerbs, BotsPane } from './ui/bots-pane'
import { closeAllRoomPanes, openRoomPane } from './ui/room-pane'
import { RoutinesPane } from './ui/routines-pane'

const BOTS_PANE = 'hermes-bots:pane'

const plugin: HermesPlugin = {
  defaultEnabled: true,
  description:
    'Every agent as a bot with a face, a private chat and group rooms — plus routines, threads and cross-machine messages.',
  id: 'hermes-bots',
  name: 'Bot Mode',
  register(ctx) {
    ctx.i18n.register(bundles)
    hydrateCaches(ctx.storage)
    ctx.onDispose(watchCaches(ctx.storage))

    // Idempotent: re-registering on a hot reload replaces the slot rather than
    // stacking. The disposer RESTORES the previous runner, which matters when a
    // native build has installed the Rust one underneath us.
    ctx.onDispose(setRoomTurnRunner(createWebviewRunner(runnerDeps())))

    // ── panes ────────────────────────────────────────────────────────────────

    ctx.registerTile({
      chrome: {
        collapsible: true,
        // THE SESSIONS│BOTS strip. `enforce` because this is not a preference:
        // the BOTS tab is the second half of a compound surface, and a user who
        // ever drags it out would otherwise lose the strip for good.
        dock: { enforce: true, pane: 'sessions', pos: 'center' }
      },
      id: 'pane',
      kind: 'bots',
      placement: 'left',
      render: () => <BotsPane />,
      // Relative units, never desktop's fixed 260px: a rail measured in pixels
      // is a rail that is wrong on every other display.
      sizing: { maxWidth: '26rem', minWidth: '13rem', width: '17rem' },
      title: 'Bots'
    })

    // Registered only WHILE the BOTS tab is on screen: a second rail nobody
    // asked for is a worse default than one extra click.
    let routinesDispose: null | (() => void) = null

    ctx.onDispose(
      host.paneVisibility(BOTS_PANE).subscribe(visible => {
        if (visible && !routinesDispose) {
          routinesDispose = ctx.registerTile({
            chrome: { collapsible: true, dock: { enforce: true, pane: 'workspace', pos: 'right' } },
            id: 'routines',
            kind: 'bot-routines',
            placement: 'right',
            render: () => <RoutinesPane />,
            sizing: { maxWidth: '24rem', minWidth: '12rem', width: '16rem' },
            title: 'Routines'
          })
        } else if (!visible && routinesDispose) {
          routinesDispose()
          routinesDispose = null
        }

        if (visible) {
          // The ONE place the roster is fetched on a schedule the user can see.
          void refreshRoster()
        }
      })
    )

    ctx.onDispose(() => {
      routinesDispose?.()
      closeAllRoomPanes()
    })

    // ── @mention completions in EVERY composer ──────────────────────────────

    ctx.register({
      area: COMPOSER_AREAS.atCompletions,
      data: {
        // SYNCHRONOUS by contract — this runs on every keystroke past the
        // debounce, so it reads the roster atom and never fetches.
        provide: query =>
          matchHandles(query, visibleRoster($roster.get(), $showHidden.get())).map(row => ({
            display: botMentionTag(row.profile),
            icon: 'hubot',
            insert: `${botMentionTag(row.profile)} `,
            meta: 'agent'
          }))
      } satisfies ComposerAtCompletionSource,
      id: 'mention-completions'
    })

    // ── the room DM card ────────────────────────────────────────────────────

    ctx.register({
      area: TRANSCRIPT_DIRECTIVE_AREA,
      data: {
        name: 'bot-dm',
        // `streaming` is honoured by the area's own `isSettledDirective` guard,
        // so a half-written name never renders as a card and then changes.
        render: ({ attrs }) => (
          <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-xs">
            <span aria-hidden>🤖</span>
            <span>{attrs.from ? `@${attrs.from}` : 'agent'}</span>
            {attrs.room && <span className="text-muted-foreground">in {attrs.room}</span>}
          </span>
        )
      } satisfies TranscriptDirectiveContribution,
      id: 'dm-card'
    })

    // ── the row verbs, on right-click and long-press ────────────────────────

    ctx.register({
      area: CONTEXT_MENU_ITEMS_AREA,
      data: {
        provide: ({ close, gesture }) => {
          const key = gesture.element?.closest?.('[data-bot-key]')?.getAttribute('data-bot-key')
          const row = key ? $roster.get().find(candidate => candidate.key === key) : undefined

          if (!row) {
            return []
          }

          // The SAME declaration the kebab renders — one verb list, three
          // surfaces, so they can never disagree.
          return [
            // `ctx.i18n.t`, not `usePluginI18n`: this runs outside React, in a
            // gesture handler. Both resolve against the app's live locale.
            botRowVerbs(row, ctx.i18n.t).map(verb => ({
              icon: verb.icon,
              label: verb.label,
              onSelect: () => {
                close()
                verb.run()
              }
            }))
          ]
        },
        targets: ['dom']
      } satisfies ContextMenuItemsContribution,
      id: 'row-verbs'
    })

    // ── palette + keybind ───────────────────────────────────────────────────

    ctx.registerMany([
      {
        area: PALETTE_AREA,
        data: {
          id: 'hermes-bots.reveal',
          keywords: ['bot', 'bots', 'agent', 'roster'],
          label: 'Bots: show the roster',
          run: revealBots
        } satisfies PaletteContribution,
        id: 'reveal'
      },
      {
        area: PALETTE_AREA,
        data: {
          id: 'hermes-bots.open-room',
          keywords: ['room', 'group', 'bots'],
          label: 'Bots: open a room…',
          run: () => {
            const room = $rooms.get()[0]

            if (room) {
              openRoomPane(room.id)
            }
          }
        } satisfies PaletteContribution,
        id: 'open-room'
      },
      {
        area: KEYBINDS_AREA,
        data: {
          category: 'view',
          // NOT mod+shift+b: `workspace.newWorktree` has owned that chord since
          // MJXHRM-62, and `keybinds/chord-uniqueness.test.ts` now fails if any
          // two actions — core or contributed — ship the same default.
          defaults: ['mod+shift+j'],
          id: 'hermes-bots.toggle',
          label: 'Toggle the Bots tab',
          run: revealBots
        } satisfies KeybindContribution,
        id: 'toggle'
      }
    ])

    // ── deep links: hermes://bot/<name> ─────────────────────────────────────

    ctx.onDispose(
      registerDeepLinkRoute({
        handle: payload => {
          const [name, kind, roomId] = payload.name.split('/')

          if (kind === 'room' && roomId) {
            openRoomPane(roomId)

            return true
          }

          const row = $roster.get().find(candidate => botHandle(candidate.profile) === name || candidate.profile === name)

          if (!row) {
            return false
          }

          $selectedBot.set(row.key)
          void openBotChat(row)

          return true
        },
        kind: 'bot',
        name: 'Bot Mode'
      })
    )

    // ── the sweep, the roster backstop, and the pause contract ──────────────

    ctx.onDispose(
      host.state.gateway.subscribe(state => {
        if (state === 'open') {
          void refreshRoster().then(() => sweepHiddenSessions())
          void resumeRooms()
        } else if (state === 'closed' || state === 'error') {
          pauseRooms('disconnected')
        }
      })
    )

    let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
      if (host.paneVisibility(BOTS_PANE).get()) {
        void refreshRoster()
      }
      // There is no `profiles.changed` event, so this backstop cannot be
      // deleted — but it IS capability-gated, so a gateway that broadcasts
      // change events gets the slow interval.
    }, livePollIntervalMs(15_000, 90_000))

    ctx.onDispose(() => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    })

    // Mobile parks the WebView when the app backgrounds, and the v1 runner does
    // not survive that. The room says so and resumes on the way back — a room
    // that silently stopped is the worst of the three options.
    if (typeof document !== 'undefined') {
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') {
          if (!currentRunnerSurvives()) {
            pauseRooms('backgrounded')
          }
        } else {
          void resumeRooms()
        }
      }

      document.addEventListener('visibilitychange', onVisibility)
      ctx.onDispose(() => document.removeEventListener('visibilitychange', onVisibility))
    }
  }
}

/** Reveal + activate the BOTS tab. */
function revealBots(): void {
  window.dispatchEvent(new CustomEvent('hermes:pane-toggle-reveal', { detail: { id: BOTS_PANE } }))
}

function currentRunnerSurvives(): boolean {
  // Read through the registry rather than captured, so installing the Rust
  // runner later changes the pause contract with no edit here.
  return runnerSurvives
}

let runnerSurvives = false

/** The host effects the v1 runner needs — the only place it touches the app. */
function runnerDeps() {
  runnerSurvives = false

  return {
    now: () => Date.now(),
    observe: (plan: { member: { storedSessionId: string } }) => {
      const key = sessionKeyFor(plan.member.storedSessionId)
      const messages = host.sessionMessages(plan.member.storedSessionId)
      const prompts = host.sessionPrompts(key)

      return {
        get: () => ({
          awaitingInput: Boolean(
            prompts.get().approval || prompts.get().clarify || prompts.get().secret || prompts.get().sudo
          ),
          busy: host.state.busyBySession.get()[plan.member.storedSessionId] === true,
          messages: messages.get().length
        }),
        listen: (fn: () => void) => {
          const stops = [messages.listen(fn), host.state.busyBySession.listen(fn), prompts.listen(fn)]

          return () => stops.forEach(stop => stop())
        }
      }
    },
    settledText: (plan: { member: { storedSessionId: string } }, before: number) => {
      const messages = host.sessionMessages(plan.member.storedSessionId).get()
      const fresh = messages.slice(before).reverse().find(message => message.role === 'assistant')

      if (!fresh || fresh.pending) {
        return null
      }

      const text = fresh.parts
        .map(part => ('text' in part ? part.text : ''))
        .join('')
        .trim()

      return isPassText(text) ? '(pass)' : text
    },
    submit: async (plan: { member: { profile: string; storedSessionId: string }; prompt: string }) => {
      const bound = await host.bindSession(plan.member.storedSessionId, { profile: plan.member.profile })

      if (!bound.ok) {
        throw new Error(bound.error)
      }

      await submitPrompt(bound.sessionKey, plan.prompt, { profile: plan.member.profile })
    }
  }
}

const sessionKeyFor = (storedId: string): string =>
  host.state.sessions.get().find(session => session.storedSessionId === storedId)?.runtimeSessionId ?? ''

export default plugin
