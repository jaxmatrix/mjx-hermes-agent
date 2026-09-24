import { describe, expect, it, vi, beforeEach } from 'vitest'

const { warmAgent, warmProfile } = vi.hoisted(() => ({
  warmAgent: vi.fn(),
  warmProfile: vi.fn()
}))

vi.mock('@hermes/plugin-sdk', () => ({
  Button: 'button',
  Codicon: () => null,
  confirm: vi.fn(),
  createTap: () => ({ cancel: vi.fn(), down: vi.fn(), fired: () => false, move: vi.fn(), up: vi.fn() }),
  DropdownMenu: 'div',
  DropdownMenuContent: 'div',
  DropdownMenuItem: 'div',
  DropdownMenuSeparator: 'div',
  DropdownMenuTrigger: 'div',
  ErrorState: () => null,
  universalHost: { warmAgent, warmProfile },
  isCoarsePointer: () => false,
  SearchField: 'input',
  StatusDot: () => null,
  usePluginI18n: () => (key: string) => key,
  useValue: () => null
}))

vi.mock('../store/atoms', () => ({
  $botProtocolSupported: { get: () => true },
  $rooms: { get: () => ({}) },
  $roster: { get: () => [] },
  $rosterError: { get: () => null },
  $rosterLoading: { get: () => false },
  $selectedBot: { get: () => null, set: vi.fn() },
  $showHidden: { get: () => false }
}))

vi.mock('../store/bots', () => ({
  openBotChat: vi.fn(),
  refreshRoster: vi.fn(),
  saveBotMeta: vi.fn()
}))

vi.mock('../store/rooms', () => ({ disbandRoom: vi.fn() }))
vi.mock('./avatar', () => ({ BotAvatar: () => null, RoomAvatar: () => null }))
vi.mock('./create-room-dialog', () => ({ CreateRoomDialog: () => null }))
vi.mock('./room-pane', () => ({ openRoomPane: vi.fn() }))
vi.mock('../ids', () => ({ botHandle: (p: string) => p }))
vi.mock('../model/roster', () => ({ visibleRoster: (rows: unknown) => rows }))

import { warmBotRow } from './bots-pane'

describe('warmBotRow', () => {
  beforeEach(() => {
    warmAgent.mockReset()
    warmProfile.mockReset()
  })

  it('uses warmAgent for rows on another connection', () => {
    warmBotRow({ connectionId: 'https://gw-b.test', profile: 'worker' })
    expect(warmAgent).toHaveBeenCalledWith('https://gw-b.test', 'worker')
    expect(warmProfile).not.toHaveBeenCalled()
  })

  it('uses warmProfile for local rows', () => {
    warmBotRow({ profile: 'default' })
    expect(warmProfile).toHaveBeenCalledWith('default')
    expect(warmAgent).not.toHaveBeenCalled()
  })
})
