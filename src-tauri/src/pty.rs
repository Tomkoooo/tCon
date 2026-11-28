//! PTY session manager: one portable-pty session per terminal pane.

use crate::osc::{OscEvent, OscFilter, PROBE_REPLY};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

struct Session {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    pane_id: String,
    status: crate::osc::ProgramStatus,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CwdEvent {
    pane_id: String,
    cwd: String,
}

/// Claude Code printed its usage-limit message in the pane.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LimitEvent {
    pane_id: String,
    hit: crate::limits::LimitHit,
}

/// A local dev-server URL printed by the pane (for the Browser view).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DevServerEvent {
    pane_id: String,
    url: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    pane_id: String,
    code: Option<u32>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    pub pane_id: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    /// Extra environment (from the selected account profile).
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Command typed into the shell after start (e.g. "claude").
    pub startup_command: Option<String>,
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
}

/// Longest startup command typed into the shell as is. The command is written before the shell
/// has set up its line editor, while the tty is still in canonical mode, and macOS keeps only
/// MAX_CANON (1024) bytes of a pending line: a longer one (an agent's `claude '<prompt>'`) is
/// cut off, loses its closing quote and leaves the shell at a `quote>` prompt.
const MAX_TYPED_COMMAND: usize = 512;

/// The line to type for a startup command: the command itself when it's short, otherwise
/// `source <script>` for a private one-shot script (0600, deletes itself) that holds it.
fn typed_startup_line(cmd: &str, pane_id: &str) -> String {
    if cmd.len() <= MAX_TYPED_COMMAND {
        return cmd.to_string();
    }
    match write_startup_script(cmd, pane_id) {
        Ok(path) => format!("source {}", sh_quote(&path.to_string_lossy())),
        Err(e) => {
            eprintln!("tCon: couldn't write startup script: {e}");
            cmd.to_string()
        }
    }
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn write_startup_script(cmd: &str, pane_id: &str) -> std::io::Result<std::path::PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let home = dirs::home_dir().ok_or_else(|| std::io::Error::other("no home directory"))?;
    let dir = home.join(".tcon").join("run");
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
    let safe: String = pane_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let path = dir.join(format!("start-{safe}-{nonce:x}.sh"));
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)?;
    // The script removes itself first; the shell keeps reading it from the open file.
    writeln!(f, "rm -f -- {}", sh_quote(&path.to_string_lossy()))?;
    writeln!(f, "{cmd}")?;
    Ok(path)
}

impl PtyManager {
    pub fn spawn(&self, app: AppHandle, opts: SpawnOptions, on_data: Channel) -> anyhow::Result<()> {
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize { rows: opts.rows.max(2), cols: opts.cols.max(2), pixel_width: 0, pixel_height: 0 })?;

        let mut cmd = CommandBuilder::new(default_shell());
        cmd.arg("-l");
        let cwd = if std::path::Path::new(&opts.cwd).is_dir() {
            opts.cwd.clone()
        } else {
            dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "/".into())
        };
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "tCon");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        cmd.env("LANG", std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into()));
        cmd.env_remove("CLAUDECODE"); // don't let nested sessions think they're inside Claude
        // Lets the SessionStart hook tCon passes to Claude record which pane a session runs in.
        cmd.env("TCON_PANE_ID", &opts.pane_id);
        // tCon's own launch/build variables (TAURI_*, npm_*, signing secrets) stay out of shells.
        for k in crate::security::inherited_vars_to_strip() {
            cmd.env_remove(k);
        }
        // tCon never injects secrets: the project env editor rejects them, and so does this.
        for (k, v) in opts.env.iter().filter(|(k, _)| !crate::security::is_secret_env_name(k)) {
            cmd.env(k, v);
        }

        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(pair.master.take_writer()?));
        let child = Arc::new(Mutex::new(child));

        if let Some(c) = opts.startup_command.as_ref().filter(|c| !c.trim().is_empty()) {
            let line = typed_startup_line(c.trim(), &opts.pane_id);
            let mut w = writer.lock();
            let _ = w.write_all(format!("{line}\r").as_bytes());
        }

        let pane_id = opts.pane_id.clone();
        let w2 = writer.clone();
        let child2 = child.clone();
        std::thread::Builder::new().name(format!("pty-{pane_id}")).spawn(move || {
            let mut filter = OscFilter::new();
            let mut dev_urls = crate::browser::devurl::DevUrlScanner::default();
            let mut limits = crate::limits::LimitScanner::default();
            let mut buf = vec![0u8; 64 * 1024];
            let mut events = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        events.clear();
                        let out = filter.feed(&buf[..n], &mut events);
                        for ev in events.drain(..) {
                            match ev {
                                OscEvent::Probe => {
                                    let mut w = w2.lock();
                                    let _ = w.write_all(PROBE_REPLY);
                                    let _ = w.flush();
                                }
                                OscEvent::Status(status) => {
                                    let _ = app.emit("pane-status", StatusEvent { pane_id: pane_id.clone(), status });
                                }
                                OscEvent::Cwd(cwd) => {
                                    let _ = app.emit("pane-cwd", CwdEvent { pane_id: pane_id.clone(), cwd });
                                }
                            }
                        }
                        if let Some(hit) = limits.feed(&out) {
                            let _ = app.emit_to("main", "pane-limit", LimitEvent { pane_id: pane_id.clone(), hit });
                        }
                        for url in dev_urls.feed(&out) {
                            let _ = app.emit_to("main", "dev-server", DevServerEvent { pane_id: pane_id.clone(), url });
                        }
                        if !out.is_empty() && on_data.send(InvokeResponseBody::Raw(out)).is_err() {
                            break;
                        }
                    }
                }
            }
            let code = child2.lock().wait().ok().map(|s| s.exit_code());
            let mut current = true;
            if let Some(state) = tauri::Manager::try_state::<PtyManager>(&app) {
                let mut sessions = state.sessions.lock();
                // Only remove if the map still holds *this* session (not a respawn).
                current = sessions.get(&pane_id).is_some_and(|s| Arc::ptr_eq(&s.child, &child2));
                if current {
                    sessions.remove(&pane_id);
                }
            }
            // A replaced (respawned) session exiting must not mark the pane as exited.
            if current {
                let _ = app.emit("pane-exit", ExitEvent { pane_id: pane_id.clone(), code });
            }
        })?;

        let old = self.sessions.lock().insert(opts.pane_id, Session { writer, master: pair.master, child });
        if let Some(old) = old {
            let _ = old.child.lock().kill(); // respawn of a still-running pane
        }
        Ok(())
    }

    pub fn write(&self, pane_id: &str, data: &[u8]) -> anyhow::Result<()> {
        let w = self.sessions.lock().get(pane_id).map(|s| s.writer.clone());
        if let Some(w) = w {
            let mut w = w.lock();
            w.write_all(data)?;
            w.flush()?;
        }
        Ok(())
    }

    pub fn resize(&self, pane_id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        if let Some(s) = self.sessions.lock().get(pane_id) {
            s.master.resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })?;
        }
        Ok(())
    }

    pub fn kill(&self, pane_id: &str) {
        if let Some(s) = self.sessions.lock().remove(pane_id) {
            let _ = s.child.lock().kill();
        }
    }

    pub fn kill_all(&self) {
        for (_, s) in self.sessions.lock().drain() {
            let _ = s.child.lock().kill();
        }
    }

    /// Name of the foreground process (e.g. "claude", "zsh") for tab titles.
    pub fn foreground_process(&self, pane_id: &str) -> Option<String> {
        let sessions = self.sessions.lock();
        let s = sessions.get(pane_id)?;
        let pid = s.master.process_group_leader()?;
        let out = std::process::Command::new("ps").args(["-o", "comm=", "-p", &pid.to_string()]).output().ok()?;
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let name = name.rsplit('/').next().unwrap_or(&name).trim_start_matches('-').to_string();
        if name.is_empty() { None } else { Some(name) }
    }
}

#[cfg(test)]
mod startup_tests {
    use super::*;

    #[test]
    fn short_commands_are_typed_as_is() {
        assert_eq!(typed_startup_line("claude --continue", "p1"), "claude --continue");
    }

    #[test]
    fn long_commands_go_through_a_self_deleting_script() {
        let cmd = format!("cd '/tmp' && claude '{}'", "x".repeat(2000));
        let line = typed_startup_line(&cmd, "pane-test");
        assert!(line.starts_with("source '") && line.len() < 200, "{line}");
        let path = line.trim_start_matches("source '").trim_end_matches('\'');
        let body = std::fs::read_to_string(path).unwrap();
        assert!(body.starts_with("rm -f -- ") && body.contains(&cmd));
        std::fs::remove_file(path).unwrap();
    }
}
