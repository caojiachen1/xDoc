//! Global full-text search commands backed by SQLite FTS5.
//!
//! Commands:
//!   search_index_paper       — Extract text from a single PDF and add to index
//!   search_index_paper_ocr   — OCR-based indexing with detailed progress
//!   search_index_all         — Index all managed papers
//!   search_paper             — Full-text search within a single paper
//!   search_index_status      — Return which paper IDs are indexed
//!   search_delete_index      — Delete index for a paper
//!   search_extract_pages     — Get all page texts (indexed or fresh from PDF)

use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use crate::gguf_ocr;
use crate::ocr_models::{self, OcrEngine};
use crate::ppocrv6;
use crate::settings_db::SettingsDb;
use super::{
    bind_pdfium_with_candidates, LayoutBox, ModelState,
    resolve_model_path, resolve_dll_dir,
};
use super::model::infer_layout_boxes;
use super::ocr::OcrState;
use pdfium_render::prelude::{PdfPageObjectsCommon, PdfRenderConfig, PdfPageRenderRotation};

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

// ── OCR-based indexing ──────────────────────────────────────────────────────

/// Progress event emitted during OCR-based search indexing.
#[derive(serde::Serialize, Clone)]
pub struct OcrIndexProgress {
    pub page: u32,
    pub total_pages: u32,
    pub status: String,      // "detecting" | "ocr" | "indexing" | "done"
    pub paragraph: u32,
    pub total_paragraphs: u32,
    pub message: String,
}

/// Returns true if a layout class ID corresponds to a text-containing region
/// (i.e., a region worth OCR'ing for text indexing).
fn is_text_class_id(cls_id: u32) -> bool {
    // Non-text / visual classes: chart(3), display_formula(5), footer_image(9),
    // header_image(13), image(14), inline_formula(15), seal(20), table(21)
    // Garbage classes: footer(8), formula_number(11), header(12), number(16), seal(20)
    // Text classes: everything else that has readable text content
    const NON_TEXT: [u32; 8] = [3, 5, 9, 13, 14, 15, 20, 21];
    const GARBAGE: [u32; 5] = [8, 9, 11, 12, 16];
    !NON_TEXT.contains(&cls_id) && !GARBAGE.contains(&cls_id)
}

/// Run OCR on a cropped image region using the active engine (non-streaming, for indexing).
pub(crate) fn run_ocr_for_index(
    engine: OcrEngine,
    model_id: &str,
    model_root: &Path,
    cropped: &image::DynamicImage,
    gguf_backend: &Arc<Mutex<Option<gguf_ocr::GgufBackend>>>,
    ppocrv6_backend: &Arc<Mutex<Option<ppocrv6::Ppocrv6Backend>>>,
    page_index: u32,
    region_index: u32,
) -> Result<String, String> {
    match engine {
        OcrEngine::Gguf => {
            let model_cfg = ocr_models::find_gguf_model(model_id)
                .ok_or_else(|| format!("Unknown GGUF OCR model: {}", model_id))?;

            let temp_dir = std::env::temp_dir();
            let temp_path = temp_dir.join(format!(
                "xdoc_ocr_index_p{}_r{}.png", page_index, region_index
            ));
            cropped.save(&temp_path)
                .map_err(|e| format!("Failed to save temp image: {e}"))?;

            let text = {
                let mut guard = gguf_backend.lock().unwrap();
                let backend = guard.as_mut().ok_or("GGUF backend not initialized")?;
                backend
                    .infer_streaming(model_root, model_cfg, &temp_path, &mut |_| {})
                    .map_err(|e| format!("OCR inference failed: {e}"))?
                    .text
            };

            let _ = std::fs::remove_file(&temp_path);
            Ok(text)
        }
        OcrEngine::Ppocrv6 => {
            let model_info = ocr_models::find_ppocrv6_model_by_id(model_id)
                .ok_or_else(|| format!("Unknown PPOCRv6 model: {}", model_id))?;

            let text = {
                let mut guard = ppocrv6_backend.lock().unwrap();
                let backend = guard.as_mut().ok_or("PPOCRv6 backend not initialized")?;
                backend
                    .infer_text(model_root, model_info, cropped, &mut |_| {})
                    .map_err(|e| format!("PPOCRv6 inference failed: {e}"))?
            };

            Ok(text)
        }
    }
}

/// Index a paper using OCR — detects paragraph regions, runs OCR on each,
/// caches results persistently, and builds the FTS5 search index.
/// Emits detailed progress events via `ocr-index-progress`.
#[tauri::command]
pub(crate) async fn search_index_paper_ocr(
    paper_id: String,
    file_path: String,
    score_threshold: Option<f32>,
    force_refresh: Option<bool>,
    app: AppHandle,
    db: State<'_, SettingsDb>,
    ocr_state: State<'_, OcrState>,
    model_state: State<'_, ModelState>,
) -> Result<u32, String> {
    let threshold = score_threshold.unwrap_or(0.5).clamp(0.0, 1.0);
    let do_refresh = force_refresh.unwrap_or(false);

    eprintln!("[search] === OCR INDEX PAPER ===");
    eprintln!("[search] paper_id: {}, file_path: {}, force_refresh: {}", paper_id, file_path, do_refresh);

    let session_arc = model_state.session.clone();
    let gguf_backend = ocr_state.gguf_backend.clone();
    let ppocrv6_backend = ocr_state.ppocrv6_backend.clone();
    let ocr_cache_arc = ocr_state.ocr_cache.clone();

    // Auto-init OCR backend if not already initialized
    {
        let model_id_guard = ocr_state.active_model_id.lock().unwrap();
        if model_id_guard.is_none() {
            drop(model_id_guard);
            eprintln!("[search-ocr] OCR not initialized, attempting auto-init from settings...");
            let ocr_model_path = db.get("ocr.modelPath")
                .ok()
                .flatten()
                .unwrap_or_else(|| "model/GLM-OCR-GGUF".to_string());
            let ocr_model_id = db.get("ocr.modelId")
                .ok()
                .flatten()
                .unwrap_or_else(|| "glm-ocr".to_string());

            let model_root = resolve_model_path(&ocr_model_path);
            if !model_root.exists() {
                return Err(format!("OCR 模型目录不存在: {}", model_root.display()));
            }

            if ocr_model_id.starts_with("ppocrv6") {
                let model_info = ocr_models::find_ppocrv6_model_by_id(&ocr_model_id)
                    .ok_or_else(|| format!("未知的 PPOCRv6 模型: {}", ocr_model_id))?;
                let mut guard = ocr_state.ppocrv6_backend.lock().unwrap();
                if guard.is_none() {
                    *guard = Some(ppocrv6::Ppocrv6Backend::new());
                }
                guard.as_mut().unwrap()
                    .ensure_loaded(&model_root, model_info)
                    .map_err(|e| format!("PPOCRv6 初始化失败: {e}"))?;
                *ocr_state.active_engine.lock().unwrap() = OcrEngine::Ppocrv6;
            } else {
                let model_cfg = ocr_models::find_gguf_model(&ocr_model_id)
                    .ok_or_else(|| format!("未知的 GGUF OCR 模型: {}", ocr_model_id))?;
                let gguf_file = model_root.join(model_cfg.text_model_q8);
                let mmproj_file = model_root.join(model_cfg.mmproj_q8);
                if !gguf_file.exists() {
                    return Err(format!("GGUF 模型文件不存在: {}", gguf_file.display()));
                }
                if !mmproj_file.exists() {
                    return Err(format!("mmproj 模型文件不存在: {}", mmproj_file.display()));
                }
                let dll_dir = resolve_dll_dir();
                let cpp_lib = gguf_ocr::CppLib::load(
                    &dll_dir.join("llama.dll"),
                    &dll_dir.join("mtmd.dll"),
                ).map_err(|e| format!("加载 llama.cpp DLL 失败: {e}"))?;
                {
                    let mut backend_guard = ocr_state.gguf_backend.lock().unwrap();
                    if let Some(ref mut backend) = *backend_guard {
                        backend.unload();
                    }
                    *backend_guard = Some(gguf_ocr::GgufBackend::new(cpp_lib, false));
                }
                *ocr_state.active_engine.lock().unwrap() = OcrEngine::Gguf;
            }
            *ocr_state.active_model_id.lock().unwrap() = Some(ocr_model_id.clone());
            *ocr_state.model_root.lock().unwrap() = Some(model_root);
            eprintln!("[search-ocr] Auto-init OCR complete: engine={:?}, model_id={}",
                *ocr_state.active_engine.lock().unwrap(), ocr_model_id);
        }
    }

    let active_engine = *ocr_state.active_engine.lock().unwrap();
    let active_model_id = ocr_state.active_model_id.lock().unwrap().clone()
        .ok_or("OCR 模型初始化失败：无法获取 model_id")?;
    let ocr_model_root = ocr_state.model_root.lock().unwrap().clone()
        .ok_or("OCR 模型初始化失败：无法获取 model_root")?;

    let pid = paper_id.clone();
    let fp = file_path.clone();
    let path = Path::new(&fp);
    if !path.exists() {
        return Err(format!("File not found: {}", fp));
    }

    let conn = rusqlite::Connection::open(&db.path)
        .map_err(|e| format!("Failed to open DB: {e}"))?;

    // When force_refresh: clear cached OCR data for this paper
    if do_refresh {
        let deleted = conn.execute(
            "DELETE FROM ocr_paragraph_cache WHERE paper_id = ?1",
            rusqlite::params![&pid],
        ).unwrap_or(0);
        eprintln!("[search-ocr] force_refresh: cleared {} cached paragraphs for paper_id={}", deleted, pid);
        let fts_deleted = conn.execute(
            "DELETE FROM papers_fts WHERE paper_id = ?1",
            rusqlite::params![&pid],
        ).unwrap_or(0);
        eprintln!("[search-ocr] force_refresh: cleared {} FTS entries for paper_id={}", fts_deleted, pid);
        let mut mem_cache = ocr_cache_arc.lock().unwrap();
        let prefix = format!("{}::", fp);
        mem_cache.retain(|k, _| !k.starts_with(&prefix));
        eprintln!("[search-ocr] force_refresh: cleared in-memory cache entries for {}", fp);
    }

    // Open PDF and get page count (CPU-heavy, but fast — just pdfium open)
    let fp_clone = fp.clone();
    let total_pages = tauri::async_runtime::spawn_blocking(move || -> Result<u32, String> {
        let bindings = bind_pdfium_with_candidates()?;
        let pdfium = pdfium_render::prelude::Pdfium::new(bindings);
        let document = pdfium
            .load_pdf_from_file(Path::new(&fp_clone), None)
            .map_err(|e| format!("Failed to open PDF: {e}"))?;
        Ok(document.pages().len() as u32)
    }).await.map_err(|e| format!("spawn_blocking failed: {e}"))??;
    eprintln!("[search-ocr] Total pages: {}", total_pages);

    let mut pages_text: Vec<(u32, String)> = Vec::new();

    for page_idx in 0..total_pages {
        // ── Progress: detecting layout ──
        let _ = app.emit("ocr-index-progress", OcrIndexProgress {
            page: page_idx,
            total_pages,
            status: "detecting".to_string(),
            paragraph: 0,
            total_paragraphs: 0,
            message: format!("正在分析第 {}/{} 页的版面布局...", page_idx + 1, total_pages),
        });

        // Render page to image (CPU-heavy → spawn_blocking)
        let fp_render = fp.clone();
        let page_image = tauri::async_runtime::spawn_blocking(move || -> Result<image::DynamicImage, String> {
            let bindings = bind_pdfium_with_candidates()?;
            let pdfium = pdfium_render::prelude::Pdfium::new(bindings);
            let document = pdfium
                .load_pdf_from_file(Path::new(&fp_render), None)
                .map_err(|e| format!("Failed to open PDF: {e}"))?;
            let pi = page_idx.min(document.pages().len() as u32 - 1);
            let page = document.pages().get(pi as u16)
                .map_err(|e| format!("Failed to get page {}: {}", page_idx, e))?;
            let rendered = page.render_with_config(
                &PdfRenderConfig::new()
                    .set_target_width(1600)
                    .rotate_if_landscape(PdfPageRenderRotation::None, true),
            ).map_err(|e| format!("Failed to render page {}: {}", page_idx, e))?;
            Ok(rendered.as_image())
        }).await.map_err(|e| format!("spawn_blocking failed: {e}"))??;

        let img_w = page_image.width() as f32;
        let img_h = page_image.height() as f32;

        // ── Layout detection (async lock → sync inference while holding guard) ──
        let boxes: Vec<LayoutBox> = {
            let mut guard = session_arc.lock().await;
            if let Some(ref mut session) = *guard {
                infer_layout_boxes(session, &page_image, threshold).unwrap_or_default()
            } else {
                vec![LayoutBox {
                    cls_id: 22,
                    score: 1.0,
                    xmin: 0.0,
                    ymin: 0.0,
                    xmax: img_w,
                    ymax: img_h,
                    read_order: 0,
                }]
            }
        };

        // Filter for text-containing regions and sort by read order
        let mut text_regions: Vec<LayoutBox> = boxes
            .into_iter()
            .filter(|b| is_text_class_id(b.cls_id))
            .collect();
        text_regions.sort_by_key(|b| b.read_order);

        if text_regions.is_empty() {
            eprintln!("[search-ocr] No text regions on page {}, using whole page", page_idx);
            text_regions.push(LayoutBox {
                cls_id: 22,
                score: 1.0,
                xmin: 0.0,
                ymin: 0.0,
                xmax: img_w,
                ymax: img_h,
                read_order: 0,
            });
        }

        let total_paragraphs = text_regions.len() as u32;
        let mut page_text_parts: Vec<String> = Vec::new();

        for (region_idx, region) in text_regions.iter().enumerate() {
            let ixmin = region.xmin.round() as i32;
            let iymin = region.ymin.round() as i32;
            let ixmax = region.xmax.round() as i32;
            let iymax = region.ymax.round() as i32;

            let _ = app.emit("ocr-index-progress", OcrIndexProgress {
                page: page_idx,
                total_pages,
                status: "ocr".to_string(),
                paragraph: region_idx as u32,
                total_paragraphs,
                message: format!(
                    "第 {}/{} 页 — OCR 识别段落 ({}/{})",
                    page_idx + 1, total_pages, region_idx + 1, total_paragraphs
                ),
            });

            // Check persistent DB cache first
            let cached = conn.query_row(
                "SELECT text FROM ocr_paragraph_cache
                 WHERE paper_id = ?1 AND page_index = ?2
                   AND xmin = ?3 AND ymin = ?4 AND xmax = ?5 AND ymax = ?6",
                rusqlite::params![&pid, page_idx as i32, ixmin, iymin, ixmax, iymax],
                |row| row.get::<_, String>(0),
            ).ok();

            if let Some(text) = cached {
                eprintln!("[search-ocr] p{} r{}/{}: cache hit ({} chars)", page_idx, region_idx + 1, total_paragraphs, text.len());
                if !text.trim().is_empty() {
                    page_text_parts.push(text.clone());
                }
                let cache_key = format!(
                    "{}::{}_{}_{}_{}_{}", fp, page_idx, ixmin, iymin, ixmax, iymax
                );
                ocr_cache_arc.lock().unwrap().insert(cache_key, text);
                continue;
            }

            eprintln!("[search-ocr] p{} r{}/{}: cache miss, running OCR (region: {},{},{},{})",
                page_idx, region_idx + 1, total_paragraphs, ixmin, iymin, ixmax, iymax);

            // Crop and run OCR (CPU-heavy → spawn_blocking)
            let cx = (region.xmin.clamp(0.0, img_w) as u32, region.ymin.clamp(0.0, img_h) as u32);
            let crop_w = ((region.xmax - region.xmin).clamp(1.0, img_w - cx.0 as f32) as u32).max(1);
            let crop_h = ((region.ymax - region.ymin).clamp(1.0, img_h - cx.1 as f32) as u32).max(1);
            let cropped = page_image.crop_imm(cx.0, cx.1, crop_w, crop_h);

            let raw_text = run_ocr_for_index(
                active_engine,
                &active_model_id,
                &ocr_model_root,
                &cropped,
                &gguf_backend,
                &ppocrv6_backend,
                page_idx,
                region_idx as u32,
            )?;

            let text = super::ocr::clean_special_tokens_public(&raw_text);
            eprintln!("[search-ocr] p{} r{}/{}: OCR done → {} chars", page_idx, region_idx + 1, total_paragraphs, text.len());

            // Yield so reading-panel OCR can acquire the backend lock
            tokio::task::yield_now().await;

            if !text.trim().is_empty() {
                page_text_parts.push(text.clone());

                let _ = conn.execute(
                    "INSERT INTO ocr_paragraph_cache (paper_id, page_index, xmin, ymin, xmax, ymax, text, model_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(paper_id, page_index, xmin, ymin, xmax, ymax)
                     DO UPDATE SET text = excluded.text, model_id = excluded.model_id, created_at = datetime('now')",
                    rusqlite::params![&pid, page_idx as i32, ixmin, iymin, ixmax, iymax, &text, &active_model_id],
                );

                let cache_key = format!(
                    "{}::{}_{}_{}_{}_{}", fp, page_idx, ixmin, iymin, ixmax, iymax
                );
                ocr_cache_arc.lock().unwrap().insert(cache_key, text);
            }
        }

        let page_text = page_text_parts.join("\n");
        if !page_text.trim().is_empty() {
            pages_text.push((page_idx, page_text));
        }

        // Yield between pages so other async tasks can run
        tokio::task::yield_now().await;
    }

    // ── Progress: writing FTS index ──
    let _ = app.emit("ocr-index-progress", OcrIndexProgress {
        page: total_pages.saturating_sub(1),
        total_pages,
        status: "indexing".to_string(),
        paragraph: 0,
        total_paragraphs: 0,
        message: "正在写入搜索索引...".to_string(),
    });

    let all_text: String = pages_text.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>().join(" ");
    let language = crate::settings_db::detect_text_language(&all_text);

    let _ = conn.execute(
        "DELETE FROM papers_fts WHERE paper_id = ?1",
        rusqlite::params![&pid],
    );

    for (page_idx, text) in &pages_text {
        if !text.trim().is_empty() {
            let char_count = text.chars().count() as i32;
            conn.execute(
                "INSERT INTO papers_fts (paper_id, page_index, text, char_count, language)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![&pid, *page_idx as i32, text, char_count, &language],
            ).map_err(|e| format!("Failed to insert FTS: {e}"))?;
        }
    }

    eprintln!(
        "[search-ocr] Indexed {} pages for paper_id={}",
        pages_text.len(), pid
    );

    let _ = app.emit("ocr-index-progress", OcrIndexProgress {
        page: total_pages.saturating_sub(1),
        total_pages,
        status: "done".to_string(),
        paragraph: 0,
        total_paragraphs: 0,
        message: format!("OCR 索引完成，共处理 {} 页", total_pages),
    });

    Ok(total_pages)
}
