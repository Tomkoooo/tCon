//! Runtime app icon (`"app.icon"` setting): "default", a built-in variant, or a path to an image.
//!
//! macOS: replaces the Dock icon of the running app (`NSApplication.applicationIconImage`).
//! The Finder / .app bundle icon is untouched. Elsewhere: sets the main window's icon (PNG only).

use tauri::AppHandle;

const DEFAULT: &[u8] = include_bytes!("../../assets/icon.png");
const VARIANTS: &[(&str, &[u8])] = &[
    ("classic", include_bytes!("../../assets/icons/classic.png")),
    ("light", include_bytes!("../../assets/icons/light.png")),
    ("mono", include_bytes!("../../assets/icons/mono.png")),
];

enum Source {
    Bytes(&'static [u8]),
    File(std::path::PathBuf),
}

fn resolve(spec: &str) -> Result<Source, String> {
    let spec = spec.trim();
    if spec.is_empty() || spec == "default" {
        return Ok(Source::Bytes(DEFAULT));
    }
    if let Some((_, bytes)) = VARIANTS.iter().find(|(name, _)| *name == spec) {
        return Ok(Source::Bytes(bytes));
    }
    let path = std::path::PathBuf::from(spec);
    if !path.is_absolute() {
        return Err(format!("unknown app icon \"{spec}\""));
    }
    if !path.is_file() {
        return Err(format!("app icon not found: {spec}"));
    }
    Ok(Source::File(path))
}

#[cfg(target_os = "macos")]
fn apply(app: &AppHandle, src: Source) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(macos::set_dock_icon(&src));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
mod macos {
    use super::Source;
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::{NSData, NSString};

    pub fn set_dock_icon(src: &Source) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
        let image = match src {
            Source::Bytes(b) => NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(b)),
            Source::File(p) => {
                NSImage::initWithContentsOfFile(NSImage::alloc(), &NSString::from_str(&p.to_string_lossy()))
            }
        }
        .ok_or("couldn't read the image (use a PNG, ICNS, JPEG or SVG file)")?;
        let ns_app = NSApplication::sharedApplication(mtm);
        unsafe { ns_app.setApplicationIconImage(Some(&image)) };
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
fn apply(app: &AppHandle, src: Source) -> Result<(), String> {
    use tauri::Manager;
    let bytes = match src {
        Source::Bytes(b) => b.to_vec(),
        Source::File(p) => {
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if ext != "png" {
                return Err("only PNG app icons are supported on this platform".into());
            }
            std::fs::read(&p).map_err(|e| e.to_string())?
        }
    };
    let image = tauri::image::Image::from_bytes(&bytes).map_err(|e| e.to_string())?;
    for win in app.webview_windows().values() {
        win.set_icon(image.clone()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Apply an `"app.icon"` spec: "default", "classic" | "light" | "mono", or an absolute image path.
#[tauri::command]
pub async fn app_set_icon(app: AppHandle, spec: String) -> Result<(), String> {
    let src = resolve(&spec)?;
    apply(&app, src)
}

/// A user-chosen icon file as a data: URL for the settings thumbnail (formats a webview can show).
#[tauri::command]
pub async fn app_icon_preview(path: String) -> Result<String, String> {
    use base64::Engine;
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::PathBuf::from(&path);
        let mime = match p.extension().and_then(|x| x.to_str()).map(|s| s.to_ascii_lowercase()).as_deref() {
            Some("png") => "image/png",
            Some("svg") => "image/svg+xml",
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("gif") => "image/gif",
            Some("webp") => "image/webp",
            _ => return Err("no preview for this format".to_string()),
        };
        let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("image too large".into());
        }
        Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    })
    .await
    .map_err(|e| e.to_string())?
}
