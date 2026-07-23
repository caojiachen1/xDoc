//! OCR model catalog.
//!
//! All model definitions live in `src-tauri/ocr_models.json` (embedded at compile
//! time via `include_str!`). To add or update an OCR model, edit that JSON file
//! only — no changes to this file or any consuming code are required.
//!
//! The JSON is parsed once on first access and the resulting values are leaked to
//! obtain `&'static` references, so the rest of the codebase can keep treating the
//! catalog exactly like the old hard-coded `&'static` tables.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OcrEngine { Gguf, Ppocrv6 }

impl Default for OcrEngine { fn default() -> Self { Self::Gguf } }

// ── Public catalog types (kept with `&'static str` fields for zero-churn consumers) ──

#[derive(Debug, Clone, Serialize)]
pub struct GgufOcrModel {
    pub label: &'static str,
    pub id: &'static str,
    pub repo_id: &'static str,
    pub text_model_q8: &'static str,
    pub text_model_f16: Option<&'static str>,
    pub mmproj_q8: &'static str,
    pub mmproj_f16: Option<&'static str>,
    pub prompt_template: &'static str,
    pub eos_token_ids: &'static [i32],
    pub n_vocab: usize,
    pub n_ctx: u32,
    pub params: &'static str,
    pub description: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ppocrv6Size { Tiny, Small, Medium }

impl Default for Ppocrv6Size { fn default() -> Self { Self::Medium } }

#[derive(Debug, Clone, Serialize)]
pub struct Ppocrv6ModelInfo {
    pub size: Ppocrv6Size,
    pub label: &'static str,
    pub id: &'static str,
    /// ModelScope repo for detection model (contains inference.onnx)
    pub det_repo: &'static str,
    /// ModelScope repo for recognition model (contains inference.onnx + inference.yml)
    pub rec_repo: &'static str,
    /// Local file name for detection ONNX (renamed from inference.onnx)
    pub det_onnx: &'static str,
    /// Local file name for recognition ONNX (renamed from inference.onnx)
    pub rec_onnx: &'static str,
    /// Local file name for recognition config (renamed from inference.yml, contains char dict)
    pub rec_yml: &'static str,
    pub params: &'static str,
    pub description: &'static str,
}

// ── Raw (owned) JSON representation ──────────────────────────────────────

#[derive(Deserialize)]
struct RawCatalog {
    gguf: Vec<RawGgufModel>,
    ppocrv6: Vec<RawPpocrv6Model>,
}

#[derive(Deserialize)]
struct RawGgufModel {
    label: String,
    id: String,
    repo_id: String,
    text_model_q8: String,
    text_model_f16: Option<String>,
    mmproj_q8: String,
    mmproj_f16: Option<String>,
    prompt_template: String,
    eos_token_ids: Vec<i32>,
    n_vocab: usize,
    n_ctx: u32,
    params: String,
    description: String,
}

#[derive(Deserialize)]
struct RawPpocrv6Model {
    size: Ppocrv6Size,
    label: String,
    id: String,
    det_repo: String,
    rec_repo: String,
    det_onnx: String,
    rec_onnx: String,
    rec_yml: String,
    params: String,
    description: String,
}

// ── Catalog loading (parse once, leak to `&'static`) ─────────────────────

/// The catalog JSON, embedded into the binary at compile time.
const CATALOG_JSON: &str = include_str!("../ocr_models.json");

struct Catalog {
    gguf: &'static [GgufOcrModel],
    ppocrv6: &'static [Ppocrv6ModelInfo],
}

static CATALOG: OnceLock<Catalog> = OnceLock::new();

fn leak_str(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn leak_opt(s: Option<String>) -> Option<&'static str> {
    s.map(leak_str)
}

fn load_catalog() -> Catalog {
    let raw: RawCatalog = serde_json::from_str(CATALOG_JSON)
        .expect("Failed to parse embedded ocr_models.json — check its syntax");

    let gguf: Vec<GgufOcrModel> = raw.gguf.into_iter().map(|m| GgufOcrModel {
        label: leak_str(m.label),
        id: leak_str(m.id),
        repo_id: leak_str(m.repo_id),
        text_model_q8: leak_str(m.text_model_q8),
        text_model_f16: leak_opt(m.text_model_f16),
        mmproj_q8: leak_str(m.mmproj_q8),
        mmproj_f16: leak_opt(m.mmproj_f16),
        prompt_template: leak_str(m.prompt_template),
        eos_token_ids: Box::leak(m.eos_token_ids.into_boxed_slice()),
        n_vocab: m.n_vocab,
        n_ctx: m.n_ctx,
        params: leak_str(m.params),
        description: leak_str(m.description),
    }).collect();

    let ppocrv6: Vec<Ppocrv6ModelInfo> = raw.ppocrv6.into_iter().map(|m| Ppocrv6ModelInfo {
        size: m.size,
        label: leak_str(m.label),
        id: leak_str(m.id),
        det_repo: leak_str(m.det_repo),
        rec_repo: leak_str(m.rec_repo),
        det_onnx: leak_str(m.det_onnx),
        rec_onnx: leak_str(m.rec_onnx),
        rec_yml: leak_str(m.rec_yml),
        params: leak_str(m.params),
        description: leak_str(m.description),
    }).collect();

    Catalog {
        gguf: Box::leak(gguf.into_boxed_slice()),
        ppocrv6: Box::leak(ppocrv6.into_boxed_slice()),
    }
}

fn catalog() -> &'static Catalog {
    CATALOG.get_or_init(load_catalog)
}

/// All GGUF (llama.cpp) OCR models defined in the catalog.
pub fn gguf_ocr_models() -> &'static [GgufOcrModel] {
    catalog().gguf
}

/// All PP-OCRv6 (ONNX) OCR models defined in the catalog.
pub fn ppocrv6_models() -> &'static [Ppocrv6ModelInfo] {
    catalog().ppocrv6
}

// ── Lookups ──────────────────────────────────────────────────────────────

pub fn find_gguf_model(id: &str) -> Option<&'static GgufOcrModel> {
    gguf_ocr_models().iter().find(|m| m.id == id)
}

pub fn find_ppocrv6_model(size: Ppocrv6Size) -> &'static Ppocrv6ModelInfo {
    let models = ppocrv6_models();
    models.iter().find(|m| m.size == size).unwrap_or(&models[0])
}

pub fn find_ppocrv6_model_by_id(id: &str) -> Option<&'static Ppocrv6ModelInfo> {
    ppocrv6_models().iter().find(|m| m.id == id)
}

pub fn all_ocr_model_ids() -> Vec<&'static str> {
    let mut ids: Vec<&'static str> = gguf_ocr_models().iter().map(|m| m.id).collect();
    ids.extend(ppocrv6_models().iter().map(|m| m.id));
    ids
}
