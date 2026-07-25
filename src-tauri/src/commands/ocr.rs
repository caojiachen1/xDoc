//! OCR backend commands (GGUF/PPOCRv6 model init, region recognition, model download).

use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use models_cat::asynchronous::ModelsCat;
use models_cat::Repo;
use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::gguf_ocr;
use crate::ocr_models::{self, OcrEngine};
use crate::ppocrv6;
use crate::settings_db::SettingsDb;
use super::{
    copy_from_cache, render_pdf_page, resolve_dll_dir, resolve_model_path, ModelDownloadProgress,
    TauriProgress,
};

// ── Special token cleanup ──────────────────────────────────────────────────

/// Strips LLM special tokens (e.g. `<|endofassistant|>`, `<s>`, `[INST]`) from OCR output.
fn clean_special_tokens(text: &str) -> String {
    static THINK_BLOCK: OnceLock<Regex> = OnceLock::new();
    static THINK_DANGLING: OnceLock<Regex> = OnceLock::new();
    static SPECIAL_TOKEN: OnceLock<Regex> = OnceLock::new();
    static SOLO_TOKENS: OnceLock<Regex> = OnceLock::new();

    // Strip chain-of-thought blocks (e.g. OvisOCR2 emits <think>...</think> before the answer).
    let think_block = THINK_BLOCK.get_or_init(|| Regex::new(r"(?is)<think>.*?</think>").unwrap());
    let think_dangling = THINK_DANGLING.get_or_init(|| Regex::new(r"(?is)<think>.*").unwrap());
    let special = SPECIAL_TOKEN.get_or_init(|| Regex::new(r"<\|[^|]+\|>").unwrap());
    let solo = SOLO_TOKENS.get_or_init(|| Regex::new(r"</?s>|\[INST\]|\[/INST\]").unwrap());

    let text = think_block.replace_all(text, "");
    let text = think_dangling.replace_all(&text, "");
    let text = special.replace_all(&text, "");
    let text = solo.replace_all(&text, "");
    text.trim_start().to_string()
}

/// Public wrapper for clean_special_tokens, used by other modules (e.g., search indexing).
pub(crate) fn clean_special_tokens_public(text: &str) -> String {
    clean_special_tokens(text)
}

// ── OCR state ──────────────────────────────────────────────────────────────

pub struct OcrState {
    pub gguf_backend: Arc<Mutex<Option<gguf_ocr::GgufBackend>>>,
    pub ppocrv6_backend: Arc<Mutex<Option<ppocrv6::Ppocrv6Backend>>>,
    pub active_engine: Arc<Mutex<OcrEngine>>,
    pub active_model_id: Arc<Mutex<Option<String>>>,
    pub model_root: Arc<Mutex<Option<PathBuf>>>,
    pub ocr_cache: Arc<Mutex<HashMap<String, String>>>,
}

// ── OCR types ──────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct OcrRegionResult {
    pub text: String,
}

#[derive(Serialize, Clone)]
struct OcrStreamToken {
    piece: String,
}

#[derive(Serialize, Clone)]
pub struct OcrModelInfo {
    pub id: String,
    pub label: String,
    pub engine: String,
    pub description: String,
    pub params: String,
    pub downloaded: bool,
    /// Whether the model performs end-to-end (page-level) layout-preserving parsing.
    pub end_to_end: bool,
    /// Directory name (under `model/`) where this model is stored/downloaded.
    /// Lets the frontend derive the model path without a hard-coded map.
    pub repo_dir: String,
}

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn init_ocr(
    ocr_model_path: String,
    ocr_model_id: String,
    state: State<'_, OcrState>,
) -> Result<String, String> {
    let model_root = resolve_model_path(&ocr_model_path);
    if !model_root.exists() {
        return Err(format!(
            "OCR model directory not found: {}",
            model_root.display()
        ));
    }

    let is_ppocrv6 = ocr_model_id.starts_with("ppocrv6");

    if is_ppocrv6 {
        let model_info = ocr_models::find_ppocrv6_model_by_id(&ocr_model_id)
            .ok_or_else(|| format!("Unknown PPOCRv6 model: {}", ocr_model_id))?;

        {
            let mut guard = state.ppocrv6_backend.lock().unwrap();
            if guard.is_none() {
                *guard = Some(ppocrv6::Ppocrv6Backend::new());
            }
            guard.as_mut().unwrap()
                .ensure_loaded(&model_root, model_info)
                .map_err(|e| format!("PPOCRv6 init failed: {e}"))?;
        }

        *state.active_engine.lock().unwrap() = OcrEngine::Ppocrv6;
        *state.active_model_id.lock().unwrap() = Some(ocr_model_id.clone());
        *state.model_root.lock().unwrap() = Some(model_root);

        Ok(format!("PPOCRv6 backend initialized with '{}'", ocr_model_id))
    } else {
        let model_cfg = ocr_models::find_gguf_model(&ocr_model_id)
            .ok_or_else(|| format!("Unknown GGUF OCR model: {}", ocr_model_id))?;

        let gguf_file = model_root.join(model_cfg.text_model_q8);
        let mmproj_file = model_root.join(model_cfg.mmproj_q8);
        if !gguf_file.exists() {
            return Err(format!("GGUF model not found: {}", gguf_file.display()));
        }
        if !mmproj_file.exists() {
            return Err(format!("mmproj model not found: {}", mmproj_file.display()));
        }

        let dll_dir = resolve_dll_dir();
        let cpp_lib = gguf_ocr::CppLib::load(
            &dll_dir.join("llama.dll"),
            &dll_dir.join("mtmd.dll"),
        )
        .map_err(|e| format!("Failed to load llama.cpp DLLs: {e}"))?;

        {
            let mut backend_guard = state.gguf_backend.lock().unwrap();
            if let Some(ref mut backend) = *backend_guard {
                backend.unload();
            }
            *backend_guard = Some(gguf_ocr::GgufBackend::new(cpp_lib, false));
        }

        *state.active_engine.lock().unwrap() = OcrEngine::Gguf;
        *state.active_model_id.lock().unwrap() = Some(ocr_model_id.clone());
        *state.model_root.lock().unwrap() = Some(model_root);

        Ok(format!("GGUF backend initialized with '{}'", ocr_model_id))
    }
}

#[tauri::command]
pub(crate) async fn run_ocr_region(
    app: AppHandle,
    file_path: String,
    page_index: u32,
    xmin: f32,
    ymin: f32,
    xmax: f32,
    ymax: f32,
    force_refresh: Option<bool>,
    paper_id: Option<String>,
    state: State<'_, OcrState>,
    db: State<'_, SettingsDb>,
) -> Result<OcrRegionResult, String> {
    let cache_key = format!(
        "{}::{}_{}_{}_{}_{}",
        file_path, page_index,
        xmin.round() as i32, ymin.round() as i32,
        xmax.round() as i32, ymax.round() as i32
    );
    if !force_refresh.unwrap_or(false) {
        // Check in-memory cache first
        if let Some(cached_text) = state.ocr_cache.lock().unwrap().get(&cache_key) {
            return Ok(OcrRegionResult { text: cached_text.clone() });
        }
        // Check persistent DB cache
        if let Some(ref pid) = paper_id {
            let ixmin = xmin.round() as i32;
            let iymin = ymin.round() as i32;
            let ixmax = xmax.round() as i32;
            let iymax = ymax.round() as i32;
            if let Ok(Some(cached_text)) = db.get_ocr_cache(pid, page_index, ixmin, iymin, ixmax, iymax) {
                // Populate in-memory cache for faster subsequent lookups
                state.ocr_cache.lock().unwrap().insert(cache_key, cached_text.clone());
                return Ok(OcrRegionResult { text: cached_text });
            }
        }
    }

    let (engine, model_id, model_root) = {
        let engine = *state.active_engine.lock().unwrap();
        let model_id = state.active_model_id.lock().unwrap().clone()
            .ok_or("OCR model not initialized")?;
        let model_root = state.model_root.lock().unwrap().clone()
            .ok_or("OCR model not initialized")?;
        (engine, model_id, model_root)
    };

    let path = Path::new(&file_path);
    if !path.exists() { return Err("File not found".to_string()); }

    let (image, _actual_page_index, _page_count) = render_pdf_page(path, page_index)?;
    let img_w = image.width() as f32;
    let img_h = image.height() as f32;
    let cx = (xmin.clamp(0.0, img_w) as u32, ymin.clamp(0.0, img_h) as u32);
    let crop_w = ((xmax - xmin).clamp(1.0, img_w - cx.0 as f32) as u32).max(1);
    let crop_h = ((ymax - ymin).clamp(1.0, img_h - cx.1 as f32) as u32).max(1);

    let cropped = image.crop_imm(cx.0, cx.1, crop_w, crop_h);

    let text = match engine {
        OcrEngine::Gguf => run_gguf_ocr(&app, &state, &model_id, &model_root, &cropped)?,
        OcrEngine::Ppocrv6 => run_ppocrv6_ocr(&app, &state, &model_id, &model_root, &cropped)?,
    };
    let text = clean_special_tokens(&text);

    // Store in in-memory cache
    state.ocr_cache.lock().unwrap().insert(cache_key, text.clone());

    // Store in persistent DB cache (if paper_id is provided)
    if let Some(ref pid) = paper_id {
        let ixmin = xmin.round() as i32;
        let iymin = ymin.round() as i32;
        let ixmax = xmax.round() as i32;
        let iymax = ymax.round() as i32;
        let model_id_str = state.active_model_id.lock().unwrap().clone().unwrap_or_default();
        let _ = db.set_ocr_cache(pid, page_index, ixmin, iymin, ixmax, iymax, &text, &model_id_str);
    }

    Ok(OcrRegionResult { text })
}

fn run_gguf_ocr(
    app: &AppHandle,
    state: &State<'_, OcrState>,
    model_id: &str,
    model_root: &PathBuf,
    cropped: &image::DynamicImage,
) -> Result<String, String> {
    let model_cfg = ocr_models::find_gguf_model(model_id)
        .ok_or_else(|| format!("Unknown GGUF model: {}", model_id))?;

    let temp_dir = env::temp_dir();
    let temp_path = temp_dir.join(format!("xdoc_ocr_gguf_{}.png", model_id));
    cropped.save(&temp_path).map_err(|e| format!("Failed to save temp image: {e}"))?;

    let text = {
        let start = Instant::now();
        let guard = loop {
            match state.gguf_backend.try_lock() {
                Ok(g) => break g,
                Err(std::sync::TryLockError::WouldBlock) => {
                    if start.elapsed() > Duration::from_secs(10) {
                        let _ = std::fs::remove_file(&temp_path);
                        return Err("OCR 后端正忙（可能正在索引），请稍后再试".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(std::sync::TryLockError::Poisoned(e)) => return Err(format!("Mutex poisoned: {e}")),
            }
        };
        let mut guard = guard;
        let backend = guard.as_mut().ok_or("GGUF backend not initialized")?;
        let app_ref = app;
        backend
            .infer_streaming(model_root, model_cfg, &temp_path, &mut |piece: &str| {
                let _ = app_ref.emit("ocr-stream-token", OcrStreamToken { piece: piece.to_string() });
            })
            .map_err(|e| format!("OCR inference failed: {e}"))?
            .text
    };

    let _ = std::fs::remove_file(&temp_path);
    Ok(text)
}

fn run_ppocrv6_ocr(
    app: &AppHandle,
    state: &State<'_, OcrState>,
    model_id: &str,
    model_root: &PathBuf,
    cropped: &image::DynamicImage,
) -> Result<String, String> {
    let model_info = ocr_models::find_ppocrv6_model_by_id(model_id)
        .ok_or_else(|| format!("Unknown PPOCRv6 model: {}", model_id))?;

    let text = {
        let start = Instant::now();
        let guard = loop {
            match state.ppocrv6_backend.try_lock() {
                Ok(g) => break g,
                Err(std::sync::TryLockError::WouldBlock) => {
                    if start.elapsed() > Duration::from_secs(10) {
                        return Err("OCR 后端正忙（可能正在索引），请稍后再试".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(std::sync::TryLockError::Poisoned(e)) => return Err(format!("Mutex poisoned: {e}")),
            }
        };
        let mut guard = guard;
        let backend = guard.as_mut().ok_or("PPOCRv6 backend not initialized")?;
        let app_ref = app;
        backend
            .infer_text(model_root, model_info, cropped, &mut |chunk: &str| {
                let _ = app_ref.emit("ocr-stream-token", OcrStreamToken { piece: chunk.to_string() });
            })
            .map_err(|e| format!("PPOCRv6 inference failed: {e}"))?
    };

    Ok(text)
}

#[derive(Serialize, Clone)]
struct ConvertProgress {
    page: u32,
    total_pages: u32,
    status: String,
    message: String,
}

fn replace_img_tags_with_placeholders(
    page_text: &str,
    page_extracted_images: &[Vec<u8>],
    images: &mut Vec<Vec<u8>>,
) -> String {
    static IMG_TAG_RE: OnceLock<Regex> = OnceLock::new();
    let re = IMG_TAG_RE.get_or_init(|| {
        Regex::new(r#"<img\s+[^>]*/?>"#).unwrap()
    });

    let matches: Vec<(usize, usize)> = re
        .find_iter(page_text)
        .map(|m| (m.start(), m.end()))
        .collect();

    if matches.is_empty() {
        return page_text.to_string();
    }

    // Group adjacent img tags: merge consecutive tags where the text between
    // them is short (sub-figure labels, whitespace, etc.)
    let mut groups: Vec<(usize, usize)> = Vec::new();
    let mut grp_start = matches[0].0;
    let mut grp_end = matches[0].1;

    for i in 1..matches.len() {
        let between = &page_text[grp_end..matches[i].0];
        let between_trimmed = between.trim();
        if between_trimmed.len() <= 20 {
            grp_end = matches[i].1;
        } else {
            groups.push((grp_start, grp_end));
            grp_start = matches[i].0;
            grp_end = matches[i].1;
        }
    }
    groups.push((grp_start, grp_end));

    // Replace each group with one pre-extracted image (matched in order).
    let mut result = String::new();
    let mut last = 0usize;
    let mut img_cursor = 0usize;

    for (grp_start, grp_end) in groups {
        result.push_str(&page_text[last..grp_start]);

        if img_cursor < page_extracted_images.len() {
            let idx = images.len();
            images.push(page_extracted_images[img_cursor].clone());
            result.push_str(&format!("![](xdoc-img://{})", idx));
            img_cursor += 1;
        }

        last = grp_end;
    }
    result.push_str(&page_text[last..]);
    result
}

/// Converts an entire PDF to a Word (.docx) or Markdown (.md) file using the
/// active end-to-end OCR model, preserving layout (headings, tables, formulas).
#[tauri::command]
pub(crate) async fn convert_pdf_document(
    app: AppHandle,
    file_path: String,
    format: String,
    output_path: String,
    state: State<'_, OcrState>,
) -> Result<String, String> {
    let (engine, model_id, model_root) = {
        let engine = *state.active_engine.lock().unwrap();
        let model_id = state.active_model_id.lock().unwrap().clone()
            .ok_or("OCR 未初始化，请先在设置中启用 OCR 并选择端到端模型")?;
        let model_root = state.model_root.lock().unwrap().clone()
            .ok_or("OCR 未初始化，请先在设置中启用 OCR 并选择端到端模型")?;
        (engine, model_id, model_root)
    };

    if engine != OcrEngine::Gguf {
        return Err("当前 OCR 引擎不支持整页文档转换，请选择端到端 GGUF 模型".to_string());
    }
    let model_cfg = ocr_models::find_gguf_model(&model_id)
        .ok_or_else(|| format!("未知的 GGUF 模型: {}", model_id))?;
    if !model_cfg.end_to_end {
        return Err(format!(
            "当前模型 “{}” 不是端到端模型，无法保留布局转换。请在设置中选择端到端 OCR 模型（如 OvisOCR2 / Qianfan-OCR）。",
            model_cfg.label
        ));
    }

    let path = Path::new(&file_path);
    if !path.exists() { return Err("文件不存在".to_string()); }

    // Render the first page to obtain the total page count.
    let (_first_img, _idx, total_pages) = render_pdf_page(path, 0)?;

    // Pre-extract embedded images from PDF using pdfium API (complete, unsplit).
    let extracted_by_page: HashMap<u32, Vec<Vec<u8>>> = {
        use base64::Engine;
        let mut map: HashMap<u32, Vec<Vec<u8>>> = HashMap::new();
        if let Ok(pdf_images) = super::pdf::extract_pdf_images(&file_path, None) {
            for info in pdf_images {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&info.image_base64) {
                    map.entry(info.page_index).or_default().push(bytes);
                }
            }
        }
        map
    };

    let temp_dir = env::temp_dir();
    let mut full_markdown = String::new();
    let want_images = matches!(format.as_str(), "docx" | "word" | "markdown" | "md");
    let mut images: Vec<Vec<u8>> = Vec::new();

    for page_index in 0..total_pages {
        let _ = app.emit("ocr-convert-progress", ConvertProgress {
            page: page_index,
            total_pages,
            status: "recognizing".to_string(),
            message: format!("正在识别第 {}/{} 页...", page_index + 1, total_pages),
        });

        let (image, _actual, _count) = render_pdf_page(path, page_index)?;
        let temp_path = temp_dir.join(format!("xdoc_convert_p{}.png", page_index));
        image.save(&temp_path).map_err(|e| format!("保存临时图片失败: {e}"))?;

        let page_text = {
            let start = Instant::now();
            let guard = loop {
                match state.gguf_backend.try_lock() {
                    Ok(g) => break g,
                    Err(std::sync::TryLockError::WouldBlock) => {
                        if start.elapsed() > Duration::from_secs(30) {
                            let _ = std::fs::remove_file(&temp_path);
                            return Err("OCR 后端正忙（可能正在索引），请稍后再试".to_string());
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    Err(std::sync::TryLockError::Poisoned(e)) => return Err(format!("Mutex poisoned: {e}")),
                }
            };
            let mut guard = guard;
            let backend = guard.as_mut().ok_or("GGUF backend not initialized")?;
            let app_ref = &app;
            backend
                .infer_streaming(&model_root, model_cfg, &temp_path, &mut |piece: &str| {
                    let _ = app_ref.emit("ocr-convert-token", OcrStreamToken { piece: piece.to_string() });
                })
                .map_err(|e| format!("OCR 识别失败: {e}"))?
                .text
        };

        let _ = std::fs::remove_file(&temp_path);
        let page_text = clean_special_tokens(&page_text);

        if page_index > 0 { full_markdown.push_str("\n\n---\n\n"); }

        if want_images {
            let page_imgs = extracted_by_page.get(&page_index).map(|v| v.as_slice()).unwrap_or(&[]);
            let page_text =
                replace_img_tags_with_placeholders(&page_text, page_imgs, &mut images);
            full_markdown.push_str(page_text.trim());
        } else {
            full_markdown.push_str(page_text.trim());
        }
    }

    let _ = app.emit("ocr-convert-progress", ConvertProgress {
        page: total_pages,
        total_pages,
        status: "writing".to_string(),
        message: "正在生成文档...".to_string(),
    });

    let out = Path::new(&output_path);
    match format.as_str() {
        "markdown" | "md" | "txt" => {
            let md = write_markdown_images(&full_markdown, &images, out)?;
            std::fs::write(out, &md).map_err(|e| format!("写入文件失败: {e}"))?;
        }
        "docx" | "word" => {
            crate::docx_export::markdown_to_docx(&full_markdown, &images, out)?;
        }
        other => return Err(format!("不支持的输出格式: {}", other)),
    }

    let _ = app.emit("ocr-convert-progress", ConvertProgress {
        page: total_pages,
        total_pages,
        status: "completed".to_string(),
        message: "转换完成".to_string(),
    });

    Ok(output_path)
}

/// Write extracted images as sidecar PNG files next to the Markdown output and
/// rewrite `xdoc-img://N` placeholders into relative image links.
fn write_markdown_images(
    markdown: &str,
    images: &[Vec<u8>],
    out: &Path,
) -> Result<String, String> {
    if images.is_empty() {
        return Ok(markdown.to_string());
    }
    let stem = out
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let dir_name = format!("{stem}_images");
    let img_dir = out
        .parent()
        .map(|p| p.join(&dir_name))
        .unwrap_or_else(|| PathBuf::from(&dir_name));
    std::fs::create_dir_all(&img_dir).map_err(|e| format!("创建图片目录失败: {e}"))?;

    let mut result = markdown.to_string();
    for (idx, bytes) in images.iter().enumerate() {
        let filename = format!("image{idx}.png");
        let file_path = img_dir.join(&filename);
        std::fs::write(&file_path, bytes).map_err(|e| format!("写入图片失败: {e}"))?;
        let rel = format!("{dir_name}/{filename}");
        result = result.replace(&format!("xdoc-img://{idx}"), &rel);
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn download_ocr_models(
    app: tauri::AppHandle,
    ocr_model_id: String,
    target_dir: String,
) -> Result<String, String> {
    let target_path = resolve_model_path(&target_dir);
    std::fs::create_dir_all(&target_path).map_err(|e| format!("无法创建目录: {e}"))?;

    let model_cfg = ocr_models::find_gguf_model(&ocr_model_id)
        .ok_or_else(|| format!("Unknown GGUF OCR model: {}", ocr_model_id))?;

    let repo = Repo::new_model(model_cfg.repo_id);
    let mc = ModelsCat::new(repo);

    let all_files = mc.list_hub_files().await
        .map_err(|e| format!("获取文件列表失败: {e}"))?;

    let files_to_download: Vec<String> = all_files.into_iter()
        .filter(|f| {
            f == &model_cfg.text_model_q8 || f == &model_cfg.mmproj_q8
        })
        .collect();

    let files_to_download = if files_to_download.is_empty() {
        let mut fb = vec![model_cfg.text_model_q8.to_string(), model_cfg.mmproj_q8.to_string()];
        fb.dedup();
        fb
    } else {
        files_to_download
    };

    if files_to_download.is_empty() {
        return Err("未找到可下载的文件".to_string());
    }

    for (i, file) in files_to_download.iter().enumerate() {
        let progress = TauriProgress { app: app.clone(), model_type: "ocr".to_string() };
        mc.download_with_progress(file, progress).await
            .map_err(|e| format!("下载 {} 失败: {}", file, e))?;

        let cache_dir = mc.repo().cache_dir();
        copy_from_cache(&cache_dir, file, &target_path)?;

        let pct = ((i + 1) as f64 / files_to_download.len() as f64) * 100.0;
        let _ = app.emit("model-download-progress", ModelDownloadProgress {
            model_type: "ocr".to_string(),
            filename: format!("{}/{}", i + 1, files_to_download.len()),
            current: (i + 1) as u64, total: files_to_download.len() as u64,
            progress: pct, status: "downloading".to_string(),
            message: format!("已完成 {}/{} 个文件", i + 1, files_to_download.len()),
        });
    }

    let _ = app.emit("model-download-progress", ModelDownloadProgress {
        model_type: "ocr".to_string(), filename: String::new(),
        current: 0, total: 0, progress: 100.0,
        status: "completed".to_string(),
        message: format!("{} 模型下载完成", model_cfg.label),
    });

    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) async fn download_ppocrv6_models(
    app: tauri::AppHandle,
    ocr_model_id: String,
    target_dir: String,
) -> Result<String, String> {
    let target_path = resolve_model_path(&target_dir);
    std::fs::create_dir_all(&target_path).map_err(|e| format!("无法创建目录: {e}"))?;

    let model_info = ocr_models::find_ppocrv6_model_by_id(&ocr_model_id)
        .ok_or_else(|| format!("Unknown PPOCRv6 model: {}", ocr_model_id))?;

    // PP-OCRv6 downloads from 2 separate repos (det + rec), each containing inference.onnx
    // We rename them to det.onnx / rec.onnx / rec.yml in the target directory
    let downloads: Vec<(&str, &str, &str)> = vec![
        // (repo_id, source_file, local_name)
        (model_info.det_repo, "inference.onnx", model_info.det_onnx),
        (model_info.rec_repo, "inference.onnx", model_info.rec_onnx),
        (model_info.rec_repo, "inference.yml", model_info.rec_yml),
    ];
    let total_files = downloads.len();

    for (i, (repo_id, source_file, local_name)) in downloads.iter().enumerate() {
        let _ = app.emit("model-download-progress", ModelDownloadProgress {
            model_type: "ocr".to_string(),
            filename: local_name.to_string(),
            current: (i + 1) as u64, total: total_files as u64,
            progress: ((i as f64 / total_files as f64) * 100.0),
            status: "downloading".to_string(),
            message: format!("下载 {} ({}/{})", local_name, i + 1, total_files),
        });

        let repo = Repo::new_model(repo_id);
        let mc = ModelsCat::new(repo);

        let progress = TauriProgress { app: app.clone(), model_type: "ocr".to_string() };
        mc.download_with_progress(source_file, progress).await
            .map_err(|e| format!("下载 {} 失败: {}", source_file, e))?;

        // Copy from cache with the original filename
        let cache_dir = mc.repo().cache_dir();
        copy_from_cache(&cache_dir, source_file, &target_path)?;

        // Rename to the local name if different
        let src = target_path.join(source_file);
        let dst = target_path.join(local_name);
        if src != dst && src.exists() {
            std::fs::rename(&src, &dst)
                .map_err(|e| format!("重命名 {} -> {} 失败: {}", source_file, local_name, e))?;
        }
    }

    let _ = app.emit("model-download-progress", ModelDownloadProgress {
        model_type: "ocr".to_string(), filename: String::new(),
        current: 0, total: 0, progress: 100.0,
        status: "completed".to_string(),
        message: format!("{} 模型下载完成", model_info.label),
    });

    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) async fn list_ocr_models() -> Result<Vec<OcrModelInfo>, String> {
    let mut models = Vec::new();

    for m in ocr_models::gguf_ocr_models() {
        let repo_dir = repo_dir_name(m.repo_id).to_string();
        let model_dir = resolve_model_path(&format!("model/{}", repo_dir));
        let downloaded = model_dir.join(m.text_model_q8).exists();
        models.push(OcrModelInfo {
            id: m.id.to_string(), label: m.label.to_string(),
            engine: "gguf".to_string(), description: m.description.to_string(),
            params: m.params.to_string(), downloaded,
            end_to_end: m.end_to_end,
            repo_dir,
        });
    }

    for m in ocr_models::ppocrv6_models() {
        let model_dir = resolve_model_path(&format!("model/{}", m.id));
        let downloaded = model_dir.join(m.det_onnx).exists() && model_dir.join(m.rec_onnx).exists();
        models.push(OcrModelInfo {
            id: m.id.to_string(), label: m.label.to_string(),
            engine: "ppocrv6".to_string(), description: m.description.to_string(),
            params: m.params.to_string(), downloaded,
            end_to_end: false,
            repo_dir: m.id.to_string(),
        });
    }

    Ok(models)
}

fn repo_dir_name(repo_id: &str) -> &str {
    repo_id.split('/').last().unwrap_or(repo_id)
}
