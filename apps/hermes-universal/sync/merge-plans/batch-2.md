# Batch 2 — gestures / SDK / hermes

Review agents: trackpad-gestures.ts, sdk/runtime.ts, hermes.ts.  
Policy: merge plans only (not applied in this pass).

---

## Merge plan: `lib/trackpad-gestures.ts`

1. **Path**
`src/lib/trackpad-gestures.ts` ← `sync/incoming/lib/trackpad-gestures.ts`  
(Wholesale replace: **no**)

2. **Why protected**
`sync/protected.txt` lists `lib/trackpad-gestures.*`. Universal owns the mobile/touch gesture layer (`createPinchTracker`) that desktop does not ship.

3. **Desktop-only deltas to take**
None. Shared wheel helpers and `createDoubleTapDetector` already match; no new APIs in incoming.

4. **Universal-only to keep**
- Header: `Chromium/WebKit` (not Electron)
- `PinchPoint`, `PinchFrame`, `PinchTracker`, `createPinchTracker()`

5. **Conflict spots**
- Header Electron vs WebKit — keep src
- Mid-file pinch-tracker block — do not delete

6. **Apply steps**
1. Leave src as-is (noop merge).
2. Do not copy incoming over src.
3. Future desktop wheel/double-tap-only changes: cherry-pick into src; leave pinch section untouched.

7. **Smoke**
- Exports resolve; two-finger pinch still works; ctrl-wheel classification unchanged.

---

## Merge plan: `sdk/runtime.ts`

1. **Path**
`src/sdk/runtime.ts` ← `sync/incoming/sdk/runtime.ts`  
(Wholesale replace: **no**)

2. **Why protected**
`@hermes/plugin-sdk` resolves to universal-only `sdk/universal.ts`; runtime shim must import that module (`sync/protected.txt`).

3. **Desktop-only deltas to take**
None in this revision aside from possible future shim logic. Body matches except import target.

4. **Universal-only to keep**
- `import * as sdk from './universal'` (not `./index`) + explaining comment

5. **Conflict spots**
| Spot | Incoming | Protected |
|------|----------|-----------|
| SDK import | `from './index'` | `from './universal'` |

6. **Apply steps**
1. Leave src as base; do not copy incoming over it.
2. Future desktop shim changes: fold hunks while keeping `from './universal'`.

7. **Smoke**
- `installPluginSdk()` / `sdkImportMap()` resolve `@hermes/plugin-sdk` → universal namespace.
- Runtime-loaded plugin sees universal-only exports.

---

## Merge plan: `hermes.ts`

1. **Path**
`src/hermes.ts` ← `sync/incoming/hermes.ts`  
(Wholesale replace: **no** — critical)

2. **Why protected**
Public `@/hermes` barrel: universal must not re-export browser-`WebSocket` `HermesGateway` from `./api/client`; local class uses Rust `openGatewaySocket` + profile scoping; `export * from './api/universal'` required.

3. **Desktop-only deltas to take**
| Delta | Action |
| --- | --- |
| Header / named client exports **except** `HermesGateway` | Take any **new** named exports desktop adds |
| `export * from './api/<domain>'` | Take new domain barrels |
| Type export list from `@/types/hermes` | Add/remove names from incoming into desktop block |
| Gateway constructor options on desktop client | Mirror into **local** `HermesGateway` class (callbacks), keep `socketFactory: openGatewaySocket` |

**Do not take:** `HermesGateway` in the `./api/client` named export list.

4. **Universal-only to keep**
- Imports: `JsonRpcGatewayClient`, `profileScoped`/`socketProfile`, `openGatewaySocket`
- `export * from './api/universal'`
- Local `export class HermesGateway` with profile overrides + `lastCloseCode`
- Layout: desktop block first; universal appendages at bottom

5. **Conflict spots**
| Spot | Rule |
| --- | --- |
| `HermesGateway` export | Keep universal class; never client re-export |
| Transport | Rust socket wins |
| `./api/universal` | Required append |

6. **Apply steps**
1. Diff; expect missing client `HermesGateway` re-export + universal bottom block.
2. Copy new desktop barrel lines into desktop block only.
3. Never add `HermesGateway` to client export list.
4. Optionally sync constructor options into local class.
5. Do not replace file with incoming.

7. **Smoke**
- `@/hermes` exports gateway + universal symbols.
- `new HermesGateway()` uses Rust factory; profile-stamped RPC.
- Grep: no `HermesGateway` from `./api/client` in `src/hermes.ts`.
- Targeted vitest: `transport/gateway-socket`, gateway/connection stores.
