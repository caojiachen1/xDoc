//! OCR backend commands (GGUF/PPOCRv6 model init, region recognition, model download).

use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use models_cat::asynchronous::ModelsCat;
use models_cat::Repo;
use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::gguf_ocr;
use crate::ocr_models::{self, OcrEngine};
use crate::ppocrv6;
use super::{
    copy_from_cache, render_pdf_page, resolve_dll_dir, resolve_model_path, ModelDownloadProgress,
    TauriProgress,
};

// ── Special token cleanup ──────────────────────────────────────────────────

/// Strips LLM special tokens (e.g. `<|endofassistant|>`, `<s>`, `[INST]`) from OCR output.
fn clean_special_tokens(text: &str) -> String {
    static SPECIAL_TOKEN: OnceLock<Regex> = OnceLock::new();
    static SOLO_TOKENS: OnceLock<Regex> = OnceLock::new();

    let special = SPECIAL_TOKEN.get_or_init(|| Regex::new(r"<\|[^|]+\|>").unwrap());
    let solo = SOLO_TOKENS.get_or_init(|| Regex::new(r"</?s>|\[INST\]|\[/INST\]").unwrap());

    let text = special.replace_all(text, "");
    let text = solo.replace_all(&text, "");
    text.to_string()
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
    state: State<'_, OcrState>,
) -> Result<OcrRegionResult, String> {
    let cache_key = format!(
        "{}::{}_{}_{}_{}_{}",
        file_path, page_index,
        xmin.round() as i32, ymin.round() as i32,
        xmax.round() as i32, ymax.round() as i32
    );
    if !force_refresh.unwrap_or(false) {
        if let Some(cached_text) = state.ocr_cache.lock().unwrap().get(&cache_key) {
            return Ok(OcrRegionResult { text: cached_text.clone() });
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

    state.ocr_cache.lock().unwrap().insert(cache_key, text.clone());
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
        let mut guard = state.gguf_backend.lock().unwrap();
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
        let mut guard = state.ppocrv6_backend.lock().unwrap();
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

    for m in ocr_models::GGUF_OCR_MODELS {
        let model_dir = resolve_model_path(&format!("model/{}", repo_dir_name(m.repo_id)));
        let downloaded = model_dir.join(m.text_model_q8).exists();
        models.push(OcrModelInfo {
            id: m.id.to_string(), label: m.label.to_string(),
            engine: "gguf".to_string(), description: m.description.to_string(),
            params: m.params.to_string(), downloaded,
        });
    }

    for m in ocr_models::PPOCRV6_MODELS {
        let model_dir = resolve_model_path(&format!("model/{}", m.id));
        let downloaded = model_dir.join(m.det_onnx).exists() && model_dir.join(m.rec_onnx).exists();
        models.push(OcrModelInfo {
            id: m.id.to_string(), label: m.label.to_string(),
            engine: "ppocrv6".to_string(), description: m.description.to_string(),
            params: m.params.to_string(), downloaded,
        });
    }

    Ok(models)
}

fn repo_dir_name(repo_id: &str) -> &str {
    repo_id.split('/').last().unwrap_or(repo_id)
}
