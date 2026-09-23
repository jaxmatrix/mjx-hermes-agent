# Batch 3 — preview / global / styles

Review agents: preview.tsx, global.ts, styles.css.  
Policy: merge plans only (not applied in this pass).

---

## Merge plan: `app/chat/right-rail/preview.tsx`

1. **Path**
`src/app/chat/right-rail/preview.tsx` ← `sync/incoming/app/chat/right-rail/preview.tsx`  
(Wholesale replace: **no**)

2. **Why protected**
Url tabs must render Tauri `BrowserPane` (Rust guest), not Electron `<webview>` `PreviewPane` (`sync/protected.txt`).

3. **Desktop-only deltas to take**
None today. Shared non-url body already matches. Future non-url prop/atom changes: port below the url guard.

4. **Universal-only to keep**
- `BrowserPane` + `$browserGuestTabId`
- UNIVERSAL'S ONE DELTA docstring
- Url branch: focused guest vs `null`; non-url → `PreviewPane`

5. **Conflict spots**
Url always `PreviewPane` (incoming) vs guest branch (src) — keep src.

6. **Apply steps**
1. Leave src as base; do not copy incoming over it.
2. Port future shared deltas only under the url guard.
3. Keep `preview.test.tsx` aligned (protected sibling).

7. **Smoke**
Focused url → BrowserPane; unfocused url → null; artifact/html → PreviewPane.

---

## Merge plan: `global.ts`

1. **Path**
`src/global.ts` ← `sync/incoming/global.ts`  
(Wholesale replace: **no**)

2. **Why protected**
`global.ts` in `sync/protected.txt` — universal host Window / `hermesDesktop` typing.

3. **Desktop-only deltas to take**
- Imports: `ScreenshotApi`, `HudModifierApi` from `electron/*-types`
- New members: `windowControls`, `screenshot`, `hudModifier`, `minimizeToTray`, `removeDesktopPlugin`, `onPoolBackendRetiring`, `profile.getDefault`/`setDefault`/`onDefaultChanged`, export `DesktopProfileRoute`
- Widen: `touchBackend` options, `openWindow(options?)`, `mcpOauth.wait.iss`, connection/window `customWindowControls`/`isMaximized`, `HermesApiRequest.priority`
- Drop: `git.review.fetchPrComment` + `HermesPrComment` (desktop removed)

4. **Universal-only to keep**
- File as protected typing root; single `hermesDesktop` Window augmentation

5. **Conflict spots**
Additive takes on signatures; drop dead git review comment API with desktop.

6. **Apply steps**
1. Keep src; patch members in place from §3.
2. Add `DesktopProfileRoute` export.
3. Remove `fetchPrComment` / `HermesPrComment`.
4. Types may land ahead of Rust (preload-drift NOT_YET).

7. **Smoke**
Typecheck call sites; vitest default-profile / window-controls / mcp-oauth; preload-drift still green.

---

## Merge plan: `styles.css`

1. **Path**
`src/styles.css` ← fold from `sync/incoming/styles.css`  
(Wholesale replace: **no**)

2. **Why protected**
Mobile/WebKit/safe-area/HUD contracts (`styles.css` + contract tests in `protected.txt`).

3. **Desktop-only deltas to take**
- Additive variants: `hover`, `compact`; reduced-motion / animations-paused / titlebar cluster
- New `:root` tokens (memory legendary, diff, primary-solid, etc.) — append
- Glass / chat / transcript / scrollbar fade / onboarding / Bot Mode hunks by selector
- Composer dock/popout/glow only where slots exist — do not replace mobile `--composer-dock-inset-bottom`
- Fonts: keep universal local kit; add JetBrains only if files exist under `src/fonts`

4. **Universal-only to keep**
- `coarse`/`fine`/`keyboard-open` variants; vendored fonts
- `--safe-area-inset-*`, touch targets, `--composer-dock-inset-bottom`
- `html.is-mobile:not([data-hud]) #root` visual-viewport pin
- `html[data-hud]` HUD (not desktop `[data-hud-shell]`)
- Connect safe-area; WebKitGTK scrollbar guard; local shimmer until tw-shimmer adopted

5. **Conflict spots**
Header variants (union); composer dock vs keyboard inset; HUD DOM contracts; scrollbar global vs scoped.

6. **Apply steps**
1. Base = src; donor = incoming.
2. Union variants; append tokens; cherry-pick by selector.
3. Leave mobile + connect + `html[data-hud]` intact.
4. Run contract tests; do not weaken them.

7. **Smoke**
```bash
npm test -- src/styles.mobile-viewport.test.ts src/styles.safe-area-vars.test.ts src/styles.connect-safe-area.test.ts src/styles.hud-contract.test.ts
```
Manual: keyboard open on phone; connect safe-area; HUD band.
