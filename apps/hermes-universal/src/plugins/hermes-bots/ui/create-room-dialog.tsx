/**
 * New room: a name and a roster of members.
 *
 * The size limits are shown BEFORE the user commits, not discovered when a
 * member silently stops answering. Two of them, and they are different: six
 * members per room, and at most five of those on OTHER machines — each remote
 * member needs its own secondary socket and MJXHRM-446's pool holds five.
 */

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  useValue
} from '@hermes/plugin-sdk'
import { useState } from 'react'

import { botHandle } from '../ids'
import { GROUP_CHAT_MAX_MEMBERS, MAX_REMOTE_MEMBERS, roomSizeRefusal } from '../model/rooms'
import { visibleRoster } from '../model/roster'
import { $roster, $showHidden } from '../store/atoms'
import { createRoom } from '../store/rooms'

import { BotAvatar } from './avatar'
import { openRoomPane } from './room-pane'

export function CreateRoomDialog({ onOpenChange, open }: { onOpenChange: (open: boolean) => void; open: boolean }) {
  const roster = useValue($roster)
  const showHidden = useValue($showHidden)
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const rows = visibleRoster(roster, showHidden)
  const members = rows.filter(row => picked.includes(row.key))

  const refusal = roomSizeRefusal(
    members.map(row => ({
      ...(row.connectionId ? { connectionId: row.connectionId } : {}),
      handle: botHandle(row.profile),
      profile: row.profile
    }))
  )

  const toggle = (key: string) =>
    setPicked(picked.includes(key) ? picked.filter(other => other !== key) : [...picked, key])

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New room</DialogTitle>
          <DialogDescription>
            Up to {GROUP_CHAT_MAX_MEMBERS} agents, of which at most {MAX_REMOTE_MEMBERS} may live on other machines.
          </DialogDescription>
        </DialogHeader>

        <Input onChange={event => setName(event.target.value)} placeholder="Room name" value={name} />

        <div className="max-h-64 overflow-y-auto">
          {rows.map(row => (
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm" key={row.key}>
              <input checked={picked.includes(row.key)} onChange={() => toggle(row.key)} type="checkbox" />
              <BotAvatar row={row} size={22} />
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {row.connectionId && <span className="text-xs text-muted-foreground">other machine</span>}
            </label>
          ))}
        </div>

        {refusal && (
          <p className="text-xs text-destructive">
            {refusal.reason === 'members'
              ? `A room holds at most ${refusal.limit} agents.`
              : `At most ${refusal.limit} agents in a room may live on other machines.`}
          </p>
        )}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={busy || !name.trim() || members.length < 2 || refusal !== null}
            onClick={async () => {
              setBusy(true)

              try {
                const room = await createRoom(name.trim(), members)

                if (room) {
                  onOpenChange(false)
                  setName('')
                  setPicked([])
                  openRoomPane(room.id)
                }
              } finally {
                setBusy(false)
              }
            }}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
