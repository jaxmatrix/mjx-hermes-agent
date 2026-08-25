import { IS_DESKTOP } from '@/lib/platform'

/**
 * Open the user's OS terminal application at `cwd`, via the native
 * `open_in_terminal` command.
 *
 * NOT the in-app terminal rail (`store/terminals.ts`), which is a portable-pty
 * session rendered inside a Hermes pane. The point of this one is to get OUT of
 * the app and into the shell the user has configured.
 *
 * Desktop only. `IS_DESKTOP` is checked here rather than at each call site
 * because the reason is the same everywhere: a phone has no terminal emulator to
 * hand a directory to, and the command is not registered on mobile builds.
 *
 * Returns whether the OS took it. The directory is validated NATIVELY (a session
 * outlives the directory it was started in — a deleted worktree, an unmounted
 * volume, a remote profile's path that does not exist on this machine), so a
 * `false` here means "nothing opened" and the caller should say so rather than
 * pretend a window appeared somewhere off-screen.
 */
export async function openPathInTerminal(cwd: null | string | undefined): Promise<boolean> {
  if (!IS_DESKTOP || !cwd) {
    return false
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_in_terminal', { cwd })

    return true
  } catch {
    return false
  }
}

/** Can this build offer the affordance at all? Gate the MENU ITEM on this, so a
 *  platform with no terminal to open never shows a row that cannot work. */
export const canOpenInTerminal = (cwd: null | string | undefined): boolean => IS_DESKTOP && Boolean(cwd)
