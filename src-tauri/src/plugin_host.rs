use anyhow::Result;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, State};

use crate::pptx_gen::SlideData;
use crate::settings_db::{PaperRecord, SettingsDb};
use pdfium_render::prelude::*;

// ── Permission check helper ─────────────────────────────────────

/// Require a permission for a plugin call; returns Err if not granted.
fn require_permission(
    state: &State<'_, PluginState>,
    plugin_id: &str,
    permission: &str,
) -> std::result::Result<(), String> {
    // Builtin plugins (those whose id is registered as builtin) bypass permission checks
    // since they ship with the app. External plugins are strictly enforced.
    // System-internal pluginIds (prefixed with __) also bypass checks.
    if state.is_builtin(plugin_id) || plugin_id.starts_with("__") {
        return Ok(());
    }
    if !state.has_permission(plugin_id, permission) {
        return Err(format!(
            "Plugin '{}' does not have permission '{}'. Add it to plugin.json permissions.",
            plugin_id, permission
        ));
    }
    Ok(())
}

/// Plugin manifest
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub min_app_version: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub permissions: Vec<String>,
    pub entry: PluginEntry,
    pub activation: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PluginEntry {
    /// Main entry point (sidecar binary or shell script path)
    pub main: Option<String>,
    /// Optional: HTML file to render a web panel
    pub renderer: Option<String>,
}

/// Registered extension points
#[derive(Default)]
#[allow(dead_code)]
pub struct ExtensionRegistry {
    /// plugin_id -> Vec<extension_point_name>
    pub hooks: Mutex<HashMap<String, Vec<String>>>,
}

/// IDs of builtin plugins (set by the frontend at startup)
pub struct BuiltinRegistry {
    ids: Mutex<Vec<String>>,
}

impl Default for BuiltinRegistry {
    fn default() -> Self {
        Self {
            ids: Mutex::new(Vec::new()),
        }
    }
}

/// Plugin manager state
#[allow(dead_code)]
pub struct PluginState {
    /// Installed plugin manifests
    pub manifests: Mutex<HashMap<String, PluginManifest>>,
    /// Plugin data directory: {app_data}/plugins/
    pub plugins_dir: PathBuf,
    /// Extension point registry
    pub registry: ExtensionRegistry,
    /// Builtin plugin IDs
    pub builtins: BuiltinRegistry,
}

impl PluginState {
    pub fn new(app_data_dir: &Path) -> Self {
        let plugins_dir = app_data_dir.join("plugins");
        fs::create_dir_all(&plugins_dir).ok();
        Self {
            manifests: Mutex::new(HashMap::new()),
            plugins_dir,
            registry: ExtensionRegistry::default(),
            builtins: BuiltinRegistry::default(),
        }
    }

    /// Scan all plugins under plugins_dir
    pub fn scan_plugins(&self) -> Vec<String> {
        let mut ids = Vec::new();
        let mut manifests = self.manifests.lock();

        let entries = match fs::read_dir(&self.plugins_dir) {
            Ok(e) => e,
            Err(_) => return ids,
        };

        for entry in entries.flatten() {
            let plugin_dir = entry.path();
            if !plugin_dir.is_dir() {
                continue;
            }
            let manifest_path = plugin_dir.join("plugin.json");
            if !manifest_path.exists() {
                continue;
            }
            match fs::read_to_string(&manifest_path) {
                Ok(content) => match serde_json::from_str::<PluginManifest>(&content) {
                    Ok(manifest) => {
                        let id = manifest.id.clone();
                        manifests.insert(id.clone(), manifest);
                        ids.push(id);
                    }
                    Err(e) => {
                        eprintln!("[plugin_host] invalid manifest at {:?}: {e}", manifest_path);
                    }
                },
                Err(e) => {
                    eprintln!("[plugin_host] failed to read {:?}: {e}", manifest_path);
                }
            }
        }
        ids
    }

    /// Check if a plugin has a given permission
    pub fn has_permission(&self, plugin_id: &str, permission: &str) -> bool {
        self.manifests
            .lock()
            .get(plugin_id)
            .map(|m| m.permissions.iter().any(|p| p == permission))
            .unwrap_or(false)
    }

    /// Mark a plugin ID as builtin (called from frontend)
    pub fn register_builtin(&self, plugin_id: &str) {
        let mut ids = self.builtins.ids.lock();
        if !ids.contains(&plugin_id.to_string()) {
            ids.push(plugin_id.to_string());
        }
    }

    /// Check if a plugin is builtin
    pub fn is_builtin(&self, plugin_id: &str) -> bool {
        self.builtins.ids.lock().contains(&plugin_id.to_string())
    }

    /// Read plugin entry file content (for frontend dynamic loading)
    pub fn read_entry(&self, plugin_id: &str, entry_path: &str) -> Result<String, String> {
        let plugin_dir = self.plugins_dir.join(plugin_id);
        let full_path = plugin_dir.join(entry_path);

        if !full_path.exists() {
            return Err(format!("Entry file not found: {}", full_path.display()));
        }

        fs::read_to_string(&full_path)
            .map_err(|e| format!("Failed to read entry: {e}"))
    }
}

// ── Tauri Commands ──────────────────────────────────────

#[tauri::command]
pub fn plugin_list(state: State<'_, PluginState>) -> Vec<PluginManifest> {
    state.manifests.lock().values().cloned().collect()
}

#[tauri::command]
pub fn plugin_get_manifest(
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<PluginManifest, String> {
    state
        .manifests
        .lock()
        .get(&plugin_id)
        .cloned()
        .ok_or_else(|| format!("Plugin '{}' not found", plugin_id))
}

#[tauri::command]
pub fn plugin_emit_event(
    app: AppHandle,
    event: String,
    payload: String,
) -> Result<(), String> {
    let _ = app.emit(&event, payload)
        .map_err(|e| format!("Failed to emit event: {e}"));
    Ok(())
}

/// Read plugin entry file (for frontend dynamic loading of external plugin code)
#[tauri::command]
pub fn plugin_read_entry(
    plugin_id: String,
    entry_path: String,
    state: State<'_, PluginState>,
) -> Result<String, String> {
    state.read_entry(&plugin_id, &entry_path)
}

/// Register a builtin plugin ID (called by frontend at startup)
#[tauri::command]
pub fn plugin_register_builtin(
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<(), String> {
    state.register_builtin(&plugin_id);
    Ok(())
}

// ── PDF APIs (permission-checked) ─────────────────────────────

/// Get full PDF text
#[tauri::command]
pub async fn plugin_get_full_pdf_text(
    file_path: String,
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<String, String> {
    require_permission(&state, &plugin_id, "pdf:read")?;
    crate::commands::misc::get_full_pdf_text(&file_path)
}

/// Extract embedded images from PDF
#[tauri::command]
pub async fn plugin_extract_pdf_images(
    file_path: String,
    page_indices: Option<Vec<u32>>,
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<Vec<PdfImageInfo>, String> {
    require_permission(&state, &plugin_id, "pdf:read")?;
    crate::commands::pdf::extract_pdf_images(&file_path, page_indices.as_deref())
}

/// Extract images via lopdf (fallback)
#[tauri::command]
pub async fn plugin_extract_pdf_images_lopdf(
    file_path: String,
    page_indices: Option<Vec<u32>>,
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<Vec<PdfImageInfo>, String> {
    require_permission(&state, &plugin_id, "pdf:read")?;
    crate::commands::pdf::extract_pdf_images_with_lopdf(&file_path, page_indices.as_deref())
}

/// Get PDF page count
#[tauri::command]
pub async fn plugin_pdf_page_count(
    file_path: String,
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<u32, String> {
    require_permission(&state, &plugin_id, "pdf:read")?;
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<u32, String> {
        let bindings = crate::commands::bind_pdfium_with_candidates()?;
        let pdfium = Pdfium::new(bindings);
        let document = pdfium
            .load_pdf_from_file(&path, None)
            .map_err(|e| format!("Failed to open PDF: {e}"))?;
        Ok(document.pages().len() as u32)
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?
}

/// Get text of a single page
#[tauri::command]
pub async fn plugin_pdf_page_text(
    file_path: String,
    page_index: u32,
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<String, String> {
    require_permission(&state, &plugin_id, "pdf:read")?;
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let bindings = crate::commands::bind_pdfium_with_candidates()?;
        let pdfium = Pdfium::new(bindings);
        let document = pdfium
            .load_pdf_from_file(&path, None)
            .map_err(|e| format!("Failed to open PDF: {e}"))?;
        let page = document
            .pages()
            .get(page_index as u16)
            .map_err(|e| format!("Failed to get page {page_index}: {e}"))?;
        let text = page.text().map(|t| t.all()).unwrap_or_default();
        Ok(text)
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?
}

/// PDF outline items (flat list, frontend builds tree)
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PluginPdfOutlineItem {
    pub title: String,
    pub page_index: u32,
    pub level: u32,
}

/// Get PDF outline (bookmarks)
#[tauri::command]
pub async fn plugin_pdf_outline(
    file_path: String,
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<Vec<PluginPdfOutlineItem>, String> {
    require_permission(&state, &plugin_id, "pdf:read")?;
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<PluginPdfOutlineItem>, String> {
        let bindings = crate::commands::bind_pdfium_with_candidates()?;
        let pdfium = Pdfium::new(bindings);
        let document = pdfium
            .load_pdf_from_file(&path, None)
            .map_err(|e| format!("Failed to open PDF: {e}"))?;

        let mut items: Vec<PluginPdfOutlineItem> = Vec::new();
        fn walk(
            bookmark: &pdfium_render::prelude::PdfBookmark<'_>,
            depth: u32,
            items: &mut Vec<PluginPdfOutlineItem>,
        ) {
            let title = bookmark.title().unwrap_or_default();
            let page_index = bookmark
                .destination()
                .and_then(|dest| dest.page_index().ok())
                .map(|idx| idx as u32)
                .unwrap_or(0);
            items.push(PluginPdfOutlineItem { title, page_index, level: depth });
            if let Some(child) = bookmark.first_child() {
                walk(&child, depth + 1, items);
            }
            if let Some(sibling) = bookmark.next_sibling() {
                walk(&sibling, depth, items);
            }
        }
        if let Some(root) = document.bookmarks().root() {
            walk(&root, 0, &mut items);
        }
        Ok(items)
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?
}

/// Search result within PDF
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PluginPdfSearchResult {
    pub page_index: u32,
    pub text: String,
}

/// Search PDF text across all pages
#[tauri::command]
pub async fn plugin_pdf_search(
    file_path: String,
    query: String,
    case_sensitive: Option<bool>,
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<Vec<PluginPdfSearchResult>, String> {
    require_permission(&state, &plugin_id, "pdf:read")?;
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }
    let cs = case_sensitive.unwrap_or(false);
    let q = if cs { query.clone() } else { query.to_lowercase() };

    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<PluginPdfSearchResult>, String> {
        let bindings = crate::commands::bind_pdfium_with_candidates()?;
        let pdfium = Pdfium::new(bindings);
        let document = pdfium
            .load_pdf_from_file(&path, None)
            .map_err(|e| format!("Failed to open PDF: {e}"))?;

        let page_count = document.pages().len();
        let mut results = Vec::new();

        for idx in 0..page_count {
            if let Ok(page) = document.pages().get(idx as u16) {
                if let Some(text_obj) = page.text().ok() {
                    let full = text_obj.all();
                    let haystack = if cs { full.clone() } else { full.to_lowercase() };
                    if haystack.contains(&q) {
                        // Extract a snippet around the match
                        if let Some(pos) = haystack.find(&q) {
                            let start = pos.saturating_sub(40);
                            let end = (pos + q.len() + 40).min(full.len());
                            results.push(PluginPdfSearchResult {
                                page_index: idx as u32,
                                text: full[start..end].to_string(),
                            });
                        }
                    }
                }
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?
}

/// PDF metadata info
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PluginPdfInfo {
    pub page_count: u32,
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub creator: Option<String>,
    pub file_size: Option<u64>,
}

/// Get PDF metadata
#[tauri::command]
pub async fn plugin_pdf_info(
    file_path: String,
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<PluginPdfInfo, String> {
    require_permission(&state, &plugin_id, "pdf:read")?;
    let path_buf = PathBuf::from(&file_path);
    if !path_buf.exists() {
        return Err("File not found".to_string());
    }
    let file_size = fs::metadata(&path_buf).ok().map(|m| m.len());

    tauri::async_runtime::spawn_blocking(move || -> Result<PluginPdfInfo, String> {
        let bindings = crate::commands::bind_pdfium_with_candidates()?;
        let pdfium = Pdfium::new(bindings);
        let document = pdfium
            .load_pdf_from_file(&path_buf, None)
            .map_err(|e| format!("Failed to open PDF: {e}"))?;

        let page_count = document.pages().len() as u32;
        let metadata = document.metadata();

        let get_meta = |tag_type: PdfDocumentMetadataTagType| -> Option<String> {
            metadata.get(tag_type)
                .map(|tag| tag.value().to_string())
                .filter(|v| !v.is_empty())
        };

        Ok(PluginPdfInfo {
            page_count,
            title: get_meta(PdfDocumentMetadataTagType::Title),
            author: get_meta(PdfDocumentMetadataTagType::Author),
            subject: get_meta(PdfDocumentMetadataTagType::Subject),
            creator: get_meta(PdfDocumentMetadataTagType::Creator),
            file_size,
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?
}

// ── PPTX APIs (permission-checked) ──────────────────────────────

/// Generate a PPTX file
#[tauri::command]
pub async fn plugin_generate_pptx(
    output_path: String,
    title: String,
    slides: Vec<SlideData>,
    template_path: Option<String>,
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<(), String> {
    require_permission(&state, &plugin_id, "file:write")?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::pptx_gen::generate_pptx(
            &output_path,
            &title,
            &slides,
            template_path.as_deref(),
        )
        .map_err(|e| format!("PPTX generation failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?
}

/// Convert a PPTX template to HTML
#[tauri::command]
pub async fn plugin_convert_template_to_html(
    template_path: String,
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<String, String> {
    require_permission(&state, &plugin_id, "file:read")?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&template_path);
        pptx2html_core::convert_file(path)
            .map_err(|e| format!("Template-to-HTML conversion failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?
}

// ── Metadata API (permission-checked) ─────────────────────────────

/// Extract first-page metadata via pdfium (lightweight, no ONNX).
/// For full metadata with AI-assisted detection, frontend should use
/// the existing `extract_first_page_metadata` tauri command directly.
#[tauri::command]
pub async fn plugin_extract_first_page_metadata(
    file_path: String,
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<serde_json::Value, String> {
    require_permission(&state, &plugin_id, "pdf:read")?;
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let bindings = crate::commands::bind_pdfium_with_candidates()?;
        let pdfium = Pdfium::new(bindings);
        let document = pdfium
            .load_pdf_from_file(&path, None)
            .map_err(|e| format!("Failed to open PDF: {e}"))?;

        let page = document
            .pages()
            .get(0)
            .map_err(|e| format!("Failed to get first page: {e}"))?;
        let full_text = page.text().map(|t| t.all()).unwrap_or_default();

        let metadata = document.metadata();
        let get_meta = |tag_type: PdfDocumentMetadataTagType| -> Option<String> {
            metadata.get(tag_type)
                .map(|tag| tag.value().to_string())
                .filter(|v| !v.is_empty())
        };

        // DOI regex
        let doi = {
            let re = regex::Regex::new(r#"10\.\d{4,9}/[^\s,;"'<>\}\]]+"#).ok();
            re.and_then(|r| {
                r.find(&full_text).map(|m| {
                    let mut d = m.as_str().to_string();
                    while d.ends_with(|c: char| ".);]>}".contains(c)) { d.pop(); }
                    d
                })
            })
        };

        let mut map = serde_json::Map::new();
        if let Some(t) = get_meta(PdfDocumentMetadataTagType::Title) {
            map.insert("title".into(), serde_json::Value::String(t));
        }
        if let Some(a) = get_meta(PdfDocumentMetadataTagType::Author) {
            map.insert("authors".into(), serde_json::Value::String(a));
        }
        if let Some(d) = doi {
            map.insert("doi".into(), serde_json::Value::String(d));
        }
        Ok(serde_json::Value::Object(map))
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?
}

// ── Storage APIs (permission-checked) ─────────────────────────────

#[tauri::command]
pub fn plugin_storage_get(
    key: String,
    plugin_id: String,
    state: State<'_, PluginState>,
    db: State<'_, SettingsDb>,
) -> Result<Option<String>, String> {
    require_permission(&state, &plugin_id, "storage:read")?;
    let conn = db.conn.lock();
    crate::plugin_storage::storage_get(&conn, &plugin_id, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_storage_set(
    key: String,
    value: String,
    plugin_id: String,
    state: State<'_, PluginState>,
    db: State<'_, SettingsDb>,
) -> Result<(), String> {
    require_permission(&state, &plugin_id, "storage:write")?;
    let conn = db.conn.lock();
    crate::plugin_storage::storage_set(&conn, &plugin_id, &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_storage_delete(
    key: String,
    plugin_id: String,
    state: State<'_, PluginState>,
    db: State<'_, SettingsDb>,
) -> Result<(), String> {
    require_permission(&state, &plugin_id, "storage:write")?;
    let conn = db.conn.lock();
    crate::plugin_storage::storage_delete(&conn, &plugin_id, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_storage_list(
    plugin_id: String,
    state: State<'_, PluginState>,
    db: State<'_, SettingsDb>,
) -> Result<Vec<String>, String> {
    require_permission(&state, &plugin_id, "storage:read")?;
    let conn = db.conn.lock();
    crate::plugin_storage::storage_list(&conn, &plugin_id).map_err(|e| e.to_string())
}

// ── Paper DB APIs (permission-checked) ────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PluginPaperRecord {
    pub id: String,
    pub name: String,
    pub journal: Option<String>,
    pub date: Option<String>,
    pub metadata_extracted: bool,
}

fn paper_record_to_plugin(r: &PaperRecord) -> PluginPaperRecord {
    PluginPaperRecord {
        id: r.id.clone(),
        name: r.name.clone(),
        journal: r.journal.clone(),
        date: r.date.clone(),
        metadata_extracted: r.title.is_some(),
    }
}

#[tauri::command]
pub fn plugin_query_papers(
    search: Option<String>,
    journal: Option<String>,
    plugin_id: String,
    state: State<'_, PluginState>,
    db: State<'_, SettingsDb>,
) -> Result<Vec<PluginPaperRecord>, String> {
    require_permission(&state, &plugin_id, "paper:read")?;
    let papers = db.list_papers().map_err(|e| e.to_string())?;
    let results: Vec<PluginPaperRecord> = papers
        .iter()
        .filter(|p| {
            if let Some(ref s) = search {
                let s_lower = s.to_lowercase();
                if !p.name.to_lowercase().contains(&s_lower)
                    && !p.title.as_deref().unwrap_or("").to_lowercase().contains(&s_lower)
                {
                    return false;
                }
            }
            if let Some(ref j) = journal {
                if p.journal.as_deref().unwrap_or("") != j.as_str() {
                    return false;
                }
            }
            true
        })
        .map(paper_record_to_plugin)
        .collect();
    Ok(results)
}

#[tauri::command]
pub fn plugin_get_paper_metadata(
    paper_id: String,
    plugin_id: String,
    state: State<'_, PluginState>,
    db: State<'_, SettingsDb>,
) -> Result<Option<serde_json::Value>, String> {
    require_permission(&state, &plugin_id, "paper:read")?;
    let papers = db.list_papers().map_err(|e| e.to_string())?;
    let found = papers.iter().find(|p| p.id == paper_id);
    match found {
        Some(p) => {
            let val = serde_json::to_value(p).map_err(|e| e.to_string())?;
            Ok(Some(val))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn plugin_update_paper_metadata(
    paper_id: String,
    updates: serde_json::Value,
    plugin_id: String,
    state: State<'_, PluginState>,
    db: State<'_, SettingsDb>,
) -> Result<(), String> {
    require_permission(&state, &plugin_id, "paper:write")?;
    let conn = db.conn.lock();
    if let Some(obj) = updates.as_object() {
        for (key, value) in obj {
            let val_str = match value {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Null => continue,
                other => other.to_string(),
            };
            // Only allow updating known metadata fields
            let allowed = [
                "title", "title_translation", "authors", "abstract_text",
                "abstract_translation", "journal", "publisher", "date", "doi",
            ];
            if allowed.contains(&key.as_str()) {
                conn.execute(
                    &format!("UPDATE papers SET {key} = ?1 WHERE id = ?2"),
                    rusqlite::params![val_str, paper_id],
                )
                .map_err(|e| format!("Failed to update {key}: {e}"))?;
            }
        }
    }
    Ok(())
}

// ── System APIs (permission-checked) ──────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlatformInfo {
    pub os: String,
    pub arch: String,
}

#[tauri::command]
pub fn plugin_get_platform(
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<PlatformInfo, String> {
    require_permission(&state, &plugin_id, "system:info")?;
    Ok(PlatformInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}

#[tauri::command]
pub fn plugin_get_app_version(
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<String, String> {
    require_permission(&state, &plugin_id, "system:info")?;
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

/// Returns the app version without requiring any permission check.
/// Used internally by the plugin manager for version compatibility checks.
#[tauri::command]
pub fn plugin_get_app_version_public() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ── File I/O APIs (permission-checked, sandboxed) ─────────────────

/// Write a file to the plugin's data directory
#[tauri::command]
pub fn plugin_write_file(
    filename: String,
    content: String,
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<String, String> {
    require_permission(&state, &plugin_id, "file:write")?;
    let plugin_dir = state.plugins_dir.join(&plugin_id);
    let data_dir = plugin_dir.join("data");
    fs::create_dir_all(&data_dir).map_err(|e| format!("Failed to create data dir: {e}"))?;
    let target = data_dir.join(&filename);
    fs::write(&target, content.as_bytes()).map_err(|e| format!("Failed to write file: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

/// Read a file from the plugin's data directory
#[tauri::command]
pub fn plugin_read_file(
    filename: String,
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<String, String> {
    require_permission(&state, &plugin_id, "file:read")?;
    let target = state.plugins_dir.join(&plugin_id).join("data").join(&filename);
    if !target.exists() {
        return Err(format!("File not found: {}", filename));
    }
    fs::read_to_string(&target).map_err(|e| format!("Failed to read file: {e}"))
}

// ── Install from zip ──────────────────────────────────────────────

/// Install a plugin from a zip file
#[tauri::command]
pub async fn plugin_install_from_zip(
    zip_path: String,
    state: State<'_, PluginState>,
) -> Result<String, String> {
    use std::io::Read;

    let zip_bytes = fs::read(&zip_path)
        .map_err(|e| format!("Failed to read zip file: {e}"))?;

    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("Invalid zip file: {e}"))?;

    let mut plugin_dir_name: Option<String> = None;
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name().to_string();
            if name.ends_with("/plugin.json") || name.contains("/plugin.json") {
                if let Some(slash_pos) = name.find('/') {
                    let dir = &name[..slash_pos];
                    plugin_dir_name = Some(dir.to_string());
                    break;
                }
            }
        }
    }

    let install_name = plugin_dir_name.unwrap_or_else(|| {
        Path::new(&zip_path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown-plugin".to_string())
    });

    let install_dir = state.plugins_dir.join(&install_name);
    fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create plugin dir: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;
        let name = entry.name().to_string();

        if name.ends_with('/') {
            continue;
        }

        let relative_path = if let Some(slash_pos) = name.find('/') {
            &name[slash_pos + 1..]
        } else {
            &name
        };

        if relative_path.is_empty() {
            continue;
        }

        let target_path = install_dir.join(relative_path);
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).ok();
        }

        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read entry {name}: {e}"))?;
        fs::write(&target_path, &buf)
            .map_err(|e| format!("Failed to write {relative_path}: {e}"))?;
    }

    let manifest_path = install_dir.join("plugin.json");
    if !manifest_path.exists() {
        return Err("plugin.json not found in zip, please verify the plugin package format".to_string());
    }

    state.scan_plugins();

    Ok(install_name)
}

/// PDF image info (returned from the Rust side)
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PdfImageInfo {
    pub page_index: u32,
    pub image_base64: String,
    pub width: u32,
    pub height: u32,
}
