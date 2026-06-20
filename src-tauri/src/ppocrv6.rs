//! PPOCRv6 ONNX backend — PaddleOCR v3/v4 via ONNX Runtime.
//! Three-stage pipeline: text detection → angle classification → text recognition.

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use image::imageops::FilterType;
use image::{DynamicImage, RgbImage};
use ndarray::Array4;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;

use crate::ocr_models::Ppocrv6ModelInfo;

// ── Detection post-processing constants ──────────────────────────────────────
const DET_TARGET_SIZE: u32 = 960;
const DET_THRESHOLD: f32 = 0.3;
const DET_MIN_SIZE: u32 = 3;
const DET_BOX_THRESHOLD: f32 = 0.7;
const DET_UNCLIP_RATIO: f32 = 1.5;

// ── Classification constants ─────────────────────────────────────────────────
// PP-OCRv6 does not have a separate angle classification model.
// The classification stage is skipped.

// ── Recognition constants ────────────────────────────────────────────────────
const REC_HEIGHT: u32 = 48;

// ── Structs ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct TextBox {
    pub points: [[f32; 2]; 4],
    pub score: f32,
}

#[derive(Debug, Clone)]
pub struct OcrResult {
    pub text: String,
    pub score: f32,
    pub bbox: TextBox,
}

// ── Backend ─────────────────────────────────────────────────────────────────

unsafe impl Send for Ppocrv6Backend {}

pub struct Ppocrv6Backend {
    det_session: Option<Session>,
    rec_session: Option<Session>,
    keys: Vec<String>,
    loaded_model_root: Option<PathBuf>,
    loaded_model_id: Option<String>,
}

impl Ppocrv6Backend {
    pub fn new() -> Self {
        Self {
            det_session: None,
            rec_session: None,
            keys: Vec::new(),
            loaded_model_root: None,
            loaded_model_id: None,
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.det_session.is_some() && self.rec_session.is_some()
    }

    pub fn unload(&mut self) {
        self.det_session = None;
        self.rec_session = None;
        self.keys.clear();
        self.loaded_model_root = None;
        self.loaded_model_id = None;
    }

    pub fn ensure_loaded(&mut self, model_root: &Path, model_info: &Ppocrv6ModelInfo) -> Result<()> {
        if self.is_loaded() {
            let same_root = self.loaded_model_root.as_deref() == Some(model_root);
            let same_id = self.loaded_model_id.as_deref() == Some(model_info.id);
            if same_root && same_id {
                return Ok(());
            }
            self.unload();
        }

        let det_path = model_root.join(model_info.det_onnx);
        let rec_path = model_root.join(model_info.rec_onnx);
        let yml_path = model_root.join(model_info.rec_yml);

        if !det_path.exists() { bail!("Detection model not found: {}", det_path.display()); }
        if !rec_path.exists() { bail!("Recognition model not found: {}", rec_path.display()); }

        let total_t = Instant::now();

        // Load detection model
        self.det_session = Some(
            Session::builder()
                .map_err(|e| anyhow::anyhow!("Session builder error: {e}"))?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|e| anyhow::anyhow!("Optimization error: {e}"))?
                .with_intra_threads(4)
                .map_err(|e| anyhow::anyhow!("Thread config error: {e}"))?
                .commit_from_file(&det_path)
                .with_context(|| format!("Failed to load detection model: {}", det_path.display()))?,
        );

        // Load recognition model
        self.rec_session = Some(
            Session::builder()
                .map_err(|e| anyhow::anyhow!("Session builder error: {e}"))?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|e| anyhow::anyhow!("Optimization error: {e}"))?
                .with_intra_threads(4)
                .map_err(|e| anyhow::anyhow!("Thread config error: {e}"))?
                .commit_from_file(&rec_path)
                .with_context(|| format!("Failed to load recognition model: {}", rec_path.display()))?,
        );

        // Print ONNX model metadata for debugging
        if let Some(ref det) = self.det_session {
            let ins: Vec<&str> = det.inputs().iter().map(|i| i.name()).collect();
            let outs: Vec<&str> = det.outputs().iter().map(|o| o.name()).collect();
            eprintln!("[PPOCRv6] DET model: inputs={:?}, outputs={:?}", ins, outs);
        }
        if let Some(ref rec) = self.rec_session {
            let ins: Vec<&str> = rec.inputs().iter().map(|i| i.name()).collect();
            let outs: Vec<&str> = rec.outputs().iter().map(|o| o.name()).collect();
            eprintln!("[PPOCRv6] REC model: inputs={:?}, outputs={:?}", ins, outs);
        }

        // Load character keys from YAML config
        self.keys = load_keys_from_yml(&yml_path)?;

        self.loaded_model_root = Some(model_root.to_path_buf());
        self.loaded_model_id = Some(model_info.id.to_string());

        eprintln!(
            "[PPOCRv6] model '{}' loaded ({:.2}s), {} chars in dict",
            model_info.id,
            total_t.elapsed().as_secs_f64(),
            self.keys.len()
        );
        Ok(())
    }

    /// Run full OCR pipeline on an image: detect → classify → recognize.
    pub fn infer(
        &mut self,
        model_root: &Path,
        model_info: &Ppocrv6ModelInfo,
        image: &DynamicImage,
    ) -> Result<Vec<OcrResult>> {
        self.ensure_loaded(model_root, model_info)?;

        let total_t = Instant::now();

        // Step 1: Text detection
        let boxes = self.detect(image)?;
        if boxes.is_empty() {
            return Ok(Vec::new());
        }

        // Step 2: For each box, crop → recognize (no angle classification for PP-OCRv6)
        let mut results = Vec::new();
        for bbox in &boxes {
            let cropped = crop_rotated_box(image, bbox);

            // Text recognition
            let rec_session = self.rec_session.as_mut().unwrap();
            if let Some((text, score)) = recognize_text(rec_session, &cropped, &self.keys)? {
                results.push(OcrResult { text, score, bbox: bbox.clone() });
            }
        }

        eprintln!(
            "[PPOCRv6] inference: {:.1}s, {} boxes, {} results",
            total_t.elapsed().as_secs_f64(),
            boxes.len(),
            results.len()
        );

        Ok(results)
    }

    /// Run OCR and return concatenated text (streaming-compatible).
    pub fn infer_text(
        &mut self,
        model_root: &Path,
        model_info: &Ppocrv6ModelInfo,
        image: &DynamicImage,
        on_chunk: &mut dyn FnMut(&str),
    ) -> Result<String> {
        let results = self.infer(model_root, model_info, image)?;

        let mut full_text = String::new();
        for (i, r) in results.iter().enumerate() {
            if i > 0 {
                full_text.push('\n');
                on_chunk("\n");
            }
            full_text.push_str(&r.text);
            on_chunk(&r.text);
        }

        Ok(full_text)
    }

    // ── Detection ────────────────────────────────────────────────────────

    fn detect(&mut self, image: &DynamicImage) -> Result<Vec<TextBox>> {
        let det_session = self.det_session.as_mut().unwrap();
        let (orig_w, orig_h) = (image.width(), image.height());

        // Preprocess: resize + normalize
        let (input_tensor, ratio_h, ratio_w) = preprocess_det_image(image);

        // Run detection
        let input_names: Vec<String> = det_session.inputs().iter().map(|i| i.name().to_string()).collect();
        let input_tensor = Tensor::from_array(input_tensor)
            .map_err(|e| anyhow::anyhow!("Failed to create det tensor: {e}"))?;
        let output = det_session.run(ort::inputs![
            input_names[0].as_str() => input_tensor,
        ]).map_err(|e| anyhow::anyhow!("Detection inference failed: {e}"))?;

        let (out_shape, out_data) = output[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| anyhow::anyhow!("Failed to extract detection output: {e}"))?;

        // Output shape: [1, 1, H, W]
        let out_h = out_shape[2] as usize;
        let out_w = out_shape[3] as usize;

        // Threshold to get binary map
        let binary: Vec<Vec<bool>> = (0..out_h)
            .map(|y| (0..out_w).map(|x| out_data[y * out_w + x] > DET_THRESHOLD).collect())
            .collect();

        // Find connected components
        let mut boxes = find_boxes(&binary, out_h, out_w);

        // Scale boxes back to original image coordinates
        for b in &mut boxes {
            for p in &mut b.points {
                p[0] = (p[0] / ratio_w).min(orig_w as f32);
                p[1] = (p[1] / ratio_h).min(orig_h as f32);
            }
        }

        // Sort by reading order (top-to-bottom, left-to-right)
        boxes.sort_by(|a, b| {
            let ya = (a.points[0][1] + a.points[1][1]) / 2.0;
            let yb = (b.points[0][1] + b.points[1][1]) / 2.0;
            let avg_h = ((a.points[2][1] - a.points[0][1]).abs() + (b.points[2][1] - b.points[0][1]).abs()) / 2.0;
            if (ya - yb).abs() > avg_h * 0.5 {
                ya.partial_cmp(&yb).unwrap_or(std::cmp::Ordering::Equal)
            } else {
                let xa = (a.points[0][0] + a.points[3][0]) / 2.0;
                let xb = (b.points[0][0] + b.points[3][0]) / 2.0;
                xa.partial_cmp(&xb).unwrap_or(std::cmp::Ordering::Equal)
            }
        });

        Ok(boxes)
    }
}

// ── Image preprocessing helpers ─────────────────────────────────────────────

fn preprocess_det_image(image: &DynamicImage) -> (Array4<f32>, f32, f32) {
    let (orig_w, orig_h) = (image.width() as f32, image.height() as f32);

    // Resize keeping aspect ratio, longest side = DET_TARGET_SIZE
    let max_side = orig_w.max(orig_h);
    let scale = if max_side > DET_TARGET_SIZE as f32 {
        DET_TARGET_SIZE as f32 / max_side
    } else {
        1.0
    };
    let new_w = (orig_w * scale).round() as u32;
    let new_h = (orig_h * scale).round() as u32;

    // Pad to multiple of 32
    let pad_w = ((new_w + 31) / 32) * 32;
    let pad_h = ((new_h + 31) / 32) * 32;

    let resized = image.resize_exact(new_w, new_h, FilterType::Triangle);
    let mut canvas = DynamicImage::new_rgb8(pad_w, pad_h);
    image::imageops::overlay(&mut canvas, &resized, 0, 0);

    let rgb = canvas.to_rgb8();
    // PaddleOCR uses BGR channel order (cv2.imread default).
    // ImageNet normalization: mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]
    // Applied in BGR order: ch0=B, ch1=G, ch2=R
    let mean = [0.485f32, 0.456, 0.406];
    let std_dev = [0.229f32, 0.224, 0.225];

    let mut tensor = Array4::<f32>::zeros((1, 3, pad_h as usize, pad_w as usize));
    for (x, y, pixel) in rgb.enumerate_pixels() {
        let r = pixel[0] as f32 / 255.0;
        let g = pixel[1] as f32 / 255.0;
        let b = pixel[2] as f32 / 255.0;
        // BGR order: channel 0=B, 1=G, 2=R
        tensor[[0, 0, y as usize, x as usize]] = (b - mean[0]) / std_dev[0]; // B
        tensor[[0, 1, y as usize, x as usize]] = (g - mean[1]) / std_dev[1]; // G
        tensor[[0, 2, y as usize, x as usize]] = (r - mean[2]) / std_dev[2]; // R
    }

    let ratio_h = pad_h as f32 / orig_h;
    let ratio_w = pad_w as f32 / orig_w;
    (tensor, ratio_h, ratio_w)
}

// ── Recognition ──────────────────────────────────────────────────────────────

fn preprocess_rec_image(image: &RgbImage) -> (Array4<f32>, usize) {
    let (w, h) = (image.width(), image.height());

    // Match PaddleOCR's resize_norm_img:
    //   imgC, imgH, imgW = [3, 48, 320]
    //   max_wh_ratio = max(imgW/imgH, crop_w/crop_h)
    //   imgW = int(imgH * max_wh_ratio)
    //   resized_w = min(ceil(imgH * w/h), imgW)
    let img_h = REC_HEIGHT as usize; // 48
    let default_img_w = 320usize;
    let crop_wh_ratio = w as f32 / h as f32;
    let max_wh_ratio = (default_img_w as f32 / REC_HEIGHT as f32).max(crop_wh_ratio);
    let img_w = (img_h as f32 * max_wh_ratio) as usize;

    let resized_w = ((img_h as f32 * crop_wh_ratio).ceil() as usize).min(img_w).max(1);

    let dyn_img = DynamicImage::ImageRgb8(image.clone());
    let resized = dyn_img.resize_exact(resized_w as u32, img_h as u32, FilterType::Triangle);
    let resized_rgb = resized.to_rgb8();

    // PaddleOCR uses BGR channel order (cv2.imread default).
    // Normalization: pixel/255 then (v - 0.5) / 0.5
    // Zero-padded: padding_im[:, :, 0:resized_w] = resized_image
    let mut tensor = Array4::<f32>::zeros((1, 3, img_h, img_w));
    for (x, y, pixel) in resized_rgb.enumerate_pixels() {
        let r = pixel[0] as f32 / 255.0;
        let g = pixel[1] as f32 / 255.0;
        let b = pixel[2] as f32 / 255.0;
        // BGR order: channel 0=B, 1=G, 2=R
        tensor[[0, 0, y as usize, x as usize]] = (b - 0.5) / 0.5; // B
        tensor[[0, 1, y as usize, x as usize]] = (g - 0.5) / 0.5; // G
        tensor[[0, 2, y as usize, x as usize]] = (r - 0.5) / 0.5; // R
    }
    (tensor, img_w)
}

fn recognize_text(session: &mut Session, image: &RgbImage, keys: &[String]) -> Result<Option<(String, f32)>> {
    let (input_tensor, _input_w) = preprocess_rec_image(image);
    let input_names: Vec<String> = session.inputs().iter().map(|i| i.name().to_string()).collect();

    let input_tensor = Tensor::from_array(input_tensor)
        .map_err(|e| anyhow::anyhow!("Failed to create rec tensor: {e}"))?;
    let output = session.run(ort::inputs![
        input_names[0].as_str() => input_tensor,
    ]).map_err(|e| anyhow::anyhow!("Recognition failed: {e}"))?;

    // Log all outputs for debugging
    for i in 0..output.len() {
        if let Ok((shape, _)) = output[i].try_extract_tensor::<f32>() {
            eprintln!("[PPOCRv6] rec output[{i}] shape: {:?}", shape);
        }
    }

    // Find the best CTC output: prefer the one whose last dimension matches keys.len()
    // PP-OCRv6 multi-head may output both CTC and NRTR; CTC is typically the one
    // with shape [1, T, num_classes] where num_classes matches the character dictionary.
    let target_classes = keys.len(); // includes blank at index 0
    let mut best_idx = 0usize;
    let mut best_score = i64::MAX; // lower = better match
    for i in 0..output.len() {
        if let Ok((shape, _)) = output[i].try_extract_tensor::<f32>() {
            if shape.len() >= 3 {
                let num_classes = shape[shape.len() - 1] as i64;
                let diff = (num_classes - target_classes as i64).abs();
                if diff < best_score {
                    best_score = diff;
                    best_idx = i;
                }
            }
        }
    }

    let (shape, out_data) = output[best_idx]
        .try_extract_tensor::<f32>()
        .map_err(|e| anyhow::anyhow!("Failed to extract rec output: {e}"))?;

    if best_score > 5 {
        eprintln!(
            "[PPOCRv6] Warning: best output class dim {} doesn't match dict size {}",
            shape[shape.len() - 1],
            target_classes
        );
    }

    // Shape: [1, T, C] where T = time steps, C = num classes
    let ndim = shape.len();
    let t = shape[ndim - 2] as usize;
    let c = shape[ndim - 1] as usize;

    eprintln!("[PPOCRv6] using output[{best_idx}]: T={t}, C={c}, dict={target_classes}");
    if c != target_classes {
        eprintln!("[PPOCRv6] *** MISMATCH: model output classes C={c} != dict size {target_classes} ***");
    }

    // CTC greedy decoding
    let mut text = String::new();
    let mut total_conf = 0.0f32;
    let mut count = 0u32;
    let mut last_idx: usize = 0; // 0 = CTC blank

    for step in 0..t {
        let row_start = step * c;
        let mut max_idx = 0usize;
        let mut max_val = f32::NEG_INFINITY;
        for k in 0..c {
            if out_data[row_start + k] > max_val {
                max_val = out_data[row_start + k];
                max_idx = k;
            }
        }

        if max_idx != 0 && max_idx != last_idx {
            // keys[0] = blank (CTC), keys[1..] = actual characters
            // model output index 0 = blank, index 1 = first character
            if max_idx < keys.len() {
                let ch = &keys[max_idx];
                if !ch.is_empty() {
                    text.push_str(ch);
                    let prob = sigmoid(max_val);
                    total_conf += prob;
                    count += 1;
                }
            }
        }
        last_idx = max_idx;
    }

    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(None);
    }

    let avg_conf = if count > 0 { total_conf / count as f32 } else { 0.0 };
    Ok(Some((text, avg_conf)))
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

// ── Connected component analysis for detection postprocessing ────────────────

fn find_boxes(binary: &[Vec<bool>], h: usize, w: usize) -> Vec<TextBox> {
    let mut visited = vec![vec![false; w]; h];
    let mut boxes = Vec::new();

    for y in 0..h {
        for x in 0..w {
            if binary[y][x] && !visited[y][x] {
                // BFS flood fill
                let mut queue = std::collections::VecDeque::new();
                queue.push_back((x, y));
                visited[y][x] = true;

                let mut min_x = x;
                let mut max_x = x;
                let mut min_y = y;
                let mut max_y = y;
                let mut pixel_count = 0u32;

                while let Some((cx, cy)) = queue.pop_front() {
                    pixel_count += 1;
                    min_x = min_x.min(cx);
                    max_x = max_x.max(cx);
                    min_y = min_y.min(cy);
                    max_y = max_y.max(cy);

                    for (dx, dy) in [(-1i32, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)] {
                        let nx = cx as i32 + dx;
                        let ny = cy as i32 + dy;
                        if nx >= 0 && ny >= 0 && (nx as usize) < w && (ny as usize) < h {
                            let nx = nx as usize;
                            let ny = ny as usize;
                            if binary[ny][nx] && !visited[ny][nx] {
                                visited[ny][nx] = true;
                                queue.push_back((nx, ny));
                            }
                        }
                    }
                }

                let comp_w = (max_x - min_x + 1) as u32;
                let comp_h = (max_y - min_y + 1) as u32;
                if comp_w < DET_MIN_SIZE || comp_h < DET_MIN_SIZE {
                    continue;
                }

                // Expand box by unclip ratio
                let expand_x = ((comp_w as f32) * (DET_UNCLIP_RATIO - 1.0) / 2.0).ceil() as usize;
                let expand_y = ((comp_h as f32) * (DET_UNCLIP_RATIO - 1.0) / 2.0).ceil() as usize;

                let x0 = min_x.saturating_sub(expand_x) as f32;
                let y0 = min_y.saturating_sub(expand_y) as f32;
                let x1 = (max_x + expand_x).min(w - 1) as f32;
                let y1 = (max_y + expand_y).min(h - 1) as f32;

                let density = pixel_count as f32 / (comp_w as f32 * comp_h as f32);
                if density < 0.1 { continue; }

                boxes.push(TextBox {
                    points: [
                        [x0, y0],
                        [x1, y0],
                        [x1, y1],
                        [x0, y1],
                    ],
                    score: density,
                });
            }
        }
    }

    boxes
}

// ── Crop rotated box from image ──────────────────────────────────────────────

fn crop_rotated_box(image: &DynamicImage, bbox: &TextBox) -> RgbImage {
    let pts = &bbox.points;

    let width = ((pts[1][0] - pts[0][0]).powi(2) + (pts[1][1] - pts[0][1]).powi(2)).sqrt() as u32;
    let height = ((pts[3][0] - pts[0][0]).powi(2) + (pts[3][1] - pts[0][1]).powi(2)).sqrt() as u32;
    let width = width.max(1);
    let height = height.max(1);

    let rgb = image.to_rgb8();
    let (img_w, img_h) = (image.width(), image.height());

    let mut output = RgbImage::new(width, height);

    // Affine transform: map output pixels to source image
    let dx_x = (pts[1][0] - pts[0][0]) / width as f32;
    let dx_y = (pts[1][1] - pts[0][1]) / width as f32;
    let dy_x = (pts[3][0] - pts[0][0]) / height as f32;
    let dy_y = (pts[3][1] - pts[0][1]) / height as f32;

    for oy in 0..height {
        for ox in 0..width {
            let sx = pts[0][0] + ox as f32 * dx_x + oy as f32 * dy_x;
            let sy = pts[0][1] + ox as f32 * dx_y + oy as f32 * dy_y;
            let sx = sx.round() as i32;
            let sy = sy.round() as i32;
            if sx >= 0 && sy >= 0 && (sx as u32) < img_w && (sy as u32) < img_h {
                output.put_pixel(ox, oy, *rgb.get_pixel(sx as u32, sy as u32));
            }
        }
    }

    output
}

// ── Key file loading from YAML ───────────────────────────────────────────────

/// Parse character dictionary from PP-OCRv6 inference.yml.
/// The YAML has a `PostProcess.character_dict` (or `characterDict`) section.
fn load_keys_from_yml(path: &Path) -> Result<Vec<String>> {
    if !path.exists() {
        eprintln!("[PPOCRv6] Warning: YAML config not found at {}, using fallback", path.display());
        let mut keys = vec![String::new()];
        for c in 32u8..=126 {
            keys.push((c as char).to_string());
        }
        return Ok(keys);
    }

    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read YAML config: {}", path.display()))?;

    let mut keys: Vec<String> = Vec::new();
    let mut in_char_dict = false;

    for line in content.lines() {
        let trimmed = line.trim();
        // Match both snake_case (character_dict) and camelCase (characterDict)
        if trimmed.contains("character_dict:") || trimmed.contains("characterDict:") {
            in_char_dict = true;
            continue;
        }
        if in_char_dict {
            if let Some(rest) = trimmed.strip_prefix("- ") {
                let r = rest.trim();
                let ch = if (r.starts_with('\'') && r.ends_with('\'') && r.len() >= 2)
                    || (r.starts_with('"') && r.ends_with('"') && r.len() >= 2)
                {
                    &r[1..r.len() - 1]
                } else {
                    r
                };
                keys.push(ch.to_string());
            } else if !trimmed.starts_with('-') && !trimmed.is_empty() {
                break;
            }
        }
    }

    if keys.is_empty() {
        eprintln!("[PPOCRv6] Warning: No characters found in YAML, using fallback");
        let mut keys = vec![String::new()]; // CTC blank
        for c in 32u8..=126 {
            keys.push((c as char).to_string());
        }
        return Ok(keys);
    }

    // PaddleOCR inference defaults: use_space_char=True
    // Append space character to dict (matching official behavior).
    keys.push(" ".to_string());

    // Insert CTC blank token at index 0 (model output idx 0 = blank)
    keys.insert(0, String::new());
    eprintln!(
        "[PPOCRv6] Loaded {} characters from YAML dict (+ space + blank = {} total)",
        keys.len() - 2,
        keys.len()
    );

    Ok(keys)
}
