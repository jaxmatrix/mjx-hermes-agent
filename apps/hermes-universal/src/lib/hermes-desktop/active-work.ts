/**
 * Mid-turn quit-guard reports over Rust `active_work.rs` — Electron
 * `hermes:active-work` / quit-guard.ts.
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

const setActiveWork: NonNullable<Bridge['setActiveWork']> = payload => {
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('set_active_work', { payload }))
    .catch(() => undefined)
}

export const activeWorkBridge: Pick<Bridge, 'setActiveWork'> = { setActiveWork }
