//! File system: listing, reading/writing text, project dir creation, watching.
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::Emitter;

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry { pub name: String, pub path: String, pub is_dir: bool, pub is_symlink: bool, pub size: u64, pub modified: i64 }

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileContent { pub content: String, pub is_binary: bool, pub too_large: bool, pub size: u64 }

/// Payload of the "fs-changed" event.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FsChanged { pub root: String, pub paths: Vec<String>, pub git: bool }

struct WatchEntry {
    _watcher: RecommendedWatcher,
    refs: usize,
}

/// Active recursive watchers keyed by root path, ref-counted.
#[derive(Default)]
pub struct Watchers {
    inner: Mutex<HashMap<String, WatchEntry>>,
}

const MAX_READ_BYTES: u64 = 5 * 1024 * 1024;
const BINARY_SNIFF: usize = 8 * 1024;
const DEBOUNCE: Duration = Duration::from_millis(250);
const MAX_EVENT_PATHS: usize = 500;

fn e2s(e: impl std::fmt::Display) -> String { e.to_string() }

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(e2s)?
}

fn mtime_ms(m: &fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------- list ----------

pub(crate) fn list_dir_sync(path: &str, show_hidden: bool) -> Result<Vec<FsEntry>, String> {
    let mut out = Vec::new();
    for ent in fs::read_dir(path).map_err(e2s)? {
        let Ok(ent) = ent else { continue };
        let name = ent.file_name().to_string_lossy().into_owned();
        if name == ".git" || name == ".DS_Store" { continue; }
        if !show_hidden && name.starts_with('.') { continue; }
        let p = ent.path();
        let Ok(lmeta) = fs::symlink_metadata(&p) else { continue };
        let is_symlink = lmeta.file_type().is_symlink();
        // For symlinks, report the target's kind/size when resolvable.
        let meta = if is_symlink { fs::metadata(&p).unwrap_or(lmeta) } else { lmeta };
        out.push(FsEntry {
            name,
            path: p.to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            is_symlink,
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified: mtime_ms(&meta),
        });
    }
    sort_entries(&mut out);
    Ok(out)
}

fn sort_entries(v: &mut [FsEntry]) {
    v.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

// ---------- read / write ----------

pub(crate) fn read_text_sync(path: &str) -> Result<FileContent, String> {
    let meta = fs::metadata(path).map_err(e2s)?;
    if meta.is_dir() { return Err(format!("{path} is a directory")); }
    let size = meta.len();
    if size > MAX_READ_BYTES {
        return Ok(FileContent { content: String::new(), is_binary: false, too_large: true, size });
    }
    let mut buf = Vec::with_capacity(size as usize);
    fs::File::open(path).map_err(e2s)?.read_to_end(&mut buf).map_err(e2s)?;
    let sniff = &buf[..buf.len().min(BINARY_SNIFF)];
    if sniff.contains(&0) {
        return Ok(FileContent { content: String::new(), is_binary: true, too_large: false, size });
    }
    Ok(FileContent { content: String::from_utf8_lossy(&buf).into_owned(), is_binary: false, too_large: false, size })
}

pub(crate) fn write_text_sync(path: &str, content: &str) -> Result<(), String> {
    // Write through symlinks to the real file so the link itself is preserved.
    let target: PathBuf = fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let dir = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let fname = target.file_name().ok_or("invalid file path")?.to_string_lossy().into_owned();
    let nanos = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = dir.join(format!(".{fname}.tcon-tmp-{}-{nanos}", std::process::id()));
    let res = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
        drop(f);
        if let Ok(m) = fs::metadata(&target) {
            fs::set_permissions(&tmp, m.permissions())?;
        }
        fs::rename(&tmp, &target)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res.map_err(e2s)
}

pub(crate) fn create_project_dir_sync(path: &str, git_init: bool) -> Result<(), String> {
    fs::create_dir_all(path).map_err(e2s)?;
    if git_init && git2::Repository::open(path).is_err() {
        git2::Repository::init(path).map_err(e2s)?;
    }
    Ok(())
}

// ---------- watch ----------

/// Classify a changed absolute path relative to `root`.
/// Returns (include_in_paths, is_git_change).
fn classify(root: &Path, p: &Path) -> (bool, bool) {
    let Ok(rel) = p.strip_prefix(root) else { return (true, false) };
    let comps: Vec<&std::ffi::OsStr> = rel
        .components()
        .filter_map(|c| match c { Component::Normal(s) => Some(s), _ => None })
        .collect();
    if comps.first().map(|c| *c == ".git").unwrap_or(false) {
        let git = match comps.get(1).and_then(|s| s.to_str()) {
            None => false,
            Some("objects") | Some("logs") => false,
            Some(_) => !comps
                .last()
                .and_then(|s| s.to_str())
                .map(|s| s.ends_with(".lock"))
                .unwrap_or(false),
        };
        return (false, git);
    }
    let excluded = comps.iter().any(|c| *c == "node_modules" || *c == "target" || *c == ".git");
    (!excluded, false)
}

/// Debounce loop: blocks until the channel closes (i.e. the watcher is dropped).
fn debounce_loop(
    rx: mpsc::Receiver<notify::Result<notify::Event>>,
    root_key: String,
    canon_root: PathBuf,
    orig_root: PathBuf,
    emit: impl Fn(FsChanged),
) {
    loop {
        let first = match rx.recv() { Ok(ev) => ev, Err(_) => return };
        let mut paths: Vec<String> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut git = false;
        // Set when the OS dropped events (FSEvents/inotify overflow) or the batch is too large:
        // listeners then get an empty `paths` list, which means "rescan everything".
        let mut rescan = false;
        let mut handle = |ev: notify::Result<notify::Event>| {
            let Ok(ev) = ev else { rescan = true; return };
            if ev.need_rescan() { rescan = true; }
            for p in ev.paths {
                // Map canonical prefix (e.g. /private/var) back to the root the caller used.
                let p = match p.strip_prefix(&canon_root) {
                    Ok(rel) => orig_root.join(rel),
                    Err(_) => p,
                };
                let (include, g) = classify(&orig_root, &p);
                git |= g;
                if include {
                    if paths.len() >= MAX_EVENT_PATHS { rescan = true; continue; }
                    let s = p.to_string_lossy().into_owned();
                    if seen.insert(s.clone()) { paths.push(s); }
                }
            }
        };
        handle(first);
        let deadline = Instant::now() + DEBOUNCE;
        let mut closed = false;
        loop {
            let now = Instant::now();
            if now >= deadline { break; }
            match rx.recv_timeout(deadline - now) {
                Ok(ev) => handle(ev),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => { closed = true; break; }
            }
        }
        if rescan {
            emit(FsChanged { root: root_key.clone(), paths: Vec::new(), git: true });
        } else if !paths.is_empty() || git {
            emit(FsChanged { root: root_key.clone(), paths, git });
        }
        if closed { return; }
    }
}

fn normalize_root(root: &str) -> String {
    let t = root.trim_end_matches('/');
    if t.is_empty() { "/".into() } else { t.to_string() }
}

impl Watchers {
    /// Start (or ref-count) a watch on `root`; `emit` receives debounced change batches.
    pub fn watch_with(&self, root: &str, emit: impl Fn(FsChanged) + Send + 'static) -> Result<(), String> {
        let key = normalize_root(root);
        let mut map = self.inner.lock();
        if let Some(e) = map.get_mut(&key) {
            e.refs += 1;
            return Ok(());
        }
        let orig = PathBuf::from(&key);
        let canon = fs::canonicalize(&orig).map_err(e2s)?;
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(tx).map_err(e2s)?;
        watcher.watch(&canon, RecursiveMode::Recursive).map_err(e2s)?;
        let key2 = key.clone();
        std::thread::Builder::new()
            .name(format!("fs-watch:{key}"))
            .spawn(move || debounce_loop(rx, key2, canon, orig, emit))
            .map_err(e2s)?;
        map.insert(key, WatchEntry { _watcher: watcher, refs: 1 });
        Ok(())
    }

    /// Decrement the ref count; drops the watcher (ending its thread) at zero.
    pub fn unwatch(&self, root: &str) {
        let key = normalize_root(root);
        let mut map = self.inner.lock();
        if let Some(e) = map.get_mut(&key) {
            e.refs = e.refs.saturating_sub(1);
            if e.refs == 0 {
                map.remove(&key);
            }
        }
    }
}

// ---------- commands ----------

#[tauri::command]
pub async fn fs_list_dir(path: String, show_hidden: bool) -> Result<Vec<FsEntry>, String> {
    crate::security::check_fs_access(&path)?;
    blocking(move || list_dir_sync(&path, show_hidden)).await
}
#[tauri::command]
pub async fn fs_read_text(path: String) -> Result<FileContent, String> {
    crate::security::check_fs_access(&path)?;
    blocking(move || read_text_sync(&path)).await
}
#[tauri::command]
pub async fn fs_write_text(path: String, content: String) -> Result<(), String> {
    crate::security::check_fs_access(&path)?;
    blocking(move || write_text_sync(&path, &content)).await
}
#[tauri::command]
pub async fn fs_create_project_dir(path: String, git_init: bool) -> Result<(), String> {
    crate::security::check_fs_access(&path)?;
    blocking(move || create_project_dir_sync(&path, git_init)).await
}
#[tauri::command]
pub fn fs_watch(app: tauri::AppHandle, state: tauri::State<'_, Watchers>, root: String) -> Result<(), String> {
    crate::security::check_fs_access(&root)?;
    state.watch_with(&root, move |payload| {
        let _ = app.emit("fs-changed", payload);
    })
}
#[tauri::command]
pub fn fs_unwatch(state: tauri::State<'_, Watchers>, root: String) -> Result<(), String> {
    state.unwatch(&root);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "tcon-fs-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn list_sorting_and_hidden() {
        let d = tmpdir("list");
        fs::create_dir(d.join("zdir")).unwrap();
        fs::create_dir(d.join("Adir")).unwrap();
        fs::create_dir(d.join(".git")).unwrap();
        fs::write(d.join("b.txt"), "x").unwrap();
        fs::write(d.join("A.txt"), "x").unwrap();
        fs::write(d.join(".env"), "x").unwrap();
        fs::write(d.join(".DS_Store"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(d.join("zdir"), d.join("link")).unwrap();

        let p = d.to_str().unwrap();
        let names: Vec<String> = list_dir_sync(p, false).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["Adir", "link", "zdir", "A.txt", "b.txt"]);
        let all = list_dir_sync(p, true).unwrap();
        let names: Vec<&str> = all.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&".env"));
        assert!(!names.contains(&".git") && !names.contains(&".DS_Store"));
        let link = all.iter().find(|e| e.name == "link").unwrap();
        assert!(link.is_symlink && link.is_dir);
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn read_write_roundtrip_and_binary() {
        let d = tmpdir("rw");
        let f = d.join("f.txt");
        let fp = f.to_str().unwrap();
        write_text_sync(fp, "héllo\n").unwrap();
        write_text_sync(fp, "héllo again\n").unwrap();
        let c = read_text_sync(fp).unwrap();
        assert_eq!(c.content, "héllo again\n");
        assert!(!c.is_binary && !c.too_large);
        // No temp files left behind.
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1);

        let b = d.join("b.bin");
        fs::write(&b, [1u8, 0, 2, 3]).unwrap();
        assert!(read_text_sync(b.to_str().unwrap()).unwrap().is_binary);
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn create_project_with_git() {
        let d = tmpdir("proj").join("a/b");
        create_project_dir_sync(d.to_str().unwrap(), true).unwrap();
        assert!(d.join(".git").is_dir());
        create_project_dir_sync(d.to_str().unwrap(), true).unwrap();
    }

    #[test]
    fn classify_paths() {
        let r = Path::new("/p");
        assert_eq!(classify(r, Path::new("/p/src/a.rs")), (true, false));
        assert_eq!(classify(r, Path::new("/p/node_modules/x/y.js")), (false, false));
        assert_eq!(classify(r, Path::new("/p/src-tauri/target/debug/x")), (false, false));
        assert_eq!(classify(r, Path::new("/p/.git/HEAD")), (false, true));
        assert_eq!(classify(r, Path::new("/p/.git/index")), (false, true));
        assert_eq!(classify(r, Path::new("/p/.git/refs/heads/main")), (false, true));
        assert_eq!(classify(r, Path::new("/p/.git/objects/ab/cdef")), (false, false));
        assert_eq!(classify(r, Path::new("/p/.git/index.lock")), (false, false));
    }

    #[test]
    fn watch_emits_debounced_events_and_refcounts() {
        let d = tmpdir("watch");
        let w = Watchers::default();
        let (tx, rx) = mpsc::channel::<FsChanged>();
        let tx2 = tx.clone();
        w.watch_with(d.to_str().unwrap(), move |e| { let _ = tx.send(e); }).unwrap();
        w.watch_with(d.to_str().unwrap(), move |e| { let _ = tx2.send(e); }).unwrap();
        assert_eq!(w.inner.lock().get(&normalize_root(d.to_str().unwrap())).unwrap().refs, 2);
        std::thread::sleep(Duration::from_millis(200));
        fs::write(d.join("x.txt"), "1").unwrap();
        fs::create_dir(d.join("node_modules")).unwrap();
        fs::write(d.join("node_modules/y.js"), "1").unwrap();
        let ev = rx.recv_timeout(Duration::from_secs(5)).expect("no fs-changed event");
        assert_eq!(ev.root, normalize_root(d.to_str().unwrap()));
        assert!(ev.paths.iter().any(|p| p.ends_with("x.txt")), "{ev:?}");
        assert!(!ev.paths.iter().any(|p| p.contains("node_modules/")), "{ev:?}");
        w.unwatch(d.to_str().unwrap());
        assert!(!w.inner.lock().is_empty());
        w.unwatch(d.to_str().unwrap());
        assert!(w.inner.lock().is_empty());
        fs::remove_dir_all(d).ok();
    }
}
