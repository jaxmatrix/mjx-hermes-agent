import { IS_TAURI } from '@/lib/platform'

/**
 * The `source` this client puts on `session.create` / `session.resume`.
 *
 * The gateway uses that field as the session's PLATFORM
 * (`_resolve_session_source` → `_resolve_agent_platform` →
 * `_load_enabled_toolsets` → `_gui_surface_toolsets`), and the ONE platform that
 * unlocks the `desktop_ui` toolset — read_terminal, close_terminal, focus_pane,
 * apply_layout, drive_preview, tour, read_preview, read_window_below,
 * react_to_message — is the literal string `"desktop"`.
 *
 * Universal used to send nothing at all (MJXHRM-472), because sending
 * `"universal"` — a string that appears nowhere in the backend — stripped all
 * nine and mis-tagged the platform hint. Omission was only ever half a fix: it
 * makes the backend fall back to `_resolve_session_platform()`, which reads the
 * SERVER's env, so a local/SSH spawn (HERMES_DESKTOP=1) got the tools and a
 * `url` or `cloud` gateway — exactly the remote setups universal exists for —
 * did not, while the same backend told the model it was talking to a GUI.
 *
 * So: say `desktop`, which is what this app is — a GUI client that answers every
 * one of those bridges (`store/tour-bridge.ts`, `store/window-below.ts`,
 * `store/agent-read-requests.ts`, `store/agent-terminal-bridge.ts`,
 * `store/preview-*`). Gated on `IS_TAURI` because a browser dev build answers
 * none of them: outside the shell there is no window to read, no pane to focus
 * and no terminal to drive, and claiming otherwise hands the model nine tools
 * that would all time out.
 *
 * Spread into the params object, so a call site that sends no source is a
 * VISIBLE omission rather than a missing import.
 */
export const SESSION_SOURCE_PARAMS: Readonly<Record<string, string>> = IS_TAURI ? { source: 'desktop' } : {}
