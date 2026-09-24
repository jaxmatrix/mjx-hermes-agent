//! Workspace / preview path helpers — Electron `sanitizeWorkspaceCwd`,
//! `normalizePreviewTarget`, and `readFileText` (preview text with binary sniff).
//!
//! Desktop-only: phones have no local project cwd / file-preview stack.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const TEXT_PREVIEW_MAX_BYTES: u64 = 512 * 1024;
const TEXT_PREVIEW_SOURCE_MAX_BYTES: u64 = 64 * 1024 * 1024;

const LOCAL_PREVIEW_HOSTS: &[&str] = &["0.0.0.0", "127.0.0.1", "::1", "[::1]", "localhost"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizeCwdResult {
    pub cwd: String,
    pub sanitized: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileTextResult {
    pub path: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTarget {
    pub kind: String,
    pub label: String,
    pub source: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large: Option<bool>,
}

fn looks_binary(sample: &[u8]) -> bool {
    if sample.is_empty() {
        return false;
    }

    let mut suspicious = 0usize;

    for &byte in sample {
        if byte == 0 {
            return true;
        }

        if byte < 32 && byte != 9 && byte != 10 && byte != 13 {
            suspicious += 1;
        }
    }

    (suspicious as f64) / (sample.len() as f64) > 0.12
}

fn language_for_ext(ext: &str) -> &'static str {
    match ext {
        ".c" | ".h" => "c",
        ".cpp" | ".hpp" => "cpp",
        ".css" => "css",
        ".go" => "go",
        ".html" | ".htm" => "html",
        ".java" => "java",
        ".js" | ".mjs" => "javascript",
        ".json" => "json",
        ".jsx" => "jsx",
        ".kt" => "kotlin",
        ".md" => "markdown",
        ".py" => "python",
        ".rb" => "ruby",
        ".rs" => "rust",
        ".sh" | ".zsh" => "shell",
        ".sql" => "sql",
        ".toml" => "toml",
        ".ts" => "typescript",
        ".tsx" => "tsx",
        ".xml" | ".svg" => "xml",
        ".yaml" | ".yml" => "yaml",
        ".csv" => "csv",
        ".conf" => "ini",
        ".txt" => "text",
        _ => "text",
    }
}

fn mime_for_path(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match ext.as_str() {
        "html" | "htm" => "text/html".into(),
        "css" => "text/css".into(),
        "js" | "mjs" => "text/javascript".into(),
        "json" => "application/json".into(),
        "md" => "text/markdown".into(),
        "pdf" => "application/pdf".into(),
        "png" => "image/png".into(),
        "jpg" | "jpeg" => "image/jpeg".into(),
        "gif" => "image/gif".into(),
        "webp" => "image/webp".into(),
        "svg" => "image/svg+xml".into(),
        "txt" => "text/plain".into(),
        _ => "application/octet-stream".into(),
    }
}

fn expand_user_path(raw: &str, home: &Path) -> PathBuf {
    let value = raw.trim();

    if value == "~" {
        return home.to_path_buf();
    }

    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return home.join(rest);
    }

    PathBuf::from(value)
}

fn file_url_to_path(raw: &str) -> Option<PathBuf> {
    let url = raw.trim();

    if !url.to_ascii_lowercase().starts_with("file:") {
        return None;
    }

    let parsed = url::Url::parse(url).ok()?;

    if parsed.scheme() != "file" {
        return None;
    }

    let path = percent_encoding::percent_decode(parsed.path().as_bytes())
        .decode_utf8()
        .ok()?
        .into_owned();

    // Windows file:///C:/... → /C:/... → C:/...
    let path = if path.len() >= 3
        && path.as_bytes()[0] == b'/'
        && path.as_bytes()[1].is_ascii_alphabetic()
        && path.as_bytes()[2] == b':'
    {
        path[1..].to_string()
    } else {
        path
    };

    Some(PathBuf::from(path))
}

fn default_cwd(app: &AppHandle) -> PathBuf {
    app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Resolve like Node `path.resolve`: absolute stays; relative joins cwd.
fn resolve_path(raw: &str) -> PathBuf {
    let path = PathBuf::from(raw);

    if path.is_absolute() {
        return path;
    }

    match std::env::current_dir() {
        Ok(cwd) => cwd.join(path),
        Err(_) => path,
    }
}

/// Refuse empty / missing paths; otherwise require an existing directory.
/// Packaged-install refusal is skipped here — fallback is always the home dir
/// (Electron's fuller candidate chain lands on home for Tauri's install layout).
#[tauri::command]
pub fn sanitize_workspace_cwd(app: AppHandle, cwd: Option<String>) -> SanitizeCwdResult {
    let fallback = default_cwd(&app);
    let trimmed = cwd.as_deref().map(str::trim).unwrap_or("");

    if trimmed.is_empty() {
        return SanitizeCwdResult {
            cwd: fallback.to_string_lossy().into_owned(),
            sanitized: false,
        };
    }

    let resolved = resolve_path(trimmed);

    if resolved.is_dir() {
        return SanitizeCwdResult {
            cwd: resolved.to_string_lossy().into_owned(),
            sanitized: false,
        };
    }

    SanitizeCwdResult {
        cwd: fallback.to_string_lossy().into_owned(),
        sanitized: true,
    }
}

/// Capped UTF-8 preview read with binary sniff (Electron `hermes:readFileText`).
#[tauri::command]
pub fn read_file_text(app: AppHandle, path: String) -> Result<ReadFileTextResult, String> {
    let home = default_cwd(&app);
    let raw = path.trim();

    if raw.is_empty() || raw.contains('\0') {
        return Err("Text preview failed: file path is required.".into());
    }

    let resolved = file_url_to_path(raw).unwrap_or_else(|| expand_user_path(raw, &home));
    let meta = fs::metadata(&resolved).map_err(|e| format!("Text preview failed: {e}"))?;

    if !meta.is_file() {
        return Err("Text preview failed: not a file.".into());
    }

    if meta.len() > TEXT_PREVIEW_SOURCE_MAX_BYTES {
        return Err(format!(
            "Text preview failed: file is too large ({} bytes; limit {} bytes).",
            meta.len(),
            TEXT_PREVIEW_SOURCE_MAX_BYTES
        ));
    }

    let to_read = meta.len().min(TEXT_PREVIEW_MAX_BYTES) as usize;
    let mut file = File::open(&resolved).map_err(|e| format!("Text preview failed: {e}"))?;
    let mut buffer = vec![0u8; to_read];
    let bytes_read = file
        .read(&mut buffer)
        .map_err(|e| format!("Text preview failed: {e}"))?;
    buffer.truncate(bytes_read);

    let sniff_len = bytes_read.min(4096);
    let binary = looks_binary(&buffer[..sniff_len]);
    let ext = resolved
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_default();

    Ok(ReadFileTextResult {
        path: resolved.to_string_lossy().into_owned(),
        text: String::from_utf8_lossy(&buffer).into_owned(),
        binary: Some(binary),
        byte_size: Some(meta.len()),
        language: Some(language_for_ext(&ext).into()),
        mime_type: Some(mime_for_path(&resolved)),
        truncated: Some(meta.len() > TEXT_PREVIEW_MAX_BYTES),
    })
}

fn preview_url_target(raw: &str) -> Option<PreviewTarget> {
    let url = url::Url::parse(raw).ok()?;

    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }

    let host = url.host_str()?.to_ascii_lowercase();

    if !LOCAL_PREVIEW_HOSTS.iter().any(|h| *h == host) {
        return None;
    }

    let mut normalized = url.clone();

    if host == "0.0.0.0" {
        let _ = normalized.set_host(Some("127.0.0.1"));
    }

    let label = format!(
        "{}{}",
        normalized.host_str().unwrap_or(""),
        if normalized.path() == "/" {
            ""
        } else {
            normalized.path()
        }
    );

    Some(PreviewTarget {
        kind: "url".into(),
        label,
        source: raw.to_string(),
        url: normalized.to_string(),
        path: None,
        mime_type: None,
        language: None,
        preview_kind: None,
        binary: None,
        byte_size: None,
        large: None,
    })
}

fn preview_file_target(
    app: &AppHandle,
    raw: &str,
    base_dir: Option<&str>,
) -> Option<PreviewTarget> {
    let home = default_cwd(app);
    let base = base_dir
        .map(|b| expand_user_path(b, &home))
        .unwrap_or_else(|| home.clone());

    let mut resolved = if let Some(from_url) = file_url_to_path(raw) {
        from_url
    } else {
        let expanded = expand_user_path(raw, &home);

        if expanded.is_absolute() {
            expanded
        } else {
            base.join(expanded)
        }
    };

    if resolved.is_dir() {
        resolved = resolved.join("index.html");
    }

    if !resolved.is_file() {
        return None;
    }

    let meta = fs::metadata(&resolved).ok()?;
    let mime = mime_for_path(&resolved);
    let ext = resolved
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_default();

    let mut sample = [0u8; 4096];
    let sniff = File::open(&resolved)
        .ok()
        .and_then(|mut f| {
            let n = f.read(&mut sample).ok()?;
            Some(looks_binary(&sample[..n]))
        })
        .unwrap_or(false);

    let binary = !mime.starts_with("image/") && sniff;
    let is_html = ext == ".html" || ext == ".htm";
    let is_image = mime.starts_with("image/");
    let is_pdf = ext == ".pdf" || mime == "application/pdf";
    let preview_kind = if is_html {
        "html"
    } else if is_image {
        "image"
    } else if is_pdf {
        "pdf"
    } else if binary {
        "binary"
    } else {
        "text"
    };

    let url = url::Url::from_file_path(&resolved).ok()?.to_string();

    Some(PreviewTarget {
        kind: "file".into(),
        label: resolved
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| resolved.to_string_lossy().into_owned()),
        source: raw.to_string(),
        url,
        path: Some(resolved.to_string_lossy().into_owned()),
        mime_type: Some(mime),
        language: Some(language_for_ext(&ext).into()),
        preview_kind: Some(preview_kind.into()),
        binary: Some(binary),
        byte_size: Some(meta.len()),
        large: Some(meta.len() > TEXT_PREVIEW_MAX_BYTES),
    })
}

#[tauri::command]
pub fn normalize_preview_target(
    app: AppHandle,
    target: String,
    base_dir: Option<String>,
) -> Option<PreviewTarget> {
    let raw = target.trim();

    if raw.is_empty() {
        return None;
    }

    if raw.to_ascii_lowercase().starts_with("http://")
        || raw.to_ascii_lowercase().starts_with("https://")
    {
        return preview_url_target(raw);
    }

    preview_file_target(&app, raw, base_dir.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_binary_on_nul() {
        assert!(looks_binary(&[b'a', 0, b'b']));
        assert!(!looks_binary(b"hello\nworld\t"));
    }

    #[test]
    fn language_map_covers_ts() {
        assert_eq!(language_for_ext(".ts"), "typescript");
        assert_eq!(language_for_ext(".unknown"), "text");
    }

    #[test]
    fn resolve_path_keeps_absolute() {
        let abs = if cfg!(windows) {
            PathBuf::from(r"C:\Users\me")
        } else {
            PathBuf::from("/tmp/work")
        };

        assert_eq!(resolve_path(abs.to_str().unwrap()), abs);
    }
}
