# Batch 1 — entry / platform

Review agents: main.tsx, platform.ts, pointer-drag.ts.  
Policy: merge plans only (not applied in this pass).

---

## Merge plan: `main.tsx`

1. **Path**
`src/main.tsx` ← merge from `sync/incoming/main.tsx`  
(Wholesale replace of `src`: **no**)

2. **Why protected**
Entry carries persisted-tab migration, `hermesDesktop` bridge install, and `bootUniversal()` — desktop has no place for these (`sync/protected.txt`).

3. **Desktop-only deltas to take**
**None.** Diff is only universal additions; shared body already matches incoming:
- Side-effect store imports (`active-work`, `power`, `translucency`, `user-bubble-transparency`)
- `@/debug/dev-only` before `react-dom`
- `installClipboardShim` / `installSelectionCopyColorGuard` / perf-probe gate
- `?win=` transparent-window style + overlay/quick/wake/intro roots
- Main-window tree: `installRendererAnimationPauseState` + provider stack + `HashRouter useTransitions={false}`

4. **Universal-only to keep**
- `./store/persisted-tiles-migration` **first**, then `./lib/hermes-desktop/install` **second**, then `./styles.css`
- `import { bootUniversal } from './boot'`
- `bootUniversal()` before `installClipboardShim()`

5. **Conflict spots**
| Region | Incoming | Universal | Resolution |
|---|---|---|---|
| File head (imports) | Starts at `styles.css` | Migration + bridge precede CSS | **Keep universal prefix** |
| Named imports / early body | No `boot` | `bootUniversal` import + call | **Keep universal** |

6. **Apply steps**
1. Do **not** copy incoming wholesale.
2. Leave `src/main.tsx` as-is if still equal to current (only universal seams vs incoming).
3. If re-absorbing later: paste incoming, then re-insert the three seams in order (migration → bridge → … → `bootUniversal()` before clipboard).
4. Do not reorder migration/bridge relative to `styles.css` or `active-work`.

7. **Smoke**
```bash
npm test -- src/lib/hermes-desktop/install.test.ts src/entry-graph.test.ts src/boot.test.ts src/store/persisted-tiles-migration.test.ts
```

---

## Merge plan: `lib/platform.ts`

1. **Path**
`src/lib/platform.ts` ← `sync/incoming/lib/platform.ts`  
(Wholesale replace: **no**)

2. **Why protected**
Universal asks Tauri which OS it is on and handles the iOS webview boot race; desktop only sniffs `navigator` and has no mobile notions — desktop’s three host-OS predicates are already folded at the bottom (`sync/protected.txt`).

3. **Desktop-only deltas to take**
- **None for code.** Incoming is only the Electron-renderer header plus three navigator sniffers. Universal already carries the same contracts with Tauri-first + UA fallback (`isMacPlatform` / `isWindowsPlatform` / `isLinuxPlatform`).
- **Do not take** the Electron header (`process.platform` / glass framing).

4. **Universal-only to keep**
- Tauri `platform()` + throw guard → `'unknown'`
- Mobile sniff: `detectMobileDevice`, `IS_MOBILE` / `IS_TAURI` / etc.
- Hybrid host-OS predicates: `IS_TAURI ? PLATFORM… : uaMatches(…)`

5. **Conflict spots**
- Wholesale replace would delete Tauri/mobile gating.
- Predicate shape: incoming = always UA; src = Tauri first — prefer src.

6. **Apply steps**
1. Do **not** replace with incoming.
2. Confirm regexes still match (they do today).
3. Future desktop sniffer tweaks: fold into `!IS_TAURI` / `uaMatches` arms only.
4. Mark MERGE as **already absorbed / no edit** unless a real incoming delta appears.

7. **Smoke**
```bash
npm test -- src/lib/platform.test.ts
```

---

## Merge plan: `lib/pointer-drag.ts`

1. **Path**
`src/lib/pointer-drag.ts` ↔ `sync/incoming/lib/pointer-drag.ts`  
(Wholesale replace: **no**)

2. **Why protected**
Desktop primitive plus `pointercancel` so touch mid-gesture does not leak listeners (`sync/protected.txt`).

3. **Desktop-only deltas to take**
None. Incoming is a strict subset of universal (same `startPointerDrag` contract; no new API).

4. **Universal-only to keep**
- `pointercancel` bind and docstring
- Shared `stop()` teardown unbinding move/up/cancel
- `return stop` cleanup contract

5. **Conflict spots**
- Listener set: incoming move+up only vs src move+up+cancel — keep src.
- Teardown: keep shared `stop()` path.

6. **Apply steps**
1. Do **not** wholesale replace.
2. Leave `src/lib/pointer-drag.ts` as-is for this absorb.
3. Later desktop changes: port only additive API that does not drop `pointercancel`.

7. **Smoke**
- Touch drag interrupted by `pointercancel`: `onEnd` once; no leftover listeners.
- `npm test -- src/lib/pointer-drag.test.ts`
