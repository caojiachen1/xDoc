use base64::Engine;
use image::{imageops::FilterType, DynamicImage, ImageFormat};
use ndarray::{Array2, Array4};
use ort::{session::Session, value::Tensor};
use pdfium_render::prelude::*;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    env,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};
use tauri::State;

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

#[derive(Serialize)]
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
struct CachedInference {
    pub boxes: Vec<LayoutBox>,
    pub width: u32,
    pub height: u32,
    pub source_type: String,
    pub page_count: u32,
}

pub struct ModelState {
    session: Arc<Mutex<Option<Session>>>,
    inference_cache: Arc<Mutex<HashMap<String, CachedInference>>>,
    prefetch_tasks: Arc<Mutex<HashSet<String>>>,
}

fn threshold_cache_key(threshold: f32) -> i32 {
    (threshold * 1000.0).round() as i32
}

fn make_cache_key(file_path: &str, page_index: u32, threshold: f32) -> String {
    format!("{}::{}::{}", file_path, page_index, threshold_cache_key(threshold))
}

fn make_prefetch_task_key(file_path: &str, threshold: f32) -> String {
    format!("{}::{}", file_path, threshold_cache_key(threshold))
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

fn collect_pdfium_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

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

fn bind_pdfium_with_candidates() -> Result<Box<dyn PdfiumLibraryBindings>, String> {
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

fn render_pdf_page(path: &Path, requested_page_index: u32) -> Result<(DynamicImage, u32, u32), String> {
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

fn load_document_as_image(path: &str, page_index: Option<u32>) -> Result<(DynamicImage, String, u32, u32), String> {
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
        return render_pdf_page(file_path, requested).map(|(img, page_index, page_count)| {
            (img, "pdf".to_string(), page_index, page_count)
        });
    }

    let image = image::open(file_path).map_err(|e| format!("Failed to open image: {e}"))?;
    Ok((image, "image".to_string(), 0, 1))
}

fn image_to_data_url(image: &DynamicImage) -> Result<String, String> {
    let mut bytes = Cursor::new(Vec::<u8>::new());
    image
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|e| format!("Failed to encode preview image: {e}"))?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes.into_inner());
    Ok(format!("data:image/png;base64,{encoded}"))
}

fn infer_layout_boxes(
    session: &mut Session,
    image: &DynamicImage,
    threshold: f32,
) -> Result<Vec<LayoutBox>, String> {
    let (input_blob, preprocess_shape, scale) = preprocess_image_doclayout(image);

    let inputs_names: Vec<String> = session.inputs().iter().map(|i| i.name().to_string()).collect();
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

fn spawn_prefetch_for_pdf(
    file_path: String,
    page_count: u32,
    requested_page: u32,
    threshold: f32,
    session: Arc<Mutex<Option<Session>>>,
    inference_cache: Arc<Mutex<HashMap<String, CachedInference>>>,
    prefetch_tasks: Arc<Mutex<HashSet<String>>>,
) {
    let task_key = make_prefetch_task_key(&file_path, threshold);
    {
        let mut tasks = prefetch_tasks.lock().unwrap();
        if tasks.contains(&task_key) {
            return;
        }
        tasks.insert(task_key.clone());
    }

    thread::spawn(move || {
        for p in 0..page_count {
            if p == requested_page {
                continue;
            }

            let cache_key = make_cache_key(&file_path, p, threshold);
            let has_cache = {
                let cache = inference_cache.lock().unwrap();
                cache.contains_key(&cache_key)
            };
            if has_cache {
                continue;
            }

            let Ok((image, source_type, _page_index, page_count_local)) =
                load_document_as_image(&file_path, Some(p))
            else {
                continue;
            };

            let infer_res = {
                let mut guard = session.lock().unwrap();
                let Some(session_ref) = guard.as_mut() else {
                    return;
                };
                infer_layout_boxes(session_ref, &image, threshold)
            };

            let Ok(boxes) = infer_res else {
                continue;
            };

            let entry = CachedInference {
                boxes,
                width: image.width(),
                height: image.height(),
                source_type,
                page_count: page_count_local,
            };

            let mut cache = inference_cache.lock().unwrap();
            cache.insert(cache_key, entry);
        }

        let mut tasks = prefetch_tasks.lock().unwrap();
        tasks.remove(&task_key);
    });
}

#[tauri::command]
async fn load_model(
    model_path: String,
    state: State<'_, ModelState>,
) -> Result<String, String> {
    if !std::path::Path::new(&model_path).exists() {
        return Err("Model file not found".to_string());
    }

    let session = Session::builder()
        .map_err(|e| e.to_string())?
        .commit_from_file(&model_path)
        .map_err(|e| e.to_string())?;

    *state.session.lock().unwrap() = Some(session);
    state.inference_cache.lock().unwrap().clear();
    state.prefetch_tasks.lock().unwrap().clear();

    Ok("Model loaded successfully".to_string())
}

#[tauri::command]
async fn run_doclayout(
    file_path: String,
    score_threshold: Option<f32>,
    page_index: Option<u32>,
    state: State<'_, ModelState>,
) -> Result<DetectionResponse, String> {
    let threshold = score_threshold.unwrap_or(0.5).clamp(0.0, 1.0);
    let (image, source_type, page_index, page_count) = load_document_as_image(&file_path, page_index)?;
    let preview_data_url = image_to_data_url(&image)?;
    let cache_key = make_cache_key(&file_path, page_index, threshold);

    let cached_entry = {
        let cache = state.inference_cache.lock().unwrap();
        cache.get(&cache_key).cloned()
    };

    let (boxes, width, height, response_source_type, response_page_count) = if let Some(entry) = cached_entry {
        (
            entry.boxes,
            entry.width,
            entry.height,
            entry.source_type,
            entry.page_count,
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
        };
        state.inference_cache.lock().unwrap().insert(cache_key, entry);

        (inferred_boxes, width, height, source_type.clone(), page_count)
    };

    if source_type == "pdf" && page_count > 1 {
        spawn_prefetch_for_pdf(
            file_path.clone(),
            page_count,
            page_index,
            threshold,
            state.session.clone(),
            state.inference_cache.clone(),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ModelState {
            session: Arc::new(Mutex::new(None)),
            inference_cache: Arc::new(Mutex::new(HashMap::new())),
            prefetch_tasks: Arc::new(Mutex::new(HashSet::new())),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![load_model, run_doclayout])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
