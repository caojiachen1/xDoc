//! PDF processing commands and shared helpers.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex},
    thread,
};

use base64::Engine;
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{
    bind_pdfium_with_candidates, image_to_data_url, load_document_as_image,
    make_cache_key, make_prefetch_task_key, render_pdf_page, CachedInference,
    ExtractContentResponse, LayoutBox, ModelState, TextSegment,
};
use super::model::infer_layout_boxes;

// ── PDF types ──────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct PagePreviewResponse {
    pub preview_data_url: String,
    pub width: u32,
    pub height: u32,
    pub page_index: u32,
    pub page_count: u32,
    pub source_type: String,
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

// ── Annotation export types ────────────────────────────────────────────────

#[derive(Deserialize, Debug, Clone)]
pub struct ExportShape {
    #[serde(rename = "type")]
    pub shape_type: String,
    pub points: Vec<ExportPoint>,
    pub color: String,
    pub size: f32,
    pub text: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ExportPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct PageAnnotations {
    pub page_index: i32,
    pub shapes: Vec<ExportShape>,
}

fn parse_hex_color(hex: &str) -> (u8, u8, u8) {
    let h = hex.trim_start_matches('#');
    let r = u8::from_str_radix(h.get(0..2).unwrap_or("00"), 16).unwrap_or(0);
    let g = u8::from_str_radix(h.get(2..4).unwrap_or("00"), 16).unwrap_or(0);
    let b = u8::from_str_radix(h.get(4..6).unwrap_or("00"), 16).unwrap_or(0);
    (r, g, b)
}

// ── Text extraction & merging helpers ──────────────────────────────────────

fn extract_font_segments_from_page(
    page: &PdfPage<'_>,
) -> Result<(Vec<FontTextSegment>, f32, f32), String> {
    let scale = 1600.0 / page.width().value;
    let page_height = page.height().value;
    let mut segments: Vec<FontTextSegment> = Vec::new();

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

    let heights: Vec<f32> = raw_segments
        .iter()
        .map(|s| s.ymax - s.ymin)
        .filter(|h| *h > 0.0)
        .collect();
    let avg_height = if heights.is_empty() {
        12.0
    } else {
        let mut h_sorted = heights;
        h_sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        h_sorted[h_sorted.len() / 2]
    };

    let line_tolerance = (avg_height * 0.8).max(5.0);

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

                let x_dist = if seg.xmin > line_xmax {
                    seg.xmin - line_xmax
                } else if line_xmin > seg.xmax {
                    line_xmin - seg.xmax
                } else {
                    0.0
                };

                (seg_cy - line_cy).abs() < line_tolerance && x_dist < avg_height * 4.0
            })
            .map(|(i, _)| i);

        if let Some(idx) = match_idx {
            lines[idx].push(seg);
        } else {
            lines.push(vec![seg]);
        }
    }

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

    line_segments.sort_by(|a, b| {
        let ya = ((a.ymin + a.ymax) / 2.0 / line_tolerance).round() as i32;
        let yb = ((b.ymin + b.ymax) / 2.0 / line_tolerance).round() as i32;
        ya.cmp(&yb).then_with(|| {
            a.xmin
                .partial_cmp(&b.xmin)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });

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

    let gap_break_threshold = median_gap * 2.0;

    let mut paragraphs: Vec<TextSegment> = Vec::new();
    let mut current_group: Vec<TextSegment> = Vec::new();

    for (_seg_idx, seg) in line_segments.into_iter().enumerate() {
        if current_group.is_empty() {
            current_group.push(seg);
            continue;
        }

        let prev = current_group.last().unwrap();
        let gap = seg.ymin - prev.ymax;

        let group_max_width = current_group
            .iter()
            .map(|s| s.xmax - s.xmin)
            .fold(0.0f32, f32::max);

        let prev_width = prev.xmax - prev.xmin;
        let this_xmin = seg.xmin;
        let prev_xmin = prev.xmin;

        let same_visual_line = gap <= line_tolerance;
        let gap_break = gap > gap_break_threshold;
        let short_last_line = group_max_width > 0.0 && prev_width < group_max_width * 0.55;
        let indented_start = this_xmin > prev_xmin + avg_height * 0.8;
        let column_break = (this_xmin - prev_xmin).abs() > avg_height * 4.0;

        let is_paragraph_break = !same_visual_line
            && (gap_break || short_last_line || indented_start || column_break);

        if !is_paragraph_break {
            current_group.push(seg);
        } else {
            let merged = merge_group(&current_group);
            paragraphs.push(merged);
            current_group = vec![seg];
        }
    }

    if !current_group.is_empty() {
        let merged = merge_group(&current_group);
        paragraphs.push(merged);
    }

    paragraphs
}

fn merge_group(group: &[TextSegment]) -> TextSegment {
    let mut text = String::new();
    for (i, s) in group.iter().enumerate() {
        let mut appended = false;
        if i > 0 {
            let trimmed = text.trim_end();
            if trimmed.ends_with('\x02') {
                let stripped = &trimmed[..trimmed.len() - 1];
                text = stripped.to_string();
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
    let mut text_boxes: Vec<&LayoutBox> = layout_boxes.iter().collect();
    text_boxes.sort_by_key(|b| b.read_order);

    if text_boxes.is_empty() {
        return merge_segments_into_paragraphs(raw_segments);
    }

    let mut result: Vec<TextSegment> = Vec::new();
    let mut assigned: HashSet<usize> = HashSet::new();

    for (_tb_idx, tb) in text_boxes.iter().enumerate() {
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

        let merged_paragraphs = merge_segments_into_paragraphs(region_segs);

        let text: String = merged_paragraphs
            .into_iter()
            .map(|p| p.text)
            .collect::<Vec<_>>()
            .join("\n");

        result.push(TextSegment {
            text,
            xmin: tb.xmin,
            ymin: tb.ymin,
            xmax: tb.xmax,
            ymax: tb.ymax,
        });
    }

    let unassigned: Vec<TextSegment> = raw_segments
        .iter()
        .enumerate()
        .filter(|(i, _)| !assigned.contains(i))
        .map(|(_, s)| s.clone())
        .collect();

    if !unassigned.is_empty() {
        let paragraphs = merge_segments_into_paragraphs(unassigned);
        result.extend(paragraphs);
    }

    result
}

// ── Prefetch ───────────────────────────────────────────────────────────────

pub(crate) fn spawn_prefetch_for_pdf(
    file_path: String,
    page_count: u32,
    requested_page: u32,
    threshold: f32,
    session: Arc<Mutex<Option<ort::session::Session>>>,
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
                    response_cache
                        .lock()
                        .unwrap()
                        .insert(cache_key, full_response);
                }
            }
        }

        let mut tasks = prefetch_tasks.lock().unwrap();
        tasks.remove(&task_key);
    });
}

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn get_pdf_paragraphs(
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

    let cache_key = make_cache_key(&file_path, actual_page_index, threshold);
    let cached_boxes = {
        let cache = state.inference_cache.lock().unwrap();
        cache.get(&cache_key).map(|e| e.boxes.clone())
    };

    let layout_boxes = if let Some(boxes) = cached_boxes {
        Some(boxes)
    } else {
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

    state
        .response_cache
        .lock()
        .unwrap()
        .insert(cache_key, response.clone());

    Ok(response)
}

#[tauri::command]
pub(crate) async fn get_pdf_text(
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

#[tauri::command]
pub(crate) async fn render_page_preview(
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
pub(crate) async fn prefetch_document(
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

#[tauri::command]
pub(crate) async fn render_pdf_thumbnails(
    file_path: String,
) -> Result<PdfThumbnailsResponse, String> {
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

    Ok(PdfThumbnailsResponse {
        thumbnails,
        page_count,
    })
}

#[tauri::command]
pub(crate) async fn extract_pdf_outline(
    file_path: String,
) -> Result<PdfOutlineResponse, String> {
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

        items.push(PdfOutlineItem {
            title,
            page_index,
            depth,
        });

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

#[tauri::command]
pub(crate) async fn extract_first_page_metadata(
    file_path: String,
    score_threshold: Option<f32>,
    state: State<'_, ModelState>,
) -> Result<FirstPageMetadata, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }

    let threshold = score_threshold.unwrap_or(0.5).clamp(0.0, 1.0);

    let session_arc = state.session.clone();
    let inference_cache_arc = state.inference_cache.clone();
    let fp = file_path.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<FirstPageMetadata, String> {
        let t0 = std::time::Instant::now();
        let log = |step: &str| {
            eprintln!("[xDoc:meta] {} (+{}ms)", step, t0.elapsed().as_millis());
        };

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

            log("extracting font segments...");
            let (segments, pw, ph) = extract_font_segments_from_page(&page)?;
            log(&format!("font segments done: {} segments", segments.len()));

            let full_text = page.text().map(|t| t.all()).unwrap_or_default();

            (segments, pw, ph, full_text)
        };

        let doi = {
            let re = regex::Regex::new(r#"10\.\d{4,9}/[^\s,;"'<>\}\]]+"#).ok();
            re.and_then(|r| {
                r.find(&full_text).map(|m| {
                    let mut d = m.as_str().to_string();
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

        log("rendering page for layout detection...");
        let (title_by_layout, abstract_by_layout) = {
            let render_result = render_pdf_page(Path::new(&fp), 0);
            if let Ok((image, _, _)) = render_result {
                log(&format!(
                    "page rendered: {}x{}",
                    image.width(),
                    image.height()
                ));
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
                                if cx >= lb.xmin
                                    && cx <= lb.xmax
                                    && cy >= lb.ymin
                                    && cy <= lb.ymax
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
pub(crate) async fn read_file_base64(file_path: String) -> Result<String, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }
    let bytes =
        std::fs::read(&file_path).map_err(|e| format!("Failed to read file: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub(crate) async fn export_annotated_pdf(
    source_path: String,
    output_path: String,
    annotations: Vec<PageAnnotations>,
) -> Result<String, String> {
    let src = Path::new(&source_path);
    if !src.exists() {
        return Err("Source PDF not found".to_string());
    }

    let sp = source_path.clone();
    let op = output_path.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let bindings = bind_pdfium_with_candidates()?;
        let pdfium = Pdfium::new(bindings);

        std::fs::copy(&sp, &op).map_err(|e| format!("Failed to copy PDF: {e}"))?;

        let mut document = pdfium
            .load_pdf_from_file(Path::new(&op), None)
            .map_err(|e| format!("Failed to open PDF copy: {e}"))?;

        let page_count = document.pages().len();

        let mut page_map: HashMap<i32, &Vec<ExportShape>> = HashMap::new();
        for pa in &annotations {
            if !pa.shapes.is_empty() {
                page_map.insert(pa.page_index, &pa.shapes);
            }
        }

        let helvetica = document.fonts_mut().helvetica();

        for pi in 0..page_count {
            let mut page = document
                .pages()
                .get(pi as u16)
                .map_err(|e| format!("Failed to get page {pi}: {e}"))?;

            let page_w = page.width().value;
            let page_h = page.height().value;

            if let Some(shapes) = page_map.get(&(pi as i32)) {
                for shape in shapes.iter() {
                    let (r, g, b) = parse_hex_color(&shape.color);
                    let stroke_w = PdfPoints::new(shape.size * 0.5);

                    match shape.shape_type.as_str() {
                        "freehand" | "eraser" => {
                            if shape.points.len() < 2 {
                                continue;
                            }
                            let color = if shape.shape_type == "eraser" {
                                PdfColor::new(255, 255, 255, 255)
                            } else {
                                PdfColor::new(r, g, b, 255)
                            };

                            for i in 1..shape.points.len() {
                                let pa = &shape.points[i - 1];
                                let pb = &shape.points[i];
                                let x1 = PdfPoints::new((pa.x as f32) * page_w);
                                let y1 = PdfPoints::new((1.0 - pa.y as f32) * page_h);
                                let x2 = PdfPoints::new((pb.x as f32) * page_w);
                                let y2 = PdfPoints::new((1.0 - pb.y as f32) * page_h);
                                let _ = page.objects_mut().create_path_object_line(
                                    x1, y1, x2, y2, color, stroke_w,
                                );
                            }
                        }
                        "rect" => {
                            if shape.points.len() < 2 {
                                continue;
                            }
                            let p0 = &shape.points[0];
                            let p1 = &shape.points[1];
                            let left = (p0.x.min(p1.x) as f32) * page_w;
                            let right = (p0.x.max(p1.x) as f32) * page_w;
                            let top_pdf = (1.0 - p0.y.min(p1.y) as f32) * page_h;
                            let bottom_pdf = (1.0 - p0.y.max(p1.y) as f32) * page_h;

                            let rect = PdfRect::new(
                                PdfPoints::new(bottom_pdf),
                                PdfPoints::new(left),
                                PdfPoints::new(top_pdf),
                                PdfPoints::new(right),
                            );
                            let color = PdfColor::new(r, g, b, 255);
                            let _ = page.objects_mut().create_path_object_rect(
                                rect,
                                Some(color),
                                Some(stroke_w),
                                None,
                            );
                        }
                        "ellipse" => {
                            if shape.points.len() < 2 {
                                continue;
                            }
                            let p0 = &shape.points[0];
                            let p1 = &shape.points[1];
                            let cx = ((p0.x + p1.x) / 2.0) as f32 * page_w;
                            let cy_pdf = (1.0 - (p0.y + p1.y) / 2.0) as f32 * page_h;
                            let rx = ((p1.x - p0.x).abs() / 2.0) as f32 * page_w;
                            let ry = ((p1.y - p0.y).abs() / 2.0) as f32 * page_h;
                            if rx < 0.5 || ry < 0.5 {
                                continue;
                            }
                            let color = PdfColor::new(r, g, b, 255);
                            let _ = page.objects_mut().create_path_object_ellipse_at(
                                PdfPoints::new(cx),
                                PdfPoints::new(cy_pdf),
                                PdfPoints::new(rx),
                                PdfPoints::new(ry),
                                Some(color),
                                Some(stroke_w),
                                None,
                            );
                        }
                        "line" => {
                            if shape.points.len() < 2 {
                                continue;
                            }
                            let color = PdfColor::new(r, g, b, 255);
                            let pa = &shape.points[0];
                            let pb = &shape.points[1];
                            let x1 = PdfPoints::new((pa.x as f32) * page_w);
                            let y1 = PdfPoints::new((1.0 - pa.y as f32) * page_h);
                            let x2 = PdfPoints::new((pb.x as f32) * page_w);
                            let y2 = PdfPoints::new((1.0 - pb.y as f32) * page_h);
                            let _ = page.objects_mut().create_path_object_line(
                                x1, y1, x2, y2, color, stroke_w,
                            );
                        }
                        "text" => {
                            if let Some(ref txt) = shape.text {
                                if txt.is_empty() {
                                    continue;
                                }
                                let p0 = &shape.points[0];
                                let x = PdfPoints::new((p0.x as f32) * page_w);
                                let y = PdfPoints::new((1.0 - p0.y as f32) * page_h);
                                let font_size = PdfPoints::new(shape.size * 4.0);

                                let _ = page.objects_mut().create_text_object(
                                    x, y, txt, helvetica, font_size,
                                );
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        document
            .save_to_file(&op)
            .map_err(|e| format!("Failed to save annotated PDF: {e}"))?;

        Ok(op)
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?
}

// ── Plugin helpers (used by plugin_host) ───────────────────────────────────

/// Extract embedded images from PDF using pdfium-render.
pub fn extract_pdf_images(
    file_path: &str,
    page_indices: Option<&[u32]>,
) -> Result<Vec<crate::plugin_host::PdfImageInfo>, String> {
    use base64::Engine;

    let path = Path::new(file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }

    let bindings = bind_pdfium_with_candidates()?;
    let pdfium = Pdfium::new(bindings);
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("Failed to open PDF: {e}"))?;

    let page_count = document.pages().len();
    let mut images = Vec::new();

    let target_pages: Vec<u32> = match page_indices {
        Some(indices) => indices.to_vec(),
        None => (0..page_count as u32).collect(),
    };

    let debug_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.join("debug_pdf_images")))
        .unwrap_or_else(|| Path::new("debug_pdf_images").to_path_buf());
    let _ = std::fs::create_dir_all(&debug_dir);
    let _pdf_stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");

    for &page_idx in &target_pages {
        let page = match document.pages().get(page_idx as u16) {
            Ok(p) => p,
            Err(_) => continue,
        };

        for (_img_idx, obj) in page.objects().iter().enumerate() {
            if let Some(img_obj) = obj.as_image_object() {
                let (disp_w, disp_h) = if let Ok(bounds) = obj.bounds() {
                    (
                        (bounds.right().value - bounds.left().value) as u32,
                        (bounds.bottom().value - bounds.top().value) as u32,
                    )
                } else {
                    (0, 0)
                };

                match img_obj.get_processed_image(&document) {
                    Ok(processed) => {
                        let img_w = processed.width();
                        let img_h = processed.height();
                        let mut png_bytes = Vec::new();
                        let mut cursor = std::io::Cursor::new(&mut png_bytes);
                        if processed
                            .write_to(&mut cursor, image::ImageFormat::Png)
                            .is_ok()
                        {
                            let b64 =
                                base64::engine::general_purpose::STANDARD.encode(&png_bytes);
                            images.push(crate::plugin_host::PdfImageInfo {
                                page_index: page_idx,
                                image_base64: b64,
                                width: if disp_w > 0 { disp_w } else { img_w },
                                height: if disp_h > 0 { disp_h } else { img_h },
                            });
                            continue;
                        }
                    }
                    Err(_) => {}
                }

                if let Ok(raw_data) = img_obj.get_raw_image_data() {
                    if raw_data.is_empty() {
                        continue;
                    }

                    let img_w = img_obj.width().unwrap_or(0).max(0) as u32;
                    let img_h = img_obj.height().unwrap_or(0).max(0) as u32;

                    let (final_bytes, _format) =
                        match ensure_encoded_image(&raw_data, img_w, img_h) {
                            Some(result) => result,
                            None => continue,
                        };
                    let b64 =
                        base64::engine::general_purpose::STANDARD.encode(&final_bytes);
                    images.push(crate::plugin_host::PdfImageInfo {
                        page_index: page_idx,
                        image_base64: b64,
                        width: if disp_w > 0 { disp_w } else { img_w },
                        height: if disp_h > 0 { disp_h } else { img_h },
                    });
                }
            }
        }
    }

    Ok(images)
}

/// Ensure image data is in a valid encoded format (PNG/JPEG).
fn ensure_encoded_image(raw_data: &[u8], width: u32, height: u32) -> Option<(Vec<u8>, String)> {
    if raw_data.len() >= 8 && &raw_data[0..4] == &[0x89, 0x50, 0x4E, 0x47] {
        return Some((raw_data.to_vec(), "PNG".to_string()));
    }
    if raw_data.len() >= 2 && &raw_data[0..2] == &[0xFF, 0xD8] {
        return Some((raw_data.to_vec(), "JPEG".to_string()));
    }
    if raw_data.len() >= 4 && &raw_data[0..4] == b"GIF8" {
        return Some((raw_data.to_vec(), "GIF".to_string()));
    }

    if width > 0 && height > 0 {
        let expected_len = (width * height * 4) as usize;
        if raw_data.len() >= expected_len {
            if let Some(img_buf) =
                image::RgbaImage::from_raw(width, height, raw_data[..expected_len].to_vec())
            {
                let dyn_img = image::DynamicImage::ImageRgba8(img_buf);
                let mut png_bytes = Vec::new();
                let mut cursor = std::io::Cursor::new(&mut png_bytes);
                if dyn_img
                    .write_to(&mut cursor, image::ImageFormat::Png)
                    .is_ok()
                {
                    return Some((png_bytes, "PNG".to_string()));
                }
            }
        }
        let expected_rgb = (width * height * 3) as usize;
        if raw_data.len() >= expected_rgb {
            if let Some(img_buf) =
                image::RgbImage::from_raw(width, height, raw_data[..expected_rgb].to_vec())
            {
                let dyn_img = image::DynamicImage::ImageRgb8(img_buf);
                let mut png_bytes = Vec::new();
                let mut cursor = std::io::Cursor::new(&mut png_bytes);
                if dyn_img
                    .write_to(&mut cursor, image::ImageFormat::Png)
                    .is_ok()
                {
                    return Some((png_bytes, "PNG".to_string()));
                }
            }
        }
    }

    None
}

/// Layer 3 (fallback): extract images via lopdf directly from PDF dictionaries.
pub fn extract_pdf_images_with_lopdf(
    file_path: &str,
    page_indices: Option<&[u32]>,
) -> Result<Vec<crate::plugin_host::PdfImageInfo>, String> {
    use base64::Engine;

    let doc =
        lopdf::Document::load(file_path).map_err(|e| format!("lopdf load failed: {e}"))?;
    let pages = doc.get_pages();

    let target_pages: Vec<u32> = match page_indices {
        Some(indices) => indices.iter().map(|i| i + 1).collect(),
        None => pages.keys().copied().collect(),
    };

    let mut images = Vec::new();

    for &page_num in &target_pages {
        let page_id = match pages.get(&page_num) {
            Some(id) => *id,
            None => continue,
        };

        let page_images = match doc.get_page_images(page_id) {
            Ok(imgs) => imgs,
            Err(_) => continue,
        };

        for (_img_idx, pdf_img) in page_images.iter().enumerate() {
            let w = pdf_img.width.max(0) as u32;
            let h = pdf_img.height.max(0) as u32;
            if w == 0 || h == 0 {
                continue;
            }

            let cs = pdf_img.color_space.as_deref().unwrap_or("DeviceRGB");

            let has_jpeg = pdf_img
                .filters
                .as_ref()
                .map_or(false, |f| f.iter().any(|ft| ft == "DCTDecode"));
            let has_flate = pdf_img
                .filters
                .as_ref()
                .map_or(false, |f| f.iter().any(|ft| ft == "FlateDecode"));
            let no_compression = pdf_img.filters.is_none()
                || pdf_img
                    .filters
                    .as_ref()
                    .map_or(true, |f| f.is_empty());

            let pixel_data: Vec<u8> = if has_jpeg {
                pdf_img.content.to_vec()
            } else if has_flate || no_compression {
                if let Ok(obj) = doc.get_object(pdf_img.id) {
                    if let Ok(stream) = obj.as_stream() {
                        stream
                            .decompressed_content()
                            .unwrap_or_else(|_| pdf_img.content.to_vec())
                    } else {
                        pdf_img.content.to_vec()
                    }
                } else {
                    pdf_img.content.to_vec()
                }
            } else {
                continue;
            };

            let png_result: Option<Vec<u8>> = match cs {
                "DeviceRGB" => {
                    let expected = (w * h * 3) as usize;
                    if pixel_data.len() >= expected {
                        image::RgbImage::from_raw(w, h, pixel_data[..expected].to_vec()).map(
                            |img| {
                                let mut png = Vec::new();
                                let mut cursor = std::io::Cursor::new(&mut png);
                                let _ = image::DynamicImage::ImageRgb8(img)
                                    .write_to(&mut cursor, image::ImageFormat::Png);
                                png
                            },
                        )
                    } else {
                        None
                    }
                }
                "DeviceGray" => {
                    let expected = (w * h) as usize;
                    if pixel_data.len() >= expected {
                        image::GrayImage::from_raw(w, h, pixel_data[..expected].to_vec()).map(
                            |img| {
                                let rgb = image::DynamicImage::ImageLuma8(img).to_rgb8();
                                let mut png = Vec::new();
                                let mut cursor = std::io::Cursor::new(&mut png);
                                let _ = rgb.write_to(&mut cursor, image::ImageFormat::Png);
                                png
                            },
                        )
                    } else {
                        None
                    }
                }
                "DeviceCMYK" => {
                    let expected = (w * h * 4) as usize;
                    if pixel_data.len() >= expected {
                        let mut rgb_pixels =
                            Vec::with_capacity((w * h * 3) as usize);
                        for i in (0..expected).step_by(4) {
                            let c = pixel_data[i] as f32 / 255.0;
                            let m = pixel_data[i + 1] as f32 / 255.0;
                            let y = pixel_data[i + 2] as f32 / 255.0;
                            let k = pixel_data[i + 3] as f32 / 255.0;
                            let r = (255.0 * (1.0 - c) * (1.0 - k)) as u8;
                            let g = (255.0 * (1.0 - m) * (1.0 - k)) as u8;
                            let b = (255.0 * (1.0 - y) * (1.0 - k)) as u8;
                            rgb_pixels.extend_from_slice(&[r, g, b]);
                        }
                        image::RgbImage::from_raw(w, h, rgb_pixels).map(|img| {
                            let mut png = Vec::new();
                            let mut cursor = std::io::Cursor::new(&mut png);
                            let _ = image::DynamicImage::ImageRgb8(img)
                                .write_to(&mut cursor, image::ImageFormat::Png);
                            png
                        })
                    } else {
                        None
                    }
                }
                _ => None,
            };

            if let Some(png_bytes) = png_result {
                if !png_bytes.is_empty() {
                    let b64 =
                        base64::engine::general_purpose::STANDARD.encode(&png_bytes);
                    images.push(crate::plugin_host::PdfImageInfo {
                        page_index: page_num - 1,
                        image_base64: b64,
                        width: w,
                        height: h,
                    });
                }
            }
        }
    }

    Ok(images)
}
