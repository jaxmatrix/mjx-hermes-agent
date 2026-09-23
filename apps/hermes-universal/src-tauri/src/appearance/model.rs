//! The pure half of window glass: no window, no OS, no `unsafe`.
//!
//! Everything here is the Rust twin of `src/lib/translucency-model.ts` (itself
//! vendored from `apps/shared/src/translucency.ts`). The three ramp literals —
//! the 0.3 floor, the exponent 2, the 0..=100 lever — are a cross-language
//! contract, pinned by `pins_the_shared_literals` below and by
//! `src/lib/translucency-model.test.ts`, exactly the way
//! `data_url_read_max.rs` ↔ `apps/shared/src/data-url-read-max.ts` are.
//!
//! The whole ladder is compiled on EVERY target — the same reason
//! `SurfaceCapabilities::none` is (`surface/mod.rs:170`): one CI job then
//! type-checks and unit-tests the rungs every other platform will run. Only the
//! two OSes with a compositor material consume all of it, so dead-code
//! reporting stays on for those and is silenced elsewhere rather than sprinkled
//! per item, where it would rot the moment a rung was added.
#![cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]

use serde::{Deserialize, Serialize};

/// Clear fades the whole window; Glass leaves it opaque at the native level and
/// gives it a compositor material the page then thins itself over.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GlassMode {
    Clear,
    Glass,
}

/// One rung of the frost ladder, sheer → heavy. The names are the macOS
/// semantic materials because that is the platform with four distinct looks;
/// Windows folds them onto three backdrops (see [`FROST_TABLE`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FrostRung {
    UnderWindow,
    Popover,
    Titlebar,
    Header,
}

/// Windows 11 system backdrops. `None` is "stop drawing one", not "let DWM
/// pick" — auto would silently erase the frost choice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowsBackdrop {
    Acrylic,
    Tabbed,
    Mica,
    None,
}

/// The NATIVE half of the resolved `TranslucencyState`.
///
/// `scope` is deliberately absent: it decides which *page* surfaces thin and no
/// native property depends on it, so a scope change costs zero IPC.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlassRequest {
    pub mode: GlassMode,
    pub intensity: u8,
    pub fade: u8,
    pub material: FrostRung,
}

/// A rung and what each OS renders it as. Adding a rung is one row here plus one
/// entry in `GLASS_MATERIALS` on the TS side — nothing else branches on the
/// ladder.
pub struct FrostRungSpec {
    pub rung: FrostRung,
    /// Windows 11 system backdrop.
    pub backdrop: WindowsBackdrop,
    /// Raw `NSVisualEffectMaterial` value. Kept as a number rather than the
    /// crate's enum so this module compiles on every target, `window-vibrancy`
    /// being a macOS/Windows-only dependency.
    pub ns_material: u64,
}

pub const FROST_TABLE: &[FrostRungSpec] = &[
    FrostRungSpec {
        rung: FrostRung::UnderWindow,
        backdrop: WindowsBackdrop::Acrylic,
        // NSVisualEffectMaterialUnderWindowBackground
        ns_material: 21,
    },
    FrostRungSpec {
        rung: FrostRung::Popover,
        backdrop: WindowsBackdrop::Tabbed,
        // NSVisualEffectMaterialPopover
        ns_material: 6,
    },
    FrostRungSpec {
        rung: FrostRung::Titlebar,
        backdrop: WindowsBackdrop::Mica,
        // NSVisualEffectMaterialTitlebar
        ns_material: 3,
    },
    FrostRungSpec {
        rung: FrostRung::Header,
        backdrop: WindowsBackdrop::Mica,
        // NSVisualEffectMaterialHeaderView
        ns_material: 10,
    },
];

pub fn frost_spec(rung: FrostRung) -> &'static FrostRungSpec {
    FROST_TABLE
        .iter()
        .find(|spec| spec.rung == rung)
        // The table is total over the enum and a test says so, so this is
        // unreachable — but a panic in a cosmetic command is never worth it.
        .unwrap_or(&FROST_TABLE[0])
}

/// Every rung, sheer → heavy. What macOS offers.
pub fn all_rungs() -> Vec<FrostRung> {
    FROST_TABLE.iter().map(|spec| spec.rung).collect()
}

/// The rungs an OS with only three backdrops can render as DISTINCT looks: the
/// first rung for each backdrop. Derived from the table rather than listed, so a
/// change there can never reintroduce two picker options that composite the same
/// — the mistake the macOS pixel census already corrected once.
pub fn distinct_backdrop_rungs() -> Vec<FrostRung> {
    let mut seen: Vec<WindowsBackdrop> = Vec::new();
    let mut rungs = Vec::new();

    for spec in FROST_TABLE {
        if !seen.contains(&spec.backdrop) {
            seen.push(spec.backdrop);
            rungs.push(spec.rung);
        }
    }

    rungs
}

/// Ported from `apps/shared/src/translucency.ts`. Keep in lockstep with
/// `src/lib/translucency-model.ts`; `pins_the_shared_literals` below and the
/// matching TS test are what make a one-sided edit fail.
pub const TRANSLUCENCY_MAX: u8 = 100;
pub const TRANSLUCENCY_OPACITY_FLOOR: f64 = 0.3;
pub const TRANSLUCENCY_CURVE: i32 = 2;

/// Windows 11 22H2. Below it `window-vibrancy` will still TRY (acrylic from
/// 17763, undocumented mica from 22000) but `tabbed` does not exist at all
/// below 22523, so the picker would offer rungs that composite identically.
/// Fail closed instead — the number is the one the desktop app pins.
pub const WINDOWS_GLASS_MIN_BUILD: u32 = 22621;

/// Whether glass is visually ACTIVE, not merely selected. Off has to mean off:
/// this is what keeps the mac light default's single point of fade from
/// following someone who turned the tint to zero.
pub fn glass_active(request: &GlassRequest) -> bool {
    request.mode == GlassMode::Glass && request.intensity > 0
}

/// Lever percent → native window opacity, floored so it stays usable.
pub fn opacity_ramp(lever: u8) -> f64 {
    let ratio = f64::from(lever.min(TRANSLUCENCY_MAX)) / f64::from(TRANSLUCENCY_MAX);

    1.0 - (1.0 - TRANSLUCENCY_OPACITY_FLOOR) * ratio.powi(TRANSLUCENCY_CURVE)
}

/// Under Clear the lever IS the opacity. Under Glass only the separate `fade`
/// reaches the window, and only while glass is active — which is what keeps a
/// tint drag from touching anything native at all.
pub fn window_opacity_for(request: &GlassRequest) -> f64 {
    if request.mode != GlassMode::Glass {
        return opacity_ramp(request.intensity);
    }

    opacity_ramp(if glass_active(request) {
        request.fade
    } else {
        0
    })
}

/// The backdrop a window should carry. `None` while glass is off, so DWM does
/// not keep drawing mica under an opaque themed page.
pub fn backdrop_for(request: &GlassRequest) -> WindowsBackdrop {
    if glass_active(request) {
        frost_spec(request.material).backdrop
    } else {
        WindowsBackdrop::None
    }
}

/// Whether this OS can back glass with a first-party compositor material.
///
/// macOS always; Windows from the 22H2 build floor; everything else no. Linux
/// is the interesting `false`: its GTK opacity lever works (which Electron's
/// does not), so *translucency* is supported there while *glass* is not.
pub fn glass_supported_for(os: &str, build: Option<u32>) -> bool {
    match os {
        "macos" => true,
        "windows" => build.is_some_and(|build| build >= WINDOWS_GLASS_MIN_BUILD),
        _ => false,
    }
}

/// What actually has to be re-applied between two requests.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Changed {
    pub material: bool,
    pub opacity: bool,
}

impl Changed {
    pub fn all() -> Self {
        Self {
            material: true,
            opacity: true,
        }
    }

    pub fn any(self) -> bool {
        self.material || self.opacity
    }
}

/// Diff a request against what this window already carries.
///
/// The material half compares the *effective* material — whether glass is
/// active and which rung — so an intensity drag under glass reports nothing at
/// all, and crossing zero reports a change. The opacity half compares the
/// resolved opacity rather than the levers, so a fade edit that cannot reach
/// the window (glass selected, tint at zero) is likewise nothing.
pub fn changed(previous: Option<&GlassRequest>, next: &GlassRequest) -> Changed {
    let Some(previous) = previous else {
        return Changed::all();
    };

    Changed {
        material: (glass_active(previous), previous.material)
            != (glass_active(next), next.material),
        opacity: window_opacity_for(previous) != window_opacity_for(next),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(mode: GlassMode, intensity: u8, fade: u8, material: FrostRung) -> GlassRequest {
        GlassRequest {
            mode,
            intensity,
            fade,
            material,
        }
    }

    #[test]
    fn pins_the_shared_literals() {
        // A cross-language contract with src/lib/translucency-model.ts and
        // apps/shared/src/translucency.ts. Changing one side alone is the drift
        // this asserts against.
        assert_eq!(TRANSLUCENCY_MAX, 100);
        assert_eq!(TRANSLUCENCY_OPACITY_FLOOR, 0.3);
        assert_eq!(TRANSLUCENCY_CURVE, 2);
        assert_eq!(WINDOWS_GLASS_MIN_BUILD, 22621);
    }

    #[test]
    fn opacity_ramp_matches_the_typescript_ramp() {
        // Sampled against `windowOpacityFor` in the TS model. Both endpoints are
        // bit-identical to a LINEAR ramp; the exponent only bends the middle.
        assert_eq!(opacity_ramp(0), 1.0);
        assert_eq!(opacity_ramp(100), 1.0 - (1.0 - TRANSLUCENCY_OPACITY_FLOOR));
        assert!((opacity_ramp(50) - 0.825).abs() < 1e-12);
        assert!((opacity_ramp(25) - 0.95625).abs() < 1e-12);
        // Out-of-range clamps rather than overshooting the floor.
        assert_eq!(opacity_ramp(255), opacity_ramp(100));
    }

    #[test]
    fn opacity_ramp_is_monotonic_and_never_below_the_floor() {
        let mut previous = 1.1;

        for lever in 0..=100u8 {
            let opacity = opacity_ramp(lever);

            assert!(opacity <= previous);
            assert!(opacity >= TRANSLUCENCY_OPACITY_FLOOR - 1e-12);
            previous = opacity;
        }
    }

    #[test]
    fn glass_active_needs_both_the_mode_and_a_tint() {
        assert!(glass_active(&request(
            GlassMode::Glass,
            40,
            0,
            FrostRung::Popover
        )));
        assert!(!glass_active(&request(
            GlassMode::Glass,
            0,
            0,
            FrostRung::Popover
        )));
        assert!(!glass_active(&request(
            GlassMode::Clear,
            40,
            0,
            FrostRung::Popover
        )));
    }

    #[test]
    fn window_opacity_covers_all_four_quadrants() {
        // Clear: the lever IS the opacity, fade is inert.
        assert_eq!(
            window_opacity_for(&request(GlassMode::Clear, 100, 0, FrostRung::Popover)),
            opacity_ramp(100)
        );
        assert_eq!(
            window_opacity_for(&request(GlassMode::Clear, 0, 100, FrostRung::Popover)),
            1.0
        );
        // Glass active: fade reaches the window, intensity does not.
        assert_eq!(
            window_opacity_for(&request(GlassMode::Glass, 100, 0, FrostRung::Popover)),
            1.0
        );
        assert_eq!(
            window_opacity_for(&request(GlassMode::Glass, 1, 100, FrostRung::Popover)),
            opacity_ramp(100)
        );
        // Glass selected but inactive: off means off, fade included.
        assert_eq!(
            window_opacity_for(&request(GlassMode::Glass, 0, 100, FrostRung::Popover)),
            1.0
        );
    }

    #[test]
    fn glass_support_fails_closed_below_the_windows_floor() {
        assert!(glass_supported_for("macos", None));
        assert!(glass_supported_for(
            "windows",
            Some(WINDOWS_GLASS_MIN_BUILD)
        ));
        assert!(glass_supported_for(
            "windows",
            Some(WINDOWS_GLASS_MIN_BUILD + 1)
        ));
        assert!(!glass_supported_for(
            "windows",
            Some(WINDOWS_GLASS_MIN_BUILD - 1)
        ));
        assert!(!glass_supported_for("windows", Some(19045)));
        assert!(!glass_supported_for("windows", None));
        assert!(!glass_supported_for("linux", Some(99999)));
        assert!(!glass_supported_for("android", None));
        assert!(!glass_supported_for("ios", None));
    }

    #[test]
    fn frost_table_is_total_and_maps_the_four_rungs() {
        for rung in [
            FrostRung::UnderWindow,
            FrostRung::Popover,
            FrostRung::Titlebar,
            FrostRung::Header,
        ] {
            assert_eq!(frost_spec(rung).rung, rung);
        }

        assert_eq!(
            frost_spec(FrostRung::UnderWindow).backdrop,
            WindowsBackdrop::Acrylic
        );
        assert_eq!(
            frost_spec(FrostRung::Popover).backdrop,
            WindowsBackdrop::Tabbed
        );
        assert_eq!(
            frost_spec(FrostRung::Titlebar).backdrop,
            WindowsBackdrop::Mica
        );
        assert_eq!(
            frost_spec(FrostRung::Header).backdrop,
            WindowsBackdrop::Mica
        );
        // The raw NSVisualEffectMaterial values, pinned so a re-ordering of the
        // table cannot quietly change what macOS renders.
        assert_eq!(frost_spec(FrostRung::UnderWindow).ns_material, 21);
        assert_eq!(frost_spec(FrostRung::Popover).ns_material, 6);
        assert_eq!(frost_spec(FrostRung::Titlebar).ns_material, 3);
        assert_eq!(frost_spec(FrostRung::Header).ns_material, 10);
    }

    #[test]
    fn windows_never_offers_two_rungs_on_one_backdrop() {
        let rungs = distinct_backdrop_rungs();
        let backdrops: Vec<_> = rungs
            .iter()
            .map(|rung| frost_spec(*rung).backdrop)
            .collect();

        assert_eq!(
            rungs,
            vec![
                FrostRung::UnderWindow,
                FrostRung::Popover,
                FrostRung::Titlebar
            ]
        );
        assert!(rungs.len() < all_rungs().len());

        for (index, backdrop) in backdrops.iter().enumerate() {
            assert!(!backdrops[..index].contains(backdrop));
        }

        // …and every backdrop the full ladder can reach is still reachable.
        for spec in FROST_TABLE {
            assert!(backdrops.contains(&spec.backdrop));
        }
    }

    #[test]
    fn backdrop_rests_at_none_while_glass_is_off() {
        assert_eq!(
            backdrop_for(&request(GlassMode::Clear, 80, 0, FrostRung::Popover)),
            WindowsBackdrop::None
        );
        assert_eq!(
            backdrop_for(&request(GlassMode::Glass, 0, 0, FrostRung::Popover)),
            WindowsBackdrop::None
        );
        assert_eq!(
            backdrop_for(&request(GlassMode::Glass, 5, 0, FrostRung::Popover)),
            WindowsBackdrop::Tabbed
        );
    }

    #[test]
    fn changed_reports_nothing_for_an_intensity_drag_under_glass() {
        // The whole point of the diff: ~100 slider ticks send one message.
        let previous = request(GlassMode::Glass, 30, 0, FrostRung::Popover);
        let next = request(GlassMode::Glass, 31, 0, FrostRung::Popover);

        assert_eq!(changed(Some(&previous), &next), Changed::default());
        assert!(!changed(Some(&previous), &next).any());
    }

    #[test]
    fn changed_reports_opacity_only_under_clear() {
        let previous = request(GlassMode::Clear, 30, 0, FrostRung::Popover);
        let next = request(GlassMode::Clear, 31, 0, FrostRung::Popover);

        assert_eq!(
            changed(Some(&previous), &next),
            Changed {
                material: false,
                opacity: true
            }
        );
    }

    #[test]
    fn changed_reports_material_only_on_a_frost_change() {
        let previous = request(GlassMode::Glass, 30, 0, FrostRung::Popover);
        let next = request(GlassMode::Glass, 30, 0, FrostRung::Titlebar);

        assert_eq!(
            changed(Some(&previous), &next),
            Changed {
                material: true,
                opacity: false
            }
        );
    }

    #[test]
    fn changed_reports_both_when_glass_crosses_zero() {
        let previous = request(GlassMode::Glass, 0, 40, FrostRung::Popover);
        let next = request(GlassMode::Glass, 1, 40, FrostRung::Popover);

        assert_eq!(changed(Some(&previous), &next), Changed::all());
    }

    #[test]
    fn a_first_push_changes_everything() {
        assert_eq!(
            changed(
                None,
                &request(GlassMode::Clear, 0, 0, FrostRung::UnderWindow)
            ),
            Changed::all()
        );
    }
}
