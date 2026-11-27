//! Project-wide file listing (quick open, ⌘P) and text search (⇧⌘F). Both use git so
//! `.gitignore` is respected; `git grep --no-index` also covers folders that aren't repos.
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::cli::git;

const MAX_FILES: usize = 50_000;
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next", ".tcon", ".venv", "__pycache__"];

fn is_repo(root: &str) -> bool {
    git(root, &["rev-parse", "--is-inside-work-tree"]).is_ok_and(|s| s.trim() == "true")
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for ent in rd.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let name = ent.file_name().to_string_lossy().into_owned();
        let Ok(ty) = ent.file_type() else { continue };
        if ty.is_symlink() {
            continue;
        }
        if ty.is_dir() {
            if !SKIP_DIRS.contains(&name.as_str()) {
                walk(root, &ent.path(), out);
            }
        } else if let Ok(rel) = ent.path().strip_prefix(root) {
            out.push(rel.to_string_lossy().into_owned());
        }
    }
}

/// Project files relative to `root`: tracked + untracked-but-not-ignored in a repo, else a
/// bounded walk that skips the usual build / dependency folders.
pub fn list_files(root: &str) -> Result<Vec<String>, String> {
    if is_repo(root) {
        let out = git(root, &["ls-files", "-co", "--exclude-standard", "-z"])?;
        let mut v: Vec<String> = out.split('\0').filter(|s| !s.is_empty()).take(MAX_FILES).map(str::to_string).collect();
        v.sort();
        v.dedup();
        return Ok(v);
    }
    let mut v = Vec::new();
    walk(Path::new(root), Path::new(root), &mut v);
    v.sort();
    Ok(v)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOpts {
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub max_results: usize,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub text: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
}

/// Parse `path\0line\0column\0text` records (`git grep -z -n --column`).
fn parse_grep(out: &str, max: usize) -> (Vec<SearchHit>, bool) {
    let mut hits = Vec::new();
    for rec in out.lines() {
        let mut it = rec.splitn(4, '\0');
        let (Some(path), Some(line), Some(col), Some(text)) = (it.next(), it.next(), it.next(), it.next()) else { continue };
        if hits.len() >= max {
            return (hits, true);
        }
        let text: String = text.trim_end().chars().take(400).collect();
        hits.push(SearchHit { path: path.to_string(), line: line.parse().unwrap_or(1), column: col.parse().unwrap_or(1), text });
    }
    (hits, false)
}

pub fn search(root: &str, query: &str, opts: &SearchOpts) -> Result<SearchResult, String> {
    if query.is_empty() {
        return Ok(SearchResult { hits: vec![], truncated: false });
    }
    let max = if opts.max_results == 0 { 2000 } else { opts.max_results.min(10_000) };
    let mut args: Vec<&str> = vec!["-c", "core.quotepath=off", "grep", "-z", "-n", "--column", "-I", "--full-name", "--max-count=50"];
    let repo = is_repo(root);
    if repo {
        args.push("--untracked");
    } else {
        args.push("--no-index");
    }
    args.push("--exclude-standard");
    args.push(if opts.regex { "-E" } else { "-F" });
    if !opts.case_sensitive {
        args.push("-i");
    }
    if opts.whole_word {
        args.push("-w");
    }
    args.push("-e");
    args.push(query);
    args.push("--");
    let excludes: Vec<String> = SKIP_DIRS.iter().map(|d| format!(":(exclude,glob)**/{d}/**")).collect();
    if !repo {
        args.push(".");
        args.extend(excludes.iter().map(|s| s.as_str()));
    }
    match git(root, &args) {
        Ok(out) => {
            let (hits, truncated) = parse_grep(&out, max);
            Ok(SearchResult { hits, truncated })
        }
        // git grep exits 1 when nothing matched.
        Err(e) if e.trim().is_empty() => Ok(SearchResult { hits: vec![], truncated: false }),
        Err(e) => Err(e),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn project_files(root: String) -> Result<Vec<String>, String> {
    blocking(move || list_files(&root)).await
}

#[tauri::command]
pub async fn project_search(root: String, query: String, opts: SearchOpts) -> Result<SearchResult, String> {
    blocking(move || search(&root, &query, &opts)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tcon-search-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::create_dir_all(d.join("node_modules/x")).unwrap();
        std::fs::write(d.join("src/a.ts"), "const Foo = 1;\nfoo(bar)\n").unwrap();
        std::fs::write(d.join("README.md"), "# Foo bar\n").unwrap();
        std::fs::write(d.join("node_modules/x/i.js"), "foo\n").unwrap();
        d
    }

    #[test]
    fn lists_and_searches_plain_folders() {
        let d = tmp();
        let r = d.to_string_lossy().to_string();
        assert_eq!(list_files(&r).unwrap(), vec!["README.md", "src/a.ts"]);
        let res = search(&r, "foo", &SearchOpts::default()).unwrap();
        let mut got: Vec<(String, u32)> = res.hits.iter().map(|h| (h.path.clone(), h.line)).collect();
        got.sort();
        assert_eq!(got, vec![("README.md".into(), 1), ("src/a.ts".into(), 1), ("src/a.ts".into(), 2)]);
        let res = search(&r, "Foo", &SearchOpts { case_sensitive: true, ..Default::default() }).unwrap();
        assert_eq!(res.hits.len(), 2);
        let h = res.hits.iter().find(|h| h.path == "src/a.ts").unwrap();
        assert_eq!((h.line, h.column, h.text.as_str()), (1, 7, "const Foo = 1;"));
        assert!(search(&r, "nothing-here", &SearchOpts::default()).unwrap().hits.is_empty());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn respects_gitignore_in_repos() {
        let d = tmp();
        let r = d.to_string_lossy().to_string();
        std::process::Command::new("git").args(["init", "-q"]).current_dir(&d).status().unwrap();
        std::fs::write(d.join(".gitignore"), "node_modules/\n").unwrap();
        assert_eq!(list_files(&r).unwrap(), vec![".gitignore", "README.md", "src/a.ts"]);
        let res = search(&r, "foo", &SearchOpts::default()).unwrap();
        assert!(res.hits.iter().all(|h| !h.path.contains("node_modules")));
        assert_eq!(res.hits.len(), 3);
        let _ = std::fs::remove_dir_all(d);
    }
}
