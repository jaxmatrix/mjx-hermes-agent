/**
 * `~/.ssh/config` for desktop's SSH form: the host aliases it suggests, and what
 * one resolves to. Electron shells out to `ssh -G`; Rust reads the file itself
 * (`src-tauri/src/ssh/config.rs`), so this works where no `ssh` binary exists
 * and answers an empty list on a phone, which has no config to read.
 */

import { settingsCopy } from './registry'

type Bridge = NonNullable<typeof window.hermesDesktop>

// Dynamic: the SSH store's scope helper reaches the backend-scope module graph,
// and the bridge's install graph stays a leaf.
const sshBackend = () => import('@/store/ssh-backend')

export const sshConfigBridge: Pick<Bridge, 'sshConfigHosts' | 'sshResolveHost'> = {
  sshConfigHosts: async () => ({ hosts: await (await sshBackend()).listSshConfigHosts() }),

  sshResolveHost: async host => {
    const alias = String(host ?? '').trim()

    if (!alias) {
      // Electron's words.
      throw new Error('SSH host is required.')
    }

    const resolved = await (await sshBackend()).resolveSshHost(alias).catch(() => {
      // Rust's text names the alias; desktop's caller ignores the failure anyway.
      throw new Error(settingsCopy().gateway.sshErrUnknown)
    })

    return {
      hostname: resolved.hostname ?? null,
      identityFile: resolved.identityFile ?? null,
      port: resolved.port ?? null,
      user: resolved.user ?? null
    }
  }
}
