/**
 * MJXHRM-460. The gateway has published `memory` and `disk` blocks on
 * `/api/status` since NS-656 (`gateway/memory_status.py`,
 * `gateway/disk_status.py`) and universal rendered neither: `StatusResponse`
 * never declared them, so the blocks arrived in `$statusSnapshot` on every poll
 * and sat there unread while the app claimed to be healthy.
 *
 * The rules under test are the ones a naive re-implementation gets wrong:
 * worst-first ordering across two domains, boot-scoped dismissal, the cascade
 * to the next trigger, and `unknown` NOT counting as recovery.
 *
 * Every fixture disagrees with the assertion it is used for: the snapshot is
 * seeded to the OPPOSITE state first wherever "did the component react" is the
 * question.
 */

import { render, screen } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $statusSnapshot } from '@/store/system-status'
import type { DiskStatus, MemoryStatus, StatusResponse } from '@/types/hermes'

import { activePressureTriggers, pressureDismissKey, ResourcePressureBanner } from './resource-pressure-banner'

const HEALTHY_MEMORY: MemoryStatus = {
  boot_id: '2026-08-21T04:00:00+00:00',
  gateway_rss_mb: 410,
  last_boot_suspected_oom: false,
  last_boot_unclean: false,
  pressure: 'ok',
  sampled_at: '2026-08-21T04:29:30+00:00',
  swap_used_mb: 0,
  system_available_mb: 5_100,
  system_total_mb: 16_000
}

const HEALTHY_DISK: DiskStatus = { free_mb: 41_000, pressure: 'ok', total_mb: 120_000, used_percent: 65.8 }

function statusOf(memory: Partial<MemoryStatus> = {}, disk: Partial<DiskStatus> = {}): StatusResponse {
  return {
    active_sessions: 1,
    config_version: 34,
    disk: { ...HEALTHY_DISK, ...disk },
    gateway_exit_reason: null,
    gateway_platforms: {},
    gateway_running: true,
    gateway_state: 'running',
    gateway_updated_at: null,
    latest_config_version: 34,
    memory: { ...HEALTHY_MEMORY, ...memory },
    release_date: '2026-08-01',
    version: '1.2.3'
  }
}

function mount() {
  return render(
    <I18nProvider>
      <ResourcePressureBanner />
    </I18nProvider>
  )
}

/** Re-poll: what `store/system-status.ts` does every 30s. */
function poll(status: null | StatusResponse) {
  act(() => $statusSnapshot.set(status))
}

const banner = () => screen.queryByTestId('resource-pressure-banner')
const trigger = () => banner()?.getAttribute('data-trigger') ?? null

describe('activePressureTriggers', () => {
  it('reports nothing on a healthy gateway', () => {
    expect(activePressureTriggers(statusOf())).toEqual([])
  })

  it('ranks disk critical above memory critical — silent data loss beats a restart', () => {
    // Both domains critical AND a suspected OOM: the whole cascade at once.
    const triggers = activePressureTriggers(
      statusOf({ last_boot_suspected_oom: true, pressure: 'critical' }, { pressure: 'critical' })
    )

    expect(triggers).toEqual(['disk_critical', 'critical', 'oom_restart'])
  })

  it('ranks both criticals above both elevateds', () => {
    expect(activePressureTriggers(statusOf({ pressure: 'elevated' }, { pressure: 'critical' }))).toEqual([
      'disk_critical',
      'elevated'
    ])
  })

  it('treats "unknown" as no evidence, not as a level', () => {
    // A gateway that is down, or whose heartbeat is >150s stale, reports this.
    // Rendering a banner off it would cry wolf on every restart.
    expect(activePressureTriggers(statusOf({ pressure: 'unknown' }, { pressure: 'unknown' }))).toEqual([])
  })

  it('reports the OOM post-mortem even when live memory is fine', () => {
    // The whole point of the sentinel: the process that died is not this one.
    expect(activePressureTriggers(statusOf({ last_boot_suspected_oom: true, pressure: 'ok' }))).toEqual(['oom_restart'])
  })

  it('survives a gateway that predates NS-656 and sends no blocks at all', () => {
    const legacy = statusOf()

    delete legacy.disk
    delete legacy.memory

    expect(activePressureTriggers(legacy)).toEqual([])
    expect(activePressureTriggers(null)).toEqual([])
  })
})

describe('pressureDismissKey', () => {
  it('scopes the key to the reporting gateway life', () => {
    expect(pressureDismissKey('critical', '2026-08-21T04:00:00+00:00')).toBe('critical:2026-08-21T04:00:00+00:00')
  })

  it('degrades a missing boot_id to a shared bucket instead of throwing', () => {
    expect(pressureDismissKey('critical', null)).toBe('critical:unknown')
    expect(pressureDismissKey('critical', undefined)).toBe('critical:unknown')
  })
})

describe('<ResourcePressureBanner />', () => {
  beforeEach(() => {
    sessionStorage.clear()
    // Seed the state that DISAGREES with every "banner appears" assertion.
    $statusSnapshot.set(statusOf())
  })

  it('renders nothing while the backend says everything is ok', () => {
    mount()

    expect(banner()).toBeNull()
  })

  it('appears when a later poll disagrees with the healthy seed', () => {
    mount()

    expect(banner()).toBeNull()

    poll(statusOf({}, { free_mb: 180, pressure: 'critical', used_percent: 99.8 }))

    expect(trigger()).toBe('disk_critical')
    expect(banner()?.textContent).toContain('180 MB free')
  })

  it('disappears again when the backend reports recovery', () => {
    $statusSnapshot.set(statusOf({ pressure: 'critical' }))
    mount()

    expect(trigger()).toBe('critical')

    poll(statusOf({ pressure: 'ok' }))

    expect(banner()).toBeNull()
  })

  it('stays hidden after a dismissal that survives a re-poll of the same condition', () => {
    $statusSnapshot.set(statusOf({ pressure: 'critical' }))
    mount()

    act(() => screen.getByRole('button').click())

    expect(banner()).toBeNull()

    // The 30s poll comes back saying exactly the same thing.
    poll(statusOf({ pressure: 'critical' }))

    expect(banner()).toBeNull()
  })

  it('re-opens after a gateway restart, because the boot id moved', () => {
    $statusSnapshot.set(statusOf({ pressure: 'critical' }))
    mount()
    act(() => screen.getByRole('button').click())

    expect(banner()).toBeNull()

    // Same condition, NEW gateway life. This is the incident the boot scoping
    // exists for: dismissing one OOM must not mute the hourly restart loop.
    poll(statusOf({ boot_id: '2026-08-21T05:11:00+00:00', pressure: 'critical' }))

    expect(trigger()).toBe('critical')
  })

  it('cascades to the next trigger instead of silencing everything', () => {
    $statusSnapshot.set(statusOf({ last_boot_suspected_oom: true, pressure: 'critical' }, { pressure: 'elevated' }))
    mount()

    expect(trigger()).toBe('critical')

    act(() => screen.getByRole('button').click())

    expect(trigger()).toBe('oom_restart')

    act(() => screen.getByRole('button').click())

    expect(trigger()).toBe('disk_elevated')
  })

  it('re-opens on escalation within one boot', () => {
    $statusSnapshot.set(statusOf({ pressure: 'elevated' }))
    mount()
    act(() => screen.getByRole('button').click())

    expect(banner()).toBeNull()

    poll(statusOf({ pressure: 'critical' }))

    expect(trigger()).toBe('critical')
  })

  it('clears a dismissal once that domain confirms recovery, so the next episode shows', () => {
    $statusSnapshot.set(statusOf({ pressure: 'elevated' }))
    mount()
    act(() => screen.getByRole('button').click())

    poll(statusOf({ pressure: 'ok' }))
    poll(statusOf({ pressure: 'elevated' }))

    expect(trigger()).toBe('elevated')
  })

  it('does NOT treat "unknown" as recovery — it is absence of evidence', () => {
    $statusSnapshot.set(statusOf({ pressure: 'elevated' }))
    mount()
    act(() => screen.getByRole('button').click())

    // A stale heartbeat, then the same episode again. The dismissal must hold.
    poll(statusOf({ pressure: 'unknown' }))
    poll(statusOf({ pressure: 'elevated' }))

    expect(banner()).toBeNull()
  })

  it('recovers each domain independently — a fixed disk must not un-dismiss memory', () => {
    $statusSnapshot.set(statusOf({ pressure: 'elevated' }, { pressure: 'elevated' }))
    mount()

    // Dismiss the disk warning (worst-first puts disk_elevated ahead of
    // memory elevated), then the memory one.
    act(() => screen.getByRole('button').click())
    act(() => screen.getByRole('button').click())

    expect(banner()).toBeNull()

    // The disk is fixed. Memory is exactly as bad as it was. The ONLY live
    // trigger left is the memory one, and its dismissal must have survived —
    // so a domain-crossing recovery reset shows up here as a reappearing
    // banner and nowhere else.
    poll(statusOf({ pressure: 'elevated' }, { pressure: 'ok' }))

    expect(activePressureTriggers($statusSnapshot.get())).toEqual(['elevated'])
    expect(banner()).toBeNull()
  })

  it('recovers each domain independently in the other direction too', () => {
    $statusSnapshot.set(statusOf({ pressure: 'elevated' }, { pressure: 'elevated' }))
    mount()
    act(() => screen.getByRole('button').click())
    act(() => screen.getByRole('button').click())

    // Memory is fixed, the disk is not. The disk dismissal must survive.
    poll(statusOf({ pressure: 'ok' }, { pressure: 'elevated' }))

    expect(activePressureTriggers($statusSnapshot.get())).toEqual(['disk_elevated'])
    expect(banner()).toBeNull()
  })

  it('marks a critical banner apart from an elevated one', () => {
    $statusSnapshot.set(statusOf({ pressure: 'critical' }))
    const { container } = mount()

    expect(container.querySelector('.text-destructive')).not.toBeNull()

    poll(statusOf({ pressure: 'elevated' }))

    expect(container.querySelector('.text-destructive')).toBeNull()
    expect(container.querySelector('.text-primary')).not.toBeNull()
  })

  it('survives an unparseable dismissal entry rather than crashing the shell', () => {
    // Pre-boot-scoping builds stored a bare trigger string, which is not JSON.
    sessionStorage.setItem('resourceBannerDismissed', 'critical')
    $statusSnapshot.set(statusOf({ pressure: 'critical' }))
    mount()

    expect(trigger()).toBe('critical')
  })

  it('rejects a stored value that parses but is not an array of strings', () => {
    // `JSON.parse('"critical:…"')` yields a STRING, and a string has its own
    // `.includes` — so an unfiltered value would substring-match the dismissal
    // key and hide a live banner. Same fixture, opposite outcome to the case
    // above: this one parses cleanly, so the catch never runs and only the
    // shape check can save it.
    sessionStorage.setItem('resourceBannerDismissed', JSON.stringify('critical:2026-08-21T04:00:00+00:00'))
    $statusSnapshot.set(statusOf({ pressure: 'critical' }))
    mount()

    expect(trigger()).toBe('critical')
  })

  it('drops non-string members of a stored array instead of trusting them', () => {
    sessionStorage.setItem('resourceBannerDismissed', JSON.stringify([7, null, { critical: true }]))
    $statusSnapshot.set(statusOf({ pressure: 'critical' }))
    mount()

    expect(trigger()).toBe('critical')

    // And the surviving entries still work: dismiss, and the write is a clean
    // array of strings.
    act(() => screen.getByRole('button').click())

    expect(JSON.parse(sessionStorage.getItem('resourceBannerDismissed') ?? '[]')).toEqual([
      'critical:2026-08-21T04:00:00+00:00'
    ])
  })
})
