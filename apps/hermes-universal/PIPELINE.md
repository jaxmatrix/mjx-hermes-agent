# Hermes Universal pipeline

Thin-host rebuild: **desktop UI is ground truth**; this package is the Tauri /
mobile host. Capability detection starts at Electron’s preload.

## Archive

| Ref | Purpose |
| --- | --- |
| Branch `archive/hermes-universal-pre-pipeline` | Pre-rebuild universal (full fork) |
| Tag `hermes-universal-pre-pipeline` | Same tip |

Recover a file:

```bash
git show archive/hermes-universal-pre-pipeline:apps/hermes-universal/path/to/file
```

## Absorb desktop src

Desktop’s `apps/desktop/src` wins for every path **not** listed in
[`sync/protected.txt`](sync/protected.txt) (host-only: bridge, boot, mobile,
browser guest, connection/Rust seams, WebKit contracts, …).

```bash
npm run absorb-desktop-src          # apply copies
npm run absorb-desktop-src -- --dry # classify only (desktop-sync without --apply)
```

Underlying script: [`scripts/desktop-sync.mjs`](scripts/desktop-sync.mjs)
(also [`scripts/absorb-desktop-src.mjs`](scripts/absorb-desktop-src.mjs)).

After a Nous merge that updates `apps/desktop`, run absorb, then
`npx vitest run src/lib/hermes-desktop/preload-drift.test.ts`.

## Port registry (preload → tasks)

```bash
npm run gen-port-registry
```

- **Source of capabilities:** [`apps/desktop/electron/preload.ts`](../desktop/electron/preload.ts)
- **Decisions (gaps only):** [`sync/port-decisions.json`](sync/port-decisions.json)
- **Output:** [`sync/port-registry.json`](sync/port-registry.json)

| Status | Meaning |
| --- | --- |
| `ported` | Not in decisions — bridge must expose it (`preload-drift` enforces) |
| `needs-Rust` | Tauri command / Rust work remaining |
| `needs-native` | Mobile/OS plugin (e.g. mic) |
| `no-mapping` | Intentionally absent / other owner |
| `mobile-n/a` | Desktop-only surface |
| `batch` | Deferred port batch |
| `undecided` | Explicit gap with no classification yet |

Authoritative gate for “missing vs present” remains
[`src/lib/hermes-desktop/preload-drift.test.ts`](src/lib/hermes-desktop/preload-drift.test.ts)
(`NOT_YET` ↔ keep `port-decisions.json` in sync when you change it).

## Absorb complete (thin IPC)

Waves 1–5 of the Electron→Tauri thin-host absorb are done on
`pipeline/nous-thin-host`: preload members that are thin IPC now live on
`window.hermesDesktop` via `src/lib/hermes-desktop/` + `src-tauri` commands.
`npm run gen-port-registry` / `preload-drift.test.ts` are the gate.

**Wave 6 (native / decisions), in order:**

1. ~~Spellcheck~~ → `no-mapping`
2. ~~`hudModifier`~~ → ported (`hud_modifier.rs` + native helper)
3. ~~`screenshot`~~ → ported (`screenshot.rs`; macOS helper + `screencapture`)
4. ~~`connections.updateManaged`~~ → ported (`connections/managed_update.rs` via live tunnel)

`needs-Rust` count is **0**.

**Check status at closeout:** `check:rust` (fmt / check / test) green; hermes-desktop
vitest green. Full `npm run check` / `check:js` typecheck is still red on
pre-existing absorb/MERGE debt (~1k+ TS errors in absorbed desktop UI) — not a
Wave 5 regression; fix that debt separately from Wave 6 native ports.

## Branch / merge notes

Work branch for this rebuild: `pipeline/nous-thin-host`.

1. Parked universal, merged `downstream/main` (Nous).
2. Restored host from archive + absorbed post-merge desktop src.
3. First typecheck after absorb is **not** green (~1200 TS errors from
   protected/MERGE seams and desktop renames) — expected debt; drift test is green.

## Patch kinds (reminder)

| Kind | Where |
| --- | --- |
| K0 identity | Absorbed desktop UI |
| K1 bridge | `src/lib/hermes-desktop/` |
| K2 native preflight | e.g. `lib/mic-permission.ts` + plugins |
| K3 host rewrite | e.g. `lib/browser/` + `src-tauri` browser |
| K4 mobile chrome | `app/shell/mobile-*`, overlays |
| K5 mobile-n/a | Registry decision |
