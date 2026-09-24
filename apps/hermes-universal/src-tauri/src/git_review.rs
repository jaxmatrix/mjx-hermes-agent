//! Coding-rail status + Codex-style review pane — Electron `git-review-ops.ts`.
//!
//! Built on the system `git` / `gh` binaries (no simple-git). Reads degrade to
//! null/empty off-repo; mutations return `{ ok: true }` or reject so the
//! renderer can toast.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::git_worktree::{resolve_repo_path, run_git, run_git_allow_nonzero};

const COMMIT_CONTEXT_DIFF_MAX_CHARS: usize = 120_000;
const COMMIT_CONTEXT_UNTRACKED_MAX: usize = 80;
const REVIEW_FILE_CAP: usize = 2_000;
const UNTRACKED_LINE_COUNT_MAX_BYTES: u64 = 1024 * 1024;
const REPO_STATUS_FILE_CAP: usize = 200;
const PR_QUERY_BRANCH_CHUNK: usize = 50;
const PR_QUERY_BRANCH_CAP: usize = 300;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HermesRepoStatusFile {
    path: String,
    staged: bool,
    unstaged: bool,
    untracked: bool,
    conflicted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesRepoStatus {
    branch: Option<String>,
    default_branch: Option<String>,
    detached: bool,
    ahead: u32,
    behind: u32,
    staged: usize,
    unstaged: usize,
    untracked: usize,
    conflicted: usize,
    changed: usize,
    added: u32,
    removed: u32,
    files: Vec<HermesRepoStatusFile>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HermesReviewFile {
    path: String,
    added: u32,
    removed: u32,
    status: String,
    staged: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesReviewList {
    files: Vec<HermesReviewFile>,
    base: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OkResult {
    ok: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitContext {
    diff: String,
    recent: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesReviewShipInfo {
    gh_ready: bool,
    pr: Option<HermesReviewPr>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesReviewPr {
    url: String,
    state: String,
    number: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesBranchPullRequest {
    branch: String,
    draft: bool,
    number: u64,
    state: String,
    title: String,
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesRepoPullRequests {
    gh_ready: bool,
    prs: Vec<HermesBranchPullRequest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePrResult {
    url: String,
}

fn resolve_rename_path(raw: &str) -> String {
    let path = raw.trim();
    if !path.contains(" => ") {
        return path.to_string();
    }
    // `dir/{old => new}/f`
    if let Some(open) = path.find('{') {
        if let Some(close) = path.find('}') {
            let prefix = &path[..open];
            let suffix = &path[close + 1..];
            let inner = &path[open + 1..close];
            if let Some((_, to)) = inner.split_once(" => ") {
                return format!("{prefix}{to}{suffix}").replace("//", "/");
            }
        }
    }
    path.split(" => ").last().unwrap_or(path).trim().to_string()
}

fn untracked_insertions(cwd: &Path, rel: &str) -> u32 {
    let full = cwd.join(rel);
    let Ok(meta) = std::fs::metadata(&full) else {
        return 0;
    };
    if !meta.is_file() || meta.len() > UNTRACKED_LINE_COUNT_MAX_BYTES {
        return 0;
    }
    let Ok(buf) = std::fs::read(&full) else {
        return 0;
    };
    if buf.contains(&0) {
        return 0;
    }
    let newlines = buf.iter().filter(|b| **b == b'\n').count() as u32;
    if buf.is_empty() {
        0
    } else if *buf.last().unwrap() != b'\n' {
        newlines + 1
    } else {
        newlines
    }
}

fn cap_text(text: &str, max: usize, label: &str) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    format!(
        "{}\n# {label}: {} chars omitted\n",
        &text[..max],
        text.len() - max
    )
}

fn numstat_counts(cwd: &Path, extra: &[&str]) -> HashMap<String, (u32, u32)> {
    let mut args = vec!["diff", "--numstat"];
    args.extend_from_slice(extra);
    let out = run_git(&args, cwd).unwrap_or_default();
    let mut map = HashMap::new();
    for line in out.lines() {
        let mut parts = line.split('\t');
        let added = parts.next().unwrap_or("0");
        let removed = parts.next().unwrap_or("0");
        let file = parts.next().unwrap_or("");
        if file.is_empty() {
            continue;
        }
        let a = if added == "-" {
            0
        } else {
            added.parse().unwrap_or(0)
        };
        let r = if removed == "-" {
            0
        } else {
            removed.parse().unwrap_or(0)
        };
        map.insert(resolve_rename_path(file), (a, r));
    }
    map
}

fn numstat_totals(cwd: &Path, extra: &[&str]) -> (u32, u32) {
    numstat_counts(cwd, extra)
        .values()
        .fold((0, 0), |(a, r), (x, y)| (a + x, r + y))
}

struct StatusEntry {
    path: String,
    index: char,
    worktree: char,
}

fn parse_porcelain(out: &str) -> Vec<StatusEntry> {
    let mut entries = Vec::new();
    for line in out.lines() {
        if line.len() < 4 {
            continue;
        }
        let index = line.chars().next().unwrap_or(' ');
        let worktree = line.chars().nth(1).unwrap_or(' ');
        let rest = line[3..].trim();
        // rename: `R  old -> new` or `R  old => new`
        let path = if let Some((_, to)) = rest.split_once(" -> ") {
            resolve_rename_path(to)
        } else if rest.contains(" => ") {
            resolve_rename_path(rest)
        } else {
            rest.to_string()
        };
        entries.push(StatusEntry {
            path,
            index,
            worktree,
        });
    }
    entries
}

fn status_letter(e: &StatusEntry) -> String {
    if e.index == '?' || e.worktree == '?' {
        return "?".into();
    }
    let code = if e.index != ' ' { e.index } else { e.worktree };
    code.to_ascii_uppercase().to_string()
}

fn is_staged(e: &StatusEntry) -> bool {
    e.index != ' ' && e.index != '?'
}

fn porcelain_status(
    cwd: &Path,
) -> Result<(Vec<StatusEntry>, Option<String>, bool, u32, u32), String> {
    let out = run_git(
        &["status", "--porcelain=v1", "-b", "--untracked-files=normal"],
        cwd,
    )?;
    let mut branch = None;
    let mut detached = false;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut body = String::new();

    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            // `## HEAD (no branch)` or `## main...origin/main [ahead 1, behind 2]`
            if rest.starts_with("HEAD (no branch)") || rest == "HEAD" {
                detached = true;
                branch = None;
            } else {
                let name = rest.split(['.', ' ', '\t']).next().unwrap_or(rest);
                if name == "HEAD" {
                    detached = true;
                    branch = None;
                } else {
                    branch = Some(name.to_string());
                }
                if let Some(idx) = rest.find('[') {
                    let bracket = &rest[idx..];
                    if let Some(a) = bracket.split("ahead ").nth(1) {
                        ahead = a
                            .chars()
                            .take_while(|c| c.is_ascii_digit())
                            .collect::<String>()
                            .parse()
                            .unwrap_or(0);
                    }
                    if let Some(b) = bracket.split("behind ").nth(1) {
                        behind = b
                            .chars()
                            .take_while(|c| c.is_ascii_digit())
                            .collect::<String>()
                            .parse()
                            .unwrap_or(0);
                    }
                }
            }
        } else {
            body.push_str(line);
            body.push('\n');
        }
    }

    Ok((parse_porcelain(&body), branch, detached, ahead, behind))
}

fn default_branch_name(cwd: &Path) -> Option<String> {
    if let Ok(head) = run_git(&["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd) {
        let head = head.trim();
        if !head.is_empty() && head != "origin/HEAD" {
            return Some(head.strip_prefix("origin/").unwrap_or(head).to_string());
        }
    }
    for r in [
        "refs/heads/main",
        "refs/heads/master",
        "refs/remotes/origin/main",
        "refs/remotes/origin/master",
    ] {
        if run_git(&["rev-parse", "--verify", "--quiet", r], cwd).is_ok() {
            return Some(
                r.trim_start_matches("refs/heads/")
                    .trim_start_matches("refs/remotes/origin/")
                    .to_string(),
            );
        }
    }
    None
}

fn branch_base(cwd: &Path) -> Option<String> {
    let mut candidates = Vec::new();
    if let Ok(head) = run_git(&["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd) {
        let head = head.trim();
        if !head.is_empty() {
            candidates.push(head.to_string());
        }
    }
    for c in ["origin/main", "origin/master", "main", "master"] {
        candidates.push(c.to_string());
    }
    for ref_name in candidates {
        if let Ok(base) = run_git(&["merge-base", "HEAD", &ref_name], cwd) {
            let base = base.trim();
            if !base.is_empty() {
                return Some(base.to_string());
            }
        }
    }
    None
}

fn fill_untracked_counts(cwd: &Path, files: &mut [HermesReviewFile]) {
    for file in files.iter_mut() {
        if file.status == "?" && file.added == 0 && file.removed == 0 {
            file.added = untracked_insertions(cwd, &file.path);
        }
    }
}

fn diff_null(cwd: &Path, file_path: &str) -> String {
    // Windows: NUL; everyone else: /dev/null
    #[cfg(windows)]
    let null = "NUL";
    #[cfg(not(windows))]
    let null = "/dev/null";
    run_git_allow_nonzero(&["diff", "--no-index", "--", null, file_path], cwd)
}

fn run_gh(args: &[&str], cwd: &Path) -> (bool, String) {
    let mut cmd = Command::new("gh");
    cmd.args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    // GUI apps often miss homebrew PATH.
    if let Ok(path) = std::env::var("PATH") {
        let extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
        let joined = format!("{}:{path}", extra.join(":"));
        cmd.env("PATH", joined);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    match cmd.output() {
        Ok(o) if o.status.success() => (true, String::from_utf8_lossy(&o.stdout).into_owned()),
        Ok(o) => (false, String::from_utf8_lossy(&o.stdout).into_owned()),
        Err(_) => (false, String::new()),
    }
}

fn repo_status_inner(repo_path: &str) -> Option<HermesRepoStatus> {
    let cwd = resolve_repo_path(repo_path).ok()?;
    if !cwd.is_dir() {
        return None;
    }
    let (entries, branch, detached, ahead, behind) = porcelain_status(&cwd).ok()?;
    let default_branch = default_branch_name(&cwd);

    let files: Vec<HermesRepoStatusFile> = entries
        .iter()
        .map(|e| HermesRepoStatusFile {
            path: e.path.clone(),
            staged: is_staged(e),
            unstaged: e.worktree != ' ' && e.worktree != '?',
            untracked: e.index == '?' || e.worktree == '?',
            conflicted: e.index == 'U' || e.worktree == 'U',
        })
        .collect();

    let staged = files.iter().filter(|f| f.staged).count();
    let unstaged = files.iter().filter(|f| f.unstaged).count();
    let untracked = files.iter().filter(|f| f.untracked).count();
    let conflicted = files.iter().filter(|f| f.conflicted).count();

    let (mut added, removed) = numstat_totals(&cwd, &["HEAD"]);
    for path in files
        .iter()
        .filter(|f| f.untracked)
        .take(500)
        .map(|f| &f.path)
    {
        added += untracked_insertions(&cwd, path);
    }

    Some(HermesRepoStatus {
        branch: if detached { None } else { branch },
        default_branch,
        detached,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
        conflicted,
        changed: files.len(),
        added,
        removed,
        files: files.into_iter().take(REPO_STATUS_FILE_CAP).collect(),
    })
}

fn review_list_inner(repo_path: &str, scope: &str, base_ref: Option<&str>) -> HermesReviewList {
    let empty = HermesReviewList {
        files: Vec::new(),
        base: None,
    };
    let Ok(cwd) = resolve_repo_path(repo_path) else {
        return empty;
    };

    if scope == "branch" || scope == "lastTurn" {
        let base = if scope == "branch" {
            branch_base(&cwd)
        } else {
            base_ref.map(str::to_string)
        };
        let Some(base) = base else {
            return empty;
        };
        let range = if scope == "branch" {
            format!("{base}...HEAD")
        } else {
            base.clone()
        };
        let counts = numstat_counts(&cwd, &[&range]);
        let mut files: Vec<HermesReviewFile> = counts
            .into_iter()
            .take(REVIEW_FILE_CAP)
            .map(|(path, (added, removed))| HermesReviewFile {
                path,
                added,
                removed,
                status: "M".into(),
                staged: false,
            })
            .collect();

        if scope == "lastTurn" && files.len() < REVIEW_FILE_CAP {
            if let Ok((entries, ..)) = porcelain_status(&cwd) {
                let mut known: std::collections::HashSet<String> =
                    files.iter().map(|f| f.path.clone()).collect();
                for e in entries {
                    if files.len() >= REVIEW_FILE_CAP {
                        break;
                    }
                    if (e.index == '?' || e.worktree == '?') && known.insert(e.path.clone()) {
                        files.push(HermesReviewFile {
                            path: e.path,
                            added: 0,
                            removed: 0,
                            status: "?".into(),
                            staged: false,
                        });
                    }
                }
            }
        }

        files.sort_by(|a, b| a.path.cmp(&b.path));
        fill_untracked_counts(&cwd, &mut files);
        return HermesReviewList {
            files,
            base: Some(base),
        };
    }

    // uncommitted
    let Ok((entries, ..)) = porcelain_status(&cwd) else {
        return empty;
    };
    let staged_counts = numstat_counts(&cwd, &["--cached"]);
    let unstaged_counts = numstat_counts(&cwd, &[]);

    let mut files: Vec<HermesReviewFile> = entries
        .into_iter()
        .take(REVIEW_FILE_CAP)
        .map(|e| {
            let path = e.path.clone();
            let (sa, sr) = staged_counts.get(&path).copied().unwrap_or((0, 0));
            let (ua, ur) = unstaged_counts.get(&path).copied().unwrap_or((0, 0));
            HermesReviewFile {
                path,
                added: sa + ua,
                removed: sr + ur,
                status: status_letter(&e),
                staged: is_staged(&e),
            }
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    fill_untracked_counts(&cwd, &mut files);
    HermesReviewList { files, base: None }
}

fn review_diff_inner(
    repo_path: &str,
    file_path: &str,
    scope: &str,
    base_ref: Option<&str>,
    staged: bool,
) -> String {
    let Ok(cwd) = resolve_repo_path(repo_path) else {
        return String::new();
    };

    if scope == "branch" {
        return branch_base(&cwd)
            .and_then(|base| {
                run_git(&["diff", &format!("{base}...HEAD"), "--", file_path], &cwd).ok()
            })
            .unwrap_or_default();
    }
    if scope == "lastTurn" {
        return base_ref
            .and_then(|b| run_git(&["diff", b, "--", file_path], &cwd).ok())
            .unwrap_or_default();
    }
    if staged {
        return run_git(&["diff", "--cached", "--", file_path], &cwd).unwrap_or_default();
    }
    let worktree = run_git(&["diff", "--", file_path], &cwd).unwrap_or_default();
    if !worktree.trim().is_empty() {
        return worktree;
    }
    diff_null(&cwd, file_path)
}

fn file_diff_vs_head_inner(repo_path: &str, file_path: &str) -> String {
    let Ok(cwd) = resolve_repo_path(repo_path) else {
        return String::new();
    };
    let head = run_git(&["diff", "HEAD", "--", file_path], &cwd).unwrap_or_default();
    if !head.trim().is_empty() {
        return head;
    }
    let status = run_git(&["status", "--porcelain", "--", file_path], &cwd).unwrap_or_default();
    if !status.trim().starts_with("??") {
        return String::new();
    }
    diff_null(&cwd, file_path)
}

fn review_stage_inner(repo_path: &str, file_path: Option<&str>) -> Result<OkResult, String> {
    let cwd = resolve_repo_path(repo_path)?;
    if let Some(f) = file_path.filter(|s| !s.is_empty()) {
        run_git(&["add", "--", f], &cwd)?;
    } else {
        run_git(&["add", "-A"], &cwd)?;
    }
    Ok(OkResult { ok: true })
}

fn review_unstage_inner(repo_path: &str, file_path: Option<&str>) -> Result<OkResult, String> {
    let cwd = resolve_repo_path(repo_path)?;
    if let Some(f) = file_path.filter(|s| !s.is_empty()) {
        run_git(&["reset", "-q", "HEAD", "--", f], &cwd)?;
    } else {
        run_git(&["reset", "-q", "HEAD"], &cwd)?;
    }
    Ok(OkResult { ok: true })
}

fn review_revert_inner(repo_path: &str, file_path: Option<&str>) -> Result<OkResult, String> {
    let cwd = resolve_repo_path(repo_path)?;
    if let Some(f) = file_path.filter(|s| !s.is_empty()) {
        let _ = run_git(&["checkout", "HEAD", "--", f], &cwd);
        let _ = run_git(&["clean", "-fd", "--", f], &cwd);
    } else {
        let _ = run_git(&["checkout", "HEAD", "--", "."], &cwd);
        let _ = run_git(&["clean", "-fd"], &cwd);
    }
    Ok(OkResult { ok: true })
}

fn review_rev_parse_inner(repo_path: &str, ref_name: Option<&str>) -> Option<String> {
    let cwd = resolve_repo_path(repo_path).ok()?;
    let r = ref_name.filter(|s| !s.is_empty()).unwrap_or("HEAD");
    run_git(&["rev-parse", r], &cwd)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn review_commit_inner(repo_path: &str, message: &str, push: bool) -> Result<OkResult, String> {
    let cwd = resolve_repo_path(repo_path)?;
    let (entries, branch, ..) = porcelain_status(&cwd)?;
    let has_staged = entries.iter().any(is_staged);
    if !has_staged {
        run_git(&["add", "-A"], &cwd)?;
    }
    run_git(&["commit", "-m", message], &cwd)?;
    if push {
        let tracking = run_git(
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
            &cwd,
        )
        .is_ok();
        if tracking {
            run_git(&["push"], &cwd)?;
        } else if let Some(b) = branch {
            run_git(&["push", "-u", "origin", &b], &cwd)?;
        }
    }
    Ok(OkResult { ok: true })
}

fn review_commit_context_inner(repo_path: &str) -> CommitContext {
    let empty = CommitContext {
        diff: String::new(),
        recent: String::new(),
    };
    let Ok(cwd) = resolve_repo_path(repo_path) else {
        return empty;
    };
    let Ok((entries, ..)) = porcelain_status(&cwd) else {
        return empty;
    };
    let has_staged = entries.iter().any(is_staged);
    let mut diff = if has_staged {
        run_git(&["diff", "--cached"], &cwd).unwrap_or_default()
    } else {
        run_git(&["diff", "HEAD"], &cwd).unwrap_or_default()
    };
    diff = cap_text(
        &diff,
        COMMIT_CONTEXT_DIFF_MAX_CHARS,
        "diff truncated for commit-message generation",
    );

    let untracked: Vec<_> = entries
        .iter()
        .filter(|e| e.index == '?' || e.worktree == '?')
        .map(|e| e.path.clone())
        .collect();
    if !untracked.is_empty() {
        let visible = &untracked[..untracked.len().min(COMMIT_CONTEXT_UNTRACKED_MAX)];
        let omitted = untracked.len().saturating_sub(visible.len());
        let mut note = String::from("\n# New (untracked) files:\n");
        for p in visible {
            note.push_str(&format!("#   {p}\n"));
        }
        if omitted > 0 {
            note.push_str(&format!("#   ... {omitted} more omitted\n"));
        }
        diff = if diff.is_empty() {
            note
        } else {
            format!("{diff}{note}")
        };
    }

    let recent = run_git(&["log", "-n", "10", "--pretty=format:%s"], &cwd)
        .unwrap_or_default()
        .trim()
        .to_string();

    CommitContext { diff, recent }
}

fn review_push_inner(repo_path: &str) -> Result<OkResult, String> {
    let cwd = resolve_repo_path(repo_path)?;
    let (entries, branch, ..) = porcelain_status(&cwd)?;
    let _ = entries;
    let tracking = run_git(
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        &cwd,
    )
    .is_ok();
    if tracking {
        run_git(&["push"], &cwd)?;
    } else if let Some(b) = branch {
        run_git(&["push", "-u", "origin", &b], &cwd)?;
    }
    Ok(OkResult { ok: true })
}

fn review_ship_info_inner(repo_path: &str) -> HermesReviewShipInfo {
    let fail = HermesReviewShipInfo {
        gh_ready: false,
        pr: None,
    };
    let Ok(cwd) = resolve_repo_path(repo_path) else {
        return fail;
    };
    let (ok, _) = run_gh(&["auth", "status"], &cwd);
    if !ok {
        return fail;
    }
    let (view_ok, stdout) = run_gh(&["pr", "view", "--json", "url,state,number"], &cwd);
    if !view_ok {
        return HermesReviewShipInfo {
            gh_ready: true,
            pr: None,
        };
    }
    let pr = serde_json::from_str::<serde_json::Value>(&stdout)
        .ok()
        .and_then(|v| {
            let url = v.get("url")?.as_str()?.to_string();
            if url.is_empty() {
                return None;
            }
            Some(HermesReviewPr {
                url,
                state: v
                    .get("state")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string(),
                number: v.get("number").and_then(|n| n.as_u64()).unwrap_or(0),
            })
        });
    HermesReviewShipInfo { gh_ready: true, pr }
}

fn pr_query_for(owner: &str, name: &str, branches: &[String], numbers: &[u64]) -> String {
    let fields = PR_NODE_FIELDS;
    let mut parts = Vec::new();
    for (i, branch) in branches.iter().enumerate() {
        parts.push(format!(
            "b{i}: pullRequests(headRefName: {}, first: 5, orderBy: {{field: CREATED_AT, direction: DESC}}) {{ nodes {{ {fields} }} }}",
            serde_json::to_string(branch).unwrap_or_else(|_| "\"\"".into())
        ));
    }
    for (i, number) in numbers.iter().enumerate() {
        parts.push(format!(
            "n{i}: pullRequest(number: {number}) {{ {fields} }}"
        ));
    }
    format!(
        "query {{ repository(owner: {}, name: {}) {{\n{}\n}} }}",
        serde_json::to_string(owner).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(name).unwrap_or_else(|_| "\"\"".into()),
        parts.join("\n")
    )
}

const PR_NODE_FIELDS: &str = "number state isDraft isCrossRepository title url headRefName";

fn pr_payload(pr: &serde_json::Value) -> Option<HermesBranchPullRequest> {
    let branch = pr.get("headRefName")?.as_str()?.to_string();
    Some(HermesBranchPullRequest {
        branch,
        draft: pr.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
        number: pr.get("number").and_then(|v| v.as_u64()).unwrap_or(0),
        state: pr
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_ascii_lowercase(),
        title: pr
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        url: pr
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

fn review_pr_list_inner(
    repo_path: &str,
    branches: Vec<String>,
    numbers: Vec<u64>,
) -> HermesRepoPullRequests {
    let fail = HermesRepoPullRequests {
        gh_ready: false,
        prs: Vec::new(),
    };
    let Ok(cwd) = resolve_repo_path(repo_path) else {
        return fail;
    };

    let mut wanted: Vec<String> = branches
        .into_iter()
        .filter(|b| !b.is_empty())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .take(PR_QUERY_BRANCH_CAP)
        .collect();
    wanted.sort();
    let by_number: Vec<u64> = numbers
        .into_iter()
        .filter(|n| *n != 0)
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .take(PR_QUERY_BRANCH_CAP)
        .collect();

    if wanted.is_empty() && by_number.is_empty() {
        return fail;
    }

    let (ok, stdout) = run_gh(
        &[
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "-q",
            ".nameWithOwner",
        ],
        &cwd,
    );
    let name_with_owner = stdout.trim();
    let Some((owner, name)) = name_with_owner.split_once('/') else {
        return fail;
    };
    if !ok || owner.is_empty() || name.is_empty() {
        return fail;
    }

    let mut prs = Vec::new();
    let mut chunks: Vec<(Vec<String>, Vec<u64>)> = Vec::new();
    for start in (0..wanted.len()).step_by(PR_QUERY_BRANCH_CHUNK) {
        chunks.push((
            wanted[start..wanted.len().min(start + PR_QUERY_BRANCH_CHUNK)].to_vec(),
            Vec::new(),
        ));
    }
    for start in (0..by_number.len()).step_by(PR_QUERY_BRANCH_CHUNK) {
        chunks.push((
            Vec::new(),
            by_number[start..by_number.len().min(start + PR_QUERY_BRANCH_CHUNK)].to_vec(),
        ));
    }

    for (branch_chunk, number_chunk) in chunks {
        let query = pr_query_for(owner, name, &branch_chunk, &number_chunk);
        let (ok, body) = run_gh(&["api", "graphql", "-f", &format!("query={query}")], &cwd);
        if !ok {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) else {
            continue;
        };
        let Some(repo) = parsed.pointer("/data/repository") else {
            continue;
        };
        let Some(obj) = repo.as_object() else {
            continue;
        };
        for (key, value) in obj {
            let pr = if key.starts_with('n') {
                Some(value)
            } else {
                value
                    .get("nodes")
                    .and_then(|n| n.as_array())
                    .and_then(|arr| {
                        arr.iter().find(|node| {
                            node.get("isCrossRepository") != Some(&serde_json::Value::Bool(true))
                        })
                    })
            };
            if let Some(pr) = pr {
                if let Some(payload) = pr_payload(pr) {
                    prs.push(payload);
                }
            }
        }
    }

    HermesRepoPullRequests {
        gh_ready: true,
        prs,
    }
}

fn review_create_pr_inner(repo_path: &str) -> Result<CreatePrResult, String> {
    let cwd = resolve_repo_path(repo_path)?;
    let _ = review_push_inner(repo_path);
    let (ok, stdout) = run_gh(&["pr", "create", "--fill"], &cwd);
    if !ok {
        return Err("gh pr create failed (is gh installed and authenticated?)".into());
    }
    let url = stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .next_back()
        .unwrap_or("")
        .to_string();
    Ok(CreatePrResult { url })
}

// --- commands ----------------------------------------------------------------

#[tauri::command]
pub async fn git_repo_status(repo_path: String) -> Option<HermesRepoStatus> {
    tauri::async_runtime::spawn_blocking(move || repo_status_inner(&repo_path))
        .await
        .ok()
        .flatten()
}

#[tauri::command]
pub async fn git_file_diff(repo_path: String, file_path: String) -> String {
    tauri::async_runtime::spawn_blocking(move || file_diff_vs_head_inner(&repo_path, &file_path))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn git_review_list(
    repo_path: String,
    scope: String,
    base_ref: Option<String>,
) -> HermesReviewList {
    tauri::async_runtime::spawn_blocking(move || {
        review_list_inner(&repo_path, &scope, base_ref.as_deref())
    })
    .await
    .unwrap_or(HermesReviewList {
        files: Vec::new(),
        base: None,
    })
}

#[tauri::command]
pub async fn git_review_diff(
    repo_path: String,
    file_path: String,
    scope: String,
    base_ref: Option<String>,
    staged: Option<bool>,
) -> String {
    tauri::async_runtime::spawn_blocking(move || {
        review_diff_inner(
            &repo_path,
            &file_path,
            &scope,
            base_ref.as_deref(),
            staged.unwrap_or(false),
        )
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn git_review_stage(
    repo_path: String,
    file_path: Option<String>,
) -> Result<OkResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        review_stage_inner(&repo_path, file_path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_review_unstage(
    repo_path: String,
    file_path: Option<String>,
) -> Result<OkResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        review_unstage_inner(&repo_path, file_path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_review_revert(
    repo_path: String,
    file_path: Option<String>,
) -> Result<OkResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        review_revert_inner(&repo_path, file_path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_review_rev_parse(repo_path: String, ref_name: Option<String>) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        review_rev_parse_inner(&repo_path, ref_name.as_deref())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn git_review_commit(
    repo_path: String,
    message: String,
    push: bool,
) -> Result<OkResult, String> {
    tauri::async_runtime::spawn_blocking(move || review_commit_inner(&repo_path, &message, push))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_review_commit_context(repo_path: String) -> CommitContext {
    tauri::async_runtime::spawn_blocking(move || review_commit_context_inner(&repo_path))
        .await
        .unwrap_or(CommitContext {
            diff: String::new(),
            recent: String::new(),
        })
}

#[tauri::command]
pub async fn git_review_push(repo_path: String) -> Result<OkResult, String> {
    tauri::async_runtime::spawn_blocking(move || review_push_inner(&repo_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_review_ship_info(repo_path: String) -> HermesReviewShipInfo {
    tauri::async_runtime::spawn_blocking(move || review_ship_info_inner(&repo_path))
        .await
        .unwrap_or(HermesReviewShipInfo {
            gh_ready: false,
            pr: None,
        })
}

#[tauri::command]
pub async fn git_review_pr_list(
    repo_path: String,
    branches: Vec<String>,
    numbers: Option<Vec<u64>>,
) -> HermesRepoPullRequests {
    tauri::async_runtime::spawn_blocking(move || {
        review_pr_list_inner(&repo_path, branches, numbers.unwrap_or_default())
    })
    .await
    .unwrap_or(HermesRepoPullRequests {
        gh_ready: false,
        prs: Vec::new(),
    })
}

#[tauri::command]
pub async fn git_review_create_pr(repo_path: String) -> Result<CreatePrResult, String> {
    tauri::async_runtime::spawn_blocking(move || review_create_pr_inner(&repo_path))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_paths_resolve_to_the_new_name() {
        assert_eq!(resolve_rename_path("a/b"), "a/b");
        assert_eq!(resolve_rename_path("old => new"), "new");
        assert_eq!(resolve_rename_path("dir/{old => new}/f"), "dir/new/f");
    }

    #[test]
    fn porcelain_lines_parse() {
        let entries = parse_porcelain(" M src/a.ts\n?? new.ts\nR  old.ts -> new.ts\n");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "src/a.ts");
        assert_eq!(entries[1].path, "new.ts");
        assert_eq!(entries[2].path, "new.ts");
        assert!(is_staged(&entries[2]));
    }
}
