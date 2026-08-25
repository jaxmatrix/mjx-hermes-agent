/**
 * @hermes/plugin-sdk — THE plugin language. The vscode-module model: plugin
 * authors import exactly one module and get everything — they never touch
 * `@/…` internals and never need codebase access.
 *
 * Two delivery modes, one surface:
 *  - bundled (`src/plugins/<name>/`): the import resolves here via alias;
 *  - runtime-loaded (disk / gateway): the loader injects this same object as
 *    `globalThis.__HERMES_PLUGIN_SDK__` and rewrites the import to a shim that
 *    re-exports it, so a published plugin builds against the types with the SDK
 *    marked external.
 *
 * Capability tiers (WoW-style):
 *  - `host.state.*` — READONLY app state (nanostore atoms; `.get()` or
 *    subscribe; `useValue` in React).
 *  - `host.*` actions — curated, safe verbs (toast, haptic).
 *  - `host.request` — the gateway JSON-RPC door; the plugin's real power,
 *    and the future seam for per-plugin capability grants.
 *  - `ui.*` — the design language, so plugin UI looks native by default.
 *
 * ── Divergences from the desktop SDK (a plugin targeting both should know) ────
 *  - No `TitlebarTool`. Universal's titlebar is composed of TitlebarButton JSX,
 *    not descriptors, so `titleBar.left/center/right` are plain Slots — use a
 *    `render()` contribution. Same mechanism reaches the mobile top bar.
 *  - `ctx.rest` CAN upload and `ctx.socket` authenticates on every gateway mode
 *    — both are wider here than the note that used to sit in this spot claimed.
 *    `upload` is ONE file under the field name `file` (what a FastAPI
 *    `UploadFile` parameter expects): no multi-file, no extra form fields, no
 *    progress, and the whole file is held in memory. Desktop takes the same
 *    shape but refuses an upload outright against an OAuth-gated backend.
 *  - `ctx.os` has the same four members and the same result contract, but sits
 *    over Tauri instead of the Electron preload bridge — so on mobile (and in a
 *    plain-browser dev run) more of them resolve `false` than on the desktop
 *    app. Branch on the result; never assume the door opened.
 */

import { atom, computed, type ReadableAtom } from 'nanostores'

import { registerPaneCloser, revealTreePane } from '@/components/pane-shell/tree/store'
import { $narrowViewport } from '@/components/pane-shell/tree/store'
import { onGatewayEvent } from '@/contrib/events'
import { registry } from '@/contrib/registry'
import type { HermesGateway } from '@/hermes'
import { getLogs, getStatus } from '@/hermes'
import { connectionIdOf } from '@/lib/backend-scope'
import type { ChatMessage } from '@/lib/chat-messages'
import { $browserState, type BrowserPageState, openInAppBrowser } from '@/store/browser'
import { $currentCwd, $sessionId } from '@/store/chat'
import { $connection } from '@/store/connection'
import { $connectionReady } from '@/store/connection-ready'
import { $gateway, $gatewayState, requestGateway } from '@/store/gateway'
import { $currentModel } from '@/store/model'
import { startNewSession } from '@/store/new-session'
import { notify, notifyError } from '@/store/notifications'
import { $paneVisible } from '@/store/pane-visibility-store'
import {
  pluginConnectionSource,
  type PluginProfileRoute,
  requestPluginProfile
} from '@/store/plugin-connection-source'
import { openPluginSession, type PluginOpenSessionOptions, warmProfile } from '@/store/plugin-open-session'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeStoredSessionId, knownSessionProfile } from '@/store/session'
import { $sessionStates, runtimeKeyForStoredSession } from '@/store/session-state-types'
import { $focusedRuntimeId, $focusedSessionState, $focusedStoredSessionId } from '@/store/session-states'
import { runGatewayRestart } from '@/store/system-status'

// -- state: readonly views over the app's live atoms -------------------------

const readonlyAtom = <T>(atomLike: ReadableAtom<T>): ReadableAtom<T> => atomLike

/** Window geometry + the app's responsive posture, one readonly rect. */
export interface ViewportRect {
  width: number
  height: number
  /** Below the app's sidebar-collapse breakpoint (rails become overlays). */
  narrow: boolean
}

const readViewport = (): ViewportRect => ({
  width: typeof window === 'undefined' ? 0 : window.innerWidth,
  height: typeof window === 'undefined' ? 0 : window.innerHeight,
  narrow: $narrowViewport.get()
})

const $viewport = atom<ViewportRect>(readViewport())

if (typeof window !== 'undefined') {
  const refresh = () => $viewport.set(readViewport())
  window.addEventListener('resize', refresh)
  $narrowViewport.listen(refresh)
}

/** One session, as a plugin sees it. Deliberately small: every field here is a
 *  standing compatibility promise. */
export interface PluginSessionSummary {
  storedSessionId: string
  runtimeSessionId: null | string
  title: string
  cwd: string
  busy: boolean
}

/**
 * `$sessions` and `$messages` are NOT exported, and that is a decision rather
 * than an omission. Universal has no `$sessions` list atom, and `$messages` is a
 * projection of the ACTIVE slice (rule 16) — handing either to a plugin gives it
 * a lie on a multi-tile screen, where the session it cares about is very often
 * not the active one. Both are answered from `$sessionStates`, the source of
 * truth for EVERY session, instead.
 */
const $pluginSessions = computed($sessionStates, states =>
  Object.values(states)
    .filter(state => state.storedSessionId)
    .map(state => ({
      busy: state.busy,
      cwd: state.cwd,
      runtimeSessionId: state.runtimeSessionId,
      storedSessionId: state.storedSessionId!,
      title: state.liveTitle
    }))
)

const $busyBySession = computed($sessionStates, states => {
  const busy: Record<string, boolean> = {}

  for (const state of Object.values(states)) {
    if (state.storedSessionId) {
      busy[state.storedSessionId] = state.busy
    }
  }

  return busy
})

/** Per-session transcripts, memoised so a subscriber taken once keeps working.
 *  Bounded by the number of sessions a plugin actually asks about. */
const sessionMessageAtoms = new Map<string, ReadableAtom<ChatMessage[]>>()

export const host = {
  state: {
    /** Runtime id of the active chat session (null on a fresh draft). */
    activeSessionId: readonlyAtom<null | string>($sessionId),
    /** Active workspace cwd ('' when detached). */
    cwd: readonlyAtom<string>($currentCwd),
    /** Gateway socket state: 'idle' | 'connecting' | 'open' | …. Widened to
     *  `string` so a plugin never depends on the app's ConnectionState union. */
    gateway: readonlyAtom<string>($gatewayState as ReadableAtom<string>),
    /** Current main model slug. */
    model: readonlyAtom<string>($currentModel),
    /** Profile the live gateway is routed to. */
    profile: readonlyAtom<string>($activeGatewayProfile),
    /** Window geometry ({ width, height, narrow }). */
    viewport: readonlyAtom<ViewportRect>($viewport),

    // ── the FOCUSED session ──────────────────────────────────────────────────
    // The focused chat, NOT a "primary" one. On a multi-tile screen the session
    // you are looking at is frequently not the selected one, and a surface that
    // follows the wrong one is `28fc9d9c0d`'s bug.

    /** A turn is running in the FOCUSED session. */
    busy: computed($focusedSessionState, state => state.busy),
    /** The focused session is waiting on the model's first token. */
    awaitingResponse: computed($focusedSessionState, state => state.awaitingResponse),
    /** `storedSessionId` → busy, for EVERY open session. */
    busyBySession: readonlyAtom<Record<string, boolean>>($busyBySession),
    /** Session KEY of the focused chat (a draft has one; a runtime id does not). */
    focusedSessionId: readonlyAtom<null | string>($focusedRuntimeId),
    focusedStoredSessionId: readonlyAtom<null | string>($focusedStoredSessionId),
    /** Owning profile of the focused session, or '' when it is not known yet. */
    focusedSessionProfile: computed($focusedStoredSessionId, id => (id ? (knownSessionProfile(id) ?? '') : '')),
    /** Cumulative token usage for the focused session. */
    focusedUsage: computed($focusedSessionState, state => state.usage),
    /** Stored id of the SELECTED session (desktop's `$selectedStoredSessionId`). */
    selectedStoredSessionId: readonlyAtom<null | string>($activeStoredSessionId),
    /** Every open session, from `$sessionStates`. */
    sessions: readonlyAtom<PluginSessionSummary[]>($pluginSessions),

    /**
     * The page in the in-app browser (MJXHRM-447), for a plugin that FOLLOWS it
     * — a bookmark bar, a reader-mode button.
     *
     * `browser_eval` and the act engine are deliberately NOT exported. A plugin
     * already evaluates with the app's full authority, so exporting them would
     * add no security and would freeze the engine's internals as a published
     * contract for a subsystem that will change.
     */
    browser: readonlyAtom<BrowserPageState>($browserState),

    /**
     * Is the app usable right now?
     *
     * A RE-EXPORT of `store/connection-ready.ts`, which derives it from the six
     * connection flags — not a seventh flag (rule 12). Core surfaces read the
     * same atom, so a plugin and the app can never disagree about it.
     */
    ready: readonlyAtom<boolean>($connectionReady),

    /**
     * Which connection the app is routed to. `'local'` for the primary,
     * whatever its gateway MODE — a phone has no local spawn and is still the
     * primary connection.
     */
    connectionId: computed($connection, connection => connectionIdOf(connection))
  },

  /** Toast into the app's notification stack. */
  notify,
  notifyError,

  // NOTE: every host door is async-safe — wrapped so a sync throw from an
  // internal helper becomes a rejection a plugin's .catch() sees, never an
  // error-boundary crash.

  /** Tail an app log file (`agent` / `errors` / `gateway` / `gui` / …). */
  logs: async (...args: Parameters<typeof getLogs>) => getLogs(...args),

  /** Navigate the app router (hash routes, e.g. '/command-center?section=system'). */
  navigate: (path: string) => {
    window.location.hash = path.startsWith('#') ? path : `#${path}`
  },

  /** HEAR the gateway stream (message deltas, session lifecycle, tool
   *  activity, …) by event type — `'*'` for everything. Returns a disposer.
   *  Listeners are isolated; a throw can't affect app dispatch.
   *
   *  This runs on the streaming hot path: an expensive `'*'` handler costs
   *  something on every delta. Filter by type where you can. */
  onEvent: onGatewayEvent,

  /** Restart the backend gateway (progress surfaces in the core statusbar). */
  restartGateway: async () => runGatewayRestart(),

  /** One-shot system status snapshot (platforms, versions, …). */
  status: async () => getStatus(),

  /** Gateway JSON-RPC — sessions, config, skills, cron, everything the app
   *  itself uses. Lazy: resolves the LIVE socket per call, and rejects when the
   *  gateway is not connected. */
  request: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    requestGateway<T>(method, params),

  /**
   * The live JSON-RPC client, for the app COMPONENTS that take one (`McpTab`).
   *
   * Not an escalation: `host.request` already reaches every method, so this is
   * the same authority with a nicer handle. Null until connected — and a fresh
   * one after a gateway switch, so hold the atom rather than the instance.
   *
   * (The architecture doc calls this structurally impossible — "universal's
   * gateway lives in Rust and there is no JS instance to hand out". Only the
   * SOCKET is in Rust; the client is `src/hermes.ts`'s `HermesGateway` and
   * `store/gateway.ts` already keeps it in an atom.)
   */
  getGateway: (): HermesGateway | null => $gateway.get(),

  /**
   * Open a conversation. THE door — a plugin never resumes a session itself,
   * because a bare resume bypasses the three id spaces and the hydration plan
   * (rules 17, 18).
   *
   * Resolves when the transcript is actually PAINTED, not when the request was
   * sent, and reports why when it is not.
   */
  openSession: async (storedSessionId: string, options?: PluginOpenSessionOptions) =>
    openPluginSession(storedSessionId, options),

  /** The owning profile of a stored session, as far as the client knows. */
  sessionProfile: (storedSessionId: string): string | undefined => knownSessionProfile(storedSessionId),

  /**
   * One session's transcript. Read from `$sessionStates` — the source of truth
   * for EVERY session — rather than from the active-slice projection, which
   * would answer about a different conversation on a multi-tile screen.
   */
  sessionMessages: (storedSessionId: string): ReadableAtom<ChatMessage[]> => {
    let existing = sessionMessageAtoms.get(storedSessionId)

    if (!existing) {
      existing = computed($sessionStates, states => {
        const key = runtimeKeyForStoredSession(storedSessionId)

        return (key ? states[key]?.messages : undefined) ?? []
      })
      sessionMessageAtoms.set(storedSessionId, existing)
    }

    return existing
  },

  /** Start a fresh chat, optionally in another profile. */
  newChat: async (profile?: null | string): Promise<void> => {
    if (profile) {
      await warmProfile(profile)
    }

    startNewSession()
  },

  /** Point the app at a profile and wait for the switch to settle. Resolves
   *  false when it did not — the caller must not carry on as if it had. */
  warmProfile: async (profile: null | string): Promise<boolean> => warmProfile(profile),

  /**
   * A workspace pane owned by this plugin: register the tile, reveal it, and
   * route its close through the tree's own closer registry so the layout stays
   * the one authority on what is open.
   *
   * Returns a disposer.
   */
  openWorkspace: (
    paneId: string,
    options: { render: () => React.ReactNode; title?: string; minWidth?: number; onClose?: () => void }
  ): (() => void) => {
    const dispose = registry.register({
      area: PANES_AREA,
      data: {
        chrome: { dock: { pane: 'workspace', pos: 'center' } },
        ...(options.minWidth === undefined ? {} : { sizing: { minWidth: options.minWidth } })
      },
      id: paneId,
      render: options.render,
      title: options.title
    })

    registerPaneCloser(paneId, options.onClose)
    revealTreePane(paneId)

    return () => {
      registerPaneCloser(paneId)
      dispose()
    }
  },

  /**
   * Is this pane on screen right now?
   *
   * An ATOM, not a `when()` — the registry's `when()` is evaluated only when an
   * area's snapshot is rebuilt, so a predicate over visibility would never
   * re-run (rule 28). A pane nobody has published reads false.
   */
  paneVisibility: (paneId: string): ReadableAtom<boolean> => $paneVisible(paneId),

  /**
   * Open a URL in the in-app browser (MJXHRM-447).
   *
   * Resolves `false` when there is no guest host or the address was refused —
   * the `ctx.os.*` result-shaped convention, so a plugin branches on the answer
   * instead of sniffing the platform. A plugin showing a doc or a dashboard is
   * the most foreseeable second consumer, and without this every one of them
   * re-implements "http(s) in-app, else the OS".
   */
  openInAppBrowser: (url: string): Promise<boolean> => openInAppBrowser(url),

  // ── connections (MJXHRM-446 fills the bodies) ──────────────────────────────
  // The SHAPES ship here so 446 replaces `PluginConnectionSource` from its own
  // module and edits nothing in this file. Today every one of them answers about
  // the single live connection, and refuses anything else with a SHAPED error
  // rather than an empty success.

  connections: async () => pluginConnectionSource().connections(),
  agents: async () => pluginConnectionSource().agents(),
  ensureAgent: async (connectionId: string, profile: string) =>
    pluginConnectionSource().ensureAgent(connectionId, profile),
  /** Desktop's name for the same act — an agent you intend to talk to shortly. */
  warmAgent: async (connectionId: string, profile: string) =>
    pluginConnectionSource().ensureAgent(connectionId, profile),
  profileRoutes: async () => pluginConnectionSource().profileRoutes(),

  /** JSON-RPC to ONE agent. Dispatched through MJXHRM-480's session router, so
   *  446 gives it multi-connection reach with no change here. */
  requestProfile: async <T>(route: PluginProfileRoute, method: string, params: Record<string, unknown> = {}) =>
    requestPluginProfile<T>(route, method, params)
}

// -- react bridge -------------------------------------------------------------

// Every contribution surface, plugin-reachable: register keybinds, palette
// commands, routes, themes, panes, composer extensions, and bar items with
// the same area ids + payload types core uses.
export {
  COMPOSER_AREAS,
  type ComposerAtCompletionItem,
  type ComposerAtCompletionSource,
  type ComposerAttachmentProvider,
  type ComposerMiddleware
} from '@/app/chat/composer/contrib'

export { PALETTE_AREA, type PaletteContribution } from '@/app/command-palette/contrib'
/** Rows in the app-wide right-click / long-press menu (MJXHRM-478). The NORMAL
 *  door: contribute to `contextMenu.items` and your sections are appended to
 *  whatever target the gesture landed on, in contribution `order`. `provide()`
 *  runs per gesture, which is how live state reaches it — `when()` is not
 *  reactive. */
export {
  CONTEXT_MENU_ITEMS_AREA,
  type ContextMenuItemsContribution
} from '@/app/context-menu/contrib'
/** Claim a whole new target KIND (the sharp door — MJXHRM-447's browser webview
 *  is its first user). `order < 100` is reserved for core and `dom` is total at
 *  100, so a provider registered below it can swallow the app's own menu. */
export {
  type ContextGesture,
  type ContextMenuItemContext,
  type ContextMenuItemSpec,
  type ContextMenuSection,
  type ContextTargetProvider,
  registerContextTarget
} from '@/app/context-menu/registry'
/** `statusBar.left` / `statusBar.right` and `titleBar.left/center/right`. A
 *  `data` contribution is a StatusbarItem; a `render` contribution owns its slot
 *  (arbitrary stateful node) — the only form `titleBar.*` accepts. */
export { STATUSBAR_AREAS, TITLEBAR_AREAS } from '@/app/contrib/surfaces'
export { type RouteContribution, ROUTES_AREA, SIDEBAR_NAV_AREA, type SidebarNavContribution } from '@/app/routes'
/** Desktop exports this from `components/ui/empty-state`; on universal the
 *  canonical one lives in the settings primitives. Same component, same look. */
export { EmptyState } from '@/app/settings/primitives'

/** The toolset configurator — provider keys, per-tool switches — as Settings
 *  renders it. */
export { ToolsetConfigPanel } from '@/app/settings/toolset-config-panel'
/**
 * THE model catalog menu — the very component the chat composer's model pill
 * renders, so a plugin that lets the user choose a model gets the app's search,
 * provider grouping, `-fast` family collapse and thinking-depth submenu for
 * free, and can never drift from the composer's.
 *
 * It renders and navigates; a `ModelMenuController` decides what a selection
 * MEANS. The composer's writes through to the live session; a plugin's may just
 * hold a detached value (a per-task override) — that seam is the whole point.
 * Mount it inside a `DropdownMenuContent` and provide `ModelMenuCloseContext`
 * so a committed row dismisses your dropdown.
 */
export {
  ModelCatalogMenu,
  type ModelChoice,
  ModelMenuCloseContext,
  type ModelMenuController
} from '@/app/shell/model-catalog-menu'

// -- ui: the design language --------------------------------------------------

export type { StatusbarItem } from '@/app/shell/statusbar-controls'
/**
 * The Capabilities view (skills, MCP, hub). Reads the LIVE gateway and the
 * app's Capabilities scope itself — unlike desktop's, it takes no fixed
 * connection, so a plugin that wants a pinned one must render its own surface.
 */
export { SkillsView } from '@/app/skills'
/**
 * THE Capabilities MCP tab — server list, add/edit, OAuth, health probes — the
 * exact component Settings renders. Takes the live client from
 * `host.getGateway()`; pass `profile` to scope it to one agent.
 *
 * Exportable only because `host.getGateway()` is (P-11): it was the single
 * thing standing between universal and this export, which is MJXHRM-454's
 * stated "mcp-tab" gap.
 */
export { McpTab } from '@/app/skills/mcp-tab'
/**
 * Markdown, rendered THE APP'S WAY: the same streaming pipeline the transcript
 * uses, with its code fences, math, tables, mermaid and artifact handling.
 *
 * Not the bare `streamdown` package, deliberately — a plugin that pulls that in
 * gets a different renderer with different plugins and its output stops looking
 * like the app. Aliased as `Streamdown` for desktop source compatibility.
 */
export { MarkdownTextContent, MarkdownTextContent as Streamdown } from '@/components/assistant-ui/markdown-text'
/**
 * A layout TILE — what `ctx.registerTile(...)` takes. Prefer it over
 * `ctx.register({ area: PANES_AREA, … })`, which hands a tile's chrome and
 * sizing to an untyped `data` blob where a typo is silent.
 *
 * That flat `data` shape still works — a plugin built against an older SDK must
 * not break — but only `registerTile` type-checks what you declare, and only it
 * can express fields added later (the mount lifecycle).
 */
export type { Tile, TileChrome, TileLifecycle, TilePlacement, TileSizing } from '@/components/pane-shell/tile/types'
/** Spawn corner for `placement: 'floating'` — the one NON-tiling placement: the
 *  tile is excluded from the layout tree and rendered as a fixed, draggable card
 *  above it. It takes no width from any zone, has no tab, and can't be docked.
 *  Pair it with `chrome.anchor` (default `'top-right'`) plus `sizing.width` /
 *  `sizing.height`. A right/bottom anchor also tracks that viewport edge. */
export type { FloatingAnchor } from '@/components/pane-shell/tree/renderer/floating-rect'
export { StatusDot, type StatusTone } from '@/components/status-dot'
export { Badge } from '@/components/ui/badge'
export { Button } from '@/components/ui/button'
export { Checkbox } from '@/components/ui/checkbox'
export { Codicon } from '@/components/ui/codicon'
export { ConfirmDialog } from '@/components/ui/confirm-dialog'
export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
export { CopyButton } from '@/components/ui/copy-button'
export { DecodeText } from '@/components/ui/decode-text'
export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
export { ErrorState } from '@/components/ui/error-state'
export { FadeScroll } from '@/components/ui/fade-scroll'
export { GlyphSpinner } from '@/components/ui/glyph-spinner'
export { Input } from '@/components/ui/input'
export { Kbd, KbdGroup } from '@/components/ui/kbd'
/** The app's canonical loader (animated curves; `lemniscate-bloom` for long
 *  page loads) — the same one every core page uses. */
export { Loader, type LoaderType } from '@/components/ui/loader'
export { LogView } from '@/components/ui/log-view'
export { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
export { ScrollArea } from '@/components/ui/scroll-area'
export { SearchField } from '@/components/ui/search-field'
export { SegmentedControl } from '@/components/ui/segmented-control'
export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
export { Separator } from '@/components/ui/separator'
export { Skeleton } from '@/components/ui/skeleton'
export { Switch } from '@/components/ui/switch'

// -- contracts ----------------------------------------------------------------

export { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
export { Textarea } from '@/components/ui/textarea'
export { Tip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
export type { GatewayEventListener } from '@/contrib/events'
export type {
  HermesPlugin,
  PluginContext,
  PluginContribution,
  PluginNativeNotificationInput,
  PluginOs,
  PluginRestOptions,
  PluginStorage,
  PluginTile
} from '@/contrib/plugin'
/** Mount-scoped contribution: while the rendering component is mounted, its
 *  children render in the target area's slot; unmount disposes it. Use for
 *  page-owned chrome (a page's titlebar control leaves with the page) —
 *  `ctx.register` stays the door for permanent contributions. Namespace the
 *  id with your plugin slug (`kanban:board-switcher`). */
export { Contribute, type ContributeProps } from '@/contrib/react/contribute'
export type { Contribution } from '@/contrib/types'
/** Grab-to-pan for overflow containers (boards, timelines, wide tables) —
 *  the shared scrub primitive; don't hand-roll drag-to-scroll. */
export { type GrabScroll, useGrabScroll } from '@/hooks/use-grab-scroll'
/** Localized copy. `useI18n` reuses the app's strings; `usePluginI18n(id)` +
 *  `ctx.i18n.register` let a plugin ship its OWN locale bundles, scoped like
 *  `ctx.storage` and resolved against the app's active locale — no core edit. */
export {
  type Locale,
  type PluginI18n,
  type PluginLocaleBundles,
  type PluginMessages,
  type PluginMessageValue,
  type PluginTranslate,
  useI18n,
  usePluginI18n
} from '@/i18n'
/** A poll that yields to the app: bounded work per tick, backing off while the
 *  tab is hidden. Don't hand-roll a `setInterval` for a scanning loop. */
export { type BudgetedLoop, type BudgetedLoopOptions, createBudgetedLoop } from '@/lib/budgeted-loop'
/** THE compact-number formatter — every user-facing count/token figure goes
 *  through here (1230 → "1.2k", 1_500_000 → "1.5M"). Don't hand-roll `/1000`. */
export { compactNumber } from '@/lib/format'
export { triggerHaptic as haptic } from '@/lib/haptics'
/** A navigation target that also works as a `hermes://` deep link — what a
 *  notification's `activate` and a context menu's "open in Hermes" both take. */
export type { HermesOpenTarget } from '@/lib/hermes-open-target'

// -- app surfaces a plugin can host whole ------------------------------------

/** Turn any supported target into an in-app path, or null. THE guard: a path
 *  that did not come through here must not be navigated to. */
export { isSafeAppPath, resolveHermesOpenPath } from '@/lib/hermes-open-target'
/** The app's icon set (RefreshCw, LayoutDashboard, Activity, …). */
export * as icons from '@/lib/icons'
export { type KeybindContribution, KEYBINDS_AREA } from '@/lib/keybinds/actions'
export { formatModifierToken } from '@/lib/keybinds/combo'

// -- host contracts ----------------------------------------------------------

/** Model-id presentation, shared with the composer and the status bar:
 *  `displayModelName` for the friendly name, `modelDisplayParts` to split off a
 *  variant tag, `reasoningEffortLabel` to render a thinking depth ('high' →
 *  'High'). A plugin showing a model should never hand-roll these. */
export { displayModelName, modelDisplayParts, reasoningEffortLabel } from '@/lib/model-status-label'
/** What OS notifications can do HERE. Action buttons and tap activation are
 *  mobile-only — ask before offering them (rule 10). */
export {
  type NativeNotificationCapabilities,
  nativeNotificationCapabilities
} from '@/lib/native-notification-capabilities'
/** The app's deterministic identity color for a name (profiles, assignees,
 *  authors) + its translucent tag fill — so plugin-rendered identities read
 *  the same hue as everywhere else. */
/** Run a pointer drag to its end and unbind every listener — including on
 *  `pointercancel`, which is how a touch platform ends a gesture it stole. Use
 *  it for any drag surface (a colour field, a canvas scrub); a hand-rolled
 *  pointermove/pointerup pair leaks a live handler on every cancelled gesture. */
export { startPointerDrag } from '@/lib/pointer-drag'
export { profileColor, profileColorSoft } from '@/lib/profile-color'
/** The shared client itself, for invalidation OUTSIDE React (e.g. a
 *  `ctx.socket` frame invalidating a query). Inside components keep using
 *  `useQueryClient`. */
export { queryClient } from '@/lib/query-client'
/** The reasoning levels the app offers, and what an unset effort resolves to —
 *  so a plugin storing a thinking depth stores one the app agrees with. */
export { DEFAULT_REASONING_EFFORT, REASONING_EFFORTS } from '@/lib/reasoning-effort'
/** The app's own gateway-readiness evaluation (setup.status +
 *  setup.runtime_check, reconciled) — pass `host.request`. Don't hand-roll
 *  readiness from raw RPC shapes. */
export { evaluateRuntimeReadiness, type RuntimeReadinessResult } from '@/lib/runtime-readiness'
/** Canonical time formatting — every timestamp/age string in the app comes
 *  from these (localized `Intl` under the hood). Don't hand-roll "Xm ago". */
export { coarseElapsed, fmtDateTime, fmtDayTime, relativeTime } from '@/lib/time'
/** The transcript as a contribution area: register a named `::directive{...}`
 *  and the model can render your component inline in assistant messages. */
export {
  TRANSCRIPT_DIRECTIVE_AREA,
  type TranscriptDirectiveContribution,
  type TranscriptDirectiveProps
} from '@/lib/transcript-directives'
export { cn } from '@/lib/utils'
/** Live accent override — set a hex and the ACTIVE theme repaints with its
 *  accent family re-seeded from it (see `retintTheme`); `null` restores the
 *  authored palette. Deliberately not persisted: it is an authoring knob, not
 *  a setting, so a plugin that sets it must clear it on dispose. */
/** The in-app browser's ONE tab (MJXHRM-447), for a plugin contributing strip
 *  tools or a pane that needs to recognise it by name. */
export { BROWSER_TAB_PATH, type BrowserPageState, isBrowserTab } from '@/store/browser'

export const PANES_AREA = 'panes'
/**
 * Ask the user a yes/no question from a plain handler — no component, no state.
 * `<ConfirmHost/>` is mounted in every window, so this resolves wherever it is
 * called from.
 */
export { confirm, type ConfirmAnswer, type ConfirmRequest } from '@/store/confirm'
/** Toast a delete confirmation the way core surfaces do (desktop's
 *  `useConfirmDelete`, as a plain call — there is no hook state to hold). */
export { confirmDelete } from '@/store/confirm-delete'

export {
  MAX_NOTIFICATION_ACTIONS,
  type NativeNotifyOutcome,
  type NativeNotifyRefusal,
  type PluginNotificationAction
} from '@/store/native-notifications'
/**
 * The multi-connection source. MJXHRM-446 registers the registry's
 * implementation from its own module; until then every answer describes the one
 * live connection, and refuses anything else with `AGENT_ROUTING_UNAVAILABLE`
 * rather than an empty success.
 */
export {
  AGENT_ROUTING_UNAVAILABLE,
  type PluginAgent,
  type PluginAgentHandle,
  type PluginAgentRoster,
  type PluginConnection,
  type PluginConnectionSource,
  type PluginProfileRoute,
  setPluginConnectionSource
} from '@/store/plugin-connection-source'
export type { PluginOpenSessionError, PluginOpenSessionOptions, PluginOpenSessionResult } from '@/store/plugin-open-session'
export { $accentOverride, setAccentOverride } from '@/themes/accent-override'
/** OKLCH colour maths, for anything deriving a palette rather than hardcoding
 *  one: perceptual conversion, the sRGB gamut boundary, WCAG contrast, and
 *  hue-stable blending. */
export {
  contrastRatio,
  hexToOklch,
  hueDelta,
  maxChroma,
  mixOklab,
  normalizeHex,
  type Oklch,
  oklchToHex,
  oklchToSrgb255,
  readableOn
} from '@/themes/color'
/** The painted theme, its name, and the appearance it resolved to. */
export { useTheme } from '@/themes/context'
export { retintTheme, themeHue } from '@/themes/retint'
export type { DesktopTheme, DesktopThemeColors } from '@/themes/types'
export { THEMES_AREA } from '@/themes/user-themes'
export type { RpcEvent, StatusResponse } from '@/types/hermes'
/** Subscribe a component to a `host.state` atom. */
export { useStore as useValue } from '@nanostores/react'
/** The app's data-fetching layer. Plugins share the ONE QueryClient mounted at
 *  the app root, so their queries cache, dedupe, poll (`refetchInterval`), and
 *  invalidate exactly like core screens — no hand-rolled atoms or polls. */
export { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
/** Deterministic blob avatars — the same generator the profile roster paints,
 *  so a plugin-rendered identity matches the app's. */
export { blobatar as blobatarSvg } from 'blobatar/blob'
export { Blobatar } from 'blobatar/react'
/** Plugin-local reactive state (share between a trigger and its panel, poll
 *  loops, cross-component signals) — the same primitive `host.state` uses. */
export { atom, computed } from 'nanostores'
