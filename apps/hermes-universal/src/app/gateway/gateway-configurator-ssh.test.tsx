import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Type-only, so these are erased and cannot trip vi.mock's hoisting.
import type * as ConnectionModule from '@/store/connection'
import type * as SshBackendModule from '@/store/ssh-backend'

// An SSH Connect is desktop's apply like every other mode (MJXHRM-602): the form
// is saved as a registry row and switched onto in two phases. These pin that the
// form hands over the whole target — and dials nothing itself.

vi.mock('@/store/connections', () => ({
  applyConnection: vi.fn().mockResolvedValue('box'),
  connectionById: vi.fn(),
  saveLaunchTarget: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/lib/secure-store', () => ({
  // Resolves to a record, never null — the form prefill reads fields off it directly.
  loadSshSecrets: vi.fn().mockResolvedValue({}),
  mergeSshSecrets: vi.fn().mockResolvedValue(undefined),
  saveSecrets: vi.fn().mockResolvedValue(undefined),
  loadSecrets: vi.fn().mockResolvedValue(null)
}))
vi.mock('@/store/connection', async importActual => ({
  ...(await importActual<typeof ConnectionModule>()),
  probeStatus: vi.fn().mockRejectedValue(new Error('no gateway in tests'))
}))
vi.mock('@/store/ssh-backend', async importActual => ({
  ...(await importActual<typeof SshBackendModule>()),
  // Both prompt channels now go through one helper, so that is what has to be
  // stubbed — the underlying listeners are no longer called from the component.
  attachSshPrompts: vi.fn().mockResolvedValue(() => {}),
  newAttemptId: () => 'attempt-1',
  onSshProgress: vi.fn().mockResolvedValue(() => {}),
  testSshBackend: vi.fn().mockResolvedValue({ hostLabel: 'box', platform: 'linux' })
}))

import { I18nProvider } from '@/i18n'
import { TRANSLATIONS } from '@/i18n/catalog'
import { queryClient } from '@/lib/query-client'
import { applyConnection } from '@/store/connections'
import { $notifications } from '@/store/notifications'
import { attachSshPrompts, testSshBackend } from '@/store/ssh-backend'

import { GatewayConfigurator } from './gateway-configurator'

function renderConfigurator() {
  return render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <GatewayConfigurator variant="settings" />
      </QueryClientProvider>
    </I18nProvider>
  )
}

/** Pick the SSH mode card, type a host, and hit the commit button. */
function connectOverSsh(host = 'deploy@box') {
  fireEvent.click(screen.getByRole('button', { name: /^Connect via SSH/ }))
  fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: host } })
  fireEvent.click(screen.getByRole('button', { name: 'Save and reconnect' }))
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  $notifications.set([])
})

const gatewayCopy = TRANSLATIONS.en.settings.gateway

describe('GatewayConfigurator — SSH connect', () => {
  it("applies the form as an ssh source, as a person's click under the attempt it follows", async () => {
    const { container } = renderConfigurator()

    fireEvent.click(screen.getByRole('button', { name: /^Connect via SSH/ }))

    const [passphrase] = container.querySelectorAll('input[type="password"]')

    fireEvent.change(passphrase, { target: { value: 'unlock-the-key' } })
    connectOverSsh()

    await waitFor(() => expect(applyConnection).toHaveBeenCalledOnce())

    expect(applyConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'deploy@box', kind: 'ssh', passphrase: 'unlock-the-key' }),
      { allowInteractive: true, attemptId: 'attempt-1' }
    )
  })

  // The tunnel puts its own questions on screen (`acquireTunnel`); a second
  // attachment here would raise each of them twice.
  it("follows the dial's progress without attaching its prompts", async () => {
    renderConfigurator()
    connectOverSsh()

    await waitFor(() => expect(applyConnection).toHaveBeenCalledOnce())

    expect(attachSshPrompts).not.toHaveBeenCalled()
  })
})

describe('GatewayConfigurator — SSH test', () => {
  it('sends the credentials typed in the form, not the target alone', async () => {
    // The bug this pins down: Test sent only host/user/port/keyPath, so a
    // password or passphrase entered directly above the button never reached
    // Rust. Test therefore prompted for a credential the form was already
    // holding, and the one that was typed looked like it had been ignored. On
    // mobile it was worse — a pasted PEM is the only credential there is.
    const { container } = renderConfigurator()

    fireEvent.click(screen.getByRole('button', { name: /^Connect via SSH/ }))
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'deploy@box' } })
    fireEvent.change(screen.getByPlaceholderText('~/.ssh/id_ed25519'), { target: { value: '~/.ssh/work' } })

    // The panel's only masked rows, in order: key passphrase, then login
    // password. They are deliberately two fields — a login password typed into
    // the passphrase row does nothing at all.
    const [passphrase, password] = container.querySelectorAll('input[type="password"]')
    fireEvent.change(passphrase, { target: { value: 'unlock-the-key' } })
    fireEvent.change(password, { target: { value: 'login-secret' } })

    fireEvent.click(screen.getByRole('button', { name: 'Test SSH' }))

    await waitFor(() => expect(testSshBackend).toHaveBeenCalledOnce())

    expect(vi.mocked(testSshBackend).mock.calls[0][1]).toMatchObject({
      host: 'deploy@box',
      interactive: true,
      keyPath: '~/.ssh/work',
      passphrase: 'unlock-the-key',
      password: 'login-secret'
    })
  })

  it('leaves an untouched secret row undefined rather than blank', async () => {
    // `Some("")` is not `None` in Rust: an empty passphrase makes russh attempt
    // a decrypt instead of reporting that the key needs one, which silently
    // discarded every encrypted key.
    renderConfigurator()

    fireEvent.click(screen.getByRole('button', { name: /^Connect via SSH/ }))
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'box' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test SSH' }))

    await waitFor(() => expect(testSshBackend).toHaveBeenCalledOnce())

    const config = vi.mocked(testSshBackend).mock.calls[0][1]
    expect(config.passphrase).toBeUndefined()
    expect(config.password).toBeUndefined()
    expect(config.privateKeyPem).toBeUndefined()
  })
})

// A Connect the person dismissed has no verdict to give. MJXHRM-592's `quiet` flag
// is the legacy primary attempt's; a Test still runs one, so it still reads it.
describe('GatewayConfigurator — a quiet attempt', () => {
  it('says nothing when the person dismissed the question, and reports every other failure', async () => {
    const failed = (cause: { kind: string }) => new Error(gatewayCopy.sshErrAuth, { cause })

    vi.mocked(applyConnection).mockRejectedValueOnce(failed({ kind: 'cancelled' }))
    renderConfigurator()
    connectOverSsh()

    await waitFor(() => expect(applyConnection).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save and reconnect' })).toBeEnabled())
    expect($notifications.get()).toEqual([])

    vi.mocked(applyConnection).mockRejectedValueOnce(failed({ kind: 'credentials-needed' }))
    connectOverSsh()

    await waitFor(() => expect($notifications.get()).toHaveLength(1))
    expect($notifications.get()[0]).toMatchObject({ kind: 'error', message: gatewayCopy.sshErrAuth })
  })

  it('leaves the Test result empty when it is quiet, and fills it otherwise', async () => {
    vi.mocked(testSshBackend).mockRejectedValueOnce({ kind: 'superseded', message: 'replaced', quiet: true })
    renderConfigurator()

    fireEvent.click(screen.getByRole('button', { name: /^Connect via SSH/ }))
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'box' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test SSH' }))

    await waitFor(() => expect(testSshBackend).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test SSH' })).toBeEnabled())
    expect(screen.queryByText(gatewayCopy.sshErrUnknown)).toBeNull()
    expect($notifications.get()).toEqual([])

    vi.mocked(testSshBackend).mockRejectedValueOnce({ kind: 'auth-failed', message: 'nope' })
    fireEvent.click(screen.getByRole('button', { name: 'Test SSH' }))

    expect(await screen.findByText(gatewayCopy.sshErrAuth)).toBeInTheDocument()

    // And the same KIND with no flag fills the result like any other failure.
    vi.mocked(testSshBackend).mockRejectedValueOnce({ kind: 'superseded', message: 'replaced' })
    fireEvent.click(screen.getByRole('button', { name: 'Test SSH' }))

    expect(await screen.findByText(gatewayCopy.sshErrUnknown)).toBeInTheDocument()
  })
})
