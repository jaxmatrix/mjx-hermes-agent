# windows profile/peer seeding — deferred (Phase F)

Applied: `isPeerInstanceWindow` pure-query tests (symbol already in `src/store/windows.ts`).

Deferred until Rust accepts profile-stamped / peer-seeded window URLs:
`isProfilePinnedWindow`, `?profileWindow=1`, `windowConnectionOverride`, and
profile args on session pop-out invoke. Do not wait on that for clearing incoming.
