import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({
  // ConfigSection reaches `store/projects` (repository discovery), which pulls in
  // `store/profile` → `store/profiles`, and that syncs the REST scope at import.
  setApiRequestProfile: vi.fn(),
  getHermesConfigRecord: vi.fn(async () => ({ display: { show_reasoning: false }, timezone: 'UTC' })),
  getHermesConfigSchema: vi.fn(async () => ({
    fields: {
      'display.show_reasoning': { type: 'boolean' },
      timezone: { type: 'string' }
    }
  })),
  saveHermesConfig: vi.fn(async () => ({ ok: true }))
}))

import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'

import { getHermesConfigRecord, getHermesConfigSchema, saveHermesConfig } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { $approvalModes } from '@/store/approval-mode'
import { setActiveProfile } from '@/store/profiles'

import { ConfigField, ConfigSection } from './config-section'
import { getNested } from './helpers'

const save = vi.mocked(saveHermesConfig)

function renderSection(sectionId = 'chat') {
  // Router context: the section reads ?field= for palette deep links.
  return render(
    <MemoryRouter>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <ConfigSection sectionId={sectionId} />
        </QueryClientProvider>
      </I18nProvider>
    </MemoryRouter>
  )
}

describe('ConfigSection', () => {
  beforeEach(() => {
    save.mockClear()
    vi.mocked(getHermesConfigRecord).mockClear()
    queryClient.clear()
    setActiveProfile(null)
  })
  afterEach(() => {
    queryClient.clear()
    setActiveProfile(null)
  })

  it('renders the section schema fields once config + schema load', async () => {
    renderSection()
    expect(await screen.findByRole('switch')).toBeInTheDocument()
  })

  it('edits a field and autosaves the full record after the debounce', async () => {
    renderSection()
    const toggle = await screen.findByRole('switch')

    fireEvent.click(toggle)

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 1500 })
    // The whole record is saved (not a partial), with the edited field flipped
    // and the untouched field preserved.
    const saved = save.mock.calls[0][0]
    expect(getNested(saved, 'display.show_reasoning')).toBe(true)
    expect(getNested(saved, 'timezone')).toBe('UTC')
  })

  // The panel stays mounted across a profile switch and `saveHermesConfig`
  // REPLACES the whole record, so an un-reset draft doesn't merge into the new
  // profile — it overwrites it with the previous profile's config wholesale.
  it('drops the draft on a profile switch instead of autosaving it into the new profile', async () => {
    renderSection()
    const toggle = await screen.findByRole('switch')

    fireEvent.click(toggle)
    expect(toggle).toBeChecked()

    // Profile B's config: the same key, still off.
    vi.mocked(getHermesConfigRecord).mockResolvedValue({ display: { show_reasoning: false }, timezone: 'Asia/Tokyo' })

    await act(async () => {
      setActiveProfile('b')
    })

    // Re-seeded from B, so the edit made against A is gone…
    await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked())
    // …and the debounced autosave it scheduled never reaches B.
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(save).not.toHaveBeenCalled()
  })

  /**
   * MJXHRM-443 — the two silent-data-loss shapes of the 08-20 contract delta.
   * A save PUTs the WHOLE draft back, so every untouched key rides along; the
   * question is whether it rides along unchanged. `agent.max_turns` is null =
   * unlimited (DEFAULT_CONFIG, not a migration), and an unset `stt.provider` is
   * what makes the backend's autodetect ladder run. Coercing either on the way
   * out silently re-caps every run / pins every fresh install to faster-whisper.
   */
  describe('values the user never touched', () => {
    it('writes back a null agent.max_turns as null, not 0 or a default', async () => {
      vi.mocked(getHermesConfigRecord).mockResolvedValue({ agent: { api_max_retries: 3, max_turns: null } })
      vi.mocked(getHermesConfigSchema).mockResolvedValue({
        fields: { 'agent.api_max_retries': { type: 'number' }, 'agent.max_turns': { type: 'number' } }
      })

      renderSection('advanced')

      // Both rows render; edit the OTHER one so max_turns is only along for the
      // ride — which is exactly the case a coercing save loses.
      const inputs = await screen.findAllByRole('spinbutton')
      // Both declared rows plus timeouts.tools.sequential_call, which renders
      // from FALLBACK_FIELD_SCHEMA with nothing seeding it.
      expect(inputs).toHaveLength(3)
      // Pick the field by its VALUE: a null max_turns renders as an empty box,
      // so an index would silently drift if the section order changed.
      const retries = inputs.find(input => (input as HTMLInputElement).value === '3')

      expect(retries).toBeDefined()
      fireEvent.change(retries!, { target: { value: '5' } })

      await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 1500 })

      const saved = save.mock.calls[0][0]
      expect(getNested(saved, 'agent.api_max_retries')).toBe(5)
      expect(getNested(saved, 'agent.max_turns')).toBeNull()
    })

    it('leaves an unset stt.provider unset instead of writing local back', async () => {
      // A fresh install: stt exists, provider does not, and the backend schema
      // no longer declares it either (the seed removal stranded its override).
      vi.mocked(getHermesConfigRecord).mockResolvedValue({ stt: { echo_transcripts: true } })
      vi.mocked(getHermesConfigSchema).mockResolvedValue({ fields: { 'stt.echo_transcripts': { type: 'boolean' } } })

      renderSection('voice')

      // The picker still renders — that is FALLBACK_FIELD_SCHEMA doing its job.
      expect(await screen.findByRole('combobox')).toBeInTheDocument()

      fireEvent.click(await screen.findByRole('switch'))

      await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 1500 })

      const saved = save.mock.calls[0][0]
      expect(getNested(saved, 'stt.echo_transcripts')).toBe(false)
      expect(getNested(saved, 'stt.provider')).toBeUndefined()
      expect(Object.prototype.hasOwnProperty.call(saved.stt as object, 'provider')).toBe(false)
    })
  })

  // MJXHRM-399. `approvals.mode` has three writers — this panel (Safety), the
  // statusbar's Zap menu, and `/approvals` — and one cached reader,
  // `$approvalModes`, which the menu fills when it mounts and nothing else ever
  // invalidates. A mode changed here left the bar reporting the old one for the
  // rest of the session, and the bar's next pick wrote that stale value straight
  // back over this save.
  describe('the approval-mode cache the statusbar renders from', () => {
    it('reconciles from the record it just saved', async () => {
      vi.mocked(getHermesConfigRecord).mockResolvedValue({
        approvals: { mode: 'off' },
        display: { show_reasoning: false },
        timezone: 'UTC'
      })
      $approvalModes.set({ default: 'smart' })

      renderSection()
      fireEvent.click(await screen.findByRole('switch'))

      await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 1500 })
      await waitFor(() => expect($approvalModes.get()).toMatchObject({ default: 'off' }))
    })

    // A config with the key unset must keep whatever default the GATEWAY
    // resolves — which is not this cache's fallback. Reconciling unconditionally
    // would slam the bar to the normalizer's "manual" on every save of an
    // unrelated section.
    it('leaves the cache alone when the record carries no mode', async () => {
      // Stated, not inherited: the suite's shared mock is a `mockResolvedValue`
      // the test above overwrites, so relying on it would make this pass or fail
      // on declaration order.
      vi.mocked(getHermesConfigRecord).mockResolvedValue({ display: { show_reasoning: false }, timezone: 'UTC' })
      $approvalModes.set({ default: 'smart' })

      renderSection()
      fireEvent.click(await screen.findByRole('switch'))

      await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 1500 })
      expect($approvalModes.get()).toMatchObject({ default: 'smart' })
    })
  })

  it('keeps a declared row the backend schema omits, inferring its type from config', async () => {
    // `memory.provider` is the live case: the backend hides it from
    // /api/config/schema on deployments where the web dashboard's Plugins page
    // owns memory providers. The row (and the panel mounted under it) must stay.
    vi.mocked(getHermesConfigRecord).mockResolvedValue({ memory: { memory_enabled: true, provider: 'honcho' } })

    renderSection('memory')

    expect(await screen.findByDisplayValue('honcho')).toBeInTheDocument()
  })
})

describe('ConfigField', () => {
  // The backend offers "" as the first memory.provider option and it means
  // built-in memory, not "memory disabled" — built-in is not a provider plugin
  // (#49513), so the generic "(none)" label misreports the subsystem as off.
  it('labels the empty memory.provider option as built-in rather than none', () => {
    render(
      <I18nProvider>
        <ConfigField
          onChange={() => {}}
          schema={{ options: ['', 'honcho'], type: 'select' }}
          schemaKey="memory.provider"
          value=""
        />
      </I18nProvider>
    )

    expect(screen.getByRole('combobox').textContent).toContain('Built-in only')
  })
})
