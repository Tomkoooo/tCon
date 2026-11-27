//! Running external CLIs (git, claude) with the user's login-shell PATH.
//! GUI apps on macOS start with a minimal PATH, so we resolve the real one once.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use serde::Serialize;

fn e2s(e: impl std::fmt::Display) -> String {
    e.to_string()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(e2s)?
}

fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let out = Command::new(shell)
            .args(["-l", "-c", "printf '%s' \"$PATH\""])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        let mut path = out.ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        if path.is_empty() {
            path = std::env::var("PATH").unwrap_or_default();
        }
        // Common install locations, in case the login shell didn't add them.
        let home = dirs::home_dir().unwrap_or_default();
        for extra in [home.join(".local/bin"), home.join(".claude/local"), PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")] {
            let s = extra.to_string_lossy().to_string();
            if !path.split(':').any(|p| p == s) {
                path.push(':');
                path.push_str(&s);
            }
        }
        path
    })
}

fn which(bin: &str) -> Option<PathBuf> {
    login_path().split(':').map(|d| Path::new(d).join(bin)).find(|p| p.is_file())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CmdOutput {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

fn run(bin: &str, args: &[String], cwd: Option<&str>, env: &HashMap<String, String>) -> Result<CmdOutput, String> {
    let exe = which(bin).ok_or_else(|| format!("`{bin}` not found on PATH"))?;
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .env("PATH", login_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("CLAUDECODE")
        .stdin(Stdio::null());
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd.output().map_err(e2s)?;
    Ok(CmdOutput {
        ok: out.status.success(),
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Run git and turn a non-zero exit into an error carrying git's message.
fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let out = run("git", &args, Some(cwd), &HashMap::new())?;
    if out.ok {
        Ok(format!("{}{}", out.stdout, out.stderr).trim().to_string())
    } else {
        let msg = if out.stderr.trim().is_empty() { out.stdout } else { out.stderr };
        Err(msg.trim().to_string())
    }
}

fn with_files<'a>(base: &[&'a str], files: &'a [String]) -> Vec<&'a str> {
    let mut v: Vec<&str> = base.to_vec();
    v.push("--");
    v.extend(files.iter().map(|s| s.as_str()));
    v
}

// ---------------- git operations ----------------

/// The single entry point for write-side git operations from the UI.
#[derive(serde::Deserialize, Debug)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum GitOp {
    Stage { files: Vec<String> },
    StageAll,
    Unstage { files: Vec<String> },
    UnstageAll,
    /// Discard working-tree changes (tracked files restored from the index, untracked deleted).
    Discard { tracked: Vec<String>, untracked: Vec<String> },
    Commit { message: String, amend: bool },
    Push,
    Pull,
    Fetch,
    Checkout { branch: String },
    CreateBranch { name: String },
    Stash,
    StashPop,
}

fn current_branch(cwd: &str) -> Result<String, String> {
    git(cwd, &["symbolic-ref", "--short", "HEAD"])
}

fn has_upstream(cwd: &str) -> bool {
    git(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_ok()
}

fn git_op_sync(cwd: &str, op: GitOp) -> Result<String, String> {
    match op {
        GitOp::Stage { files } => git(cwd, &with_files(&["add", "-A"], &files)),
        GitOp::StageAll => git(cwd, &["add", "-A"]),
        GitOp::Unstage { files } => {
            if git(cwd, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok() {
                git(cwd, &with_files(&["reset", "-q", "HEAD"], &files))
            } else {
                git(cwd, &with_files(&["rm", "-r", "-q", "--cached"], &files)) // no commits yet
            }
        }
        GitOp::UnstageAll => {
            if git(cwd, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok() {
                git(cwd, &["reset", "-q"])
            } else {
                git(cwd, &["rm", "-r", "-q", "--cached", "."])
            }
        }
        GitOp::Discard { tracked, untracked } => {
            let mut out = String::new();
            if !tracked.is_empty() {
                out += &git(cwd, &with_files(&["checkout"], &tracked))?;
            }
            if !untracked.is_empty() {
                out += &git(cwd, &with_files(&["clean", "-f", "-d", "-q"], &untracked))?;
            }
            Ok(out)
        }
        GitOp::Commit { message, amend } => {
            if message.trim().is_empty() && !amend {
                return Err("Commit message is empty".into());
            }
            let mut args = vec!["commit", "-m", message.as_str()];
            if amend {
                args = if message.trim().is_empty() { vec!["commit", "--amend", "--no-edit"] } else { vec!["commit", "--amend", "-m", message.as_str()] };
            }
            git(cwd, &args)
        }
        GitOp::Push => {
            if has_upstream(cwd) {
                git(cwd, &["push"])
            } else {
                let branch = current_branch(cwd)?;
                let remotes = git(cwd, &["remote"])?;
                let remote = if remotes.lines().any(|r| r == "origin") { "origin".to_string() } else {
                    remotes.lines().next().map(|s| s.to_string()).ok_or("This repository has no remote to push to")?
                };
                git(cwd, &["push", "-u", &remote, &branch])
            }
        }
        GitOp::Pull => git(cwd, &["pull"]),
        GitOp::Fetch => git(cwd, &["fetch", "--all", "--prune"]),
        GitOp::Checkout { branch } => {
            // "origin/feature" → create/switch to a local tracking branch "feature".
            let remotes = git(cwd, &["remote"]).unwrap_or_default();
            if let Some((remote, name)) = branch.split_once('/').filter(|(r, _)| remotes.lines().any(|x| x == *r)) {
                if git(cwd, &["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")]).is_ok() {
                    return git(cwd, &["switch", name]);
                }
                return git(cwd, &["switch", "--track", &format!("{remote}/{name}")]);
            }
            git(cwd, &["switch", &branch])
        }
        GitOp::CreateBranch { name } => git(cwd, &["switch", "-c", name.trim()]),
        GitOp::Stash => git(cwd, &["stash", "push", "-u"]),
        GitOp::StashPop => git(cwd, &["stash", "pop"]),
    }
}

#[tauri::command]
pub async fn git_op(path: String, op: GitOp) -> Result<String, String> {
    blocking(move || git_op_sync(&path, op)).await
}

// ---------------- Claude accounts ----------------

fn account_env(config_dir: &Option<String>) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if let Some(d) = config_dir.as_ref().filter(|d| !d.is_empty()) {
        env.insert("CLAUDE_CONFIG_DIR".to_string(), d.clone());
    }
    env
}

/// `claude auth status --json` for one config dir (None = default ~/.claude).
#[tauri::command]
pub async fn claude_auth_status(config_dir: Option<String>) -> Result<serde_json::Value, String> {
    blocking(move || {
        let out = run("claude", &["auth".into(), "status".into(), "--json".into()], None, &account_env(&config_dir))?;
        serde_json::from_str(out.stdout.trim()).map_err(|_| {
            let msg = if out.stderr.trim().is_empty() { out.stdout } else { out.stderr };
            format!("claude auth status failed: {}", msg.trim())
        })
    })
    .await
}

#[tauri::command]
pub async fn claude_auth_logout(config_dir: Option<String>) -> Result<(), String> {
    blocking(move || {
        let out = run("claude", &["auth".into(), "logout".into()], None, &account_env(&config_dir))?;
        if out.ok { Ok(()) } else { Err(format!("{}{}", out.stdout, out.stderr).trim().to_string()) }
    })
    .await
}

/// Items of ~/.claude that every account shares (history, settings, memory, commands…),
/// so switching accounts keeps `--continue`, CLAUDE.md, plugins etc.
const SHARED: &[&str] = &["projects", "settings.json", "CLAUDE.md", "commands", "agents", "skills", "plugins", "todos"];

/// Create an extra account's config dir, symlinking the shared items from ~/.claude.
#[tauri::command]
pub fn account_prepare_dir(dir: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let base = home.join(".claude");
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).map_err(e2s)?;
    std::fs::create_dir_all(base.join("projects")).map_err(e2s)?;
    for item in SHARED {
        let src = base.join(item);
        let dst = dir.join(item);
        if src.exists() && std::fs::symlink_metadata(&dst).is_err() {
            std::os::unix::fs::symlink(&src, &dst).map_err(e2s)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(dir: &str, o: GitOp) -> Result<String, String> {
        git_op_sync(dir, o)
    }

    #[test]
    fn git_ops_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("tcon-git-{}", uuid::Uuid::new_v4()));
        let remote = tmp.join("remote.git");
        let work = tmp.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let w = work.to_str().unwrap();
        git(tmp.to_str().unwrap(), &["init", "-q", "--bare", remote.to_str().unwrap()]).unwrap();
        git(w, &["init", "-q", "-b", "main"]).unwrap();
        git(w, &["config", "user.email", "t@example.com"]).unwrap();
        git(w, &["config", "user.name", "t"]).unwrap();
        git(w, &["config", "commit.gpgsign", "false"]).unwrap();
        git(w, &["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();

        // unstage before the first commit (no HEAD) must work
        std::fs::write(work.join("a.txt"), "1").unwrap();
        op(w, GitOp::StageAll).unwrap();
        op(w, GitOp::Unstage { files: vec!["a.txt".into()] }).unwrap();
        op(w, GitOp::Stage { files: vec!["a.txt".into()] }).unwrap();
        assert!(op(w, GitOp::Commit { message: " ".into(), amend: false }).is_err());
        op(w, GitOp::Commit { message: "first".into(), amend: false }).unwrap();

        // publish (no upstream yet) then normal push
        op(w, GitOp::Push).unwrap();
        assert!(has_upstream(w));

        // discard tracked + untracked
        std::fs::write(work.join("a.txt"), "changed").unwrap();
        std::fs::write(work.join("new.txt"), "x").unwrap();
        op(w, GitOp::Discard { tracked: vec!["a.txt".into()], untracked: vec!["new.txt".into()] }).unwrap();
        assert_eq!(std::fs::read_to_string(work.join("a.txt")).unwrap(), "1");
        assert!(!work.join("new.txt").exists());

        // branches + stash
        op(w, GitOp::CreateBranch { name: "feat".into() }).unwrap();
        assert_eq!(current_branch(w).unwrap(), "feat");
        std::fs::write(work.join("a.txt"), "wip").unwrap();
        op(w, GitOp::Stash).unwrap();
        op(w, GitOp::Checkout { branch: "main".into() }).unwrap();
        op(w, GitOp::StashPop).unwrap();
        assert_eq!(std::fs::read_to_string(work.join("a.txt")).unwrap(), "wip");
        op(w, GitOp::StageAll).unwrap();
        op(w, GitOp::Commit { message: "second".into(), amend: false }).unwrap();
        op(w, GitOp::Commit { message: "second (amended)".into(), amend: true }).unwrap();
        op(w, GitOp::Push).unwrap();
        op(w, GitOp::Fetch).unwrap();
        op(w, GitOp::Pull).unwrap();

        // remote branch checkout creates a tracking branch
        op(w, GitOp::CreateBranch { name: "other".into() }).unwrap();
        op(w, GitOp::Push).unwrap();
        op(w, GitOp::Checkout { branch: "main".into() }).unwrap();
        git(w, &["branch", "-D", "other"]).unwrap();
        op(w, GitOp::Checkout { branch: "origin/other".into() }).unwrap();
        assert_eq!(current_branch(w).unwrap(), "other");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn log_marks_sync_state() {
        let tmp = std::env::temp_dir().join(format!("tcon-sync-{}", uuid::Uuid::new_v4()));
        let remote = tmp.join("remote.git");
        let (a, b) = (tmp.join("a"), tmp.join("b"));
        std::fs::create_dir_all(&tmp).unwrap();
        let t = tmp.to_str().unwrap();
        git(t, &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]).unwrap();
        let setup = |dir: &std::path::Path| {
            let d = dir.to_str().unwrap();
            git(d, &["config", "user.email", "t@example.com"]).unwrap();
            git(d, &["config", "user.name", "t"]).unwrap();
            git(d, &["config", "commit.gpgsign", "false"]).unwrap();
        };
        git(t, &["clone", "-q", remote.to_str().unwrap(), a.to_str().unwrap()]).unwrap();
        setup(&a);
        let ad = a.to_str().unwrap();
        git(ad, &["switch", "-q", "-c", "main"]).ok();
        git(ad, &["commit", "-q", "--allow-empty", "-m", "base"]).unwrap();
        git(ad, &["push", "-q", "-u", "origin", "main"]).unwrap();

        git(t, &["clone", "-q", remote.to_str().unwrap(), b.to_str().unwrap()]).unwrap();
        setup(&b);
        let bd = b.to_str().unwrap();
        git(bd, &["commit", "-q", "--allow-empty", "-m", "theirs"]).unwrap();
        git(bd, &["push", "-q"]).unwrap();

        git(ad, &["commit", "-q", "--allow-empty", "-m", "mine"]).unwrap();
        git(ad, &["fetch", "-q"]).unwrap();
        git(ad, &["switch", "-q", "-c", "side"]).unwrap();
        git(ad, &["commit", "-q", "--allow-empty", "-m", "side-only"]).unwrap();
        git(ad, &["switch", "-q", "main"]).unwrap();

        let log = crate::git::log_sync(ad, 50).unwrap();
        let state = |msg: &str| log.iter().find(|c| c.summary == msg).map(|c| c.sync.clone()).expect(msg);
        assert_eq!(state("mine"), Some("outgoing".into()));
        assert_eq!(state("theirs"), Some("incoming".into()));
        assert_eq!(state("side-only"), Some("local".into()));
        assert_eq!(state("base"), None);
        std::fs::remove_dir_all(&tmp).ok();
    }
}
