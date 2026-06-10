//! Command module — domain-based split of all Tauri commands.
//!
//! Sub-modules:
//!   pdf      — PDF text extraction, rendering, thumbnails, outline, annotations export
//!   model    — ONNX model loading, layout detection, model download
//!   ocr      — OCR backend init, region recognition, model download
//!   paper    — Paper library management (import, delete, rename)
//!   settings — Settings DB, reading sessions, journal ranking, annotation persistence
//!   grobid   — Grobid academic paper parsing engine
//!   misc     — Miscellaneous utilities (git check, file ops, sentence splitting)

pub(crate) mod grobid;
pub(crate) mod misc;
pub(crate) mod model;
pub(crate) mod ocr;
pub(crate) mod paper;
pub(crate) mod pdf;
pub(crate) mod settings;

// ── Shared types ───────────────────────────────────────────────────────────

use std::{
    collections::{HashMap, HashSet},
    env,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use base64::Engine;
use image::{DynamicImage, ImageFormat};
use models_cat::asynchronous::{Progress, ProgressUnit};
use models_cat::OpsError;
use ort::session::Session;
use pdfium_render::prelude::*;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct LayoutBox {
    pub cls_id: u32,
    pub score: f32,
    pub xmin: f32,
    pub ymin: f32,
    pub xmax: f32,
    pub ymax: f32,
    pub read_order: u32,
}

#[derive(Serialize, Clone)]
pub struct TextSegment {
    pub text: String,
    pub xmin: f32,
    pub ymin: f32,
    pub xmax: f32,
    pub ymax: f32,
}

#[derive(Serialize, Clone)]
pub struct ExtractContentResponse {
    pub width: u32,
    pub height: u32,
    pub preview_data_url: String,
    pub page_index: u32,
    pub page_count: u32,
    pub segments: Vec<TextSegment>,
}

#[derive(Serialize, Clone)]
pub struct DetectionResponse {
    pub width: u32,
    pub height: u32,
    pub preview_data_url: String,
    pub source_type: String,
    pub page_index: u32,
    pub page_count: u32,
    pub boxes: Vec<LayoutBox>,
}

#[derive(Clone)]
pub(crate) struct CachedInference {
    pub boxes: Vec<LayoutBox>,
    pub width: u32,
    pub height: u32,
    pub source_type: String,
    pub page_count: u32,
    pub preview_data_url: Option<String>,
}

// ── State structs (managed by Tauri) ──────────────────────────────────────

pub struct ModelState {
    pub session: Arc<Mutex<Option<Session>>>,
    pub inference_cache: Arc<Mutex<HashMap<String, CachedInference>>>,
    pub response_cache: Arc<Mutex<HashMap<String, ExtractContentResponse>>>,
    pub prefetch_tasks: Arc<Mutex<HashSet<String>>>,
}

// ── Model download progress types ─────────────────────────────────────────

#[derive(Serialize, Clone)]
pub(crate) struct ModelDownloadProgress {
    pub model_type: String,
    pub filename: String,
    pub current: u64,
    pub total: u64,
    pub progress: f64,
    pub status: String,
    pub message: String,
}

#[derive(Clone)]
pub(crate) struct TauriProgress {
    pub app: AppHandle,
    pub model_type: String,
}

#[async_trait]
impl Progress for TauriProgress {
    async fn on_start(&mut self, unit: &ProgressUnit) -> std::result::Result<(), OpsError> {
        let _ = self.app.emit(
            "model-download-progress",
            ModelDownloadProgress {
                model_type: self.model_type.clone(),
                filename: unit.filename().to_string(),
                current: 0,
                total: unit.total_size(),
                progress: 0.0,
                status: "downloading".to_string(),
                message: format!("开始下载 {}", unit.filename()),
            },
        );
        Ok(())
    }

    async fn on_progress(&mut self, unit: &ProgressUnit) -> std::result::Result<(), OpsError> {
        let pct = if unit.total_size() > 0 {
            (unit.current() as f64 / unit.total_size() as f64) * 100.0
        } else {
            0.0
        };
        let _ = self.app.emit(
            "model-download-progress",
            ModelDownloadProgress {
                model_type: self.model_type.clone(),
                filename: unit.filename().to_string(),
                current: unit.current(),
                total: unit.total_size(),
                progress: pct,
                status: "downloading".to_string(),
                message: format!("下载中 {} ({:.1}%)", unit.filename(), pct),
            },
        );
        Ok(())
    }

    async fn on_finish(&mut self, unit: &ProgressUnit) -> std::result::Result<(), OpsError> {
        let _ = self.app.emit(
            "model-download-progress",
            ModelDownloadProgress {
                model_type: self.model_type.clone(),
                filename: unit.filename().to_string(),
                current: unit.total_size(),
                total: unit.total_size(),
                progress: 100.0,
                status: "file_completed".to_string(),
                message: format!("{} 下载完成", unit.filename()),
            },
        );
        Ok(())
    }
}

// ── Shared helper functions ────────────────────────────────────────────────

pub(crate) fn threshold_cache_key(threshold: f32) -> i32 {
    (threshold * 1000.0).round() as i32
}

pub(crate) fn make_cache_key(file_path: &str, page_index: u32, threshold: f32) -> String {
    format!(
        "{}::{}::{}",
        file_path,
        page_index,
        threshold_cache_key(threshold)
    )
}

pub(crate) fn make_prefetch_task_key(file_path: &str, threshold: f32) -> String {
    format!("{}::{}", file_path, threshold_cache_key(threshold))
}

pub(crate) fn collect_pdfium_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    let dll_dir = resolve_dll_dir();
    candidates.push(Pdfium::pdfium_platform_library_name_at_path(&dll_dir));

    if let Ok(p) = env::var("PDFIUM_DYNAMIC_LIB_PATH") {
        let path = PathBuf::from(p);
        if path.is_file() {
            candidates.push(path);
        } else {
            candidates.push(Pdfium::pdfium_platform_library_name_at_path(&path));
        }
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(Pdfium::pdfium_platform_library_name_at_path(parent));
            for ancestor in parent.ancestors().take(8) {
                candidates.push(Pdfium::pdfium_platform_library_name_at_path(ancestor));
            }
        }
    }

    if let Ok(cwd) = env::current_dir() {
        candidates.push(Pdfium::pdfium_platform_library_name_at_path(&cwd));
        for ancestor in cwd.ancestors().take(8) {
            candidates.push(Pdfium::pdfium_platform_library_name_at_path(ancestor));
        }
    }

    candidates.sort();
    candidates.dedup();
    candidates
}

pub(crate) fn bind_pdfium_with_candidates() -> Result<Box<dyn PdfiumLibraryBindings>, String> {
    let candidates = collect_pdfium_candidates();
    let existing: Vec<PathBuf> = candidates.into_iter().filter(|p| p.exists()).collect();

    if existing.is_empty() {
        return Err(
            "No pdfium.dll found in candidate paths. Put pdfium.dll in one of: executable directory, current working directory, project root, or set PDFIUM_DYNAMIC_LIB_PATH to the dll full path."
                .to_string(),
        );
    }

    let mut errors: Vec<String> = Vec::new();
    for dll_path in &existing {
        match Pdfium::bind_to_library(dll_path) {
            Ok(bindings) => return Ok(bindings),
            Err(e) => errors.push(format!("{} => {}", dll_path.display(), e)),
        }
    }

    Err(format!(
        "Found pdfium.dll but failed to load from all candidate paths (often due to missing dependent runtime DLLs or x86/x64 mismatch). Attempts:\n{}",
        errors.join("\n")
    ))
}

pub(crate) fn render_pdf_page(
    path: &Path,
    requested_page_index: u32,
) -> Result<(DynamicImage, u32, u32), String> {
    let bindings = bind_pdfium_with_candidates()?;

    let pdfium = Pdfium::new(bindings);
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("Failed to open PDF: {e}"))?;

    let page_count = document.pages().len() as u32;
    if page_count == 0 {
        return Err("PDF has no pages".to_string());
    }

    let page_index = requested_page_index.min(page_count - 1);

    let page = document
        .pages()
        .get(page_index as u16)
        .map_err(|e| format!("Failed to get page {page_index}: {e}"))?;

    let rendered = page
        .render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(1600)
                .rotate_if_landscape(PdfPageRenderRotation::None, true),
        )
        .map_err(|e| format!("Failed to render PDF page: {e}"))?;

    Ok((rendered.as_image(), page_index, page_count))
}

pub(crate) fn load_document_as_image(
    path: &str,
    page_index: Option<u32>,
) -> Result<(DynamicImage, String, u32, u32), String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err("Input file not found".to_string());
    }

    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if ext == "pdf" {
        let requested = page_index.unwrap_or(0);
        return render_pdf_page(file_path, requested)
            .map(|(img, page_index, page_count)| (img, "pdf".to_string(), page_index, page_count));
    }

    let image = image::open(file_path).map_err(|e| format!("Failed to open image: {e}"))?;
    Ok((image, "image".to_string(), 0, 1))
}

pub(crate) fn image_to_data_url(image: &DynamicImage) -> Result<String, String> {
    let mut bytes = Cursor::new(Vec::<u8>::new());
    image
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|e| format!("Failed to encode preview image: {e}"))?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes.into_inner());
    Ok(format!("data:image/png;base64,{encoded}"))
}

pub(crate) fn copy_from_cache(
    cache_dir: &Path,
    filename: &str,
    target_dir: &Path,
) -> Result<(), String> {
    for entry in walkdir::WalkDir::new(cache_dir)
        .max_depth(10)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() && entry.file_name() == filename {
            let target = target_dir.join(filename);
            std::fs::copy(entry.path(), &target)
                .map_err(|e| format!("复制文件失败: {e}"))?;
            return Ok(());
        }
    }
    Err(format!("在缓存中未找到文件: {}", filename))
}

pub(crate) fn resolve_dll_dir() -> PathBuf {
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let bundled = exe_dir.join("llama.dll");
            if bundled.exists() {
                return exe_dir.to_path_buf();
            }
            for ancestor in exe_dir.ancestors() {
                let candidate = ancestor.join("lib").join("llama.dll");
                if candidate.exists() {
                    return ancestor.join("lib");
                }
            }
        }
    }
    PathBuf::from("lib")
}

pub(crate) fn resolve_model_path(model_path: &str) -> PathBuf {
    let path = PathBuf::from(model_path);
    if path.is_absolute() {
        return path;
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            return exe_dir.join(path);
        }
    }
    path
}
