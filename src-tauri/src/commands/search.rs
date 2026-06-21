//! Global full-text search commands backed by SQLite FTS5.
//!
//! Commands:
//!   search_index_paper     — Extract text from a single PDF and add to index
//!   search_index_all       — Index all managed papers
//!   search_paper           — Full-text search within a single paper
//!   search_index_status    — Return which paper IDs are indexed
//!   search_delete_index    — Delete index for a paper
//!   search_extract_pages   — Get all page texts (indexed or fresh from PDF)

use std::path::Path;
use tauri::State;

use crate::settings_db::SettingsDb;
use super::bind_pdfium_with_candidates;
use pdfium_render::prelude::PdfPageObjectsCommon;

/// A single search result returned to the frontend.
#[derive(serde::Serialize, Clone)]
pub struct SearchResult {
    pub page_index: u32,
    pub char_offset: i32,
    pub snippet: String,
}

/// Extract raw text from every page of a PDF using pdfium.
fn extract_all_pages_text(file_path: &str) -> Result<Vec<(u32, String)>, String> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    eprintln!("[search] Opening PDF: {}", file_path);
    let bindings = bind_pdfium_with_candidates()?;
    let pdfium = pdfium_render::prelude::Pdfium::new(bindings);
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("Failed to open PDF: {e}"))?;

    let page_count = document.pages().len();
    let mut pages: Vec<(u32, String)> = Vec::with_capacity(page_count as usize);
    let mut empty_pages = 0u32;

    for page_idx in 0..page_count {
        let page = match document.pages().get(page_idx as u16) {
            Ok(p) => p,
            Err(_) => continue,
        };
        // Try the fast text() API first
        let text = match page.text() {
            Ok(t) => t.all(),
            Err(_) => {
                // Fallback: iterate text objects manually
                let mut segs = Vec::new();
                for obj in page.objects().iter() {
                    if let Some(text_obj) = obj.as_text_object() {
                        let txt = text_obj.text();
                        if !txt.trim().is_empty() {
                            segs.push(txt);
                        }
                    }
                }
                segs.join(" ")
            }
        };
        if !text.trim().is_empty() {
            pages.push((page_idx as u32, text));
        } else {
            empty_pages += 1;
        }
    }

    eprintln!(
        "[search] Extracted text from {}/{} pages ({} empty pages skipped)",
        pages.len(), page_count, empty_pages
    );
    if !pages.is_empty() {
        let total_chars: usize = pages.iter().map(|(_, t)| t.chars().count()).sum();
        eprintln!("[search] Total characters extracted: {}", total_chars);
    }

    Ok(pages)
}

/// Index a single paper's PDF into the FTS5 table.
#[tauri::command]
pub(crate) async fn search_index_paper(
    paper_id: String,
    file_path: String,
    db: State<'_, SettingsDb>,
) -> Result<u32, String> {
    eprintln!("[search] === INDEX PAPER ===");
    eprintln!("[search] paper_id: {}, file_path: {}", paper_id, file_path);

    let fp = file_path.clone();
    let pid = paper_id.clone();

    let pages = tauri::async_runtime::spawn_blocking(move || {
        extract_all_pages_text(&fp)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))??;

    let page_count = pages.len() as u32;
    eprintln!("[search] Indexing {} pages for paper_id={}", page_count, pid);

    db.index_paper_text(&pid, &pages)
        .map_err(|e| {
            eprintln!("[search] ERROR: Failed to index paper {}: {}", pid, e);
            format!("Failed to index paper: {e}")
        })?;

    // Verify indexing succeeded
    let is_indexed = db.is_paper_indexed(&pid).unwrap_or(false);
    eprintln!("[search] Index complete. is_indexed={}, pages={}", is_indexed, page_count);

    Ok(page_count)
}

/// Index all papers that have a managed_path (batch operation).
/// Emits progress events via `search-index-progress`.
#[tauri::command]
pub(crate) async fn search_index_all(
    app: tauri::AppHandle,
    db: State<'_, SettingsDb>,
) -> Result<u32, String> {
    use tauri::Emitter;

    let papers = db.list_papers().map_err(|e| e.to_string())?;
    let total = papers.len() as u32;
    let mut indexed = 0u32;

    for (i, paper) in papers.iter().enumerate() {
        let file_path = paper
            .managed_path
            .as_deref()
            .unwrap_or(&paper.original_path);

        // Skip if already indexed
        if db.is_paper_indexed(&paper.id).unwrap_or(false) {
            indexed += 1;
            let _ = app.emit(
                "search-index-progress",
                serde_json::json!({
                    "current": i + 1,
                    "total": total,
                    "paper_name": paper.name,
                    "status": "skipped",
                }),
            );
            continue;
        }

        let fp = file_path.to_string();
        let pid = paper.id.clone();

        let pages_result = tauri::async_runtime::spawn_blocking(move || {
            extract_all_pages_text(&fp)
        })
        .await;

        match pages_result {
            Ok(Ok(pages)) => {
                if let Err(e) = db.index_paper_text(&pid, &pages) {
                    eprintln!("[search] failed to index paper {}: {}", pid, e);
                } else {
                    indexed += 1;
                }
            }
            Ok(Err(e)) => {
                eprintln!("[search] failed to extract text for {}: {}", pid, e);
            }
            Err(e) => {
                eprintln!("[search] spawn_blocking failed for {}: {}", pid, e);
            }
        }

        let _ = app.emit(
            "search-index-progress",
            serde_json::json!({
                "current": i + 1,
                "total": total,
                "paper_name": paper.name,
                "status": "indexed",
            }),
        );
    }

    Ok(indexed)
}

/// Full-text search within a single paper (uses indexed data).
#[tauri::command]
pub(crate) async fn search_paper(
    paper_id: String,
    query: String,
    limit: Option<i32>,
    db: State<'_, SettingsDb>,
) -> Result<Vec<SearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    let max_results = limit.unwrap_or(100).min(500);
    eprintln!("[search] === SEARCH PAPER ===");
    eprintln!("[search] paper_id: {}, query: {:?}, limit: {}", paper_id, query, max_results);

    // Check if paper is indexed
    let is_indexed = db.is_paper_indexed(&paper_id).unwrap_or(false);
    eprintln!("[search] Paper indexed: {}", is_indexed);

    if !is_indexed {
        eprintln!("[search] Paper not indexed, returning empty results");
        return Ok(vec![]);
    }

    let raw_results = db
        .search_paper_fts(&paper_id, &query, max_results)
        .map_err(|e| {
            eprintln!("[search] ERROR: Search failed for paper {}: {}", paper_id, e);
            format!("Search failed: {e}")
        })?;

    eprintln!("[search] Found {} matching pages", raw_results.len());

    let results: Vec<SearchResult> = raw_results
        .into_iter()
        .map(|(page_index, char_offset, snippet)| SearchResult {
            page_index: page_index as u32,
            char_offset,
            snippet,
        })
        .collect();

    Ok(results)
}

/// Extract all page texts for a paper — uses index if available, else extracts fresh from PDF.
/// Returns array of { page_index, text } and the detected language.
#[tauri::command]
pub(crate) async fn search_extract_pages(
    paper_id: String,
    file_path: String,
    db: State<'_, SettingsDb>,
) -> Result<serde_json::Value, String> {
    eprintln!("[search] === EXTRACT PAGES ===");
    eprintln!("[search] paper_id: {}, file_path: {}", paper_id, file_path);

    // Try indexed text first
    let indexed = db.get_paper_pages_text(&paper_id).unwrap_or_default();
    if !indexed.is_empty() {
        let language = db.get_paper_language(&paper_id).unwrap_or_default().unwrap_or_default();
        eprintln!("[search] Using indexed text: {} pages, language={}", indexed.len(), language);
        let pages: Vec<serde_json::Value> = indexed
            .into_iter()
            .map(|(idx, text)| {
                serde_json::json!({
                    "page_index": idx,
                    "text": if text.len() > 3000 {
                        &text[..text.floor_char_boundary(3000)]
                    } else { &text },
                })
            })
            .collect();
        return Ok(serde_json::json!({
            "pages": pages,
            "language": language,
        }));
    }

    eprintln!("[search] No index found, extracting fresh from PDF...");
    // Not indexed: extract fresh from PDF
    let fp = file_path.clone();
    let pages = tauri::async_runtime::spawn_blocking(move || {
        extract_all_pages_text(&fp)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))??;

    let all_text: String = pages.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>().join(" ");
    let language = crate::settings_db::detect_text_language(&all_text);
    eprintln!("[search] Fresh extraction: {} pages, language={}", pages.len(), language);

    let page_values: Vec<serde_json::Value> = pages
        .into_iter()
        .map(|(idx, text)| {
            serde_json::json!({
                "page_index": idx,
                "text": if text.len() > 3000 {
                    &text[..text.floor_char_boundary(3000)]
                } else { &text },
            })
        })
        .collect();

    Ok(serde_json::json!({
        "pages": page_values,
        "language": language,
    }))
}

/// Return which paper IDs have been indexed.
#[tauri::command]
pub(crate) async fn search_index_status(
    db: State<'_, SettingsDb>,
) -> Result<Vec<String>, String> {
    let ids = db.list_indexed_paper_ids()
        .map_err(|e| format!("Failed to get index status: {e}"))?;
    eprintln!("[search] Index status: {} papers indexed", ids.len());
    Ok(ids)
}

/// Delete the FTS index for a specific paper.
#[tauri::command]
pub(crate) async fn search_delete_index(
    paper_id: String,
    db: State<'_, SettingsDb>,
) -> Result<(), String> {
    db.delete_paper_index(&paper_id)
        .map_err(|e| format!("Failed to delete index: {e}"))
}
