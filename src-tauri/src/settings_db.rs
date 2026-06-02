use anyhow::Result;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The C-drive directory where we persist user settings.
const DB_DIR: &str = "C:\\xDoc";
const DB_FILE: &str = "settings.db";

/// Resolve the managed papers directory relative to the executable.
/// Returns `<exe_dir>/papers`.
pub fn get_papers_dir() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("papers")
}

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

/// An annotation record stored per page.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AnnotationRecord {
    pub file_path: String,
    pub page_index: i32,
    pub shapes_json: String,
}

/// A paper record stored in the papers table.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct PaperRecord {
    pub id: String,
    pub name: String,
    pub original_path: String,
    pub managed_path: Option<String>,
    pub import_date: String,
    pub last_read_date: Option<String>,
    pub file_size: Option<i64>,
    // Metadata fields
    pub title: Option<String>,
    pub title_translation: Option<String>,
    pub authors: Option<String>,       // JSON array
    pub abstract_text: Option<String>,
    pub journal: Option<String>,
    pub publisher: Option<String>,
    pub date: Option<String>,
    pub volume: Option<String>,
    pub issue: Option<String>,
    pub pages: Option<String>,
    pub doi: Option<String>,
    pub url: Option<String>,
    pub journal_abbrev: Option<String>,
    pub issn: Option<String>,
    pub isbn: Option<String>,
    pub language: Option<String>,
    pub keywords: Option<String>,      // JSON array
    pub metadata_extracted: bool,
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

        // Papers table — stores imported paper info + extracted metadata
        conn.execute(
            "CREATE TABLE IF NOT EXISTS papers (
                id                  TEXT PRIMARY KEY,
                name                TEXT NOT NULL,
                original_path       TEXT NOT NULL,
                managed_path        TEXT,
                import_date         TEXT NOT NULL,
                last_read_date      TEXT,
                file_size           INTEGER,
                title               TEXT,
                title_translation   TEXT,
                authors             TEXT,
                abstract_text       TEXT,
                journal             TEXT,
                publisher           TEXT,
                date                TEXT,
                volume              TEXT,
                issue               TEXT,
                pages               TEXT,
                doi                 TEXT,
                url                 TEXT,
                journal_abbrev      TEXT,
                issn                TEXT,
                isbn                TEXT,
                language            TEXT,
                keywords            TEXT,
                metadata_extracted  INTEGER DEFAULT 0
             )",
            [],
        )
        .map_err(|e| anyhow::anyhow!("创建 papers 表失败: {e}"))?;

        // Annotations table — stores per-page annotation shapes
        conn.execute(
            "CREATE TABLE IF NOT EXISTS annotations (
                file_path     TEXT    NOT NULL,
                page_index    INTEGER NOT NULL,
                shapes_json   TEXT    NOT NULL,
                created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
                updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (file_path, page_index)
             )",
            [],
        )
        .map_err(|e| anyhow::anyhow!("创建 annotations 表失败: {e}"))?;

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

    // ── Paper CRUD ──────────────────────────────────────────────────────────

    /// Insert or update a paper record.
    pub fn upsert_paper(&self, paper: &PaperRecord) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO papers (
                id, name, original_path, managed_path, import_date,
                last_read_date, file_size, title, title_translation,
                authors, abstract_text, journal, publisher, date,
                volume, issue, pages, doi, url, journal_abbrev,
                issn, isbn, language, keywords, metadata_extracted
             ) VALUES (
                ?1,  ?2,  ?3,  ?4,  ?5,
                ?6,  ?7,  ?8,  ?9,
                ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18, ?19, ?20,
                ?21, ?22, ?23, ?24, ?25
             )
             ON CONFLICT(id) DO UPDATE SET
                name               = excluded.name,
                original_path      = excluded.original_path,
                managed_path       = excluded.managed_path,
                import_date        = excluded.import_date,
                last_read_date     = excluded.last_read_date,
                file_size          = excluded.file_size,
                title              = excluded.title,
                title_translation  = excluded.title_translation,
                authors            = excluded.authors,
                abstract_text      = excluded.abstract_text,
                journal            = excluded.journal,
                publisher          = excluded.publisher,
                date               = excluded.date,
                volume             = excluded.volume,
                issue              = excluded.issue,
                pages              = excluded.pages,
                doi                = excluded.doi,
                url                = excluded.url,
                journal_abbrev     = excluded.journal_abbrev,
                issn               = excluded.issn,
                isbn               = excluded.isbn,
                language           = excluded.language,
                keywords           = excluded.keywords,
                metadata_extracted = excluded.metadata_extracted",
            params![
                paper.id,
                paper.name,
                paper.original_path,
                paper.managed_path,
                paper.import_date,
                paper.last_read_date,
                paper.file_size,
                paper.title,
                paper.title_translation,
                paper.authors,
                paper.abstract_text,
                paper.journal,
                paper.publisher,
                paper.date,
                paper.volume,
                paper.issue,
                paper.pages,
                paper.doi,
                paper.url,
                paper.journal_abbrev,
                paper.issn,
                paper.isbn,
                paper.language,
                paper.keywords,
                paper.metadata_extracted as i32,
            ],
        )?;
        Ok(())
    }

    /// Read all paper records.
    pub fn list_papers(&self) -> Result<Vec<PaperRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, original_path, managed_path, import_date,
                    last_read_date, file_size, title, title_translation,
                    authors, abstract_text, journal, publisher, date,
                    volume, issue, pages, doi, url, journal_abbrev,
                    issn, isbn, language, keywords, metadata_extracted
             FROM papers ORDER BY import_date DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PaperRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                original_path: row.get(2)?,
                managed_path: row.get(3)?,
                import_date: row.get(4)?,
                last_read_date: row.get(5)?,
                file_size: row.get(6)?,
                title: row.get(7)?,
                title_translation: row.get(8)?,
                authors: row.get(9)?,
                abstract_text: row.get(10)?,
                journal: row.get(11)?,
                publisher: row.get(12)?,
                date: row.get(13)?,
                volume: row.get(14)?,
                issue: row.get(15)?,
                pages: row.get(16)?,
                doi: row.get(17)?,
                url: row.get(18)?,
                journal_abbrev: row.get(19)?,
                issn: row.get(20)?,
                isbn: row.get(21)?,
                language: row.get(22)?,
                keywords: row.get(23)?,
                metadata_extracted: row.get::<_, i32>(24)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Delete a paper record (does NOT remove the managed file — caller handles that).
    pub fn delete_paper(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM papers WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Get the managed_path for a paper (used for file cleanup on delete).
    pub fn get_paper_managed_path(&self, id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT managed_path FROM papers WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(row.get(0)?)
        } else {
            Ok(None)
        }
    }

    // ── Annotation CRUD ─────────────────────────────────────────────────────

    /// Insert or update annotation shapes for a specific page.
    pub fn save_annotations(&self, file_path: &str, page_index: i32, shapes_json: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO annotations (file_path, page_index, shapes_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, datetime('now'), datetime('now'))
             ON CONFLICT(file_path, page_index) DO UPDATE SET
                shapes_json = excluded.shapes_json,
                updated_at  = datetime('now')",
            params![file_path, page_index, shapes_json],
        )?;
        Ok(())
    }

    /// Load all annotation records for a document.
    pub fn load_annotations(&self, file_path: &str) -> Result<Vec<AnnotationRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT file_path, page_index, shapes_json FROM annotations
             WHERE file_path = ?1 ORDER BY page_index",
        )?;
        let rows = stmt.query_map(params![file_path], |row| {
            Ok(AnnotationRecord {
                file_path: row.get(0)?,
                page_index: row.get(1)?,
                shapes_json: row.get(2)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Delete all annotation records for a document.
    pub fn delete_annotations(&self, file_path: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM annotations WHERE file_path = ?1", params![file_path])?;
        Ok(())
    }
}
