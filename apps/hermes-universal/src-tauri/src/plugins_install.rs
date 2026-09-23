//! Probe / install / remove STANDALONE desktop plugins from Git.
//!
//! Port of Electron `desktop-plugin-install.ts` + `desktop-plugin-remove.ts`.
//! The read inventory stays in [`crate::plugins`]; this module only mutates
//! `$HERMES_HOME/desktop-plugins/<name>/`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::plugins::{root_for, safe_segment, PluginRoot};

const PACKAGE_MARKER: &str = ".hermes-package.json";
const GITHUB_BROWSER_SEGMENTS: &[&str] = &["tree", "blob", "commit"];

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedGitUrl {
    git_url: String,
    subdir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PluginComponentDetection {
    agent: bool,
    desktop: bool,
    agent_name: Option<String>,
    desktop_source_subdir: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProbeResult {
    ok: bool,
    agent: bool,
    desktop: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    desktop_name: Option<String>,
    warnings: Vec<String>,
    insecure: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPluginInstallResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugin_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveDesktopPluginResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Resolve a user-typed identifier into a clone URL + optional subdirectory.
fn resolve_plugin_git_url(identifier: &str) -> Result<ResolvedGitUrl, String> {
    let trimmed = identifier.trim();
    if trimmed.is_empty() {
        return Err("Plugin identifier is required.".to_string());
    }

    let looks_like_url = trimmed.starts_with("https://")
        || trimmed.starts_with("http://")
        || trimmed.starts_with("git@")
        || trimmed.starts_with("ssh://")
        || trimmed.starts_with("file://");

    if looks_like_url {
        if let Some(rest) = trimmed.strip_prefix("https://github.com/") {
            let rest = rest
                .split(['?', '#'])
                .next()
                .unwrap_or(rest)
                .trim_end_matches('/');
            let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();

            if parts.len() >= 3 && GITHUB_BROWSER_SEGMENTS.contains(&parts[2]) {
                let owner = parts[0];
                let repo = parts[1].trim_end_matches(".git");
                let mut subdir = None;

                if parts[2] == "tree" && parts.len() >= 5 {
                    let joined = parts[4..].join("/");
                    let cleaned = joined.trim_end_matches('/');
                    if !cleaned.is_empty() {
                        subdir = Some(cleaned.to_string());
                    }
                }

                return Ok(ResolvedGitUrl {
                    git_url: format!("https://github.com/{owner}/{repo}.git"),
                    subdir,
                });
            }
        }

        if let Some(hash_idx) = trimmed.find('#') {
            let git_url = trimmed[..hash_idx].to_string();
            let subdir = trimmed[hash_idx + 1..].trim_matches('/').to_string();
            return Ok(ResolvedGitUrl {
                git_url,
                subdir: if subdir.is_empty() {
                    None
                } else {
                    Some(subdir)
                },
            });
        }

        if let Some(idx) = trimmed.find(".git/") {
            let end = idx + ".git".len();
            let git_url = trimmed[..end].to_string();
            let subdir = trimmed[end + 1..].trim_matches('/').to_string();
            return Ok(ResolvedGitUrl {
                git_url,
                subdir: if subdir.is_empty() {
                    None
                } else {
                    Some(subdir)
                },
            });
        }

        return Ok(ResolvedGitUrl {
            git_url: trimmed.to_string(),
            subdir: None,
        });
    }

    let parts: Vec<&str> = trimmed.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() >= 2 {
        let owner = parts[0];
        let repo = parts[1];
        let subdir = if parts.len() > 2 {
            let joined = parts[2..].join("/");
            let cleaned = joined.trim_end_matches('/');
            if cleaned.is_empty() {
                None
            } else {
                Some(cleaned.to_string())
            }
        } else {
            None
        };

        return Ok(ResolvedGitUrl {
            git_url: format!("https://github.com/{owner}/{repo}.git"),
            subdir,
        });
    }

    Err(
        "Invalid plugin identifier. Use a Git URL or 'owner/repo' (optionally with a subdirectory)."
            .to_string(),
    )
}

fn repo_name_from_url(url: &str) -> String {
    let mut name = url.trim_end_matches('/').to_string();
    if name.ends_with(".git") {
        name.truncate(name.len() - 4);
    }
    let mut name = name.rsplit('/').next().unwrap_or(&name).to_string();
    if name.contains(':') {
        name = name.rsplit(':').next().unwrap_or(&name).to_string();
        name = name.rsplit('/').next().unwrap_or(&name).to_string();
    }
    name
}

fn desktop_plugin_folder_name(git_url: &str, subdir: Option<&str>) -> String {
    if let Some(subdir) = subdir {
        if let Some(last) = subdir
            .split(['/', '\\'])
            .filter(|part| !part.is_empty() && *part != "." && *part != "desktop")
            .next_back()
        {
            return last.to_string();
        }
    }
    repo_name_from_url(git_url)
}

fn resolve_subdir_within(clone_root: &Path, subdir: &str) -> Result<PathBuf, String> {
    let root = clone_root
        .canonicalize()
        .unwrap_or_else(|_| clone_root.to_path_buf());
    let candidate = root.join(subdir);
    let candidate = candidate
        .canonicalize()
        .map_err(|_| format!("Plugin subdirectory '{subdir}' does not exist in the repository."))?;

    if candidate != root && !candidate.starts_with(&root) {
        return Err(format!(
            "Plugin subdirectory '{subdir}' escapes the repository."
        ));
    }

    Ok(candidate)
}

fn find_desktop_entry(plugin_root: &Path) -> Option<(PathBuf, String)> {
    let root_plugin = plugin_root.join("plugin.js");
    if root_plugin.is_file() {
        return Some((root_plugin, ".".to_string()));
    }
    let nested = plugin_root.join("desktop").join("plugin.js");
    if nested.is_file() {
        return Some((nested, "desktop".to_string()));
    }
    None
}

fn detect_plugin_components(plugin_root: &Path) -> PluginComponentDetection {
    let has_yaml =
        plugin_root.join("plugin.yaml").is_file() || plugin_root.join("plugin.yml").is_file();
    let has_init = plugin_root.join("__init__.py").is_file();
    let has_portable = plugin_root.join("plugin.json").is_file();
    let agent = (has_yaml && has_init) || has_portable;

    let desktop_entry = find_desktop_entry(plugin_root);
    let desktop = desktop_entry.is_some();

    let mut agent_name = None;
    if agent {
        agent_name = Some(
            plugin_root
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "plugin".to_string()),
        );

        if has_yaml {
            let yaml_path = if plugin_root.join("plugin.yaml").is_file() {
                plugin_root.join("plugin.yaml")
            } else {
                plugin_root.join("plugin.yml")
            };
            if let Ok(text) = std::fs::read_to_string(yaml_path) {
                if let Some(cap) = regex_name_line(&text) {
                    agent_name = Some(cap);
                }
            }
        } else if has_portable {
            if let Ok(raw) = std::fs::read_to_string(plugin_root.join("plugin.json")) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(name) = parsed.get("name").and_then(|v| v.as_str()) {
                        agent_name = Some(name.to_string());
                    }
                }
            }
        }
    }

    PluginComponentDetection {
        agent,
        desktop,
        agent_name,
        desktop_source_subdir: desktop_entry.map(|(_, sub)| sub),
    }
}

fn regex_name_line(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("name:") {
            let value = rest.trim().trim_matches(['\'', '"']).trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn insecure_scheme_warnings(git_url: &str) -> (Vec<String>, bool) {
    if git_url.starts_with("http://") || git_url.starts_with("file://") {
        (
            vec![
                "This URL uses an insecure or local scheme. Prefer https:// or git@ for production installs."
                    .to_string(),
            ],
            true,
        )
    } else {
        (Vec::new(), false)
    }
}

fn run_git(args: &[&str], cwd: Option<&Path>) -> Result<(), String> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "echo")
        .env("SSH_ASKPASS", "echo");

    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("could not run git: {e}. Is git installed?"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Git clone failed:\n{}", stderr.trim()))
    }
}

fn scratch_dir(prefix: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!(
        "{prefix}{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create temp dir: {e}"))?;
    Ok(dir)
}

fn clone_to_temp(git_url: &str) -> Result<PathBuf, String> {
    let tmp = scratch_dir("hermes-plugin-")?;

    // Clone into a child of the tempdir — the tempdir itself already exists and
    // git refuses a non-empty destination.
    let clone_dest = tmp.join("repo");
    if let Err(e) = run_git(
        &[
            "clone",
            "--depth",
            "1",
            git_url,
            &clone_dest.to_string_lossy(),
        ],
        None,
    ) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }

    Ok(tmp)
}

fn resolve_plugin_root(clone_root: &Path, subdir: Option<&str>) -> Result<PathBuf, String> {
    match subdir {
        None => Ok(clone_root.to_path_buf()),
        Some(subdir) => {
            let resolved = resolve_subdir_within(clone_root, subdir)?;
            if !resolved.is_dir() {
                return Err(format!(
                    "Plugin subdirectory '{subdir}' does not exist in the repository."
                ));
            }
            Ok(resolved)
        }
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("could not create {}: {e}", dst.display()))?;
    for entry in
        std::fs::read_dir(src).map_err(|e| format!("could not read {}: {e}", src.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if ty.is_file() || ty.is_symlink() {
            std::fs::copy(entry.path(), &to)
                .map_err(|e| format!("could not copy {}: {e}", entry.path().display()))?;
        }
    }
    Ok(())
}

fn publish_desktop_tree(source_dir: &Path, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "plugin target has no parent".to_string())?;
    let name = target
        .file_name()
        .ok_or_else(|| "plugin target has no name".to_string())?;

    std::fs::create_dir_all(parent)
        .map_err(|e| format!("could not create {}: {e}", parent.display()))?;

    // Stage under the parent so rename stays on the same volume.
    let staging_root = parent.join(format!(
        ".{}-staging-{}-{}",
        name.to_string_lossy(),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&staging_root).map_err(|e| format!("could not stage plugin: {e}"))?;
    let staged = staging_root.join(name);

    let result = (|| {
        copy_dir_recursive(source_dir, &staged)?;
        let _ = std::fs::remove_dir_all(target);
        std::fs::rename(&staged, target)
            .map_err(|e| format!("could not finalize plugin install: {e}"))?;
        Ok(())
    })();

    let _ = std::fs::remove_dir_all(&staging_root);
    result
}

fn probe_inner(identifier: &str) -> PluginProbeResult {
    match (|| -> Result<PluginProbeResult, String> {
        let resolved = resolve_plugin_git_url(identifier)?;
        let (warnings, insecure) = insecure_scheme_warnings(&resolved.git_url);
        let tmp = clone_to_temp(&resolved.git_url)?;
        let clone_root = tmp.join("repo");
        let result = (|| {
            let plugin_root = resolve_plugin_root(&clone_root, resolved.subdir.as_deref())?;
            let detected = detect_plugin_components(&plugin_root);
            let repo_fallback = repo_name_from_url(&resolved.git_url);

            if !detected.agent && !detected.desktop {
                return Ok(PluginProbeResult {
                    ok: false,
                    agent: false,
                    desktop: false,
                    agent_name: None,
                    desktop_name: None,
                    warnings: warnings.clone(),
                    insecure,
                    error: Some(
                        "No agent or desktop plugin artifacts found in this repository."
                            .to_string(),
                    ),
                });
            }

            Ok(PluginProbeResult {
                ok: true,
                agent: detected.agent,
                desktop: detected.desktop,
                agent_name: detected
                    .agent_name
                    .or_else(|| detected.agent.then_some(repo_fallback)),
                desktop_name: detected.desktop.then(|| {
                    desktop_plugin_folder_name(&resolved.git_url, resolved.subdir.as_deref())
                }),
                warnings: warnings.clone(),
                insecure,
                error: None,
            })
        })();
        let _ = std::fs::remove_dir_all(&tmp);
        result
    })() {
        Ok(result) => result,
        Err(error) => PluginProbeResult {
            ok: false,
            agent: false,
            desktop: false,
            agent_name: None,
            desktop_name: None,
            warnings: Vec::new(),
            insecure: false,
            error: Some(error),
        },
    }
}

fn install_inner(identifier: &str, force: bool) -> DesktopPluginInstallResult {
    match (|| -> Result<DesktopPluginInstallResult, String> {
        let resolved = resolve_plugin_git_url(identifier)?;
        let tmp = clone_to_temp(&resolved.git_url)?;
        let clone_root = tmp.join("repo");
        let result = (|| {
            let plugin_root = resolve_plugin_root(&clone_root, resolved.subdir.as_deref())?;
            let detected = detect_plugin_components(&plugin_root);

            let Some(source_subdir) = detected.desktop_source_subdir.filter(|_| detected.desktop)
            else {
                return Ok(DesktopPluginInstallResult {
                    ok: false,
                    plugin_name: None,
                    path: None,
                    error: Some("No desktop plugin.js found in this repository.".to_string()),
                });
            };

            let source_dir = if source_subdir == "." {
                plugin_root.clone()
            } else {
                plugin_root.join(&source_subdir)
            };

            let plugin_name =
                desktop_plugin_folder_name(&resolved.git_url, resolved.subdir.as_deref());
            if !safe_segment(&plugin_name) {
                return Err(format!("illegal plugin folder name \"{plugin_name}\""));
            }

            let desktop_root = root_for(None, PluginRoot::DesktopPlugins)?;
            std::fs::create_dir_all(&desktop_root)
                .map_err(|e| format!("could not create {}: {e}", desktop_root.display()))?;

            let target_dir = desktop_root.join(&plugin_name);
            let target_plugin = target_dir.join("plugin.js");

            if target_dir.is_dir() || target_plugin.is_file() {
                if !force {
                    return Ok(DesktopPluginInstallResult {
                        ok: false,
                        plugin_name: None,
                        path: None,
                        error: Some(format!(
                            "Desktop plugin '{plugin_name}' already exists. Enable force reinstall to replace it."
                        )),
                    });
                }
                let _ = std::fs::remove_dir_all(&target_dir);
            }

            publish_desktop_tree(&source_dir, &target_dir)?;

            if !target_plugin.is_file() {
                return Ok(DesktopPluginInstallResult {
                    ok: false,
                    plugin_name: None,
                    path: None,
                    error: Some(format!(
                        "Install completed but {} is missing.",
                        target_plugin.display()
                    )),
                });
            }

            Ok(DesktopPluginInstallResult {
                ok: true,
                plugin_name: Some(plugin_name),
                path: Some(target_dir.to_string_lossy().to_string()),
                error: None,
            })
        })();
        let _ = std::fs::remove_dir_all(&tmp);
        result
    })() {
        Ok(result) => result,
        Err(error) => DesktopPluginInstallResult {
            ok: false,
            plugin_name: None,
            path: None,
            error: Some(error),
        },
    }
}

fn remove_inner(raw_name: &str) -> RemoveDesktopPluginResult {
    let name = raw_name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return RemoveDesktopPluginResult {
            ok: false,
            path: None,
            error: Some("invalid plugin folder name".to_string()),
        };
    }

    let root = match root_for(None, PluginRoot::DesktopPlugins) {
        Ok(root) => root,
        Err(error) => {
            return RemoveDesktopPluginResult {
                ok: false,
                path: None,
                error: Some(error),
            };
        }
    };

    let target = root.join(name);
    // Containment: the resolved path's file name must equal `name` and live
    // directly under the root (no `..` climb).
    if target.strip_prefix(&root).ok().and_then(|rel| rel.to_str()) != Some(name) {
        return RemoveDesktopPluginResult {
            ok: false,
            path: None,
            error: Some(format!("{name} is not inside the desktop-plugins folder")),
        };
    }

    let meta = match std::fs::symlink_metadata(&target) {
        Ok(meta) => meta,
        Err(_) => {
            return RemoveDesktopPluginResult {
                ok: false,
                path: None,
                error: Some(format!("{name} is not installed")),
            };
        }
    };

    if !meta.is_dir() && !meta.file_type().is_symlink() {
        return RemoveDesktopPluginResult {
            ok: false,
            path: None,
            error: Some(format!("{name} is not a plugin folder")),
        };
    }

    if meta.is_dir() && target.join(PACKAGE_MARKER).exists() {
        return RemoveDesktopPluginResult {
            ok: false,
            path: None,
            error: Some(format!(
                "{name} is the desktop half of an agent plugin — uninstall that plugin instead"
            )),
        };
    }

    match std::fs::remove_dir_all(&target) {
        Ok(()) => RemoveDesktopPluginResult {
            ok: true,
            path: Some(target.to_string_lossy().to_string()),
            error: None,
        },
        Err(error) => RemoveDesktopPluginResult {
            ok: false,
            path: None,
            error: Some(error.to_string()),
        },
    }
}

#[tauri::command]
pub async fn plugins_probe(identifier: Option<String>, repo: Option<String>) -> PluginProbeResult {
    let id = identifier.or(repo).unwrap_or_default().trim().to_string();
    if id.is_empty() {
        return PluginProbeResult {
            ok: false,
            agent: false,
            desktop: false,
            agent_name: None,
            desktop_name: None,
            warnings: Vec::new(),
            insecure: false,
            error: Some("identifier is required".to_string()),
        };
    }

    tauri::async_runtime::spawn_blocking(move || probe_inner(&id))
        .await
        .unwrap_or_else(|e| PluginProbeResult {
            ok: false,
            agent: false,
            desktop: false,
            agent_name: None,
            desktop_name: None,
            warnings: Vec::new(),
            insecure: false,
            error: Some(format!("probe task failed: {e}")),
        })
}

#[tauri::command]
pub async fn plugins_install_desktop(
    identifier: Option<String>,
    repo: Option<String>,
    force: Option<bool>,
) -> DesktopPluginInstallResult {
    let id = identifier.or(repo).unwrap_or_default().trim().to_string();
    if id.is_empty() {
        return DesktopPluginInstallResult {
            ok: false,
            plugin_name: None,
            path: None,
            error: Some("identifier is required".to_string()),
        };
    }
    let force = force.unwrap_or(false);

    tauri::async_runtime::spawn_blocking(move || install_inner(&id, force))
        .await
        .unwrap_or_else(|e| DesktopPluginInstallResult {
            ok: false,
            plugin_name: None,
            path: None,
            error: Some(format!("install task failed: {e}")),
        })
}

#[tauri::command]
pub fn plugins_remove_desktop(name: String) -> RemoveDesktopPluginResult {
    remove_inner(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_repo_resolves_to_github() {
        assert_eq!(
            resolve_plugin_git_url("acme/widget").unwrap(),
            ResolvedGitUrl {
                git_url: "https://github.com/acme/widget.git".to_string(),
                subdir: None,
            }
        );
        assert_eq!(
            resolve_plugin_git_url("acme/widget/packages/desktop").unwrap(),
            ResolvedGitUrl {
                git_url: "https://github.com/acme/widget.git".to_string(),
                subdir: Some("packages/desktop".to_string()),
            }
        );
    }

    #[test]
    fn github_tree_url_extracts_subdir() {
        let resolved =
            resolve_plugin_git_url("https://github.com/acme/widget/tree/main/packages/desktop")
                .unwrap();
        assert_eq!(resolved.git_url, "https://github.com/acme/widget.git");
        assert_eq!(resolved.subdir.as_deref(), Some("packages/desktop"));
    }

    #[test]
    fn hash_and_git_slash_mark_a_subdir() {
        assert_eq!(
            resolve_plugin_git_url("https://example.com/r.git#foo/bar")
                .unwrap()
                .subdir
                .as_deref(),
            Some("foo/bar")
        );
        assert_eq!(
            resolve_plugin_git_url("https://example.com/r.git/foo")
                .unwrap()
                .subdir
                .as_deref(),
            Some("foo")
        );
    }

    #[test]
    fn folder_name_prefers_subdir_leaf() {
        assert_eq!(
            desktop_plugin_folder_name("https://github.com/a/b.git", Some("packages/desktop")),
            "packages"
        );
        assert_eq!(
            desktop_plugin_folder_name("https://github.com/a/my-plugin.git", None),
            "my-plugin"
        );
    }

    #[test]
    fn remove_refuses_traversal_and_package_halves() {
        assert!(!safe_segment("a/b"));
        assert_eq!(
            remove_inner("").error.as_deref(),
            Some("invalid plugin folder name")
        );
        assert_eq!(
            remove_inner("../x").error.as_deref(),
            Some("invalid plugin folder name")
        );
    }

    #[test]
    fn detects_desktop_and_agent_layout() {
        let dir = scratch_dir("hermes-plugin-detect-").unwrap();
        std::fs::write(dir.join("plugin.js"), "export default {}").unwrap();
        let detected = detect_plugin_components(&dir);
        assert!(detected.desktop);
        assert!(!detected.agent);
        assert_eq!(detected.desktop_source_subdir.as_deref(), Some("."));

        std::fs::write(dir.join("plugin.yaml"), "name: cool\n").unwrap();
        std::fs::write(dir.join("__init__.py"), "").unwrap();
        let detected = detect_plugin_components(&dir);
        assert!(detected.agent);
        assert_eq!(detected.agent_name.as_deref(), Some("cool"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
