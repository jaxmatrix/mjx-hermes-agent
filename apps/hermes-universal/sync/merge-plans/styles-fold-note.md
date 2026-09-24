# styles.css fold (Phase E) — deferred deep cherry-pick

Applied on absorb: `hover`/`compact` variants, titlebar icon size, reduced-motion +
`data-renderer-animations-paused`, shared `:root` tokens (memory legendary, diff,
primary-solid, titlebar), tool-memory-legendary rules, composer-dock/popout width,
chat-unfocused opacity, scrollbar-fade alias, hover-marquee.

Left intact: mobile `#root` pin, `--composer-dock-inset-bottom`, `html[data-hud]`,
connect safe-area, WebKitGTK scrollbar scoping (`.scrollbar-dt`, not desktop global `*`).

Deferred: desktop `[data-hud-shell]` / Bot Mode glass shell CSS; any remaining
per-selector chat/transcript diffs that do not affect contract tests. Revisit when
porting those features.
