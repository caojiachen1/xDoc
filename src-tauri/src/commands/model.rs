//! ONNX model loading, layout detection inference, and model download commands.

use image::{imageops::FilterType, DynamicImage};
use models_cat::asynchronous::ModelsCat;
use models_cat::Repo;
use ndarray::{Array2, Array4};
use ort::{session::Session, value::Tensor};
use tauri::{Emitter, State};

use super::{
    copy_from_cache, image_to_data_url, load_document_as_image, make_cache_key, resolve_model_path,
    CachedInference, DetectionResponse, LayoutBox, ModelState, ModelDownloadProgress,
    TauriProgress,
};

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn load_model(
    model_path: String,
    state: State<'_, ModelState>,
) -> Result<String, String> {
    let resolved = resolve_model_path(&model_path);
    if !resolved.exists() {
        return Err(format!("Model file not found: {}", resolved.display()));
    }

    let resolved_str = resolved.to_string_lossy().to_string();
    let session_arc = state.session.clone();
    let inference_cache_arc = state.inference_cache.clone();
    let prefetch_arc = state.prefetch_tasks.clone();
    let response_cache_arc = state.response_cache.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let t0 = std::time::Instant::now();
        eprintln!("[xDoc:model] loading ONNX model from {}...", resolved_str);

        let session = Session::builder()
            .map_err(|e| e.to_string())?
            .commit_from_file(&resolved_str)
            .map_err(|e| e.to_string())?;

        eprintln!(
            "[xDoc:model] ONNX session created (+{}ms)",
            t0.elapsed().as_millis()
        );

        *session_arc.lock().unwrap() = Some(session);
        inference_cache_arc.lock().unwrap().clear();
        prefetch_arc.lock().unwrap().clear();
        response_cache_arc.lock().unwrap().clear();

        eprintln!(
            "[xDoc:model] model loaded successfully (+{}ms)",
            t0.elapsed().as_millis()
        );
        Ok("Model loaded successfully".to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

#[tauri::command]
pub(crate) async fn run_doclayout(
    file_path: String,
    score_threshold: Option<f32>,
    page_index: Option<u32>,
    state: State<'_, ModelState>,
) -> Result<DetectionResponse, String> {
    let threshold = score_threshold.unwrap_or(0.5).clamp(0.0, 1.0);

    // Check cache first
    {
        let page_idx = page_index.unwrap_or(0);
        let cache_key = make_cache_key(&file_path, page_idx, threshold);
        let cache = state.inference_cache.lock().unwrap();
        if let Some(entry) = cache.get(&cache_key) {
            if let Some(ref pdu) = entry.preview_data_url {
                let response = DetectionResponse {
                    width: entry.width,
                    height: entry.height,
                    preview_data_url: pdu.clone(),
                    source_type: entry.source_type.clone(),
                    page_index: page_idx,
                    page_count: entry.page_count,
                    boxes: entry.boxes.clone(),
                };
                return Ok(response);
            }
        }
    }

    let (image, source_type, page_index, page_count) =
        load_document_as_image(&file_path, page_index)?;
    let preview_data_url = image_to_data_url(&image)?;
    let cache_key = make_cache_key(&file_path, page_index, threshold);

    let cached_entry = {
        let cache = state.inference_cache.lock().unwrap();
        cache.get(&cache_key).cloned()
    };

    let (boxes, width, height, response_source_type, response_page_count, cached_preview) =
        if let Some(entry) = cached_entry {
            (
                entry.boxes,
                entry.width,
                entry.height,
                entry.source_type,
                entry.page_count,
                entry.preview_data_url,
            )
        } else {
            let inferred_boxes = {
                let mut guard = state.session.lock().unwrap();
                let session = guard.as_mut().ok_or("Model not loaded")?;
                infer_layout_boxes(session, &image, threshold)?
            };

            let width = image.width();
            let height = image.height();
            let entry = CachedInference {
                boxes: inferred_boxes.clone(),
                width,
                height,
                source_type: source_type.clone(),
                page_count,
                preview_data_url: Some(preview_data_url.clone()),
            };
            state
                .inference_cache
                .lock()
                .unwrap()
                .insert(cache_key, entry);

            (
                inferred_boxes,
                width,
                height,
                source_type.clone(),
                page_count,
                Some(preview_data_url.clone()),
            )
        };

    let preview_data_url = cached_preview.unwrap_or(preview_data_url);

    if source_type == "pdf" && page_count > 1 {
        super::pdf::spawn_prefetch_for_pdf(
            file_path.clone(),
            page_count,
            page_index,
            threshold,
            state.session.clone(),
            state.inference_cache.clone(),
            state.response_cache.clone(),
            state.prefetch_tasks.clone(),
        );
    }

    Ok(DetectionResponse {
        width,
        height,
        preview_data_url,
        source_type: response_source_type,
        page_index,
        page_count: response_page_count,
        boxes,
    })
}

#[tauri::command]
pub(crate) async fn download_onnx_model(
    app: tauri::AppHandle,
    target_dir: String,
) -> Result<String, String> {
    let target_path = resolve_model_path(&target_dir);
    std::fs::create_dir_all(&target_path).map_err(|e| format!("无法创建目录: {e}"))?;

    let repo = Repo::new_model("cjc1887415157/PP-DocLayoutV3-ONNX");
    let mc = ModelsCat::new(repo);
    let progress = TauriProgress {
        app: app.clone(),
        model_type: "layout".to_string(),
    };

    mc.download_with_progress("PP-DocLayoutV3.onnx", progress)
        .await
        .map_err(|e| format!("下载失败: {e}"))?;

    let cache_dir = mc.repo().cache_dir();
    copy_from_cache(&cache_dir, "PP-DocLayoutV3.onnx", &target_path)?;

    let target_file = target_path.join("PP-DocLayoutV3.onnx");

    let _ = app.emit(
        "model-download-progress",
        ModelDownloadProgress {
            model_type: "layout".to_string(),
            filename: String::new(),
            current: 0,
            total: 0,
            progress: 100.0,
            status: "completed".to_string(),
            message: "布局分析模型下载完成".to_string(),
        },
    );

    Ok(target_file.to_string_lossy().to_string())
}

// ── Internal helpers ───────────────────────────────────────────────────────

pub(crate) fn infer_layout_boxes(
    session: &mut Session,
    image: &DynamicImage,
    threshold: f32,
) -> Result<Vec<LayoutBox>, String> {
    let (input_blob, preprocess_shape, scale) = preprocess_image_doclayout(image);

    let inputs_names: Vec<String> = session
        .inputs()
        .iter()
        .map(|i| i.name().to_string())
        .collect();
    if inputs_names.len() < 3 {
        return Err("Model has fewer than 3 inputs; PP-DocLayoutV3 ONNX expected".to_string());
    }

    let shape_tensor = Tensor::from_array(preprocess_shape).map_err(|e| e.to_string())?;
    let blob_tensor = Tensor::from_array(input_blob).map_err(|e| e.to_string())?;
    let scale_tensor = Tensor::from_array(scale).map_err(|e| e.to_string())?;

    let outputs = session
        .run(ort::inputs![
            inputs_names[0].as_str() => shape_tensor,
            inputs_names[1].as_str() => blob_tensor,
            inputs_names[2].as_str() => scale_tensor,
        ])
        .map_err(|e| e.to_string())?;

    let (shape, output_tensor) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;

    let mut boxes = Vec::new();
    if shape.len() == 2 && shape[1] == 7 {
        let n_boxes = shape[0] as usize;
        for i in 0..n_boxes {
            let score = output_tensor[i * 7 + 1];
            if score > threshold {
                boxes.push(LayoutBox {
                    cls_id: output_tensor[i * 7 + 0] as u32,
                    score,
                    xmin: output_tensor[i * 7 + 2],
                    ymin: output_tensor[i * 7 + 3],
                    xmax: output_tensor[i * 7 + 4],
                    ymax: output_tensor[i * 7 + 5],
                    read_order: output_tensor[i * 7 + 6] as u32,
                });
            }
        }
    }

    boxes.sort_by_key(|b| b.read_order);
    Ok(boxes)
}

fn preprocess_image_doclayout(image: &DynamicImage) -> (Array4<f32>, Array2<f32>, Array2<f32>) {
    let orig_w = image.width() as f32;
    let orig_h = image.height() as f32;

    let target_w = 800.0f32;
    let target_h = 800.0f32;
    let scale_h = target_h / orig_h;
    let scale_w = target_w / orig_w;

    let resized = image.resize_exact(target_w as u32, target_h as u32, FilterType::Triangle);
    let rgb = resized.to_rgb8();

    let mean = [0.485f32, 0.456, 0.406];
    let std = [0.229f32, 0.224, 0.225];
    let mut input_blob = Array4::<f32>::zeros((1, 3, target_h as usize, target_w as usize));

    for (x, y, pixel) in rgb.enumerate_pixels() {
        let r = pixel[0] as f32 / 255.0;
        let g = pixel[1] as f32 / 255.0;
        let b = pixel[2] as f32 / 255.0;

        input_blob[[0, 0, y as usize, x as usize]] = (r - mean[0]) / std[0];
        input_blob[[0, 1, y as usize, x as usize]] = (g - mean[1]) / std[1];
        input_blob[[0, 2, y as usize, x as usize]] = (b - mean[2]) / std[2];
    }

    let preprocess_shape =
        Array2::<f32>::from_shape_vec((1, 2), vec![target_h, target_w]).expect("valid shape");
    let scale = Array2::<f32>::from_shape_vec((1, 2), vec![scale_h, scale_w]).expect("valid shape");

    (input_blob, preprocess_shape, scale)
}
