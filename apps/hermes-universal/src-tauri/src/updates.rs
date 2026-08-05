//! App update checks and self-update (MJX-6, MJXHRM-144).
//!
//! Where the new build comes from depends on how the app was installed, so each
//! target asks a different authority:
//!
//! * desktop  — `tauri-plugin-updater`, pointed at the signed `latest.json`
//!              published with each GitHub release of this repo. The update is
//!              downloaded, signature-verified and installed in place; the app
//!              then restarts itself.
//! * Android  — the Play Store listing for our own package id, scraped for the
//!              published version; the "download" is a `market://` deep link.
//! * iOS      — the official iTunes Lookup API for our own bundle id; the
//!              "download" is an `itms-apps://` deep link.
//!
//! All of it runs here rather than in JS because the webview CSP is
//! `connect-src 'self' ipc:` — the frontend cannot reach github.com/google.com/
//! apple.com at all — and because that is where the rest of our networking lives
//! (see `transport.rs`). The updater plugin is likewise driven from Rust, so no
//! updater ACL permission has to be handed to the webview.
//!
//! **Why the manifest host does not have to be trusted.** The minisign public
//! key is compiled into the binary (`plugins.updater.pubkey` in
//! tauri.conf.json) and the plugin verifies the downloaded bundle against it
//! before installing — the plugin offers no way to switch that off. Whoever
//! controls the manifest can therefore withhold or stall an update, but cannot
//! substitute one: the private signing key, which lives only in the release
//! workflow's protected environment, is the single root of trust.
//!
//! The checks sit behind the `update-checks` cargo feature, which is **on by
//! default** — a build compiled with `--no-default-features` gets the stub at
//! the bottom, which reports `source: "disabled"` / no update available and
//! never touches the network, so the About page renders version-only.
//!
//! Nothing here is fatal: an unreachable store, a rate-limited API or Play
//! changing its markup all resolve to a well-formed `UpdateStatus` carrying a
//! `reason`, so the UI can say "couldn't check" instead of throwing.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, State};

/// How long a check result stays fresh. The About page checks on mount, so
/// without this every visit would hit the network.
const CACHE_TTL_MS: u64 = 6 * 60 * 60 * 1000;

/// Our own repo — NOT upstream NousResearch/hermes-agent. Releases of this fork
/// are what our builds are cut from, and their version numbers are the only ones
/// comparable with the running build's.
///
/// `allow(dead_code)`: unused in a `--no-default-features` build.
#[allow(dead_code)]
pub const REPO_URL: &str = "https://github.com/jaxmatrix/mjx-hermes-agent";

/// Whether the app has real Play Store / App Store listings yet.
///
/// It does not. Until it does, the mobile checks are mocked: scraping an
/// unpublished listing only ever 404s, and a `market://` / `itms-apps://` deep
/// link would drop the user on a dead page. The real backends below stay
/// compiled and unit-tested — flip this one constant when the listings go live.
///
/// `allow(dead_code)`: only the store backends read it, so a desktop build
/// compiles it unused.
#[allow(dead_code)]
pub const STORE_LISTING_PUBLISHED: bool = false;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// Which authority answered: `github` | `play` | `appstore` | `disabled`.
    pub source: String,
    /// The running build's version (from the Tauri package info).
    pub current_version: String,
    /// The published version, when we could read one.
    pub latest_version: Option<String>,
    pub update_available: bool,
    /// What to open to get the update — a release page, `market://…` or
    /// `itms-apps://…`. Absent where there is nothing meaningful to open.
    pub download_url: Option<String>,
    /// Human-facing page for the same thing (release page / store listing).
    pub notes_url: Option<String>,
    pub checked_at_ms: u64,
    /// Whether `update_install` can actually apply this update in place. False
    /// on mobile (the store owns installs) and in a checks-disabled build, which
    /// is what tells the UI to offer "Download" instead of "Update now".
    pub can_self_install: bool,
    /// `checks_disabled` | `store_pending` | `unreachable` | `unparsed` —
    /// absent on success.
    pub reason: Option<String>,
}

/// Progress of an in-flight `update_install`, emitted on `update://progress`.
/// `total` is absent when the server sends no Content-Length.
///
/// `allow(dead_code)`: only the desktop installer emits it.
#[allow(dead_code)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// Last result, so `force: false` can answer from memory (see `CACHE_TTL_MS`).
#[derive(Default)]
pub struct UpdateState(tokio::sync::Mutex<Option<UpdateStatus>>);

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, UpdateState>,
    force: bool,
) -> Result<UpdateStatus, String> {
    let current = app.package_info().version.to_string();

    if !force {
        if let Some(cached) = state.0.lock().await.clone() {
            if now_ms().saturating_sub(cached.checked_at_ms) < CACHE_TTL_MS {
                return Ok(cached);
            }
        }
    }

    // The store identity is the bundle/package id from tauri.conf.json — never
    // hardcoded per platform, so a rename can't silently query the wrong app.
    let identifier = app.config().identifier.clone();
    let status = imp::check(&app, &identifier, &current).await;

    *state.0.lock().await = Some(status.clone());

    Ok(status)
}

/// Download, verify and install the published update, then restart into it.
///
/// Desktop only — mobile installs are the store's job. The check is repeated
/// here rather than holding the `Update` handle from `update_check`: it is one
/// cheap request against a manifest we just cached anyway, and it keeps the
/// command self-contained (the handle is neither `Clone` nor cheap to park in
/// shared state across an IPC round-trip).
///
/// Emits `update://progress` while downloading and `update://done` once the
/// bytes are in. Never returns on success — the process restarts.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    imp::install(&app).await?;

    // Windows hands off to the installer and exits before reaching this; the
    // other platforms swap the bundle in place and need the explicit restart.
    app.restart();
}

/// Open the update destination. Routed through the opener plugin's Rust API for
/// the same reason `open_external` is (lib.rs): a Rust-internal call isn't gated
/// by the opener ACL/scope. Handles the non-http `market://` / `itms-apps://`
/// schemes too; if the OS refuses those (no store app — e.g. a sideloaded build
/// on an Android device without Play), we retry with the https listing.
#[tauri::command]
pub fn update_open_download(
    app: AppHandle,
    url: String,
    fallback: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    match app.opener().open_url(url, None::<&str>) {
        Ok(()) => Ok(()),
        Err(err) => match fallback {
            Some(alt) => app
                .opener()
                .open_url(alt, None::<&str>)
                .map_err(|e| e.to_string()),
            None => Err(err.to_string()),
        },
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A blank result for `source`, stamped now. Callers fill in what they learned.
fn status_for(source: &str, current: &str) -> UpdateStatus {
    UpdateStatus {
        source: source.to_string(),
        current_version: current.to_string(),
        checked_at_ms: now_ms(),
        ..UpdateStatus::default()
    }
}

/// Is `latest` a higher version than `current`?
///
/// Numeric dotted comparison, left to right, missing components read as 0
/// (`1.2` == `1.2.0`), a leading `v` tolerated, and any pre-release/build suffix
/// ignored — so `1.2.3-beta` compares equal to `1.2.3` and does not prompt.
/// Deliberately not a full semver parse: the store version strings are not
/// guaranteed to be semver at all.
///
/// Only the store backends use this. Desktop defers to the updater plugin, which
/// does compare pre-release identifiers properly — which matters while we ship
/// `0.1.0-beta.N` builds, since this function reads every one of those as plain
/// `0.1.0`.
///
/// `allow(dead_code)`: unused on a desktop build, but it stays outside the
/// feature gate so the default build still compiles and tests it.
#[allow(dead_code)]
pub fn is_newer(latest: &str, current: &str) -> bool {
    let latest = version_parts(latest);
    let current = version_parts(current);

    for index in 0..latest.len().max(current.len()) {
        let a = latest.get(index).copied().unwrap_or(0);
        let b = current.get(index).copied().unwrap_or(0);

        if a != b {
            return a > b;
        }
    }

    false
}

#[allow(dead_code)]
fn version_parts(value: &str) -> Vec<u64> {
    value
        .trim()
        .trim_start_matches(['v', 'V'])
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse()
                .unwrap_or(0)
        })
        .collect()
}

// --------------------------------------------------------------------------
// Real checks — the `update-checks` feature (on by default).
// --------------------------------------------------------------------------
#[cfg(feature = "update-checks")]
mod imp {
    use std::time::Duration;

    use tauri::AppHandle;

    // `is_newer` / `STORE_LISTING_PUBLISHED` belong to the store backends, so a
    // desktop build imports them unused.
    #[allow(unused_imports)]
    use super::{is_newer, status_for, UpdateStatus, REPO_URL, STORE_LISTING_PUBLISHED};

    /// `allow(dead_code)` on the HTTP scaffolding below: only the store
    /// backends use it, so a desktop build compiles it unused.
    #[allow(dead_code)]
    const TIMEOUT: Duration = Duration::from_secs(10);
    /// Apple rejects requests without a User-Agent.
    #[allow(dead_code)]
    const API_USER_AGENT: &str = concat!("Hermes-Universal/", env!("CARGO_PKG_VERSION"));
    /// Play serves a different (parseable) page to a browser-shaped agent.
    #[allow(dead_code)]
    const WEB_USER_AGENT: &str =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

    #[allow(dead_code)]
    const REASON_UNREACHABLE: &str = "unreachable";
    #[allow(dead_code)]
    const REASON_UNPARSED: &str = "unparsed";
    #[allow(dead_code)]
    const REASON_STORE_PENDING: &str = "store_pending";

    /// A dedicated client, NOT `TransportState`'s — that one carries the gateway
    /// session cookie jar, which must never be sent to Google/Apple.
    #[allow(dead_code)]
    async fn get(url: &str, accept: &str, user_agent: &str) -> Option<String> {
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(user_agent)
            .build()
            .ok()?;

        let response = client.get(url).header("Accept", accept).send().await.ok()?;

        if !response.status().is_success() {
            return None;
        }

        response.text().await.ok()
    }

    // ---- desktop: the signed updater manifest -----------------------------
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub async fn check(app: &AppHandle, _identifier: &str, current: &str) -> UpdateStatus {
        use tauri_plugin_updater::UpdaterExt;

        let mut status = status_for("github", current);

        status.can_self_install = true;

        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(err) => {
                log::warn!("updater unavailable: {err}");
                status.reason = Some(REASON_UNREACHABLE.to_string());

                return status;
            }
        };

        match updater.check().await {
            Ok(Some(update)) => {
                let notes = format!("{REPO_URL}/releases/tag/v{}", update.version);

                status.update_available = true;
                status.latest_version = Some(update.version.clone());
                // Both point at the release page: self-install is the primary
                // path, and this is the fallback for a user who would rather
                // grab the installer themselves.
                status.download_url = Some(notes.clone());
                status.notes_url = Some(notes);
            }
            Ok(None) => {
                status.latest_version = Some(current.to_string());
                status.notes_url = Some(format!("{REPO_URL}/releases/latest"));
            }
            // A malformed manifest is deliberately reported as `unreachable`
            // rather than `unparsed`: unlike a scraped store listing, that
            // manifest comes out of our own release workflow, so a parse failure
            // is our bug to fix and not something to explain to the user.
            Err(err) => {
                log::warn!("update check failed: {err}");
                status.reason = Some(REASON_UNREACHABLE.to_string());
            }
        }

        status
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub async fn install(app: &AppHandle) -> Result<(), String> {
        use tauri::Emitter;
        use tauri_plugin_updater::UpdaterExt;

        let updater = app.updater().map_err(|err| err.to_string())?;
        let update = updater
            .check()
            .await
            .map_err(|err| err.to_string())?
            .ok_or_else(|| "no update available".to_string())?;

        let progress_app = app.clone();
        let done_app = app.clone();
        let mut downloaded: u64 = 0;

        update
            .download_and_install(
                move |chunk, total| {
                    downloaded += chunk as u64;

                    let _ = progress_app.emit(
                        "update://progress",
                        super::UpdateProgress { downloaded, total },
                    );
                },
                move || {
                    let _ = done_app.emit("update://done", ());
                },
            )
            .await
            .map_err(|err| err.to_string())
    }

    // ---- Android: Play Store listing --------------------------------------
    #[cfg(target_os = "android")]
    pub async fn check(_app: &AppHandle, identifier: &str, current: &str) -> UpdateStatus {
        let mut status = status_for("play", current);

        // Mocked until the listing exists. Leaving the URLs unset keeps the UI
        // from offering a "see what's new" link into a 404.
        if !STORE_LISTING_PUBLISHED {
            status.reason = Some(REASON_STORE_PENDING.to_string());

            return status;
        }

        let listing = format!("https://play.google.com/store/apps/details?id={identifier}&hl=en&gl=US");

        status.notes_url = Some(listing.clone());
        status.download_url = Some(format!("market://details?id={identifier}"));

        let Some(body) = get(&listing, "text/html", WEB_USER_AGENT).await else {
            status.reason = Some(REASON_UNREACHABLE.to_string());

            return status;
        };

        // Scraping a listing page is inherently brittle — Google changes this
        // markup without notice. A miss is "we don't know", not an error.
        let Some(version) = parse_play(&body) else {
            status.reason = Some(REASON_UNPARSED.to_string());

            return status;
        };

        status.update_available = is_newer(&version, current);
        status.latest_version = Some(version);

        status
    }

    // ---- iOS: iTunes Lookup API -------------------------------------------
    #[cfg(target_os = "ios")]
    pub async fn check(_app: &AppHandle, identifier: &str, current: &str) -> UpdateStatus {
        let mut status = status_for("appstore", current);

        if !STORE_LISTING_PUBLISHED {
            status.reason = Some(REASON_STORE_PENDING.to_string());

            return status;
        }

        let lookup = format!("https://itunes.apple.com/lookup?bundleId={identifier}&country=us");

        let Some(body) = get(&lookup, "application/json", API_USER_AGENT).await else {
            status.reason = Some(REASON_UNREACHABLE.to_string());

            return status;
        };

        // An app that isn't on the store yet returns resultCount: 0 — same
        // "we don't know" shape as a parse miss.
        let Some((version, track_url)) = parse_itunes(&body) else {
            status.reason = Some(REASON_UNPARSED.to_string());

            return status;
        };

        status.update_available = is_newer(&version, current);
        status.latest_version = Some(version);
        // itms-apps:// opens the App Store app directly instead of Safari.
        status.download_url = Some(track_url.replacen("https://", "itms-apps://", 1));
        status.notes_url = Some(track_url);

        status
    }

    /// A phone updates through its store; there is nothing for us to install.
    #[cfg(any(target_os = "android", target_os = "ios"))]
    pub async fn install(_app: &AppHandle) -> Result<(), String> {
        Err("unsupported_platform".to_string())
    }

    // ------------------------------------------------------------------
    // Parsers. Deliberately target-independent (only the `check` dispatch
    // above is `cfg`-gated) so both are compiled and unit-tested on the dev
    // host — the mobile ones would otherwise never be exercised.
    // ------------------------------------------------------------------

    /// Pull the published version out of a Play listing page. Ordered by how
    /// stable each shape has proven: the `[[["1.2.3"]]]` blob in the embedded
    /// data callback, the schema.org `softwareVersion` field, then the visible
    /// "Current Version" label.
    #[allow(dead_code)]
    pub fn parse_play(body: &str) -> Option<String> {
        use std::sync::OnceLock;

        use regex::Regex;

        static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();

        let patterns = PATTERNS.get_or_init(|| {
            [
                r#"\[\[\["(\d+(?:\.\d+)+[^"]*)"\]\]"#,
                r#""softwareVersion"\s*:\s*"(\d+(?:\.\d+)*[^"]*)""#,
                r#"(?s)Current Version.{0,200}?>\s*(\d+(?:\.\d+)+)\s*<"#,
            ]
            .iter()
            .filter_map(|pattern| Regex::new(pattern).ok())
            .collect()
        });

        for pattern in patterns {
            if let Some(captures) = pattern.captures(body) {
                let value = captures.get(1)?.as_str().trim();

                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }

        None
    }

    #[derive(serde::Deserialize)]
    struct ItunesLookup {
        #[serde(default)]
        results: Vec<ItunesResult>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ItunesResult {
        #[serde(default)]
        version: String,
        #[serde(default)]
        track_view_url: String,
    }

    /// `(version, storeUrl)` from an iTunes Lookup response. An app that isn't
    /// published yet answers `resultCount: 0`, which lands here as `None`.
    #[allow(dead_code)]
    pub fn parse_itunes(body: &str) -> Option<(String, String)> {
        let lookup: ItunesLookup = serde_json::from_str(body).ok()?;
        let first = lookup.results.into_iter().next()?;
        let version = first.version.trim().to_string();

        if version.is_empty() {
            return None;
        }

        Some((version, first.track_view_url))
    }
}

// --------------------------------------------------------------------------
// Stub — `--no-default-features`. Same signatures, so everything above is
// identical either way and `generate_handler!` never changes shape.
// --------------------------------------------------------------------------
#[cfg(not(feature = "update-checks"))]
mod imp {
    use tauri::AppHandle;

    use super::{status_for, UpdateStatus};

    pub async fn check(_app: &AppHandle, _identifier: &str, current: &str) -> UpdateStatus {
        let mut status = status_for("disabled", current);

        status.reason = Some("checks_disabled".to_string());

        status
    }

    pub async fn install(_app: &AppHandle) -> Result<(), String> {
        Err("checks_disabled".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("1.2.4", "1.2.3"));
        assert!(is_newer("1.3.0", "1.2.9"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(is_newer("1.2.3", "1.2"));
        assert!(is_newer("0.0.2", "0.0.1"));
    }

    #[test]
    fn is_not_newer_when_same_or_older() {
        assert!(!is_newer("1.2.3", "1.2.3"));
        assert!(!is_newer("1.2", "1.2.0"));
        assert!(!is_newer("1.2.3", "1.2.4"));
        assert!(!is_newer("0.9.9", "1.0.0"));
    }

    #[test]
    fn tolerates_v_prefix_and_suffixes() {
        assert!(is_newer("v1.2.4", "1.2.3"));
        assert!(!is_newer("1.2.3-beta.1", "1.2.3"));
        assert!(is_newer("1.2.4-rc1", "1.2.3"));
        assert!(!is_newer("", "1.0.0"));
    }

    /// The store comparison cannot tell one beta from the next, which is why
    /// desktop uses the updater plugin's semver instead. Pinned so nobody
    /// "fixes" the desktop path back onto this helper while we ship betas.
    #[test]
    fn cannot_order_prereleases_of_the_same_version() {
        assert!(!is_newer("0.1.0-beta.2", "0.1.0-beta.1"));
    }
}

#[cfg(all(test, feature = "update-checks"))]
mod backend_tests {
    use super::imp::{parse_itunes, parse_play};

    #[test]
    fn reads_the_play_version_blob() {
        let body = r#"…,[[["2.7.1"]],[[["Aug 1, 2026"]]],…"#;

        assert_eq!(parse_play(body).as_deref(), Some("2.7.1"));
    }

    #[test]
    fn reads_the_play_software_version_field() {
        let body = r#"{"@type":"SoftwareApplication","softwareVersion":"3.0.4"}"#;

        assert_eq!(parse_play(body).as_deref(), Some("3.0.4"));
    }

    #[test]
    fn returns_none_when_play_markup_changes() {
        assert!(parse_play("<html><body>nothing useful here</body></html>").is_none());
    }

    #[test]
    fn reads_an_itunes_lookup() {
        let body = r#"{"resultCount":1,"results":[{"version":"5.2.0","trackViewUrl":"https://apps.apple.com/us/app/hermes/id123"}]}"#;
        let (version, url) = parse_itunes(body).expect("parsed");

        assert_eq!(version, "5.2.0");
        assert_eq!(url, "https://apps.apple.com/us/app/hermes/id123");
    }

    #[test]
    fn returns_none_for_an_unlisted_app() {
        assert!(parse_itunes(r#"{"resultCount":0,"results":[]}"#).is_none());
        assert!(parse_itunes("nope").is_none());
    }
}
