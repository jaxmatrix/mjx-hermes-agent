//! Favicon resolution — Electron `electron/favicon.ts` + main-process cache.
//!
//! Cross-origin HTML is unreadable from the webview (CORS), so the ladder runs
//! here. Only the site's own marks — never a third-party icon service.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use url::Url;

use crate::transport::TransportState;

const SCORE_SVG: i32 = 1024;
const SCORE_ANY: i32 = 512;
const SCORE_APPLE_TOUCH: i32 = 180;
const SCORE_UNSIZED: i32 = 96;
const SCORE_GUESS: i32 = 48;
const SCORE_CEILING: i32 = 512;

const FAVICON_CACHE_LIMIT: usize = 400;
const FAVICON_TTL_MS: u128 = 30 * 24 * 60 * 60 * 1000;
const FAVICON_MISS_TTL_MS: u128 = 12 * 60 * 60 * 1000;
const FAVICON_TIMEOUT: Duration = Duration::from_secs(6);
const FAVICON_MAX_BYTES: usize = 256 * 1024;
const TEXT_BUDGET: usize = 96 * 1024 * 2;
const USER_AGENT: &str = "Mozilla/5.0 (compatible; Hermes-Universal/1.0)";

#[derive(Clone, Debug)]
pub struct IconCandidate {
    pub url: String,
    pub score: i32,
}

#[derive(Clone, Serialize, Deserialize)]
struct CacheEntry {
    at: u128,
    icon: String,
}

#[derive(Default)]
pub struct FaviconState {
    memory: Mutex<HashMap<String, CacheEntry>>,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("favicon-cache.json"))
}

fn load_cache(app: &AppHandle, state: &FaviconState) {
    let mut guard = state.memory.lock().unwrap_or_else(|e| e.into_inner());
    if !guard.is_empty() {
        return;
    }
    let Some(path) = cache_path(app) else {
        return;
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    let Some(icons) = parsed.get("icons").and_then(|v| v.as_object()) else {
        return;
    };
    let now = now_ms();
    for (host, entry) in icons {
        let at = entry.get("at").and_then(|v| v.as_u64()).unwrap_or(0) as u128;
        let icon = entry
            .get("icon")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let ttl = if icon.is_empty() {
            FAVICON_MISS_TTL_MS
        } else {
            FAVICON_TTL_MS
        };
        if now.saturating_sub(at) < ttl {
            guard.insert(host.clone(), CacheEntry { at, icon });
        }
    }
}

fn save_cache(app: &AppHandle, state: &FaviconState) {
    let Some(path) = cache_path(app) else {
        return;
    };
    let guard = state.memory.lock().unwrap_or_else(|e| e.into_inner());
    let mut icons = serde_json::Map::new();
    for (host, entry) in guard.iter() {
        icons.insert(
            host.clone(),
            serde_json::json!({ "at": entry.at, "icon": entry.icon }),
        );
    }
    let _ = fs::create_dir_all(path.parent().unwrap_or(std::path::Path::new(".")));
    let _ = fs::write(
        path,
        serde_json::to_string(&serde_json::json!({ "icons": icons })).unwrap_or_default(),
    );
}

pub fn is_public_http_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    if host == "localhost"
        || host == "::1"
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || !host.contains('.')
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || host.starts_with("169.254.")
    {
        return false;
    }
    if let Some(rest) = host.strip_prefix("172.") {
        if let Some(second) = rest.split('.').next() {
            if let Ok(n) = second.parse::<u8>() {
                if (16..=31).contains(&n) {
                    return false;
                }
            }
        }
    }
    true
}

fn favicon_cache_key(raw: &str) -> String {
    Url::parse(raw)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|h| {
            let lower = h.to_ascii_lowercase();
            lower.strip_prefix("www.").unwrap_or(&lower).to_string()
        })
        .unwrap_or_default()
}

fn absolute(href: &str, base: &str) -> String {
    let Ok(url) = Url::parse(base).and_then(|b| b.join(href.trim())) else {
        return String::new();
    };
    if url.scheme() == "http" || url.scheme() == "https" {
        url.to_string()
    } else {
        String::new()
    }
}

pub fn largest_declared_size(sizes: &str) -> i32 {
    let mut best = 0i32;
    for token in sizes.to_ascii_lowercase().split_whitespace() {
        if token == "any" {
            best = best.max(SCORE_ANY);
            continue;
        }
        if let Some(edge) = token.split('x').next().and_then(|s| s.parse::<i32>().ok()) {
            best = best.max(edge);
        }
    }
    best
}

fn attr(tag: &str, name: &str) -> String {
    let re = Regex::new(&format!(
        r#"(?i)\b{}\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))"#,
        regex::escape(name)
    ))
    .ok();
    let Some(re) = re else {
        return String::new();
    };
    let Some(caps) = re.captures(tag) else {
        return String::new();
    };
    caps.get(2)
        .or_else(|| caps.get(3))
        .or_else(|| caps.get(4))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default()
}

fn score_for(rel: &str, typ: &str, sizes: &str) -> i32 {
    if typ.contains("svg") || rel.contains("mask-icon") {
        return SCORE_SVG;
    }
    let declared = largest_declared_size(sizes);
    if declared > 0 {
        return declared.min(SCORE_CEILING);
    }
    if rel.contains("apple-touch-icon") {
        SCORE_APPLE_TOUCH
    } else {
        SCORE_UNSIZED
    }
}

pub fn icon_candidates_from_html(html: &str, page_url: &str) -> Vec<IconCandidate> {
    let base_re = Regex::new(r"(?i)<base\b[^>]*>").ok();
    let base_tag = base_re
        .as_ref()
        .and_then(|re| re.find(html))
        .map(|m| m.as_str())
        .unwrap_or("");
    let base_href = attr(base_tag, "href");
    let base = {
        let abs = absolute(&base_href, page_url);
        if abs.is_empty() {
            page_url.to_string()
        } else {
            abs
        }
    };

    let link_re = Regex::new(r"(?i)<link\b[^>]*>").ok();
    let mut candidates = Vec::new();
    let Some(link_re) = link_re else {
        return candidates;
    };
    let rel_ok = Regex::new(
        r"(?i)\b(icon|shortcut icon|apple-touch-icon|apple-touch-icon-precomposed|fluid-icon|mask-icon)\b",
    )
    .ok();
    let Some(rel_ok) = rel_ok else {
        return candidates;
    };

    for m in link_re.find_iter(html) {
        let tag = m.as_str();
        let rel = attr(tag, "rel").to_ascii_lowercase();
        if !rel_ok.is_match(&rel) {
            continue;
        }
        let url = absolute(&attr(tag, "href"), &base);
        if !url.is_empty() {
            candidates.push(IconCandidate {
                score: score_for(
                    &rel,
                    &attr(tag, "type").to_ascii_lowercase(),
                    &attr(tag, "sizes"),
                ),
                url,
            });
        }
    }
    candidates
}

pub fn manifest_url_from_html(html: &str, page_url: &str) -> String {
    let link_re = Regex::new(r"(?i)<link\b[^>]*>").ok();
    let Some(link_re) = link_re else {
        return String::new();
    };
    for m in link_re.find_iter(html) {
        let tag = m.as_str();
        if attr(tag, "rel").to_ascii_lowercase().contains("manifest") {
            return absolute(&attr(tag, "href"), page_url);
        }
    }
    String::new()
}

pub fn icon_candidates_from_manifest(raw: &str, manifest_url: &str) -> Vec<IconCandidate> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(icons) = parsed.get("icons").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    for icon in icons {
        let src = icon
            .get("src")
            .and_then(|v| v.as_str())
            .map(|s| absolute(s, manifest_url))
            .unwrap_or_default();
        if src.is_empty() {
            continue;
        }
        let typ = icon
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let sizes = icon.get("sizes").and_then(|v| v.as_str()).unwrap_or("");
        candidates.push(IconCandidate {
            score: score_for("", &typ, sizes),
            url: src,
        });
    }
    candidates
}

pub fn fallback_icon_candidates(page_url: &str) -> Vec<IconCandidate> {
    let Ok(url) = Url::parse(page_url) else {
        return Vec::new();
    };
    let host = url.host_str().unwrap_or("").to_string();
    let labels: Vec<&str> = host.split('.').collect();
    let apex = if labels.len() > 2 {
        format!(
            "{}//{}.{}",
            url.scheme(),
            labels[labels.len() - 2],
            labels[labels.len() - 1]
        )
    } else {
        url.origin().ascii_serialization()
    };
    let origins = {
        let mut v = vec![url.origin().ascii_serialization(), apex];
        v.sort();
        v.dedup();
        v
    };
    let mut out = Vec::new();
    for origin in origins {
        out.push(IconCandidate {
            score: SCORE_GUESS + 2,
            url: format!("{origin}/apple-touch-icon.png"),
        });
        out.push(IconCandidate {
            score: SCORE_GUESS + 1,
            url: format!("{origin}/apple-touch-icon-precomposed.png"),
        });
        out.push(IconCandidate {
            score: SCORE_GUESS,
            url: format!("{origin}/favicon.ico"),
        });
        out.push(IconCandidate {
            score: SCORE_GUESS - 1,
            url: format!("{origin}/favicon.png"),
        });
    }
    out
}

pub fn rank_candidates(candidates: &[IconCandidate], limit: usize) -> Vec<IconCandidate> {
    let mut best: HashMap<String, i32> = HashMap::new();
    for c in candidates {
        let entry = best.entry(c.url.clone()).or_insert(0);
        *entry = (*entry).max(c.score);
    }
    let mut ranked: Vec<_> = best
        .into_iter()
        .map(|(url, score)| IconCandidate { url, score })
        .collect();
    ranked.sort_by(|a, b| b.score.cmp(&a.score));
    ranked.truncate(limit);
    ranked
}

pub fn sniff_image_mime(bytes: &[u8]) -> &'static str {
    let at = |offset: usize, sig: &[u8]| {
        bytes.len() >= offset + sig.len() && &bytes[offset..offset + sig.len()] == sig
    };
    if at(0, &[0x89, 0x50, 0x4e, 0x47]) {
        return "image/png";
    }
    if at(0, &[0xff, 0xd8, 0xff]) {
        return "image/jpeg";
    }
    if at(0, &[0x47, 0x49, 0x46, 0x38]) {
        return "image/gif";
    }
    if at(0, &[0x00, 0x00, 0x01, 0x00]) {
        return "image/x-icon";
    }
    if at(0, &[0x52, 0x49, 0x46, 0x46]) && at(8, &[0x57, 0x45, 0x42, 0x50]) {
        return "image/webp";
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
    if head.contains("<svg") {
        "image/svg+xml"
    } else {
        ""
    }
}

pub fn image_mime(declared: &str, bytes: &[u8]) -> String {
    if bytes.len() < 48 {
        return String::new();
    }
    let sniffed = sniff_image_mime(bytes);
    if !sniffed.is_empty() {
        return sniffed.to_string();
    }
    if declared.to_ascii_lowercase().contains("svg") {
        "image/svg+xml".into()
    } else {
        String::new()
    }
}

fn to_data_url(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> String {
    let Ok(resp) = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
        )
        .timeout(FAVICON_TIMEOUT)
        .send()
        .await
    else {
        return String::new();
    };
    if !resp.status().is_success() {
        return String::new();
    }
    match resp.text().await {
        Ok(body) => body.chars().take(TEXT_BUDGET).collect(),
        Err(_) => String::new(),
    }
}

async fn fetch_image(client: &reqwest::Client, url: &str) -> Option<(Vec<u8>, String)> {
    let Ok(resp) = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "image/*,*/*;q=0.5")
        .timeout(FAVICON_TIMEOUT)
        .send()
        .await
    else {
        return None;
    };
    if !resp.status().is_success() {
        return None;
    }
    let mime = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let Ok(bytes) = resp.bytes().await else {
        return None;
    };
    if bytes.len() > FAVICON_MAX_BYTES || bytes.is_empty() {
        return None;
    }
    Some((bytes.to_vec(), mime))
}

async fn resolve_favicon_ladder(client: &reqwest::Client, page_url: &str) -> String {
    if !is_public_http_url(page_url) {
        return String::new();
    }

    let mut candidates = Vec::new();
    let html = fetch_text(client, page_url).await;
    if !html.is_empty() {
        candidates.extend(icon_candidates_from_html(&html, page_url));
        let manifest_url = manifest_url_from_html(&html, page_url);
        if !manifest_url.is_empty() {
            let manifest = fetch_text(client, &manifest_url).await;
            if !manifest.is_empty() {
                candidates.extend(icon_candidates_from_manifest(&manifest, &manifest_url));
            }
        }
    }
    candidates.extend(fallback_icon_candidates(page_url));

    for candidate in rank_candidates(&candidates, 6) {
        if let Some((bytes, declared)) = fetch_image(client, &candidate.url).await {
            let mime = image_mime(&declared, &bytes);
            if !mime.is_empty() {
                return to_data_url(&mime, &bytes);
            }
        }
    }
    String::new()
}

#[tauri::command]
pub async fn resolve_favicon(
    app: AppHandle,
    transport: State<'_, TransportState>,
    state: State<'_, FaviconState>,
    url: String,
) -> Result<String, String> {
    let raw = url.trim().to_string();
    let key = favicon_cache_key(&raw);
    if key.is_empty() {
        return Ok(String::new());
    }

    load_cache(&app, &state);

    {
        let guard = state.memory.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(hit) = guard.get(&key) {
            let ttl = if hit.icon.is_empty() {
                FAVICON_MISS_TTL_MS
            } else {
                FAVICON_TTL_MS
            };
            if now_ms().saturating_sub(hit.at) < ttl {
                return Ok(hit.icon.clone());
            }
        }
    }

    let icon = resolve_favicon_ladder(transport.client(), &raw).await;

    {
        let mut guard = state.memory.lock().unwrap_or_else(|e| e.into_inner());
        if guard.len() >= FAVICON_CACHE_LIMIT {
            if let Some(oldest) = guard.keys().next().cloned() {
                guard.remove(&oldest);
            }
        }
        guard.insert(
            key,
            CacheEntry {
                at: now_ms(),
                icon: icon.clone(),
            },
        );
    }
    save_cache(&app, &state);

    Ok(icon)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_hosts_only() {
        assert!(is_public_http_url("https://linear.app"));
        assert!(!is_public_http_url("http://localhost:8000/mcp"));
        assert!(!is_public_http_url("http://127.0.0.1:3000"));
        assert!(!is_public_http_url("http://192.168.1.5"));
        assert!(!is_public_http_url("http://172.16.0.9"));
        assert!(!is_public_http_url("file:///etc/passwd"));
    }

    #[test]
    fn declared_icons_absolute() {
        let found = icon_candidates_from_html(
            r#"<link rel="icon" href="/assets/mark.png">"#,
            "https://acme.test/docs/start",
        );
        assert_eq!(found[0].url, "https://acme.test/assets/mark.png");
    }

    #[test]
    fn sniff_png() {
        let mut bytes = vec![0x89, 0x50, 0x4e, 0x47];
        bytes.extend(std::iter::repeat(0).take(60));
        assert_eq!(sniff_image_mime(&bytes), "image/png");
    }

    #[test]
    fn rank_prefers_higher_score() {
        let ranked = rank_candidates(
            &[
                IconCandidate {
                    url: "a".into(),
                    score: 10,
                },
                IconCandidate {
                    url: "b".into(),
                    score: 100,
                },
            ],
            6,
        );
        assert_eq!(ranked[0].url, "b");
    }
}
