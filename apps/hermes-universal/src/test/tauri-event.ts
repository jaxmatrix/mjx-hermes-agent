/**
 * Vitest stand-in for `@tauri-apps/api/event`. Production loads the module
 * through dynamic `import()`; aliasing it here (see vite.config `VITEST`) is
 * what makes those imports mockable — `vi.mock()` alone does not intercept them.
 */

export type TauriEventMock = {
  emit: (event: string, payload?: unknown) => Promise<void>
  listen: <T>(
    event: string,
    handler: (event: { payload: T }) => void
  ) => Promise<() => void>
}

let mock: TauriEventMock = {
  emit: async () => undefined,
  listen: async () => () => undefined
}

export function installTauriEventMock(next: TauriEventMock): void {
  mock = next
}

export function resetTauriEventMock(): void {
  mock = {
    emit: async () => undefined,
    listen: async () => () => undefined
  }
}

export const emit = (event: string, payload?: unknown) => mock.emit(event, payload)

export const listen = <T>(event: string, handler: (event: { payload: T }) => void) =>
  mock.listen(event, handler)
