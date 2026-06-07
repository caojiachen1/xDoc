//! Plugin key-value storage (per-plugin, SQLite-backed).
//!
//! Each plugin gets an isolated namespace with a 5 MB quota.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// Maximum bytes a single plugin may store (5 MB).
const MAX_STORAGE_PER_PLUGIN: usize = 5 * 1024 * 1024;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[allow(dead_code)]
pub struct PluginStorageEntry {
    pub plugin_id: String,
    pub key: String,
    pub value: String,
}

/// Create the `plugin_storage` table if it does not exist.
/// Called from `SettingsDb::open()`.
pub fn init_plugin_storage_table(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS plugin_storage (
            plugin_id TEXT NOT NULL,
            key       TEXT NOT NULL,
            value     TEXT NOT NULL,
            PRIMARY KEY (plugin_id, key)
        )",
        [],
    )
    .map_err(|e| anyhow::anyhow!("创建 plugin_storage 表失败: {e}"))?;
    Ok(())
}

/// Get a single value by key for a given plugin.
pub fn storage_get(
    conn: &Connection,
    plugin_id: &str,
    key: &str,
) -> Result<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT value FROM plugin_storage WHERE plugin_id = ?1 AND key = ?2",
    )?;
    let mut rows = stmt.query(params![plugin_id, key])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

/// Insert or update a key. Enforces the per-plugin quota.
pub fn storage_set(
    conn: &Connection,
    plugin_id: &str,
    key: &str,
    value: &str,
) -> Result<()> {
    // Compute current usage (excluding the key being overwritten)
    let current: i64 = conn.query_row(
        "SELECT COALESCE(SUM(LENGTH(value)), 0)
         FROM plugin_storage
         WHERE plugin_id = ?1 AND key != ?2",
        params![plugin_id, key],
        |row| row.get(0),
    )?;

    if current as usize + value.len() > MAX_STORAGE_PER_PLUGIN {
        anyhow::bail!(
            "Plugin '{}' storage quota exceeded (limit {} bytes)",
            plugin_id,
            MAX_STORAGE_PER_PLUGIN
        );
    }

    conn.execute(
        "INSERT INTO plugin_storage(plugin_id, key, value) VALUES(?1, ?2, ?3)
         ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value",
        params![plugin_id, key, value],
    )?;
    Ok(())
}

/// Delete a key.
pub fn storage_delete(conn: &Connection, plugin_id: &str, key: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM plugin_storage WHERE plugin_id = ?1 AND key = ?2",
        params![plugin_id, key],
    )?;
    Ok(())
}

/// List all keys for a plugin, alphabetically sorted.
pub fn storage_list(conn: &Connection, plugin_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT key FROM plugin_storage WHERE plugin_id = ?1 ORDER BY key",
    )?;
    let rows = stmt.query_map(params![plugin_id], |row| row.get(0))?;
    let mut keys: Vec<String> = Vec::new();
    for r in rows {
        keys.push(r?);
    }
    Ok(keys)
}
