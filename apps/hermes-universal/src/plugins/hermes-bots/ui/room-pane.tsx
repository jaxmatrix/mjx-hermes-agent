/**
 * A ROOM, as a workspace pane.
 *
 * A pane and not an overlay: rooms are long-lived and belong BESIDE a chat —
 * draggable, tileable, detachable, closeable. An overlay cannot sit next to the
 * conversation it is about.
 *
 * The member strip is the design's biggest deletion versus desktop. Expanding a
 * member mounts `SessionThread` — the app's OWN transcript for that member's
 * session — so tool calls, media, artifacts, approvals and clarify all appear in
 * the room with NO mirroring layer. Desktop hand-copied approvals into its room
 * and drifted from the real UI on every transcript feature that shipped after.
 */

import {
  Button,
  Codicon,
  host,
  SessionThread,
  StatusDot,
  Textarea,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useState } from 'react'

import { MAIN_THREAD } from '../ids'
import type { Room } from '../model/rooms'
import { $roomLogs, $roomRuntime, $rooms, $roster, roomRuntime } from '../store/atoms'
import { rebuildRoomLog, roomIsDriving, sendToRoom } from '../store/rooms'

import { BotAvatar, RoomAvatar } from './avatar'

const roomPaneId = (roomId: string): string => `room:${roomId}`

/** Open (or reveal) a room's pane. Registered dynamically, so N rooms are N
 *  tabs rather than one pane that switches. */
const openPanes = new Map<string, () => void>()

export function openRoomPane(roomId: string): void {
  if (openPanes.has(roomId)) {
    return
  }

  const room = $rooms.get().find(candidate => candidate.id === roomId)

  if (!room) {
    return
  }

  const dispose = host.openWorkspace(roomPaneId(roomId), {
    onClose: () => {
      openPanes.delete(roomId)

      // Release the members' transports: the conversations keep running on the
      // gateway, this window just stops following them.
      for (const storedId of Object.values(room.sessions)) {
        if (storedId) {
          host.releaseSession(storedId)
        }
      }
    },
    render: () => <RoomPane roomId={roomId} />,
    title: room.name
  })

  openPanes.set(roomId, dispose)
}

export function closeAllRoomPanes(): void {
  for (const dispose of openPanes.values()) {
    dispose()
  }

  openPanes.clear()
}

function MemberCard({ room, memberKey }: { memberKey: string; room: Room }) {
  const roster = useValue($roster)
  const row = roster.find(candidate => candidate.key === memberKey)
  const storedId = room.sessions[memberKey]
  const [expanded, setExpanded] = useState(false)
  const runtime = useValue($roomRuntime)[room.id]

  // A read-only projection: answering goes through the mounted SessionThread,
  // so MJXHRM-458's requestId correlation has exactly one path.
  const sessionKey = host.state.sessions.get().find(session => session.storedSessionId === storedId)?.runtimeSessionId
  const prompts = useValue(host.sessionPrompts(sessionKey ?? ''))
  const needsYou = Boolean(prompts.approval || prompts.clarify || prompts.mcpSetup || prompts.secret || prompts.sudo)
  const working = useValue(host.state.liveSessions)[storedId ?? ''] === 'working'

  if (!row || !storedId) {
    return null
  }

  return (
    <div className="rounded-md border border-border/60" data-glass-raised="">
      <button
        className="flex w-full items-center gap-2 px-2 py-1.5 text-start text-sm"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <BotAvatar row={row} size={22} />
        <span className="min-w-0 flex-1 truncate">{row.name}</span>
        {row.connectionId && <Codicon className="opacity-60" name="remote" title="on another machine" />}
        {needsYou && <StatusDot title="needs you" tone="warn" />}
        {working && <StatusDot title="working" tone="good" />}
        {runtime?.turn === row.profile && <span className="text-xs text-muted-foreground">thinking…</span>}
        <Codicon name={expanded ? 'chevron-up' : 'chevron-down'} />
      </button>

      {expanded && (
        <div className="max-h-[24rem] min-h-0 overflow-y-auto border-t border-border/60">
          {/* THE app's transcript — approvals, clarify, tools, media, all of it,
              with no mirroring layer of our own. */}
          <SessionThread storedSessionId={storedId} />
        </div>
      )}
    </div>
  )
}

export function RoomPane({ roomId }: { roomId: string }) {
  const rooms = useValue($rooms)
  const logs = useValue($roomLogs)
  const runtimes = useValue($roomRuntime)
  const [draft, setDraft] = useState('')
  const room = rooms.find(candidate => candidate.id === roomId)
  const runtime = runtimes[roomId] ?? roomRuntime(roomId)
  const thread = runtime.thread || MAIN_THREAD

  const roomKey = room?.id

  useEffect(() => {
    // Keyed on the ID, not the record: the record is a fresh object on every
    // roster merge, and rebuilding the log on each of those would put six
    // transcript reads on the roster's backstop interval.
    const current = $rooms.get().find(candidate => candidate.id === roomKey)

    if (current) {
      void rebuildRoomLog(current)
    }
  }, [roomKey])

  const lines = useMemo(
    () => (logs[roomId]?.lines ?? []).filter(line => line.thread === thread),
    [logs, roomId, thread]
  )

  if (!room) {
    return <p className="p-4 text-sm text-muted-foreground">This room was disbanded.</p>
  }

  const send = () => {
    const text = draft.trim()

    if (!text) {
      return
    }

    setDraft('')
    void sendToRoom(room, text, thread)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2" data-glass-raised="">
        <RoomAvatar name={room.name} roomId={room.id} size={22} />
        <span className="min-w-0 flex-1 truncate font-medium">{room.name}</span>
        {runtime.running && <span className="text-xs text-muted-foreground">running…</span>}
      </header>

      {runtime.paused && (
        // Rule 9: the drive stopped and the user is told why, with what to do.
        <p className="border-b border-border/60 bg-muted/50 px-3 py-1.5 text-xs">
          {runtime.paused === 'backgrounded'
            ? 'Paused — reopen Hermes to continue. The agent that was thinking is still working.'
            : 'Paused — the gateway is offline. It will pick up where it left off.'}
        </p>
      )}

      {runtime.error && <p className="border-b border-border/60 px-3 py-1.5 text-xs text-destructive">{runtime.error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {lines.map(line => (
          <p className="py-1 text-sm" key={`${line.at}-${line.seq}-${line.from.kind}`}>
            <span className="pe-1.5 font-medium">{line.from.kind === 'user' ? 'You' : line.from.profile}</span>
            <span className="whitespace-pre-wrap">{line.text}</span>
          </p>
        ))}
        {lines.length === 0 && <p className="py-4 text-xs text-muted-foreground">Nothing said yet.</p>}
      </div>

      <div className="flex flex-col gap-1 border-t border-border/60 px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {Object.keys(room.sessions).map(memberKey => (
            <MemberCard key={memberKey} memberKey={memberKey} room={room} />
          ))}
        </div>

        <div className="flex items-end gap-1">
          <Textarea
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            }}
            placeholder="Message the room — @mention to address one agent"
            rows={2}
            value={draft}
          />
          <Button disabled={roomIsDriving(room.id)} onClick={send} size="sm">
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}
