//! OCR backend commands (GGUF model init, region recognition, model download).

use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use models_cat::asynchronous::ModelsCat;
use models_cat::Repo;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::gguf_ocr;
use super::{
    copy_from_cache, render_pdf_page, resolve_dll_dir, resolve_model_path, ModelDownloadProgress,
    TauriProgress,
};

// ── OCR state ──────────────────────────────────────────────────────────────

pub struct OcrState {
    pub backend: Arc<Mutex<Option<gguf_ocr::GgufBackend>>>,
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

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn init_ocr(
    ocr_model_path: String,
    state: State<'_, OcrState>,
) -> Result<String, String> {
    let model_root = resolve_model_path(&ocr_model_path);
    if !model_root.exists() {
        return Err(format!(
            "OCR model directory not found: {}",
            model_root.display()
        ));
    }

    let gguf_file = model_root.join("GLM-OCR-Q8_0.gguf");
    let mmproj_file = model_root.join("mmproj-GLM-OCR-Q8_0.gguf");
    if !gguf_file.exists() {
        return Err(format!("GGUF model not found at: {}", gguf_file.display()));
    }
    if !mmproj_file.exists() {
        return Err(format!(
            "mmproj model not found at: {}",
            mmproj_file.display()
        ));
    }

    let dll_dir = resolve_dll_dir();
    let cpp_lib = gguf_ocr::CppLib::load(
        &dll_dir.join("llama.dll"),
        &dll_dir.join("mtmd.dll"),
    )
    .map_err(|e| format!("Failed to load llama.cpp DLLs: {e}"))?;

    {
        let mut backend_guard = state.backend.lock().unwrap();
        if let Some(ref mut backend) = *backend_guard {
            backend.unload();
        }
        *backend_guard = Some(gguf_ocr::GgufBackend::new(cpp_lib, false));
    }

    *state.model_root.lock().unwrap() = Some(model_root);

    Ok("OCR backend initialized".to_string())
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
    state: State<'_, OcrState>,
) -> Result<OcrRegionResult, String> {
    let cache_key = format!(
        "{}::{}_{}_{}_{}_{}",
        file_path,
        page_index,
        xmin.round() as i32,
        ymin.round() as i32,
        xmax.round() as i32,
        ymax.round() as i32
    );
    if let Some(cached_text) = state.ocr_cache.lock().unwrap().get(&cache_key) {
        return Ok(OcrRegionResult {
            text: cached_text.clone(),
        });
    }

    let model_root = {
        let guard = state.model_root.lock().unwrap();
        guard.clone().ok_or("OCR model not initialized")?
    };

    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }

    let (image, actual_page_index, _page_count) = render_pdf_page(path, page_index)?;

    let img_w = image.width() as f32;
    let img_h = image.height() as f32;

    let cx = (xmin.clamp(0.0, img_w) as u32, ymin.clamp(0.0, img_h) as u32);
    let crop_w = ((xmax - xmin).clamp(1.0, img_w - cx.0 as f32) as u32).max(1);
    let crop_h = ((ymax - ymin).clamp(1.0, img_h - cx.1 as f32) as u32).max(1);

    eprintln!(
        "[OCR] cropping region: orig={}x{} crop=({},{} {}x{})",
        img_w, img_h, cx.0, cx.1, crop_w, crop_h
    );

    let cropped = image.crop_imm(cx.0, cx.1, crop_w, crop_h);

    let temp_dir = env::temp_dir();
    let temp_path = temp_dir.join(format!(
        "xdoc_ocr_region_{}_{}.png",
        actual_page_index,
        (cx.0 as u64) << 32 | cx.1 as u64
    ));
    cropped
        .save(&temp_path)
        .map_err(|e| format!("Failed to save temp image: {e}"))?;

    eprintln!("[OCR] temp image saved: {}", temp_path.display());

    let text = {
        let mut backend_guard = state.backend.lock().unwrap();
        let backend = backend_guard
            .as_mut()
            .ok_or("OCR backend not initialized")?;

        let app_ref = &app;
        let result = backend
            .infer_streaming(&model_root, &temp_path, &mut |piece: &str| {
                let _ = app_ref.emit("ocr-stream-token", OcrStreamToken {
                    piece: piece.to_string(),
                });
            })
            .map_err(|e| format!("OCR inference failed: {e}"))?;

        result.text
    };

    let _ = std::fs::remove_file(&temp_path);

    state.ocr_cache.lock().unwrap().insert(cache_key, text.clone());

    Ok(OcrRegionResult { text })
}

#[tauri::command]
pub(crate) async fn download_ocr_models(
    app: tauri::AppHandle,
    target_dir: String,
) -> Result<String, String> {
    let target_path = resolve_model_path(&target_dir);
    std::fs::create_dir_all(&target_path).map_err(|e| format!("无法创建目录: {e}"))?;

    let repo = Repo::new_model("ggml-org/GLM-OCR-GGUF");
    let mc = ModelsCat::new(repo);

    let all_files = mc
        .list_hub_files()
        .await
        .map_err(|e| format!("获取文件列表失败: {e}"))?;

    let files_to_download: Vec<String> = all_files
        .into_iter()
        .filter(|f| f != "GLM-OCR-f16.gguf")
        .collect();

    if files_to_download.is_empty() {
        return Err("未找到可下载的文件".to_string());
    }

    for (i, file) in files_to_download.iter().enumerate() {
        let progress = TauriProgress {
            app: app.clone(),
            model_type: "ocr".to_string(),
        };

        mc.download_with_progress(file, progress)
            .await
            .map_err(|e| format!("下载 {} 失败: {}", file, e))?;

        let cache_dir = mc.repo().cache_dir();
        copy_from_cache(&cache_dir, file, &target_path)?;

        let overall_pct = ((i + 1) as f64 / files_to_download.len() as f64) * 100.0;
        let _ = app.emit(
            "model-download-progress",
            ModelDownloadProgress {
                model_type: "ocr".to_string(),
                filename: format!("{}/{}", i + 1, files_to_download.len()),
                current: (i + 1) as u64,
                total: files_to_download.len() as u64,
                progress: overall_pct,
                status: "downloading".to_string(),
                message: format!("已完成 {}/{} 个文件", i + 1, files_to_download.len()),
            },
        );
    }

    let _ = app.emit(
        "model-download-progress",
        ModelDownloadProgress {
            model_type: "ocr".to_string(),
            filename: String::new(),
            current: 0,
            total: 0,
            progress: 100.0,
            status: "completed".to_string(),
            message: "OCR 模型下载完成".to_string(),
        },
    );

    Ok(target_path.to_string_lossy().to_string())
}
