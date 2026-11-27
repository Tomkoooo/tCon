mod appicon;
mod background;
mod browser;
mod cli;
mod db;
mod fs;
mod git;
pub mod osc;
mod pty;
mod security;
mod tasks;
mod themes;

use db::{Db, Profile, RecentPath};
use pty::{PtyManager, SpawnOptions};
use tauri::ipc::Channel;
use tauri::{Manager, State};

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

// ---------- PTY ----------

#[tauri::command]
fn pty_spawn(app: tauri::AppHandle, state: State<'_, PtyManager>, opts: SpawnOptions, on_data: Channel) -> Result<(), String> {
    state.spawn(app, opts, on_data).map_err(e)
}

#[tauri::command]
fn pty_write(state: State<'_, PtyManager>, pane_id: String, data: String) -> Result<(), String> {
    state.write(&pane_id, data.as_bytes()).map_err(e)
}

#[tauri::command]
fn pty_resize(state: State<'_, PtyManager>, pane_id: String, cols: u16, rows: u16) -> Result<(), String> {
    state.resize(&pane_id, cols, rows).map_err(e)
}

#[tauri::command]
fn pty_kill(state: State<'_, PtyManager>, pane_id: String) {
    state.kill(&pane_id)
}

#[tauri::command]
fn pty_foreground(state: State<'_, PtyManager>, pane_id: String) -> Option<String> {
    state.foreground_process(&pane_id)
}

// ---------- Persistence ----------

#[tauri::command]
fn recent_list(db: State<'_, Db>, limit: u32) -> Result<Vec<RecentPath>, String> {
    db.recent(limit).map_err(e)
}
#[tauri::command]
fn recent_touch(db: State<'_, Db>, path: String) -> Result<(), String> {
    db.touch_recent(&path).map_err(e)
}
#[tauri::command]
fn recent_pin(db: State<'_, Db>, path: String, pinned: bool) -> Result<(), String> {
    db.set_pinned(&path, pinned).map_err(e)
}
#[tauri::command]
fn recent_remove(db: State<'_, Db>, path: String) -> Result<(), String> {
    db.remove_recent(&path).map_err(e)
}
#[tauri::command]
fn profiles_list(db: State<'_, Db>) -> Result<Vec<Profile>, String> {
    db.profiles().map_err(e)
}
#[tauri::command]
fn profile_save(db: State<'_, Db>, profile: Profile) -> Result<(), String> {
    db.save_profile(&profile).map_err(e)
}
#[tauri::command]
fn profile_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    db.delete_profile(&id).map_err(e)
}
#[tauri::command]
fn setting_get(db: State<'_, Db>, key: String) -> Result<Option<String>, String> {
    db.get_setting(&key).map_err(e)
}
#[tauri::command]
fn setting_set(db: State<'_, Db>, key: String, value: String) -> Result<(), String> {
    db.set_setting(&key, &value).map_err(e)
}
#[tauri::command]
fn home_dir() -> String {
    dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "/".into())
}

/// Custom menu: like the default, but without "Close Window" (⌘W closes panes here).
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, PredefinedMenuItem as P, Submenu};
    let app_menu = Submenu::with_items(
        app,
        "tCon",
        true,
        &[
            &P::about(app, None, None)?,
            &P::separator(app)?,
            &P::hide(app, None)?,
            &P::hide_others(app, None)?,
            &P::show_all(app, None)?,
            &P::separator(app)?,
            &P::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &P::undo(app, None)?,
            &P::redo(app, None)?,
            &P::separator(app)?,
            &P::cut(app, None)?,
            &P::copy(app, None)?,
            &P::paste(app, None)?,
            &P::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(app, "View", true, &[&P::fullscreen(app, None)?])?;
    let window = Submenu::with_items(app, "Window", true, &[&P::minimize(app, None)?, &P::maximize(app, None)?])?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    // The `devtools` feature (for the browser's Web Inspector) would also enable it in the
    // main UI webview: keep it off there in release builds.
    if !cfg!(debug_assertions) {
        for w in &mut context.config_mut().app.windows {
            w.devtools = Some(false);
        }
    }
    // Started by the login item: only the tray icon shows (src/background.rs).
    if background::started_hidden() {
        for w in &mut context.config_mut().app.windows {
            w.visible = false;
        }
    }
    tauri::Builder::default()
        // Background mode (src/background.rs): global shortcut → quick panel, launch at login.
        .plugin(background::shortcut_plugin())
        .plugin(background::autostart_plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(PtyManager::default())
        .manage(fs::Watchers::default())
        .manage(browser::ChromeState::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(Db::open(&dir)?);
            app.set_menu(build_menu(app.handle())?)?;
            background::setup(app.handle())?;
            Ok(())
        })
        // Closing the main window hides it while background mode is on.
        .on_window_event(|w, ev| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                if w.label() == background::MAIN_LABEL {
                    background::on_main_close(w, api);
                }
            }
        })
        // browser::guard_invoke: pages in the integrated browser (`browser-*` webviews) never reach commands.
        // background::guard_invoke: the quick panel only reaches its own few commands.
        .invoke_handler(background::guard_invoke(browser::guard_invoke(tauri::generate_handler![
            appicon::app_set_icon,
            appicon::app_icon_preview,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_foreground,
            recent_list,
            recent_touch,
            recent_pin,
            recent_remove,
            profiles_list,
            profile_save,
            profile_delete,
            setting_get,
            setting_set,
            home_dir,
            git::git_status,
            git::git_log,
            git::git_branches,
            git::git_worktrees,
            git::git_diff,
            cli::git_op,
            cli::claude_auth_status,
            cli::claude_auth_logout,
            cli::account_prepare_dir,
            security::security_audit,
            security::security_fix_permissions,
            security::security_keychain_acl,
            themes::themes_scan,
            themes::theme_load,
            themes::icon_theme_load,
            themes::theme_asset,
            themes::config_init,
            themes::config_read,
            themes::config_write,
            fs::fs_list_dir,
            fs::fs_read_text,
            fs::fs_write_text,
            fs::fs_create_project_dir,
            fs::fs_watch,
            fs::fs_unwatch,
            tasks::tasks_load,
            tasks::tasks_init,
            tasks::task_create,
            tasks::task_update,
            tasks::task_move,
            tasks::task_delete,
            tasks::tasks_save_settings,
            tasks::tasks_install_skill,
            background::background_apply,
            background::background_status,
            background::background_check_shortcut,
            background::quick_toggle,
            background::tray_refresh,
            background::quick_projects,
            background::quick_hide,
            background::quick_open,
            browser::builtin::browser_info,
            browser::builtin::browser_create,
            browser::builtin::browser_set_bounds,
            browser::builtin::browser_navigate,
            browser::builtin::browser_action,
            browser::builtin::browser_url,
            browser::builtin::browser_close,
            browser::builtin::browser_clear_data,
            browser::chrome::chrome_status,
            browser::chrome::chrome_launch,
            browser::chrome::chrome_tabs,
            browser::chrome::chrome_open,
            browser::chrome::chrome_activate,
            browser::chrome::chrome_close,
            browser::chrome::chrome_link_native_hosts,
            browser::import::browser_import_sources,
            browser::import::browser_import,
        ])))
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<PtyManager>().kill_all();
            }
            // Dock icon clicked while the main window is hidden.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = &event {
                background::show_main(app);
            }
        });
}
