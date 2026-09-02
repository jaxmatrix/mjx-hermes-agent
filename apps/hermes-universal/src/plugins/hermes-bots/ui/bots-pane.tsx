/**
 * The BOTS list — the second tab of the sessions strip.
 *
 * Every verb is reachable without a mouse. A row's actions live on a visible ⋯
 * kebab AND in the app-wide context menu (right-click on desktop, long-press on
 * touch), from ONE declaration — there is no hover-only affordance, because a
 * verb you can only reach by hovering does not exist on a phone.
 */

import {
  Button,
  Codicon,
  confirm,
  createTap,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ErrorState,
  host,
  isCoarsePointer,
  SearchField,
  StatusDot,
  usePluginI18n,
  useValue
} from '@hermes/plugin-sdk'
import { useCallback, useMemo, useState } from 'react'

import { botHandle } from '../ids'
import { type RosterRow, visibleRoster } from '../model/roster'
import {
  $botProtocolSupported,
  $rooms,
  $roster,
  $rosterError,
  $rosterLoading,
  $selectedBot,
  $showHidden
} from '../store/atoms'
import { openBotChat, refreshRoster, saveBotMeta } from '../store/bots'
import { disbandRoom } from '../store/rooms'

import { BotAvatar, RoomAvatar } from './avatar'
import { CreateRoomDialog } from './create-room-dialog'
import { openRoomPane } from './room-pane'

/** The verbs on a bot row. ONE declaration, three surfaces (kebab, right-click,
 *  long-press) — see `plugin.tsx`, which feeds the same list to 478's area. */
export function botRowVerbs(
  row: RosterRow,
  t: (key: string, ...args: unknown[]) => string
): { danger?: boolean; icon: string; label: string; run: () => void }[] {
  return [
    {
      icon: 'edit',
      label: t('roster.editBot'),
      run: () => host.navigate(`/profiles?name=${encodeURIComponent(row.profile)}`)
    },
    {
      icon: 'eye-closed',
      label: row.meta.hidden ? t('roster.show') : t('roster.hide'),
      run: () => void saveBotMeta(row, { ...row.meta, hidden: !row.meta.hidden })
    },
    {
      icon: 'comment-discussion',
      label: t('roster.openChat'),
      run: () => void openBotChat(row)
    },
    {
      danger: true,
      icon: 'trash',
      label: t('roster.deleteBot'),
      // Deletion stays a CORE, confirmed flow: a plugin-callable profile
      // destructor is the one door whose blast radius is a user's whole agent
      // directory (§2.3 A-2).
      run: () => host.navigate(`/profiles?name=${encodeURIComponent(row.profile)}&delete=1`)
    }
  ]
}

function BotRow({ row }: { row: RosterRow }) {
  const t = usePluginI18n('hermes-bots')
  const selected = useValue($selectedBot) === row.key
  const [warmed, setWarmed] = useState(false)

  // Pre-warm the profile so the chat opens instantly. On a coarse pointer there
  // is no hover, so the FIRST TAP does it — the gesture that is about to open
  // the chat anyway.
  const warm = () => {
    if (!warmed) {
      setWarmed(true)
      void host.warmProfile(row.profile)
    }
  }

  const open = useCallback(() => {
    $selectedBot.set(row.key)
    void openBotChat(row)
  }, [row])

  // A `click` on Android is the WebView's own gesture verdict and arrives late
  // on a row that also scrolls and long-presses; `createTap` decides from the
  // pointer stream instead.
  const tap = useMemo(() => createTap({ onTap: open }), [open])

  return (
    <div
      className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[selected=true]:bg-accent/60"
      data-bot-key={row.key}
      data-hermes-context-target="bot-row"
      data-selected={selected}
      onClick={() => {
        // `createTap` deliberately ignores a mouse pointer — its native click
        // still rules — so the mouse path lands here and the touch path is
        // swallowed to stop the gesture firing twice.
        if (!tap.fired()) {
          open()
        }
      }}
      onPointerCancel={() => tap.cancel()}
      onPointerDown={event => {
        tap.down(event.nativeEvent)

        if (isCoarsePointer()) {
          warm()
        }
      }}
      onPointerEnter={() => {
        if (!isCoarsePointer()) {
          warm()
        }
      }}
      onPointerMove={event => tap.move(event.nativeEvent)}
      onPointerUp={event => tap.up(event.nativeEvent)}
    >
      <BotAvatar row={row} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium">{row.name}</span>
          {row.connectionId && <Codicon className="opacity-60" name="remote" />}
          {row.working && <StatusDot title="working" tone="good" />}
        </span>
        {/* A remote row's `preview` is ALWAYS empty — `host.agents()` reports
            names only, never a session — so falling through to the handle here
            reads as "this bot has no conversations", which is a claim we cannot
            make about a machine we did not ask. Say what is actually true. */}
        <span className="block truncate text-xs text-muted-foreground">
          {row.connectionId
            ? t('roster.onOtherMachine', botHandle(row.profile))
            : row.preview || `@${botHandle(row.profile)}`}
        </span>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* Always rendered, never hover-gated: a verb behind `hover:` does
              not exist on a touch device. */}
          <Button aria-label={t('roster.actionsFor', row.name)} size="icon" variant="ghost">
            <Codicon name="ellipsis" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {botRowVerbs(row, t).map(verb => (
            <DropdownMenuItem key={verb.label} onSelect={verb.run}>
              <Codicon name={verb.icon} />
              {verb.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function RoomRow({ id, name }: { id: string; name: string }) {
  const t = usePluginI18n('hermes-bots')

  return (
    <div className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm">
      <RoomAvatar name={name} roomId={id} />
      <button className="min-w-0 flex-1 truncate text-start" onClick={() => openRoomPane(id)} type="button">
        {name}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label={t('roster.actionsFor', name)} size="icon" variant="ghost">
            <Codicon name="ellipsis" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => openRoomPane(id)}>{t('room.open')}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              const room = $rooms.get().find(candidate => candidate.id === id)

              if (room) {
                void disbandRoom(room)
              }
            }}
          >
            {t('room.disband')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function BotsPane() {
  const t = usePluginI18n('hermes-bots')
  const roster = useValue($roster)
  const rooms = useValue($rooms)
  const loading = useValue($rosterLoading)
  const error = useValue($rosterError)
  const showHidden = useValue($showHidden)
  const protocol = useValue($botProtocolSupported)
  const [query, setQuery] = useState('')
  const [creatingRoom, setCreatingRoom] = useState(false)

  const visible = useMemo(() => {
    const rows = visibleRoster(roster, showHidden)
    const needle = query.trim().toLowerCase()

    return needle ? rows.filter(row => row.name.toLowerCase().includes(needle) || row.handle.includes(needle)) : rows
  }, [query, roster, showHidden])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2" data-glass-raised="">
      <SearchField onChange={setQuery} placeholder={t('roster.search')} value={query} />

      {error && (
        <ErrorState description={error} title={t('roster.loadFailed')}>
          <Button onClick={() => void refreshRoster()} size="sm">
            {t('roster.retry')}
          </Button>
        </ErrorState>
      )}

      {!protocol && (
        // Rule 9: say what is actually true. Desktop wrote the protocol into the
        // user's SOUL.md when the gateway did not support it, which is
        // destructive, racy across clients, and was never traced back.
        <p className="rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
          {t('errors.noProtocol')}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rooms.length > 0 && (
          <>
            <p className="px-2 pb-1 pt-2 text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{t('roster.rooms')}</p>
            {rooms.map(room => (
              <RoomRow id={room.id} key={room.id} name={room.name} />
            ))}
          </>
        )}

        <p className="px-2 pb-1 pt-2 text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{t('roster.agents')}</p>
        {visible.map(row => (
          <BotRow key={row.key} row={row} />
        ))}

        {visible.length === 0 && !loading && <p className="px-2 py-4 text-xs text-muted-foreground">{t('roster.empty')}</p>}
      </div>

      <CreateRoomDialog onOpenChange={setCreatingRoom} open={creatingRoom} />

      <div className="flex items-center gap-1">
        <Button className="flex-1" onClick={() => setCreatingRoom(true)} size="sm" variant="outline">
          <Codicon name="comment-discussion" /> {t('roster.newRoom')}
        </Button>
        <Button
          className="flex-1"
          onClick={async () => {
            const answer = await confirm({
              confirmLabel: t('roster.createAgentConfirm'),
              description: t('roster.createAgentBody'),
              title: t('roster.createAgentTitle')
            })

            if (answer === true) {
              host.navigate('/profiles')
            }
          }}
          size="sm"
          variant="outline"
        >
          <Codicon name="add" /> {t('roster.newAgent')}
        </Button>
        <Button
          aria-label={showHidden ? t('roster.hideHidden') : t('roster.showHidden')}
          onClick={() => $showHidden.set(!showHidden)}
          size="icon"
          variant="ghost"
        >
          <Codicon name={showHidden ? 'eye' : 'eye-closed'} />
        </Button>
      </div>
    </div>
  )
}
