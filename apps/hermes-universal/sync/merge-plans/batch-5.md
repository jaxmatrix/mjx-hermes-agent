# Batch 5 — artifacts test + connections

Review agents: artifacts.test.ts, connections.ts, connections.test.ts.  
Policy: merge plans only (not applied in this pass).

---

## Merge plan: `store/artifacts.test.ts`

1. **Path**
`src/store/artifacts.test.ts` ← incoming  
(Wholesale replace: **no**)

2. **Why protected**
Sibling of Tauri-aware `artifacts.ts` (staging, pin, connection drop).

3. **Desktop-only deltas to take**
- Persistence case: `openArtifact` → `localStorage.getItem('hermes.desktop.previewTabs.v2')` is `null`
- Optional: `versionAdded === true` beside dual-content assert

4. **Universal-only to keep**
Tauri mock; three describes; full tab shape with `source`; cap/pin/clamp; unknown id / file isolation.

5. **Conflict spots**
Weaker desktop `toMatchObject` vs full universal tab assert — keep universal.

6. **Apply steps**
Leave base; add persistence case under preview tabs; do not weaken asserts or drop Tauri mock.

7. **Smoke**
```bash
npx vitest run src/store/artifacts.test.ts
```

---

## Merge plan: `store/connections.ts`

1. **Path**
`src/store/connections.ts` ← incoming  
(Wholesale replace: **no** — critical)

2. **Why protected**
Rust owns document/credentials/probe/source commit; tunnels; MJXHRM-591/592. Electron thin registry+switcher is incompatible.

3. **Desktop-only deltas to take** (behavior, not Electron IPC)
- Bounded awaits on switch (`withTimeout` budgets; clear pending on hang)
- Fail-open if target already published after commit timeout
- Failed-commit recover after wipe-without-land
- `$activeConnectionId.listen` → `invalidateProfileScopedQueries` (avoid double storms)
- OAuth remote prove-before-wipe intent (use Tauri/auth stack, not Electron `getProfiles`)
- Swallow last-used errors; comments/issue ids

**Do not take:** `hermesDesktop.connections`, `openGatewayAgent`/`ensureGatewayAgent`, `beginGatewaySwitch` inside select, Electron `initializeConnectionsRegistry` restore, desktop last-profile key.

4. **Universal-only to keep**
Full Rust CRUD/probe/roster; `$registryView` + projection; tunnels; `applySource`/`commitSource`/watcher; `restoreLaunchConnection`; connect-form helpers; universal last-profile key.

5. **Conflict spots**
File role; select control flow; init = refresh only; soft-switch via `emitConnectionApplied`.

6. **Apply steps**
Cherry-pick timeouts/invalidate/recover into src; leave init/restore/CRUD/tunnels; run connections + bridge + windows tests.

7. **Smoke**
Multi-source switch; hung preflight clears spinner; SSH interactive; cloud OAuth; cross-window announce; settings CRUD; switcher without Electron bridge.

---

## Merge plan: `store/connections.test.ts`

1. **Path**
Incoming vs `src/store/connections.test.ts`  
(Wholesale replace: **no**)

2. **Why protected**
Tauri invoke/listen harness for Rust registry — not Electron gateway-switch.

3. **Desktop-only deltas to take**
None as pasted suites. Optional later re-author: stuck list timeout, boot vs mid-select race, OAuth prove, late-publish guard — against universal helpers only.

4. **Universal-only to keep**
Entire src file (projection, restoreLaunch, select order, tunnels, applySource, watcher, last-profile, saveTunnelAnswer).

5. **Conflict spots**
Host API, switch model, boot path, profile memory key, session wipe mocks.

6. **Apply steps**
Leave src; never introduce `hermesDesktop` / `beginGatewaySwitch` / desktop last-profile key.

7. **Smoke**
```bash
npx vitest run src/store/connections.test.ts
```
