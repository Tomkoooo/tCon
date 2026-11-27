//! Import a Chromium-family profile (cookies, logins, storage, extensions, bookmarks…) into the
//! tCon-managed Chrome profile by copying the profile directory while the managed browser is closed.
//!
//! Cookies and saved passwords stay readable only when the managed profile is launched with the
//! same browser (same "<Browser> Safe Storage" key). Firefox and Safari are listed as unsupported:
//! their stores need format conversion / Full Disk Access and cross-engine import is fragile.

use super::chrome::{current_os, managed_dir, profile_in_use, user_data_dirs, Family};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    /// directory name inside the user-data-dir ("Default", "Profile 1")
    pub dir: String,
    pub name: String,
    pub user: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    pub browser: String,
    pub family: Option<Family>,
    pub user_data_dir: String,
    pub profiles: Vec<ProfileInfo>,
    pub running: bool,
    pub supported: bool,
    pub reason: Option<String>,
}

fn profile_order(dir: &str) -> (u8, u32, String) {
    if dir == "Default" {
        (0, 0, String::new())
    } else if let Some(n) = dir.strip_prefix("Profile ").and_then(|n| n.parse().ok()) {
        (1, n, String::new())
    } else {
        (2, 0, dir.to_string())
    }
}

/// Profiles listed in a "Local State" file (profile.info_cache), Default first.
pub fn parse_local_state_profiles(json: &str) -> Vec<ProfileInfo> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return vec![] };
    let Some(cache) = v.pointer("/profile/info_cache").and_then(|c| c.as_object()) else { return vec![] };
    let mut out: Vec<ProfileInfo> = cache
        .iter()
        .filter(|(dir, _)| valid_profile_dir(dir))
        .map(|(dir, info)| {
            let s = |k: &str| info.get(k).and_then(|x| x.as_str()).map(str::trim).filter(|x| !x.is_empty()).map(String::from);
            ProfileInfo { dir: dir.clone(), name: s("name").or_else(|| s("gaia_name")).unwrap_or_else(|| dir.clone()), user: s("user_name") }
        })
        .collect();
    out.sort_by_key(|p| profile_order(&p.dir));
    out
}

pub fn valid_profile_dir(dir: &str) -> bool {
    !dir.is_empty() && dir.len() < 128 && dir != "." && dir != ".." && !dir.contains(['/', '\\', '\0'])
}

fn profiles_of(user_data_dir: &Path) -> Vec<ProfileInfo> {
    let from_state = std::fs::read_to_string(user_data_dir.join("Local State")).map(|s| parse_local_state_profiles(&s)).unwrap_or_default();
    let mut out: Vec<ProfileInfo> = from_state.into_iter().filter(|p| user_data_dir.join(&p.dir).is_dir()).collect();
    if out.is_empty() {
        if let Ok(rd) = std::fs::read_dir(user_data_dir) {
            for e in rd.flatten() {
                let dir = e.file_name().to_string_lossy().into_owned();
                if (dir == "Default" || dir.starts_with("Profile ")) && e.path().join("Preferences").is_file() {
                    out.push(ProfileInfo { name: dir.clone(), dir, user: None });
                }
            }
        }
        out.sort_by_key(|p| profile_order(&p.dir));
    }
    out
}

pub fn list_sources() -> Vec<ImportSource> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let mut out = Vec::new();
    for (family, dir) in user_data_dirs(current_os(), &home, &|k| std::env::var(k).ok()) {
        if !dir.is_dir() {
            continue;
        }
        let profiles = profiles_of(&dir);
        if profiles.is_empty() {
            continue;
        }
        out.push(ImportSource {
            browser: family.label().to_string(),
            family: Some(family),
            user_data_dir: dir.to_string_lossy().into_owned(),
            profiles,
            running: profile_in_use(&dir),
            supported: true,
            reason: None,
        });
    }
    let firefox = match current_os() {
        "macos" => home.join("Library/Application Support/Firefox"),
        "windows" => std::env::var("APPDATA").map(|a| PathBuf::from(a).join("Mozilla/Firefox")).unwrap_or_default(),
        _ => home.join(".mozilla/firefox"),
    };
    if firefox.is_dir() {
        out.push(unsupported("Firefox", &firefox, "Firefox keeps sessions in its own formats (cookies.sqlite, NSS-encrypted logins) that Chrome can't read. Sign in once in the tCon profile instead."));
    }
    if current_os() == "macos" && Path::new("/Applications/Safari.app").exists() {
        out.push(unsupported("Safari", &home.join("Library/Safari"), "Safari's cookies are a private binary format behind Full Disk Access; tCon doesn't read them. Sign in once in the tCon profile instead."));
    }
    out
}

fn unsupported(browser: &str, dir: &Path, reason: &str) -> ImportSource {
    ImportSource {
        browser: browser.into(),
        family: None,
        user_data_dir: dir.to_string_lossy().into_owned(),
        profiles: vec![],
        running: false,
        supported: false,
        reason: Some(reason.into()),
    }
}

/// Keep only the imported profile in Local State, renamed to "Default".
pub fn patch_local_state(json: &str, src_profile: &str) -> Result<String, String> {
    let mut v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("bad Local State: {e}"))?;
    let entry = v.pointer(&format!("/profile/info_cache/{}", src_profile.replace('~', "~0").replace('/', "~1"))).cloned().unwrap_or_else(|| serde_json::json!({}));
    let root = v.as_object_mut().ok_or("bad Local State")?;
    let profile = root.entry("profile").or_insert_with(|| serde_json::json!({}));
    let p = profile.as_object_mut().ok_or("bad Local State")?;
    p.insert("info_cache".into(), serde_json::json!({ "Default": entry }));
    p.insert("last_used".into(), "Default".into());
    p.insert("last_active_profiles".into(), serde_json::json!(["Default"]));
    p.insert("profiles_order".into(), serde_json::json!(["Default"]));
    p.remove("profiles_created");
    serde_json::to_string(&v).map_err(|e| e.to_string())
}

/// Caches and runtime files that aren't worth copying (or must not be).
const SKIP: &[&str] = &[
    "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache", "ShaderCache",
    "GraphiteDawnCache", "Crashpad", "SingletonLock", "SingletonSocket", "SingletonCookie", "RunningChromeVersion", "LOCK.tmp",
];

fn copy_tree(src: &Path, dst: &Path, stats: &mut (u64, u64)) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if SKIP.iter().any(|s| name.to_string_lossy() == *s) {
            continue;
        }
        let ft = entry.file_type()?; // does not follow symlinks
        let to = dst.join(&name);
        if ft.is_dir() {
            copy_tree(&entry.path(), &to, stats)?;
        } else if ft.is_file() {
            stats.0 += std::fs::copy(entry.path(), &to)?;
            stats.1 += 1;
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    backup: Option<String>,
    bytes: u64,
    files: u64,
}

pub fn import(user_data_dir: &str, profile: &str) -> Result<ImportResult, String> {
    if !valid_profile_dir(profile) {
        return Err("invalid profile".into());
    }
    // Only from a known browser location (never an arbitrary path).
    let source = list_sources().into_iter().find(|s| s.supported && s.user_data_dir == user_data_dir).ok_or("unknown source browser")?;
    if !source.profiles.iter().any(|p| p.dir == profile) {
        return Err("profile not found".into());
    }
    let src_root = PathBuf::from(&source.user_data_dir);
    let dest = managed_dir();
    if profile_in_use(&dest) {
        return Err("Quit the tCon Chrome profile first; its files can't be replaced while it runs.".into());
    }
    let mut backup = None;
    if dest.exists() && std::fs::read_dir(&dest).map(|mut d| d.next().is_some()).unwrap_or(false) {
        let b = dest.with_file_name(format!("chrome-profile.backup-{}", chrono::Local::now().format("%Y%m%d-%H%M%S")));
        std::fs::rename(&dest, &b).map_err(|e| format!("couldn't back up the current profile: {e}"))?;
        backup = Some(b.to_string_lossy().into_owned());
    }
    let mut stats = (0u64, 0u64);
    let res = (|| -> Result<(), String> {
        copy_tree(&src_root.join(profile), &dest.join("Default"), &mut stats).map_err(|e| format!("copy failed: {e}"))?;
        if let Ok(ls) = std::fs::read_to_string(src_root.join("Local State")) {
            std::fs::write(dest.join("Local State"), patch_local_state(&ls, profile)?).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if let Err(err) = res {
        // roll back to the previous profile
        let _ = std::fs::remove_dir_all(&dest);
        if let Some(b) = &backup {
            let _ = std::fs::rename(b, &dest);
        }
        return Err(err);
    }
    let _ = super::chrome::mirror_native_hosts(&dest);
    Ok(ImportResult { backup, bytes: stats.0, files: stats.1 })
}

#[tauri::command]
pub async fn browser_import_sources() -> Result<Vec<ImportSource>, String> {
    tauri::async_runtime::spawn_blocking(list_sources).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_import(user_data_dir: String, profile: String) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || import(&user_data_dir, &profile)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCAL_STATE: &str = r#"{
      "os_crypt": {"encrypted_key": "abc"},
      "profile": {
        "last_used": "Profile 2",
        "info_cache": {
          "Profile 10": {"name": "Ten"},
          "Profile 2": {"name": "Work", "user_name": "me@work.com", "gaia_name": "Me"},
          "Default": {"name": "", "gaia_name": "Personal"},
          "../evil": {"name": "x"}
        }
      }
    }"#;

    #[test]
    fn parses_profiles() {
        let p = parse_local_state_profiles(LOCAL_STATE);
        assert_eq!(
            p,
            vec![
                ProfileInfo { dir: "Default".into(), name: "Personal".into(), user: None },
                ProfileInfo { dir: "Profile 2".into(), name: "Work".into(), user: Some("me@work.com".into()) },
                ProfileInfo { dir: "Profile 10".into(), name: "Ten".into(), user: None },
            ]
        );
        assert!(parse_local_state_profiles("not json").is_empty());
        assert!(parse_local_state_profiles("{}").is_empty());
    }

    #[test]
    fn patches_local_state() {
        let out: serde_json::Value = serde_json::from_str(&patch_local_state(LOCAL_STATE, "Profile 2").unwrap()).unwrap();
        assert_eq!(out["profile"]["last_used"], "Default");
        assert_eq!(out["profile"]["info_cache"]["Default"]["name"], "Work");
        assert_eq!(out["profile"]["info_cache"].as_object().unwrap().len(), 1);
        assert_eq!(out["os_crypt"]["encrypted_key"], "abc"); // Windows/Linux cookie key must survive
    }

    #[test]
    fn copies_without_caches() {
        let base = std::env::temp_dir().join(format!("tcon-import-{}", std::process::id()));
        let src = base.join("src");
        std::fs::create_dir_all(src.join("Cache/Cache_Data")).unwrap();
        std::fs::create_dir_all(src.join("Local Storage/leveldb")).unwrap();
        std::fs::write(src.join("Cookies"), b"cookies").unwrap();
        std::fs::write(src.join("Cache/Cache_Data/x"), b"big").unwrap();
        std::fs::write(src.join("Local Storage/leveldb/000003.log"), b"ls").unwrap();
        let mut stats = (0, 0);
        copy_tree(&src, &base.join("dst"), &mut stats).unwrap();
        assert!(base.join("dst/Cookies").is_file());
        assert!(base.join("dst/Local Storage/leveldb/000003.log").is_file());
        assert!(!base.join("dst/Cache").exists());
        assert_eq!(stats, (9, 2));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn profile_dir_validation() {
        assert!(valid_profile_dir("Profile 3"));
        assert!(!valid_profile_dir("../x"));
        assert!(!valid_profile_dir(".."));
        assert!(!valid_profile_dir(""));
    }
}
