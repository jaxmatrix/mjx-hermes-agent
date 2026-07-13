import { describe, expect, it } from 'vitest'

import { appViewForPath, isOverlayView, routeSessionId, sessionRoute } from './routes'

describe('routes', () => {
  it('maps reserved paths to their view, everything else to chat', () => {
    expect(appViewForPath('/settings')).toBe('settings')
    expect(appViewForPath('/agents')).toBe('agents')
    expect(appViewForPath('/')).toBe('chat')
    expect(appViewForPath('/abc123')).toBe('chat') // a session id
  })

  it('extracts a session id from a non-reserved single-segment path', () => {
    expect(routeSessionId('/abc123')).toBe('abc123')
    expect(routeSessionId('/settings')).toBeNull() // reserved
    expect(routeSessionId('/')).toBeNull()
    expect(routeSessionId('/a/b')).toBeNull() // multi-segment
  })

  it('round-trips sessionRoute ↔ routeSessionId with encoding', () => {
    const id = 'sess/with space'
    expect(routeSessionId(sessionRoute(id))).toBe(id)
  })

  it('flags overlay views', () => {
    expect(isOverlayView('settings')).toBe(true)
    expect(isOverlayView('chat')).toBe(false)
  })
})
