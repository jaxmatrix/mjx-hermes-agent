/**
 * Window translucency — the pure model, vendored from `apps/shared/src/translucency.ts`.
 *
 * Universal imports nothing from `apps/shared` (same precedent as
 * `lib/cron-trigger-controller.ts` and `themes/skin-contract.ts`), so the model
 * is copied rather than imported and pinned against its source by
 * `translucency-model.contract.test.ts` — a SEMANTIC pin (every exported name,
 * every numeric constant, the defaults table), because this repo's eslint sorts
 * members and prettier reformats, so byte identity could never hold.
 *
 * Two exports are deliberately NOT vendored: `translucencySupportedOn` and
 * `glassSupportedOn`. On Electron they are static platform facts; here they are
 * a RUNTIME question with a different answer per OS (Linux's GTK opacity works,
 * Electron's `setOpacity` does not), so Rust answers them through
 * `appearance_capabilities` → `$glassCapabilities`. `WINDOWS_GLASS_MIN_BUILD`
 * IS vendored: it is the number both apps pin.
 *
 * Note `normalizeMode` here is the TRANSLUCENCY mode; `themes/context.tsx` has
 * an unrelated private `normalizeMode` for `ThemeMode`.
 */

export type TranslucencyMode = 'clear' | 'glass'

/**
 * macOS vibrancy materials offered as glass "frost" levels, ordered sheer →
 * heavy. macOS exposes no blur-radius knob (VibrancyOptions is only an
 * animation duration), so the material IS the frost control: each maps to a
 * different NSVisualEffectView material with its own luminance lift.
 *
 * Curated by pixel census on macOS 26 (one window, visualEffectState pinned
 * to 'active', cycling all 14 materials over the same wallpaper): the 14
 * collapse to 9 distinct looks (sidebar≡hud, window≡fullscreen-ui,
 * tooltip≡content≡under-window≡under-page). These four are the ladder with
 * the widest separations that stay distinct in BOTH appearances — dark lum
 * 26/63/84/127, light lum 217/233/254/242. sidebar/hud sit 9 lum from
 * under-window when focused and collapse INTO it when unfocused, which
 * shipped as two indistinguishable picker options once — don't re-add them.
 */
export const GLASS_MATERIALS = ['under-window', 'popover', 'titlebar', 'header'] as const

export type GlassMaterial = (typeof GLASS_MATERIALS)[number]

export const DEFAULT_GLASS_MATERIAL: GlassMaterial = 'under-window'

/**
 * Where the glass field lives. 'window' thins every field surface; 'sidebar'
 * is the Finder shape — glass rail, opaque content column. The scope is a
 * page concern (which surfaces thin), so it never crosses IPC at all — Rust has
 * no native property that depends on it.
 */
export const GLASS_SCOPES = ['window', 'sidebar'] as const

export type GlassScope = (typeof GLASS_SCOPES)[number]

export const DEFAULT_GLASS_SCOPE: GlassScope = 'window'

/**
 * Windows 11 system backdrops. `'auto'` is deliberately absent — it lets DWM
 * pick, which would silently erase the frost choice.
 */
export const WINDOWS_BACKGROUND_MATERIALS = ['acrylic', 'tabbed', 'mica', 'none'] as const

export type WindowsBackgroundMaterial = (typeof WINDOWS_BACKGROUND_MATERIALS)[number]

/**
 * Frost (sheer → heavy) → Windows 11 system backdrop. Acrylic is the live-blur
 * transient material, closest to macOS under-window vibrancy; tabbed and mica
 * sample the wallpaper and read more opaque.
 *
 * Three backdrops for four rungs, so the two heaviest both land on mica. The
 * mapping stays total — a frost saved on a Mac still resolves — and the PICKER
 * drops the duplicate instead (see `glassMaterialsFor`).
 */
const WINDOWS_MATERIAL_BY_FROST: Record<GlassMaterial, Exclude<WindowsBackgroundMaterial, 'none'>> = {
  'under-window': 'acrylic',
  popover: 'tabbed',
  titlebar: 'mica',
  header: 'mica'
}

/**
 * The frost rungs Windows can render as DISTINCT looks: the first rung for each
 * backdrop. Shipping two options that composite identically is the mistake the
 * macOS census already corrected once (sidebar/hud); deriving the list from the
 * mapping means a change there can never reintroduce a duplicate.
 */
const WINDOWS_GLASS_MATERIALS: readonly GlassMaterial[] = GLASS_MATERIALS.filter(
  (material, index) =>
    GLASS_MATERIALS.findIndex(rung => WINDOWS_MATERIAL_BY_FROST[rung] === WINDOWS_MATERIAL_BY_FROST[material]) === index
)

/**
 * Windows 11 22H2 (build 22621) is the floor for a supported system backdrop.
 * Windows 11 still reports kernel 10.0; the build number is the discriminator,
 * and Rust's `glass_supported_for` fails closed on an unparseable version.
 * `window-vibrancy` will TRY below this (acrylic from 17763, undocumented mica
 * from 22000, no `tabbed` at all below 22523) — offering a picker whose rungs
 * collapse is worse than not offering glass, so the floor stays where the
 * desktop app put it and the two apps agree what "glass-capable" means.
 */
export const WINDOWS_GLASS_MIN_BUILD = 22621

export interface TranslucencyState {
  intensity: number
  /**
   * Glass only: native window opacity, on the same ramp Clear's lever uses.
   * Defaults to 0 (no fade) because fading a glass window fades its text too —
   * the very thing Glass exists to avoid. It is offered as a deliberate second
   * lever, never as part of the tint.
   */
  fade: number
  mode: TranslucencyMode
  material: GlassMaterial
  scope: GlassScope
}

/**
 * The half of the state that is scoped to the light/dark appearance.
 *
 * A tint that reads as a whisper over a dark palette is a milky sheet over a
 * light one, so one shared number cannot serve both — the same setting has to
 * mean a different amount in each appearance. `mode` stays global: clear vs
 * glass is a choice about the window, not about the palette.
 */
export type TranslucencyValues = Omit<TranslucencyState, 'mode'>

export type Appearance = 'light' | 'dark'

/**
 * Per-appearance defaults, per platform family. Glass ships ON: it is the
 * better-looking half of the feature, and a lever that starts at zero is a
 * feature nobody finds.
 *
 * The two platforms need different numbers because the lever means different
 * things behind them. `intensity` is how much of the theme tint the page
 * REMOVES (see `glassSurfaceKeep`), and what shows through underneath is a
 * native material with its own weight:
 *
 * - macOS vibrancy is genuinely sheer, so the tint has to come most of the way
 *   off before the desktop reads at all. Light leans heavy — a bright desktop
 *   behind a bright window needs real thinning before the field separates —
 *   with a single point of fade so the window edge reads as glass rather than
 *   as paint. Dark takes far less: a dark field already separates, and the
 *   tint that flatters light would smother it.
 * - Windows acrylic composites its OWN tint in DWM before the page is drawn,
 *   so the page's tint stacks on top of a backdrop that is already doing
 *   the work. The same numbers that read as frost on a Mac read as a washed
 *   sheet here; these stay low and let DWM carry it. Fade stays at zero —
 *   window alpha over a system backdrop dims the composited result rather than
 *   deepening it.
 *
 * Both sit on the frost each platform renders best: 'header' and 'titlebar'
 * are macOS-only rungs (on Windows they collapse onto mica — see
 * `glassMaterialsFor`), while 'under-window' is the acrylic rung, the live
 * blur closest to what macOS calls under-window.
 */
const DEFAULT_VALUES: Record<'mac' | 'windows', Record<Appearance, TranslucencyValues>> = {
  mac: {
    light: { intensity: 66, fade: 1, material: 'header', scope: 'window' },
    dark: { intensity: 22, fade: 0, material: 'titlebar', scope: 'window' }
  },
  windows: {
    light: { intensity: 20, fade: 0, material: 'under-window', scope: 'window' },
    dark: { intensity: 5, fade: 0, material: 'under-window', scope: 'window' }
  }
}

/**
 * The untouched values for an appearance on this platform. Linux never reaches
 * here — translucency is unsupported there, so nothing resolves.
 */
export function defaultTranslucencyValues(appearance: Appearance, isWindows: boolean): TranslucencyValues {
  return DEFAULT_VALUES[isWindows ? 'windows' : 'mac'][appearance]
}

/**
 * The webview's book of translucency settings.
 *
 * `base` is the shared rung: a value the user set before appearances were
 * split (a migrated v1 state), or one they have never touched. An appearance
 * slot only carries the keys edited WHILE that appearance was painted, so
 * changing the tint in light mode leaves dark's alone and an untouched dark
 * still inherits whatever base says. That is the ladder — appearance over base
 * over default, per key, so \"unset\" keeps carrying over.
 *
 * The book is webview-owned. Rust is handed the RESOLVED state (see
 * `resolveTranslucency`) because a window's material and opacity only ever
 * concern the appearance actually on screen.
 */
export interface TranslucencyBook {
  mode: TranslucencyMode
  base: Partial<TranslucencyValues>
  light: Partial<TranslucencyValues>
  dark: Partial<TranslucencyValues>
}

export const TRANSLUCENCY_MIN = 0
export const TRANSLUCENCY_MAX = 100

/** Renderer slider granularity. Main accepts any integer in range. */
export const TRANSLUCENCY_STEP = 1

/** Most see-through clear setting — floored so it stays usable, not invisible. */
export const TRANSLUCENCY_OPACITY_FLOOR = 0.3

/**
 * Exponent for the clear intensity → opacity ramp. 1 is a linear ramp, which
 * spends the whole readable band (opacity ≳ 0.95) in the first few percent of
 * the lever. 2 holds that band across roughly the first third while leaving
 * both endpoints bit-identical to the linear ramp.
 */
export const TRANSLUCENCY_CURVE = 2

export function clampIntensity(value: unknown): number {
  const n = Math.round(Number(value))

  return Number.isFinite(n) ? Math.min(TRANSLUCENCY_MAX, Math.max(TRANSLUCENCY_MIN, n)) : TRANSLUCENCY_MIN
}

/**
 * Glass needs a native window material, so unsupported platforms stay on
 * 'clear'.
 *
 * With no mode recorded, a glass-capable OS gets glass — it is the
 * better-looking half of the feature and the one worth finding, and
 * pre-selecting it costs a fresh profile nothing because the intensity still
 * starts at 0 (the whole feature is off until the user raises the lever).
 * `legacyIntensity` is the escape hatch: a profile that already carries a
 * NON-ZERO intensity but no mode predates this setting and has been rendering
 * as clear all along, so it keeps rendering as clear. Flipping a window
 * someone already tuned is the one thing a default must not do.
 */
export function normalizeMode(value: unknown, glassSupported: boolean, legacyIntensity = 0): TranslucencyMode {
  if (!glassSupported) {
    return 'clear'
  }

  if (value === 'glass' || value === 'clear') {
    return value
  }

  return legacyIntensity > 0 ? 'clear' : 'glass'
}

/** Unknown or unsupported values fall back to the default material. */
export function normalizeMaterial(value: unknown): GlassMaterial {
  return GLASS_MATERIALS.includes(value as GlassMaterial) ? (value as GlassMaterial) : DEFAULT_GLASS_MATERIAL
}

/** Unknown or unsupported values fall back to whole-window glass. */
export function normalizeScope(value: unknown): GlassScope {
  return GLASS_SCOPES.includes(value as GlassScope) ? (value as GlassScope) : DEFAULT_GLASS_SCOPE
}

/** Parse a persisted payload / peer broadcast into a safe state. */
export function normalizeState(payload: unknown, glassSupported: boolean): TranslucencyState {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const intensity = clampIntensity(record.intensity)

  return {
    intensity,
    fade: clampIntensity(record.fade),
    mode: normalizeMode(record.mode, glassSupported, intensity),
    material: normalizeMaterial(record.material),
    scope: normalizeScope(record.scope)
  }
}

/**
 * The resolved state a surface should assume before anyone has said otherwise.
 *
 * Unlike Electron, Tauri can swap a young window's material freely, so nothing
 * here has to guess an appearance before the first paint — the store resolves
 * the real book synchronously at module init. This is the shape a caller with
 * no book at all should assume.
 */
export function defaultTranslucencyState(
  appearance: Appearance,
  glassSupported: boolean,
  isWindows: boolean
): TranslucencyState {
  return {
    ...defaultTranslucencyValues(appearance, isWindows),
    mode: normalizeMode(undefined, glassSupported)
  }
}

/** Keep only the value keys actually present, each normalized. Unknown keys drop. */
function normalizeValues(payload: unknown): Partial<TranslucencyValues> {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const out: Partial<TranslucencyValues> = {}

  if (record.intensity !== undefined) {
    out.intensity = clampIntensity(record.intensity)
  }

  if (record.fade !== undefined) {
    out.fade = clampIntensity(record.fade)
  }

  if (record.material !== undefined) {
    out.material = normalizeMaterial(record.material)
  }

  if (record.scope !== undefined) {
    out.scope = normalizeScope(record.scope)
  }

  return out
}

/**
 * Parse a persisted book, or migrate a flat v1 state into one.
 *
 * A v1 payload is a window someone already tuned, so its values land in `base`
 * — every appearance inherits exactly what was on screen before the upgrade,
 * and the new per-appearance defaults apply only where nothing was ever set.
 * The legacy clear rule rides along: a non-zero v1 intensity with no mode was
 * rendering as clear and keeps doing so.
 */
export function normalizeBook(payload: unknown, glassSupported: boolean): TranslucencyBook {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const migrating = record.base === undefined && record.light === undefined && record.dark === undefined

  const base = normalizeValues(migrating ? record : record.base)
  const legacyIntensity = migrating ? clampIntensity(record.intensity) : 0

  return {
    mode: normalizeMode(record.mode, glassSupported, legacyIntensity),
    base,
    light: normalizeValues(migrating ? null : record.light),
    dark: normalizeValues(migrating ? null : record.dark)
  }
}

/**
 * Flatten the book for one appearance: appearance slot → base → default.
 *
 * This is the only thing outside the settings surface that should ever be
 * handed around — Rust, the CSS field surfaces, and every consumer of
 * `$translucency` all want the resolved answer for what is painted right now.
 */
export function resolveTranslucency(
  book: TranslucencyBook,
  appearance: Appearance,
  isWindows: boolean
): TranslucencyState {
  const fallback = defaultTranslucencyValues(appearance, isWindows)
  const slot = book[appearance]

  return {
    mode: book.mode,
    intensity: slot.intensity ?? book.base.intensity ?? fallback.intensity,
    fade: slot.fade ?? book.base.fade ?? fallback.fade,
    material: slot.material ?? book.base.material ?? fallback.material,
    scope: slot.scope ?? book.base.scope ?? fallback.scope
  }
}

/**
 * Record an edit against the appearance being painted.
 *
 * The edit is written to the appearance slot rather than to base, so tuning
 * light mode is scoped to light mode. Base is left intact as the inheritance
 * rung for whichever appearance has not been touched.
 */
export function setTranslucencyValues(
  book: TranslucencyBook,
  appearance: Appearance,
  patch: Partial<TranslucencyValues>
): TranslucencyBook {
  return { ...book, [appearance]: { ...book[appearance], ...normalizeValues(patch) } }
}

/** Lever percent → native window opacity, floored so it stays usable. */
function opacityRamp(lever: number): number {
  const ratio = clampIntensity(lever) / TRANSLUCENCY_MAX

  return 1 - (1 - TRANSLUCENCY_OPACITY_FLOOR) * Math.pow(ratio, TRANSLUCENCY_CURVE)
}

/**
 * Native window opacity for a state.
 *
 * Under Clear the lever IS the opacity. Under Glass the lever paints the tint
 * and only the separate `fade` reaches the window, so a glass window stays at
 * 1 until the user opts into fading it — which is what keeps a tint drag from
 * touching anything native.
 *
 * Fade is gated on glass being ACTIVE, not merely selected. The light default
 * carries a single point of it so the window edge reads as glass rather than
 * as paint, and without this gate that point would follow someone who had
 * turned the tint to zero — leaving a window that asked to be opaque sitting
 * at 0.9999. Off has to mean off.
 */
export function windowOpacityFor(state: TranslucencyState): number {
  if (state.mode !== 'glass') {
    return opacityRamp(state.intensity)
  }

  return opacityRamp(glassActive(state) ? state.fade : 0)
}

/**
 * Whether glass is visually active. Both sides branch on this: Rust to decide
 * whether a material is applied, the page to decide whether surfaces thin.
 */
export function glassActive({ intensity, mode }: TranslucencyState): boolean {
  return mode === 'glass' && intensity > 0
}

/**
 * Percent of the surface tint the page KEEPS at a given intensity. Linear
 * to zero: at 100 the tint is fully gone — bare platform glass — so the slider
 * spans the whole range from opaque theme to untinted blur. Text and cards
 * keep their own opaque tokens for contrast; only the field surfaces thin.
 */
export function glassSurfaceKeep(intensity: number): number {
  return TRANSLUCENCY_MAX - clampIntensity(intensity)
}

/**
 * The vibrancy material a chat window should carry. 'sidebar' is the
 * long-standing default the titlebar band was designed against; glass mode
 * swaps the whole window onto the user's chosen material (applying vibrancy is
 * cheap and animatable at runtime).
 */
export function vibrancyFor(state: TranslucencyState): GlassMaterial | 'sidebar' {
  return glassActive(state) ? state.material : 'sidebar'
}

/**
 * The Windows 11 system backdrop a chat window should carry. 'none' while
 * glass is off so DWM does not keep drawing mica/acrylic under the opaque
 * themed backing.
 */
export function backgroundMaterialFor(state: TranslucencyState): WindowsBackgroundMaterial {
  return glassActive(state) ? WINDOWS_MATERIAL_BY_FROST[state.material] : 'none'
}

/** The frost rungs to offer on this platform. */
export function glassMaterialsFor(isWindows: boolean): readonly GlassMaterial[] {
  return isWindows ? WINDOWS_GLASS_MATERIALS : GLASS_MATERIALS
}

/**
 * The native frost a HUD-style transparent window should carry.
 *
 * Two gates, because the HUD's frost answers to more than the setting. The
 * material is the WINDOW's — nothing on the page can clip it — so it is only
 * ever right while the band actually covers the window below the bar;
 * `showing` is the page's answer to that. The setting
 * is the other half: Glass off, or the tint at zero, means no frost at all.
 *
 * The off answer is `null` rather than a resting material, which is the one
 * way this differs from `vibrancyFor`. A chat window is opaque and keeps
 * 'sidebar' under its titlebar band whatever the setting says; a transparent
 * window has no opaque page to hide an unwanted material behind, so off has
 * to mean off or the frost is a grey slab hanging over someone else's app.
 */
export function hudFrostFor(
  state: TranslucencyState,
  showing: boolean
): { backgroundMaterial: WindowsBackgroundMaterial; vibrancy: GlassMaterial | null } {
  const active = showing && glassActive(state)

  return {
    vibrancy: active ? state.material : null,
    backgroundMaterial: active ? backgroundMaterialFor(state) : 'none'
  }
}

/**
 * The rung the picker highlights. A frost with no rung of its own here — a
 * Mac's 'header' read on Windows — folds onto the rung that renders the same
 * backdrop, so the picker shows a truthful selection without rewriting the
 * value the user saved on their other machine.
 */
export function glassMaterialForPicker(material: GlassMaterial, isWindows: boolean): GlassMaterial {
  if (!isWindows) {
    return material
  }

  return (
    WINDOWS_GLASS_MATERIALS.find(rung => WINDOWS_MATERIAL_BY_FROST[rung] === WINDOWS_MATERIAL_BY_FROST[material]) ??
    DEFAULT_GLASS_MATERIAL
  )
}
