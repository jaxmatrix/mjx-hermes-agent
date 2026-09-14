import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Any = Record<string, unknown>

const configureProfile = vi.fn<(params: Any) => Promise<Any>>()
const describeProfile = vi.fn<(name: string) => Promise<Any>>()
const getProfileAsset = vi.fn<(name: string) => Promise<Any>>()
const setProfileAsset = vi.fn<(params: Any) => Promise<Any>>()
const clearProfileAsset = vi.fn<(name: string) => Promise<Any>>()
const notify = vi.fn<(input: Any) => void>()

vi.mock('@/lib/gateway-rpc', () => ({
  clearProfileAsset: (name: string) => clearProfileAsset(name),
  configureProfile: (params: Any) => configureProfile(params),
  describeProfile: (name: string) => describeProfile(name),
  getProfileAsset: (name: string) => getProfileAsset(name),
  setProfileAsset: (params: Any) => setProfileAsset(params)
}))
vi.mock('@/store/notifications', () => ({ notify: (input: Any) => notify(input), notifyError: vi.fn() }))

import { I18nProvider } from '@/i18n'

import { ProfileEditor } from './profile-editor'

const described = (over: Record<string, unknown> = {}) => ({
  description: 'Research agent',
  mcp_servers: [{ enabled: true, name: 'linear', transport: 'stdio' }],
  model: { default: 'glm-5', provider: 'zai' },
  name: 'research',
  skills: [
    { enabled: true, name: 'pdf' },
    { enabled: true, name: 'web' }
  ],
  soul: '',
  toolsets: [{ description: '', enabled: true, name: 'search', tool_count: 3 }],
  toolsets_pinned: false,
  ...over
})

const renderEditor = () =>
  render(
    <I18nProvider>
      <ProfileEditor profileName="research" />
    </I18nProvider>
  )

beforeEach(() => {
  configureProfile.mockClear().mockResolvedValue({ applied: {}, ok: true })
  describeProfile.mockReset().mockResolvedValue(described())
  getProfileAsset.mockClear().mockResolvedValue({ found: false })
  setProfileAsset.mockClear()
  clearProfileAsset.mockClear()
  notify.mockClear()
})

afterEach(() => vi.clearAllTimers())

describe('ProfileEditor save', () => {
  it('sends only the sections the user touched', async () => {
    renderEditor()
    const switches = await screen.findAllByRole('switch')

    // Turn OFF the first skill ("pdf"); leave toolsets and MCP alone.
    fireEvent.click(switches[0])
    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }))

    await waitFor(() => expect(configureProfile).toHaveBeenCalledTimes(1))

    const params = configureProfile.mock.calls[0][0]
    expect(params).toEqual({ disabledSkills: ['pdf'], name: 'research' })
    // An untouched toolset list must NOT be echoed back: `toolsets_pinned` is
    // false here, so sending the list would PIN today's set forever.
    expect(params).not.toHaveProperty('enabledToolsets')
    expect(params).not.toHaveProperty('enabledMcpServers')
    expect(params).not.toHaveProperty('description')
  })

  it('sends the full enabled list for a touched toolset section', async () => {
    describeProfile.mockResolvedValue(
      described({
        toolsets: [
          { description: '', enabled: true, name: 'search', tool_count: 3 },
          { description: '', enabled: true, name: 'shell', tool_count: 9 }
        ],
        toolsets_pinned: true
      })
    )

    renderEditor()
    await screen.findByText('search')

    // Switch order: 2 skills, then 2 toolsets, then 1 MCP server.
    const switches = screen.getAllByRole('switch')
    fireEvent.click(switches[3])
    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }))

    await waitFor(() => expect(configureProfile).toHaveBeenCalledTimes(1))
    expect(configureProfile.mock.calls[0][0]).toEqual({ enabledToolsets: ['search'], name: 'research' })
  })

  // Every section is applied independently and best-effort, so `ok` alone
  // cannot tell the user which half of their Save was lost.
  it('warns naming the section when the backend rejects one', async () => {
    configureProfile.mockResolvedValue({ applied: { skills: true, ui_meta: false }, ok: false })

    renderEditor()
    const switches = await screen.findAllByRole('switch')

    fireEvent.click(switches[0])
    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }))

    await waitFor(() => expect(notify).toHaveBeenCalled())
    expect(notify.mock.calls[0][0]).toMatchObject({ kind: 'warning', message: 'ui_meta' })
  })

  it('offers no save until something is edited', async () => {
    renderEditor()
    await screen.findAllByRole('switch')

    expect(screen.getByRole('button', { name: /save configuration/i })).toBeDisabled()
  })
})

describe('ProfileEditor avatar', () => {
  const upload = (file: File) => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    fireEvent.change(input)
  }

  it('stores a supported image on the gateway', async () => {
    renderEditor()
    await screen.findAllByRole('switch')

    upload(new File(['x'], 'a.png', { type: 'image/png' }))

    await waitFor(() => expect(setProfileAsset).toHaveBeenCalled())
    expect(setProfileAsset.mock.calls[0][0]).toMatchObject({ name: 'research' })
  })

  // The gateway rejects these anyway (4066 / 2 MB decoded); rejecting here is
  // what stops a 2 MB base64 round trip that can only fail.
  it('refuses an unsupported format without calling the gateway', async () => {
    renderEditor()
    await screen.findAllByRole('switch')

    upload(new File(['x'], 'a.gif', { type: 'image/gif' }))

    await waitFor(() => expect(notify).toHaveBeenCalled())
    expect(setProfileAsset).not.toHaveBeenCalled()
  })

  it('refuses an image over the 2 MB cap without calling the gateway', async () => {
    renderEditor()
    await screen.findAllByRole('switch')

    const big = new File(['x'], 'a.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: 3 * 1024 * 1024 })
    upload(big)

    await waitFor(() => expect(notify).toHaveBeenCalled())
    expect(setProfileAsset).not.toHaveBeenCalled()
  })

  it('clears a stored avatar', async () => {
    getProfileAsset.mockResolvedValue({ data: 'data:image/png;base64,AA', found: true, mime: 'image/png' })

    renderEditor()

    fireEvent.click(await screen.findByRole('button', { name: /remove/i }))

    await waitFor(() => expect(clearProfileAsset).toHaveBeenCalledWith('research'))
  })
})
