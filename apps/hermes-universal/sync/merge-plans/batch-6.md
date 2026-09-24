# Batch 6 — connection-request

Review agents: connection-request.ts, connection-request.test.ts.  
Policy: merge plans only (not applied in this pass).

---

## Merge plan: `store/connection-request.ts`

1. **Path**
Incoming: `sync/incoming/store/connection-request.ts`  
Protected src: `src/store/connection-request.ts` (**absent** — call sites already import `@/store/connection-request`)

2. **Why protected**
`store/connection-*.*` glob — session connector/MCP/plugin/skill op cards (`connection.request` / respond / update), not roster/tunnel state.

3. **Desktop-only deltas to take**
Full module (add-only): types/parsers, `$connectionRequests` cache ops, respond path (`connectionOwnerFor`, skip/continue/respond), companion test.

4. **Universal-only to keep**
Other connection-layer files untouched. Existing call-site wiring stays.

5. **Conflict spots**
Glob vs semantics: absorb as new sibling, do not fold into `connections.ts` / `connection.ts` / `connection-updates.ts`.  
`connectionOwnerFor` must use universal gateway/session-owner seams.

6. **Apply steps**
1. **Copy incoming → `src/store/connection-request.ts`** (add-only wholesale for this path is justified — src missing).
2. Copy test; adjust helpers only if gateway/session test APIs differ.
3. Do not rewrite roster/tunnel modules.
4. Typecheck importers.

7. **Smoke**
```bash
npx vitest run src/store/connection-request.test.ts
```
Plus mcp/connector/catalog tool tests; manual connection.request card approve/skip.

---

## Merge plan: `store/connection-request.test.ts`

1. **Path**
Incoming → `src/store/connection-request.test.ts`  
(src absent — land as new file)

2. **Why protected**
Sibling of `connection-request.ts`.

3. **Desktop-only deltas to take**
Entire incoming suite once the module lands.

4. **Universal-only to keep**
Harness conventions (`setPrimaryGateway`, session-owner hints) used elsewhere.

5. **Conflict spots**
None file-vs-file; soft-couple to sibling exports + gateway fallback.

6. **Apply steps**
Create from incoming with `connection-request.ts`; fix owner wiring in helpers only if needed.

7. **Smoke**
```bash
npx vitest run src/store/connection-request.test.ts
```
