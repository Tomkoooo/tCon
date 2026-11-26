//! Git integration via git2. (STUB — implemented by the git/fs agent.)
use serde::Serialize;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus { pub path: String, pub index: String, pub worktree: String }

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub dirty: bool,
    pub files: Vec<GitFileStatus>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit { pub id: String, pub short_id: String, pub summary: String, pub author: String, pub time: i64, pub parents: Vec<String>, pub refs: Vec<String> }

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch { pub name: String, pub is_remote: bool, pub is_head: bool, pub upstream: Option<String>, pub target: String }

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree { pub name: String, pub path: String, pub branch: Option<String>, pub is_main: bool }

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatus, String> { let _ = path; Ok(GitStatus::default()) }
#[tauri::command]
pub async fn git_log(path: String, limit: usize) -> Result<Vec<GitCommit>, String> { let _ = (path, limit); Ok(vec![]) }
#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<GitBranch>, String> { let _ = path; Ok(vec![]) }
#[tauri::command]
pub async fn git_worktrees(path: String) -> Result<Vec<GitWorktree>, String> { let _ = path; Ok(vec![]) }
#[tauri::command]
pub async fn git_diff(path: String, file: Option<String>, staged: bool) -> Result<String, String> { let _ = (path, file, staged); Ok(String::new()) }
