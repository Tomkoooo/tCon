//! SQLite persistence: workspace snapshot, recent paths, account profiles, settings.

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub struct Db(pub Mutex<Connection>);

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentPath {
    pub path: String,
    pub last_used: i64,
    pub pinned: bool,
}

/// An account / launch profile. `env` is injected into the PTY. Use e.g.
/// `CLAUDE_CONFIG_DIR` to separate Claude accounts. Secrets don't belong here.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub color: String,
    pub env: std::collections::HashMap<String, String>,
}

impl Db {
    pub fn open(dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let conn = Connection::open(dir.join("tcon.db"))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS recent_paths (path TEXT PRIMARY KEY, last_used INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, env_json TEXT NOT NULL);",
        )?;
        Ok(Db(Mutex::new(conn)))
    }

    pub fn get_setting(&self, key: &str) -> anyhow::Result<Option<String>> {
        Ok(self.0.lock().query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> anyhow::Result<()> {
        self.0.lock().execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn touch_recent(&self, path: &str) -> anyhow::Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        self.0.lock().execute(
            "INSERT INTO recent_paths(path,last_used) VALUES(?1,?2) ON CONFLICT(path) DO UPDATE SET last_used=excluded.last_used",
            params![path, now],
        )?;
        Ok(())
    }

    pub fn set_pinned(&self, path: &str, pinned: bool) -> anyhow::Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        self.0.lock().execute(
            "INSERT INTO recent_paths(path,last_used,pinned) VALUES(?1,?2,?3) ON CONFLICT(path) DO UPDATE SET pinned=excluded.pinned",
            params![path, now, pinned as i64],
        )?;
        Ok(())
    }

    pub fn remove_recent(&self, path: &str) -> anyhow::Result<()> {
        self.0.lock().execute("DELETE FROM recent_paths WHERE path=?1", [path])?;
        Ok(())
    }

    pub fn recent(&self, limit: u32) -> anyhow::Result<Vec<RecentPath>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare("SELECT path,last_used,pinned FROM recent_paths ORDER BY pinned DESC, last_used DESC LIMIT ?1")?;
        let rows = stmt.query_map([limit], |r| {
            Ok(RecentPath { path: r.get(0)?, last_used: r.get(1)?, pinned: r.get::<_, i64>(2)? != 0 })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn profiles(&self) -> anyhow::Result<Vec<Profile>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare("SELECT id,name,color,env_json FROM profiles ORDER BY name")?;
        let rows = stmt.query_map([], |r| {
            let env_json: String = r.get(3)?;
            Ok(Profile { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, env: serde_json::from_str(&env_json).unwrap_or_default() })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn save_profile(&self, p: &Profile) -> anyhow::Result<()> {
        self.0.lock().execute(
            "INSERT INTO profiles(id,name,color,env_json) VALUES(?1,?2,?3,?4)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,env_json=excluded.env_json",
            params![p.id, p.name, p.color, serde_json::to_string(&p.env)?],
        )?;
        Ok(())
    }

    pub fn delete_profile(&self, id: &str) -> anyhow::Result<()> {
        self.0.lock().execute("DELETE FROM profiles WHERE id=?1", [id])?;
        Ok(())
    }
}
