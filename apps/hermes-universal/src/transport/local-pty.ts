import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

// A local shell PTY driven over Tauri IPC (src-tauri/src/pty.rs). Mirrors the
// desktop (Electron) node-pty bridge: spawn `$SHELL` on THIS machine and stream
// it to xterm — no gateway, no auth, no backend endpoint. Kept parallel to
// TerminalSocket (the remote /api/shell-pty WS), which stays for a later phase.
//
// Handshake mirrors TerminalSocket/ws_open: subscribe to `pty://{id}/data` and
// `pty://{id}/exit` BEFORE invoking `pty_spawn`, so no early frame is missed.

export interface LocalPtyHandlers {
  /** Raw PTY output bytes → write straight to xterm. */
  onData: (bytes: Uint8Array) => void
  /** The child shell exited (or spawn failed). */
  onExit: () => void
  onError: (message: string) => void
  /** Fired once `pty_spawn` resolves; `shell` is the launched shell path. */
  onSpawn: (shell: string) => void
}

export interface LocalPtyOptions {
  cols: number
  cwd?: string
  rows: number
}

export class LocalPtySocket {
  private readonly id = crypto.randomUUID()
  private unlisten: UnlistenFn[] = []
  private live = false
  private closed = false

  constructor(
    private readonly options: LocalPtyOptions,
    private readonly handlers: LocalPtyHandlers
  ) {
    void this.init()
  }

  private async init(): Promise<void> {
    try {
      const sub = (suffix: string, cb: (payload: unknown) => void) =>
        listen(`pty://${this.id}/${suffix}`, event => cb(event.payload))

      this.unlisten = await Promise.all([
        sub('data', payload => this.handlers.onData(Uint8Array.from((payload as number[]) ?? []))),
        sub('exit', () => {
          this.live = false
          this.handlers.onExit()
        })
      ])

      if (this.closed) {
        void invoke('pty_kill', { id: this.id }).catch(() => undefined)
        this.teardown()

        return
      }

      const result = (await invoke('pty_spawn', {
        cols: this.options.cols,
        cwd: this.options.cwd,
        id: this.id,
        rows: this.options.rows
      })) as { shell?: string }

      this.live = true
      this.handlers.onSpawn(result?.shell ?? 'shell')
    } catch (err) {
      this.handlers.onError(err instanceof Error ? err.message : String(err))
      this.handlers.onExit()
      this.teardown()
    }
  }

  /** Send keystrokes (UTF-8) to the shell. */
  write(data: string): void {
    if (this.live) {
      void invoke('pty_write', { data, id: this.id }).catch(() => undefined)
    }
  }

  resize(cols: number, rows: number): void {
    if (this.live) {
      void invoke('pty_resize', { cols, id: this.id, rows }).catch(() => undefined)
    }
  }

  get isLive(): boolean {
    return this.live
  }

  close(): void {
    this.closed = true
    this.live = false
    void invoke('pty_kill', { id: this.id })
      .catch(() => undefined)
      .finally(() => this.teardown())
  }

  private teardown(): void {
    for (const off of this.unlisten) {
      try {
        off()
      } catch {
        // ignore
      }
    }

    this.unlisten = []
  }
}
