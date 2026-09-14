import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const installPluginRequest = vi.fn()
const openAppRoute = vi.fn()
const loadAgentPlugins = vi.fn()
const discoverRuntimePlugins = vi.fn()
const notify = vi.fn()

vi.mock('@/store/windows', () => ({ openAppRoute: (route: string) => openAppRoute(route) }))
vi.mock('@/store/agent-plugins', () => ({ loadAgentPlugins: () => loadAgentPlugins() }))
vi.mock('@/contrib/runtime-loader', () => ({ discoverRuntimePlugins: () => discoverRuntimePlugins() }))
vi.mock('@/store/notifications', () => ({ notify: (input: unknown) => notify(input) }))
vi.mock('@/store/gateway', () => ({
  // `store/connection-ready` subscribes to `$gatewayState` at module scope, so a
  // partial mock of this module would silently remove it (the recipe-6.4 trap).
  $gatewayState: { get: () => 'open', listen: () => () => {}, subscribe: (fn: (v: string) => void) => {
    fn('open')

    return () => {}
  } },
  requestGateway: vi.fn()
}))

import { atom } from 'nanostores'

vi.mock('@/store/connection-ready', () => ({ $connectionReady: atom(true) }))

vi.mock('@/store/plugin-install-request', async importOriginal => {
  const actual = await importOriginal<typeof PluginInstallRequestModule>()

  return { ...actual, installPluginRequest: (request: unknown) => installPluginRequest(request) }
})

import { $restDoorEnabled } from '@/contrib/plugin-disk'
import { I18nProvider } from '@/i18n'
import { $connection } from '@/store/connection'
import { $connectionReady } from '@/store/connection-ready'
import type * as PluginInstallRequestModule from '@/store/plugin-install-request'
import { $pluginInstallRequest, closePluginInstallRequest } from '@/store/plugin-install-request'

import { PluginInstallModal } from './plugin-install-modal'

const READY = $connectionReady as ReturnType<typeof atom<boolean>>

/** Park the request BEFORE rendering, the way a real open works: the atom is
 *  set by a deep link or a settings click and the host re-renders from it. */
function mount(request?: Parameters<typeof $pluginInstallRequest.set>[0]) {
  if (request) {
    $pluginInstallRequest.set(request)
  }

  return render(
    <I18nProvider>
      <PluginInstallModal />
    </I18nProvider>
  )
}

beforeEach(() => {
  closePluginInstallRequest()
  READY.set(true)
  $restDoorEnabled.set(true)
  $connection.set(null)
  window.location.hash = '#/'
  installPluginRequest.mockReset().mockResolvedValue({ ok: true, result: { name: 'demo', ok: true } })
  openAppRoute.mockReset()
  loadAgentPlugins.mockReset()
  discoverRuntimePlugins.mockReset()
  notify.mockReset()
})

afterEach(cleanup)

const install = () => screen.getByRole('button', { name: /^Install$/ })

describe('PluginInstallModal', () => {
  it('renders nothing until a request is parked', () => {
    mount()

    expect(screen.queryByText('Install a plugin')).toBeNull()
  })

  it('names the source and says a LINK asked, for a deep link', () => {
    mount({ origin: 'deep-link', repo: 'owner/repo' })

    expect(screen.getByText(/A link asked Hermes/)).toBeTruthy()
    expect(screen.getByText('owner/repo')).toBeTruthy()
  })

  // A dialog that opens with a focused Install button is one Enter away from an
  // install the user never chose.
  it('does not focus Install for a link, and does focus the field from Settings', async () => {
    mount({ origin: 'deep-link', repo: 'owner/repo' })

    await waitFor(() => expect(document.activeElement).not.toBe(install()))

    cleanup()
    mount({ origin: 'settings', repo: '' })

    await waitFor(() => expect((document.activeElement as HTMLInputElement)?.tagName).toBe('INPUT'))
  })

  it('leaves the room before drawing, when a link arrives over Settings', () => {
    window.location.hash = '#/settings/plugins'
    mount({ origin: 'deep-link', repo: 'owner/repo' })

    // Settings is a full-screen overlay ABOVE the dialog — the question would be
    // parked behind it otherwise.
    expect(openAppRoute).toHaveBeenCalledWith('/')
  })

  it('stays put when the user opened it FROM Settings', () => {
    window.location.hash = '#/settings/plugins'
    mount({ origin: 'settings', repo: '' })

    expect(openAppRoute).not.toHaveBeenCalled()
  })

  it('disables Install until the gateway is ready, and enables it when it becomes so', async () => {
    READY.set(false)
    mount({ origin: 'deep-link', repo: 'owner/repo' })

    expect(install()).toBeDisabled()
    expect(screen.getByText(/Waiting for the gateway/)).toBeTruthy()

    act(() => READY.set(true))

    await waitFor(() => expect(install()).not.toBeDisabled())
  })

  it('refuses an identifier it cannot resolve', () => {
    mount({ origin: 'deep-link', repo: 'nonsense' })

    expect(install()).toBeDisabled()
    expect(screen.getByText(/not a repository Hermes can install/)).toBeTruthy()
  })

  it('warns about an unauthenticated source before the user consents', () => {
    mount({ origin: 'deep-link', repo: 'http://git.example.test/x/y.git' })

    expect(screen.getByText(/not an authenticated source/)).toBeTruthy()
  })

  it('warns that a desktop half will not load when the gateway door is off on a remote gateway', () => {
    $restDoorEnabled.set(false)
    $connection.set({ baseUrl: 'https://remote.test', mode: 'remote' } as never)
    mount({ origin: 'deep-link', repo: 'owner/repo' })

    expect(screen.getByText(/gateway plugin door is off/)).toBeTruthy()
  })

  it('refreshes BOTH inventories and lands on the plugins page after a success', async () => {
    mount({ origin: 'deep-link', repo: 'owner/repo' })
    fireEvent.click(install())

    await waitFor(() => expect($pluginInstallRequest.get()).toBeNull())
    expect(loadAgentPlugins).toHaveBeenCalled()
    expect(discoverRuntimePlugins).toHaveBeenCalled()
    expect(openAppRoute).toHaveBeenCalledWith('/settings/plugins')
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }))
  })

  it('surfaces missing_env as a warning rather than swallowing it', async () => {
    installPluginRequest.mockResolvedValue({ ok: true, result: { missing_env: ['FOO', 'BAR'], name: 'demo', ok: true } })
    mount({ origin: 'deep-link', repo: 'owner/repo' })
    fireEvent.click(install())

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('FOO, BAR') }))
    )
  })

  it('keeps the dialog open on 5026 and shows the backend message verbatim', async () => {
    installPluginRequest.mockResolvedValue({
      failure: 'already-exists',
      message: 'plugin demo already exists at /home/x/.hermes/plugins/demo',
      ok: false
    })
    mount({ origin: 'deep-link', repo: 'owner/repo' })
    fireEvent.click(install())

    await waitFor(() => expect(screen.getByText(/already exists at/)).toBeTruthy())
    expect($pluginInstallRequest.get()).not.toBeNull()
  })

  it('resends with force:true after the switch is flipped', async () => {
    mount({ origin: 'deep-link', repo: 'owner/repo' })

    fireEvent.click(screen.getByRole('switch', { name: /Force reinstall/i }))
    fireEvent.click(install())

    await waitFor(() => expect(installPluginRequest).toHaveBeenCalled())
    expect(installPluginRequest).toHaveBeenCalledWith(expect.objectContaining({ force: true }))
  })

  it('says the link named no repository for a 4019', async () => {
    installPluginRequest.mockResolvedValue({ failure: 'no-identifier', message: 'raw', ok: false })
    mount({ origin: 'deep-link', repo: 'owner/repo' })
    fireEvent.click(install())

    await waitFor(() => expect(screen.getByText('The link did not name a repository.')).toBeTruthy())
  })

  // The one that matters most: a false "failed" invites a Force retry, and
  // Force is what deletes a good install.
  it('never calls an unanswered install a failure', async () => {
    installPluginRequest.mockResolvedValue({ failure: 'unreachable', message: 'request timed out', ok: false })
    mount({ origin: 'deep-link', repo: 'owner/repo' })
    fireEvent.click(install())

    await waitFor(() => expect(screen.getByText(/may still be running/)).toBeTruthy())
    expect(screen.queryByText(/failed/i)).toBeNull()
  })
})
