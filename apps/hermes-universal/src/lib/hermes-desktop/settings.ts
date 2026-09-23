/**
 * `hermesDesktop.settings`: the folder new LOCAL chats start in.
 *
 * Electron keeps it in `project-dir.json` and its spawned backend reads it.
 * Universal's is a preference (`store/default-project-dir`), sent as the `cwd`
 * of `session.create` on a local connection only — a path on this machine means
 * nothing to a gateway on another. Desktop-only: a phone has no folder picker
 * and no local backend.
 *
 * `setDefaultProjectDir` creates nothing: every caller passes a folder the OS
 * picker just returned, which exists.
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

export const settingsBridge: Pick<Bridge, 'settings'> = {
  settings: {
    getDefaultProjectDir: async () => {
      const [{ $defaultProjectDir }, { homeDir }] = await Promise.all([
        import('@/store/default-project-dir'),
        import('@tauri-apps/api/path')
      ])

      const dir = $defaultProjectDir.get()
      const home = await homeDir().catch(() => '')

      return { defaultLabel: home, dir, resolvedCwd: dir ?? home }
    },

    pickDefaultProjectDir: async () => {
      const [{ open }, { $defaultProjectDir }] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@/store/default-project-dir')
      ])

      const picked = await open({
        defaultPath: $defaultProjectDir.get() ?? undefined,
        directory: true,
        multiple: false
      })

      return typeof picked === 'string' && picked ? { canceled: false, dir: picked } : { canceled: true, dir: null }
    },

    setDefaultProjectDir: async dir => {
      const { $defaultProjectDir, setDefaultProjectDir } = await import('@/store/default-project-dir')

      setDefaultProjectDir(typeof dir === 'string' ? dir : null)

      return { dir: $defaultProjectDir.get() }
    }
  }
}
