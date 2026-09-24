# Batch 4 — windows + artifacts

Review agents: windows.ts, windows.test.ts, artifacts.ts.  
Policy: merge plans only (not applied in this pass).

---

## Merge plan: `store/windows.ts`

1. **Path**
`src/store/windows.ts` ← `sync/incoming/store/windows.ts`  
(Wholesale replace: **no**)

2. **Why protected**
Window kinds are a Rust contract (`open_*_window`, satellites, tiles, screens). Electron `hermesDesktop` openers must not replace that host.

3. **Desktop-only deltas to take** (behavior/API shape; re-implement on Tauri when ready)
- `isProfilePinnedWindow` / `?profileWindow=1`, `windowConnectionOverride` / `?connectionId=`
- Profile resolution ladder on session pop-out (pass `profile` into opener when Rust accepts it)
- `openNewWindow(route?)` when peer seeding lands
- Peer/browser URL contracts when builders emit them
- Comments/issue refs (rewrite Electron → Tauri)

**Do not take:** predicate caches; `canOpen*` gated only on `hermesDesktop`; wholesale `runWindowOpen` expecting `{ok,error}` for session/instance.

4. **Universal-only to keep**
INIT ORDER (no caches); tile model; activity screens; `multiWindowSupported`; `invoke` session/instance opens + draft flush; full satellite stack; Tauri imports.

5. **Conflict spots**
`isSecondaryWindow` / HUD / canOpen gates / open paths — keep universal; graft profile/route when Rust ready.

6. **Apply steps**
1. Diff exports; add desktop symbols only as stubs or behind Rust support.
2. Wire profile/peer into URL builders when ready; keep flush + `notePopoutSession`.
3. Never replace file, reintroduce caches, or swap opens to `hermesDesktop`.

7. **Smoke**
Session pop-out / new window / tile / HUD / Android activity / iOS multi-window gate; browser/terminal affordances without crash.

---

## Merge plan: `store/windows.test.ts`

1. **Path**
Incoming vs `src/store/windows.test.ts`  
(Wholesale replace: **no**)

2. **Why protected**
Sibling of `windows.ts` — Tauri invoke harness, not Electron bridge.

3. **Desktop-only deltas to take**
- `isPeerInstanceWindow` pure-query describe
- Profile-stamped session pop-out (#82768) if impl supports `profile` arg
- Browser/notify cases via `windows-kind.test.ts` or thin bridge-shaped block — translate to `calls`/`invoke`, not `hermesDesktop`

4. **Universal-only to keep**
Ordered `calls` + Tauri mocks; dynamic import; iOS probe; flush-before-build suite; `addressesThisWindow`; `resizeSatelliteWindow`.

5. **Conflict spots**
Harness style; flush vs profile; peer vs profile-pinned (drop latter if symbol absent).

6. **Apply steps**
Keep protected base; append peer (+ optional profile) cases; never merge `installBridge`.

7. **Smoke**
```bash
npm test -- src/store/windows.test.ts src/store/windows-kind.test.ts
```

---

## Merge plan: `store/artifacts.ts`

1. **Path**
`src/store/artifacts.ts` ← incoming  
(Wholesale replace: **no**)

2. **Why protected**
`store/artifacts.*` — Tauri staging, `@/store/atom`, connection-scoped keys.

3. **Desktop-only deltas to take**
None. Incoming is a subset.

4. **Universal-only to keep**
`invoke` staging/release; `shiftVersionPin`; `dropArtifactsForConnection`; `@/store/atom`.

5. **Conflict spots**
None requiring fold — keep universal.

6. **Apply steps**
No-op leave as-is; future shared helper edits only with Universal APIs preserved.

7. **Smoke**
Artifact pin/trim/connection-drop tests; restage hash stability.
