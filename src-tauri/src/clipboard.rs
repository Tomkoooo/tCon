//! Files on the clipboard (Finder ⌘C). The webview only sees their names, so a terminal
//! paste would insert just "photo.png"; this returns their full paths so tCon can paste
//! those instead, like macOS Terminal does. Reads only `public.file-url` entries.

/// `file:///a/My%20File.png` → `/a/My File.png`.
pub fn file_url_to_path(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    if !rest.starts_with('/') {
        return None;
    }
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()).ok_or(()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

#[cfg(target_os = "macos")]
fn file_urls() -> Vec<String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
    // SAFETY: plain AppKit pasteboard reads; NSPasteboard is safe to use off the main thread.
    unsafe {
        let pb = NSPasteboard::generalPasteboard();
        let Some(items) = pb.pasteboardItems() else { return Vec::new() };
        items.iter().filter_map(|item| item.stringForType(NSPasteboardTypeFileURL).map(|s| s.to_string())).collect()
    }
}

#[cfg(not(target_os = "macos"))]
fn file_urls() -> Vec<String> {
    Vec::new()
}

/// Full paths of the files on the clipboard (empty when it holds no files).
#[tauri::command]
pub fn clipboard_file_paths() -> Vec<String> {
    file_urls().iter().filter_map(|u| file_url_to_path(u)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_file_urls() {
        assert_eq!(file_url_to_path("file:///Users/me/My%20File.png").as_deref(), Some("/Users/me/My File.png"));
        assert_eq!(file_url_to_path("file://localhost/tmp/%C3%A1.txt").as_deref(), Some("/tmp/á.txt"));
        assert_eq!(file_url_to_path("file:///tmp/100%").as_deref(), Some("/tmp/100%"));
        assert_eq!(file_url_to_path("https://x/y"), None);
    }
}
