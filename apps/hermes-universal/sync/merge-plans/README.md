# Incoming merge plans — index

Thin-host absorb: fold Nous desktop (`sync/incoming/`) into protected universal (`src/`).  
**Plans only** for batches 1–6 (except i18n, which was applied).

| Artifact | Role |
| --- | --- |
| [batch-0-i18n.md](./batch-0-i18n.md) | **Applied:** desktop i18n copied as-is into `src/i18n/` |
| [batch-1.md](./batch-1.md) | main.tsx, platform.ts, pointer-drag.ts |
| [batch-2.md](./batch-2.md) | trackpad-gestures.ts, sdk/runtime.ts, hermes.ts |
| [batch-3.md](./batch-3.md) | preview.tsx, global.ts, styles.css |
| [batch-4.md](./batch-4.md) | windows.ts, windows.test.ts, artifacts.ts |
| [batch-5.md](./batch-5.md) | artifacts.test.ts, connections.ts, connections.test.ts |
| [batch-6.md](./batch-6.md) | connection-request.ts + test (**src missing — copy incoming**) |

## Legend (execute pass)

| Verdict (from plans) | Files |
| --- | --- |
| **No-op leave src** | main, platform, pointer-drag, trackpad-gestures, sdk/runtime, preview, artifacts.ts, connections.test.ts |
| **Additive fold** | hermes.ts (barrel/options), global.ts (new hermesDesktop types), styles.css (union tokens/variants), windows.ts/.test (peer/profile when Rust ready), artifacts.test (persistence case), connections.ts (timeouts/invalidate/recover) |
| **Copy incoming (add)** | connection-request.ts + .test.ts |
| **Already applied** | i18n/* |

## Suggested execute order

1. **batch-6** — restore missing `connection-request` (unblocks imports)
2. **batch-3** `global.ts` — types for new preload members
3. **batch-2** `hermes.ts` — only if desktop barrel deltas exist
4. **batch-3** `styles.css` — careful cherry-pick
5. **batch-4/5** windows + connections behavioral folds
6. Delete each resolved path under `sync/incoming/`
7. `npx vitest run src/lib/hermes-desktop/preload-drift.test.ts`

## Policy reminder

- Incoming = Nous desktop  
- src = protected universal (keep Tauri/mobile/Rust)  
- Wholesale replace of src: **no**, except connection-request add and i18n (done)
