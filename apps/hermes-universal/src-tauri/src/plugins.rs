//! The LOCAL plugin door — TWO roots under `$HERMES_HOME[/profiles/<p>]`:
//!   * `desktop-plugins/<name>/plugin.js` — the user's own drop folder;
//!   * `plugins/<name>/desktop/plugin.js` — the desktop half of a unified agent
//!     package, i.e. whatever `plugins.manage{action:"install"}` cloned.
//!
//! The second root is the whole reason installing a plugin needs no client-side
//! git: the gateway clones into `plugins/<name>/`, and if that package carries a
//! desktop half it lands exactly where this door already looks.
//!
//! Port of the Electron `hermes:fs:desktopPluginsRoot` + readDir/readFileText
//! trio (apps/desktop/electron/main.ts:10910) onto Tauri/Rust.
//!
//! SECURITY / TRUST: this door only READS files. The webview evaluates what comes
//! back, which is error isolation, not a capability boundary — a plugin runs with
//! the app's full authority. What these commands do guarantee is the ADDRESS
//! SPACE: a folder NAME is the only thing a caller may supply, never a path. No
//! command accepts an absolute path, so there is no scope to misconfigure and no
//! way to read outside the plugin root.
//!
//! Deliberately narrow commands rather than `tauri-plugin-fs` grants:
//!   * fs scopes are static and cannot express a runtime profile segment
//!     (`$HOME/.hermes/profiles/<active profile>/desktop-plugins`);
//!   * `fs:allow-watch` is not in the capability set, and enabling it is a whole
//!     feature flag;
//!   * handing the webview a general read-dir primitive widens the renderer's
//!     authority for a door that is explicitly not a trust boundary.
//! `marketplace_search`/`marketplace_fetch` is the in-repo precedent.
//!
//! LOCALITY IS THE INVARIANT (desktop bug #66899): the root is resolved from THIS
//! machine's HERMES_HOME, never from the connected backend's `hermes_home`. A
//! remote backend must not be able to point the local loader at its own files;
//! that path exists deliberately and separately as the frontend's REST door.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

const PLUGIN_DIR: &str = "desktop-plugins";
const PLUGIN_ENTRY: &str = "plugin.js";
const AGENT_PACKAGE_DIR: &str = "plugins";
const AGENT_PACKAGE_ENTRY: &str = "desktop/plugin.js";

/// WHICH root a call addresses.
///
/// `None` on the wire means `DesktopPlugins`, so every pre-existing call site is
/// byte-identical — and, more importantly, the entry file is chosen by this ENUM
/// rather than by the caller, so the address-space invariant above survives a
/// second root without a second guard: `AgentPackages` cannot be used to read an
/// arbitrary sub-path.
#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginRoot {
    #[default]
    DesktopPlugins,
    /// Installed-but-INERT until the user allowlists it (GHSA-mcfc-hp25-cjv7):
    /// an agent package's python half is opt-in, so its desktop half must be
    /// too. The frontend caps this root's `defaultEnabled` to false.
    AgentPackages,
}

impl PluginRoot {
    /// Directory under the (profile-resolved) hermes home.
    fn dir(self) -> &'static str {
        match self {
            Self::DesktopPlugins => PLUGIN_DIR,
            Self::AgentPackages => AGENT_PACKAGE_DIR,
        }
    }

    /// Entry file, relative to `<root>/<name>/`.
    fn entry(self) -> &'static str {
        match self {
            Self::DesktopPlugins => PLUGIN_ENTRY,
            Self::AgentPackages => AGENT_PACKAGE_ENTRY,
        }
    }
}

/// One discovered plugin folder.
#[derive(Serialize)]
pub struct PluginDirEntry {
    /// Folder name — the ONLY handle `plugins_read` accepts.
    name: String,
    /// Absolute path to the entry file, for display + "reveal in file manager".
    file: String,
    /// Which root it came from. The frontend keys its records on `file` (folder
    /// names collide across roots) and shows this as the row's badge.
    root: PluginRoot,
    /// Modification time in ms; the frontend polls this to spot an edit without
    /// re-reading the source.
    ///
    /// NOTE the serde spelling: this struct is deliberately NOT
    /// `rename_all = "camelCase"` — `plugin-disk.ts` reads `mtime_ms`, and
    /// renaming it would break that reader silently.
    mtime_ms: u64,
    size: u64,
}

/// This machine's HERMES_HOME: the explicit env var if set, else the platform
/// default desktop uses (%LOCALAPPDATA%\hermes on Windows, ~/.hermes elsewhere).
///
/// The env override matters: `local_backend` passes HERMES_HOME to the backend it
/// spawns, but computed the default without honouring an existing value — so a
/// user running with a custom HERMES_HOME would have had the plugin root and the
/// backend disagree.
pub(crate) fn hermes_home() -> Option<PathBuf> {
    resolve_hermes_home(std::env::var("HERMES_HOME").ok(), platform_hermes_home)
}

/// Apply the override rule to a HERMES_HOME value already read out of the
/// environment: a set-but-blank value is not an override.
///
/// Split out from `hermes_home` for the same reason `plugin_root_under` is split
/// out of `root_for` — so the rule is testable WITHOUT mutating the process
/// environment. `cargo test` runs a crate's tests as threads in one process, and
/// on glibc a `setenv` can reallocate `environ` under a concurrent `getenv`,
/// which is a data race regardless of what the assertions expect.
fn resolve_hermes_home(
    explicit: Option<String>,
    platform: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(explicit) = explicit {
        let trimmed = explicit.trim();

        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }

    platform()
}

/// The platform default desktop uses, with no override applied.
fn platform_hermes_home() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|p| PathBuf::from(p).join("hermes"))
    } else {
        std::env::var("HOME")
            .ok()
            .map(|p| PathBuf::from(p).join(".hermes"))
    }
}

/// Resolve the plugin root for `profile` under `home`. Profile-aware exactly like
/// the Electron resolver: the default profile lives at the home root, a named one
/// under `profiles/<name>/`.
///
/// Split out from `root_for` so it is testable WITHOUT touching the process
/// environment — cargo runs tests in parallel threads, and mutating a global env
/// var made these races against each other.
fn plugin_root_under(
    home: PathBuf,
    profile: Option<&str>,
    root: PluginRoot,
) -> Result<PathBuf, String> {
    let mut base = home;

    if let Some(name) = profile.map(str::trim).filter(|p| !p.is_empty()) {
        if name != "default" && name != "current" {
            // A profile name is user data; it must not be able to climb out.
            if !safe_segment(name) {
                return Err(format!("illegal profile name \"{name}\""));
            }

            base = base.join("profiles").join(name);
        }
    }

    Ok(base.join(root.dir()))
}

fn root_for(profile: Option<String>, root: PluginRoot) -> Result<PathBuf, String> {
    let home = hermes_home().ok_or("could not resolve HERMES_HOME on this platform")?;

    plugin_root_under(home, profile.as_deref(), root)
}

/// A single, well-behaved path segment: no separators, no traversal, not hidden.
fn safe_segment(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

/// Absolute path of the plugin root, created on demand so a "reveal" always has
/// somewhere to go. Creation failure is not fatal — the path is still returned so
/// the caller can show a real error instead of an empty inventory.
#[tauri::command]
pub fn plugins_root(profile: Option<String>, root: Option<PluginRoot>) -> Result<String, String> {
    let path = root_for(profile, root.unwrap_or_default())?;
    let _ = std::fs::create_dir_all(&path);

    Ok(path.to_string_lossy().to_string())
}

/// Every `<root>/<name>/plugin.js` that exists and is readable. A folder without
/// a readable entry file is not a plugin and is skipped silently — the directory
/// is a user-writable drop point, so stray files are expected, not errors.
#[tauri::command]
pub fn plugins_list(
    profile: Option<String>,
    root: Option<PluginRoot>,
) -> Result<Vec<PluginDirEntry>, String> {
    let root = root.unwrap_or_default();

    list_plugins_under(&root_for(profile, root)?, root)
}

/// The inventory itself, against an explicit root — testable without resolving
/// (and therefore without mutating) HERMES_HOME.
fn list_plugins_under(path: &Path, root: PluginRoot) -> Result<Vec<PluginDirEntry>, String> {
    let dir = match std::fs::read_dir(path) {
        Ok(dir) => dir,
        // No root yet = no plugins yet. The scanner should see an empty list, not
        // an error it has to special-case on every poll tick.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("could not read {}: {err}", path.display())),
    };

    let mut out = Vec::new();

    for entry in dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();

        if !safe_segment(&name) || !entry.path().is_dir() {
            continue;
        }

        let file = entry.path().join(root.entry());

        let Ok(meta) = std::fs::metadata(&file) else {
            continue;
        };

        if !meta.is_file() {
            continue;
        }

        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        out.push(PluginDirEntry {
            name,
            file: file.to_string_lossy().to_string(),
            root,
            mtime_ms,
            size: meta.len(),
        });
    }

    // Stable order so the inventory doesn't reshuffle between polls.
    out.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(out)
}

/// Source of `<root>/<name>/plugin.js`. `name` is a folder name, never a path —
/// anything with a separator or traversal is refused before touching the disk.
#[tauri::command]
pub fn plugins_read(
    profile: Option<String>,
    root: Option<PluginRoot>,
    name: String,
) -> Result<String, String> {
    if !safe_segment(&name) {
        return Err(format!("illegal plugin name \"{name}\""));
    }

    let root = root.unwrap_or_default();
    let file = root_for(profile, root)?.join(&name).join(root.entry());

    std::fs::read_to_string(&file)
        .map_err(|err| format!("could not read {}: {err}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_names_that_could_escape_the_root() {
        for name in ["..", ".", "", "a/b", "a\\b", "../etc", ".hidden", "a\0b"] {
            assert!(!safe_segment(name), "{name} should be refused");
        }
    }

    #[test]
    fn accepts_ordinary_folder_names() {
        for name in ["kanban", "cost-meter", "my_plugin", "a.b"] {
            assert!(safe_segment(name), "{name} should be allowed");
        }
    }

    #[test]
    fn plugins_read_refuses_a_path_instead_of_a_name() {
        // Assert the REFUSAL, not merely an error. Both of these fail on
        // `is_err()` even with the guard deleted — `<root>/../../etc/passwd`
        // and `/etc/passwd` (which `Path::join` substitutes wholesale) simply
        // have no `plugin.js`, so the read fails on its own. Only the message
        // separates "the address space forbids this" from "that file happened
        // not to exist", and the address space is this module's one invariant.
        // BOTH roots: a second root is a second chance to forget the guard.
        for root in [None, Some(PluginRoot::AgentPackages)] {
            for name in ["../../etc/passwd", "/etc/passwd", "..", ".hidden", "a\0b"] {
                let err = plugins_read(None, root, name.into()).unwrap_err();

                assert!(
                    err.starts_with("illegal plugin name"),
                    "{name} should be refused by name, got: {err}"
                );
            }
        }
    }

    fn home() -> PathBuf {
        PathBuf::from("/tmp/hermes-test-home")
    }

    fn root_under(profile: Option<&str>) -> PathBuf {
        plugin_root_under(home(), profile, PluginRoot::default()).unwrap()
    }

    #[test]
    fn default_profile_uses_the_home_root_and_named_profiles_nest() {
        let default = root_under(None);
        let explicit_default = root_under(Some("default"));
        let current = root_under(Some("current"));
        let blank = root_under(Some("  "));
        let named = root_under(Some("work"));

        assert_eq!(default, home().join("desktop-plugins"));
        // "default" / "current" / blank all mean the home root, not a subfolder.
        assert_eq!(default, explicit_default);
        assert_eq!(default, current);
        assert_eq!(default, blank);
        assert_eq!(
            named,
            home().join("profiles").join("work").join("desktop-plugins")
        );
    }

    #[test]
    fn a_bad_profile_name_is_refused() {
        for root in [PluginRoot::DesktopPlugins, PluginRoot::AgentPackages] {
            for profile in ["../escape", "a/b", "a\\b", ".hidden"] {
                assert!(
                    plugin_root_under(home(), Some(profile), root).is_err(),
                    "{profile} should be refused"
                );
            }
        }
    }

    #[test]
    fn the_agent_package_root_is_plugins_with_a_desktop_entry() {
        // The unified package layout the gateway's installer writes:
        // `<home>/plugins/<name>/desktop/plugin.js`, NOT a `plugin.js` at the
        // folder root. Getting this wrong makes every installed package look
        // like it has no desktop half.
        assert_eq!(
            plugin_root_under(home(), None, PluginRoot::AgentPackages).unwrap(),
            home().join("plugins")
        );
        assert_eq!(PluginRoot::AgentPackages.entry(), "desktop/plugin.js");
        assert_eq!(PluginRoot::DesktopPlugins.entry(), "plugin.js");

        // ...and the profile nesting still applies to it.
        assert_eq!(
            plugin_root_under(home(), Some("work"), PluginRoot::AgentPackages).unwrap(),
            home().join("profiles").join("work").join("plugins")
        );
    }

    #[test]
    fn the_root_serializes_as_the_kebab_literal_the_frontend_sends() {
        assert_eq!(
            serde_json::to_string(&PluginRoot::AgentPackages).unwrap(),
            "\"agent-packages\""
        );
        assert_eq!(
            serde_json::to_string(&PluginRoot::DesktopPlugins).unwrap(),
            "\"desktop-plugins\""
        );
        assert!(matches!(
            serde_json::from_str::<PluginRoot>("\"agent-packages\"").unwrap(),
            PluginRoot::AgentPackages
        ));
    }

    // These used to set HERMES_HOME and restore it, which raced every `getenv`
    // in every other test thread — cargo runs a crate's tests in one process.
    // They go through the `resolve_hermes_home` / `list_plugins_under` seams
    // instead, so nothing here writes the process environment.

    #[test]
    fn honours_an_explicit_hermes_home() {
        let platform = || Some(PathBuf::from("/platform/.hermes"));

        assert_eq!(
            resolve_hermes_home(Some("/tmp/custom-home".into()), platform),
            Some(PathBuf::from("/tmp/custom-home"))
        );
        // Surrounding whitespace is trimmed off a real value.
        assert_eq!(
            resolve_hermes_home(Some("  /tmp/custom-home  ".into()), platform),
            Some(PathBuf::from("/tmp/custom-home"))
        );
        // A blank value must not shadow the platform default — it must yield the
        // platform default, not the blank string and not `None`.
        assert_eq!(
            resolve_hermes_home(Some("  ".into()), platform),
            Some(PathBuf::from("/platform/.hermes"))
        );
        assert_eq!(
            resolve_hermes_home(None, platform),
            Some(PathBuf::from("/platform/.hermes"))
        );
        // No override and no platform home is "unknown", not a bare root.
        assert_eq!(resolve_hermes_home(None, || None), None);
    }

    #[test]
    fn listing_a_missing_root_is_empty_not_an_error() {
        for root in [PluginRoot::DesktopPlugins, PluginRoot::AgentPackages] {
            let listed = list_plugins_under(Path::new("/tmp/hermes-does-not-exist-XYZ"), root);

            assert_eq!(listed.unwrap().len(), 0);
        }
    }

    #[test]
    fn each_root_lists_only_folders_carrying_its_own_entry_file() {
        let base = std::env::temp_dir().join(format!(
            "hermes-plugin-roots-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);

        // A folder with a bare `plugin.js` is a desktop-plugins plugin; the same
        // folder name under the package root needs `desktop/plugin.js`.
        std::fs::create_dir_all(base.join("desktop-plugins").join("demo")).unwrap();
        std::fs::write(
            base.join("desktop-plugins").join("demo").join("plugin.js"),
            "export default {}",
        )
        .unwrap();

        std::fs::create_dir_all(base.join("plugins").join("demo").join("desktop")).unwrap();
        std::fs::write(
            base.join("plugins")
                .join("demo")
                .join("desktop")
                .join("plugin.js"),
            "export default {}",
        )
        .unwrap();
        // A package with NO desktop half — the common case, and it must not be
        // inventoried as a client plugin.
        std::fs::create_dir_all(base.join("plugins").join("python-only")).unwrap();
        std::fs::write(
            base.join("plugins").join("python-only").join("plugin.js"),
            "not the entry for this root",
        )
        .unwrap();

        let desktop =
            list_plugins_under(&base.join("desktop-plugins"), PluginRoot::DesktopPlugins).unwrap();
        let packages =
            list_plugins_under(&base.join("plugins"), PluginRoot::AgentPackages).unwrap();

        assert_eq!(desktop.len(), 1);
        assert!(desktop[0].file.ends_with("desktop-plugins/demo/plugin.js"));

        // Same folder NAME in both roots, two different files — which is why the
        // frontend keys its records on `file` rather than on `name`.
        assert_eq!(packages.len(), 1);
        assert_eq!(packages[0].name, "demo");
        assert!(packages[0].file.ends_with("plugins/demo/desktop/plugin.js"));

        let _ = std::fs::remove_dir_all(&base);
    }
}
