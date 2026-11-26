//! File system: listing, reading/writing text, project dir creation, watching. (STUB — implemented by the git/fs agent.)
use serde::Serialize;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry { pub name: String, pub path: String, pub is_dir: bool, pub is_symlink: bool, pub size: u64, pub modified: i64 }

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileContent { pub content: String, pub is_binary: bool, pub too_large: bool, pub size: u64 }

#[derive(Default)]
pub struct Watchers;

#[tauri::command]
pub async fn fs_list_dir(path: String, show_hidden: bool) -> Result<Vec<FsEntry>, String> { let _ = (path, show_hidden); Ok(vec![]) }
#[tauri::command]
pub async fn fs_read_text(path: String) -> Result<FileContent, String> { let _ = path; Ok(FileContent::default()) }
#[tauri::command]
pub async fn fs_write_text(path: String, content: String) -> Result<(), String> { let _ = (path, content); Ok(()) }
#[tauri::command]
pub async fn fs_create_project_dir(path: String, git_init: bool) -> Result<(), String> { let _ = (path, git_init); Ok(()) }
#[tauri::command]
pub fn fs_watch(app: tauri::AppHandle, state: tauri::State<'_, Watchers>, root: String) -> Result<(), String> { let _ = (app, state, root); Ok(()) }
#[tauri::command]
pub fn fs_unwatch(state: tauri::State<'_, Watchers>, root: String) -> Result<(), String> { let _ = (state, root); Ok(()) }
