//! Credential hygiene and cheap guards against a misbehaving renderer.
//!
//! tCon never stores Claude tokens itself. Claude Code keeps each account's OAuth login in
//! the macOS login Keychain (service `Claude Code-credentials`, plus `-<sha256(dir)[..8]>`
//! for a custom `CLAUDE_CONFIG_DIR`) or, on Linux, in `<config dir>/.credentials.json`.
//! This module only looks at metadata (existence, permissions, symlinks) and never reads
//! secret content.
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

fn e2s(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "no home dir".to_string())
}

/// Credential files Claude Code may write into a config dir. Never shared, symlinked,
/// read or written by tCon.
pub const CREDENTIAL_FILE_NAMES: &[&str] = &[".credentials.json", "credentials.json"];

pub fn is_credential_file(name: &str) -> bool {
    CREDENTIAL_FILE_NAMES.contains(&name)
}

/// Keychain service name Claude Code uses for a config dir (None = default ~/.claude).
pub fn keychain_service(config_dir: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    match config_dir.filter(|d| !d.is_empty()) {
        None => "Claude Code-credentials".to_string(),
        Some(d) => {
            let hex: String = Sha256::digest(d.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
            format!("Claude Code-credentials-{}", &hex[..8])
        }
    }
}

// ---------------------------------------------------------------- environment

/// Variable names that look like secrets. tCon never passes these to terminals from its
/// own settings (the project env editor rejects them too).
pub fn is_secret_env_name(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL"].iter().any(|s| n.contains(s))
}

/// Inherited variables that belong to tCon's own build/launch (e.g. `npm run tauri dev`,
/// CI signing) and must not leak into user shells.
pub fn is_build_env_name(name: &str) -> bool {
    const EXACT: &[&str] = &[
        "APPLE_CERTIFICATE",
        "APPLE_CERTIFICATE_PASSWORD",
        "APPLE_PASSWORD",
        "APPLE_API_KEY",
        "APPLE_API_KEY_PATH",
        "APPLE_API_ISSUER",
        "APPLE_SIGNING_IDENTITY",
        "APPLE_ID",
        "APPLE_TEAM_ID",
        "KEYCHAIN_PASSWORD",
    ];
    name.starts_with("TAURI_") || name.starts_with("npm_") || name.starts_with("NPM_CONFIG_") || EXACT.contains(&name)
}

/// Names of variables in tCon's own environment that spawned processes must not inherit.
pub fn inherited_vars_to_strip() -> Vec<String> {
    std::env::vars_os()
        .filter_map(|(k, _)| k.into_string().ok())
        .filter(|k| is_build_env_name(k))
        .collect()
}

// ---------------------------------------------------------------- fs guards

/// Resolve `p` like the OS would (symlinks included) even when the leaf doesn't exist yet:
/// canonicalize the deepest existing ancestor, then append the rest lexically.
fn resolve(p: &Path) -> PathBuf {
    let mut existing = p.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(c) = fs::canonicalize(&existing) {
            let mut out = c;
            for seg in rest.iter().rev() {
                if seg == ".." {
                    out.pop();
                } else if seg != "." {
                    out.push(seg);
                }
            }
            return out;
        }
        match (existing.file_name().map(|s| s.to_os_string()), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent.to_path_buf();
            }
            _ => {
                // e.g. trailing ".." or a relative path that doesn't exist: normalize lexically.
                let mut out = PathBuf::new();
                for c in p.components() {
                    match c {
                        Component::ParentDir => {
                            out.pop();
                        }
                        Component::CurDir => {}
                        other => out.push(other.as_os_str()),
                    }
                }
                return out;
            }
        }
    }
}

fn canon(p: PathBuf) -> PathBuf {
    fs::canonicalize(&p).unwrap_or(p)
}

/// Reject editor/file-tree access to secrets that the editor never needs:
/// SSH/GPG keys, the Keychain files, Claude credential files, and the private config dirs
/// of tCon's extra accounts (their shared items resolve into ~/.claude and stay reachable).
pub fn check_fs_access_in(home: &Path, path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    let p = resolve(Path::new(path));
    let deny_dirs = [home.join(".ssh"), home.join(".gnupg"), home.join("Library/Keychains"), home.join(".claude-accounts")];
    for d in deny_dirs {
        let d = canon(d);
        if p.starts_with(&d) {
            return Err(format!("tCon does not open files in {} (it holds credentials)", d.display()));
        }
    }
    let home_c = canon(home.to_path_buf());
    if let Ok(rel) = p.strip_prefix(&home_c) {
        let in_claude = rel.components().next().is_some_and(|c| c.as_os_str().to_string_lossy().starts_with(".claude"));
        let name = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if in_claude && is_credential_file(&name) {
            return Err("tCon does not open Claude Code credential files".into());
        }
    }
    Ok(())
}

pub fn check_fs_access(path: &str) -> Result<(), String> {
    check_fs_access_in(&home()?, path)
}

// ---------------------------------------------------------------- audit

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// "warn" | "info"
    pub severity: &'static str,
    /// "plaintext-credentials" | "loose-dir" | "loose-file" | "external-symlink" | "shared-credentials" | "missing"
    pub kind: &'static str,
    pub message: String,
    /// Up to a few example paths.
    pub paths: Vec<String>,
    pub count: usize,
    /// "Fix permissions" can resolve it (chmod only).
    pub fixable: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeychainItem {
    pub service: String,
    pub present: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountAudit {
    pub config_dir: Option<String>,
    pub path: String,
    pub exists: bool,
    pub dir_mode: Option<String>,
    /// macOS only.
    pub keychain: Option<KeychainItem>,
    /// Plaintext credential files found in the config dir.
    pub credential_files: Vec<String>,
    pub issues: Vec<Issue>,
    pub scanned: usize,
    pub truncated: bool,
}

const MAX_SCAN: usize = 50_000;
const EXAMPLES: usize = 5;

#[cfg(unix)]
fn mode_of(m: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode() & 0o7777
}
#[cfg(not(unix))]
fn mode_of(_m: &fs::Metadata) -> u32 {
    0o700
}

fn fmt_mode(m: u32) -> String {
    format!("{m:04o}")
}

/// Group/other permission bits present.
fn is_loose(mode: u32) -> bool {
    mode & 0o077 != 0
}

struct Walk {
    loose_dirs: Vec<PathBuf>,
    loose_files: Vec<PathBuf>,
    symlinks: Vec<(PathBuf, PathBuf)>,
    credentials: Vec<PathBuf>,
    scanned: usize,
    truncated: bool,
}

/// Walk `root` without following symlinks.
fn walk(root: &Path) -> Walk {
    let mut w = Walk { loose_dirs: vec![], loose_files: vec![], symlinks: vec![], credentials: vec![], scanned: 0, truncated: false };
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for ent in rd.flatten() {
            if w.scanned >= MAX_SCAN {
                w.truncated = true;
                return w;
            }
            w.scanned += 1;
            let p = ent.path();
            let Ok(m) = fs::symlink_metadata(&p) else { continue };
            let ft = m.file_type();
            let name = ent.file_name().to_string_lossy().into_owned();
            if ft.is_symlink() {
                if let Ok(t) = fs::read_link(&p) {
                    let abs = if t.is_absolute() { t } else { dir.join(t) };
                    w.symlinks.push((p.clone(), abs));
                }
                if is_credential_file(&name) {
                    w.credentials.push(p);
                }
                continue;
            }
            if ft.is_dir() {
                if is_loose(mode_of(&m)) {
                    w.loose_dirs.push(p.clone());
                }
                stack.push(p);
            } else {
                if is_loose(mode_of(&m)) {
                    w.loose_files.push(p.clone());
                }
                if is_credential_file(&name) {
                    w.credentials.push(p);
                }
            }
        }
    }
    w
}

fn tilde(home: &Path, p: &Path) -> String {
    match p.strip_prefix(home) {
        Ok(rel) => format!("~/{}", rel.display()),
        Err(_) => p.display().to_string(),
    }
}

fn examples(home: &Path, v: &[PathBuf]) -> Vec<String> {
    v.iter().take(EXAMPLES).map(|p| tilde(home, p)).collect()
}

/// The config dir an account uses (None/empty = ~/.claude).
fn account_dir(home: &Path, config_dir: Option<&str>) -> PathBuf {
    match config_dir.filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => home.join(".claude"),
    }
}

/// Extra files outside the config dir that belong to the account (the default account's
/// state file lives at ~/.claude.json).
fn account_side_files(home: &Path, config_dir: Option<&str>) -> Vec<PathBuf> {
    if config_dir.filter(|d| !d.is_empty()).is_none() { vec![home.join(".claude.json")] } else { vec![] }
}

pub fn audit_account_in(home: &Path, config_dir: Option<&str>, keychain_check: &dyn Fn(&str) -> Option<bool>) -> AccountAudit {
    let dir = account_dir(home, config_dir);
    let mut out = AccountAudit {
        config_dir: config_dir.map(str::to_string),
        path: tilde(home, &dir),
        exists: dir.is_dir(),
        dir_mode: None,
        keychain: None,
        credential_files: vec![],
        issues: vec![],
        scanned: 0,
        truncated: false,
    };
    let service = keychain_service(config_dir);
    out.keychain = keychain_check(&service).map(|present| KeychainItem { service, present });
    if !out.exists {
        out.issues.push(Issue {
            severity: "info",
            kind: "missing",
            message: "The config directory does not exist yet.".into(),
            paths: vec![],
            count: 0,
            fixable: false,
        });
        return out;
    }

    let mut loose_dirs = Vec::new();
    let mut loose_files = Vec::new();
    // The dir itself, and ~/.claude-accounts for extra accounts.
    let mut own_dirs = vec![dir.clone()];
    if let Some(parent) = dir.parent().filter(|p| p.file_name().is_some_and(|n| n == ".claude-accounts")) {
        own_dirs.push(parent.to_path_buf());
    }
    for d in own_dirs {
        if let Ok(m) = fs::metadata(&d) {
            if d == dir {
                out.dir_mode = Some(fmt_mode(mode_of(&m)));
            }
            if is_loose(mode_of(&m)) {
                loose_dirs.push(d);
            }
        }
    }
    for f in account_side_files(home, config_dir) {
        if let Ok(m) = fs::symlink_metadata(&f) {
            if m.is_file() && is_loose(mode_of(&m)) {
                loose_files.push(f);
            }
        }
    }

    let w = walk(&dir);
    out.scanned = w.scanned;
    out.truncated = w.truncated;
    loose_dirs.extend(w.loose_dirs);
    loose_files.extend(w.loose_files);

    let shared_root = canon(home.join(".claude"));
    let dir_c = canon(dir.clone());
    let mut external = Vec::new();
    let mut shared_creds = Vec::new();
    for (link, target) in &w.symlinks {
        let t = resolve(target);
        let name = link.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if is_credential_file(&name) {
            shared_creds.push(link.clone());
        } else if !t.starts_with(&shared_root) && !t.starts_with(&dir_c) {
            external.push(link.clone());
        }
    }
    let plain: Vec<PathBuf> = w.credentials.iter().filter(|p| !shared_creds.contains(p)).cloned().collect();
    out.credential_files = plain.iter().map(|p| tilde(home, p)).collect();

    if !plain.is_empty() {
        let linux = cfg!(target_os = "linux");
        out.issues.push(Issue {
            severity: if linux { "info" } else { "warn" },
            kind: "plaintext-credentials",
            message: if linux {
                "Claude Code stores this login in a plaintext file (normal on Linux). Any program running as you can read it; keep it 0600.".into()
            } else {
                "A plaintext credential file exists although this system has a Keychain. Any program running as you can read it.".into()
            },
            paths: examples(home, &plain),
            count: plain.len(),
            fixable: false,
        });
    }
    if !shared_creds.is_empty() {
        out.issues.push(Issue {
            severity: "warn",
            kind: "shared-credentials",
            message: "A credential file is a symlink, so this account shares its login with another one.".into(),
            paths: examples(home, &shared_creds),
            count: shared_creds.len(),
            fixable: false,
        });
    }
    if !external.is_empty() {
        out.issues.push(Issue {
            severity: "warn",
            kind: "external-symlink",
            message: "Symlinks point outside ~/.claude. Whatever they point to is read and written as this account's config.".into(),
            paths: examples(home, &external),
            count: external.len(),
            fixable: false,
        });
    }
    if !loose_dirs.is_empty() {
        out.issues.push(Issue {
            severity: "warn",
            kind: "loose-dir",
            message: format!("{} director{} can be listed by other users on this Mac (should be 0700).", loose_dirs.len(), if loose_dirs.len() == 1 { "y" } else { "ies" }),
            paths: examples(home, &loose_dirs),
            count: loose_dirs.len(),
            fixable: true,
        });
    }
    if !loose_files.is_empty() {
        out.issues.push(Issue {
            severity: "warn",
            kind: "loose-file",
            message: format!("{} file{} can be read by other users (should be 0600).", loose_files.len(), if loose_files.len() == 1 { "" } else { "s" }),
            paths: examples(home, &loose_files),
            count: loose_files.len(),
            fixable: true,
        });
    }
    out
}

/// Only ~/.claude and tCon's own account dirs (~/.claude-accounts/<id>) may be chmod-ed.
fn fixable_root(home: &Path, dir: &Path) -> bool {
    let Ok(d) = fs::canonicalize(dir) else { return false };
    let base = canon(home.join(".claude"));
    let accounts = canon(home.join(".claude-accounts"));
    d == base || d.parent() == Some(accounts.as_path())
}

#[cfg(unix)]
fn tighten(p: &Path, m: &fs::Metadata) -> std::io::Result<bool> {
    use std::os::unix::fs::PermissionsExt;
    let mode = mode_of(m);
    if !is_loose(mode) {
        return Ok(false);
    }
    fs::set_permissions(p, fs::Permissions::from_mode(mode & !0o077))?;
    Ok(true)
}
#[cfg(not(unix))]
fn tighten(_p: &Path, _m: &fs::Metadata) -> std::io::Result<bool> {
    Ok(false)
}

/// chmod go-rwx on everything in the account dirs (no symlink is followed, nothing is
/// read, deleted or moved). Returns how many entries changed.
pub fn fix_permissions_in(home: &Path, config_dirs: &[Option<String>]) -> Result<usize, String> {
    let mut changed = 0;
    let mut seen = HashSet::new();
    for cd in config_dirs {
        let cd = cd.as_deref();
        let dir = account_dir(home, cd);
        if !dir.is_dir() {
            continue;
        }
        if !fixable_root(home, &dir) {
            return Err(format!("{} is not a Claude config dir managed by tCon", dir.display()));
        }
        if !seen.insert(canon(dir.clone())) {
            continue;
        }
        let mut targets = vec![dir.clone()];
        if let Some(parent) = dir.parent().filter(|p| p.file_name().is_some_and(|n| n == ".claude-accounts")) {
            targets.push(parent.to_path_buf());
        }
        targets.extend(account_side_files(home, cd));
        let w = walk(&dir);
        targets.extend(w.loose_dirs);
        targets.extend(w.loose_files);
        for t in targets {
            let Ok(m) = fs::symlink_metadata(&t) else { continue };
            if m.file_type().is_symlink() {
                continue;
            }
            if tighten(&t, &m).map_err(|e| format!("{}: {e}", t.display()))? {
                changed += 1;
            }
        }
    }
    Ok(changed)
}

// ---------------------------------------------------------------- keychain (macOS)

/// Whether the Keychain holds an item for `service`. Uses `security find-generic-password`
/// without -g/-w, which only matches attributes: the secret is never requested or printed.
#[cfg(target_os = "macos")]
fn keychain_has(service: &str) -> Option<bool> {
    use std::process::{Command, Stdio};
    let st = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", service])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()?;
    Some(st.success())
}
#[cfg(not(target_os = "macos"))]
fn keychain_has(_service: &str) -> Option<bool> {
    None
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeychainAcl {
    pub service: String,
    /// The decrypt ACL has no application list: every app may read it.
    pub any_application: bool,
    /// Apps allowed to read the secret without asking.
    pub trusted_apps: Vec<String>,
    /// Reading asks for the login password.
    pub requires_password: bool,
    /// Partition list (e.g. "apple-tool:" = Apple-signed tools only).
    pub partitions: Vec<String>,
}

/// Parse `security dump-keychain -a` output, keeping only Claude Code's items.
pub fn parse_keychain_acls(dump: &str) -> Vec<KeychainAcl> {
    let mut out = Vec::new();
    for item in dump.split("keychain: \"").skip(1) {
        let service = item.lines().find_map(|l| {
            let l = l.trim();
            l.strip_prefix("\"svce\"<blob>=\"").and_then(|r| r.strip_suffix('"')).map(str::to_string)
        });
        let Some(service) = service.filter(|s| s.starts_with("Claude Code-credentials")) else { continue };
        let mut acl = KeychainAcl { service, ..Default::default() };
        let mut auths = String::new();
        let mut in_apps = false;
        let mut apps: Option<Vec<String>> = None;
        let mut no_password = false;
        let mut description = String::new();
        let flush = |auths: &str, apps: &Option<Vec<String>>, no_password: bool, description: &str, acl: &mut KeychainAcl| {
            if auths.split_whitespace().any(|a| a == "decrypt") {
                match apps {
                    None => acl.any_application = true,
                    Some(v) => acl.trusted_apps.extend(v.iter().cloned()),
                }
                acl.requires_password |= !no_password;
            }
            if auths.split_whitespace().any(|a| a == "partition_id") && !description.is_empty() {
                acl.partitions.extend(description.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
            }
        };
        let mut started = false;
        for line in item.lines() {
            let t = line.trim();
            if t.starts_with("entry ") && t.ends_with(':') {
                if started {
                    flush(&auths, &apps, no_password, &description, &mut acl);
                }
                started = true;
                auths.clear();
                apps = None;
                in_apps = false;
                no_password = false;
                description.clear();
            } else if let Some(rest) = t.strip_prefix("authorizations") {
                auths = rest.split_once(':').map(|x| x.1.to_string()).unwrap_or_default();
            } else if t == "don't-require-password" {
                no_password = true;
            } else if let Some(d) = t.strip_prefix("description: ") {
                description = d.to_string();
            } else if t == "applications: <null>" {
                apps = None;
                in_apps = false;
            } else if t.starts_with("applications (") {
                apps = Some(vec![]);
                in_apps = true;
            } else if in_apps {
                if let Some((idx, rest)) = t.split_once(": ") {
                    if idx.chars().all(|c| c.is_ascii_digit()) {
                        let app = rest.trim_end_matches(" (OK)").trim_end_matches(" (status 0)").to_string();
                        if let Some(v) = apps.as_mut() {
                            v.push(app);
                        }
                    }
                }
            }
        }
        if started {
            flush(&auths, &apps, no_password, &description, &mut acl);
        }
        acl.trusted_apps.sort();
        acl.trusted_apps.dedup();
        out.push(acl);
    }
    out
}

// ---------------------------------------------------------------- commands

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(e2s)?
}

/// Audit each account's config dir (None = default ~/.claude).
#[tauri::command]
pub async fn security_audit(config_dirs: Vec<Option<String>>) -> Result<Vec<AccountAudit>, String> {
    blocking(move || {
        let h = home()?;
        Ok(config_dirs.iter().map(|cd| audit_account_in(&h, cd.as_deref(), &keychain_has)).collect())
    })
    .await
}

#[tauri::command]
pub async fn security_fix_permissions(config_dirs: Vec<Option<String>>) -> Result<usize, String> {
    blocking(move || fix_permissions_in(&home()?, &config_dirs)).await
}

/// Read the access-control lists of Claude Code's Keychain items (metadata only: no -d,
/// so `security` never decrypts anything). Slow: it walks the whole login keychain.
#[tauri::command]
pub async fn security_keychain_acl() -> Result<Vec<KeychainAcl>, String> {
    #[cfg(target_os = "macos")]
    {
        blocking(|| {
            let out = std::process::Command::new("/usr/bin/security")
                .args(["dump-keychain", "-a"])
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .output()
                .map_err(e2s)?;
            Ok(parse_keychain_acls(&String::from_utf8_lossy(&out.stdout)))
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("The Keychain is only used on macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tcon-sec-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        canon(d)
    }

    #[cfg(unix)]
    fn chmod(p: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(p, fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(unix)]
    fn mode(p: &Path) -> u32 {
        mode_of(&fs::symlink_metadata(p).unwrap())
    }

    #[test]
    fn keychain_service_names() {
        assert_eq!(keychain_service(None), "Claude Code-credentials");
        assert_eq!(keychain_service(Some("")), "Claude Code-credentials");
        // sha256("/Users/x/.claude-accounts/abc")[..8]
        let s = keychain_service(Some("/Users/x/.claude-accounts/abc"));
        assert!(s.starts_with("Claude Code-credentials-") && s.len() == "Claude Code-credentials-".len() + 8, "{s}");
        assert_eq!(s, keychain_service(Some("/Users/x/.claude-accounts/abc")));
        // First 8 hex chars of sha256("abc"), matching what Claude Code appends.
        assert_eq!(keychain_service(Some("abc")), "Claude Code-credentials-ba7816bf");
    }

    #[test]
    fn env_name_classification() {
        for n in ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "db_password", "AWS_SECRET_ACCESS_KEY", "GOOGLE_APPLICATION_CREDENTIALS"] {
            assert!(is_secret_env_name(n), "{n}");
        }
        for n in ["CLAUDE_CONFIG_DIR", "NODE_ENV", "PATH", "ANTHROPIC_MODEL"] {
            assert!(!is_secret_env_name(n), "{n}");
        }
        for n in ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_ENV_DEBUG", "npm_config__authToken", "APPLE_PASSWORD", "APPLE_CERTIFICATE"] {
            assert!(is_build_env_name(n), "{n}");
        }
        assert!(!is_build_env_name("HOME") && !is_build_env_name("CLAUDE_CONFIG_DIR"));
    }

    #[test]
    fn fs_guard_blocks_secrets_but_not_projects() {
        let home = tmp("guard");
        for d in [".ssh", ".claude", ".claude-accounts/a1", "proj/src", ".gnupg"] {
            fs::create_dir_all(home.join(d)).unwrap();
        }
        fs::write(home.join(".ssh/id_ed25519"), "k").unwrap();
        fs::write(home.join(".claude/.credentials.json"), "{}").unwrap();
        fs::write(home.join(".claude/CLAUDE.md"), "x").unwrap();
        let h = |p: &str| home.join(p).to_string_lossy().into_owned();
        let ok = |p: &str| check_fs_access_in(&home, &h(p));

        assert!(ok(".ssh/id_ed25519").is_err());
        assert!(ok(".ssh").is_err());
        assert!(ok(".gnupg/x").is_err());
        assert!(ok(".claude/.credentials.json").is_err());
        assert!(ok(".claude-accounts/a1/.credentials.json").is_err());
        assert!(ok(".claude-accounts/a1/.claude.json").is_err());
        assert!(ok("proj/../.ssh/id_ed25519").is_err());
        assert!(ok("proj/nope/../../.ssh/new").is_err());
        assert!(ok(".claude/CLAUDE.md").is_ok());
        assert!(ok(".claude/settings.json").is_ok());
        assert!(ok("proj/src/main.rs").is_ok());
        assert!(ok("proj/.credentials.json").is_ok(), "only Claude's credential files are special");
        assert!(check_fs_access_in(&home, "").is_err());

        // A symlink from a project into ~/.ssh is resolved and refused.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(home.join(".ssh"), home.join("proj/keys")).unwrap();
            assert!(ok("proj/keys/id_ed25519").is_err());
            // ...while an account's shared item that resolves into ~/.claude is fine.
            std::os::unix::fs::symlink(home.join(".claude/CLAUDE.md"), home.join("proj/CLAUDE.md")).unwrap();
            assert!(ok("proj/CLAUDE.md").is_ok());
        }
        fs::remove_dir_all(&home).ok();
    }

    #[cfg(unix)]
    #[test]
    fn audit_flags_and_fix_tightens() {
        let home = tmp("audit");
        let base = home.join(".claude");
        let acct = home.join(".claude-accounts/a1");
        fs::create_dir_all(base.join("projects/p")).unwrap();
        fs::create_dir_all(&acct).unwrap();
        fs::create_dir_all(home.join("elsewhere")).unwrap();
        chmod(&base, 0o755);
        chmod(&base.join("projects"), 0o755);
        chmod(&base.join("projects/p"), 0o700);
        chmod(&home.join(".claude-accounts"), 0o755);
        chmod(&acct, 0o755);
        fs::write(base.join("history.jsonl"), "h").unwrap();
        chmod(&base.join("history.jsonl"), 0o644);
        fs::write(base.join("projects/p/s.jsonl"), "s").unwrap();
        chmod(&base.join("projects/p/s.jsonl"), 0o600);
        fs::write(home.join(".claude.json"), "{}").unwrap();
        chmod(&home.join(".claude.json"), 0o644);
        fs::write(acct.join(".credentials.json"), "{}").unwrap();
        chmod(&acct.join(".credentials.json"), 0o644);
        std::os::unix::fs::symlink(base.join("projects"), acct.join("projects")).unwrap();
        std::os::unix::fs::symlink(home.join("elsewhere"), acct.join("plugins")).unwrap();
        std::os::unix::fs::symlink(base.join(".credentials.json"), acct.join("credentials.json")).unwrap();

        let kc = |s: &str| Some(s == "Claude Code-credentials");
        let a = audit_account_in(&home, None, &kc);
        assert!(a.exists);
        assert_eq!(a.dir_mode.as_deref(), Some("0755"));
        assert!(a.keychain.as_ref().unwrap().present);
        let kinds: Vec<&str> = a.issues.iter().map(|i| i.kind).collect();
        assert!(kinds.contains(&"loose-dir") && kinds.contains(&"loose-file"), "{kinds:?}");
        let lf = a.issues.iter().find(|i| i.kind == "loose-file").unwrap();
        assert_eq!(lf.count, 2, "history.jsonl + ~/.claude.json: {lf:?}");
        assert!(a.credential_files.is_empty());

        let dir = acct.to_string_lossy().into_owned();
        let b = audit_account_in(&home, Some(&dir), &kc);
        assert!(!b.keychain.as_ref().unwrap().present);
        let kinds: Vec<&str> = b.issues.iter().map(|i| i.kind).collect();
        for k in ["plaintext-credentials", "shared-credentials", "external-symlink", "loose-dir", "loose-file"] {
            assert!(kinds.contains(&k), "{k} missing from {kinds:?}");
        }
        assert_eq!(b.credential_files, vec!["~/.claude-accounts/a1/.credentials.json".to_string()]);
        let ext = b.issues.iter().find(|i| i.kind == "external-symlink").unwrap();
        assert_eq!(ext.paths, vec!["~/.claude-accounts/a1/plugins".to_string()]);
        let ld = b.issues.iter().find(|i| i.kind == "loose-dir").unwrap();
        assert_eq!(ld.count, 2, "the account dir and ~/.claude-accounts: {ld:?}");

        // Fix: only chmod, contents untouched, symlinks untouched.
        let n = fix_permissions_in(&home, &[None, Some(dir.clone())]).unwrap();
        assert!(n >= 6, "changed {n}");
        assert_eq!(mode(&base), 0o700);
        assert_eq!(mode(&base.join("projects")), 0o700);
        assert_eq!(mode(&base.join("history.jsonl")), 0o600);
        assert_eq!(mode(&home.join(".claude.json")), 0o600);
        assert_eq!(mode(&acct), 0o700);
        assert_eq!(mode(&home.join(".claude-accounts")), 0o700);
        assert_eq!(mode(&acct.join(".credentials.json")), 0o600);
        assert_eq!(mode(&home.join("elsewhere")), 0o755, "symlink targets outside are not touched");
        assert_eq!(fs::read_to_string(acct.join(".credentials.json")).unwrap(), "{}");
        let after = audit_account_in(&home, Some(&dir), &kc);
        assert!(!after.issues.iter().any(|i| i.fixable), "{:?}", after.issues);

        // Refuses dirs tCon doesn't manage.
        assert!(fix_permissions_in(&home, &[Some(home.join("elsewhere").to_string_lossy().into_owned())]).is_err());
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn audit_missing_dir() {
        let home = tmp("missing");
        let a = audit_account_in(&home, Some(&home.join("nope").to_string_lossy()), &|_| None);
        assert!(!a.exists && a.keychain.is_none());
        assert_eq!(a.issues[0].kind, "missing");
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn parses_keychain_acl_dump() {
        let dump = r#"keychain: "/Users/u/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="someone"
    "svce"<blob>="Claude Code-credentials-94399583"
access: 3 entries
    entry 0:
        authorizations (6): decrypt derive export_clear export_wrapped mac sign
        don't-require-password
        description: Claude Code-credentials-94399583
        applications (1):
            0: /usr/bin/security (OK)
                requirement: identifier "com.apple.security" and anchor apple
    entry 1:
        authorizations (1): encrypt
        don't-require-password
        description: Claude Code-credentials-94399583
        applications: <null>
    entry 2:
        authorizations (1): partition_id
        don't-require-password
        description: apple-tool:
        applications: <null>
keychain: "/Users/u/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "svce"<blob>="Other App"
access: 1 entries
    entry 0:
        authorizations (1): decrypt
        applications: <null>
keychain: "/Users/u/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "svce"<blob>="Claude Code-credentials"
access: 1 entries
    entry 0:
        authorizations (2): decrypt sign
        description: Claude Code-credentials
        applications: <null>
"#;
        let acls = parse_keychain_acls(dump);
        assert_eq!(acls.len(), 2);
        assert_eq!(
            acls[0],
            KeychainAcl {
                service: "Claude Code-credentials-94399583".into(),
                any_application: false,
                trusted_apps: vec!["/usr/bin/security".into()],
                requires_password: false,
                partitions: vec!["apple-tool:".into()],
            }
        );
        assert!(acls[1].any_application && acls[1].requires_password);
    }
}
