use anyhow::Result;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The C-drive directory where we persist user settings.
const DB_DIR: &str = "C:\\xDoc";
const DB_FILE: &str = "settings.db";

/// AI vendor configuration returned to / received from the frontend.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct AiConfig {
    pub vendor: String,
    pub vendor_api_keys: std::collections::HashMap<String, String>,
    pub base_url: String,
    pub model: String,
}

/// A single key/value record stored in the settings table.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SettingEntry {
    pub key: String,
    pub value: String,
}

/// Owns the SQLite connection. Wrapped in a Tauri-managed state.
pub struct SettingsDb {
    pub conn: Mutex<Connection>,
    pub path: PathBuf,
}

impl SettingsDb {
    /// Open (or create) the settings database at `C:\xDoc\settings.db`.
    pub fn open() -> Result<Self> {
        let dir = PathBuf::from(DB_DIR);
        std::fs::create_dir_all(&dir)
            .map_err(|e| anyhow::anyhow!("无法创建数据库目录 {}: {}", dir.display(), e))?;
        let path = dir.join(DB_FILE);

        let conn = Connection::open(&path)
            .map_err(|e| anyhow::anyhow!("无法打开数据库 {}: {}", path.display(), e))?;

        // Enable WAL for better concurrent read/write characteristics.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous  = NORMAL;
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|e| anyhow::anyhow!("设置 PRAGMA 失败: {e}"))?;

        // The settings table — simple key/value store with TEXT values
        // (we JSON-encode complex structures like vendorApiKeys).
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
             )",
            [],
        )
        .map_err(|e| anyhow::anyhow!("创建 settings 表失败: {e}"))?;

        Ok(Self {
            conn: Mutex::new(conn),
            path,
        })
    }

    /// Read a single string value by key.
    pub fn get(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    /// Insert or replace a single key/value pair.
    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Remove a single key.
    pub fn delete(&self, key: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// Read all rows (used by the frontend to bootstrap state).
    pub fn get_all(&self) -> Result<Vec<SettingEntry>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |row| {
            Ok(SettingEntry {
                key: row.get(0)?,
                value: row.get(1)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Convenience: read a vendor_api_keys map (stored as JSON).
    pub fn get_vendor_api_keys(&self) -> Result<std::collections::HashMap<String, String>> {
        match self.get("llm.vendorApiKeys")? {
            Some(s) if !s.is_empty() => Ok(serde_json::from_str(&s).unwrap_or_default()),
            _ => Ok(std::collections::HashMap::new()),
        }
    }

    /// Convenience: write a vendor_api_keys map.
    pub fn set_vendor_api_keys(
        &self,
        keys: &std::collections::HashMap<String, String>,
    ) -> Result<()> {
        let s = serde_json::to_string(keys)?;
        self.set("llm.vendorApiKeys", &s)
    }
}
