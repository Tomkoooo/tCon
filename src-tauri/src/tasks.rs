//! Per-workspace task board, stored as Claude-friendly files under `<root>/.tcon/`:
//!
//! - `.tcon/tasks/<id>.md`: one Markdown file per task with YAML-style frontmatter.
//! - `.tcon/board.json`: columns, card order and board settings.
//! - `.tcon/PROTOCOL.md`: the agent protocol (same text as the `tcon-tasks` Claude Code skill).
//!
//! Claude edits task files concurrently with the app, so every mutation here is a fresh
//! read-modify-write of one file followed by an atomic replace (temp file + rename).
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::fs::write_text_sync;

/// The task protocol, installed as a Claude Code skill and copied to `.tcon/PROTOCOL.md`.
pub const SKILL_MD: &str = include_str!("../resources/tcon-tasks/SKILL.md");
const SKILL_NAME: &str = "tcon-tasks";
const EXCLUDE_LINE: &str = ".tcon/";
const EXCLUDE_COMMENT: &str = "# tCon task board (local only)";
const AGENT_HEADINGS: [&str; 3] = ["plan", "progress log", "verification"];

/// Serializes the app's own read-modify-write cycles (Claude's edits can still interleave).
static LOCK: Mutex<()> = Mutex::new(());

// ---------------- model ----------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub status: String,
    pub priority: String,
    pub labels: Vec<String>,
    pub created: String,
    pub updated: String,
    pub agent: String,
    pub branch: String,
    pub commits: Vec<String>,
    pub pane_id: String,
    /// Tasks that must reach Review/Done before this one may start (`depends: [T-3]`).
    pub depends: Vec<String>,
    /// Git worktree the agent works in (isolation: worktree), "" = the main checkout.
    pub worktree: String,
    /// Frontmatter keys we don't know, kept verbatim (key, raw value).
    pub extra: Vec<(String, String)>,
    /// Body text before the agent sections.
    pub description: String,
    /// `## Plan` / `## Progress log` / `## Verification` and anything after them.
    pub sections: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub id: String,
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BoardSettings {
    /// Old boolean form of `auto_pickup` (`true` = "ask"); read for migration, never written.
    #[serde(skip_serializing)]
    pub ask_on_todo: Option<bool>,
    /// What happens when a task enters Todo: "off" | "ask" | "auto" (queue and start).
    pub auto_pickup: String,
    /// Where a task joins the run queue: "end" | "front" | "priority".
    pub pickup_position: String,
    /// New Inbox tasks get a planning agent automatically.
    pub inbox_auto_plan: bool,
    /// Concurrent agents per board; the rest are queued.
    pub max_agents: u32,
    /// "rolling" (keep max_agents busy) | "batch" (start batch_size, wait for all) |
    /// "parallel-safe" (start non-conflicting groups by the plans' Files lines).
    pub run_mode: String,
    pub batch_size: u32,
    /// Queue stopped: running agents finish, no new ones start.
    pub paused: bool,
    /// "none" | "worktree": each agent gets its own branch + git worktree.
    pub isolation: String,
    /// Shell command run in a new worktree before the agent starts (e.g. `npm ci`).
    pub worktree_setup: String,
    /// Symlink the main checkout's node_modules into new worktrees.
    pub link_node_modules: bool,
    /// Share `.tcon/` via git (no `.git/info/exclude` entry).
    pub shared: bool,
}

impl Default for BoardSettings {
    fn default() -> Self {
        Self {
            ask_on_todo: None,
            auto_pickup: "off".into(),
            pickup_position: "end".into(),
            inbox_auto_plan: false,
            max_agents: 1,
            run_mode: "rolling".into(),
            batch_size: 2,
            paused: false,
            isolation: "none".into(),
            worktree_setup: String::new(),
            link_node_modules: true,
            shared: false,
        }
    }
}

impl BoardSettings {
    /// Fill in defaults / migrate the old `askOnTodo` flag and clamp numbers.
    fn normalize(mut self) -> Self {
        if let Some(ask) = self.ask_on_todo.take() {
            if ask && (self.auto_pickup.is_empty() || self.auto_pickup == "off") {
                self.auto_pickup = "ask".into();
            }
        }
        let pick = |v: &str, allowed: &[&str]| if allowed.contains(&v) { v.to_string() } else { allowed[0].to_string() };
        self.auto_pickup = pick(&self.auto_pickup, &["off", "ask", "auto"]);
        self.pickup_position = pick(&self.pickup_position, &["end", "front", "priority"]);
        self.run_mode = pick(&self.run_mode, &["rolling", "batch", "parallel-safe"]);
        self.isolation = pick(&self.isolation, &["none", "worktree"]);
        self.max_agents = self.max_agents.clamp(1, 16);
        self.batch_size = self.batch_size.clamp(1, 16);
        self
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Board {
    pub version: u32,
    pub columns: Vec<Column>,
    /// column id → task ids, top to bottom. Tasks missing here are appended by creation time.
    pub order: BTreeMap<String, Vec<String>>,
    pub next_id: u32,
    pub settings: BoardSettings,
    /// Task ids waiting for an agent, in start order.
    pub run_queue: Vec<String>,
    /// Batch run mode: the ids started together in the current batch.
    pub batch: Vec<String>,
}

impl Default for Board {
    fn default() -> Self {
        let col = |id: &str, title: &str| Column { id: id.into(), title: title.into() };
        Self {
            version: 1,
            columns: vec![col("inbox", "Inbox"), col("todo", "Todo"), col("in-progress", "In Progress"), col("review", "Review"), col("done", "Done")],
            order: BTreeMap::new(),
            next_id: 1,
            settings: BoardSettings::default(),
            run_queue: Vec::new(),
            batch: Vec::new(),
        }
    }
}

/// Everything the UI needs to render a board.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BoardState {
    pub board: Board,
    pub tasks: Vec<Task>,
    /// Effective order: every column id → its task ids.
    pub columns: BTreeMap<String, Vec<String>>,
    /// `.tcon/` exists.
    pub initialized: bool,
    /// Tasks whose file couldn't be parsed (path, error).
    pub errors: Vec<(String, String)>,
}

/// Partial update of a task; `None` leaves a field unchanged.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskPatch {
    pub title: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub labels: Option<Vec<String>>,
    pub agent: Option<String>,
    pub branch: Option<String>,
    pub pane_id: Option<String>,
    pub depends: Option<Vec<String>>,
    pub worktree: Option<String>,
    pub description: Option<String>,
    /// Line appended to `## Progress log`.
    pub log: Option<String>,
}

// ---------------- paths / time ----------------

fn tcon_dir(root: &str) -> PathBuf {
    Path::new(root).join(".tcon")
}
fn tasks_dir(root: &str) -> PathBuf {
    tcon_dir(root).join("tasks")
}
fn board_path(root: &str) -> PathBuf {
    tcon_dir(root).join("board.json")
}
fn task_path(root: &str, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("invalid task id: {id}"));
    }
    Ok(tasks_dir(root).join(format!("{id}.md")))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
fn log_line(msg: &str) -> String {
    format!("- {} — {}", chrono::Local::now().format("%Y-%m-%d %H:%M"), msg.trim())
}

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    write_text_sync(&path.to_string_lossy(), content)
}

// ---------------- frontmatter ----------------

fn unquote(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        let inner = &s[1..s.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some(o) => out.push(o),
                    None => out.push('\\'),
                }
            } else {
                out.push(c);
            }
        }
        return out;
    }
    if s.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') {
        return s[1..s.len() - 1].replace("''", "'");
    }
    s.to_string()
}

/// Strip a trailing ` # comment` that isn't inside quotes.
fn strip_comment(s: &str) -> &str {
    let mut quote: Option<char> = None;
    let bytes: Vec<char> = s.chars().collect();
    let mut byte_idx = 0;
    let mut escaped = false;
    for (i, &c) in bytes.iter().enumerate() {
        if escaped {
            escaped = false;
            byte_idx += c.len_utf8();
            continue;
        }
        match quote {
            Some('"') if c == '\\' => escaped = true,
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '#' && (i == 0 || bytes[i - 1].is_whitespace()) => return s[..byte_idx].trim_end(),
            None => {}
        }
        byte_idx += c.len_utf8();
    }
    s
}

/// Split `a, "b, c", d` on commas outside quotes.
fn split_list(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for c in s.chars() {
        if escaped {
            escaped = false;
            cur.push(c);
            continue;
        }
        match quote {
            Some('"') if c == '\\' => {
                escaped = true;
                cur.push(c);
            }
            Some(q) if c == q => {
                quote = None;
                cur.push(c);
            }
            Some(_) => cur.push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                cur.push(c);
            }
            None if c == ',' => {
                out.push(std::mem::take(&mut cur));
            }
            None => cur.push(c),
        }
    }
    out.push(cur);
    out.into_iter().map(|x| unquote(&x)).filter(|x| !x.is_empty()).collect()
}

fn parse_list(raw: &str) -> Vec<String> {
    let t = raw.trim();
    let inner = t.strip_prefix('[').and_then(|x| x.strip_suffix(']')).unwrap_or(t);
    split_list(inner)
}

fn needs_quotes(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let first = s.chars().next().unwrap();
    s != s.trim()
        || s.contains(": ")
        || s.ends_with(':')
        || s.contains(" #")
        || s.contains('\n')
        || s.contains('"')
        || "[]{}&*!|>'%@`#,?-".contains(first)
        || matches!(s.to_ascii_lowercase().as_str(), "true" | "false" | "null" | "yes" | "no" | "~")
}

fn quote(s: &str) -> String {
    if needs_quotes(s) {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n"))
    } else {
        s.to_string()
    }
}

fn fmt_list(v: &[String]) -> String {
    let items: Vec<String> = v
        .iter()
        .map(|x| if x.contains(',') || x.contains('[') || x.contains(']') || needs_quotes(x) { format!("\"{}\"", x.replace('\\', "\\\\").replace('"', "\\\"")) } else { x.clone() })
        .collect();
    format!("[{}]", items.join(", "))
}

/// Map free-form status text to a column id.
pub fn normalize_status(s: &str) -> String {
    let k = s.trim().to_ascii_lowercase().replace(['_', ' '], "-");
    match k.as_str() {
        "" | "backlog" | "new" | "triage" | "inbox" => "inbox",
        "todo" | "to-do" | "ready" | "open" => "todo",
        "in-progress" | "inprogress" | "doing" | "wip" | "started" | "active" | "blocked" => "in-progress",
        "review" | "in-review" | "testing" | "qa" => "review",
        "done" | "closed" | "complete" | "completed" | "resolved" | "fixed" => "done",
        other => return other.to_string(),
    }
    .to_string()
}

fn is_agent_heading(line: &str) -> bool {
    let t = line.trim();
    t.strip_prefix("## ").map(|h| AGENT_HEADINGS.contains(&h.trim().to_ascii_lowercase().as_str())).unwrap_or(false)
}

fn split_body(body: &str) -> (String, String) {
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        if is_agent_heading(line) {
            return (body[..offset].trim().to_string(), body[offset..].trim_end().to_string());
        }
        offset += line.len();
    }
    (body.trim().to_string(), String::new())
}

pub fn parse_task(text: &str, fallback_id: &str) -> Task {
    let text = text.replace("\r\n", "\n");
    let mut t = Task { id: fallback_id.to_string(), ..Default::default() };
    let mut body: &str = &text;
    if let Some(rest) = text.strip_prefix("---\n") {
        // Closing fence: a line that is exactly `---` (or `...`).
        let mut end = None;
        let mut off = 0;
        for line in rest.split_inclusive('\n') {
            let l = line.trim_end();
            if l == "---" || l == "..." {
                end = Some((off, off + line.len()));
                break;
            }
            off += line.len();
        }
        if let Some((fm_end, body_start)) = end {
            let fm = &rest[..fm_end];
            body = &rest[body_start..];
            let lines: Vec<&str> = fm.lines().collect();
            let mut i = 0;
            while i < lines.len() {
                let line = lines[i];
                i += 1;
                if line.trim().is_empty() || line.trim_start().starts_with('#') || line.starts_with(' ') || line.starts_with('-') {
                    continue;
                }
                let Some((k, v)) = line.split_once(':') else { continue };
                let key = k.trim().to_string();
                let mut raw = strip_comment(v).trim().to_string();
                // YAML block list: `key:` followed by `  - item` lines.
                if raw.is_empty() {
                    let mut items = Vec::new();
                    while i < lines.len() && lines[i].trim_start().starts_with("- ") {
                        items.push(lines[i].trim_start()[2..].trim().to_string());
                        i += 1;
                    }
                    if !items.is_empty() {
                        raw = format!("[{}]", items.join(", "));
                    }
                }
                match key.as_str() {
                    "id" => t.id = unquote(&raw),
                    "title" => t.title = unquote(&raw),
                    "status" => t.status = normalize_status(&unquote(&raw)),
                    "priority" => t.priority = unquote(&raw).to_ascii_lowercase(),
                    "labels" | "tags" => t.labels = parse_list(&raw),
                    "created" => t.created = unquote(&raw),
                    "updated" => t.updated = unquote(&raw),
                    "agent" => t.agent = unquote(&raw).to_ascii_lowercase(),
                    "branch" => t.branch = unquote(&raw),
                    "commits" => t.commits = parse_list(&raw),
                    "pane" | "paneId" => t.pane_id = unquote(&raw),
                    "depends" | "dependsOn" => t.depends = parse_list(&raw),
                    "worktree" => t.worktree = unquote(&raw),
                    _ => t.extra.push((key, raw)),
                }
            }
        }
    }
    let (description, sections) = split_body(body);
    t.description = description;
    t.sections = sections;
    if t.title.is_empty() {
        // No frontmatter title: use the first heading / line of the body.
        if let Some(first) = t.description.lines().find(|l| !l.trim().is_empty()) {
            t.title = first.trim_start_matches('#').trim().to_string();
        }
    }
    if t.status.is_empty() {
        t.status = "inbox".into();
    }
    if t.priority.is_empty() {
        t.priority = "none".into();
    }
    if t.agent.is_empty() {
        t.agent = "idle".into();
    }
    t
}

pub fn serialize_task(t: &Task) -> String {
    let mut s = String::from("---\n");
    let kv = |s: &mut String, k: &str, v: &str| {
        s.push_str(k);
        s.push(':');
        if !v.is_empty() {
            s.push(' ');
            s.push_str(v);
        }
        s.push('\n');
    };
    kv(&mut s, "id", &quote(&t.id));
    kv(&mut s, "title", &quote(&t.title));
    kv(&mut s, "status", &quote(&t.status));
    kv(&mut s, "priority", &quote(&t.priority));
    kv(&mut s, "labels", &fmt_list(&t.labels));
    kv(&mut s, "created", &quote(&t.created));
    kv(&mut s, "updated", &quote(&t.updated));
    kv(&mut s, "agent", &quote(&t.agent));
    kv(&mut s, "branch", &quote(&t.branch));
    kv(&mut s, "commits", &fmt_list(&t.commits));
    kv(&mut s, "pane", &quote(&t.pane_id));
    if !t.depends.is_empty() {
        kv(&mut s, "depends", &fmt_list(&t.depends));
    }
    if !t.worktree.is_empty() {
        kv(&mut s, "worktree", &quote(&t.worktree));
    }
    for (k, v) in &t.extra {
        kv(&mut s, k, v);
    }
    s.push_str("---\n\n");
    if !t.description.trim().is_empty() {
        s.push_str(t.description.trim());
        s.push_str("\n\n");
    }
    if !t.sections.trim().is_empty() {
        s.push_str(t.sections.trim_end());
        s.push('\n');
    }
    s
}

fn default_sections(created_msg: &str) -> String {
    format!("## Plan\n\n## Progress log\n{}\n\n## Verification\n", log_line(created_msg))
}

/// Append a line at the end of the `## Progress log` section (creating it if needed).
pub fn append_log(sections: &str, line: &str) -> String {
    let lines: Vec<&str> = sections.lines().collect();
    let start = lines.iter().position(|l| l.trim().eq_ignore_ascii_case("## progress log"));
    match start {
        Some(si) => {
            let end = lines.iter().enumerate().skip(si + 1).find(|(_, l)| l.starts_with("## ")).map(|(i, _)| i).unwrap_or(lines.len());
            // Insert after the last non-blank line of the section.
            let mut at = end;
            while at > si + 1 && lines[at - 1].trim().is_empty() {
                at -= 1;
            }
            let mut out: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
            out.insert(at, line.to_string());
            if at + 1 < out.len() && !out[at + 1].trim().is_empty() {
                out.insert(at + 1, String::new());
            }
            out.join("\n")
        }
        None => {
            let section = format!("## Progress log\n{line}\n");
            match lines.iter().position(|l| l.trim().eq_ignore_ascii_case("## verification")) {
                Some(vi) => {
                    let mut out: Vec<String> = lines[..vi].iter().map(|s| s.to_string()).collect();
                    out.push(section);
                    out.extend(lines[vi..].iter().map(|s| s.to_string()));
                    out.join("\n")
                }
                None if sections.trim().is_empty() => section,
                None => format!("{}\n\n{section}", sections.trim_end()),
            }
        }
    }
}

// ---------------- board ----------------

fn read_board(root: &str) -> Board {
    fs::read_to_string(board_path(root))
        .ok()
        .and_then(|s| serde_json::from_str::<Board>(&s).ok())
        .map(|mut b| {
            if b.columns.is_empty() {
                b.columns = Board::default().columns;
            }
            b.next_id = b.next_id.max(1);
            b.settings = b.settings.normalize();
            b
        })
        .unwrap_or_default()
}

fn write_board(root: &str, b: &Board) -> Result<(), String> {
    let json = serde_json::to_string_pretty(b).map_err(|e| e.to_string())?;
    write_atomic(&board_path(root), &(json + "\n"))
}

/// Column a task is shown in: its status if that's a column, else the first column.
fn column_of(board: &Board, status: &str) -> String {
    if board.columns.iter().any(|c| c.id == status) {
        status.to_string()
    } else {
        board.columns.first().map(|c| c.id.clone()).unwrap_or_default()
    }
}

/// Effective order: stored order filtered to tasks really in that column, then the remaining
/// tasks of each column by creation time.
pub fn reconcile(board: &Board, tasks: &[Task]) -> BTreeMap<String, Vec<String>> {
    let mut out: BTreeMap<String, Vec<String>> = board.columns.iter().map(|c| (c.id.clone(), Vec::new())).collect();
    let col_of: BTreeMap<&str, String> = tasks.iter().map(|t| (t.id.as_str(), column_of(board, &t.status))).collect();
    let mut placed: HashSet<&str> = HashSet::new();
    for c in &board.columns {
        if let Some(ids) = board.order.get(&c.id) {
            for id in ids {
                if col_of.get(id.as_str()) == Some(&c.id) && placed.insert(id.as_str()) {
                    out.get_mut(&c.id).unwrap().push(id.clone());
                }
            }
        }
    }
    let mut rest: Vec<&Task> = tasks.iter().filter(|t| !placed.contains(t.id.as_str())).collect();
    rest.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| id_num(&a.id).cmp(&id_num(&b.id))).then_with(|| a.id.cmp(&b.id)));
    for t in rest {
        if let Some(v) = out.get_mut(&col_of[t.id.as_str()]) {
            v.push(t.id.clone());
        }
    }
    out
}

/// Move `id` to `to_col` at `index` in an effective order map.
pub fn move_in_order(order: &mut BTreeMap<String, Vec<String>>, id: &str, to_col: &str, index: usize) {
    for v in order.values_mut() {
        v.retain(|x| x != id);
    }
    let v = order.entry(to_col.to_string()).or_default();
    let i = index.min(v.len());
    v.insert(i, id.to_string());
}

fn id_num(id: &str) -> u32 {
    id.rsplit('-').next().and_then(|n| n.parse().ok()).unwrap_or(0)
}

fn read_tasks(root: &str) -> (Vec<Task>, Vec<(String, String)>) {
    let mut tasks = Vec::new();
    let mut errors = Vec::new();
    let Ok(rd) = fs::read_dir(tasks_dir(root)) else { return (tasks, errors) };
    let mut seen = HashSet::new();
    for ent in rd.flatten() {
        let p = ent.path();
        let name = ent.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".md") || name.starts_with('.') {
            continue;
        }
        let stem = name.trim_end_matches(".md").to_string();
        match fs::read_to_string(&p) {
            Ok(text) => {
                let mut t = parse_task(&text, &stem);
                // The file name is the source of truth for the id (it's how we address the file).
                if t.id != stem {
                    t.id = stem;
                }
                if seen.insert(t.id.clone()) {
                    tasks.push(t);
                }
            }
            Err(e) => errors.push((p.to_string_lossy().into_owned(), e.to_string())),
        }
    }
    (tasks, errors)
}

fn read_task(root: &str, id: &str) -> Result<Task, String> {
    let p = task_path(root, id)?;
    let text = fs::read_to_string(&p).map_err(|e| format!("task {id}: {e}"))?;
    let mut t = parse_task(&text, id);
    t.id = id.to_string();
    Ok(t)
}

fn write_task(root: &str, t: &Task) -> Result<(), String> {
    write_atomic(&task_path(root, &t.id)?, &serialize_task(t))
}

// ---------------- git exclude ----------------

fn exclude_file(root: &str) -> Option<PathBuf> {
    let repo = git2::Repository::discover(root).ok()?;
    Some(repo.commondir().join("info").join("exclude"))
}

/// Add (`exclude = true`) or remove the `.tcon/` line in `.git/info/exclude`.
pub fn set_exclude_in(path: &Path, exclude: bool) -> Result<(), String> {
    let cur = fs::read_to_string(path).unwrap_or_default();
    let has = cur.lines().any(|l| l.trim() == EXCLUDE_LINE || l.trim() == "/.tcon/" || l.trim() == ".tcon");
    let next = if exclude {
        if has {
            return Ok(());
        }
        let mut s = cur.clone();
        if !s.is_empty() && !s.ends_with('\n') {
            s.push('\n');
        }
        s.push_str(EXCLUDE_COMMENT);
        s.push('\n');
        s.push_str(EXCLUDE_LINE);
        s.push('\n');
        s
    } else {
        if !has {
            return Ok(());
        }
        let kept: Vec<&str> = cur.lines().filter(|l| !matches!(l.trim(), EXCLUDE_LINE | "/.tcon/" | ".tcon" | EXCLUDE_COMMENT)).collect();
        let mut s = kept.join("\n");
        if !s.is_empty() {
            s.push('\n');
        }
        s
    };
    write_atomic(path, &next)
}

fn apply_exclude(root: &str, shared: bool) -> Result<(), String> {
    match exclude_file(root) {
        Some(p) => set_exclude_in(&p, !shared),
        None => Ok(()), // not a git repo: nothing to exclude
    }
}

/// Create `.tcon/tasks`, the protocol file and (unless shared) the git exclude entry.
fn ensure_init(root: &str) -> Result<Board, String> {
    let dir = tasks_dir(root);
    let fresh = !tcon_dir(root).exists();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let board = read_board(root);
    let protocol = tcon_dir(root).join("PROTOCOL.md");
    if fs::read_to_string(&protocol).ok().as_deref() != Some(SKILL_MD) {
        write_atomic(&protocol, SKILL_MD)?;
    }
    if fresh || !board_path(root).exists() {
        apply_exclude(root, board.settings.shared)?;
        write_board(root, &board)?;
    }
    Ok(board)
}

// ---------------- operations ----------------

pub fn load(root: &str) -> BoardState {
    let initialized = tcon_dir(root).is_dir();
    let board = read_board(root);
    let (tasks, errors) = read_tasks(root);
    let columns = reconcile(&board, &tasks);
    BoardState { board, tasks, columns, initialized, errors }
}

pub fn create(root: &str, title: &str, description: &str, status: &str) -> Result<Task, String> {
    let _g = LOCK.lock();
    let mut board = ensure_init(root)?;
    let (tasks, _) = read_tasks(root);
    let mut n = board.next_id.max(tasks.iter().map(|t| id_num(&t.id)).max().unwrap_or(0) + 1);
    let mut id = format!("T-{n}");
    while task_path(root, &id)?.exists() {
        n += 1;
        id = format!("T-{n}");
    }
    let now = now_iso();
    let status = normalize_status(status);
    let t = Task {
        id: id.clone(),
        title: title.trim().to_string(),
        status: column_of(&board, &status),
        priority: "none".into(),
        created: now.clone(),
        updated: now,
        agent: "idle".into(),
        description: description.trim().to_string(),
        sections: default_sections("Created"),
        ..Default::default()
    };
    write_task(root, &t)?;
    board.next_id = n + 1;
    write_board(root, &board)?;
    Ok(t)
}

pub fn update(root: &str, id: &str, patch: TaskPatch) -> Result<Task, String> {
    let _g = LOCK.lock();
    update_locked(root, id, patch)
}

fn update_locked(root: &str, id: &str, patch: TaskPatch) -> Result<Task, String> {
    let mut t = read_task(root, id)?;
    if let Some(v) = patch.title {
        t.title = v.trim().to_string();
    }
    if let Some(v) = patch.status {
        let s = normalize_status(&v);
        if s != t.status {
            t.status = s;
        }
    }
    if let Some(v) = patch.priority {
        t.priority = v;
    }
    if let Some(v) = patch.labels {
        t.labels = v.into_iter().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    }
    if let Some(v) = patch.agent {
        t.agent = v;
    }
    if let Some(v) = patch.branch {
        t.branch = v;
    }
    if let Some(v) = patch.pane_id {
        t.pane_id = v;
    }
    if let Some(v) = patch.worktree {
        t.worktree = v;
    }
    if let Some(v) = patch.depends {
        t.depends = v.into_iter().map(|d| d.trim().to_string()).filter(|d| !d.is_empty()).collect();
    }
    if let Some(v) = patch.description {
        t.description = v.trim().to_string();
    }
    if let Some(msg) = patch.log.filter(|m| !m.trim().is_empty()) {
        t.sections = append_log(&t.sections, &log_line(&msg));
    }
    t.updated = now_iso();
    write_task(root, &t)?;
    Ok(t)
}

pub fn move_task(root: &str, id: &str, to_col: &str, index: usize) -> Result<BoardState, String> {
    {
        let _g = LOCK.lock();
        let mut board = read_board(root);
        if !board.columns.iter().any(|c| c.id == to_col) {
            return Err(format!("unknown column: {to_col}"));
        }
        let mut t = read_task(root, id)?;
        if column_of(&board, &t.status) != to_col || t.status != to_col {
            let title = board.columns.iter().find(|c| c.id == to_col).map(|c| c.title.clone()).unwrap_or_default();
            t.status = to_col.to_string();
            t.updated = now_iso();
            t.sections = append_log(&t.sections, &log_line(&format!("Moved to {title}")));
            write_task(root, &t)?;
        }
        let (tasks, _) = read_tasks(root);
        let mut order = reconcile(&board, &tasks);
        move_in_order(&mut order, id, to_col, index);
        board.order = order;
        write_board(root, &board)?;
    }
    Ok(load(root))
}

pub fn delete(root: &str, id: &str) -> Result<(), String> {
    let _g = LOCK.lock();
    let p = task_path(root, id)?;
    if p.exists() {
        fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    let mut board = read_board(root);
    let mut changed = false;
    for v in board.order.values_mut().chain([&mut board.run_queue, &mut board.batch]) {
        let before = v.len();
        v.retain(|x| x != id);
        changed |= v.len() != before;
    }
    if changed {
        write_board(root, &board)?;
    }
    Ok(())
}

pub fn save_settings(root: &str, settings: BoardSettings) -> Result<Board, String> {
    let _g = LOCK.lock();
    let mut board = ensure_init(root)?;
    let shared_changed = board.settings.shared != settings.shared;
    board.settings = settings.normalize();
    write_board(root, &board)?;
    if shared_changed {
        apply_exclude(root, board.settings.shared)?;
    }
    Ok(board)
}

/// One operation of [`bulk`]: patch a task, move it to the end of a column, or delete it.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BulkOp {
    pub id: String,
    pub patch: Option<TaskPatch>,
    pub column: Option<String>,
    pub delete: bool,
}

/// Apply several task operations under one lock (multi-select on the board). Returns the
/// board afterwards and the errors of the operations that failed (id, message).
pub fn bulk(root: &str, ops: Vec<BulkOp>) -> Result<(BoardState, Vec<(String, String)>), String> {
    let mut failed = Vec::new();
    {
        let _g = LOCK.lock();
        let mut board = read_board(root);
        let mut order_dirty = false;
        let (tasks, _) = read_tasks(root);
        let mut order = reconcile(&board, &tasks);
        for op in ops {
            let res: Result<(), String> = (|| {
                if op.delete {
                    let p = task_path(root, &op.id)?;
                    if p.exists() {
                        fs::remove_file(&p).map_err(|e| e.to_string())?;
                    }
                    for v in order.values_mut().chain([&mut board.run_queue, &mut board.batch]) {
                        v.retain(|x| x != &op.id);
                    }
                    order_dirty = true;
                    return Ok(());
                }
                if let Some(patch) = op.patch {
                    update_locked(root, &op.id, patch)?;
                }
                if let Some(col) = op.column {
                    let Some(title) = board.columns.iter().find(|c| c.id == col).map(|c| c.title.clone()) else {
                        return Err(format!("unknown column: {col}"));
                    };
                    let mut t = read_task(root, &op.id)?;
                    if t.status != col {
                        t.status = col.clone();
                        t.updated = now_iso();
                        t.sections = append_log(&t.sections, &log_line(&format!("Moved to {title}")));
                        write_task(root, &t)?;
                    }
                    let len = order.get(&col).map(|v| v.len()).unwrap_or(0);
                    move_in_order(&mut order, &op.id, &col, len);
                    order_dirty = true;
                }
                Ok(())
            })();
            if let Err(e) = res {
                failed.push((op.id, e));
            }
        }
        if order_dirty {
            board.order = order;
            write_board(root, &board)?;
        }
    }
    Ok((load(root), failed))
}

/// Replace the run queue (and the current batch). Unknown ids are dropped.
pub fn set_queue(root: &str, queue: Vec<String>, batch: Option<Vec<String>>) -> Result<Board, String> {
    let _g = LOCK.lock();
    let mut board = ensure_init(root)?;
    let (tasks, _) = read_tasks(root);
    let known: HashSet<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
    let mut seen = HashSet::new();
    board.run_queue = queue.into_iter().filter(|id| known.contains(id.as_str()) && seen.insert(id.clone())).collect();
    if let Some(b) = batch {
        board.batch = b.into_iter().filter(|id| known.contains(id.as_str())).collect();
    }
    write_board(root, &board)?;
    Ok(board)
}

/// Write the skill into `<config_dir>/skills/tcon-tasks/SKILL.md` for each config dir.
pub fn install_skill(config_dirs: &[String]) -> Result<Vec<String>, String> {
    let mut written = Vec::new();
    let mut seen = HashSet::new();
    for d in config_dirs {
        let d = d.trim_end_matches('/');
        if d.is_empty() || !seen.insert(d.to_string()) {
            continue;
        }
        let p = Path::new(d).join("skills").join(SKILL_NAME).join("SKILL.md");
        write_atomic(&p, SKILL_MD)?;
        written.push(p.to_string_lossy().into_owned());
    }
    Ok(written)
}

/// Rewrite copies of the skill that are already installed but outdated (after a tCon update).
/// Config dirs without the skill are left alone. Returns the paths that were updated.
pub fn refresh_skill(config_dirs: &[String]) -> Result<Vec<String>, String> {
    let mut written = Vec::new();
    let mut seen = HashSet::new();
    for d in config_dirs {
        let d = d.trim_end_matches('/');
        if d.is_empty() || !seen.insert(d.to_string()) {
            continue;
        }
        let p = Path::new(d).join("skills").join(SKILL_NAME).join("SKILL.md");
        match fs::read_to_string(&p) {
            Ok(cur) if cur != SKILL_MD => {
                write_atomic(&p, SKILL_MD)?;
                written.push(p.to_string_lossy().into_owned());
            }
            _ => {}
        }
    }
    Ok(written)
}

// ---------------- tauri commands ----------------

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tasks_load(root: String) -> Result<BoardState, String> {
    blocking(move || Ok(load(&root))).await
}

#[tauri::command]
pub async fn tasks_init(root: String) -> Result<BoardState, String> {
    blocking(move || {
        {
            let _g = LOCK.lock();
            ensure_init(&root)?;
        }
        Ok(load(&root))
    })
    .await
}

#[tauri::command]
pub async fn task_create(root: String, title: String, description: String, status: String) -> Result<Task, String> {
    blocking(move || create(&root, &title, &description, &status)).await
}

#[tauri::command]
pub async fn task_update(root: String, id: String, patch: TaskPatch) -> Result<Task, String> {
    blocking(move || update(&root, &id, patch)).await
}

#[tauri::command]
pub async fn task_move(root: String, id: String, column: String, index: usize) -> Result<BoardState, String> {
    blocking(move || move_task(&root, &id, &column, index)).await
}

#[tauri::command]
pub async fn task_delete(root: String, id: String) -> Result<(), String> {
    blocking(move || delete(&root, &id)).await
}

#[tauri::command]
pub async fn tasks_save_settings(root: String, settings: BoardSettings) -> Result<Board, String> {
    blocking(move || save_settings(&root, settings)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkResult {
    pub state: BoardState,
    pub failed: Vec<(String, String)>,
}

#[tauri::command]
pub async fn task_bulk(root: String, ops: Vec<BulkOp>) -> Result<BulkResult, String> {
    blocking(move || bulk(&root, ops).map(|(state, failed)| BulkResult { state, failed })).await
}

#[tauri::command]
pub async fn tasks_set_queue(root: String, queue: Vec<String>, batch: Option<Vec<String>>) -> Result<Board, String> {
    blocking(move || set_queue(&root, queue, batch)).await
}

#[tauri::command]
pub async fn tasks_refresh_skill(config_dirs: Vec<String>) -> Result<Vec<String>, String> {
    blocking(move || refresh_skill(&config_dirs)).await
}

#[tauri::command]
pub async fn tasks_install_skill(config_dirs: Vec<String>) -> Result<Vec<String>, String> {
    blocking(move || install_skill(&config_dirs)).await
}

// ---------------- tests ----------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tcon-tasks-{name}-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn sample() -> Task {
        Task {
            id: "T-3".into(),
            title: "Fix: login # redirect \"loop\"".into(),
            status: "in-progress".into(),
            priority: "high".into(),
            labels: vec!["bug".into(), "auth, sso".into()],
            created: "2026-11-27T10:00:00Z".into(),
            updated: "2026-11-27T11:00:00Z".into(),
            agent: "running".into(),
            branch: "feat/x".into(),
            commits: vec!["abc1234".into()],
            pane_id: "p1".into(),
            depends: vec!["T-1".into()],
            worktree: "/Users/x/.tcon/worktrees/p-1/T-3".into(),
            extra: vec![("estimate".into(), "3".into())],
            description: "Users report a loop.\n\n## Notes from the meeting\n- happens on Safari".into(),
            sections: "## Plan\n1. look\n\n## Progress log\n- 2026-11-27 10:00 — Created\n\n## Verification".into(),
        }
    }

    #[test]
    fn frontmatter_round_trip() {
        let t = sample();
        let text = serialize_task(&t);
        let back = parse_task(&text, "ignored");
        assert_eq!(back, t);
        // Serializing again is stable.
        assert_eq!(serialize_task(&back), text);
    }

    #[test]
    fn parses_hand_written_yaml() {
        let text = "---\r\nid: T-9\r\ntitle: 'It''s broken'   # comment\r\nstatus: In Progress\r\nlabels:\r\n  - ui\r\n  - \"a, b\"\r\ncommits: []\r\nowner: me\r\n---\r\nBody line\r\n";
        let t = parse_task(text, "T-9");
        assert_eq!(t.title, "It's broken");
        assert_eq!(t.status, "in-progress");
        assert_eq!(t.labels, vec!["ui".to_string(), "a, b".to_string()]);
        assert!(t.commits.is_empty());
        assert_eq!(t.priority, "none");
        assert_eq!(t.agent, "idle");
        assert_eq!(t.extra, vec![("owner".to_string(), "me".to_string())]);
        assert_eq!(t.description, "Body line");
    }

    #[test]
    fn no_frontmatter_uses_first_line() {
        let t = parse_task("# Quick note\nmore", "T-1");
        assert_eq!(t.title, "Quick note");
        assert_eq!(t.status, "inbox");
    }

    #[test]
    fn append_log_inserts_into_section() {
        let s = "## Plan\nx\n\n## Progress log\n- a\n\n## Verification\nok";
        let out = append_log(s, "- b");
        assert_eq!(out, "## Plan\nx\n\n## Progress log\n- a\n- b\n\n## Verification\nok");
        let out = append_log("## Plan\n\n## Verification\n", "- c");
        assert!(out.contains("## Progress log\n- c\n"));
        assert!(out.find("Progress log").unwrap() < out.find("Verification").unwrap());
        assert_eq!(append_log("", "- d"), "## Progress log\n- d\n");
    }

    #[test]
    fn board_ordering_reconciles() {
        let mut board = Board::default();
        let mk = |id: &str, status: &str, created: &str| Task { id: id.into(), status: status.into(), created: created.into(), ..Default::default() };
        let tasks = vec![
            mk("T-1", "todo", "2026-01-01"),
            mk("T-2", "todo", "2026-01-02"),
            mk("T-3", "todo", "2026-01-03"),
            mk("T-4", "weird", "2026-01-04"),
            mk("T-5", "done", "2026-01-05"),
        ];
        // Stored order lists T-3 first, a stale id, and T-5 in the wrong column.
        board.order.insert("todo".into(), vec!["T-3".into(), "T-gone".into(), "T-5".into()]);
        let o = reconcile(&board, &tasks);
        assert_eq!(o["todo"], vec!["T-3", "T-1", "T-2"]);
        assert_eq!(o["inbox"], vec!["T-4"]); // unknown status → first column
        assert_eq!(o["done"], vec!["T-5"]);
        assert!(o["review"].is_empty());

        let mut o2 = o.clone();
        move_in_order(&mut o2, "T-1", "done", 0);
        assert_eq!(o2["todo"], vec!["T-3", "T-2"]);
        assert_eq!(o2["done"], vec!["T-1", "T-5"]);
        move_in_order(&mut o2, "T-2", "done", 99);
        assert_eq!(o2["done"], vec!["T-1", "T-5", "T-2"]);
    }

    #[test]
    fn create_move_update_delete_on_disk() {
        let root = tmp("ops");
        let r = root.to_string_lossy().to_string();
        let a = create(&r, "First", "notes", "inbox").unwrap();
        let b = create(&r, "Second", "", "todo").unwrap();
        assert_eq!(a.id, "T-1");
        assert_eq!(b.id, "T-2");
        assert!(root.join(".tcon/PROTOCOL.md").exists());

        let st = move_task(&r, "T-1", "todo", 0).unwrap();
        assert_eq!(st.columns["todo"], vec!["T-1", "T-2"]);
        let t1 = st.tasks.iter().find(|t| t.id == "T-1").unwrap();
        assert_eq!(t1.status, "todo");
        assert!(t1.sections.contains("Moved to Todo"));

        let u = update(&r, "T-2", TaskPatch { agent: Some("running".into()), log: Some("Started".into()), ..Default::default() }).unwrap();
        assert_eq!(u.agent, "running");
        assert!(u.sections.contains("— Started"));
        assert_eq!(u.description, "");

        delete(&r, "T-1").unwrap();
        // Ids are not reused after deletion.
        let c = create(&r, "Third", "", "inbox").unwrap();
        assert_eq!(c.id, "T-3");
        let st = load(&r);
        assert_eq!(st.tasks.len(), 2);
        assert_eq!(st.columns["todo"], vec!["T-2"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn exclude_line_add_remove() {
        let root = tmp("excl");
        let p = root.join("exclude");
        fs::write(&p, "# git ls-files --others\n*.log").unwrap();
        set_exclude_in(&p, true).unwrap();
        set_exclude_in(&p, true).unwrap();
        let s = fs::read_to_string(&p).unwrap();
        assert_eq!(s.matches(".tcon/").count(), 1);
        assert!(s.starts_with("# git ls-files --others\n*.log\n"));
        set_exclude_in(&p, false).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "# git ls-files --others\n*.log\n");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn settings_migrate_and_normalize() {
        let b: Board = serde_json::from_str(r#"{"settings":{"askOnTodo":true,"maxAgents":40,"runMode":"weird"}}"#).unwrap();
        let s = b.settings.normalize();
        assert_eq!(s.auto_pickup, "ask");
        assert_eq!(s.max_agents, 16);
        assert_eq!(s.run_mode, "rolling");
        assert_eq!(s.pickup_position, "end");
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("askOnTodo"));
        let b: Board = serde_json::from_str(r#"{"settings":{"askOnTodo":false,"autoPickup":"auto"}}"#).unwrap();
        assert_eq!(b.settings.normalize().auto_pickup, "auto");
    }

    #[test]
    fn queue_keeps_known_ids_once() {
        let root = tmp("queue");
        let r = root.to_string_lossy().to_string();
        create(&r, "A", "", "todo").unwrap();
        create(&r, "B", "", "todo").unwrap();
        let b = set_queue(&r, vec!["T-2".into(), "T-9".into(), "T-1".into(), "T-2".into()], Some(vec!["T-1".into()])).unwrap();
        assert_eq!(b.run_queue, vec!["T-2", "T-1"]);
        assert_eq!(b.batch, vec!["T-1"]);
        assert_eq!(load(&r).board.run_queue, vec!["T-2", "T-1"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bulk_patches_moves_and_deletes() {
        let root = tmp("bulk");
        let r = root.to_string_lossy().to_string();
        for n in ["A", "B", "C"] {
            create(&r, n, "", "inbox").unwrap();
        }
        set_queue(&r, vec!["T-3".into()], None).unwrap();
        let ops = vec![
            BulkOp { id: "T-1".into(), patch: Some(TaskPatch { priority: Some("high".into()), ..Default::default() }), column: Some("todo".into()), ..Default::default() },
            BulkOp { id: "T-2".into(), column: Some("todo".into()), ..Default::default() },
            BulkOp { id: "T-3".into(), delete: true, ..Default::default() },
            BulkOp { id: "T-9".into(), column: Some("todo".into()), ..Default::default() },
        ];
        let (st, failed) = bulk(&r, ops).unwrap();
        assert_eq!(st.columns["todo"], vec!["T-1", "T-2"]);
        assert!(st.columns["inbox"].is_empty());
        assert_eq!(st.tasks.iter().find(|t| t.id == "T-1").unwrap().priority, "high");
        assert_eq!(st.tasks.len(), 2);
        assert!(st.board.run_queue.is_empty());
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].0, "T-9");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_bad_ids() {
        assert!(task_path("/x", "../etc").is_err());
        assert!(task_path("/x", "").is_err());
        assert!(task_path("/x", "T-1").is_ok());
    }

    #[test]
    fn refresh_skill_only_touches_installed_copies() {
        let root = tmp("skill");
        let a = root.join("a");
        let b = root.join("b");
        let pa = a.join("skills/tcon-tasks/SKILL.md");
        fs::create_dir_all(pa.parent().unwrap()).unwrap();
        fs::write(&pa, "old").unwrap();
        let dirs = vec![a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned()];
        let out = refresh_skill(&dirs).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(fs::read_to_string(&pa).unwrap(), SKILL_MD);
        assert!(!b.join("skills").exists());
        assert!(refresh_skill(&dirs).unwrap().is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn skill_has_frontmatter() {
        assert!(SKILL_MD.starts_with("---\nname: tcon-tasks\ndescription: "));
    }
}
