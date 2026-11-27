//! VS Code-compatible theming: color themes, icon themes, and the user's ~/.tcon config files.
//!
//! Themes are discovered from VS Code-family installs (VS Code, Insiders, Cursor, VSCodium,
//! Windsurf — both their bundled extensions and the user's ~/.<app>/extensions), from
//! ~/.tcon/extensions (unpacked extension folders) and loose color themes in ~/.tcon/themes.
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use serde_json::{Map, Value};

fn e2s(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

pub fn tcon_dir() -> PathBuf {
    home().join(".tcon")
}

// ---------------- JSONC ----------------

/// Strip // and /* */ comments and trailing commas, so serde_json can parse VS Code's JSONC.
pub fn strip_jsonc(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    let mut in_str = false;
    while i < b.len() {
        let c = b[i];
        if in_str {
            out.push(c);
            if c == b'\\' && i + 1 < b.len() {
                out.push(b[i + 1]);
                i += 2;
                continue;
            }
            if c == b'"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' => {
                in_str = true;
                out.push(c);
                i += 1;
            }
            b'/' if b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            b',' => {
                // drop a comma followed (after whitespace/comments) by } or ]
                let mut j = i + 1;
                loop {
                    while j < b.len() && (b[j] as char).is_whitespace() {
                        j += 1;
                    }
                    if b.get(j) == Some(&b'/') && b.get(j + 1) == Some(&b'/') {
                        while j < b.len() && b[j] != b'\n' {
                            j += 1;
                        }
                        continue;
                    }
                    if b.get(j) == Some(&b'/') && b.get(j + 1) == Some(&b'*') {
                        j += 2;
                        while j + 1 < b.len() && !(b[j] == b'*' && b[j + 1] == b'/') {
                            j += 1;
                        }
                        j += 2;
                        continue;
                    }
                    break;
                }
                if !matches!(b.get(j), Some(b'}') | Some(b']')) {
                    out.push(c);
                }
                i += 1;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

pub fn read_jsonc(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let text = text.trim_start_matches('\u{feff}');
    serde_json::from_str(&strip_jsonc(text)).map_err(|e| format!("{}: {e}", path.display()))
}

// ---------------- discovery ----------------

/// Extension directories of VS Code-family editors (bundled + user-installed) and ~/.tcon/extensions.
fn extension_roots() -> Vec<(PathBuf, &'static str)> {
    let h = home();
    let mut v: Vec<(PathBuf, &'static str)> = vec![(tcon_dir().join("extensions"), "tCon")];
    for (app, label) in [
        ("Visual Studio Code.app", "VS Code"),
        ("Visual Studio Code - Insiders.app", "VS Code Insiders"),
        ("Cursor.app", "Cursor"),
        ("VSCodium.app", "VSCodium"),
        ("Windsurf.app", "Windsurf"),
    ] {
        v.push((PathBuf::from("/Applications").join(app).join("Contents/Resources/app/extensions"), label));
        v.push((h.join("Applications").join(app).join("Contents/Resources/app/extensions"), label));
    }
    for (dir, label) in [
        (".vscode/extensions", "VS Code"),
        (".vscode-insiders/extensions", "VS Code Insiders"),
        (".cursor/extensions", "Cursor"),
        (".vscode-oss/extensions", "VSCodium"),
        (".windsurf/extensions", "Windsurf"),
    ] {
        v.push((h.join(dir), label));
    }
    v
}

/// May the frontend read this file? Only theme/extension locations.
fn allowed(path: &Path) -> bool {
    let Ok(canon) = path.canonicalize() else { return false };
    let mut roots: Vec<PathBuf> = extension_roots().into_iter().map(|(p, _)| p).collect();
    roots.push(tcon_dir());
    roots.iter().filter_map(|r| r.canonicalize().ok()).any(|r| canon.starts_with(r))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThemeEntry {
    pub id: String,
    pub label: String,
    /// vs | vs-dark | hc-black | hc-light (color themes only)
    pub ui_theme: Option<String>,
    pub path: String,
    /// where it came from, e.g. "Cursor · Shades of Purple"
    pub source: String,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThemeCatalog {
    pub color_themes: Vec<ThemeEntry>,
    pub icon_themes: Vec<ThemeEntry>,
}

fn localize(s: &str, nls: &Option<Value>) -> String {
    if s.len() > 2 && s.starts_with('%') && s.ends_with('%') {
        if let Some(v) = nls.as_ref().and_then(|n| n.get(&s[1..s.len() - 1])) {
            if let Some(t) = v.as_str() {
                return t.to_string();
            }
            if let Some(t) = v.get("message").and_then(|m| m.as_str()) {
                return t.to_string();
            }
        }
    }
    s.to_string()
}

fn scan_extension(dir: &Path, origin: &str, cat: &mut ThemeCatalog) {
    let Ok(pkg) = read_jsonc(&dir.join("package.json")) else { return };
    let Some(contrib) = pkg.get("contributes") else { return };
    let nls = read_jsonc(&dir.join("package.nls.json")).ok();
    let ext_name = pkg.get("displayName").and_then(|v| v.as_str()).map(|s| localize(s, &nls))
        .or_else(|| pkg.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .unwrap_or_default();
    let source = format!("{origin} · {ext_name}");
    let entries = |key: &str| -> Vec<ThemeEntry> {
        contrib.get(key).and_then(|v| v.as_array()).cloned().unwrap_or_default().iter().filter_map(|t| {
            let rel = t.get("path")?.as_str()?;
            let label = localize(t.get("label").and_then(|v| v.as_str()).unwrap_or(""), &nls);
            let id = t.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| label.clone());
            let path = dir.join(rel);
            if !path.is_file() { return None; }
            Some(ThemeEntry {
                label: if label.is_empty() { id.clone() } else { label },
                id,
                ui_theme: t.get("uiTheme").and_then(|v| v.as_str()).map(|s| s.to_string()),
                path: path.to_string_lossy().into_owned(),
                source: source.clone(),
            })
        }).collect()
    };
    cat.color_themes.extend(entries("themes"));
    cat.icon_themes.extend(entries("iconThemes"));
}

pub fn scan_sync() -> ThemeCatalog {
    let mut cat = ThemeCatalog::default();
    for (root, origin) in extension_roots() {
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort(); // several versions of one extension: the later (higher) version wins below
        for d in dirs {
            scan_extension(&d, origin, &mut cat);
        }
    }
    // Loose color themes: ~/.tcon/themes/*.json
    if let Ok(rd) = std::fs::read_dir(tcon_dir().join("themes")) {
        for p in rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")) {
            let Ok(v) = read_jsonc(&p) else { continue };
            let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let label = v.get("name").and_then(|x| x.as_str()).map(|s| s.to_string()).unwrap_or(stem);
            let ui = match v.get("type").and_then(|x| x.as_str()) {
                Some("light") => "vs",
                Some("hc") | Some("hcDark") | Some("hc-black") => "hc-black",
                Some("hcLight") | Some("hc-light") => "hc-light",
                _ => "vs-dark",
            };
            cat.color_themes.push(ThemeEntry {
                id: label.clone(), label, ui_theme: Some(ui.into()),
                path: p.to_string_lossy().into_owned(), source: "~/.tcon/themes".into(),
            });
        }
    }
    // Dedupe by id: keep the last one found (newest version / user dirs after bundled ones).
    fn dedupe(v: &mut Vec<ThemeEntry>) {
        let mut seen: HashMap<String, usize> = HashMap::new();
        let mut out: Vec<ThemeEntry> = Vec::new();
        for t in v.drain(..) {
            if let Some(&i) = seen.get(&t.id) { out[i] = t; } else { seen.insert(t.id.clone(), out.len()); out.push(t); }
        }
        *v = out;
    }
    dedupe(&mut cat.color_themes);
    dedupe(&mut cat.icon_themes);
    cat
}

#[tauri::command]
pub async fn themes_scan() -> Result<ThemeCatalog, String> {
    tauri::async_runtime::spawn_blocking(scan_sync).await.map_err(e2s)
}

// ---------------- loading ----------------

/// Load a color theme, resolving `include` chains (VS Code semantics: the including theme wins).
pub fn load_color_theme(path: &Path, depth: u8) -> Result<Value, String> {
    if depth > 8 { return Err("theme include chain too deep".into()); }
    let mut v = read_jsonc(path)?;
    let dir = path.parent().unwrap_or(Path::new("/"));
    // tokenColors may point at a separate file (JSON or .tmTheme); JSON is supported.
    if let Some(rel) = v.get("tokenColors").and_then(|t| t.as_str()).map(|s| s.to_string()) {
        let p = dir.join(&rel);
        let tc = if p.extension().is_some_and(|x| x == "json") {
            read_jsonc(&p).ok().and_then(|x| x.get("tokenColors").cloned().or(Some(x)))
        } else { None };
        v["tokenColors"] = tc.filter(|t| t.is_array()).unwrap_or(Value::Array(vec![]));
    }
    let Some(inc) = v.get("include").and_then(|i| i.as_str()).map(|s| s.to_string()) else { return Ok(v) };
    let base = load_color_theme(&dir.join(inc), depth + 1)?;
    let mut merged = base.clone();
    // colors / semanticTokenColors: child overrides
    for key in ["colors", "semanticTokenColors"] {
        let mut m: Map<String, Value> = base.get(key).and_then(|x| x.as_object()).cloned().unwrap_or_default();
        if let Some(own) = v.get(key).and_then(|x| x.as_object()) {
            for (k, val) in own { m.insert(k.clone(), val.clone()); }
        }
        merged[key] = Value::Object(m);
    }
    // tokenColors: base rules first, child rules later (later rules win on equal specificity)
    let mut tc: Vec<Value> = base.get("tokenColors").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    tc.extend(v.get("tokenColors").and_then(|x| x.as_array()).cloned().unwrap_or_default());
    merged["tokenColors"] = Value::Array(tc);
    for key in ["name", "type", "semanticHighlighting"] {
        if let Some(x) = v.get(key) { merged[key] = x.clone(); }
    }
    if let Some(m) = merged.as_object_mut() { m.remove("include"); }
    Ok(merged)
}

#[tauri::command]
pub async fn theme_load(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !allowed(&p) { return Err(format!("not a theme location: {path}")); }
        load_color_theme(&p, 0)
    }).await.map_err(e2s)?
}

#[tauri::command]
pub async fn icon_theme_load(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !allowed(&p) { return Err(format!("not a theme location: {path}")); }
        read_jsonc(&p)
    }).await.map_err(e2s)?
}

/// An icon/font file of a theme as a data: URL.
#[tauri::command]
pub async fn theme_asset(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !allowed(&p) { return Err(format!("not a theme location: {path}")); }
        let bytes = std::fs::read(&p).map_err(e2s)?;
        if bytes.len() > 4 * 1024 * 1024 { return Err("asset too large".into()); }
        let mime = match p.extension().and_then(|x| x.to_str()).map(|s| s.to_ascii_lowercase()).as_deref() {
            Some("svg") => "image/svg+xml",
            Some("png") => "image/png",
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("gif") => "image/gif",
            Some("woff") => "font/woff",
            Some("woff2") => "font/woff2",
            Some("ttf") => "font/ttf",
            Some("otf") => "font/otf",
            _ => "application/octet-stream",
        };
        Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }).await.map_err(e2s)?
}

// ---------------- ~/.tcon config files ----------------

const CONFIG_FILES: &[&str] = &["settings.json", "keybindings.json", "custom.css"];

const DEFAULT_SETTINGS: &str = r##"// tCon settings — VS Code-style keys. Saved changes apply immediately.
// Themes: any VS Code color/icon theme installed in VS Code, Cursor, VSCodium or Windsurf
// is picked up automatically. You can also drop theme .json files into ~/.tcon/themes
// or unpacked extension folders into ~/.tcon/extensions.
{
  // Follow the macOS appearance and use the preferred themes below.
  "window.autoDetectColorScheme": true,
  "workbench.preferredDarkColorTheme": "tCon Dark",
  "workbench.preferredLightColorTheme": "tCon Light",
  // Used when autoDetectColorScheme is false.
  "workbench.colorTheme": "tCon Dark",
  "workbench.iconTheme": "material-icon-theme",

  // Override individual colors (VS Code color ids), optionally per theme:
  // "workbench.colorCustomizations": { "sideBar.background": "#1e1e2e", "[Monokai]": { "focusBorder": "#f92672" } },
  // "editor.tokenColorCustomizations": { "textMateRules": [{ "scope": "comment", "settings": { "fontStyle": "italic" } }] },

  // "editor.fontFamily": "JetBrains Mono, Menlo, monospace",
  // "editor.fontSize": 13,
  // "editor.lineHeight": 1.5,
  // "terminal.integrated.fontFamily": "SF Mono, Menlo, monospace",
  // "terminal.integrated.fontSize": 13,
  // "terminal.integrated.lineHeight": 1.15,
  // "terminal.integrated.cursorBlink": true,
  // "terminal.integrated.cursorStyle": "block",
  // "workbench.fontSize": 13,
  // Load ~/.tcon/custom.css on top of everything (advanced; may break with updates).
  "tcon.customCss": false
}
"##;

const DEFAULT_KEYBINDINGS: &str = r##"// tCon keybindings — same format as VS Code's keybindings.json.
// Add { "key": "cmd+shift+n", "command": "terminal.new" } to bind a key,
// or { "key": "cmd+d", "command": "-terminal.splitRight" } to remove a default binding.
// Keys: cmd, ctrl, alt (option), shift + a key, e.g. "cmd+alt+left", "ctrl+`", "cmd+\\".
// "when" supports editorFocus, terminalFocus, ! and &&.
// The full command list with defaults is in Settings → Keyboard Shortcuts.
[
]
"##;

const DEFAULT_CUSTOM_CSS: &str = "/* tCon custom CSS — loaded when \"tcon.customCss\": true in settings.json.\n   Every color is a CSS variable on :root, e.g.\n   :root { --claude: #ff7a59; }\n   .activitybar { width: 40px; }\n   Class names may change between versions. */\n";

fn config_path(name: &str) -> Result<PathBuf, String> {
    if !CONFIG_FILES.contains(&name) { return Err(format!("unknown config file {name}")); }
    Ok(tcon_dir().join(name))
}

/// Create ~/.tcon (themes/, extensions/, default settings + keybindings). Returns its path.
#[tauri::command]
pub fn config_init() -> Result<String, String> {
    let d = tcon_dir();
    std::fs::create_dir_all(d.join("themes")).map_err(e2s)?;
    std::fs::create_dir_all(d.join("extensions")).map_err(e2s)?;
    for (name, content) in [("settings.json", DEFAULT_SETTINGS), ("keybindings.json", DEFAULT_KEYBINDINGS), ("custom.css", DEFAULT_CUSTOM_CSS)] {
        let p = d.join(name);
        if !p.exists() { std::fs::write(&p, content).map_err(e2s)?; }
    }
    Ok(d.to_string_lossy().into_owned())
}

/// Raw text of a config file ("" if missing).
#[tauri::command]
pub fn config_read(name: String) -> Result<String, String> {
    let p = config_path(&name)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e2s(e)),
    }
}

#[tauri::command]
pub fn config_write(name: String, content: String) -> Result<(), String> {
    let p = config_path(&name)?;
    std::fs::create_dir_all(tcon_dir()).map_err(e2s)?;
    std::fs::write(p, content).map_err(e2s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonc_strips_comments_and_trailing_commas() {
        let src = r##"{
          // line comment with "quotes"
          "a": "http://x/*not a comment*/", /* block */
          "b": [1, 2, /* c */ ],
          "c": { "d": "\"//\"", },
        }"##;
        let v: Value = serde_json::from_str(&strip_jsonc(src)).unwrap();
        assert_eq!(v["a"], "http://x/*not a comment*/");
        assert_eq!(v["b"], serde_json::json!([1, 2]));
        assert_eq!(v["c"]["d"], "\"//\"");
    }

    #[test]
    fn include_chain_merges() {
        let d = std::env::temp_dir().join(format!("tcon-theme-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("base.json"), r##"{ "colors": { "a": "#111", "b": "#222" }, "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#999" } }] }"##).unwrap();
        std::fs::write(d.join("child.json"), r##"{ "name": "Child", "include": "./base.json", "colors": { "b": "#333", }, // c
            "tokenColors": [{ "scope": "string", "settings": { "foreground": "#0f0" } }] }"##).unwrap();
        let v = load_color_theme(&d.join("child.json"), 0).unwrap();
        assert_eq!(v["name"], "Child");
        assert_eq!(v["colors"]["a"], "#111");
        assert_eq!(v["colors"]["b"], "#333");
        assert_eq!(v["tokenColors"].as_array().unwrap().len(), 2);
        assert_eq!(v["tokenColors"][0]["scope"], "comment");
        std::fs::remove_dir_all(&d).ok();
    }

    /// Smoke test against real installed themes, when present on this machine.
    #[test]
    fn scan_and_load_installed_themes() {
        let cat = scan_sync();
        for t in cat.color_themes.iter().take(200) {
            if let Err(e) = load_color_theme(Path::new(&t.path), 0) {
                // .tmTheme-only themes etc. are allowed to fail, but JSON parse errors are bugs.
                assert!(!e.contains("expected"), "{} ({}): {e}", t.label, t.path);
            }
        }
        for t in &cat.icon_themes {
            read_jsonc(Path::new(&t.path)).unwrap_or_else(|e| panic!("{}: {e}", t.label));
        }
    }
}
