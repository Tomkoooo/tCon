//! Claude Code session tracking per terminal pane, so every Claude pane can resume its own
//! conversation after a restart or an account switch.
//!
//! - tCon starts `claude` with `--settings` holding a `SessionStart` hook (src/claudeSessions.ts)
//!   that writes the hook input (JSON with `session_id`) to `~/.tcon/sessions/<pane id>.json`
//!   (the pane id comes from `TCON_PANE_ID`, set by pty.rs). [`claude_pane_sessions`] reads them.
//! - [`copy_session`] copies one conversation transcript between two Claude config dirs
//!   (account switch). It only ever reads and writes below `<config>/projects/`; credential
//!   files are never touched.
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

fn sessions_dir(home: &Path) -> PathBuf {
    home.join(".tcon").join("sessions")
}

fn valid_pane_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Claude session ids are UUIDs.
pub fn valid_session_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') && id.matches('-').count() == 4
}

/// How Claude Code names a project folder: every character that isn't ASCII alphanumeric
/// becomes `-` (`/Users/me/my app` → `-Users-me-my-app`).
pub fn encode_project_dir(cwd: &str) -> String {
    cwd.trim_end_matches('/').chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

pub fn read_pane_sessions(home: &Path, pane_ids: &[String]) -> HashMap<String, String> {
    let dir = sessions_dir(home);
    let mut out = HashMap::new();
    for id in pane_ids.iter().filter(|i| valid_pane_id(i)) {
        let Ok(text) = fs::read_to_string(dir.join(format!("{id}.json"))) else { continue };
        let sid = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("session_id").and_then(|s| s.as_str()).map(str::to_string));
        if let Some(sid) = sid.filter(|s| valid_session_id(s)) {
            out.insert(id.clone(), sid);
        }
    }
    out
}

pub fn forget_panes(home: &Path, pane_ids: &[String]) {
    let dir = sessions_dir(home);
    for id in pane_ids.iter().filter(|i| valid_pane_id(i)) {
        let _ = fs::remove_file(dir.join(format!("{id}.json")));
    }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for ent in fs::read_dir(from)? {
        let ent = ent?;
        let ty = ent.file_type()?;
        if ty.is_symlink() {
            continue;
        }
        let dest = to.join(ent.file_name());
        if ty.is_dir() {
            copy_dir(&ent.path(), &dest)?;
        } else {
            fs::copy(ent.path(), dest)?;
        }
    }
    Ok(())
}

/// Copy the transcript of `session_id` (and its side folder, if any) for `cwd` from one
/// Claude config dir to another. Returns false when the source has no such session.
pub fn copy_session(from_config: &Path, to_config: &Path, cwd: &str, session_id: &str) -> Result<bool, String> {
    if !valid_session_id(session_id) {
        return Err(format!("invalid session id: {session_id}"));
    }
    let enc = encode_project_dir(cwd);
    if enc.is_empty() || from_config == to_config {
        return Ok(false);
    }
    let src = from_config.join("projects").join(&enc);
    let dst = to_config.join("projects").join(&enc);
    let file = src.join(format!("{session_id}.jsonl"));
    if !file.is_file() {
        return Ok(false);
    }
    fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
    let target = dst.join(format!("{session_id}.jsonl"));
    // Never overwrite a newer copy (the session may already continue on that account).
    let newer = target.metadata().and_then(|m| m.modified()).ok() > file.metadata().and_then(|m| m.modified()).ok();
    if !newer {
        fs::copy(&file, &target).map_err(|e| e.to_string())?;
    }
    let side = src.join(session_id);
    if side.is_dir() {
        copy_dir(&side, &dst.join(session_id)).map_err(|e| e.to_string())?;
    }
    Ok(true)
}

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "no home directory".to_string())
}

/// Default config dir when no account sets CLAUDE_CONFIG_DIR.
fn config_or_default(dir: Option<String>) -> Result<PathBuf, String> {
    match dir.filter(|d| !d.trim().is_empty()) {
        Some(d) => Ok(PathBuf::from(d)),
        None => Ok(home()?.join(".claude")),
    }
}

#[tauri::command]
pub fn claude_pane_sessions(pane_ids: Vec<String>) -> Result<HashMap<String, String>, String> {
    Ok(read_pane_sessions(&home()?, &pane_ids))
}

#[tauri::command]
pub fn claude_forget_panes(pane_ids: Vec<String>) -> Result<(), String> {
    forget_panes(&home()?, &pane_ids);
    Ok(())
}

#[tauri::command]
pub async fn claude_copy_session(from_config: Option<String>, to_config: Option<String>, cwd: String, session_id: String) -> Result<bool, String> {
    let from = config_or_default(from_config)?;
    let to = config_or_default(to_config)?;
    tauri::async_runtime::spawn_blocking(move || copy_session(&from, &to, &cwd, &session_id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    #[test]
    fn encodes_like_claude() {
        assert_eq!(encode_project_dir("/Users/tomko/programing/tCon"), "-Users-tomko-programing-tCon");
        assert_eq!(encode_project_dir("/a/my app.v2/"), "-a-my-app-v2");
    }

    #[test]
    fn reads_pane_sessions() {
        let home = std::env::temp_dir().join(format!("tcon-sess-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(sessions_dir(&home)).unwrap();
        fs::write(sessions_dir(&home).join("p1.json"), format!(r#"{{"session_id":"{SID}","source":"startup"}}"#)).unwrap();
        fs::write(sessions_dir(&home).join("p2.json"), r#"{"session_id":"../../etc"}"#).unwrap();
        let m = read_pane_sessions(&home, &["p1".into(), "p2".into(), "../x".into(), "p3".into()]);
        assert_eq!(m.len(), 1);
        assert_eq!(m["p1"], SID);
        forget_panes(&home, &["p1".into()]);
        assert!(read_pane_sessions(&home, &["p1".into()]).is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn copies_only_the_transcript() {
        let base = std::env::temp_dir().join(format!("tcon-copy-{}", uuid::Uuid::new_v4()));
        let (a, b) = (base.join("a"), base.join("b"));
        let enc = encode_project_dir("/w/proj");
        let src = a.join("projects").join(&enc);
        fs::create_dir_all(src.join(SID)).unwrap();
        fs::write(src.join(format!("{SID}.jsonl")), "{}\n").unwrap();
        fs::write(src.join(SID).join("todo.json"), "[]").unwrap();
        fs::write(a.join(".credentials.json"), "secret").unwrap();
        assert!(copy_session(&a, &b, "/w/proj", SID).unwrap());
        let dst = b.join("projects").join(&enc);
        assert!(dst.join(format!("{SID}.jsonl")).is_file());
        assert!(dst.join(SID).join("todo.json").is_file());
        assert!(!b.join(".credentials.json").exists());
        assert!(!copy_session(&a, &b, "/w/other", SID).unwrap());
        assert!(copy_session(&a, &b, "/w/proj", "../../x").is_err());
        let _ = fs::remove_dir_all(base);
    }
}
