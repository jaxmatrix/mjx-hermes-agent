//! Git worktree + branch ops — Electron `git-worktree-ops.ts`.
//!
//! Driven by the "Start work" flow and project-lane branch pickers. Git is the
//! source of truth; the renderer just drives these commands. Paths are resolved
//! the same way `fs_ipc` does (trim, expand `~`, reject NUL) — the caller already
//! picked them from the project tree.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

const TRUNK_BRANCHES: &[&str] = &["main", "master"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesGitWorktree {
    path: String,
    branch: Option<String>,
    is_main: bool,
    detached: bool,
    locked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesGitBranch {
    name: String,
    checked_out: bool,
    is_default: bool,
    is_remote: bool,
    worktree_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesGitBaseBranch {
    name: String,
    is_remote: bool,
    is_default: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAddResult {
    path: String,
    branch: String,
    repo_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveResult {
    removed: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSwitchResult {
    branch: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAddOptions {
    name: Option<String>,
    branch: Option<String>,
    base: Option<String>,
    existing_branch: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveOptions {
    force: Option<bool>,
}

pub(crate) fn resolve_repo_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("file path is required".to_string());
    }

    let path = if trimmed == "~" || trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
        let home = dirs_home().ok_or_else(|| "could not resolve home directory".to_string())?;
        home.join(
            trimmed
                .trim_start_matches('~')
                .trim_start_matches(['/', '\\']),
        )
    } else {
        PathBuf::from(trimmed)
    };

    Ok(path.canonicalize().unwrap_or(path))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

pub(crate) fn run_git(args: &[&str], cwd: &Path) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("could not run git: {e}. Is git installed?"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(stderr.trim().to_string())
    }
}

/// Like [`run_git`], but keeps stdout even when git exits non-zero (e.g.
/// `diff --no-index` always does when files differ).
pub(crate) fn run_git_allow_nonzero(args: &[&str], cwd: &Path) -> String {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    cmd.output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

fn git_line(args: &[&str], cwd: &Path) -> String {
    run_git(args, cwd)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn git_ok(args: &[&str], cwd: &Path) -> bool {
    run_git(args, cwd).is_ok()
}

/// Parse `git worktree list --porcelain`. The first record is the main worktree.
fn parse_worktrees(out: &str) -> Vec<(String, Option<String>, bool, bool, bool)> {
    let mut trees = Vec::new();
    let mut cur: Option<(String, Option<String>, bool, bool, bool)> = None;

    for line in out.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(tree) = cur.take() {
                trees.push(tree);
            }
            cur = Some((path.trim().to_string(), None, false, false, false));
        } else if let Some(ref mut tree) = cur {
            if let Some(branch) = line.strip_prefix("branch ") {
                let branch = branch
                    .trim()
                    .strip_prefix("refs/heads/")
                    .unwrap_or(branch.trim());
                tree.1 = Some(branch.to_string());
            } else if line == "detached" {
                tree.2 = true;
            } else if line == "bare" {
                tree.3 = true;
            } else if line.starts_with("locked") {
                tree.4 = true;
            }
        }
    }

    if let Some(tree) = cur {
        trees.push(tree);
    }

    trees
}

fn sanitize_branch(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    let mut prev_slash = false;
    let mut prev_dot = false;

    for ch in name.chars() {
        let mapped = if ch.is_whitespace() {
            '-'
        } else if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '/' || ch == '-' {
            ch
        } else {
            continue;
        };

        if mapped == '-' {
            if prev_dash {
                continue;
            }
            prev_dash = true;
            prev_slash = false;
            prev_dot = false;
        } else if mapped == '/' {
            if prev_slash {
                continue;
            }
            prev_slash = true;
            prev_dash = false;
            prev_dot = false;
        } else if mapped == '.' {
            if prev_dot {
                continue;
            }
            prev_dot = true;
            prev_dash = false;
            prev_slash = false;
        } else {
            prev_dash = false;
            prev_slash = false;
            prev_dot = false;
        }

        out.push(mapped);
    }

    out.trim_matches(['-', '.', '/']).to_string()
}

fn slugify(name: &str) -> String {
    let slug: String = name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let collapsed = {
        let mut s = String::new();
        let mut prev_dash = false;
        for c in slug.chars() {
            if c == '-' {
                if prev_dash {
                    continue;
                }
                prev_dash = true;
            } else {
                prev_dash = false;
            }
            s.push(c);
        }
        s.trim_matches('-').chars().take(40).collect::<String>()
    };
    let trimmed = collapsed.trim_end_matches('-');
    if trimmed.is_empty() {
        "work".to_string()
    } else {
        trimmed.to_string()
    }
}

fn remote_of_ref(cwd: &Path, name: &str) -> String {
    if !name.contains('/') {
        return String::new();
    }
    if !git_ok(
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{name}"),
        ],
        cwd,
    ) {
        return String::new();
    }
    name[..name.find('/').unwrap_or(0)].to_string()
}

fn default_branch(cwd: &Path) -> String {
    let remote = git_line(
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        cwd,
    )
    .strip_prefix("origin/")
    .unwrap_or("")
    .to_string();
    if !remote.is_empty() {
        return remote;
    }

    let configured = git_line(&["config", "--get", "init.defaultBranch"], cwd);
    if !configured.is_empty() {
        return configured;
    }

    for branch in TRUNK_BRANCHES {
        if !git_line(
            &["show-ref", "--verify", &format!("refs/heads/{branch}")],
            cwd,
        )
        .is_empty()
        {
            return (*branch).to_string();
        }
    }

    String::new()
}

fn ensure_git_repo(dir: &Path) -> Result<(), String> {
    let mut needs_root = false;

    match run_git(&["rev-parse", "--is-inside-work-tree"], dir) {
        Ok(inside) if inside.trim() == "true" => {
            if run_git(&["rev-parse", "--verify", "HEAD"], dir).is_err() {
                needs_root = true;
            }
        }
        _ => {
            run_git(&["init"], dir)?;
            needs_root = true;
        }
    }

    if needs_root {
        run_git(
            &[
                "-c",
                "user.email=hermes@localhost",
                "-c",
                "user.name=Hermes",
                "commit",
                "--allow-empty",
                "-m",
                "Initial commit",
            ],
            dir,
        )?;
    }

    Ok(())
}

fn list_worktrees_inner(cwd: &Path) -> Vec<HermesGitWorktree> {
    match run_git(&["worktree", "list", "--porcelain"], cwd) {
        Ok(out) => parse_worktrees(&out)
            .into_iter()
            .enumerate()
            .map(
                |(index, (path, branch, detached, _bare, locked))| HermesGitWorktree {
                    path,
                    branch,
                    is_main: index == 0,
                    detached,
                    locked,
                },
            )
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn main_root(cwd: &Path) -> PathBuf {
    list_worktrees_inner(cwd)
        .into_iter()
        .find(|t| t.is_main)
        .map(|t| PathBuf::from(t.path))
        .unwrap_or_else(|| cwd.to_path_buf())
}

fn unique_dir(base: &Path) -> PathBuf {
    let mut dir = base.to_path_buf();
    let mut n = 1u32;
    while dir.exists() {
        n += 1;
        dir = PathBuf::from(format!("{}-{n}", base.display()));
    }
    dir
}

fn add_existing_branch_worktree(root: &Path, name: &str) -> Result<WorktreeAddResult, String> {
    let requested = sanitize_branch(name);
    if requested.is_empty() {
        return Err("Branch name is required.".to_string());
    }

    let remote = remote_of_ref(root, &requested);
    let branch = if remote.is_empty() {
        requested.clone()
    } else {
        requested[remote.len() + 1..].to_string()
    };

    if remote.is_empty() && branch == default_branch(root) {
        run_git(&["switch", &branch], root)?;
        return Ok(WorktreeAddResult {
            path: root.to_string_lossy().into_owned(),
            branch,
            repo_root: root.to_string_lossy().into_owned(),
        });
    }

    let dir = unique_dir(&root.join(".worktrees").join(slugify(&branch)));

    if !remote.is_empty() {
        let _ = run_git(&["fetch", &remote, &branch], root);
        run_git(
            &[
                "worktree",
                "add",
                "--track",
                "-b",
                &branch,
                &dir.to_string_lossy(),
                &requested,
            ],
            root,
        )?;
        return Ok(WorktreeAddResult {
            path: dir.to_string_lossy().into_owned(),
            branch,
            repo_root: root.to_string_lossy().into_owned(),
        });
    }

    run_git(&["worktree", "add", &dir.to_string_lossy(), &branch], root)?;

    Ok(WorktreeAddResult {
        path: dir.to_string_lossy().into_owned(),
        branch,
        repo_root: root.to_string_lossy().into_owned(),
    })
}

fn add_worktree_inner(
    repo_path: &str,
    options: WorktreeAddOptions,
) -> Result<WorktreeAddResult, String> {
    let resolved = resolve_repo_path(repo_path)?;
    ensure_git_repo(&resolved)?;
    let root = main_root(&resolved);

    if let Some(existing) = options.existing_branch.filter(|s| !s.trim().is_empty()) {
        return add_existing_branch_worktree(&root, &existing);
    }

    let slug_source = options
        .name
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "work-{:x}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            )
        });
    let slug = slugify(&slug_source);
    let branch = {
        let sanitized = options
            .branch
            .as_deref()
            .map(sanitize_branch)
            .unwrap_or_default();
        if sanitized.is_empty() {
            format!("hermes/{slug}")
        } else {
            sanitized
        }
    };
    let dir = unique_dir(&root.join(".worktrees").join(&slug));

    let mut args: Vec<String> = vec![
        "worktree".into(),
        "add".into(),
        "-b".into(),
        branch.clone(),
        dir.to_string_lossy().into_owned(),
    ];

    if let Some(base) = options.base.filter(|s| !s.is_empty()) {
        if let Some(remote_branch) = base.strip_prefix("origin/") {
            let _ = run_git(&["fetch", "origin", remote_branch], &root);
            args.push("--no-track".into());
        }
        args.push(base);
    }

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    if let Err(err) = run_git(&arg_refs, &root) {
        if err.to_ascii_lowercase().contains("already exists") {
            run_git(&["worktree", "add", &dir.to_string_lossy(), &branch], &root)?;
        } else {
            return Err(err);
        }
    }

    Ok(WorktreeAddResult {
        path: dir.to_string_lossy().into_owned(),
        branch,
        repo_root: root.to_string_lossy().into_owned(),
    })
}

fn remove_worktree_inner(
    repo_path: &str,
    worktree_path: &str,
    options: WorktreeRemoveOptions,
) -> Result<WorktreeRemoveResult, String> {
    let resolved_repo = resolve_repo_path(repo_path)?;
    let resolved_tree = resolve_repo_path(worktree_path)?;
    let root = main_root(&resolved_repo);

    let mut args = vec!["worktree".to_string(), "remove".to_string()];
    if options.force.unwrap_or(false) {
        args.push("--force".into());
    }
    args.push(resolved_tree.to_string_lossy().into_owned());

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(&arg_refs, &root)?;

    Ok(WorktreeRemoveResult {
        removed: resolved_tree.to_string_lossy().into_owned(),
    })
}

fn list_branches_inner(repo_path: &str) -> Vec<HermesGitBranch> {
    let Ok(resolved) = resolve_repo_path(repo_path) else {
        return Vec::new();
    };

    let local_out = match run_git(
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "--sort=-committerdate",
            "refs/heads",
        ],
        &resolved,
    ) {
        Ok(out) => out,
        Err(_) => return Vec::new(),
    };
    let remote_out = run_git(
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "--sort=-committerdate",
            "refs/remotes",
        ],
        &resolved,
    )
    .unwrap_or_default();

    let trees = list_worktrees_inner(&resolved);
    let path_by_branch: std::collections::HashMap<String, String> = trees
        .into_iter()
        .filter_map(|t| t.branch.map(|b| (b, t.path)))
        .collect();
    let trunk = default_branch(&resolved);

    let names = |out: &str| -> Vec<String> {
        out.lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    };

    let locals = names(&local_out);
    let local_set: std::collections::HashSet<&str> = locals.iter().map(String::as_str).collect();

    let remotes: Vec<String> = names(&remote_out)
        .into_iter()
        .filter(|name| {
            if name.ends_with("/HEAD") {
                return false;
            }
            let short = name
                .find('/')
                .map(|i| &name[i + 1..])
                .unwrap_or(name.as_str());
            !local_set.contains(short)
        })
        .collect();

    let mut out = Vec::new();
    for name in locals {
        let worktree_path = path_by_branch.get(&name).cloned();
        let checked_out = worktree_path.is_some();
        let is_default = !trunk.is_empty() && name == trunk;
        out.push(HermesGitBranch {
            name,
            checked_out,
            is_default,
            is_remote: false,
            worktree_path,
        });
    }
    for name in remotes {
        out.push(HermesGitBranch {
            name,
            checked_out: false,
            is_default: false,
            is_remote: true,
            worktree_path: None,
        });
    }
    out
}

fn switch_branch_inner(repo_path: &str, branch: &str) -> Result<BranchSwitchResult, String> {
    let resolved = resolve_repo_path(repo_path)?;

    let inside = run_git(&["rev-parse", "--is-inside-work-tree"], &resolved)
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "false".into());

    if inside != "true" {
        return Ok(BranchSwitchResult { branch: None });
    }

    let target = sanitize_branch(branch);
    if target.is_empty() {
        return Err("Branch name is required.".to_string());
    }

    run_git(&["switch", &target], &resolved)?;
    Ok(BranchSwitchResult {
        branch: Some(target),
    })
}

fn list_base_branches_inner(repo_path: &str) -> Vec<HermesGitBaseBranch> {
    let Ok(resolved) = resolve_repo_path(repo_path) else {
        return Vec::new();
    };

    let out = match run_git(
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(committerdate:iso)",
            "--sort=-committerdate",
            "refs/heads",
            "refs/remotes",
        ],
        &resolved,
    ) {
        Ok(out) => out,
        Err(_) => return Vec::new(),
    };

    let remote_default = git_line(
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        &resolved,
    );
    let local_default = default_branch(&resolved);

    out.lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|line| {
            let name = line.split('\t').next()?.to_string();
            let is_remote = name.starts_with("origin/");
            let is_default = (!remote_default.is_empty() && name == remote_default)
                || (remote_default.is_empty()
                    && !local_default.is_empty()
                    && name == local_default);
            Some(HermesGitBaseBranch {
                name,
                is_remote,
                is_default,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn git_worktree_list(repo_path: String) -> Vec<HermesGitWorktree> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_repo_path(&repo_path)
            .map(|p| list_worktrees_inner(&p))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn git_worktree_add(
    repo_path: String,
    options: Option<WorktreeAddOptions>,
) -> Result<WorktreeAddResult, String> {
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || add_worktree_inner(&repo_path, options))
        .await
        .map_err(|e| format!("worktree add task failed: {e}"))?
}

#[tauri::command]
pub async fn git_worktree_remove(
    repo_path: String,
    worktree_path: String,
    options: Option<WorktreeRemoveOptions>,
) -> Result<WorktreeRemoveResult, String> {
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        remove_worktree_inner(&repo_path, &worktree_path, options)
    })
    .await
    .map_err(|e| format!("worktree remove task failed: {e}"))?
}

#[tauri::command]
pub async fn git_branch_list(repo_path: String) -> Vec<HermesGitBranch> {
    tauri::async_runtime::spawn_blocking(move || list_branches_inner(&repo_path))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn git_base_branch_list(repo_path: String) -> Vec<HermesGitBaseBranch> {
    tauri::async_runtime::spawn_blocking(move || list_base_branches_inner(&repo_path))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn git_branch_switch(
    repo_path: String,
    branch: String,
) -> Result<BranchSwitchResult, String> {
    tauri::async_runtime::spawn_blocking(move || switch_branch_inner(&repo_path, &branch))
        .await
        .map_err(|e| format!("branch switch task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_worktrees_parse() {
        let out = "\
worktree /repo
HEAD abc
branch refs/heads/main

worktree /repo/.worktrees/feat
HEAD def
branch refs/heads/feat
locked
";
        let trees = parse_worktrees(out);
        assert_eq!(trees.len(), 2);
        assert_eq!(trees[0].0, "/repo");
        assert_eq!(trees[0].1.as_deref(), Some("main"));
        assert_eq!(trees[1].1.as_deref(), Some("feat"));
        assert!(trees[1].4);
    }

    #[test]
    fn branch_sanitize_and_slug() {
        assert_eq!(
            sanitize_branch("feat/my cool branch!!"),
            "feat/my-cool-branch"
        );
        assert_eq!(slugify("My Cool Work"), "my-cool-work");
        assert_eq!(slugify(""), "work");
    }
}
