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

/// A journal ranking record from the CAS ranking table.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct JournalRanking {
    pub journal: String,
    pub zone: i32,
    pub is_top: bool,
    pub is_oa: bool,
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
    pub abstract_translation: Option<String>,
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
                abstract_translation TEXT,
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

        // Migration: add abstract_translation column if missing (for existing DBs)
        {
            let has_col: bool = conn
                .prepare("PRAGMA table_info(papers)")
                .and_then(|mut stmt| {
                    let rows = stmt.query_map([], |row| {
                        Ok(row.get::<_, String>(1)?)
                    })?;
                    Ok(rows.filter_map(|r| r.ok()).any(|name| name == "abstract_translation"))
                })
                .unwrap_or(false);
            if !has_col {
                conn.execute("ALTER TABLE papers ADD COLUMN abstract_translation TEXT", [])
                    .map_err(|e| anyhow::anyhow!("迁移 abstract_translation 列失败: {e}"))?;
            }
        }

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

        // Journal rankings table — CAS journal ranking data (tier table)
        conn.execute(
            "CREATE TABLE IF NOT EXISTS journal_rankings (
                journal_norm TEXT PRIMARY KEY,
                journal      TEXT NOT NULL,
                zone         INTEGER NOT NULL,
                is_top       INTEGER NOT NULL DEFAULT 0,
                is_oa        INTEGER NOT NULL DEFAULT 0
             )",
            [],
        )
        .map_err(|e| anyhow::anyhow!("创建 journal_rankings 表失败: {e}"))?;

        // Reading sessions table — tracks reading time per paper
        conn.execute(
            "CREATE TABLE IF NOT EXISTS reading_sessions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                paper_id        TEXT    NOT NULL,
                paper_name      TEXT    NOT NULL,
                start_time      TEXT    NOT NULL,
                end_time        TEXT    NOT NULL,
                duration_seconds INTEGER NOT NULL,
                date            TEXT    NOT NULL,
                hour            INTEGER NOT NULL
             )",
            [],
        )
        .map_err(|e| anyhow::anyhow!("创建 reading_sessions 表失败: {e}"))?;

        // Plugin key-value storage table
        crate::plugin_storage::init_plugin_storage_table(&conn)
            .map_err(|e| anyhow::anyhow!("初始化 plugin_storage 表失败: {e}"))?;

        // Full-text search index — stores per-page text for search.
        // FTS5 virtual tables do NOT support ALTER TABLE ADD COLUMN,
        // so we detect the schema and recreate if columns are missing.
        {
            let needs_recreate = conn
                .prepare("PRAGMA table_info(papers_fts)")
                .and_then(|mut stmt| {
                    let cols: Vec<String> = stmt
                        .query_map([], |row| row.get::<_, String>(1))?
                        .filter_map(|r| r.ok())
                        .collect();
                    eprintln!("[db] papers_fts columns: {:?}", cols);
                    // If table exists but lacks char_count column, we must recreate
                    Ok(!cols.is_empty() && !cols.contains(&"char_count".to_string()))
                })
                .unwrap_or(false);

            if needs_recreate {
                eprintln!("[db] papers_fts table has old schema, dropping and recreating...");
                conn.execute_batch("DROP TABLE IF EXISTS papers_fts;")
                    .map_err(|e| anyhow::anyhow!("删除旧 papers_fts 表失败: {e}"))?;
            } else {
                eprintln!("[db] papers_fts table schema is up-to-date");
            }

            conn.execute_batch(
                "CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
                    paper_id UNINDEXED,
                    page_index UNINDEXED,
                    text,
                    char_count UNINDEXED,
                    language UNINDEXED,
                    tokenize='unicode61'
                );",
            )
            .map_err(|e| anyhow::anyhow!("创建 papers_fts 表失败: {e}"))?;
            eprintln!("[db] papers_fts table ready");
        }

        // OCR paragraph cache — persistent cache of OCR results per paragraph region.
        // Used for both search indexing (OCR mode) and instant display when clicking paragraph boxes.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS ocr_paragraph_cache (
                paper_id    TEXT    NOT NULL,
                page_index  INTEGER NOT NULL,
                xmin        INTEGER NOT NULL,
                ymin        INTEGER NOT NULL,
                xmax        INTEGER NOT NULL,
                ymax        INTEGER NOT NULL,
                text        TEXT    NOT NULL,
                model_id    TEXT,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (paper_id, page_index, xmin, ymin, xmax, ymax)
             )",
            [],
        )
        .map_err(|e| anyhow::anyhow!("创建 ocr_paragraph_cache 表失败: {e}"))?;

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
                authors, abstract_text, abstract_translation, journal, publisher, date,
                volume, issue, pages, doi, url, journal_abbrev,
                issn, isbn, language, keywords, metadata_extracted
             ) VALUES (
                ?1,  ?2,  ?3,  ?4,  ?5,
                ?6,  ?7,  ?8,  ?9,
                ?10, ?11, ?12, ?13, ?14, ?15,
                ?16, ?17, ?18, ?19, ?20, ?21,
                ?22, ?23, ?24, ?25, ?26
             )
             ON CONFLICT(id) DO UPDATE SET
                name                 = excluded.name,
                original_path        = excluded.original_path,
                managed_path         = excluded.managed_path,
                import_date          = excluded.import_date,
                last_read_date       = excluded.last_read_date,
                file_size            = excluded.file_size,
                title                = excluded.title,
                title_translation    = excluded.title_translation,
                authors              = excluded.authors,
                abstract_text        = excluded.abstract_text,
                abstract_translation = excluded.abstract_translation,
                journal              = excluded.journal,
                publisher            = excluded.publisher,
                date                 = excluded.date,
                volume               = excluded.volume,
                issue                = excluded.issue,
                pages                = excluded.pages,
                doi                  = excluded.doi,
                url                  = excluded.url,
                journal_abbrev       = excluded.journal_abbrev,
                issn                 = excluded.issn,
                isbn                 = excluded.isbn,
                language             = excluded.language,
                keywords             = excluded.keywords,
                metadata_extracted   = excluded.metadata_extracted",
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
                paper.abstract_translation,
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
                    authors, abstract_text, abstract_translation, journal, publisher, date,
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
                abstract_translation: row.get(11)?,
                journal: row.get(12)?,
                publisher: row.get(13)?,
                date: row.get(14)?,
                volume: row.get(15)?,
                issue: row.get(16)?,
                pages: row.get(17)?,
                doi: row.get(18)?,
                url: row.get(19)?,
                journal_abbrev: row.get(20)?,
                issn: row.get(21)?,
                isbn: row.get(22)?,
                language: row.get(23)?,
                keywords: row.get(24)?,
                metadata_extracted: row.get::<_, i32>(25)? != 0,
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

    // ── Journal Rankings ────────────────────────────────────────────────────

    /// Normalize a journal name for case-insensitive, punctuation-insensitive lookup.
    /// Strips all punctuation, lowercases, and collapses whitespace.
    fn normalize_journal(name: &str) -> String {
        name.to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<&str>>()
            .join(" ")
    }

    /// Expand common journal abbrev for fuzzy matching.
    fn expand_journal_abbrevs(norm: &str) -> String {
        let words: Vec<&str> = norm.split_whitespace().collect();
        let expanded: Vec<&str> = words.iter().map(|w| {
            match *w {
                "j" | "jour" => "journal",
                "int" | "intl" => "international",
                "sci" => "science",
                "eng" => "engineering",
                "tech" => "technology",
                "res" => "research",
                "lett" => "letters",
                "proc" | "proceed" => "proceedings",
                "trans" => "transactions",
                "rev" => "review",
                "adv" | "advan" => "advanced",
                "appl" => "applied",
                "comput" => "computer",
                "inf" => "information",
                "syst" => "systems",
                "mater" => "materials",
                "chem" => "chemistry",
                "phys" => "physics",
                "biol" => "biology",
                "med" => "medicine",
                "elec" => "electrical",
                "electron" => "electronics",
                "mech" => "mechanical",
                "civ" => "civil",
                "environ" | "env" => "environmental",
                "nat" => "natural",
                "bull" => "bulletin",
                "mag" => "magazine",
                "rept" | "rep" => "report",
                "ann" => "annals",
                "arch" => "archives",
                "comm" | "commun" => "communications",
                "conf" => "conference",
                "dev" | "develop" => "development",
                "educ" => "education",
                "exp" => "experimental",
                "ind" | "industr" => "industrial",
                "inst" => "institute",
                "math" => "mathematics",
                "micro" => "microscopy",
                "mol" => "molecular",
                "nano" => "nanotechnology",
                "neurol" => "neurology",
                "num" => "numerical",
                "pharm" => "pharmaceutical",
                "polym" => "polymers",
                "pract" => "practice",
                "prog" => "progress",
                "quant" => "quantum",
                "soc" => "society",
                "stat" => "statistics",
                "struct" => "structural",
                "surv" => "survey",
                "theor" => "theoretical",
                _ => *w,
            }
        }).collect();
        expanded.join(" ")
    }

    /// Contract full journal name words to their abbreviated forms (reverse of expand).
    fn contract_journal_abbrevs(norm: &str) -> String {
        let words: Vec<&str> = norm.split_whitespace().collect();
        let contracted: Vec<&str> = words.iter().map(|w| {
            match *w {
                "journal" => "j",
                "international" => "int",
                "science" => "sci",
                "engineering" => "eng",
                "technology" => "tech",
                "research" => "res",
                "letters" => "lett",
                "proceedings" => "proc",
                "transactions" => "trans",
                "review" => "rev",
                "advanced" => "adv",
                "applied" => "appl",
                "computer" => "comput",
                "information" => "inf",
                "systems" => "syst",
                "materials" => "mater",
                "chemistry" => "chem",
                "physics" => "phys",
                "biology" => "biol",
                "medicine" => "med",
                "electrical" => "elec",
                "electronics" => "electron",
                "mechanical" => "mech",
                "civil" => "civ",
                "environmental" => "environ",
                "natural" => "nat",
                "bulletin" => "bull",
                "magazine" => "mag",
                "annals" => "ann",
                "archives" => "arch",
                "communications" => "commun",
                "conference" => "conf",
                "development" => "dev",
                "education" => "educ",
                "experimental" => "exp",
                "industrial" => "ind",
                "institute" => "inst",
                "mathematics" => "math",
                "molecular" => "mol",
                "pharmaceutical" => "pharm",
                "polymers" => "polym",
                "progress" => "prog",
                "society" => "soc",
                "statistics" => "stat",
                "theoretical" => "theor",
                _ => *w,
            }
        }).collect();
        contracted.join(" ")
    }

    /// Common English stop words to filter for token-overlap matching.
    fn is_stop_word(w: &str) -> bool {
        matches!(w, "the" | "of" | "and" | "in" | "on" | "at" | "for" | "to" | "a" | "an" | "is" | "by" | "with" | "from" | "its")
    }

    /// Initialize the journal_rankings table from embedded JSON data.
    /// Only runs if the table is empty (first launch or data reset).
    pub fn init_journal_rankings(&self) -> Result<()> {
        let conn = self.conn.lock();

        // Check if data already loaded
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM journal_rankings",
            [],
            |row| row.get(0),
        )?;
        if count > 0 {
            return Ok(());
        }

        // Parse embedded JSON data
        let json_data = include_str!("../journal_rankings.json");
        let entries: Vec<serde_json::Value> = serde_json::from_str(json_data)
            .map_err(|e| anyhow::anyhow!("解析分区表 JSON 失败: {e}"))?;

        // Batch insert using a transaction for performance
        let tx = conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO journal_rankings (journal_norm, journal, zone, is_top, is_oa)
                 VALUES (?1, ?2, ?3, ?4, ?5)"
            )?;
            for entry in &entries {
                let journal = entry["journal"].as_str().unwrap_or("");
                let zone = entry["zone"].as_i64().unwrap_or(4) as i32;
                let is_top = entry["is_top"].as_bool().unwrap_or(false);
                let is_oa = entry["is_oa"].as_bool().unwrap_or(false);
                let norm = Self::normalize_journal(journal);
                if !norm.is_empty() {
                    stmt.execute(params![norm, journal, zone, is_top as i32, is_oa as i32])?;
                }
            }
        }
        tx.commit()?;

        eprintln!("[db] journal rankings initialized: {} entries", entries.len());
        Ok(())
    }

    /// Look up a journal's CAS ranking by name.
    /// Tries multiple strategies in order:
    ///   1. Exact normalized match (case/punctuation insensitive)
    ///   2. Abbreviation-expanded match
    ///   3. Substring / containment match
    ///   4. Significant-token overlap (≥60% match)
    pub fn lookup_journal_ranking(&self, journal_name: &str) -> Result<Option<JournalRanking>> {
        let conn = self.conn.lock();
        let norm = Self::normalize_journal(journal_name);
        if norm.is_empty() {
            return Ok(None);
        }

        let make_ranking = |row: &rusqlite::Row| -> rusqlite::Result<JournalRanking> {
            Ok(JournalRanking {
                journal: row.get(0)?,
                zone: row.get(1)?,
                is_top: row.get::<_, i32>(2)? != 0,
                is_oa: row.get::<_, i32>(3)? != 0,
            })
        };

        // 1. Exact normalized match
        let mut stmt = conn.prepare(
            "SELECT journal, zone, is_top, is_oa FROM journal_rankings WHERE journal_norm = ?1"
        )?;
        if let Ok(row) = stmt.query_row(params![&norm], make_ranking) {
            return Ok(Some(row));
        }

        // 2. Abbreviation-expanded match (query has abbreviations, DB has full names)
        let expanded = Self::expand_journal_abbrevs(&norm);
        if expanded != norm {
            let mut stmt2 = conn.prepare(
                "SELECT journal, zone, is_top, is_oa FROM journal_rankings WHERE journal_norm = ?1"
            )?;
            let row = stmt2.query_row(params![&expanded], make_ranking).ok();
            if let Some(row) = row {
                return Ok(Some(row));
            };
        }

        // 2b. Abbreviation-contracted match (query has full names, DB has abbreviations)
        let contracted = Self::contract_journal_abbrevs(&norm);
        if contracted != norm && contracted != expanded {
            let mut stmt2b = conn.prepare(
                "SELECT journal, zone, is_top, is_oa FROM journal_rankings WHERE journal_norm = ?1"
            )?;
            if let Ok(row) = stmt2b.query_row(params![&contracted], make_ranking) {
                return Ok(Some(row));
            }
        }

        // 3. Substring / containment match
        let pattern = format!("%{}%", norm);
        let mut stmt3 = conn.prepare(
            "SELECT journal, zone, is_top, is_oa FROM journal_rankings
             WHERE ?1 LIKE '%' || journal_norm || '%' OR journal_norm LIKE ?2
             ORDER BY LENGTH(journal_norm) DESC LIMIT 1"
        )?;
        if let Ok(row) = stmt3.query_row(params![&norm, &pattern], make_ranking) {
            return Ok(Some(row));
        }

        // 4. Token-overlap fuzzy match: gather all DB entries and compare significant tokens
        let query_tokens: std::collections::HashSet<&str> = expanded
            .split_whitespace()
            .filter(|w| !Self::is_stop_word(w) && w.len() > 2)
            .collect();

        if query_tokens.len() >= 2 {
            let mut stmt4 = conn.prepare(
                "SELECT journal, zone, is_top, is_oa, journal_norm FROM journal_rankings
                 WHERE LENGTH(journal_norm) > 5"
            )?;
            let rows = stmt4.query_map([], make_ranking)?;

            let mut best_match: Option<(JournalRanking, f64)> = None;
            // We need journal_norm for comparison, so use a separate query
            drop(rows);
            drop(stmt4);

            let mut stmt5 = conn.prepare(
                "SELECT journal, zone, is_top, is_oa, journal_norm FROM journal_rankings
                 WHERE LENGTH(journal_norm) > 5"
            )?;
            let mut rows5 = stmt5.query([])?;
            while let Some(row) = rows5.next()? {
                let db_norm: String = row.get(4)?;
                let db_tokens: std::collections::HashSet<&str> = db_norm
                    .split_whitespace()
                    .filter(|w| !Self::is_stop_word(w) && w.len() > 2)
                    .collect();

                if db_tokens.is_empty() {
                    continue;
                }

                let common = query_tokens.intersection(&db_tokens).count();
                let overlap = common as f64 / std::cmp::max(query_tokens.len(), db_tokens.len()) as f64;

                if overlap >= 0.6 {
                    let is_better = match &best_match {
                        Some((_, prev_overlap)) => overlap > *prev_overlap,
                        None => true,
                    };
                    if is_better {
                        best_match = Some((JournalRanking {
                            journal: row.get(0)?,
                            zone: row.get(1)?,
                            is_top: row.get::<_, i32>(2)? != 0,
                            is_oa: row.get::<_, i32>(3)? != 0,
                        }, overlap));
                    }
                }
            }

            if let Some((ranking, _)) = best_match {
                return Ok(Some(ranking));
            }
        }

        Ok(None)
    }

    // ────────────────────── Reading Sessions ──────────────────────

    /// Log a reading session.
    pub fn log_reading_session(
        &self,
        paper_id: &str,
        paper_name: &str,
        start_time: &str,
        end_time: &str,
        duration_seconds: i64,
    ) -> Result<()> {
        let conn = self.conn.lock();
        // Extract date and hour from start_time (ISO 8601 format: "2026-06-08T14:30:00")
        let date = start_time.get(0..10).unwrap_or("unknown").to_string();
        let hour: i32 = start_time
            .get(11..13)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        conn.execute(
            "INSERT INTO reading_sessions (paper_id, paper_name, start_time, end_time, duration_seconds, date, hour)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![paper_id, paper_name, start_time, end_time, duration_seconds, date, hour],
        )?;
        Ok(())
    }

    /// Get total reading time in seconds across all sessions.
    pub fn get_total_reading_seconds(&self) -> Result<i64> {
        let conn = self.conn.lock();
        let total: i64 = conn.query_row(
            "SELECT COALESCE(SUM(duration_seconds), 0) FROM reading_sessions",
            [],
            |row| row.get(0),
        )?;
        Ok(total)
    }

    /// Get per-paper reading time leaderboard (top N).
    pub fn get_paper_reading_ranking(&self, limit: i32) -> Result<Vec<(String, String, i64)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT paper_id, paper_name, SUM(duration_seconds) as total
             FROM reading_sessions
             GROUP BY paper_id
             ORDER BY total DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Get daily reading time distribution (date -> total seconds) for last N days.
    pub fn get_daily_reading_distribution(&self, days: i32) -> Result<Vec<(String, i64)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT date, SUM(duration_seconds) as total
             FROM reading_sessions
             WHERE date >= date('now', ?1 || ' days')
             GROUP BY date
             ORDER BY date ASC",
        )?;
        let rows = stmt.query_map(params![-days], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Get hourly reading time distribution (hour 0-23 -> total seconds).
    pub fn get_hourly_reading_distribution(&self) -> Result<Vec<(i32, i64)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT hour, SUM(duration_seconds) as total
             FROM reading_sessions
             GROUP BY hour
             ORDER BY hour ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    // ────────────────────── Full-Text Search (FTS5) ──────────────────────

    /// Index a paper's text content with metadata (char_count, language detection).
    /// Replaces any existing index entries for this paper_id.
    pub fn index_paper_text(
        &self,
        paper_id: &str,
        pages: &[(u32, String)], // (page_index, text)
    ) -> Result<()> {
        let conn = self.conn.lock();
        eprintln!("[db] index_paper_text: paper_id={}, pages={}", paper_id, pages.len());
        // Remove old entries
        let deleted = conn.execute(
            "DELETE FROM papers_fts WHERE paper_id = ?1",
            params![paper_id],
        )?;
        eprintln!("[db] Deleted {} old index entries for paper_id={}", deleted, paper_id);
        // Detect dominant language across all pages
        let all_text: String = pages.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>().join(" ");
        let language = detect_text_language(&all_text);
        eprintln!("[db] Detected language: {}", language);
        // Insert new entries
        let mut inserted = 0u32;
        for (page_idx, text) in pages {
            if !text.trim().is_empty() {
                let char_count = text.chars().count() as i32;
                conn.execute(
                    "INSERT INTO papers_fts (paper_id, page_index, text, char_count, language) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![paper_id, *page_idx as i32, text, char_count, &language],
                )?;
                inserted += 1;
            }
        }
        eprintln!("[db] Inserted {} new index entries for paper_id={}", inserted, paper_id);
        Ok(())
    }

    /// Check if a paper has been indexed for full-text search.
    pub fn is_paper_indexed(&self, paper_id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM papers_fts WHERE paper_id = ?1",
            params![paper_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Delete FTS index entries for a paper.
    pub fn delete_paper_index(&self, paper_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM papers_fts WHERE paper_id = ?1",
            params![paper_id],
        )?;
        Ok(())
    }

    /// Search a SINGLE paper's indexed text using SQL LIKE (CJK-friendly).
    /// Returns (page_index, char_offset, snippet) for each page with a match.
    pub fn search_paper_fts(
        &self,
        paper_id: &str,
        query: &str,
        limit: i32,
    ) -> Result<Vec<(i32, i32, String)>> {
        let conn = self.conn.lock();
        let trimmed = query.trim().to_string();
        if trimmed.is_empty() {
            return Ok(vec![]);
        }

        let pattern = format!("%{}%", trimmed);
        let mut stmt = conn.prepare(
            "SELECT page_index, text FROM papers_fts
             WHERE paper_id = ?1 AND text LIKE ?2
             ORDER BY page_index
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![paper_id, pattern, limit], |row| {
            Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?))
        })?;

        let mut out = Vec::new();
        for r in rows {
            let (page_index, text) = r?;
            let lower_text = text.to_lowercase();
            let lower_query = trimmed.to_lowercase();
            if let Some(byte_offset) = lower_text.find(&lower_query) {
                let char_offset = text[..byte_offset].chars().count() as i32;
                let snippet = Self::build_snippet(&text, &trimmed, 120);
                out.push((page_index, char_offset, snippet));
            }
        }
        Ok(out)
    }

    /// Get all indexed page texts for a specific paper.
    /// Returns (page_index, text) sorted by page.
    pub fn get_paper_pages_text(&self, paper_id: &str) -> Result<Vec<(u32, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT page_index, text FROM papers_fts
             WHERE paper_id = ?1
             ORDER BY page_index",
        )?;
        let rows = stmt.query_map(params![paper_id], |row| {
            Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Get the detected language for a paper's index.
    pub fn get_paper_language(&self, paper_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT language FROM papers_fts WHERE paper_id = ?1 LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![paper_id], |row| row.get(0))?;
        if let Some(r) = rows.next() {
            Ok(Some(r?))
        } else {
            Ok(None)
        }
    }

    /// Extract a context window around the first match and add `<mark>` highlighting.
    fn build_snippet(text: &str, query: &str, context_chars: usize) -> String {
        let lower_text = text.to_lowercase();
        let lower_query = query.to_lowercase();
        let pos = lower_text.find(&lower_query);

        let snippet = if let Some(start) = pos {
            let match_end = start + query.len();
            let ctx_start = if start > context_chars { start - context_chars } else { 0 };
            let ctx_end = std::cmp::min(match_end + context_chars, text.len());
            // Adjust to char boundaries
            let ctx_start = text.floor_char_boundary(ctx_start);
            let ctx_end = text.ceil_char_boundary(ctx_end);

            let prefix = if ctx_start > 0 { "..." } else { "" };
            let suffix = if ctx_end < text.len() { "..." } else { "" };
            format!(
                "{}{}<mark>{}</mark>{}{}",
                prefix,
                &text[ctx_start..start],
                &text[start..match_end],
                &text[match_end..ctx_end],
                suffix,
            )
        } else {
            // No match in original text (shouldn't happen), return beginning
            let end = std::cmp::min(240, text.len());
            let end = text.ceil_char_boundary(end);
            format!("{}...", &text[..end])
        };

        // Escape HTML entities (except our <mark> tags)
        snippet
    }

    /// Get all indexed paper IDs (for status display).
    pub fn list_indexed_paper_ids(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT DISTINCT paper_id FROM papers_fts",
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    // ────────────────────── OCR Paragraph Cache ──────────────────────

    /// Get cached OCR text for a specific paragraph region.
    /// Coordinates are rounded to integers for cache key matching.
    pub fn get_ocr_cache(
        &self,
        paper_id: &str,
        page_index: u32,
        xmin: i32,
        ymin: i32,
        xmax: i32,
        ymax: i32,
    ) -> Result<Option<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT text FROM ocr_paragraph_cache
             WHERE paper_id = ?1 AND page_index = ?2
               AND xmin = ?3 AND ymin = ?4 AND xmax = ?5 AND ymax = ?6",
        )?;
        let mut rows = stmt.query(params![paper_id, page_index as i32, xmin, ymin, xmax, ymax])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    /// Store OCR text for a specific paragraph region.
    pub fn set_ocr_cache(
        &self,
        paper_id: &str,
        page_index: u32,
        xmin: i32,
        ymin: i32,
        xmax: i32,
        ymax: i32,
        text: &str,
        model_id: &str,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO ocr_paragraph_cache (paper_id, page_index, xmin, ymin, xmax, ymax, text, model_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(paper_id, page_index, xmin, ymin, xmax, ymax)
             DO UPDATE SET text = excluded.text, model_id = excluded.model_id, created_at = datetime('now')",
            params![paper_id, page_index as i32, xmin, ymin, xmax, ymax, text, model_id],
        )?;
        Ok(())
    }

    /// Get all cached OCR entries for a specific page.
    /// Returns (xmin, ymin, xmax, ymax, text) sorted by vertical then horizontal position.
    pub fn get_ocr_cache_page(
        &self,
        paper_id: &str,
        page_index: u32,
    ) -> Result<Vec<(i32, i32, i32, i32, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT xmin, ymin, xmax, ymax, text FROM ocr_paragraph_cache
             WHERE paper_id = ?1 AND page_index = ?2
             ORDER BY ymin ASC, xmin ASC",
        )?;
        let rows = stmt.query_map(params![paper_id, page_index as i32], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Check if a page has any OCR cache entries.
    pub fn has_ocr_cache_page(&self, paper_id: &str, page_index: u32) -> Result<bool> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ocr_paragraph_cache
             WHERE paper_id = ?1 AND page_index = ?2",
            params![paper_id, page_index as i32],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Clear all OCR cache entries for a specific paper.
    pub fn clear_ocr_cache(&self, paper_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM ocr_paragraph_cache WHERE paper_id = ?1",
            params![paper_id],
        )?;
        Ok(())
    }
}

/// Simple language detection based on character frequency analysis.
/// Returns "zh" for Chinese-dominant, "ja" for Japanese, "en" for Latin-dominant, "mixed" otherwise.
pub fn detect_text_language(text: &str) -> String {
    let mut cjk_count = 0u32;
    let mut latin_count = 0u32;
    let mut hiragana_count = 0u32;
    let mut total = 0u32;

    for ch in text.chars() {
        if ch.is_whitespace() || ch.is_ascii_punctuation() {
            continue;
        }
        total += 1;
        let cp = ch as u32;
        if (0x4E00..=0x9FFF).contains(&cp) || (0x3400..=0x4DBF).contains(&cp) {
            cjk_count += 1;
        } else if (0x3040..=0x309F).contains(&cp) || (0x30A0..=0x30FF).contains(&cp) {
            hiragana_count += 1;
        } else if ch.is_ascii_alphabetic() {
            latin_count += 1;
        }
    }

    if total == 0 {
        return "unknown".to_string();
    }

    let cjk_ratio = cjk_count as f64 / total as f64;
    let latin_ratio = latin_count as f64 / total as f64;
    let kana_ratio = hiragana_count as f64 / total as f64;

    if kana_ratio > 0.05 {
        "ja".to_string()
    } else if cjk_ratio > 0.3 {
        "zh".to_string()
    } else if latin_ratio > 0.5 {
        "en".to_string()
    } else {
        "mixed".to_string()
    }
}
