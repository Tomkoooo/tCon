//! Chrome engine: the user's installed Chrome/Chromium/Brave/Edge, launched on a tCon-managed
//! profile (`~/.tcon/browser/chrome-profile`) with the DevTools protocol on 127.0.0.1, and driven
//! through CDP's HTTP endpoints (/json/list, /json/new, /json/activate, /json/close).
//!
//! A dedicated user-data-dir is required: Chrome 136+ refuses --remote-debugging-port on the
//! default profile, and any local process can drive a debug-enabled profile, so it must never be
//! the user's main one.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    Chrome,
    Canary,
    Chromium,
    Brave,
    Edge,
    Arc,
    Other,
}

impl Family {
    pub fn label(self) -> &'static str {
        match self {
            Family::Chrome => "Google Chrome",
            Family::Canary => "Chrome Canary",
            Family::Chromium => "Chromium",
            Family::Brave => "Brave",
            Family::Edge => "Microsoft Edge",
            Family::Arc => "Arc",
            Family::Other => "Chromium-based browser",
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChromeBinary {
    pub family: Family,
    pub name: String,
    pub path: String,
}

pub fn managed_dir() -> PathBuf {
    crate::themes::tcon_dir().join("browser").join("chrome-profile")
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

// ---------------------------------------------------------------- detection

/// Known install locations, in preference order, for an OS ("macos" | "linux" | "windows").
pub fn candidates(os: &str, home: &Path, env: &dyn Fn(&str) -> Option<String>) -> Vec<(Family, &'static str, PathBuf)> {
    let mut v = Vec::new();
    match os {
        "macos" => {
            let apps: [(Family, &'static str, &str); 5] = [
                (Family::Chrome, "Google Chrome", "Google Chrome.app/Contents/MacOS/Google Chrome"),
                (Family::Brave, "Brave Browser", "Brave Browser.app/Contents/MacOS/Brave Browser"),
                (Family::Edge, "Microsoft Edge", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
                (Family::Chromium, "Chromium", "Chromium.app/Contents/MacOS/Chromium"),
                (Family::Canary, "Google Chrome Canary", "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"),
            ];
            for (f, name, rel) in apps {
                v.push((f, name, Path::new("/Applications").join(rel)));
                v.push((f, name, home.join("Applications").join(rel)));
            }
        }
        "windows" => {
            let roots: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"].iter().filter_map(|k| env(k)).map(PathBuf::from).collect();
            let apps: [(Family, &'static str, &str); 4] = [
                (Family::Chrome, "Google Chrome", r"Google\Chrome\Application\chrome.exe"),
                (Family::Brave, "Brave Browser", r"BraveSoftware\Brave-Browser\Application\brave.exe"),
                (Family::Edge, "Microsoft Edge", r"Microsoft\Edge\Application\msedge.exe"),
                (Family::Chromium, "Chromium", r"Chromium\Application\chrome.exe"),
            ];
            for (f, name, rel) in apps {
                for r in &roots {
                    v.push((f, name, r.join(rel)));
                }
            }
        }
        _ => {
            let bins: [(Family, &'static str, &str); 6] = [
                (Family::Chrome, "Google Chrome", "google-chrome"),
                (Family::Chrome, "Google Chrome", "google-chrome-stable"),
                (Family::Brave, "Brave Browser", "brave-browser"),
                (Family::Edge, "Microsoft Edge", "microsoft-edge"),
                (Family::Chromium, "Chromium", "chromium"),
                (Family::Chromium, "Chromium", "chromium-browser"),
            ];
            for (f, name, bin) in bins {
                for dir in ["/usr/bin", "/usr/local/bin", "/snap/bin"] {
                    v.push((f, name, Path::new(dir).join(bin)));
                }
            }
        }
    }
    v
}

pub fn current_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

pub fn detect_with(os: &str, home: &Path, env: &dyn Fn(&str) -> Option<String>, exists: &dyn Fn(&Path) -> bool) -> Vec<ChromeBinary> {
    let mut out: Vec<ChromeBinary> = Vec::new();
    for (family, name, path) in candidates(os, home, env) {
        if exists(&path) && !out.iter().any(|b| b.family == family && b.name == name) {
            out.push(ChromeBinary { family, name: name.to_string(), path: path.to_string_lossy().into_owned() });
        }
    }
    out
}

pub fn detect() -> Vec<ChromeBinary> {
    detect_with(current_os(), &home(), &|k| std::env::var(k).ok(), &|p| p.is_file())
}

/// Family of a user-chosen binary path, from its file name.
pub fn family_of(path: &str) -> Family {
    let name = Path::new(path).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let full = path.to_lowercase();
    if name.contains("brave") {
        Family::Brave
    } else if name.contains("edge") {
        Family::Edge
    } else if name.contains("canary") {
        Family::Canary
    } else if name.contains("chromium") || (name == "chrome.exe" && full.contains("chromium")) {
        Family::Chromium
    } else if name.contains("chrome") {
        Family::Chrome
    } else if name.contains("arc") {
        Family::Arc
    } else {
        Family::Other
    }
}

/// The binary to use: the configured path if it exists, else the first detected one.
pub fn resolve_binary(configured: Option<&str>) -> Option<ChromeBinary> {
    if let Some(p) = configured.map(str::trim).filter(|p| !p.is_empty()) {
        if Path::new(p).is_file() {
            let family = family_of(p);
            let name = detect().into_iter().find(|b| b.path == p).map(|b| b.name).unwrap_or_else(|| family.label().to_string());
            return Some(ChromeBinary { family, name, path: p.to_string() });
        }
        return None;
    }
    detect().into_iter().next()
}

/// Default (user-level) user-data-dirs of Chromium-family browsers.
pub fn user_data_dirs(os: &str, home: &Path, env: &dyn Fn(&str) -> Option<String>) -> Vec<(Family, PathBuf)> {
    match os {
        "macos" => {
            let s = home.join("Library/Application Support");
            vec![
                (Family::Chrome, s.join("Google/Chrome")),
                (Family::Brave, s.join("BraveSoftware/Brave-Browser")),
                (Family::Edge, s.join("Microsoft Edge")),
                (Family::Chromium, s.join("Chromium")),
                (Family::Canary, s.join("Google/Chrome Canary")),
                (Family::Arc, s.join("Arc/User Data")),
            ]
        }
        "windows" => match env("LOCALAPPDATA") {
            Some(l) => {
                let l = PathBuf::from(l);
                vec![
                    (Family::Chrome, l.join(r"Google\Chrome\User Data")),
                    (Family::Brave, l.join(r"BraveSoftware\Brave-Browser\User Data")),
                    (Family::Edge, l.join(r"Microsoft\Edge\User Data")),
                    (Family::Chromium, l.join(r"Chromium\User Data")),
                ]
            }
            None => vec![],
        },
        _ => {
            let c = home.join(".config");
            vec![
                (Family::Chrome, c.join("google-chrome")),
                (Family::Brave, c.join("BraveSoftware/Brave-Browser")),
                (Family::Edge, c.join("microsoft-edge")),
                (Family::Chromium, c.join("chromium")),
            ]
        }
    }
}

// ---------------------------------------------------------------- CDP over HTTP (no extra deps)

/// Split a raw HTTP/1.1 response into (status, body), handling Content-Length and chunked bodies.
/// Returns None while the response is still incomplete.
pub fn parse_http_response(buf: &[u8], eof: bool) -> Option<Result<(u16, String), String>> {
    let head_end = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&buf[..head_end]);
    let body = &buf[head_end + 4..];
    let mut lines = head.split("\r\n");
    let status = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|s| s.parse::<u16>().ok());
    let Some(status) = status else { return Some(Err("bad HTTP response".into())) };
    let mut content_length = None;
    let mut chunked = false;
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            let k = k.trim().to_ascii_lowercase();
            if k == "content-length" {
                content_length = v.trim().parse::<usize>().ok();
            } else if k == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            }
        }
    }
    if chunked {
        let mut out = Vec::new();
        let mut rest = body;
        loop {
            let Some(line_end) = rest.windows(2).position(|w| w == b"\r\n") else { return if eof { Some(Err("truncated chunked body".into())) } else { None } };
            let size_str = String::from_utf8_lossy(&rest[..line_end]);
            let Ok(size) = usize::from_str_radix(size_str.split(';').next().unwrap_or("").trim(), 16) else { return Some(Err("bad chunk size".into())) };
            rest = &rest[line_end + 2..];
            if size == 0 {
                return Some(Ok((status, String::from_utf8_lossy(&out).into_owned())));
            }
            if rest.len() < size + 2 {
                return if eof { Some(Err("truncated chunk".into())) } else { None };
            }
            out.extend_from_slice(&rest[..size]);
            rest = &rest[size + 2..];
        }
    }
    match content_length {
        Some(n) if body.len() >= n => Some(Ok((status, String::from_utf8_lossy(&body[..n]).into_owned()))),
        Some(_) if !eof => None,
        None if !eof => None,
        _ => Some(Ok((status, String::from_utf8_lossy(body).into_owned()))),
    }
}

fn http(port: u16, method: &str, path: &str) -> Result<(u16, String), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(700)).map_err(|e| format!("can't reach 127.0.0.1:{port}: {e}"))?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(4)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    let req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match s.read(&mut chunk) {
            Ok(0) => return parse_http_response(&buf, true).unwrap_or_else(|| Err("empty response".into())),
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(r) = parse_http_response(&buf, false) {
                    return r;
                }
                if buf.len() > 8 * 1024 * 1024 {
                    return Err("response too large".into());
                }
            }
            Err(e) => return parse_http_response(&buf, true).unwrap_or_else(|| Err(e.to_string())),
        }
    }
}

fn http_ok(port: u16, method: &str, path: &str) -> Result<String, String> {
    let (status, body) = http(port, method, path)?;
    if (200..300).contains(&status) { Ok(body) } else { Err(format!("Chrome answered {status}: {}", body.trim())) }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChromeTab {
    pub id: String,
    pub title: String,
    pub url: String,
    pub favicon_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTarget {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    favicon_url: Option<String>,
}

/// Page targets from /json/list (skips service workers, extension backgrounds and DevTools windows).
pub fn parse_targets(json: &str) -> Result<Vec<ChromeTab>, String> {
    let raw: Vec<RawTarget> = serde_json::from_str(json).map_err(|e| format!("bad /json/list: {e}"))?;
    Ok(raw
        .into_iter()
        .filter(|t| t.kind == "page" && !t.url.starts_with("devtools://") && !t.url.starts_with("chrome-extension://"))
        .map(|t| ChromeTab { id: t.id, title: t.title, url: t.url, favicon_url: t.favicon_url })
        .collect())
}

fn parse_target(json: &str) -> Result<ChromeTab, String> {
    let t: RawTarget = serde_json::from_str(json).map_err(|e| format!("bad /json/new: {e}"))?;
    Ok(ChromeTab { id: t.id, title: t.title, url: t.url, favicon_url: t.favicon_url })
}

/// Percent-encode for the /json/new query (Chrome unescapes it).
pub fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn valid_target_id(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { Ok(id) } else { Err("invalid tab id".into()) }
}

/// Only web URLs are opened in the managed browser from tCon.
fn check_url(url: &str) -> Result<(), String> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower == "about:blank" { Ok(()) } else { Err("only http(s) URLs can be opened".into()) }
}

pub fn list_tabs(port: u16) -> Result<Vec<ChromeTab>, String> {
    parse_targets(&http_ok(port, "GET", "/json/list")?)
}

pub fn open_tab(port: u16, url: &str) -> Result<ChromeTab, String> {
    check_url(url)?;
    let path = format!("/json/new?{}", encode_component(url.trim()));
    // Chrome 111+ requires PUT; older versions only accept GET.
    match http(port, "PUT", &path)? {
        (200, body) => parse_target(&body),
        _ => parse_target(&http_ok(port, "GET", &path)?),
    }
}

pub fn activate_tab(port: u16, id: &str) -> Result<(), String> {
    http_ok(port, "GET", &format!("/json/activate/{}", valid_target_id(id)?)).map(|_| ())
}

pub fn close_tab(port: u16, id: &str) -> Result<(), String> {
    http_ok(port, "GET", &format!("/json/close/{}", valid_target_id(id)?)).map(|_| ())
}

/// Browser product string ("Chrome/131.0…") if a CDP endpoint answers on `port`.
pub fn probe(port: u16) -> Option<String> {
    let body = http_ok(port, "GET", "/json/version").ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    Some(v.get("Browser").and_then(|b| b.as_str()).unwrap_or("Chromium").to_string())
}

/// Port written by Chrome to <user-data-dir>/DevToolsActivePort.
pub fn active_port_file(dir: &Path) -> Option<u16> {
    std::fs::read_to_string(dir.join("DevToolsActivePort")).ok()?.lines().next()?.trim().parse().ok()
}

// ---------------------------------------------------------------- process / profile state

/// Is the profile at `dir` in use by a live browser process (Chrome's SingletonLock → "host-pid")?
pub fn profile_in_use(dir: &Path) -> bool {
    #[cfg(unix)]
    {
        let Ok(target) = std::fs::read_link(dir.join("SingletonLock")) else { return false };
        let target = target.to_string_lossy().into_owned();
        let Some(pid) = target.rsplit('-').next().and_then(|p| p.parse::<u32>().ok()) else { return true };
        Command::new("kill").args(["-0", &pid.to_string()]).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(true)
    }
    #[cfg(not(unix))]
    {
        // Chrome keeps "lockfile" open exclusively while running.
        let lock = dir.join("lockfile");
        lock.exists() && std::fs::OpenOptions::new().write(true).open(&lock).is_err()
    }
}

#[derive(Default)]
pub struct ChromeState {
    child: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
}

impl ChromeState {
    /// Port of the running managed browser, if it answers.
    pub fn running_port(&self) -> Option<(u16, String)> {
        if let Some(c) = self.child.lock().as_mut() {
            let _ = c.try_wait(); // reap
        }
        let mut ports: Vec<u16> = Vec::new();
        if let Some(p) = *self.port.lock() {
            ports.push(p);
        }
        if let Some(p) = active_port_file(&managed_dir()) {
            if !ports.contains(&p) {
                ports.push(p);
            }
        }
        for p in ports {
            if let Some(v) = probe(p) {
                *self.port.lock() = Some(p);
                return Some((p, v));
            }
        }
        None
    }

    pub fn require_port(&self) -> Result<u16, String> {
        self.running_port().map(|(p, _)| p).ok_or_else(|| "The tCon Chrome profile isn't running. Launch it from the Browser view.".into())
    }

    /// Launch the managed browser (or reuse it) and optionally open `url` in it.
    pub fn launch(&self, binary: &ChromeBinary, preferred_port: u16, url: Option<&str>) -> Result<u16, String> {
        if let Some(u) = url {
            check_url(u)?;
        }
        if let Some((port, _)) = self.running_port() {
            if let Some(u) = url {
                open_tab(port, u)?;
            }
            return Ok(port);
        }
        let dir = managed_dir();
        if profile_in_use(&dir) {
            return Err("The tCon Chrome profile is already open in a browser without the debugging port (maybe started by hand). Quit that browser window and try again.".into());
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(dir.join("DevToolsActivePort"));
        let _ = mirror_native_hosts(&dir);
        let port = pick_port(preferred_port);
        let mut cmd = Command::new(&binary.path);
        cmd.arg(format!("--user-data-dir={}", dir.to_string_lossy()))
            .arg(format!("--remote-debugging-port={port}"))
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(u) = url {
            cmd.arg(u.trim());
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0); // survive Ctrl-C of `tauri dev` / tCon quitting
        }
        let child = cmd.spawn().map_err(|e| format!("couldn't start {}: {e}", binary.name))?;
        *self.child.lock() = Some(child);
        *self.port.lock() = Some(port);
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(20) {
            if probe(port).is_some() {
                return Ok(port);
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        Err(format!("{} started but its debugging port {port} didn't answer.", binary.name))
    }
}

/// `preferred` if free on 127.0.0.1, else any free port.
pub fn pick_port(preferred: u16) -> u16 {
    if preferred > 0 && TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()).map(|a| a.port()).unwrap_or(9333)
}

// ---------------------------------------------------------------- Claude in Chrome native host

/// Chrome looks for user-level native messaging hosts in <user-data-dir>/NativeMessagingHosts
/// (macOS/Linux), so a custom profile doesn't see the ones Claude Code installed for the default
/// profile. Copy Anthropic's manifests over so the Claude in Chrome extension can talk to Claude Code.
pub fn native_host_sources() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for (_, dir) in user_data_dirs(current_os(), &home(), &|k| std::env::var(k).ok()) {
        let d = dir.join("NativeMessagingHosts");
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("com.anthropic.") && name.ends_with(".json") && !out.iter().any(|p: &PathBuf| p.file_name() == Some(entry.file_name().as_os_str())) {
                out.push(entry.path());
            }
        }
    }
    out
}

pub fn mirror_native_hosts(dir: &Path) -> Result<Vec<String>, String> {
    if cfg!(windows) {
        return Ok(vec![]); // registry-based: already global
    }
    let dest = dir.join("NativeMessagingHosts");
    let mut linked = Vec::new();
    for src in native_host_sources() {
        let Some(name) = src.file_name() else { continue };
        let target = dest.join(name);
        let content = std::fs::read(&src).map_err(|e| e.to_string())?;
        if std::fs::read(&target).ok().as_deref() != Some(&content[..]) {
            std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            std::fs::write(&target, &content).map_err(|e| e.to_string())?;
        }
        linked.push(name.to_string_lossy().into_owned());
    }
    Ok(linked)
}

// ---------------------------------------------------------------- commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeStatus {
    running: bool,
    port: Option<u16>,
    endpoint: Option<String>,
    version: Option<String>,
    profile_dir: String,
    profile_exists: bool,
    binary: Option<ChromeBinary>,
    detected: Vec<ChromeBinary>,
    native_hosts: Vec<String>,
    native_hosts_linked: Vec<String>,
}

fn status(state: &ChromeState, configured: Option<&str>) -> ChromeStatus {
    let dir = managed_dir();
    let running = state.running_port();
    let linked_dir = dir.join("NativeMessagingHosts");
    let native_hosts: Vec<String> = native_host_sources().iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
    let native_hosts_linked = native_hosts.iter().filter(|n| linked_dir.join(n).is_file()).cloned().collect();
    ChromeStatus {
        running: running.is_some(),
        port: running.as_ref().map(|r| r.0),
        endpoint: running.as_ref().map(|r| format!("http://127.0.0.1:{}", r.0)),
        version: running.map(|r| r.1),
        profile_dir: dir.to_string_lossy().into_owned(),
        profile_exists: dir.join("Local State").exists() || dir.join("Default").exists(),
        binary: resolve_binary(configured),
        detected: detect(),
        native_hosts,
        native_hosts_linked,
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn chrome_status(app: tauri::AppHandle, binary: Option<String>) -> Result<ChromeStatus, String> {
    use tauri::Manager;
    blocking(move || Ok(status(&app.state::<ChromeState>(), binary.as_deref()))).await
}

#[tauri::command]
pub async fn chrome_launch(app: tauri::AppHandle, binary: Option<String>, port: Option<u16>, url: Option<String>) -> Result<ChromeStatus, String> {
    use tauri::Manager;
    blocking(move || {
        let bin = resolve_binary(binary.as_deref()).ok_or_else(|| match binary.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(p) => format!("Chrome binary not found: {p}"),
            None => "No Chrome, Chromium, Brave or Edge installation found. Set the path in Settings → Browser.".to_string(),
        })?;
        let state = app.state::<ChromeState>();
        state.launch(&bin, port.unwrap_or(9333), url.as_deref())?;
        Ok(status(&state, binary.as_deref()))
    })
    .await
}

#[tauri::command]
pub async fn chrome_tabs(app: tauri::AppHandle) -> Result<Vec<ChromeTab>, String> {
    use tauri::Manager;
    blocking(move || {
        let state = app.state::<ChromeState>();
        let port = *state.port.lock();
        // fast path: the known port (status polling refreshes it)
        match port.map(list_tabs) {
            Some(Ok(t)) => Ok(t),
            _ => list_tabs(state.require_port()?),
        }
    })
    .await
}

#[tauri::command]
pub async fn chrome_open(app: tauri::AppHandle, url: String) -> Result<ChromeTab, String> {
    use tauri::Manager;
    blocking(move || {
        let port = app.state::<ChromeState>().require_port()?;
        let tab = open_tab(port, &url)?;
        let _ = activate_tab(port, &tab.id);
        Ok(tab)
    })
    .await
}

#[tauri::command]
pub async fn chrome_activate(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    blocking(move || activate_tab(app.state::<ChromeState>().require_port()?, &id)).await
}

#[tauri::command]
pub async fn chrome_close(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    blocking(move || close_tab(app.state::<ChromeState>().require_port()?, &id)).await
}

#[tauri::command]
pub async fn chrome_link_native_hosts() -> Result<Vec<String>, String> {
    blocking(|| mirror_native_hosts(&managed_dir())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_installed_macos_browsers() {
        let home = Path::new("/Users/me");
        let installed = ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
        let found = detect_with("macos", home, &|_| None, &|p| installed.iter().any(|i| Path::new(i) == p));
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].family, Family::Chrome); // preference order, not install order
        assert_eq!(found[0].path, installed[1]);
        assert_eq!(found[1].family, Family::Brave);
    }

    #[test]
    fn detects_linux_and_windows() {
        let found = detect_with("linux", Path::new("/home/me"), &|_| None, &|p| p == Path::new("/usr/bin/chromium"));
        assert_eq!(found, vec![ChromeBinary { family: Family::Chromium, name: "Chromium".into(), path: "/usr/bin/chromium".into() }]);
        let env = |k: &str| (k == "ProgramFiles").then(|| r"C:\Program Files".to_string());
        let c = candidates("windows", Path::new(r"C:\Users\me"), &env);
        assert!(c.iter().any(|(f, _, p)| *f == Family::Edge && p.to_string_lossy().contains("msedge.exe")));
    }

    #[test]
    fn families() {
        assert_eq!(family_of("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"), Family::Brave);
        assert_eq!(family_of("/usr/bin/google-chrome-stable"), Family::Chrome);
        assert_eq!(family_of("/usr/bin/chromium-browser"), Family::Chromium);
        assert_eq!(family_of(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"), Family::Edge);
        assert_eq!(family_of("/opt/thing/browser"), Family::Other);
    }

    #[test]
    fn http_parsing() {
        let r = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n[]";
        assert_eq!(parse_http_response(r, false), Some(Ok((200, "[]".into()))));
        assert_eq!(parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n[]", false), None);
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n[1,\r\n2\r\n2]\r\n0\r\n\r\n";
        assert_eq!(parse_http_response(chunked, false), Some(Ok((200, "[1,2]".into()))));
        assert_eq!(parse_http_response(b"HTTP/1.1 405 Method Not Allowed\r\n\r\nUsing unsafe HTTP verb GET", true), Some(Ok((405, "Using unsafe HTTP verb GET".into()))));
        assert_eq!(parse_http_response(b"HTTP/1.1 200", false), None);
    }

    #[test]
    fn target_list() {
        let json = r#"[
          {"description":"","devtoolsFrontendUrl":"/devtools/inspector.html?ws=127.0.0.1:9333/devtools/page/A1","faviconUrl":"http://localhost:5173/favicon.svg","id":"A1","title":"Vite App","type":"page","url":"http://localhost:5173/","webSocketDebuggerUrl":"ws://127.0.0.1:9333/devtools/page/A1"},
          {"id":"SW","title":"Service Worker","type":"service_worker","url":"chrome-extension://abc/sw.js"},
          {"id":"B2","title":"DevTools","type":"page","url":"devtools://devtools/bundled/inspector.html"},
          {"id":"C3","title":"New Tab","type":"page","url":"chrome://newtab/"}
        ]"#;
        let tabs = parse_targets(json).unwrap();
        assert_eq!(tabs.len(), 2);
        assert_eq!(tabs[0], ChromeTab { id: "A1".into(), title: "Vite App".into(), url: "http://localhost:5173/".into(), favicon_url: Some("http://localhost:5173/favicon.svg".into()) });
        assert_eq!(tabs[1].id, "C3");
        assert!(parse_targets("{}").is_err());
    }

    /// Live check against an installed Chrome (headless, temp profile): `cargo test -- --ignored cdp_live`.
    #[test]
    #[ignore]
    fn cdp_live() {
        let Some(bin) = detect().into_iter().next() else { return };
        let dir = std::env::temp_dir().join(format!("tcon-cdp-live-{}", std::process::id()));
        let port = pick_port(0);
        let mut child = Command::new(&bin.path)
            .args(["--headless=new", "--no-first-run", &format!("--user-data-dir={}", dir.display()), &format!("--remote-debugging-port={port}"), "about:blank"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let start = Instant::now();
        while probe(port).is_none() && start.elapsed() < Duration::from_secs(15) {
            std::thread::sleep(Duration::from_millis(100));
        }
        let res = (|| -> Result<(), String> {
            assert!(probe(port).is_some());
            let tab = open_tab(port, "http://example.com/a?b=1&c=2#x")?;
            assert_eq!(tab.url, "http://example.com/a?b=1&c=2#x");
            assert!(list_tabs(port)?.iter().any(|t| t.id == tab.id));
            activate_tab(port, &tab.id)?;
            close_tab(port, &tab.id)?;
            std::thread::sleep(Duration::from_millis(300));
            assert!(!list_tabs(port)?.iter().any(|t| t.id == tab.id));
            Ok(())
        })();
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
        res.unwrap();
    }

    #[test]
    fn helpers() {
        assert_eq!(encode_component("http://localhost:3000/a?b=1&c#d"), "http%3A%2F%2Flocalhost%3A3000%2Fa%3Fb%3D1%26c%23d");
        assert!(valid_target_id("AB/CD").is_err());
        assert!(valid_target_id("ABCDEF0123").is_ok());
        assert!(valid_target_id("../../x").is_err());
        assert!(check_url("javascript:alert(1)").is_err());
        assert!(check_url("HTTP://localhost").is_ok());
        let dir = std::env::temp_dir().join(format!("tcon-cdp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("DevToolsActivePort"), "9444\n/devtools/browser/x\n").unwrap();
        assert_eq!(active_port_file(&dir), Some(9444));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
