use async_trait::async_trait;
use base64::Engine;
use image::{imageops::FilterType, DynamicImage, ImageFormat};
use models_cat::asynchronous::{ModelsCat, Progress, ProgressUnit};
use models_cat::{OpsError, Repo};
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
use tauri::{AppHandle, Emitter, State};

#[allow(dead_code)]
mod gguf_ocr;
mod settings_db;
use settings_db::{AiConfig, PaperRecord, SettingEntry, SettingsDb, get_papers_dir};

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
    pub preview_data_url: Option<String>,
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
pub struct FontTextSegment {
    pub text: String,
    pub xmin: f32,
    pub ymin: f32,
    pub xmax: f32,
    pub ymax: f32,
    pub font_name: String,
    pub font_size: f32,
    pub is_bold: bool,
    pub is_italic: bool,
}

#[derive(Serialize)]
pub struct FirstPageMetadata {
    pub title_by_layout: Option<String>,
    pub abstract_by_layout: Option<String>,
    pub title_by_font: Option<String>,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    pub all_segments: Vec<FontTextSegment>,
    pub page_width: f32,
    pub page_height: f32,
}

#[derive(Serialize, Clone)]
pub struct PdfOutlineItem {
    pub title: String,
    pub page_index: u32,
    pub depth: u32,
}

#[derive(Serialize)]
pub struct PdfOutlineResponse {
    pub items: Vec<PdfOutlineItem>,
    pub page_count: u32,
}

#[derive(Serialize)]
pub struct PdfThumbnailsResponse {
    pub thumbnails: Vec<String>,
    pub page_count: u32,
}

fn extract_font_segments_from_page(
    page: &PdfPage<'_>,
) -> Result<(Vec<FontTextSegment>, f32, f32), String> {
    let scale = 1600.0 / page.width().value;
    let page_height = page.height().value;
    let mut segments: Vec<FontTextSegment> = Vec::new();

    // Extract page text ONCE before the loop (avoids O(n²) re-parsing)
    let page_text = page.text().ok();

    for obj in page.objects().iter() {
        if let Some(text_obj) = obj.as_text_object() {
            let text = text_obj.text();
            if text.trim().is_empty() {
                continue;
            }
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

                // Get font info from the first character of this text object
                let (font_name, font_size, is_bold, is_italic) =
                    if let Some(ref pt) = page_text {
                        if let Ok(chars) = pt.chars_for_object(text_obj) {
                            if let Some(ch) = chars.iter().next() {
                                let weight_bold = matches!(
                                    ch.font_weight(),
                                    Some(PdfFontWeight::Weight700Bold)
                                        | Some(PdfFontWeight::Weight800)
                                        | Some(PdfFontWeight::Weight900)
                                );
                                (
                                    ch.font_name(),
                                    ch.scaled_font_size().value,
                                    ch.font_is_bold_reenforced() || weight_bold,
                                    ch.font_is_italic(),
                                )
                            } else {
                                ("unknown".to_string(), 0.0, false, false)
                            }
                        } else {
                            ("unknown".to_string(), 0.0, false, false)
                        }
                    } else {
                        ("unknown".to_string(), 0.0, false, false)
                    };

                segments.push(FontTextSegment {
                    text,
                    xmin,
                    ymin,
                    xmax,
                    ymax,
                    font_name,
                    font_size,
                    is_bold,
                    is_italic,
                });
            }
        }
    }

    Ok((segments, page.width().value * scale, page_height * scale))
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
    let cache_key = make_cache_key(&file_path, page_index, threshold);

    let cached_response = {
        let cache = state.response_cache.lock().unwrap();
        cache.get(&cache_key).cloned()
    };

    if let Some(response) = cached_response {
        // Trigger prefetch for other pages in background
        if response.page_count > 1 {
            spawn_prefetch_for_pdf(
                file_path.clone(),
                response.page_count,
                page_index,
                threshold,
                state.session.clone(),
                state.inference_cache.clone(),
                state.response_cache.clone(),
                state.prefetch_tasks.clone(),
            );
        }
        return Ok(response);
    }

    let (image, actual_page_index, page_count) = render_pdf_page(path, page_index)?;
    let preview_data_url = image_to_data_url(&image)?;
    let raw_segments = extract_raw_text_segments(path, actual_page_index)?;

    // Also update cache_key in case actual_page_index != page_index
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
                        preview_data_url: Some(preview_data_url.clone()),
                    };
                    state
                        .inference_cache
                        .lock()
                        .unwrap()
                        .insert(cache_key.clone(), entry);
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
            state.response_cache.clone(),
            state.prefetch_tasks.clone(),
        );
    }

    let response = ExtractContentResponse {
        width: image.width(),
        height: image.height(),
        preview_data_url,
        page_index: actual_page_index,
        page_count,
        segments,
    };

    // Cache the response
    state.response_cache.lock().unwrap().insert(cache_key, response.clone());

    Ok(response)
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

#[derive(Serialize, Clone)]
pub struct PagePreviewResponse {
    pub preview_data_url: String,
    pub width: u32,
    pub height: u32,
    pub page_index: u32,
    pub page_count: u32,
    pub source_type: String,
}

#[tauri::command]
async fn render_page_preview(
    file_path: String,
    page_index: Option<u32>,
) -> Result<PagePreviewResponse, String> {
    let (image, source_type, actual_page_index, page_count) =
        load_document_as_image(&file_path, page_index)?;
    let preview_data_url = image_to_data_url(&image)?;

    Ok(PagePreviewResponse {
        preview_data_url,
        width: image.width(),
        height: image.height(),
        page_index: actual_page_index,
        page_count,
        source_type,
    })
}

#[tauri::command]
async fn prefetch_document(
    file_path: String,
    current_page: u32,
    score_threshold: Option<f32>,
    state: State<'_, ModelState>,
) -> Result<(), String> {
    let threshold = score_threshold.unwrap_or(0.5).clamp(0.0, 1.0);

    let (_, _, _, page_count) = load_document_as_image(&file_path, Some(0))?;

    if page_count <= 1 {
        return Ok(());
    }

    spawn_prefetch_for_pdf(
        file_path,
        page_count,
        current_page,
        threshold,
        state.session.clone(),
        state.inference_cache.clone(),
        state.response_cache.clone(),
        state.prefetch_tasks.clone(),
    );

    Ok(())
}

pub struct ModelState {
    session: Arc<Mutex<Option<Session>>>,
    inference_cache: Arc<Mutex<HashMap<String, CachedInference>>>,
    response_cache: Arc<Mutex<HashMap<String, ExtractContentResponse>>>,
    prefetch_tasks: Arc<Mutex<HashSet<String>>>,
}

pub struct OcrState {
    backend: Arc<Mutex<Option<gguf_ocr::GgufBackend>>>,
    model_root: Arc<Mutex<Option<PathBuf>>>,
    ocr_cache: Arc<Mutex<HashMap<String, String>>>,
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

#[tauri::command]
async fn render_pdf_thumbnails(file_path: String) -> Result<PdfThumbnailsResponse, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }

    let bindings = bind_pdfium_with_candidates()?;
    let pdfium = Pdfium::new(bindings);
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("Failed to open PDF: {e}"))?;

    let page_count = document.pages().len() as u32;
    let mut thumbnails = Vec::with_capacity(page_count as usize);

    for i in 0..page_count {
        let page = document
            .pages()
            .get(i as u16)
            .map_err(|e| format!("Failed to get page {i}: {e}"))?;

        let rendered = page
            .render_with_config(
                &PdfRenderConfig::new()
                    .set_target_width(200)
                    .rotate_if_landscape(PdfPageRenderRotation::None, true),
            )
            .map_err(|e| format!("Failed to render page {i}: {e}"))?;

        let data_url = image_to_data_url(&rendered.as_image())?;
        thumbnails.push(data_url);
    }

    Ok(PdfThumbnailsResponse { thumbnails, page_count })
}

#[tauri::command]
async fn extract_pdf_outline(file_path: String) -> Result<PdfOutlineResponse, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }

    let bindings = bind_pdfium_with_candidates()?;
    let pdfium = Pdfium::new(bindings);
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("Failed to open PDF: {e}"))?;

    let page_count = document.pages().len() as u32;
    let mut items: Vec<PdfOutlineItem> = Vec::new();

    fn walk(bookmark: &PdfBookmark<'_>, depth: u32, items: &mut Vec<PdfOutlineItem>) {
        let title = bookmark.title().unwrap_or_default();
        let page_index = bookmark
            .destination()
            .and_then(|dest| dest.page_index().ok())
            .map(|idx| idx as u32)
            .unwrap_or(0);

        items.push(PdfOutlineItem { title, page_index, depth });

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

    Ok(PdfOutlineResponse { items, page_count })
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
    response_cache: Arc<Mutex<HashMap<String, ExtractContentResponse>>>,
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
        // Priority ordering: spiral outward from requested_page, forward-biased
        let mut page_order: Vec<u32> = (0..page_count)
            .filter(|&p| p != requested_page)
            .collect();
        page_order.sort_by_key(|&p| {
            if p >= requested_page {
                (p - requested_page) as i64 * 2
            } else {
                (requested_page - p) as i64 * 3 + 1
            }
        });

        for p in page_order {
            let cache_key = make_cache_key(&file_path, p, threshold);
            let has_cache = {
                let cache = inference_cache.lock().unwrap();
                let full_cache = response_cache.lock().unwrap();
                cache.contains_key(&cache_key) && full_cache.contains_key(&cache_key)
            };
            if has_cache {
                continue;
            }

            let Ok((image, source_type, _page_index, page_count_local)) =
                load_document_as_image(&file_path, Some(p))
            else {
                continue;
            };

            let preview_data_url = image_to_data_url(&image).ok();

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
                boxes: boxes.clone(),
                width: image.width(),
                height: image.height(),
                source_type,
                page_count: page_count_local,
                preview_data_url: preview_data_url.clone(),
            };

            {
                let mut cache = inference_cache.lock().unwrap();
                cache.insert(cache_key.clone(), entry);
            }

            // Also cache the full response
            if let Some(ref pdu) = preview_data_url {
                if let Ok(raw_segments) = extract_raw_text_segments(Path::new(&file_path), p) {
                    let segments = merge_segments_with_layout(raw_segments, &boxes);
                    let full_response = ExtractContentResponse {
                        width: image.width(),
                        height: image.height(),
                        preview_data_url: pdu.clone(),
                        page_index: p,
                        page_count: page_count_local,
                        segments,
                    };
                    response_cache.lock().unwrap().insert(cache_key, full_response);
                }
            }
        }

        let mut tasks = prefetch_tasks.lock().unwrap();
        tasks.remove(&task_key);
    });
}

#[tauri::command]
async fn load_model(model_path: String, state: State<'_, ModelState>) -> Result<String, String> {
    let resolved = resolve_model_path(&model_path);
    if !resolved.exists() {
        return Err(format!("Model file not found: {}", resolved.display()));
    }

    let resolved_str = resolved.to_string_lossy().to_string();
    let session_arc = state.session.clone();
    let inference_cache_arc = state.inference_cache.clone();
    let prefetch_arc = state.prefetch_tasks.clone();
    let response_cache_arc = state.response_cache.clone();

    // ONNX session creation is CPU-heavy; run on blocking thread
    // so we don't block the async runtime.
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let t0 = std::time::Instant::now();
        eprintln!("[xDoc:model] loading ONNX model from {}...", resolved_str);

        let session = Session::builder()
            .map_err(|e| e.to_string())?
            .commit_from_file(&resolved_str)
            .map_err(|e| e.to_string())?;

        eprintln!("[xDoc:model] ONNX session created (+{}ms)", t0.elapsed().as_millis());

        *session_arc.lock().unwrap() = Some(session);
        inference_cache_arc.lock().unwrap().clear();
        prefetch_arc.lock().unwrap().clear();
        response_cache_arc.lock().unwrap().clear();

        eprintln!("[xDoc:model] model loaded successfully (+{}ms)", t0.elapsed().as_millis());
        Ok("Model loaded successfully".to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

#[tauri::command]
async fn run_doclayout(
    file_path: String,
    score_threshold: Option<f32>,
    page_index: Option<u32>,
    state: State<'_, ModelState>,
) -> Result<DetectionResponse, String> {
    let threshold = score_threshold.unwrap_or(0.5).clamp(0.0, 1.0);

    // Check cache first — avoid rendering if we already have everything
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
        spawn_prefetch_for_pdf(
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

#[derive(Serialize, Clone)]
struct ModelDownloadProgress {
    model_type: String,   // "layout" | "ocr"
    filename: String,
    current: u64,
    total: u64,
    progress: f64,        // 0.0 - 100.0
    status: String,       // "downloading" | "file_completed" | "completed" | "error"
    message: String,
}

#[derive(Clone)]
struct TauriProgress {
    app: AppHandle,
    model_type: String,
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

#[tauri::command]
async fn download_onnx_model(
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

    // Copy from models-cat cache to target directory
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

#[tauri::command]
async fn download_ocr_models(
    app: tauri::AppHandle,
    target_dir: String,
) -> Result<String, String> {
    let target_path = resolve_model_path(&target_dir);
    std::fs::create_dir_all(&target_path).map_err(|e| format!("无法创建目录: {e}"))?;

    let repo = Repo::new_model("ggml-org/GLM-OCR-GGUF");
    let mc = ModelsCat::new(repo);

    // List all available files and exclude the large fp16 variant
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

        // Copy each file after download
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

/// Walk the models-cat cache directory and copy a file by name to the target directory.
fn copy_from_cache(
    cache_dir: &std::path::Path,
    filename: &str,
    target_dir: &std::path::Path,
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

fn resolve_dll_dir() -> PathBuf {
    // 1. Look in the exe's own directory (bundled DLLs for installed app)
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let bundled = exe_dir.join("llama.dll");
            if bundled.exists() {
                return exe_dir.to_path_buf();
            }
            // 2. Walk up from exe to find lib/ directory (dev environment)
            for ancestor in exe_dir.ancestors() {
                let candidate = ancestor.join("lib").join("llama.dll");
                if candidate.exists() {
                    return ancestor.join("lib");
                }
            }
        }
    }
    // 3. Fallback: lib/ relative to current working directory
    PathBuf::from("lib")
}

fn resolve_model_path(model_path: &str) -> PathBuf {
    let path = PathBuf::from(model_path);
    if path.is_absolute() {
        return path;
    }
    // Resolve relative paths against the exe directory so that
    // "model/PP-DocLayoutV3.onnx" points to <exe_dir>/model/...
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            return exe_dir.join(path);
        }
    }
    path
}

#[tauri::command]
async fn init_ocr(
    ocr_model_path: String,
    state: State<'_, OcrState>,
) -> Result<String, String> {
    let model_root = resolve_model_path(&ocr_model_path);
    if !model_root.exists() {
        return Err(format!("OCR model directory not found: {}", model_root.display()));
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

#[derive(Serialize, Clone)]
pub struct OcrRegionResult {
    pub text: String,
}

#[derive(Serialize, Clone)]
struct OcrStreamToken {
    piece: String,
}

#[tauri::command]
async fn run_ocr_region(
    app: AppHandle,
    file_path: String,
    page_index: u32,
    xmin: f32,
    ymin: f32,
    xmax: f32,
    ymax: f32,
    state: State<'_, OcrState>,
) -> Result<OcrRegionResult, String> {
    let cache_key = format!("{}::{}_{}_{}_{}_{}", file_path, page_index, xmin.round() as i32, ymin.round() as i32, xmax.round() as i32, ymax.round() as i32);
    if let Some(cached_text) = state.ocr_cache.lock().unwrap().get(&cache_key) {
        // Ensure frontend still receives this text (if it relies on either the return value,
        // or we can emit it as a single chunk). The frontend does setOcrText(result.text)
        // so returning it immediately will display it instantly.
        return Ok(OcrRegionResult { text: cached_text.clone() });
    }

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

    // Run OCR on the cropped region (streaming)
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

    // Clean up temp file
    let _ = std::fs::remove_file(&temp_path);

    state.ocr_cache.lock().unwrap().insert(cache_key, text.clone());

    Ok(OcrRegionResult { text })
}

#[cfg(target_os = "windows")]
extern "system" {
    fn SetDllDirectoryW(lpPathName: *const u16) -> i32;
}

#[tauri::command]
async fn check_git() -> Result<bool, String> {
    match std::process::Command::new("git").arg("--version").output() {
        Ok(output) => Ok(output.status.success()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
async fn check_model_exists(model_path: String) -> bool {
    resolve_model_path(&model_path).exists()
}

#[tauri::command]
fn save_fulltext_debug(text: String) -> Result<String, String> {
    let path = env::temp_dir().join("xdoc_fulltext_debug.txt");
    std::fs::write(&path, &text).map_err(|e| format!("Failed to write: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

// ────────────────────────────────────────────────────────────────────────
// Settings database commands (C:\xDoc\settings.db)
// ────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn db_get_all_settings(db: State<'_, SettingsDb>) -> Result<Vec<SettingEntry>, String> {
    db.get_all().map_err(|e| e.to_string())
}

#[tauri::command]
fn db_get_setting(key: String, db: State<'_, SettingsDb>) -> Result<Option<String>, String> {
    db.get(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_set_setting(key: String, value: String, db: State<'_, SettingsDb>) -> Result<(), String> {
    db.set(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_delete_setting(key: String, db: State<'_, SettingsDb>) -> Result<(), String> {
    db.delete(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_get_ai_config(db: State<'_, SettingsDb>) -> Result<AiConfig, String> {
    let vendor = db.get("llm.vendor").map_err(|e| e.to_string())?.unwrap_or_default();
    let base_url = db.get("llm.baseUrl").map_err(|e| e.to_string())?.unwrap_or_default();
    let model = db.get("llm.model").map_err(|e| e.to_string())?.unwrap_or_default();
    let vendor_api_keys = db.get_vendor_api_keys().map_err(|e| e.to_string())?;
    Ok(AiConfig {
        vendor,
        vendor_api_keys,
        base_url,
        model,
    })
}

#[tauri::command]
fn db_set_ai_config(config: AiConfig, db: State<'_, SettingsDb>) -> Result<(), String> {
    if !config.vendor.is_empty() {
        db.set("llm.vendor", &config.vendor).map_err(|e| e.to_string())?;
    } else {
        db.delete("llm.vendor").map_err(|e| e.to_string())?;
    }
    if !config.base_url.is_empty() {
        db.set("llm.baseUrl", &config.base_url).map_err(|e| e.to_string())?;
    } else {
        db.delete("llm.baseUrl").map_err(|e| e.to_string())?;
    }
    if !config.model.is_empty() {
        db.set("llm.model", &config.model).map_err(|e| e.to_string())?;
    } else {
        db.delete("llm.model").map_err(|e| e.to_string())?;
    }
    db.set_vendor_api_keys(&config.vendor_api_keys)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_get_path(db: State<'_, SettingsDb>) -> Result<String, String> {
    Ok(db.path.to_string_lossy().to_string())
}

// ── Paper management commands ───────────────────────────────────────────────

/// Copy a file to xDoc's managed papers directory, returning the managed path.
/// Uses the original filename.
#[tauri::command]
fn paper_copy_to_managed(source_path: String, _paper_id: String) -> Result<String, String> {
    let src = Path::new(&source_path);
    if !src.exists() {
        return Err(format!("Source file not found: {}", source_path));
    }

    let papers_dir = get_papers_dir();
    std::fs::create_dir_all(&papers_dir)
        .map_err(|e| format!("Failed to create papers dir: {e}"))?;

    let filename = src
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let dest = papers_dir.join(&filename);

    // Handle name conflicts: append counter if file exists with different content
    let dest = if dest.exists() && dest != src {
        let stem = src.file_stem().unwrap_or_default().to_string_lossy();
        let ext = src.extension().unwrap_or_default().to_string_lossy();
        let mut counter = 1u32;
        loop {
            let candidate = papers_dir.join(format!("{}_{}.{}", stem, counter, ext));
            if !candidate.exists() {
                break candidate;
            }
            counter += 1;
        }
    } else {
        dest
    };

    // Only copy if not already in managed dir
    if src != dest.as_path() {
        std::fs::copy(src, &dest)
            .map_err(|e| format!("Failed to copy file: {e}"))?;
    }

    Ok(dest.to_string_lossy().to_string())
}

/// Save (insert or update) a paper record to the database.
#[tauri::command]
fn paper_save(paper: PaperRecord, db: State<'_, SettingsDb>) -> Result<(), String> {
    db.upsert_paper(&paper).map_err(|e| e.to_string())
}

/// List all paper records from the database.
#[tauri::command]
fn paper_list(db: State<'_, SettingsDb>) -> Result<Vec<PaperRecord>, String> {
    db.list_papers().map_err(|e| e.to_string())
}

/// Delete a paper record and its managed file.
#[tauri::command]
fn paper_delete(id: String, db: State<'_, SettingsDb>) -> Result<(), String> {
    // Get managed path before deleting the record
    let managed_path = db
        .get_paper_managed_path(&id)
        .map_err(|e| e.to_string())?;

    // Delete the DB record
    db.delete_paper(&id).map_err(|e| e.to_string())?;

    // Delete the managed file if it exists
    if let Some(mp) = managed_path {
        let p = Path::new(&mp);
        if p.exists() {
            let _ = std::fs::remove_file(p);
        }
    }

    Ok(())
}

/// Get the papers managed directory path.
#[tauri::command]
fn paper_get_managed_dir() -> Result<String, String> {
    Ok(get_papers_dir().to_string_lossy().to_string())
}

/// Rename a managed paper file (e.g. after title is extracted from metadata).
#[tauri::command]
fn paper_rename(old_path: String, new_title: String) -> Result<String, String> {
    let old = Path::new(&old_path);
    if !old.exists() {
        return Err(format!("File not found: {}", old_path));
    }

    let parent = old.parent().unwrap_or(Path::new("."));
    let ext = old
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // Sanitize title for use as filename
    let sanitized: String = new_title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .collect();
    let sanitized = sanitized.trim().to_string();
    if sanitized.is_empty() {
        return Ok(old_path); // Title is empty, keep original name
    }

    let new_name = if ext.is_empty() {
        sanitized.clone()
    } else {
        format!("{}.{}", sanitized, ext)
    };
    let new_path = parent.join(&new_name);

    // Already has the right name
    if old == new_path {
        return Ok(new_path.to_string_lossy().to_string());
    }

    // Handle conflicts: append counter if target exists
    let final_path = if new_path.exists() && new_path != old {
        let mut counter = 1u32;
        loop {
            let candidate = if ext.is_empty() {
                parent.join(format!("{}_{}", sanitized, counter))
            } else {
                parent.join(format!("{}_{:02}.{}", sanitized, counter, ext))
            };
            if !candidate.exists() {
                break candidate;
            }
            counter += 1;
        }
    } else {
        new_path
    };

    std::fs::rename(old, &final_path)
        .map_err(|e| format!("Failed to rename: {e}"))?;

    Ok(final_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn extract_first_page_metadata(
    file_path: String,
    score_threshold: Option<f32>,
    state: State<'_, ModelState>,
) -> Result<FirstPageMetadata, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }

    let threshold = score_threshold.unwrap_or(0.5).clamp(0.0, 1.0);

    // Clone Arc references so we can move them into spawn_blocking
    let session_arc = state.session.clone();
    let inference_cache_arc = state.inference_cache.clone();
    let fp = file_path.clone();

    // Run all heavy CPU-bound work on a blocking thread to avoid
    // blocking the async runtime (which would freeze other Tauri commands).
    tauri::async_runtime::spawn_blocking(move || -> Result<FirstPageMetadata, String> {
        let t0 = std::time::Instant::now();
        let log = |step: &str| {
            eprintln!("[xDoc:meta] {} (+{}ms)", step, t0.elapsed().as_millis());
        };

        // 1. Load PDF and extract font-aware text segments from first page.
        //    All pdfium objects are scoped so they are dropped BEFORE
        //    render_pdf_page() opens the same file again (pdfium has a
        //    process-wide lock — two concurrent opens deadlock).
        log("binding pdfium...");
        let (segments, page_width, page_height, full_text) = {
            let bindings = bind_pdfium_with_candidates()?;
            let pdfium = Pdfium::new(bindings);
            log("loading PDF document...");
            let document = pdfium
                .load_pdf_from_file(Path::new(&fp), None)
                .map_err(|e| format!("Failed to open PDF: {e}"))?;

            let page = document
                .pages()
                .get(0)
                .map_err(|e| format!("Failed to get first page: {e}"))?;

            log("extracting font segments (O(n) with cached page_text)...");
            let (segments, pw, ph) = extract_font_segments_from_page(&page)?;
            log(&format!("font segments done: {} segments", segments.len()));

            // Get full text for DOI and arXiv regex matching
            let full_text = page.text().map(|t| t.all()).unwrap_or_default();

            (segments, pw, ph, full_text)
        }; // pdfium, document, page all dropped here — global lock released

        let doi = {
            let re = regex::Regex::new(r#"10\.\d{4,9}/[^\s,;"'<>\}\]]+"#).ok();
            re.and_then(|r| {
                r.find(&full_text).map(|m| {
                    let mut d = m.as_str().to_string();
                    // Strip trailing punctuation
                    while d.ends_with(|c: char| ".);]>}".contains(c)) {
                        d.pop();
                    }
                    d
                })
            })
        };

        let arxiv_id = {
            let re = regex::Regex::new(r"(?i)arXiv:(\d{4}\.\d{4,5}|[a-z-]+/\d{7})").ok();
            re.and_then(|r| r.captures(&full_text).map(|c| c[1].to_string()))
        };

        // 3. Font-based title detection: find the largest font size segments
        let title_by_font = {
            if segments.is_empty() {
                None
            } else {
                let max_size = segments
                    .iter()
                    .map(|s| s.font_size)
                    .fold(0.0f32, f32::max);
                if max_size > 0.0 {
                    let threshold_size = max_size * 0.9;
                    let title_segs: Vec<&FontTextSegment> = segments
                        .iter()
                        .filter(|s| s.font_size >= threshold_size)
                        .collect();
                    if !title_segs.is_empty() {
                        let title_text = title_segs
                            .iter()
                            .map(|s| s.text.trim())
                            .collect::<Vec<_>>()
                            .join(" ")
                            .trim()
                            .to_string();
                        if !title_text.is_empty() {
                            Some(title_text)
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
        };

        // 4. Run layout detection to find doc_title (class 6) and abstract (class 0)
        //    pdfium document was dropped in step 1, so it's safe to open the file again.
        log("pdfium document dropped, rendering page for layout detection...");
        let (title_by_layout, abstract_by_layout) = {
            let render_result = render_pdf_page(Path::new(&fp), 0);
            if let Ok((image, _, _)) = render_result {
                log(&format!("page rendered: {}x{}", image.width(), image.height()));
                let cache_key = make_cache_key(&fp, 0, threshold);
                let cached_boxes = {
                    let cache = inference_cache_arc.lock().unwrap();
                    cache.get(&cache_key).map(|e| e.boxes.clone())
                };

                let layout_boxes = if let Some(boxes) = cached_boxes {
                    log("using cached layout boxes");
                    Some(boxes)
                } else {
                    log("running ONNX inference...");
                    let mut session_guard = session_arc.lock().unwrap();
                    if let Some(ref mut session) = *session_guard {
                        match infer_layout_boxes(session, &image, threshold) {
                            Ok(boxes) => {
                                drop(session_guard);
                                log(&format!("ONNX inference done: {} boxes", boxes.len()));
                                let entry = CachedInference {
                                    boxes: boxes.clone(),
                                    width: image.width(),
                                    height: image.height(),
                                    source_type: "pdf".to_string(),
                                    page_count: 1,
                                    preview_data_url: None,
                                };
                                inference_cache_arc
                                    .lock()
                                    .unwrap()
                                    .insert(cache_key, entry);
                                Some(boxes)
                            }
                            Err(e) => {
                                drop(session_guard);
                                log(&format!("ONNX inference FAILED: {}", e));
                                None
                            }
                        }
                    } else {
                        log("no ONNX session loaded, skipping layout detection");
                        None
                    }
                };

                if let Some(ref boxes) = layout_boxes {
                    let collect_text_in_class = |cls_id: u32| -> Option<String> {
                        let class_boxes: Vec<&LayoutBox> =
                            boxes.iter().filter(|b| b.cls_id == cls_id).collect();
                        if class_boxes.is_empty() {
                            return None;
                        }
                        let mut texts: Vec<String> = Vec::new();
                        for lb in &class_boxes {
                            let mut seg_texts: Vec<String> = Vec::new();
                            for seg in &segments {
                                let cx = (seg.xmin + seg.xmax) / 2.0;
                                let cy = (seg.ymin + seg.ymax) / 2.0;
                                if cx >= lb.xmin && cx <= lb.xmax && cy >= lb.ymin && cy <= lb.ymax
                                {
                                    seg_texts.push(seg.text.trim().to_string());
                                }
                            }
                            if !seg_texts.is_empty() {
                                texts.push(seg_texts.join(" "));
                            }
                        }
                        if texts.is_empty() {
                            None
                        } else {
                            Some(texts.join(" ").trim().to_string())
                        }
                    };

                    (collect_text_in_class(6), collect_text_in_class(0))
                } else {
                    (None, None)
                }
            } else {
                log("page render failed, skipping layout detection");
                (None, None)
            }
        };

        log(&format!(
            "done (total {}ms) — title_font={:?}, title_layout={:?}, doi={:?}",
            t0.elapsed().as_millis(),
            title_by_font.as_deref(),
            title_by_layout.as_deref(),
            doi.as_deref(),
        ));

        Ok(FirstPageMetadata {
            title_by_layout,
            abstract_by_layout,
            title_by_font,
            doi,
            arxiv_id,
            all_segments: segments,
            page_width,
            page_height,
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

#[tauri::command]
async fn read_file_base64(file_path: String) -> Result<String, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }
    let bytes = std::fs::read(&file_path)
        .map_err(|e| format!("Failed to read file: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
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

    // Open (or create) the settings DB. If the C drive is somehow unavailable,
    // we fall back to the executable directory so the app still boots.
    let settings_db = match SettingsDb::open() {
        Ok(db) => {
            eprintln!("[xDoc] settings db resolved to: {}", db.path.display());
            db
        }
        Err(e) => {
            eprintln!("[xDoc] failed to open C:\\xDoc\\settings.db ({e}); falling back to exe dir");
            let fallback_dir = env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .unwrap_or_else(|| PathBuf::from("."));
            std::fs::create_dir_all(&fallback_dir).ok();
            let path = fallback_dir.join("settings.db");
            let conn = rusqlite::Connection::open(&path)
                .expect("failed to open fallback settings.db");
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous  = NORMAL;",
            )
            .ok();
            conn.execute(
                "CREATE TABLE IF NOT EXISTS settings (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                 )",
                [],
            )
            .ok();
            SettingsDb {
                conn: parking_lot::Mutex::new(conn),
                path,
            }
        }
    };

    tauri::Builder::default()
        .manage(ModelState {
            session: Arc::new(Mutex::new(None)),
            inference_cache: Arc::new(Mutex::new(HashMap::new())),
            response_cache: Arc::new(Mutex::new(HashMap::new())),
            prefetch_tasks: Arc::new(Mutex::new(HashSet::new())),
        })
        .manage(OcrState {
            backend: Arc::new(Mutex::new(None)),
            model_root: Arc::new(Mutex::new(None)),
            ocr_cache: Arc::new(Mutex::new(HashMap::new())),
        })
        .manage(settings_db)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            load_model,
            run_doclayout,
            get_pdf_text,
            get_pdf_paragraphs,
            render_page_preview,
            render_pdf_thumbnails,
            extract_pdf_outline,
            prefetch_document,
            download_onnx_model,
            download_ocr_models,
            init_ocr,
            run_ocr_region,
            check_git,
            check_model_exists,
            save_fulltext_debug,
            db_get_all_settings,
            db_get_setting,
            db_set_setting,
            db_delete_setting,
            db_get_ai_config,
            db_set_ai_config,
            db_get_path,
            read_file_base64,
            extract_first_page_metadata,
            paper_copy_to_managed,
            paper_save,
            paper_list,
            paper_delete,
            paper_get_managed_dir,
            paper_rename,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
