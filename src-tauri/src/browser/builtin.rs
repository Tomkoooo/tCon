//! Built-in browser engine: one native child webview (WKWebView on macOS) per "browser" editor
//! tab, laid over the tab's content area by the frontend (see src/browser/overlay.ts).
//!
//! Security model — these webviews load arbitrary sites and must never reach tCon's IPC:
//! - labels start with `browser-`; no capability lists them (default.json must target the
//!   "main" *webview*, not the "main" window, or child webviews inherit it);
//! - `guard_invoke` (lib.rs) rejects every app command coming from a `browser-*` webview, so
//!   even a page that ends up on a "local" origin can't call tCon commands;
//! - navigation is limited to http(s)/about/data/blob and never to tCon's own origins
//!   (tauri://, ipc://, asset://, the dev server), so a page can't load the app UI inside itself;
//! - no initialization scripts, no custom protocols of ours; page state (URL, title, loading)
//!   comes back only through native navigation callbacks, never through IPC from the page.

use serde::Serialize;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewBuilder, WebviewUrl};

pub const LABEL_PREFIX: &str = "browser-";
const TEMP_LABEL: &str = "browser-housekeeping";

/// Fixed WKWebsiteDataStore identifier (macOS 14+): the browser's cookies/storage live apart from
/// tCon's own UI and persist across restarts.
#[cfg(target_os = "macos")]
const DATA_STORE_ID: [u8; 16] = [0x7c, 0x0e, 0x5b, 0x1a, 0x42, 0x9d, 0x4f, 0x3e, 0x8a, 0x61, 0x0b, 0x2c, 0x93, 0xd4, 0x5e, 0x17];

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

pub fn is_browser_label(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

fn label_for(tab_id: &str) -> Result<String, String> {
    if tab_id.is_empty() || tab_id.len() > 64 || !tab_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid browser tab id".into());
    }
    Ok(format!("{LABEL_PREFIX}{tab_id}"))
}

/// Parse a URL typed by the user or restored from the workspace; only web URLs are accepted.
pub fn parse_page_url(raw: &str) -> Result<Url, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Ok(Url::parse("about:blank").unwrap());
    }
    let url = Url::parse(s).map_err(|err| format!("invalid URL: {err}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        "about" if url.as_str() == "about:blank" => Ok(url),
        other => Err(format!("{other}: URLs can't be opened in the browser")),
    }
}

fn blocked_hosts() -> &'static [String] {
    static HOSTS: OnceLock<Vec<String>> = OnceLock::new();
    HOSTS.get_or_init(|| ["tauri.localhost", "ipc.localhost", "asset.localhost"].iter().map(|s| s.to_string()).collect())
}

/// May a browser webview (any frame) navigate to `url`? `app_origin` is tCon's dev server origin.
pub fn navigation_allowed(url: &Url, app_origin: Option<&Url>) -> bool {
    match url.scheme() {
        "http" | "https" => {
            if let Some(h) = url.host_str() {
                if blocked_hosts().iter().any(|b| b.eq_ignore_ascii_case(h)) {
                    return false;
                }
            }
            match app_origin {
                Some(app) => url.origin() != app.origin(),
                None => true,
            }
        }
        "about" | "data" | "blob" => true,
        _ => false,
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PageEvent {
    tab_id: String,
    url: Option<String>,
    title: Option<String>,
    loading: Option<bool>,
    favicon: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NewWindowEvent {
    tab_id: String,
    url: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadDone {
    tab_id: String,
    path: String,
    success: bool,
}

fn emit_page(app: &AppHandle, ev: PageEvent) {
    let _ = app.emit_to("main", "browser-page", ev);
}

fn tab_of(label: &str) -> String {
    label.strip_prefix(LABEL_PREFIX).unwrap_or(label).to_string()
}

/// macOS 14+ supports separate WKWebsiteDataStores; older versions fall back to the app's
/// default store (shared with tCon's UI — "clear browsing data" is then unavailable).
pub fn isolated_store() -> bool {
    #[cfg(target_os = "macos")]
    {
        static MAJOR: OnceLock<u32> = OnceLock::new();
        *MAJOR.get_or_init(|| {
            std::process::Command::new("sw_vers")
                .arg("-productVersion")
                .output()
                .ok()
                .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().split('.').next().and_then(|m| m.parse().ok()))
                .unwrap_or(0)
        }) >= 14
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[cfg(not(target_os = "macos"))]
fn data_dir() -> PathBuf {
    crate::themes::tcon_dir().join("browser").join("webview-data")
}

fn downloads_dir() -> PathBuf {
    dirs::download_dir().or_else(|| dirs::home_dir().map(|h| h.join("Downloads"))).unwrap_or_else(std::env::temp_dir)
}

fn builder(app: &AppHandle, label: &str, url: Url) -> WebviewBuilder<tauri::Wry> {
    let app_origin = if cfg!(debug_assertions) { app.config().build.dev_url.clone() } else { None };
    let tab_id = tab_of(label);
    let (a1, a2, a3, a4) = (app.clone(), app.clone(), app.clone(), app.clone());
    let (t1, t2, t3, t4) = (tab_id.clone(), tab_id.clone(), tab_id.clone(), tab_id);

    let b = WebviewBuilder::new(label, WebviewUrl::External(url))
        .devtools(true)
        .focused(false)
        .on_navigation(move |url| navigation_allowed(url, app_origin.as_ref()))
        .on_page_load(move |wv, payload| {
            let finished = matches!(payload.event(), PageLoadEvent::Finished);
            emit_page(&a1, PageEvent { tab_id: t1.clone(), url: Some(payload.url().to_string()), title: None, loading: Some(!finished), favicon: None });
            if finished {
                // The page's own answer is untrusted data: only ever used as an <img> URL after validation.
                let (app, tab) = (a1.clone(), t1.clone());
                let _ = wv.eval_with_callback(
                    "(function(){try{var l=document.querySelector('link[rel~=\"icon\"],link[rel=\"shortcut icon\"]');return l&&l.href?l.href:location.origin+'/favicon.ico'}catch(e){return ''}})()",
                    move |raw| {
                        let icon = serde_json::from_str::<String>(&raw).unwrap_or_default();
                        let ok = icon.len() < 2048 && (icon.starts_with("https://") || icon.starts_with("http://"));
                        if ok {
                            emit_page(&app, PageEvent { tab_id: tab.clone(), url: None, title: None, loading: None, favicon: Some(icon) });
                        }
                    },
                );
            }
        })
        .on_document_title_changed(move |_wv, title| {
            emit_page(&a2, PageEvent { tab_id: t2.clone(), url: None, title: Some(title.chars().take(300).collect()), loading: None, favicon: None });
        })
        // target=_blank / window.open → a new tCon browser tab (never a new native window).
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                let _ = a3.emit_to("main", "browser-new-window", NewWindowEvent { tab_id: t3.clone(), url: url.to_string() });
            }
            NewWindowResponse::Deny
        })
        .on_download(move |_wv, event| match event {
            DownloadEvent::Requested { destination, .. } => {
                let name = destination.file_name().map(|n| n.to_os_string()).unwrap_or_else(|| "download".into());
                *destination = downloads_dir().join(name);
                true
            }
            DownloadEvent::Finished { path, success, .. } => {
                let path = path.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
                let _ = a4.emit_to("main", "browser-download", DownloadDone { tab_id: t4.clone(), path, success });
                true
            }
            _ => true,
        });

    #[cfg(target_os = "macos")]
    let b = b.data_store_identifier(DATA_STORE_ID);
    #[cfg(not(target_os = "macos"))]
    let b = b.data_directory(data_dir());
    b
}

fn get(app: &AppHandle, tab_id: &str) -> Result<Webview, String> {
    let label = label_for(tab_id)?;
    app.get_webview(&label).ok_or_else(|| "browser page not open".to_string())
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { position: LogicalPosition::new(x.max(0.0), y.max(0.0)).into(), size: LogicalSize::new(w.max(1.0), h.max(1.0)).into() }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    isolated_store: bool,
    store_location: String,
}

#[tauri::command]
pub fn browser_info() -> BrowserInfo {
    #[cfg(target_os = "macos")]
    let store_location = if isolated_store() {
        "WebKit data store (~/Library/WebKit/<app>/WebsiteDataStore)".to_string()
    } else {
        "the app's default WebKit store (macOS 13 and older)".to_string()
    };
    #[cfg(not(target_os = "macos"))]
    let store_location = data_dir().to_string_lossy().into_owned();
    BrowserInfo { isolated_store: isolated_store(), store_location }
}

/// Create (or just reposition) the webview of a browser tab. Async: `add_child` blocks on the main thread.
#[tauri::command]
pub async fn browser_create(app: AppHandle, tab_id: String, url: String, x: f64, y: f64, width: f64, height: f64, visible: bool) -> Result<(), String> {
    let label = label_for(&tab_id)?;
    if let Some(wv) = app.get_webview(&label) {
        wv.set_bounds(rect(x, y, width, height)).map_err(e)?;
        if visible { wv.show().map_err(e)? } else { wv.hide().map_err(e)? }
        return Ok(());
    }
    let url = parse_page_url(&url)?;
    let window = app.get_window("main").ok_or("main window not found")?;
    let wv = window
        .add_child(builder(&app, &label, url), LogicalPosition::new(x.max(0.0), y.max(0.0)), LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(e)?;
    if !visible {
        wv.hide().map_err(e)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_set_bounds(app: AppHandle, tab_id: String, x: f64, y: f64, width: f64, height: f64, visible: bool) -> Result<(), String> {
    let wv = get(&app, &tab_id)?;
    if visible {
        wv.set_bounds(rect(x, y, width, height)).map_err(e)?;
        wv.show().map_err(e)?;
    } else {
        wv.hide().map_err(e)?;
        // keyboard focus must not stay in an invisible page
        if let Some(main) = app.get_webview("main") {
            let _ = main.set_focus();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, tab_id: String, url: String) -> Result<(), String> {
    let url = parse_page_url(&url)?;
    get(&app, &tab_id)?.navigate(url).map_err(e)
}

/// back | forward | reload | stop
#[tauri::command]
pub async fn browser_action(app: AppHandle, tab_id: String, action: String) -> Result<(), String> {
    let wv = get(&app, &tab_id)?;
    match action.as_str() {
        "reload" => wv.reload().map_err(e),
        "back" => wv.eval("history.back()").map_err(e),
        "forward" => wv.eval("history.forward()").map_err(e),
        "stop" => wv.eval("window.stop()").map_err(e),
        "devtools" => {
            wv.open_devtools();
            Ok(())
        }
        "focus" => wv.set_focus().map_err(e),
        _ => Err(format!("unknown action {action}")),
    }
}

/// Current URL (follows pushState navigations, which fire no page-load event).
#[tauri::command]
pub async fn browser_url(app: AppHandle, tab_id: String) -> Result<String, String> {
    Ok(get(&app, &tab_id)?.url().map_err(e)?.to_string())
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, tab_id: String) -> Result<(), String> {
    if let Ok(wv) = get(&app, &tab_id) {
        wv.close().map_err(e)?;
    }
    Ok(())
}

/// Delete cookies, storage, caches of the built-in engine (all tabs share one store).
#[tauri::command]
pub async fn browser_clear_data(app: AppHandle) -> Result<(), String> {
    if !isolated_store() {
        return Err("On macOS 13 and older the built-in browser shares tCon's own WebKit store, so it can't be cleared separately.".into());
    }
    let existing = app.webviews().into_iter().find(|(label, _)| is_browser_label(label)).map(|(_, wv)| wv);
    if let Some(wv) = existing {
        wv.clear_all_browsing_data().map_err(e)?;
        return Ok(());
    }
    // No page open: use a short-lived hidden webview on the same store.
    let window = app.get_window("main").ok_or("main window not found")?;
    let wv = match app.get_webview(TEMP_LABEL) {
        Some(wv) => wv,
        None => window
            .add_child(builder(&app, TEMP_LABEL, Url::parse("about:blank").unwrap()), LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
            .map_err(e)?,
    };
    let _ = wv.hide();
    let res = wv.clear_all_browsing_data().map_err(e);
    let wv2 = wv.clone();
    tauri::async_runtime::spawn(async move {
        std::thread::sleep(std::time::Duration::from_secs(3)); // clearing is asynchronous
        let _ = wv2.close();
    });
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert_eq!(label_for("abc-12_x").unwrap(), "browser-abc-12_x");
        assert!(label_for("../x").is_err());
        assert!(label_for("").is_err());
        assert!(is_browser_label("browser-x"));
        assert!(!is_browser_label("main"));
    }

    #[test]
    fn page_urls() {
        assert!(parse_page_url("http://localhost:5173").is_ok());
        assert!(parse_page_url("https://example.com/x").is_ok());
        assert_eq!(parse_page_url("").unwrap().as_str(), "about:blank");
        assert!(parse_page_url("tauri://localhost/").is_err());
        assert!(parse_page_url("file:///etc/passwd").is_err());
        assert!(parse_page_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn navigation_policy() {
        let dev = Url::parse("http://localhost:1420").unwrap();
        let ok = |s: &str| navigation_allowed(&Url::parse(s).unwrap(), Some(&dev));
        assert!(ok("http://localhost:5173/"));
        assert!(ok("https://example.com"));
        assert!(ok("about:blank"));
        assert!(ok("data:text/html,hi"));
        assert!(!ok("http://localhost:1420/"));
        assert!(!ok("tauri://localhost/"));
        assert!(!ok("ipc://localhost/cmd"));
        assert!(!ok("asset://localhost/x"));
        assert!(!ok("http://tauri.localhost/"));
        assert!(!ok("file:///etc/hosts"));
        assert!(navigation_allowed(&Url::parse("http://localhost:1420/").unwrap(), None));
    }
}
