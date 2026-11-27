//! Integrated browser: a built-in engine (native child webviews over editor tabs) and a Chrome
//! engine (the user's Chromium-family browser on a tCon-managed profile, driven over CDP).

pub mod builtin;
pub mod chrome;
pub mod devurl;
pub mod import;

pub use chrome::ChromeState;

/// Wrap the app's invoke handler so no command can ever be called from a browser webview,
/// whatever origin the page ends up on (defense in depth on top of the capability files).
pub fn guard_invoke<F>(handler: F) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static
where
    F: Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static,
{
    move |invoke| {
        if builtin::is_browser_label(invoke.message.webview_ref().label()) {
            invoke.resolver.reject("tCon commands are not available to browser pages");
            return true;
        }
        handler(invoke)
    }
}
