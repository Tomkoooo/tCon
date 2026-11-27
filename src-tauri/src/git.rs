//! Git integration via git2.
use std::collections::HashMap;
use std::path::Path;

use git2::{
    BranchType, DiffFormat, DiffOptions, Oid, Repository, Sort, Status, StatusOptions,
};
use serde::Serialize;

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus { pub path: String, pub index: String, pub worktree: String }

#[derive(Serialize, Default, Debug)]
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
    /// e.g. "origin/main"; None when the branch isn't tracking anything
    pub upstream: Option<String>,
    pub has_remote: bool,
    pub stash_count: usize,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit { pub id: String, pub short_id: String, pub summary: String, pub author: String, pub time: i64, pub parents: Vec<String>, pub refs: Vec<String> }

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch { pub name: String, pub is_remote: bool, pub is_head: bool, pub upstream: Option<String>, pub target: String }

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree { pub name: String, pub path: String, pub branch: Option<String>, pub is_main: bool }

const MAX_STATUS_FILES: usize = 2000;
const MAX_DIFF_BYTES: usize = 1024 * 1024;

fn e2s(e: impl std::fmt::Display) -> String { e.to_string() }

fn short(oid: Oid) -> String {
    let s = oid.to_string();
    s[..7.min(s.len())].to_string()
}

fn open(path: &str) -> Option<Repository> { Repository::discover(path).ok() }

fn workdir_str(repo: &Repository) -> Option<String> {
    repo.workdir().map(|p| p.to_string_lossy().trim_end_matches('/').to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(e2s)?
}

// ---------- status ----------

fn index_code(s: Status) -> &'static str {
    if s.contains(Status::INDEX_NEW) { "A" }
    else if s.contains(Status::INDEX_MODIFIED) { "M" }
    else if s.contains(Status::INDEX_DELETED) { "D" }
    else if s.contains(Status::INDEX_RENAMED) { "R" }
    else if s.contains(Status::INDEX_TYPECHANGE) { "T" }
    else { " " }
}

fn worktree_code(s: Status) -> &'static str {
    if s.contains(Status::WT_NEW) { "?" }
    else if s.contains(Status::WT_MODIFIED) { "M" }
    else if s.contains(Status::WT_DELETED) { "D" }
    else if s.contains(Status::WT_RENAMED) { "R" }
    else if s.contains(Status::WT_TYPECHANGE) { "T" }
    else { " " }
}

pub(crate) fn status_sync(path: &str) -> Result<GitStatus, String> {
    let Some(repo) = open(path) else { return Ok(GitStatus::default()) };
    let mut st = GitStatus { is_repo: true, root: workdir_str(&repo), ..Default::default() };
    st.has_remote = repo.remotes().map(|r| !r.is_empty()).unwrap_or(false);
    st.stash_count = repo.reflog("refs/stash").map(|r| r.len()).unwrap_or(0);

    if let Ok(head) = repo.head() {
        if let Some(oid) = head.target() {
            st.head = Some(short(oid));
        }
        if head.is_branch() {
            st.branch = head.shorthand().ok().map(|s| s.to_string());
            if let (Some(local), Some(name)) = (head.target(), head.name().ok()) {
                if let Ok(up_name) = repo.branch_upstream_name(name) {
                    if let Ok(up_name) = up_name.as_str() {
                        st.upstream = Some(up_name.trim_start_matches("refs/remotes/").to_string());
                        if let Ok(up_oid) = repo.refname_to_id(up_name) {
                            if let Ok((a, b)) = repo.graph_ahead_behind(local, up_oid) {
                                st.ahead = a;
                                st.behind = b;
                            }
                        }
                    }
                }
            }
        }
    } else if let Ok(r) = repo.find_reference("HEAD") {
        // Unborn branch: HEAD points at a ref that doesn't exist yet.
        if let Some(t) = r.symbolic_target().ok().flatten() {
            st.branch = Some(t.trim_start_matches("refs/heads/").to_string());
        }
    }

    if repo.is_bare() {
        return Ok(st);
    }
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(false)
        .include_ignored(false)
        .exclude_submodules(true)
        .renames_head_to_index(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(e2s)?;
    for entry in statuses.iter() {
        if st.files.len() >= MAX_STATUS_FILES { break; }
        let s = entry.status();
        if s.contains(Status::IGNORED) || s.is_empty() { continue; }
        let p = entry
            .path()
            .ok()
            .map(|s| s.to_string())
            .unwrap_or_else(|| String::from_utf8_lossy(entry.path_bytes()).into_owned());
        let (index, worktree) = if s.contains(Status::CONFLICTED) {
            ("U", "U")
        } else {
            (index_code(s), worktree_code(s))
        };
        if index == " " && worktree == " " { continue; }
        st.files.push(GitFileStatus { path: p, index: index.into(), worktree: worktree.into() });
    }
    st.dirty = !st.files.is_empty();
    Ok(st)
}

// ---------- log ----------

fn ref_map(repo: &Repository) -> HashMap<Oid, Vec<String>> {
    let mut map: HashMap<Oid, Vec<String>> = HashMap::new();
    if let Ok(head) = repo.head() {
        if let Some(oid) = head.target() {
            map.entry(oid).or_default().push("HEAD".into());
        }
    }
    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            let Ok(name) = r.name() else { continue };
            if !(name.starts_with("refs/heads/") || name.starts_with("refs/remotes/") || name.starts_with("refs/tags/")) {
                continue;
            }
            if r.symbolic_target().ok().flatten().is_some() { continue; } // e.g. origin/HEAD
            // Peel (annotated tags → commit).
            let oid = match r.peel_to_commit() {
                Ok(c) => c.id(),
                Err(_) => match r.target() { Some(o) => o, None => continue },
            };
            let sh = r.shorthand().ok().map(|s| s.to_string()).unwrap_or_else(|| name.to_string());
            map.entry(oid).or_default().push(sh);
        }
    }
    map
}

pub(crate) fn log_sync(path: &str, limit: usize) -> Result<Vec<GitCommit>, String> {
    let Some(repo) = open(path) else { return Ok(vec![]) };
    let refs = ref_map(&repo);
    let mut walk = repo.revwalk().map_err(e2s)?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(e2s)?;
    let _ = walk.push_head();
    let _ = walk.push_glob("refs/heads");
    let _ = walk.push_glob("refs/remotes");
    let mut out = Vec::new();
    for oid in walk {
        if out.len() >= limit { break; }
        let Ok(oid) = oid else { continue };
        let Ok(c) = repo.find_commit(oid) else { continue };
        out.push(GitCommit {
            id: oid.to_string(),
            short_id: short(oid),
            summary: c.summary().ok().flatten().map(|s| s.to_string())
                .unwrap_or_else(|| c.summary_bytes().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default()),
            author: c.author().name().ok().map(|s| s.to_string()).unwrap_or_default(),
            time: c.time().seconds() * 1000,
            parents: c.parent_ids().map(|p| p.to_string()).collect(),
            refs: refs.get(&oid).cloned().unwrap_or_default(),
        });
    }
    Ok(out)
}

// ---------- branches ----------

pub(crate) fn branches_sync(path: &str) -> Result<Vec<GitBranch>, String> {
    let Some(repo) = open(path) else { return Ok(vec![]) };
    let mut out = Vec::new();
    for item in repo.branches(None).map_err(e2s)? {
        let Ok((b, kind)) = item else { continue };
        let r = b.get();
        if r.symbolic_target().ok().flatten().is_some() { continue; }
        let Some(name) = b.name().ok().flatten().map(|s| s.to_string()) else { continue };
        if kind == BranchType::Remote && name.ends_with("/HEAD") { continue; }
        let target = r.target().map(short).unwrap_or_default();
        let upstream = if kind == BranchType::Local {
            b.upstream().ok().and_then(|u| u.name().ok().flatten().map(|s| s.to_string()))
        } else {
            None
        };
        out.push(GitBranch {
            name,
            is_remote: kind == BranchType::Remote,
            is_head: b.is_head(),
            upstream,
            target,
        });
    }
    out.sort_by(|a, b| a.is_remote.cmp(&b.is_remote).then(b.is_head.cmp(&a.is_head)).then(a.name.cmp(&b.name)));
    Ok(out)
}

// ---------- worktrees ----------

fn head_shorthand(repo: &Repository) -> Option<String> {
    match repo.head() {
        Ok(h) if h.is_branch() => h.shorthand().ok().map(|s| s.to_string()),
        Ok(h) => h.target().map(short),
        Err(_) => repo
            .find_reference("HEAD")
            .ok()
            .and_then(|r| r.symbolic_target().ok().flatten().map(|t| t.trim_start_matches("refs/heads/").to_string())),
    }
}

pub(crate) fn worktrees_sync(path: &str) -> Result<Vec<GitWorktree>, String> {
    let Some(repo) = open(path) else { return Ok(vec![]) };
    // If we discovered a linked worktree, switch to the main repository.
    let main = if repo.is_worktree() {
        Repository::open(repo.commondir()).map_err(e2s)?
    } else {
        repo
    };
    let mut out = Vec::new();
    let main_path = workdir_str(&main)
        .unwrap_or_else(|| main.path().to_string_lossy().trim_end_matches('/').to_string());
    let main_name = Path::new(&main_path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| main_path.clone());
    out.push(GitWorktree { name: main_name, path: main_path, branch: head_shorthand(&main), is_main: true });

    if let Ok(names) = main.worktrees() {
        for name in names.iter().flatten().flatten() {
            let Ok(wt) = main.find_worktree(name) else { continue };
            let wpath = wt.path().to_string_lossy().trim_end_matches('/').to_string();
            let branch = Repository::open_from_worktree(&wt).ok().and_then(|r| head_shorthand(&r));
            out.push(GitWorktree { name: name.to_string(), path: wpath, branch, is_main: false });
        }
    }
    Ok(out)
}

// ---------- diff ----------

fn rel_pathspec(repo: &Repository, file: &str) -> String {
    if let Some(wd) = repo.workdir() {
        let p = Path::new(file);
        if p.is_absolute() {
            if let Ok(rel) = p.strip_prefix(wd) {
                return rel.to_string_lossy().into_owned();
            }
            // Handle symlinked prefixes like /var → /private/var on macOS.
            if let (Ok(cp), Ok(cwd)) = (p.canonicalize(), wd.canonicalize()) {
                if let Ok(rel) = cp.strip_prefix(&cwd) {
                    return rel.to_string_lossy().into_owned();
                }
            }
        }
    }
    file.to_string()
}

pub(crate) fn diff_sync(path: &str, file: Option<&str>, staged: bool) -> Result<String, String> {
    let Some(repo) = open(path) else { return Ok(String::new()) };
    let mut opts = DiffOptions::new();
    if let Some(f) = file {
        opts.pathspec(rel_pathspec(&repo, f)).disable_pathspec_match(true);
    }
    let diff = if staged {
        let tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        let index = repo.index().map_err(e2s)?;
        repo.diff_tree_to_index(tree.as_ref(), Some(&index), Some(&mut opts)).map_err(e2s)?
    } else {
        opts.include_untracked(true).show_untracked_content(true).recurse_untracked_dirs(true);
        repo.diff_index_to_workdir(None, Some(&mut opts)).map_err(e2s)?
    };
    let mut buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    let res = diff.print(DiffFormat::Patch, |_d, _h, line| {
        if buf.len() >= MAX_DIFF_BYTES {
            truncated = true;
            return false;
        }
        match line.origin() {
            '+' | '-' | ' ' => buf.push(line.origin() as u8),
            _ => {}
        }
        buf.extend_from_slice(line.content());
        true
    });
    if let Err(e) = res {
        if !truncated { return Err(e2s(e)); }
    }
    let mut s = String::from_utf8_lossy(&buf).into_owned();
    if truncated {
        s.push_str("\n… diff truncated (exceeds 1 MB) …\n");
    }
    Ok(s)
}

// ---------- commands ----------

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatus, String> {
    blocking(move || status_sync(&path)).await
}
#[tauri::command]
pub async fn git_log(path: String, limit: usize) -> Result<Vec<GitCommit>, String> {
    blocking(move || log_sync(&path, limit)).await
}
#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<GitBranch>, String> {
    blocking(move || branches_sync(&path)).await
}
#[tauri::command]
pub async fn git_worktrees(path: String) -> Result<Vec<GitWorktree>, String> {
    blocking(move || worktrees_sync(&path)).await
}
#[tauri::command]
pub async fn git_diff(path: String, file: Option<String>, staged: bool) -> Result<String, String> {
    blocking(move || diff_sync(&path, file.as_deref(), staged)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "tcon-git-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn commit_all(repo: &Repository, msg: &str) -> Oid {
        let mut idx = repo.index().unwrap();
        idx.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
        idx.write().unwrap();
        let tree_id = idx.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = git2::Signature::now("Tester", "t@example.com").unwrap();
        let parents: Vec<git2::Commit> = repo.head().ok().and_then(|h| h.peel_to_commit().ok()).into_iter().collect();
        let prefs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &prefs).unwrap()
    }

    #[test]
    fn non_repo_is_not_error() {
        let d = tmpdir("norepo");
        let st = status_sync(d.to_str().unwrap()).unwrap();
        assert!(!st.is_repo);
        assert!(log_sync(d.to_str().unwrap(), 10).unwrap().is_empty());
        assert!(worktrees_sync(d.to_str().unwrap()).unwrap().is_empty());
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn status_log_branches_diff() {
        let d = tmpdir("repo");
        let repo = Repository::init(&d).unwrap();
        fs::write(d.join("a.txt"), "hello\n").unwrap();
        let c1 = commit_all(&repo, "first");
        fs::write(d.join("a.txt"), "hello\nworld\n").unwrap();
        fs::write(d.join("b.txt"), "new\n").unwrap();
        let c2 = commit_all(&repo, "second");
        repo.tag_lightweight("v1", &repo.find_object(c1, None).unwrap(), false).unwrap();

        // Clean.
        let p = d.to_str().unwrap();
        let st = status_sync(p).unwrap();
        assert!(st.is_repo);
        assert!(!st.dirty);
        assert_eq!(st.head.as_deref(), Some(&c2.to_string()[..7]));
        assert!(st.branch.is_some());

        // Dirty: modified + untracked + staged.
        fs::write(d.join("a.txt"), "changed\n").unwrap();
        fs::write(d.join("c.txt"), "untracked\n").unwrap();
        fs::write(d.join("b.txt"), "staged\n").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(Path::new("b.txt")).unwrap();
        idx.write().unwrap();
        let st = status_sync(p).unwrap();
        assert!(st.dirty);
        let get = |n: &str| st.files.iter().find(|f| f.path == n).unwrap();
        assert_eq!((get("a.txt").index.as_str(), get("a.txt").worktree.as_str()), (" ", "M"));
        assert_eq!((get("b.txt").index.as_str(), get("b.txt").worktree.as_str()), ("M", " "));
        assert_eq!(get("c.txt").worktree, "?");

        let log = log_sync(p, 10).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].id, c2.to_string());
        assert_eq!(log[0].summary, "second");
        assert_eq!(log[0].parents, vec![c1.to_string()]);
        assert!(log[0].refs.contains(&"HEAD".to_string()));
        assert!(log[1].refs.contains(&"v1".to_string()));
        assert_eq!(log_sync(p, 1).unwrap().len(), 1);

        let br = branches_sync(p).unwrap();
        assert_eq!(br.len(), 1);
        assert!(br[0].is_head);

        let unstaged = diff_sync(p, None, false).unwrap();
        assert!(unstaged.contains("+changed"));
        assert!(unstaged.contains("c.txt"));
        let abs = d.join("a.txt");
        let one = diff_sync(p, Some(abs.to_str().unwrap()), false).unwrap();
        assert!(one.contains("a.txt") && !one.contains("c.txt"));
        let staged = diff_sync(p, None, true).unwrap();
        assert!(staged.contains("+staged") && !staged.contains("+changed"));

        let wts = worktrees_sync(p).unwrap();
        assert_eq!(wts.len(), 1);
        assert!(wts[0].is_main);
        fs::remove_dir_all(d).ok();
    }
}
