# PORT.md — Full-Parity Port: Hermes Desktop → Hermes Universal

> **Committed working ledger** (previously gitignored; now tracked as of the rename below). This is the
> ledger for porting the full Hermes **desktop** (`apps/desktop`, Electron + React) feature set onto the
> **universal** Tauri v2 client (`apps/hermes-universal` — desktop + Android + iOS from one codebase;
> historically called "mobile"). Update the status table as steps land.
>
> **Naming note:** this app was originally scaffolded as `apps/mobile` and many steps below say "mobile".
> It is really a *universal* rewrite, not a mobile-only client — see the handoff summary at the bottom for
> the rename and the deferred "de-mobile" cleanup.

Status legend: `[ ]` pending · `[~]` in progress · `[x]` done · `[-]` gated/skipped for this platform.

---

## Context & architecture reality

`apps/mobile` today = a **remote-only chat client** (~1,610 LoC TS + ~248 LoC Rust, typechecks clean):
connect → probe `/api/status` → auth (`none`/`token`/`ticket` via password-login) → gateway WS →
streaming chat (reasoning / tool-chips / approval). All HTTP+WS runs in a **Rust transport**
(`src-tauri/src/transport.rs`: `http_request`, `ws_open/ws_send/ws_close`, reqwest cookie jar) so the
webview has no CORS constraint. Frontend: React 19 + a hand-written nanostores-compatible atom store,
a single `styles.css`, **no router**, vendored gateway core (`src/gateway/*` copied from `apps/shared`).

**Desktop** is the full product: **Electron** shell + React/Vite renderer, ~150-method `hermes.ts` API
client, ~84 nanostores, assistant-ui rich rendering, and ~90 Electron-main IPC channels for
OAuth/cloud/local-spawn/git/fs/terminal.

**Core reality:** desktop's native surface lives in the **Electron main process** (`BrowserWindow`,
`net`, `safeStorage`, `child_process.spawn`, session partitions). None of that exists in a Tauri
webview → every native-backed feature is **new Rust/Tauri work**, not a JS copy. This is the real lift
and it gates the feature tracks.

**Goal:** full parity, all three gateway modes (**Local gated/hidden on Android**), including voice,
file browser/attachments, code review/git, and pet/themes/i18n.

---

## Feature inventory (traced from desktop navigation — parity checklist)

Source: `apps/desktop/src/app/routes.ts`, `settings/index.tsx`, `skills/index.tsx`,
`right-sidebar/index.tsx`, `command-palette/index.tsx`.

- **Top-level views (10):** chat · settings · command-center · **skills** · messaging · artifacts · cron · profiles · agents · starmap
- **Skills view tabs (where “plugins” live):** Skills · Toolsets · **MCP servers** · **Hub** (install/marketplace)
- **Right sidebar panes:** file browser · terminal · code-review/git · preview
- **Chat surface:** rich markdown (streamdown/shiki/katex/mermaid) · tool calls + diffs · approval/sudo/secret/clarify · reasoning · embeds · composer (slash + @-mention completions, attachments, voice, queue, input history)
- **Sessions:** list · switcher · picker · search · export · branch · rename/delete · projects/workspaces
- **Settings tabs:** model · chat · appearance · voice · safety/advanced · memory · notifications · providers (accounts + API keys) · gateway (local/remote/cloud) · keys/credentials (tools + settings) · archived chats · computer-use · pet · about · uninstall
- **Gateway modes:** local (spawn) · remote (URL) · cloud (Nous portal / Privy SSO + agent discovery)
- **Cross-cutting:** profiles · command palette (cmdk) · onboarding · themes/marketplace · i18n (en/ja/zh/zh-hant) · notifications · keybindings · haptics · voice/audio · pet/companion · updates
- **Agents/subagents · cron/routines · messaging platforms · artifacts · starmap (d3-force)**

---

## Porting principles

1. **Atomic step** = one store file / one component / one Rust command / one hermes.ts method-group / one route — independently compilable, reviewable, testable. **Canonical ledger IDs are the per-track numbers (`An`/`In`/`Jn`/`Kn`); when a single item is too large for one commit, decompose it as nested sub-steps `Kn.a`, `Kn.b`, … under that item — never a new flat `KcN` renumber.** (Commit-message shorthand may still say `Kc…`; the ledger folds each into its canonical `Kn`.)
2. **Foundation tracks A–F land before any feature track G–K.** After F, feature tracks parallelize.
3. Step tags: **[RUST]** new Tauri/Rust work · **[PORT]** JS/React copy-adapt from desktop · **[JS]** new mobile glue · **[GATE]** platform-gated (hidden on Android).
4. Reuse `apps/shared` (`JsonRpcGatewayClient`, `websocket-url`); de-vendor the mobile copy where feasible.
5. **FIXME convention:** any deferred/stubbed/adapted-away-from-desktop code gets a `// FIXME(<track>): <what the full port still needs>` comment at the site. `grep -rn "FIXME(" src` is the authoritative "not-fully-ported-yet" index alongside this ledger.
6. **Responsive UI discipline (mobile-first — applies to ALL UI, from Track F on):**
   1. Base classes = phone; `sm:`/`md:`/`lg:` only **add** for bigger screens — never `max-*` walkbacks.
   2. Push breakpoints into layout primitives (`Container`/`Grid`/`Stack` in `src/components/layout/`); pages compose them and stay breakpoint-noise-free.
   3. Container queries (`@container` + `@md:`, core in Tailwind v4) for reusable components that adapt to their _slot_ width; viewport breakpoints for page/shell layout.
   4. `clamp()` for things that just scale (type, padding, gaps); discrete breakpoints only for genuine reflow (stack→row, 1→N cols).
   5. Nav is an explicit shared-content / two-presentations split (rail vs drawer), not one component doing both.
   6. Locked breakpoints = Tailwind v4 defaults (`sm/md/lg/xl`); no arbitrary `min-[…px]:`.

---

## Native Rust/Tauri work — master list (gates feature tracks)

| #   | Capability                                          | Desktop (Electron)                      | Tauri/Rust replacement                                                                                                                               | Blocks                        |
| --- | --------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| R1  | Platform detect                                     | `process.platform`                      | `tauri-plugin-os`                                                                                                                                    | gating (A)                    |
| R2  | Secure credential store                             | `safeStorage`                           | custom `secure_store_{set,get,delete}`: Android `EncryptedSharedPreferences`, `stronghold` elsewhere                                                 | auth (D), keys                |
| R2b | Cookie persistence                                  | persistent partition                    | serialize reqwest cookie jar across launches                                                                                                         | oauth/cloud                   |
| R3  | OAuth interactive login                             | partition `BrowserWindow` + cookie poll | `tauri-plugin-deep-link` (`hermes://auth/callback`) + system browser (`tauri-plugin-opener`); land Set-Cookie in reqwest jar via `oauth_login(base)` | D-oauth, cloud                |
| R4  | ws-ticket mint under oauth                          | `net` on partition                      | already works via shared cookie-store client; verify                                                                                                 | D                             |
| R5  | Cloud/Portal (Privy) login + discovery + silent SSO | hidden `BrowserWindow` 302 cascade      | `portal_login`, `portal_discover_agents(org)`, `portal_agent_sign_in(url)` in reqwest                                                                | E-cloud                       |
| R6  | Local backend spawn                                 | `child_process.spawn`                   | **[GATE]** `tauri-plugin-shell` on desktop only; `cfg(android)`→unsupported                                                                          | E-local                       |
| R7  | Filesystem / attachments / preview                  | `fs:*` IPC                              | `tauri-plugin-fs` + `tauri-plugin-dialog` (SAF picker)                                                                                               | file browser, attach, preview |
| R8  | Notifications                                       | `hermes:notify`                         | `tauri-plugin-notification` (+ Android POST_NOTIFICATIONS)                                                                                           | notifications                 |
| R9  | Haptics                                             | `web-haptics`                           | `tauri-plugin-haptics` (Web Vibration fallback)                                                                                                      | chat, approvals               |
| R10 | Voice mic + TTS                                     | `getUserMedia`/WebAudio                 | webview `getUserMedia` + Android `RECORD_AUDIO`; STT/TTS via gateway `audio.*`                                                                       | voice                         |
| R11 | Clipboard / open-external / share / link-title      | clipboard + `shell.openExternal`        | `tauri-plugin-clipboard-manager`, `tauri-plugin-opener`, Android share intent; link-title via Rust http                                              | embeds, artifacts, links      |
| R12 | Updates                                             | electron-builder                        | `tauri-plugin-updater` (desktop) / Play Store **[GATE]** on Android                                                                                  | updates                       |
| R13 | Deep links                                          | custom protocol                         | `tauri-plugin-deep-link` (shared w/ R3)                                                                                                              | nav, notifications, cron      |
| R14 | Git/worktree/review                                 | `simple-git`                            | **[GATE]** desktop-only `git` via shell; Android = remote diffs read-only                                                                            | code review                   |
| R15 | Terminal                                            | node-pty                                | **impractical on Android**; desktop = shell pty + xterm; Android **[GATE]** or remote stream                                                         | terminal                      |

**Platform gating (decide once in A):** `tauri-plugin-os` → `src/lib/platform.ts` exporting `IS_ANDROID`,
`LOCAL_MODE_SUPPORTED = !mobileFormFactor`. UI hides Local mode / terminal / updater / pet-overlay when
unsupported; Rust commands `cfg(target_os="android")`→`unsupported_platform`. Every new plugin permission
goes into `src-tauri/capabilities/default.json` incrementally.

---

## Dependency graph & milestones

```
A ─┬─> B(nanostores) ─> C3(client) ─> H, J, K (all feature data)
   └─> C1 types ;  C2(REST via Rust http) ─> C3 REST groups
A5 ─> A6 gating
D1 secure store ─> D2, J-keys
D3 deep-link ─> D4 oauth ─> D6, E4/E5 cloud ;  E3 local [GATE]
F(router+shell) ─> every feature route
G1(assistant-ui) ─> G2..G10 ;  R7 fs ─> G8-attach/K13 ;  R10 mic ─> G8-voice/K9
```

**Critical path to a usable app:** A → B → C1/C2/C3(sessions,models,config) → D(remote+oauth) → F →
G1–G4 (rich chat core) → H ← **“usable milestone.”**
Then parallelize D3/D4 OAuth, E cloud/local, G5–G10, I, J tabs, K areas.

---

## Impractical / major-rework features (parity via adaptation)

- **Terminal (K15):** node-pty impossible in webview/Android sandbox. Desktop Tauri → shell pty + xterm.js. Android **[GATE]** hide, or remote terminal stream if the gateway exposes one.
- **File browser (K13):** no browsable local FS on Android. Replace `react-arborist`-over-local-FS with a **remote workspace listing via gateway** + `tauri-plugin-dialog`/SAF attachment picker. Local FS tree desktop-only **[GATE]**.
- **CodeMirror editor / preview-edit:** CodeMirror works in webview — port it; scope editing to remote/gateway + SAF-picked files (no free-form absolute paths).
- **Code review/git (K14):** git binary absent on Android. Desktop → `git` via shell (port `electron/git-*.ts`). Android **[GATE]** → gateway-served diffs, read-only.
- **Pet overlay (K10):** desktop transparent overlay window → **[GATE]** in-app pet on Android; second WebviewWindow on desktop Tauri.
- **Updates (K12):** Android = Play Store **[GATE]**; desktop = `tauri-plugin-updater`.
- **Zoom / titlebar / translucency / window-state:** zoom→CSS root font-size; drop titlebar/translucency on Android (no-ops so ported components compile).

---

## Test plan (per feature area)

Port desktop `.test.ts` files and adapt where logic is shared. Each area = unit tests (logic/reducers/API
shapes) + manual/E2E on a real Android device.

- **Foundation (A/B/C/F):** `cn()` merge; Tailwind builds; `platform.ts` → android + `LOCAL_MODE_SUPPORTED===false`; atom get/set/subscribe/computed; persisted atom rehydrates; `tsc --noEmit` on ported types; `apiRequest` URL+auth via mocked `http_request`, 401 surfaces; C3 per-group request shape matches desktop `hermes.test.ts`; `appViewForPath`/`routeSessionId`/`sessionRoute`; nav across all 10 views; connected-guard redirect when disconnected.
- **Auth/Gateway (D/E):** secure_store round-trip + survives restart + not plaintext; oauth E2E (Login → system browser → `hermes://` callback → ws-ticket → chat); Local card absent on Android / present on desktop; android spawn=unsupported / desktop spawns+ready; cloud portal login → agent list → silent connect.
- **Chat (G):** reducer handles all events incl. clarify/sudo/secret/subagent/moa; markdown renders code/math + XSS sanitized; mermaid renders; tool-diff parse + approval respond; embeds; slash/mention filtering + queue order; attach file [R7]; voice dictation [R10]; stays pinned during stream; haptic on send.
- **Sessions (H):** list/search/rename/branch/export request shapes; switch reloads history; export produces file.
- **Themes/i18n/notify (I):** locale switch updates strings; theme preset applies vars; notification appears (permission prompt) + tap deep-links to session.
- **Settings (J):** per tab — loads config (C3 group) + save posts; keys tab uses secure_store; uninstall hidden on Android.
- **Feature areas (K):** per area — store reducer + API group unit + manual route-renders + primary action round-trips (starmap pan/zoom; cron create + deep-link; voice mic→transcript→TTS; pet in-app / overlay hidden on Android).
- **Native plugins:** Rust unit tests where pure; device tests for permissioned ones (notification, mic, fs, deep-link, haptics, share).

---

## Step ledger

Each step: `id [TAG] description — target file(s)`. Tick the box on landing; note the PR.

### Track A — Foundation: build / styling / platform / tests

- [x] A1 [JS] Tailwind v4 wired (plugin + empty-PostCSS pin), inert — `vite.config.ts`, `package.json` (tailwindcss+@tailwindcss/vite 4.3.2). Build/typecheck green, no visual change; utility emission smoke-verified.
- [x] A2 [JS] Activated `@import 'tailwindcss'` + `@custom-variant dark`; Preflight reconciled (unlayered mobile classes win, screens unchanged); added `@theme inline` shadcn named-token map (`--color-*`/`--radius-*`) sourced from `--ui-*` — `src/styles.css`. Full desktop `--ui-*` palette + `--theme-*` engine deferred to I3 / lazy growth. Smoke-verified named tokens resolve to mobile colors.
- [x] A3 [PORT] Ported 7 shadcn primitives adapted (touch-tuned, A2 tokens, Tabler icons, API-compatible): button, input(+control), dialog, dropdown-menu, tabs, tooltip, scroll-area — `src/components/ui/`. Dialog i18n label deferred to I1; verified via throwaway demo (composes/bundles/dev-boots).
- [x] A4 [JS] `cn()` (clsx + tailwind-merge) + `@/lib/icons` Tabler re-export + deps (cva, radix-ui) — landed with A3.0 — `src/lib/utils.ts`, `src/lib/icons.ts`
- [x] A5 [RUST] `tauri-plugin-os` registered + `@tauri-apps/plugin-os` bindings; granted least-privilege `os:allow-platform` in `capabilities/default.json` (the running native-permission ledger). Verified via `cargo check`. — `Cargo.toml`, `lib.rs`, `capabilities/default.json`
- [x] A6 [JS/GATE] `PLATFORM`/`IS_ANDROID`/`IS_MOBILE`/`LOCAL_MODE_SUPPORTED`; `platform()` guarded for non-Tauri (browser/vitest) → desktop-like fallback — `src/lib/platform.ts`
- [x] A7 [JS] vitest + @testing-library (jsdom, jest-dom) via `test` block in `vite.config.ts`; `test`/`test:watch` scripts; first 7 tests (platform, cn, Button) — `package.json`, `vite.config.ts`, `src/test-setup.ts`

### Track B — State/store engine parity

- [x] B1 [PORT] Replaced `atom.ts` shim with real `nanostores` + `@nanostores/react` re-export (zero-churn seam; adds computed/map/onMount) — `src/store/atom.ts`
- [x] B2 [PORT] Ported `persistentAtom` + `Codecs` (from desktop) over a null-aware `readKey`/`writeKey` choke point — `src/lib/persisted.ts`, `src/lib/persist.ts`
- [~] B3 [PORT] Leaf stores ported **lazily with their consumers** (not a standalone step): layout/keybinds → Track F; todos/thread-scroll → Track G; zoom→CSS, notifications → Track I. Adapt desktop-shaped ones as they land.

### Track C — API client parity (`hermes.ts`)

- [x] C1 [PORT] `types/hermes.ts` copied verbatim (108 self-contained types) — `src/types/hermes.ts`
- [x] C2 [JS] `api()` aligned to the desktop REST contract (+ ignored `profile` field, `FIXME(E)`); routes through Rust `http_request` + `$connection` auth — `src/lib/api.ts`
- [x] C3 [PORT] **Whole-file** port of the REST client (103 fns): shared import → `@/gateway`, `window.hermesDesktop.api` → `api()`. Tree-shaken until consumed; RPC still via `requestGateway` — `src/hermes.ts`
- [x] C4 [JS] `@tanstack/react-query` + `queryClient`/`writeCache` + `QueryClientProvider` in `main.tsx` — `src/lib/query-client.ts`, `src/main.tsx`

### Track D — Auth + secure storage + OAuth

- [x] D1 [RUST] Secure storage via `tauri-plugin-keyring` (silent, Android Keystore-backed) + `src/lib/secure-store.ts` seam. NOTE: pivoted from `tauri-plugin-keystore` (biometric) — its only published build was a broken alpha; `FIXME(D)` tracks re-adding biometric via `tauri-plugin-biometric`. Android runtime path verified on-device (deferred). [R2]
- [x] D2 [JS] Credentials off plaintext → keyring (token/password); url/username stay in localStorage; silent prefill on mount — `src/store/connection.ts`, `connect-screen.tsx`
- [ ] D3 [RUST] `tauri-plugin-deep-link` + `hermes://` (AndroidManifest intent-filter) [R3/R13] — **OAuth half (D3–D6) deferred to its own session**
- [ ] D4 [RUST] `oauth_login/oauth_status/oauth_logout` (system browser → deep-link → cookie jar) — `src-tauri/src/oauth.rs` [R3/R4]
- [ ] D5 [JS] Pure `connection-config` model (auth-mode enum incl. `oauth`, cookie-liveness via ws-ticket) — `src/store/gateway-config.ts`
- [ ] D6 [JS] Wire `authMode:'oauth'` into `connect()` — `src/store/connection.ts`

### Track E — Gateway modes (local / remote / cloud)

- [ ] E1 [PORT] Gateway-mode model + `gateway-switch` — `src/store/gateway.ts`, `gateway-switch.ts`
- [ ] E2 [JS/GATE] 3-card mode picker; Local hidden unless `LOCAL_MODE_SUPPORTED` — `src/app/gateway/mode-picker.tsx`
- [ ] E3 [RUST/GATE] `local_backend_{spawn,status,stop}` (android→unsupported) — `src-tauri/src/local_backend.rs` [R6]
- [ ] E4 [RUST] `portal_login`, `portal_discover_agents`, `portal_agent_sign_in` — `src-tauri/src/cloud.rs` [R5]
- [ ] E5 [PORT] Cloud UI: discovery list + connect — `src/app/gateway/cloud-agents.tsx`

### Track F — Navigation / app shell

- [x] F0 [JS] Responsive UI discipline adopted as principle #6 (mobile-first; base+prefixes; primitives own breakpoints; container queries; clamp; nav split; locked breakpoints)
- [x] F1 [PORT] `react-router-dom` + `routes.ts` verbatim + `HashRouter` in `main.tsx` — `src/app/routes.ts`
- [x] F2 [JS] Responsive layout primitives (`Container`/`Grid`/`Stack`) + `Sheet` drawer + nav icons — `src/components/layout/`, `src/components/ui/sheet.tsx`
- [x] F3 [JS] **Sidebar shell** — shared `SidebarNav` as md+ rail / phone `Sheet` drawer via `SidebarProvider`+`SidebarTrigger`; connected-guard + `Routes`; FIXME-tagged placeholders for the 9 un-ported views; chat gains a `md:hidden` hamburger — `src/app/shell/`, `src/app/mobile-controller.tsx`
- [x] F4 [PORT] `ErrorBoundary` (adapted) wrapping the tree; `FIXME(I)` marks where I18n/Theme/Haptics providers mount — `src/components/error-boundary.tsx`, `src/main.tsx`
- [~] F5 [JS] Command palette (cmdk) — **deferred (lazy)**; sidebar is the primary nav — `src/app/command-palette/index.tsx`

### Track G — Chat rich rendering

- [x] G1 [PORT] **assistant-ui runtime adopted** — gateway reducer emits assistant-ui parts (text/reasoning/tool-call); extended events (reasoning.available, moa.reference, clarify/sudo/secret); stock external-store runtime + `convertMessage` — `src/store/chat.ts`, `src/app/chat/runtime.tsx`. (subagent/moa.aggregating → `FIXME(K3)`; full desktop chat-messages coalescing → `FIXME(G)`.)
- [x] G2 [PORT] Markdown via streamdown (GFM + Shiki code) + Tailwind typography, A2-token prose — `src/components/assistant-ui/markdown-text.tsx`. (KaTeX math → `FIXME(G)`; sanitize via streamdown security.)
- [ ] G3 [PORT] Mermaid (lazy) — `FIXME(G)` (streamdown supports it; not wired) — `.../embeds/mermaid.tsx`
- [~] G4 [PORT] **Basic** tool row (name/status/args/result) done; full `buildToolView` (diffs/ansi/search/image) → `FIXME(G4)` — `src/components/assistant-ui/thread/tool-part.tsx`
- [~] G5 [PORT] Approval kept; sudo/secret/clarify routed to atoms with stub responders (`respondClarify/Sudo/Secret`) — UI → later — `store/chat.ts`
- [x] G6 [PORT] Reasoning disclosure — `src/components/assistant-ui/thread/reasoning-part.tsx`
- [~] G7 [PORT] Links open externally (Gc6); inline images / rich unfurl → `FIXME(G7)`
- [x] G8 [PORT] Composer: slash/@ completions (Gc7), attachments (Gc8), voice (Gc9), queue+history (Gc7) — `src/app/chat/composer.tsx`
- [x] G9 [PORT] Stick-to-bottom via `ThreadPrimitive.Viewport` autoScroll — `thread.tsx`
- [x] G10 [JS/R9] Haptics on send/approval (Gc10) — `src/store/haptics.ts`

**Track G completion — remaining atomic sub-chunks** (do one at a time; tick + commit each):

- [x] Gc0 [chore] Dedupe assistant-ui → 0.14.26 (exact), drop unused deps (dompurify/katex/remark-math) — `4adcbb330`
- [x] Gc1 [PORT] Pure formatters ported verbatim (+ tests): `lib/text.ts`, `lib/summarize-command.ts`, `lib/tool-result-summary.ts` — `e12aeda4c`. (external-link/i18n-shim/haptics-seam folded into their consuming chunks instead.)
- [x] Gc2 [JS] Math (KaTeX): `@streamdown/math`+`@streamdown/code` wired `plugins={{code,math}}` (singleDollarTextMath) + KaTeX CSS in main.tsx — `fed6a2195`
- [x] Gc3 [JS] Mermaid: `@streamdown/mermaid` plugin (engine lazy-chunked) — `8e3f3fe59`. Diagram render in webview = on-device check.
- [~] Gc4 [PORT] Lean rich `ToolEntry` (humanized title + formatted result/error via ported formatters) — `b25bbaf67`. Full desktop parity (inline diffs/ansi/search/images from `fallback-model/buildToolView`) → `FIXME(G4)`.
- [x] Gc5 [JS] Prompt UIs: fixed atom shapes ($sudo password flow + request_id; $clarify+request_id); wired clarify/sudo/secret.respond RPCs; ClarifyBar/SudoBar/SecretBar in ChatScreen — `d1ed46a6e`
- [x] Gc6 [RUST] Links: `tauri-plugin-opener` + `openExternalLink`; markdown `<a>` opens in system browser — `1ec055484`. Inline images/rich unfurl → `FIXME(G7)`. Actual open device-verified.
- [x] Gc7 [JS] Composer completions: `/`→complete.slash + `@`→complete.path drawer, persisted history (ArrowUp/Down), send-while-busy queue — `aee84cc9d`. `slash.exec`/arg-splice → `FIXME(Gc7)`.
- [x] Gc8 [RUST] Attachments: `tauri-plugin-dialog`+`tauri-plugin-fs`; pickAttachment → data-URL → `file.attach`→ref → composer chips + spliced into `prompt.submit` — `b36155520`. Picker/fs read + SAF device-verified.
- [x] Gc9 [JS] Voice: `useVoiceRecorder` (getUserMedia+MediaRecorder) → `transcribeAudio` → composer; mic button — `29aff10c9`. Device setup: RECORD_AUDIO manifest + webview mic grant (gen/ gitignored). `speakText` auto-speak → `FIXME(Gc9)`.
- [x] Gc10 [RUST] Haptics: `tauri-plugin-haptics` + `triggerHaptic` seam (Web Vibration fallback, $hapticsMuted); fires on send/approval — `de60563e9`. Vibration device-verified.

### Track H — Sessions

- [x] H1 [PORT] session store (Hc2) — `src/store/session.ts`
- [x] H2 [JS] History sheet list/switcher (Hc3) — `src/app/chat/session-sheet.tsx`
- [x] H3 Search (Hc2/Hc3) · [~] H4 Export → `FIXME(H4)` (needs save/share transport) · [~] H5 Branch → `FIXME(H5)` (tree UI) · [x] H6 Rename/delete/archive (Hc2/Hc3)

**Track H — atomic sub-chunks** (one at a time):

- [x] Hc1 [PORT] `session-history.ts` — lean `toChatMessages(SessionMessage[])→parts` (attaches tool results, groups tool-only assistants, dedupes ids) + 6 tests — `296192d53`
- [x] Hc2 [JS] `src/store/session.ts` — `$sessions`/refresh/loadMore, `openSession` (`session.resume`+hydrate+bind `$sessionId`, getSessionMessages fallback), `newSession`, optimistic rename/delete/archive, search — `733e05c7b`
- [x] Hc3 [JS] History `Sheet` from chat header: `session-sheet`/`session-row` + rename dialog + kebab menu + debounced search + load-more; "New"→`newSession` — `97daf2954`
- Deferred: Export (`FIXME(H4)`), Branch (`FIXME(H5)`)

### Track I — Themes / i18n / notifications / haptics

Full i18n (en/ja/zh/zh-hant) + full theme engine. (Landed as sub-steps — commits inline.)

- [x] I1 [PORT] i18n — catalogs + runtime + `<I18nProvider>` + nav/UI literals → `t.*` (all 4 locales, `nav` namespace, `useNavItems()`); `src/i18n/*`, `src/app/settings/{field-copy,constants}.ts`. `9f655a315` `1107ccf2a` `0ca0d98c7`
- [x] I2 [JS] Language switcher — `src/components/language-switcher.tsx` (DropdownMenu over LOCALE_OPTIONS, in sidebar footer). `93f0a075c`
- [x] I3 [PORT] Theme engine — data (`src/themes/{color,types,presets,user-themes}.ts`) + 3-layer token CSS (`--theme-*`→`--ui-*`→`--dt-*` + mobile bridge) in `styles.css` + `ThemeProvider` (global skin+mode) + theme picker & `/skin`. VS Code/marketplace import deferred `FIXME(I3)`. `65c864f9d` `574209fbf` `50481df04` `04691801e`
- [x] I4 [RUST/R9] Haptics — `src/store/haptics.ts` (`tauri-plugin-haptics` + Web Vibration fallback). `de60563e9`
- [x] I5 [PORT/RUST] Notifications — in-app toast stack (`store/notifications.ts` + `NotificationStack`) + native `tauri-plugin-notification` (`store/native-notifications.ts`, backgrounded-gated), dispatched from `handleGatewayEvent`. Device: POST_NOTIFICATIONS manifest. `d5efdd773` `a698786f3`

### Track J — Settings (multi-tab)

Drill-in list → `/settings/:section`, reusing the config data layer + form/list primitives (J1). Deferred
tabs are gated to their tracks; `grep FIXME\(J` = the in-tab deferrals (ElevenLabs voice list, MoA/aux
model, export/import config, embeds/tool-view, completion-sound).

- [x] J1 [PORT] Settings shell + config data layer + form primitives — `constants.ts` (SECTIONS/ENUM_OPTIONS/PROVIDER_GROUPS) + `helpers.ts`/`use-config-record.ts`; `ui/{switch,select,textarea}` + `app/settings/primitives.tsx`; `SettingsIndex`→`SettingsSection` drill-in + reset-to-defaults. `5c1094c3e` `7a88cb11d` `32278abbc`
- [x] J2 [JS] Model — default-model picker + model schema fields (`model-section.tsx`); MoA/aux/onboarding `FIXME(J7)`. `1e2055d25`
- [x] J3 [PORT] Chat — schema `ConfigSection` (`config-section.tsx`: seed draft + 550ms full-record autosave). `c9c083f80`
- [x] J4 [JS] Appearance — shared `ThemeControls` (mode/skin) + language switcher. `de06a1e97`
- [x] J5 [JS] Voice — `ConfigSection` + `voiceFieldVisible`; ElevenLabs list static `FIXME(J5)`. `480ac93b5`
- [x] J6 [PORT] Safety / Advanced / Workspace — schema `ConfigSection`. `c9c083f80`
- [x] J7 [JS] Memory — schema `ConfigSection`; provider OAuth connect deferred `FIXME(D2)`. `e2ec5e5c1`
- [x] J8 [JS] Notifications — native-notif prefs (master + per-kind) + send-test + haptics toggle; completion-sound `FIXME(J9)`. `e94d7ccc5`
- [~] J9 [PORT] Providers — API-keys covered by J11; account OAuth deferred `FIXME(D2)`.
- [-] J10 Gateway modes — deferred to Track E.
- [x] J11 [PORT] Keys / credentials — `keys-section.tsx` env-var list (grouped/search/set/reveal/clear). `35d37fff8`
- [-] J12 Computer-use — omitted (no mobile analog).
- [-] J13 Pet — deferred to K10.
- [x] J14 [JS] About — app version + gateway version + release-notes; self-update/uninstall omitted. `069899755`
- [-] J15 Uninstall — omitted (no mobile analog).
- [x] J16 [JS] Archived chats — `archived-section.tsx` (list + unarchive + permanent delete). `dfba485b4`

### Track K — Feature views (each independent route)

Built as lean drill-in screens reusing the Track-J list primitives. Large items carry `.a/.b` sub-steps.

- [~] K1 [PORT] Profiles / workspaces — Profiles view (list + create/rename/delete + SOUL.md editor, `store/profiles.ts`) `92569b400`; app-wide switching + projects/cwd gated `FIXME(E)`.
- [x] K2 [PORT] Skills + Toolsets + MCP + Hub —
  - [x] K2.a Skills + Toolsets (`/skills` tabbed toggle lists, `store/skills.ts`); computer_use hidden `FIXME(K5)`. `efa47fc5f`
  - [x] K2.b MCP servers — MCP tab (list + enable/test + catalog-install sheet) + `store/mcp.ts` (+test) + `skills.mcp` i18n (4 locales); `reload.mcp` RPC; MCP-OAuth finish-on-desktop `FIXME(K2)`. `f4c414017`
  - [x] K2.c Skills Hub — Hub tab (search/featured + install/uninstall + preview/scan sheet) + `store/hub.ts` (spawn→poll action flow, +test). `3ede80676`
- [x] K3 [PORT] Agents / subagents — `store/subagents.ts` reducer + `subagent.*` wired into `chat.ts` + spawn-tree view. `74334a99a`
- [x] K4 [PORT] Command center — `/command-center` 3-tab dashboard (System: status+logs+restart/update · Usage: analytics · Maintenance: diagnostics/curator/memory-reset) + shared `lib/action-poll.ts` (+test); sessions omitted (History sheet), debug-share `FIXME(K4)`. `0a68e3495`
- [x] K5 [PORT] Cron / routines — `/cron` list + enable/trigger/edit/delete + sheet form (`store/cron.ts`). `6062a429f`
- [x] K6 [PORT] Messaging platforms — `/messaging` list + credential detail sheet + test (`store/messaging.ts`); no OAuth. `328b75ed4`
- [x] K7 [PORT] Artifacts — `/artifacts` scan recent sessions → image grid + file/link tabs (`artifact-utils.ts`, `lib/media.ts`); fan-out capped `FIXME(K4)`. `ecb95dd0b`
- [x] K8 [PORT] Starmap — `/starmap` memory graph: d3-force sim (`graph-sim.ts`, +test) + 2D-canvas render with battery-aware rAF + touch pan/pinch/tap (`starmap-canvas.tsx`) + All/Used/Learned filters + node-detail sheet (`store/starmap.ts`). Ring/recency choreography + share-code + timeline simplified away `FIXME(K8)`. `1e66f8f9d` `4d9866bb4`
- [x] K9 [PORT] Voice / audio — mic dictation (`29aff10c9`) + TTS/auto-speak: `lib/tts.ts` (speakText→`<audio>`) + `store/voice-prefs.ts` (config-backed `auto_tts`, +test), auto-speak on reply-complete + composer toggle. Resolves FIXME(Gc9). `051c5719c`
- [x] K10 [PORT] Pet — in-app on Android; overlay desktop-only [GATE].
  - [x] K10.a Gallery — `/settings/pet` adopt / enable / disable + thumbnails (`store/pet.ts`, `store/pet-gallery.ts` +test, `pet-thumb.tsx`, `pet-section.tsx`); nav entry under Settings. `c896495cd`
  - [x] K10.b In-app sprite — canvas `PetSprite` steps the idle/run row of the active pet's spritesheet across loopMs (`app/pet/pet-sprite.tsx`); shown in the Pet section + a parked `FloatingPet` in chat that runs while a turn streams; `syncPetInfo` on connect. Roam physics / pop-out overlay dropped [GATE]. `9a20ec4c6`
  - [x] K10.c AI generation — `store/pet-generate.ts` (+test): pet.generate streams 4 drafts (pet.generate.progress) → pet.hatch animates one with per-row progress (pet.hatch.progress) → animated preview → adopt/discard; `subscribeGateway` helper + bottom-sheet wizard (`pet-generate-sheet.tsx`) from the Pet section. Cancellation via run-id guard + pet.cancel (no AbortSignal on mobile); reference-image / persisted-provider / background-notify dropped. `ebf7b26b0`
- [x] K11 [PORT] Onboarding — first-run provider-setup wizard (`store/onboarding.ts` + `app/onboarding/`): picker → API-key / provider OAuth (device-code poll + PKCE) / local endpoint → confirm-model, first-run gate in `mobile-controller`, "choose later" skip, Settings re-entry. **Resolves D2 (provider OAuth) + J7 (local endpoint).** External-CLI OAuth + local-runtime boot gated. `289e01307` `7f8c6e9ec` `dd5c3f756`
- [-] K12 Updates — gated (Play Store on Android) [R12].
- [x] K13 [PORT] File browser — remote workspace listing (no local FS on Android): hermes `readDir`/`readFileText`/`getDefaultCwd` (`/api/fs/*`) + `FilesScreen` (breadcrumb + folders-first list) + `FilePreviewSheet` (text/image/binary); `/files` route + nav item + i18n; +test. Local FS tree stays desktop-only [GATE]. `e60607106`
- [x] K14 [PORT] Code review / git — read-only remote diffs (no git binary on Android): hermes `getRepoStatus`/`getFileDiff` (`/api/git/*`) + `ReviewScreen` (branch + changed files) + `DiffSheet` (colored unified diff); `/review` route + nav item + i18n; +test. `66bbc7450`
- [-] K15 Terminal — gated (impractical on Android) [R15].
- [x] K16 [JS] Keybindings (soft-keyboard adapted) — composer ⌘/Ctrl+Enter→send + a read-only Keyboard Shortcuts settings reference (`shortcuts-section.tsx` + `shortcuts` i18n, 4 locales, +test). No configurable keymap (touch-first). `283017dd3`

---

## Execution order

1. Track A · 2. B1/B2 · 3. C1/C2 + C3 core groups (sessions, models, config) · 4. D1/D2 · 5. F ·
2. G1–G4 → **usable milestone** · 7. parallelize D3/D4, E, G5–G10, I, J, K.

---

## Progress summary — session handoff (2026-07-13)

This section is the **rebuild-context-from-scratch** snapshot. Read it first in a fresh session; the ledger
above has the per-step detail, and `grep -rn "FIXME(" apps/hermes-universal/src` is the authoritative
deferral index.

### Current state
- **Branch:** `port/hermes-mobile/1` · **HEAD:** `f23e1c0af` · **83 commits ahead of `origin/main`**, all
  confined to the app folder. Remotes: `origin` = jaxmatrix/mjx-hermes-agent (fork), `upstream` = NousResearch.
- **The app folder is now `apps/hermes-universal`** (renamed from `apps/mobile` — see "Rename" below). Run all
  tooling as `pnpm -C apps/hermes-universal <typecheck|test|build>`. Latest: **230 tests green**, typecheck +
  Vite build clean. (Rust/Android build is device-side, verified manually.)
- **The name "mobile" is a misnomer.** This is a *universal* Tauri client (desktop + Android + iOS from one
  codebase, meant to eventually supersede the Electron `apps/desktop`). Much of the ledger and some code still
  say "mobile"; treat that as historical. Some feature/scope decisions were made under a mobile-only
  assumption and should be revisited (see "Deferred: de-mobile pass").

### Track roll-up
- **Done (essentially complete):** A (foundation), C (REST client), F (nav/shell), G (chat rendering — a few
  polish FIXMEs open), H (sessions — export/branch deferred), I (themes/i18n/notify/haptics), J (settings —
  J9 provider-OAuth partial), and **K (feature views) — all landed**, including **K10 Pet (a: gallery ·
  b: animated in-app sprite · c: AI generation draft→hatch→adopt)** and K11 onboarding wizard (resolved D2
  provider-OAuth + J7 local endpoint).
- **Largest remaining greenfield (both Rust-heavy):**
  - **Track D3–D6** — connection-level OAuth to the gateway via a `hermes://` deep-link
    (`tauri-plugin-deep-link`, `oauth.rs`, `hermes://` intent-filter). Explicitly deferred to its own session.
    Note: **D2** (per-provider OAuth via device-code / PKCE) is already **done** via K11 — D3–D6 is the
    separate "sign in to the gateway itself" half.
  - **Track E1–E5** — gateway-mode switch + cloud-agent discovery (`portal_*`) + local-backend spawn. Mostly
    Rust; local-backend is Android-unsupported (gated).
- **Gated / dropped for this platform:** K12 updates (Play Store), K15 terminal (impractical on Android),
  E3 local backend on Android, D local-runtime boot.

### Open FIXME shortlist (polish/parity deferrals)
G4 (rich `buildToolView`: inline diffs/ansi/search/images) · G7 (inline images / rich unfurl) · H4 (session
export — needs save/share transport) · H5 (branch tree UI) · J5 (ElevenLabs voice list is free-text, no
fetch) · plus assorted K4/K5/K8 polish. Some FIXMEs are stale (e.g. `FIXME(D2)`, `FIXME(Gc9)` were resolved
by K11/K9) — trust the grep, not old inline notes.

### Rename + de-mobile (this session)
`apps/mobile` → **`apps/hermes-universal`** via a forward `git mv` (history preserved; use `git log --follow`).
Build identity updated to match: npm package `@hermes/universal`, Rust crate `hermes-universal` / lib
`hermes_universal_lib`, Tauri identifier **`com.nousresearch.hermes.universal`**, user-agent `hermes-universal/`.
`PORT.md` was un-gitignored and committed. The `apps/*` workspace glob auto-discovers the new folder; no
cross-package imports needed updating.
**Runtime storage keys de-mobiled too:** `hermes.mobile.*` `persistentAtom` keys
(connection/composer/haptics/onboarding/i18n/notifications/themes) → `hermes.*`; keyring `SERVICE`
`hermes-mobile` → `hermes`; `user-themes` key → `hermes-user-themes-v1`. This orphans any prior on-device dev
data (re-login / re-pick theme once) — acceptable pre-release. Legacy Electron desktop uses `hermes.desktop.*`,
so no collision.

### Deferred: de-mobile pass (next session)
- **Regenerate `src-tauri/gen/android`** (`tauri android init`) so the Android package + `System.loadLibrary`
  pick up the new identifier (`com.nousresearch.hermes.universal`) and lib name (`hermes_universal_lib`).
  `gen/` is gitignored — device-side, user-run.
- **Review mobile-only assumptions** in scope/architecture (the reason for the fresh session): features that
  were gated, simplified, or shaped as "mobile-only" that should be reconsidered now that desktop is also a
  target of this same app.

---

## Pending work, patches & lean-implementation notes — full audit (2026-07-13)

> **Appended review — nothing above this line was changed.** A top-to-bottom audit of the universal app:
> what "lean" means here, and every Tauri/native, web, and cross-cutting item that is incomplete, deferred,
> or a deliberate patch that may need revisiting. The live deferral index remains
> `grep -rn "FIXME(" apps/hermes-universal/src`. Every claim below traces to a file:line in the tree.

**Current commit state** (fresh note; does not edit the stale HEAD in the handoff above): on `main`, sequence
`7b63393c5` rename → `acdc500e0` de-mobile storage keys → `1d697e72a` lib.rs strings → `e6ccfd47b` merge
upstream/main → `0479d21e8` keyring/Android fix. Local-only beyond `origin/main`'s PR #2 merge; unpushed.

### 0. Lean implementation — what "lean" means here

This is a **mobile-first, remote-only** port. Where the desktop feature was large or desktop-shaped, we built
a deliberately smaller version that covers the common path and **tracked the parity gap as a `FIXME(<track>)`**
rather than porting the whole thing. These are **intentional scope cuts, not bugs**. Confirmed lean modules:

- **Tool-call rendering** — `components/assistant-ui/thread/tool-part.tsx`: humanized title + status dot +
  collapsible `<pre>` + raw JSON args. No inline file diffs / ANSI colors / search-hit grouping / image
  results vs desktop `buildToolView` (`FIXME(G4)`).
- **Starmap** — `app/starmap/{starmap-canvas.tsx,graph-sim.ts}`: plain d3-force 2D canvas with pan/pinch/tap.
  Desktop's ring/recency choreography, share-code, timeline dropped (`FIXME(K8)`).
- **Pet** — `app/pet/{pet-sprite.tsx,floating-pet.tsx}` + `store/pet-generate.ts`: idle/run sprite only; roam
  physics + pop-out overlay dropped; single-variation generation flow.
- **Streaming reducer** — `store/chat.ts:17`: no cross-channel coalescing vs desktop `appendStreamPart`
  (`FIXME(G)`).
- **Others:** notifications toast stack (`components/notifications.tsx:12`, dual-placement dropped), Command
  Center (sessions tab omitted), composer completions (`Gc7`), cron store (optimistic), session-history
  hydration (`lib/session-history.ts`), language switcher (no cmdk), media resolver (remote-only,
  `lib/media.ts`), and **single-profile** throughout.
- Also vendored (copied, not imported): the gateway client under `src/gateway/*` (see §3).

### 1. Tauri / native (Rust) — pending & patched

**Implemented:** plugins `os` / `keyring` (vendored) / `opener` / `haptics` / `dialog`+`fs` (read-only) /
`notification`, plus the custom `src-tauri/src/transport.rs` HTTP+WS IPC proxy (reqwest+rustls, in-memory
cookie jar, manual WS ping/pong keepalive). CSP restricts the webview to `ipc:` only.

**Missing / deferred native features** (no Rust source exists for these yet):
- **Deep-link `hermes://` (D3)** — no `tauri-plugin-deep-link`, no intent-filter in the manifest.
- **Gateway OAuth `oauth.rs` (D4)** — unbuilt; the transport cookie jar is the only pre-wiring. (Per-provider
  OAuth **D2 is done** in JS via K11 — this is the separate "sign in to the gateway" half.)
- **`local_backend.rs` (E3, gated)**, **`cloud.rs` portal (E4)**, **updater (K12, gated)**, **terminal (K15,
  gated)**, **biometric** (dropped when we left `tauri-plugin-keystore`; `FIXME(D)` to re-add via
  `tauri-plugin-biometric`), **push notifications**, **background tasks**.
- **Cookie persistence across launches (R2b)** — the reqwest jar is in-memory only, so the gateway login
  session is lost on app restart.

**Patches that may backfire:**
- **Vendored keyring plugin** (`src-tauri/plugins/tauri-plugin-keyring/`, path dep): a git-branch-tip snapshot
  of `charlesportwoodii/tauri-plugin-keyring @ b0a137b`, **no upstream LICENSE**, with `tauri-specta`/`specta`
  manually stripped (specta `2.0.0-rc.25` uses nightly-only `fmt::from_fn`). Depends on six ~`1.0.0`
  keyring-core store crates on caret ranges; `KeyringPlugin.kt` is an empty bridge (storage is Rust via
  `keyring-core`) that assumes Tauri initialized `ndk_context` globally. Any bump requires re-vetting the
  whole tree + re-stripping specta + re-confirming license.
- **`gen/android` is gitignored** → the Android app's identifier, `minSdk=24`, `AndroidManifest` permissions
  (**`RECORD_AUDIO` for voice and `POST_NOTIFICATIONS`, added only on-device, are in NO committed file**),
  signing config, and plugin Gradle wiring are ephemeral — regenerated/overwritten by `tauri android init`
  and invisible to review.

**Verification gaps:** Android verified by `cargo check --target aarch64-linux-android` only — **never a full
APK / device run**. **iOS is never built** (no `gen/apple`). The NDK cross-compile is a hand-run env, not
automated.

### 2. Web application (React/TS) — pending & simplified

**FIXME index by track** (authoritative via `grep -rn "FIXME(" src`):
- **G4** `tool-part.tsx:12` (rich tool views) · **G7** `markdown-text.tsx:15` (media/image embeds) ·
  **G** `chat.ts:19,298` + `runtime.tsx:35` (lean reducer, `onNew` no-op).
- **Gc7** `composer-completions.ts:7` · **Gc8** `attachments.ts:10` (base64 blocks main thread; Android SAF) ·
  **Gc9** `use-voice-recorder.ts:9,11` (RECORD_AUDIO; auto-speak — *this one is stale/resolved*).
- **H** `session-history.ts:10` (context-marker strip) + `session.ts:38` (no true offset pagination).
- **E** `api.ts:16` + `profiles.ts:8` + `mobile-controller.tsx:76` (single-profile; switching gated).
- **D** `secure-store.ts:16` (silent; biometric later) · **D2** `settings-section.tsx:39` (*stale — resolved
  via K11*).
- **J** `settings-index.tsx:25` (config export/import) + `settings-section.tsx:78` (default placeholder) ·
  **J5** `settings-section.tsx:34` (ElevenLabs static) · **J7** `model-section.tsx:20` (MoA/local endpoint) ·
  **J8** `appearance-section.tsx:10` · **J9** `notifications-section.tsx:20` (completion sound).
- **K2** `mcp-catalog-sheet.tsx:13` (MCP OAuth) · **K4** `maintenance-panel.tsx:95` (debug-share),
  `artifacts-screen.tsx:15` (paginate), `media.ts:8` (cookie/ticket media) · **K5** `skills-screen.tsx:31`
  (computer_use hidden) · **K8** `starmap-canvas.tsx:9` · **K11** `api-key-options.ts:53` (CLI providers) ·
  **I3** `user-themes.ts:9` (theme import dropped).
- **Stale FIXMEs to ignore** (resolved but comment not removed): `FIXME(D2)` (K11) and the `FIXME(Gc9)`
  auto-speak line.

**Deferred / gated UI:** command palette (F5 — `app/command-palette/` was **never created**), session export
(H4), branch tree (H5), ElevenLabs voice list (J5, free-text), gateway-mode picker + profile switching (E),
theme marketplace/import (I3), `computer_use` toolset (K5), MCP OAuth (K2), debug-share (K4).

**Secure-store scope gap:** `lib/secure-store.ts` `safe()` short-circuits `if (!IS_MOBILE) return fallback`, so
`saveSecrets`/`loadSecrets`/`clearSecrets` are **no-ops on desktop** — desktop secrets are never persisted even
though the app now targets desktop. (The `invoke('plugin:keyring|…')` JS layer is hand-vendored, stringly-typed
against the vendored Rust `commands.rs`, no type-checked binding.)

**Tests:** 53 `*.test.ts(x)` files, **store-unit-heavy**, **no e2e/integration**. Key untested UI: the chat
thread / composer / runtime / approval-clarify-sudo-secret bars, `starmap-canvas`, pet rendering,
`markdown-text`, `onboarding-screen`, `connect-screen`, and `mobile-controller` routing.

**Dead code:** `app/shell/placeholder-view.tsx` (`PlaceholderView`) is defined but never imported — every route
now maps to a real screen. **Good news (not gaps):** mermaid is actually wired (`@streamdown/mermaid`, done);
sudo/secret/clarify are **fully wired** (real responders in `store/chat.ts`, not stubs); i18n's 4 locales stay
TS-type-synced with **no** placeholder/untranslated strings.

### 3. Build / infra / cross-cutting — patches that may backfire

- **npm-vs-pnpm split.** Root is npm-workspaces (`package.json:6` `apps/*`) but the app is pnpm-managed
  (`pnpm-lock.yaml`, no per-app `package-lock.json`). A root `npm install` descends in and clobbers the app's
  `node_modules/.bin` (tsc/vitest vanish) → recover with `rm -rf node_modules && pnpm install`. The root
  `package-lock.json` was **hand-edited** during the rename (a manual patch to a generated file).
- **App absent from CI.** `.github/workflows/typecheck.yml` matrix is `[ui-tui, web, apps/bootstrap-installer,
  apps/desktop, apps/shared]` — **not** `apps/hermes-universal`. No CI gate for its typecheck / vitest /
  `vite build` / Cargo / Android build; all green signals are local only. (CI also installs via `npm ci`,
  which the pnpm split would break anyway.)
- **Vendored gateway has already drifted.** `src/gateway/json-rpc-gateway.ts` is a hand-copy of
  `apps/shared/src` and is now **missing the `profile?: string` field** that the upstream merge `e6ccfd47b`
  added to `apps/shared`. The header's "keep in sync" instruction has lapsed; upstream gateway fixes
  (deterministic WS close, dedup, profile tagging) do not propagate.
- **`gen/android` not version-controlled** (see §1) — no committed source describes the Android
  manifest/permissions/signing; lost on regen.
- **2.2 MB monolithic JS bundle.** `vite.config.ts` sets no `manualChunks` / `chunkSizeWarningLimit`; the
  single `index-*.js` is ~2.2 MB (plus 600–780 KB syntax-grammar chunks from streamdown) — the Android
  WebView cold-start payload.
- **Minor:** 4 `eslint-disable react-hooks/exhaustive-deps` (`config-section.tsx:243`,
  `archived-section.tsx:48`, `keys-section.tsx:60`, `files-screen.tsx:48`) with no CI lint gate; toolchain
  pinned to very new majors (TS 6 / Vite 8 / Vitest 4) ahead of the rest of the monorepo, reproducible only
  via the app's `pnpm-lock.yaml` that no CI installs.

### 4. "Might backfire" priority hotlist

1. **Keyring vendoring** — no license (legal), git-branch-tip source, ~days-old `1.0` RC-era supply chain, a
   local de-specta patch to re-apply on every bump. Highest blast radius if it needs updating.
2. **`gen/android` unversioned** — manifest, runtime permissions (RECORD_AUDIO / POST_NOTIFICATIONS), and
   signing exist only on one machine and are silently lost on `tauri android init`.
3. **Vendored-gateway drift** — already diverged from `apps/shared`; future upstream gateway fixes won't reach
   the app, and no test catches it.
4. **No CI** — every regression (TS, test, build, Cargo, Android) surfaces only on a developer's machine.
5. **npm/pnpm split** — a stray root `npm install` breaks the app's toolchain until a manual pnpm reinstall.
