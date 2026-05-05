use base64::Engine;
use image::{imageops::FilterType, DynamicImage, ImageFormat};
use ndarray::{Array2, Array4};
use ort::{session::Session, value::Tensor};
use pdfium_render::prelude::*;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    env,
    io::{BufRead, BufReader, Cursor},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{Emitter, State};

#[allow(dead_code)]
mod gguf_ocr;

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

#[derive(Serialize, Clone)]
pub struct TextSegment {
    pub text: String,
    pub xmin: f32,
    pub ymin: f32,
    pub xmax: f32,
    pub ymax: f32,
}

#[derive(Serialize)]
pub struct ExtractContentResponse {
    pub width: u32,
    pub height: u32,
    pub preview_data_url: String,
    pub page_index: u32,
    pub page_count: u32,
    pub segments: Vec<TextSegment>,
}

fn extract_raw_text_segments(path: &Path, page_index: u32) -> Result<Vec<TextSegment>, String> {
    let bindings = bind_pdfium_with_candidates()?;
    let pdfium = Pdfium::new(bindings);

    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("Failed to open PDF: {e}"))?;

    let page = document
        .pages()
        .get(page_index as u16)
        .map_err(|e| format!("Failed to get page {page_index}: {e}"))?;

    let scale = 1600.0 / page.width().value;
    let page_height = page.height().value;
    let mut segments = Vec::new();


    for (_obj_idx, obj) in page.objects().iter().enumerate() {
        if let Some(text_obj) = obj.as_text_object() {
            let text = text_obj.text();

            if !text.trim().is_empty() {
                if let Ok(bounds) = text_obj.bounds() {
                    let mut xmin = bounds.left().value * scale;
                    let mut xmax = bounds.right().value * scale;
                    let mut ymin = (page_height - bounds.top().value) * scale;
                    let mut ymax = (page_height - bounds.bottom().value) * scale;

                    if ymin > ymax {
                        std::mem::swap(&mut ymin, &mut ymax);
                    }
                    if xmin > xmax {
                        std::mem::swap(&mut xmin, &mut xmax);
                    }

                    let _truncated: String = text.chars().take(50).collect();

                    segments.push(TextSegment {
                        text,
                        xmin,
                        ymin,
                        xmax,
                        ymax,
                    });
                }
            }
        }
    }


    Ok(segments)
}

fn merge_segments_into_paragraphs(raw_segments: Vec<TextSegment>) -> Vec<TextSegment> {
    if raw_segments.is_empty() {
        return raw_segments;
    }

    // Calculate average text height for threshold estimation
    let heights: Vec<f32> = raw_segments
        .iter()
        .map(|s| s.ymax - s.ymin)
        .filter(|h| *h > 0.0)
        .collect();
    let avg_height = if heights.is_empty() {
        12.0
    } else {
        // Use median height to reduce influence of tiny fragments (subscripts etc.)
        let mut h_sorted = heights;
        h_sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        h_sorted[h_sorted.len() / 2]
    };

    // Use a wider tolerance: 0.8× median height, with a floor of 5.0 px.
    // This keeps same-line fragments (which may have slightly different baselines
    // due to subscripts, font changes, or kerning splits) in the same Y-bucket.
    let line_tolerance = (avg_height * 0.8).max(5.0);


    // Sort: primary by Y-center bucketing, secondary by X
    let mut sorted: Vec<TextSegment> = raw_segments.into_iter().collect();
    sorted.sort_by(|a, b| {
        let ya = ((a.ymin + a.ymax) / 2.0 / line_tolerance).round() as i32;
        let yb = ((b.ymin + b.ymax) / 2.0 / line_tolerance).round() as i32;
        ya.cmp(&yb).then_with(|| {
            a.xmin
                .partial_cmp(&b.xmin)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });

    // Debug: print sorted order
    for (_i, seg) in sorted.iter().enumerate() {
        let cy = (seg.ymin + seg.ymax) / 2.0;
        let _y_bucket = (cy / line_tolerance).round() as i32;
        let _truncated: String = seg.text.chars().take(40).collect();
    }

    // Group into lines by Y-overlap
    let mut lines: Vec<Vec<TextSegment>> = Vec::new();
    for (_seg_idx, seg) in sorted.into_iter().enumerate() {
        let seg_cy = (seg.ymin + seg.ymax) / 2.0;

        let match_idx = lines
            .iter()
            .enumerate()
            .rev()
            .take(6)
            .find(|(_, line)| {
                let line_cy =
                    line.iter().map(|s| (s.ymin + s.ymax) / 2.0).sum::<f32>() / line.len() as f32;

                let line_xmin = line.iter().map(|s| s.xmin).fold(f32::MAX, f32::min);
                let line_xmax = line.iter().map(|s| s.xmax).fold(f32::MIN, f32::max);

                // Calculate horizontal distance between the segments and the existing line bounding box
                let x_dist = if seg.xmin > line_xmax {
                    seg.xmin - line_xmax
                } else if line_xmin > seg.xmax {
                    line_xmin - seg.xmax
                } else {
                    0.0 // overlapping horizontally
                };

                // Allow a segment on the same line if Y-overlap is close
                // AND there is no massive horizontal gap (i.e. jumping to next column).
                (seg_cy - line_cy).abs() < line_tolerance && x_dist < avg_height * 4.0
            })
            .map(|(i, _)| i);

        if let Some(idx) = match_idx {
            let _line_cy: f32 = lines[idx].iter().map(|s| (s.ymin + s.ymax) / 2.0).sum::<f32>()
                / lines[idx].len() as f32;
            let _truncated: String = seg.text.chars().take(30).collect();
            lines[idx].push(seg);
        } else {
            let _truncated: String = seg.text.chars().take(30).collect();
            lines.push(vec![seg]);
        }
    }


    // For each line, sort by X and merge into a single segment
    let mut line_segments: Vec<TextSegment> = Vec::new();
    for (_line_idx, mut line) in lines.into_iter().enumerate() {
        line.sort_by(|a, b| {
            a.xmin
                .partial_cmp(&b.xmin)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let merged_text: String = line.iter().map(|s| s.text.as_str()).collect();
        let xmin = line.iter().map(|s| s.xmin).fold(f32::MAX, f32::min);
        let xmax = line.iter().map(|s| s.xmax).fold(f32::MIN, f32::max);
        let ymin = line.iter().map(|s| s.ymin).fold(f32::MAX, f32::min);
        let ymax = line.iter().map(|s| s.ymax).fold(f32::MIN, f32::max);

        let _truncated: String = merged_text.chars().take(60).collect();

        line_segments.push(TextSegment {
            text: merged_text,
            xmin,
            ymin,
            xmax,
            ymax,
        });
    }

    if line_segments.len() <= 1 {
        return line_segments;
    }

    // Safety step: Ensure line_segments are strongly ordered top-to-bottom, left-to-right.
    // If lines were formed in broken order due to disjoint column processing, this reorders them.
    line_segments.sort_by(|a, b| {
        let ya = ((a.ymin + a.ymax) / 2.0 / line_tolerance).round() as i32;
        let yb = ((b.ymin + b.ymax) / 2.0 / line_tolerance).round() as i32;
        ya.cmp(&yb).then_with(|| {
            a.xmin
                .partial_cmp(&b.xmin)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });

    for (_i, ls) in line_segments.iter().enumerate() {
        let _truncated: String = ls.text.chars().take(50).collect();
    }

    // Merge consecutive lines into paragraphs based on multiple heuristics
    // Calculate median gap between consecutive lines
    let mut gaps: Vec<f32> = line_segments
        .windows(2)
        .map(|w| w[1].ymin - w[0].ymax)
        .filter(|g| *g > 0.0)
        .collect();
    gaps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let median_gap = if gaps.is_empty() {
        avg_height * 1.2
    } else {
        gaps[gaps.len() / 2]
    };

    // Paragraph break needs gap > 2x median line spacing
    let gap_break_threshold = median_gap * 2.0;


    let mut paragraphs: Vec<TextSegment> = Vec::new();
    let mut current_group: Vec<TextSegment> = Vec::new();

    for (_seg_idx, seg) in line_segments.into_iter().enumerate() {
        if current_group.is_empty() {
            let _truncated: String = seg.text.chars().take(30).collect();
            current_group.push(seg);
            continue;
        }

        let prev = current_group.last().unwrap();
        let gap = seg.ymin - prev.ymax;

        // Full-line reference: max width of lines in current group
        let group_max_width = current_group
            .iter()
            .map(|s| s.xmax - s.xmin)
            .fold(0.0f32, f32::max);

        let prev_width = prev.xmax - prev.xmin;
        let this_xmin = seg.xmin;
        let prev_xmin = prev.xmin;

        // Guard: if lines overlap vertically (gap is small or negative),
        // they are likely fragments of the same visual line. Never break
        // paragraph here — indentation and column heuristics are unreliable
        // when PDF text objects have been split by font/kerning changes.
        let same_visual_line = gap <= line_tolerance;

        // Heuristic 1: gap significantly larger than typical line spacing
        let gap_break = gap > gap_break_threshold;

        // Heuristic 2: previous line is a short last line (ends well before full width)
        let short_last_line = group_max_width > 0.0 && prev_width < group_max_width * 0.55;

        // Heuristic 3: first-line indentation (new paragraph starts further right)
        let indented_start = this_xmin > prev_xmin + avg_height * 0.8;

        // Heuristic 4: significant X-shift indicates a different column or block
        let column_break = (this_xmin - prev_xmin).abs() > avg_height * 4.0;

        let is_paragraph_break = !same_visual_line
            && (gap_break || short_last_line || indented_start || column_break);

        let _truncated: String = seg.text.chars().take(30).collect();
        let _prev_truncated: String = prev.text.chars().take(30).collect();

        if !is_paragraph_break {
            current_group.push(seg);
        } else {
            let merged = merge_group(&current_group);
            {
                let _t: String = merged.text.chars().take(60).collect();
            }
            paragraphs.push(merged);
            current_group = vec![seg];
        }
    }

    if !current_group.is_empty() {
        let merged = merge_group(&current_group);
        {
            let _t: String = merged.text.chars().take(60).collect();
        }
        paragraphs.push(merged);
    }

    for (_i, p) in paragraphs.iter().enumerate() {
        let _t: String = p.text.chars().take(80).collect();
    }

    paragraphs
}

fn merge_group(group: &[TextSegment]) -> TextSegment {
    let mut text = String::new();
    for (i, s) in group.iter().enumerate() {
        let mut appended = false;
        if i > 0 {
            // First, trim any whitespace at the end of the existing text.
            let trimmed = text.trim_end();
            if trimmed.ends_with('\x02') {
                // If it ends with \x02, we forcefully strip the \x02 and trailing spaces
                let stripped = &trimmed[..trimmed.len() - 1];
                text = stripped.to_string();

                // Also forcefully strip any leading spaces of the incoming segment
                text.push_str(s.text.trim_start());
                appended = true;
            }
        }

        if !appended {
            if i > 0 {
                text.push('\n');
            }
            text.push_str(&s.text);
        }
    }
    // Clean up any remaining soft hyphens just in case
    text = text.replace('\x02', "");

    let xmin = group.iter().map(|s| s.xmin).fold(f32::MAX, f32::min);
    let xmax = group.iter().map(|s| s.xmax).fold(f32::MIN, f32::max);
    let ymin = group.iter().map(|s| s.ymin).fold(f32::MAX, f32::min);
    let ymax = group.iter().map(|s| s.ymax).fold(f32::MIN, f32::max);
    TextSegment {
        text,
        xmin,
        ymin,
        xmax,
        ymax,
    }
}

fn merge_segments_with_layout(
    raw_segments: Vec<TextSegment>,
    layout_boxes: &[LayoutBox],
) -> Vec<TextSegment> {
    // Collect text-region layout boxes, everything can contain text except maybe pure figures.
    // For safety, we can process all layout boxes, or exclude only figure(2).
    // Let's include everything to ensure "每个检测到的区域" is clickable if it has text.
    let mut text_boxes: Vec<&LayoutBox> = layout_boxes.iter().collect();
    text_boxes.sort_by_key(|b| b.read_order);

    for (_i, _tb) in text_boxes.iter().enumerate() {
    }

    if text_boxes.is_empty() {
        return merge_segments_into_paragraphs(raw_segments);
    }

    let mut result: Vec<TextSegment> = Vec::new();
    let mut assigned: HashSet<usize> = HashSet::new();

    for (_tb_idx, tb) in text_boxes.iter().enumerate() {
        // Collect all raw text segments whose center falls within this layout box
        let mut region_segs: Vec<TextSegment> = Vec::new();
        for (i, seg) in raw_segments.iter().enumerate() {
            if assigned.contains(&i) {
                continue;
            }
            let cx = (seg.xmin + seg.xmax) / 2.0;
            let cy = (seg.ymin + seg.ymax) / 2.0;
            if cx >= tb.xmin && cx <= tb.xmax && cy >= tb.ymin && cy <= tb.ymax {
                region_segs.push(seg.clone());
                assigned.insert(i);
            }
        }


        if region_segs.is_empty() {
            continue;
        }

        // Use the line-based grouping logic to assemble text correctly without text scrambling
        let merged_paragraphs = merge_segments_into_paragraphs(region_segs);

        // Merge all paragraphs in this layout box into one block
        let text: String = merged_paragraphs
            .into_iter()
            .map(|p| p.text)
            .collect::<Vec<_>>()
            .join("\n");

        let _truncated: String = text.chars().take(80).collect();

        result.push(TextSegment {
            text,
            xmin: tb.xmin,
            ymin: tb.ymin,
            xmax: tb.xmax,
            ymax: tb.ymax,
        });
    }

    // Handle unassigned segments (outside any text layout box)
    let unassigned: Vec<TextSegment> = raw_segments
        .iter()
        .enumerate()
        .filter(|(i, _)| !assigned.contains(i))
        .map(|(_, s)| s.clone())
        .collect();

    if !unassigned.is_empty() {
        for (_i, seg) in unassigned.iter().enumerate() {
            let _truncated: String = seg.text.chars().take(40).collect();
        }
        let paragraphs = merge_segments_into_paragraphs(unassigned);
        result.extend(paragraphs);
    }


    result
}

#[tauri::command]
async fn get_pdf_paragraphs(
    file_path: String,
    page_index: u32,
    score_threshold: Option<f32>,
    state: State<'_, ModelState>,
) -> Result<ExtractContentResponse, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }

    let threshold = score_threshold.unwrap_or(0.5).clamp(0.0, 1.0);
    let (image, actual_page_index, page_count) = render_pdf_page(path, page_index)?;
    let preview_data_url = image_to_data_url(&image)?;
    let raw_segments = extract_raw_text_segments(path, actual_page_index)?;

    let cache_key = make_cache_key(&file_path, actual_page_index, threshold);
    let cached_boxes = {
        let cache = state.inference_cache.lock().unwrap();
        cache.get(&cache_key).map(|e| e.boxes.clone())
    };

    let layout_boxes = if let Some(boxes) = cached_boxes {
        Some(boxes)
    } else {
        // Run layout inference now so we get model-guided paragraph regions
        let mut session_guard = state.session.lock().unwrap();
        if let Some(ref mut session) = *session_guard {
            match infer_layout_boxes(session, &image, threshold) {
                Ok(boxes) => {
                    drop(session_guard);
                    let entry = CachedInference {
                        boxes: boxes.clone(),
                        width: image.width(),
                        height: image.height(),
                        source_type: "pdf".to_string(),
                        page_count,
                    };
                    state
                        .inference_cache
                        .lock()
                        .unwrap()
                        .insert(cache_key, entry);
                    Some(boxes)
                }
                Err(_) => {
                    drop(session_guard);
                    None
                }
            }
        } else {
            None
        }
    };

    let segments = if let Some(ref boxes) = layout_boxes {
        merge_segments_with_layout(raw_segments, boxes)
    } else {
        merge_segments_into_paragraphs(raw_segments)
    };

    // Trigger prefetch for other pages in background
    if page_count > 1 {
        spawn_prefetch_for_pdf(
            file_path.clone(),
            page_count,
            actual_page_index,
            threshold,
            state.session.clone(),
            state.inference_cache.clone(),
            state.prefetch_tasks.clone(),
        );
    }

    Ok(ExtractContentResponse {
        width: image.width(),
        height: image.height(),
        preview_data_url,
        page_index: actual_page_index,
        page_count,
        segments,
    })
}

#[tauri::command]
async fn get_pdf_text(
    file_path: String,
    page_index: u32,
) -> Result<ExtractContentResponse, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }

    let (image, actual_page_index, page_count) = render_pdf_page(path, page_index)?;
    let preview_data_url = image_to_data_url(&image)?;
    let raw_segments = extract_raw_text_segments(path, actual_page_index)?;
    let segments = merge_segments_into_paragraphs(raw_segments);

    Ok(ExtractContentResponse {
        width: image.width(),
        height: image.height(),
        preview_data_url,
        page_index: actual_page_index,
        page_count,
        segments,
    })
}

pub struct ModelState {
    session: Arc<Mutex<Option<Session>>>,
    inference_cache: Arc<Mutex<HashMap<String, CachedInference>>>,
    prefetch_tasks: Arc<Mutex<HashSet<String>>>,
}

pub struct OcrState {
    backend: Arc<Mutex<Option<gguf_ocr::GgufBackend>>>,
    model_root: Arc<Mutex<Option<PathBuf>>>,
}

fn threshold_cache_key(threshold: f32) -> i32 {
    (threshold * 1000.0).round() as i32
}

fn make_cache_key(file_path: &str, page_index: u32, threshold: f32) -> String {
    format!(
        "{}::{}::{}",
        file_path,
        page_index,
        threshold_cache_key(threshold)
    )
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

    // Prioritize the lib/ directory (same place as llama.cpp DLLs)
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

fn render_pdf_page(
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

fn load_document_as_image(
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
async fn load_model(model_path: String, state: State<'_, ModelState>) -> Result<String, String> {
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
    let (image, source_type, page_index, page_count) =
        load_document_as_image(&file_path, page_index)?;
    let preview_data_url = image_to_data_url(&image)?;
    let cache_key = make_cache_key(&file_path, page_index, threshold);

    let cached_entry = {
        let cache = state.inference_cache.lock().unwrap();
        cache.get(&cache_key).cloned()
    };

    let (boxes, width, height, response_source_type, response_page_count) =
        if let Some(entry) = cached_entry {
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
            )
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

#[derive(Serialize, Clone)]
struct DownloadProgress {
    progress: f64,
    message: String,
    status: String, // "downloading" | "completed" | "error" | "checking"
}

#[tauri::command]
async fn download_ocr_model(
    app: tauri::AppHandle,
    repo_url: String,
    target_dir: String,
) -> Result<String, String> {
    let target_path = Path::new(&target_dir);
    let dir_name = target_path
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("GLM-OCR-GGUF"))
        .to_string_lossy()
        .to_string();

    // Check if target already exists
    if target_path.exists() {
        return Err(format!("目录已存在: {}", target_dir));
    }

    let emit_progress = |app: &tauri::AppHandle, progress: f64, message: &str, status: &str| {
        let _ = app.emit(
            "ocr-download-progress",
            DownloadProgress {
                progress,
                message: message.to_string(),
                status: status.to_string(),
            },
        );
    };

    // Step 1: Check git availability
    emit_progress(&app, 0.0, "正在检查 git ...", "checking");

    let git_check = Command::new("git")
        .args(["--version"])
        .output()
        .map_err(|e| format!("git 未安装或不在 PATH 中: {e}"))?;

    if !git_check.status.success() {
        return Err("git 命令不可用".to_string());
    }

    // Step 2: Check git-lfs availability
    emit_progress(&app, 0.0, "正在检查 git-lfs ...", "checking");

    let lfs_check = Command::new("git")
        .args(["lfs", "version"])
        .output()
        .map_err(|_| "git-lfs 未安装。请运行: git lfs install".to_string())?;

    if !lfs_check.status.success() {
        return Err("git-lfs 不可用，请先安装 git-lfs".to_string());
    }

    emit_progress(&app, 0.0, "开始克隆仓库...", "downloading");

    // Step 3: Run git lfs clone
    let parent_dir = target_path
        .parent()
        .unwrap_or_else(|| Path::new("."));

    if parent_dir.to_str() != Some("") && parent_dir.to_str() != Some(".") {
        std::fs::create_dir_all(parent_dir).map_err(|e| format!("无法创建父目录: {e}"))?;
    }

    let mut child = Command::new("git")
        .args([
            "lfs",
            "clone",
            "--progress",
            &repo_url,
            &dir_name,
        ])
        .current_dir(parent_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 git: {e}"))?;

    let stderr = child
        .stderr
        .take()
        .ok_or("无法读取 git stderr".to_string())?;

    let reader = BufReader::new(stderr);
    for line_result in reader.lines() {
        if let Ok(line) = line_result {
            // Parse progress from git output
            // Git outputs: "Receiving objects:  45% (123/456)"
            // Git LFS outputs: "Git LFS: (1 of 3 files) 1.2 GB / 4.2 GB"
            let mut progress = -1.0;
            let message = line.clone();

            // Try to find percentage
            if let Some(pct_start) = line.find(|c: char| c.is_ascii_digit()) {
                if let Some(pct_idx) = line[pct_start..].find('%') {
                    let pct_str = &line[pct_start..pct_start + pct_idx];
                    if let Ok(pct) = pct_str.parse::<f64>() {
                        progress = pct.clamp(0.0, 100.0);
                    }
                }
            }

            // Try parse LFS fraction: "X/Y" or "X of Y"
            if progress < 0.0 {
                if let Some(frac_start) = line.find("(") {
                    if let Some(slash) = line[frac_start..].find('/') {
                        let before_slash = &line[frac_start + 1..frac_start + slash];
                        if let Some(space) = before_slash.find(" of ") {
                            let num_str = &before_slash[space + 4..];
                            if let Ok(current) = num_str.trim().parse::<f64>() {
                                if let Some(after_slash) = line[frac_start + slash + 1..].find(|c: char| !c.is_ascii_digit()) {
                                    let denom_str = &line[frac_start + slash + 1..frac_start + slash + 1 + after_slash];
                                    if let Ok(total) = denom_str.trim().parse::<f64>() {
                                        if total > 0.0 {
                                            progress = (current / total * 100.0).clamp(0.0, 99.0);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if progress >= 0.0 {
                emit_progress(&app, progress, &message, "downloading");
            } else {
                emit_progress(&app, 0.0, &message, "downloading");
            }
        }
    }

    // Also read stdout
    if let Some(stdout) = child.stdout.take() {
        let stdout_reader = BufReader::new(stdout);
        for line_result in stdout_reader.lines() {
            if let Ok(line) = line_result {
                emit_progress(&app, 0.0, &line, "downloading");
            }
        }
    }

    let status = child.wait().map_err(|e| format!("等待 git 进程失败: {e}"))?;

    if status.success() {
        emit_progress(&app, 100.0, "下载完成", "completed");
        let final_path = parent_dir.join(&dir_name);
        Ok(final_path.to_string_lossy().to_string())
    } else {
        emit_progress(
            &app,
            0.0,
            &format!("git clone 失败，退出码: {:?}", status.code()),
            "error",
        );
        Err(format!("git clone 失败，退出码: {:?}", status.code()))
    }
}

fn resolve_dll_dir() -> PathBuf {
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
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

#[tauri::command]
async fn init_ocr(
    ocr_model_path: String,
    state: State<'_, OcrState>,
) -> Result<String, String> {
    let model_root = PathBuf::from(&ocr_model_path);
    if !model_root.exists() {
        return Err(format!("OCR model directory not found: {ocr_model_path}"));
    }

    let gguf_file = model_root.join("GLM-OCR-Q8_0.gguf");
    let mmproj_file = model_root.join("mmproj-GLM-OCR-Q8_0.gguf");
    if !gguf_file.exists() {
        return Err(format!("GGUF model not found at: {}", gguf_file.display()));
    }
    if !mmproj_file.exists() {
        return Err(format!("mmproj model not found at: {}", mmproj_file.display()));
    }

    let dll_dir = resolve_dll_dir();
    let cpp_lib = gguf_ocr::CppLib::load(
        &dll_dir.join("llama.dll"),
        &dll_dir.join("mtmd.dll"),
    )
    .map_err(|e| format!("Failed to load llama.cpp DLLs: {e}"))?;

    // Unload previous backend if any
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

#[derive(Serialize)]
pub struct OcrRegionResult {
    pub text: String,
}

#[tauri::command]
async fn run_ocr_region(
    file_path: String,
    page_index: u32,
    xmin: f32,
    ymin: f32,
    xmax: f32,
    ymax: f32,
    state: State<'_, OcrState>,
) -> Result<OcrRegionResult, String> {
    let model_root = {
        let guard = state.model_root.lock().unwrap();
        guard.clone().ok_or("OCR model not initialized")?
    };

    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }

    // Render the page
    let (image, actual_page_index, _page_count) = render_pdf_page(path, page_index)?;

    let img_w = image.width() as f32;
    let img_h = image.height() as f32;

    // Clamp coordinates to image bounds
    let cx = (xmin.clamp(0.0, img_w) as u32, ymin.clamp(0.0, img_h) as u32);
    let crop_w = ((xmax - xmin).clamp(1.0, img_w - cx.0 as f32) as u32).max(1);
    let crop_h = ((ymax - ymin).clamp(1.0, img_h - cx.1 as f32) as u32).max(1);

    eprintln!(
        "[OCR] cropping region: orig={}x{} crop=({},{} {}x{})",
        img_w, img_h, cx.0, cx.1, crop_w, crop_h
    );

    let cropped = image.crop_imm(cx.0, cx.1, crop_w, crop_h);

    // Save to temp file
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

    // Run OCR on the cropped region
    let text = {
        let mut backend_guard = state.backend.lock().unwrap();
        let backend = backend_guard
            .as_mut()
            .ok_or("OCR backend not initialized")?;

        let result = backend
            .infer(&model_root, &temp_path)
            .map_err(|e| format!("OCR inference failed: {e}"))?;

        result.text
    };

    // Clean up temp file
    let _ = std::fs::remove_file(&temp_path);

    Ok(OcrRegionResult { text })
}

#[cfg(target_os = "windows")]
extern "system" {
    fn SetDllDirectoryW(lpPathName: *const u16) -> i32;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let dll_dir = resolve_dll_dir();
    eprintln!("[xDoc] lib dir resolved to: {}", dll_dir.display());

    // Add the DLL directory to Windows DLL search path so that
    // llama.dll can find its dependencies (ggml.dll etc.) in the same folder.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = dll_dir
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe { SetDllDirectoryW(wide.as_ptr()); }
    }

    tauri::Builder::default()
        .manage(ModelState {
            session: Arc::new(Mutex::new(None)),
            inference_cache: Arc::new(Mutex::new(HashMap::new())),
            prefetch_tasks: Arc::new(Mutex::new(HashSet::new())),
        })
        .manage(OcrState {
            backend: Arc::new(Mutex::new(None)),
            model_root: Arc::new(Mutex::new(None)),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_model,
            run_doclayout,
            get_pdf_text,
            get_pdf_paragraphs,
            download_ocr_model,
            init_ocr,
            run_ocr_region
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
