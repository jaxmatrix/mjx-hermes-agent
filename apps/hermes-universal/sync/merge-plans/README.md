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
| [batch-6.md](./batch-6.md) | connection-request.ts + test (**applied** — in `src/store/`) |

## Incoming clearance (pipeline/nous-thin-host)

`sync/incoming/` cleared. Verdicts:

| Path | Outcome |
| --- | --- |
| main, platform, pointer-drag, trackpad-gestures, sdk/runtime, preview, artifacts.ts, connections.test, i18n | no-op leave src |
| hermes.ts barrel | matched (no `HermesGateway` from `./api/client`) |
| artifacts.test | persistence case already in src |
| connection-request | applied (src present) |
| styles.css | partial fold; deep cherry-pick deferred — [styles-fold-note.md](./styles-fold-note.md) |
| windows* | peer/profile URL deferred — [windows-deferred-note.md](./windows-deferred-note.md) |
| connections.ts | timeouts/invalidate/recover already in src; Electron restore left out |
