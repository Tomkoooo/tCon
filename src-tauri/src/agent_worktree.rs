//! Git worktrees for task agents (board setting `isolation: worktree`): each agent works on
//! its own branch `tcon/<task id>` in `~/.tcon/worktrees/<project>-<hash>/<task id>`, outside
//! the repository so it never shows up in `git status`. Uses the git CLI (cli.rs).
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::cli::{git, run};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorktree {
    pub path: String,
    pub branch: String,
    /// The branch the worktree was created from (the main checkout's branch).
    pub base: String,
}

fn valid_task_id(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(id)
    } else {
        Err(format!("invalid task id: {id}"))
    }
}

/// Only branches this module creates may be merged / deleted through it.
fn valid_branch(b: &str) -> Result<&str, String> {
    match b.strip_prefix("tcon/") {
        Some(id) if valid_task_id(id).is_ok() => Ok(b),
        _ => Err(format!("not a tCon task branch: {b}")),
    }
}

/// FNV-1a, so the folder name is stable across runs and platforms.
fn fnv(s: &str) -> u32 {
    s.bytes().fold(0x811c9dc5u32, |h, b| (h ^ b as u32).wrapping_mul(0x01000193))
}

pub fn worktree_dir(home: &Path, root: &str, task_id: &str) -> PathBuf {
    let root = root.trim_end_matches('/');
    let name: String = Path::new(root)
        .file_name()
        .map(|s| s.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect())
        .unwrap_or_else(|| "project".into());
    home.join(".tcon").join("worktrees").join(format!("{name}-{:08x}", fnv(root))).join(task_id)
}

fn top_level(root: &str) -> Result<String, String> {
    git(root, &["rev-parse", "--show-toplevel"])
}

pub fn add(home: &Path, root: &str, task_id: &str) -> Result<AgentWorktree, String> {
    let id = valid_task_id(task_id)?;
    let top = top_level(root).map_err(|_| "This project isn't a git repository, so agents can't get their own worktree.".to_string())?;
    let base = git(&top, &["symbolic-ref", "--short", "HEAD"]).unwrap_or_else(|_| "HEAD".into());
    let branch = format!("tcon/{id}");
    let dir = worktree_dir(home, &top, id);
    let path = dir.to_string_lossy().into_owned();
    if dir.join(".git").exists() {
        return Ok(AgentWorktree { path, branch, base });
    }
    std::fs::create_dir_all(dir.parent().unwrap_or(&dir)).map_err(|e| e.to_string())?;
    let _ = git(&top, &["worktree", "prune"]);
    let exists = git(&top, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok();
    if exists {
        git(&top, &["worktree", "add", &path, &branch])?;
    } else {
        git(&top, &["worktree", "add", "-b", &branch, &path, "HEAD"])?;
    }
    Ok(AgentWorktree { path, branch, base })
}

fn is_clean(path: &str) -> Result<bool, String> {
    Ok(git(path, &["status", "--porcelain"])?.trim().is_empty())
}

fn merged_into_head(top: &str, branch: &str) -> bool {
    git(top, &["merge-base", "--is-ancestor", branch, "HEAD"]).is_ok()
}

/// Remove a task worktree and its branch. Without `force` it refuses when the worktree has
/// uncommitted changes or the branch isn't merged into the main checkout's HEAD.
pub fn remove(root: &str, path: &str, branch: &str, force: bool) -> Result<String, String> {
    let branch = valid_branch(branch)?;
    let top = top_level(root)?;
    let wt_exists = Path::new(path).join(".git").exists();
    if !force {
        if wt_exists && !is_clean(path)? {
            return Err("The worktree has uncommitted changes.".into());
        }
        if !merged_into_head(&top, branch) {
            return Err(format!("{branch} isn't merged into the current branch yet."));
        }
    }
    if wt_exists {
        if force {
            git(&top, &["worktree", "remove", "--force", path])?;
        } else {
            git(&top, &["worktree", "remove", path])?;
        }
    }
    let _ = git(&top, &["branch", if force { "-D" } else { "-d" }, branch]);
    let _ = git(&top, &["worktree", "prune"]);
    Ok(format!("Removed the worktree and {branch}."))
}

/// Merge a task branch into the main checkout's current branch (no fast-forward, so the
/// task stays one unit in history). Aborts and reports on conflicts.
pub fn merge(root: &str, branch: &str) -> Result<String, String> {
    let branch = valid_branch(branch)?;
    let top = top_level(root)?;
    if !is_clean(&top)? {
        return Err("Commit or stash the changes in the main checkout first.".into());
    }
    match git(&top, &["merge", "--no-ff", "--no-edit", branch]) {
        Ok(out) => Ok(out),
        Err(e) => {
            let _ = git(&top, &["merge", "--abort"]);
            Err(format!("Merge failed and was aborted: {e}"))
        }
    }
}

/// Push the task branch and open a pull request with the GitHub CLI. Returns its URL.
pub fn open_pr(root: &str, branch: &str, title: &str) -> Result<String, String> {
    let branch = valid_branch(branch)?;
    let top = top_level(root)?;
    git(&top, &["push", "-u", "origin", branch])?;
    let args: Vec<String> = ["pr", "create", "--head", branch, "--title", title, "--fill"].iter().map(|s| s.to_string()).collect();
    let out = run("gh", &args, Some(&top), &Default::default())?;
    let text = format!("{}{}", out.stdout, out.stderr);
    if !out.ok && !text.contains("already exists") {
        return Err(text.trim().to_string());
    }
    Ok(text.split_whitespace().find(|w| w.starts_with("https://")).unwrap_or("").to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn task_worktree_add(root: String, task_id: String) -> Result<AgentWorktree, String> {
    let home = dirs::home_dir().ok_or("no home directory")?;
    blocking(move || add(&home, &root, &task_id)).await
}

#[tauri::command]
pub async fn task_worktree_remove(root: String, path: String, branch: String, force: bool) -> Result<String, String> {
    blocking(move || remove(&root, &path, &branch, force)).await
}

#[tauri::command]
pub async fn task_worktree_merge(root: String, branch: String) -> Result<String, String> {
    blocking(move || merge(&root, &branch)).await
}

#[tauri::command]
pub async fn task_worktree_pr(root: String, branch: String, title: String) -> Result<String, String> {
    blocking(move || open_pr(&root, &branch, &title)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap().status.success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn add_merge_remove_in_temp_repo() {
        let base = std::env::temp_dir().join(format!("tcon-wt-{}", uuid::Uuid::new_v4()));
        let repo = base.join("repo");
        let home = base.join("home");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
        let root = repo.to_string_lossy().to_string();

        let wt = add(&home, &root, "T-7").unwrap();
        assert_eq!(wt.branch, "tcon/T-7");
        assert_eq!(wt.base, "main");
        assert!(Path::new(&wt.path).join(".git").exists());
        assert!(wt.path.starts_with(&*home.to_string_lossy()));
        // Idempotent.
        assert_eq!(add(&home, &root, "T-7").unwrap().path, wt.path);

        let wtp = Path::new(&wt.path);
        std::fs::write(wtp.join("a.txt"), "x").unwrap();
        // Dirty + unmerged: refused.
        assert!(remove(&root, &wt.path, &wt.branch, false).is_err());
        sh(wtp, &["add", "a.txt"]);
        sh(wtp, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "T-7: a"]);
        assert!(remove(&root, &wt.path, &wt.branch, false).unwrap_err().contains("isn't merged"));

        // The merge commit needs an identity (CI has none).
        sh(&repo, &["config", "user.email", "t@t"]);
        sh(&repo, &["config", "user.name", "t"]);
        merge(&root, &wt.branch).unwrap();
        assert!(repo.join("a.txt").exists());
        remove(&root, &wt.path, &wt.branch, false).unwrap();
        assert!(!wtp.exists());
        assert!(merge(&root, "main").is_err());
        assert!(add(&home, &root, "../x").is_err());
        let _ = std::fs::remove_dir_all(base);
    }
}
