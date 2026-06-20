//! OCR model definitions - all llama.cpp GGUF OCR models + PPOCRv6 ONNX.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OcrEngine { Gguf, Ppocrv6 }

impl Default for OcrEngine { fn default() -> Self { Self::Gguf } }

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

pub fn find_gguf_model(id: &str) -> Option<&'static GgufOcrModel> {
    GGUF_OCR_MODELS.iter().find(|m| m.id == id)
}

pub fn find_ppocrv6_model(size: Ppocrv6Size) -> &'static Ppocrv6ModelInfo {
    PPOCRV6_MODELS.iter().find(|m| m.size == size).unwrap_or(&PPOCRV6_MODELS[0])
}

pub fn find_ppocrv6_model_by_id(id: &str) -> Option<&'static Ppocrv6ModelInfo> {
    PPOCRV6_MODELS.iter().find(|m| m.id == id)
}

pub fn all_ocr_model_ids() -> Vec<&'static str> {
    let mut ids: Vec<&'static str> = GGUF_OCR_MODELS.iter().map(|m| m.id).collect();
    ids.extend(PPOCRV6_MODELS.iter().map(|m| m.id));
    ids
}

// ── GGUF OCR model catalog ──────────────────────────────────────────────

pub static GGUF_OCR_MODELS: &[GgufOcrModel] = &[
    // ── 1. GLM-OCR ──────────────────────────────────────────────────────
    GgufOcrModel {
        label: "GLM-OCR (智谱, 0.9B)",
        id: "glm-ocr",
        repo_id: "ggml-org/GLM-OCR-GGUF",
        text_model_q8: "GLM-OCR-Q8_0.gguf",
        text_model_f16: Some("GLM-OCR-f16.gguf"),
        mmproj_q8: "mmproj-GLM-OCR-Q8_0.gguf",
        mmproj_f16: None,
        prompt_template: "[gMASK]<sop><|user|>\n<|begin_of_image|>{marker}<|end_of_image|>\nText Recognition:\n<|assistant|>\n",
        eos_token_ids: &[59246, 59253, 59252, 59251],
        n_vocab: 59392,
        n_ctx: 8192,
        params: "0.9B",
        description: "智谱AI开源OCR模型，支持文字/公式/表格识别，中文效果优秀",
    },

    // ── 2. DeepSeek-OCR ─────────────────────────────────────────────────
    GgufOcrModel {
        label: "DeepSeek-OCR (深度求索, 3B)",
        id: "deepseek-ocr",
        repo_id: "ggml-org/DeepSeek-OCR-GGUF",
        text_model_q8: "DeepSeek-OCR-Q8_0.gguf",
        text_model_f16: None,
        mmproj_q8: "mmproj-DeepSeek-OCR-Q8_0.gguf",
        mmproj_f16: None,
        prompt_template: "<image>\nFree OCR. ",
        eos_token_ids: &[1, 0],
        n_vocab: 129280,
        n_ctx: 8192,
        params: "3B",
        description: "DeepSeek开源OCR模型，支持文档转Markdown，长文本识别能力强",
    },

    // ── 3. HunyuanOCR ───────────────────────────────────────────────────
    GgufOcrModel {
        label: "HunyuanOCR (腾讯混元, 0.5B)",
        id: "hunyuan-ocr",
        repo_id: "ggml-org/HunyuanOCR-GGUF",
        text_model_q8: "HunyuanOCR-Q8_0.gguf",
        text_model_f16: Some("HunyuanOCR-bf16.gguf"),
        mmproj_q8: "mmproj-HunyuanOCR-Q8_0.gguf",
        mmproj_f16: Some("mmproj-HunyuanOCR-bf16.gguf"),
        prompt_template: "<｜hy_begin▁of▁sentence｜><｜hy_place▁holder▁no▁100｜>{marker}<｜hy_place▁holder▁no▁101｜>OCR<｜hy_User｜>",
        eos_token_ids: &[120007],
        n_vocab: 120818,
        n_ctx: 8192,
        params: "0.5B",
        description: "腾讯混元OCR模型，支持文字/公式/表格/版面分析，超轻量高效",
    },

    // ── 4. dots.ocr ─────────────────────────────────────────────────────
    GgufOcrModel {
        label: "dots.ocr (小红书, 2B)",
        id: "dots-ocr",
        repo_id: "ggml-org/dots.ocr-GGUF",
        text_model_q8: "dots.ocr-Q8_0.gguf",
        text_model_f16: Some("dots.ocr-f16.gguf"),
        mmproj_q8: "mmproj-dots.ocr-Q8_0.gguf",
        mmproj_f16: Some("mmproj-dots.ocr-f16.gguf"),
        prompt_template: "<|user|>{marker}\nOCR<|endofuser|><|assistant|>",
        eos_token_ids: &[151645, 151643],
        n_vocab: 151936,
        n_ctx: 8192,
        params: "2B",
        description: "小红书开源多语言文档解析模型，支持结构化输出与多语言识别",
    },

    // ── 5. Qianfan-OCR ──────────────────────────────────────────────────
    GgufOcrModel {
        label: "Qianfan-OCR (百度千帆, 4B)",
        id: "qianfan-ocr",
        repo_id: "ggml-org/Qianfan-OCR-GGUF",
        text_model_q8: "Qianfan-OCR-Q8_0.gguf",
        text_model_f16: Some("Qianfan-OCR-f16.gguf"),
        mmproj_q8: "mmproj-Qianfan-OCR-Q8_0.gguf",
        mmproj_f16: Some("mmproj-Qianfan-OCR-f16.gguf"),
        prompt_template: "<|im_start|>user\n{marker}\nParse this document to Markdown.\n<|im_end|>\n<|im_start|>assistant\n",
        eos_token_ids: &[151645],
        n_vocab: 153678,
        n_ctx: 8192,
        params: "4B",
        description: "百度千帆OCR模型，支持卡证识别/文档解析/关键信息提取",
    },

    // ── 6. LightOnOCR v1 ─────────────────────────────────────────────────
    GgufOcrModel {
        label: "LightOnOCR v1 (LightOn, 1B)",
        id: "lighton-ocr-1b",
        repo_id: "ggml-org/LightOnOCR-1B-1025-GGUF",
        text_model_q8: "LightOnOCR-1B-1025-Q8_0.gguf",
        text_model_f16: None,
        mmproj_q8: "mmproj-LightOnOCR-1B-1025-Q8_0.gguf",
        mmproj_f16: None,
        prompt_template: "<|im_start|>user\n{marker}\nOCR\n<|im_end|>\n<|im_start|>assistant\n",
        eos_token_ids: &[151645, 151643],
        n_vocab: 151936,
        n_ctx: 8192,
        params: "1B",
        description: "LightOn开源轻量级OCR模型，高效文档文字识别",
    },
];

// ── PPOCRv6 ONNX model catalog ────────────────────────────────────────

pub static PPOCRV6_MODELS: &[Ppocrv6ModelInfo] = &[
    // ── PP-OCRv6 Medium (34.5M params, Server) ──────────────────────────
    Ppocrv6ModelInfo {
        size: Ppocrv6Size::Medium,
        label: "PP-OCRv6 Medium (服务端, 34.5M)",
        id: "ppocrv6-medium",
        det_repo: "PaddlePaddle/PP-OCRv6_medium_det_onnx",
        rec_repo: "PaddlePaddle/PP-OCRv6_medium_rec_onnx",
        det_onnx: "det.onnx",
        rec_onnx: "rec.onnx",
        rec_yml: "rec.yml",
        params: "34.5M",
        description: "PP-OCRv6 服务端模型，精度最高，适合文档识别 (det 59MB + rec 73MB)",
    },

    // ── PP-OCRv6 Small (7.7M params, Mobile) ────────────────────────────
    Ppocrv6ModelInfo {
        size: Ppocrv6Size::Small,
        label: "PP-OCRv6 Small (移动端, 7.7M)",
        id: "ppocrv6-small",
        det_repo: "PaddlePaddle/PP-OCRv6_small_det_onnx",
        rec_repo: "PaddlePaddle/PP-OCRv6_small_rec_onnx",
        det_onnx: "det.onnx",
        rec_onnx: "rec.onnx",
        rec_yml: "rec.yml",
        params: "7.7M",
        description: "PP-OCRv6 移动端模型，速度与精度均衡 (det 9.4MB + rec 20MB)",
    },

    // ── PP-OCRv6 Tiny (1.5M params, Edge) ──────────────────────────────
    Ppocrv6ModelInfo {
        size: Ppocrv6Size::Tiny,
        label: "PP-OCRv6 Tiny (边缘端, 1.5M)",
        id: "ppocrv6-tiny",
        det_repo: "PaddlePaddle/PP-OCRv6_tiny_det_onnx",
        rec_repo: "PaddlePaddle/PP-OCRv6_tiny_rec_onnx",
        det_onnx: "det.onnx",
        rec_onnx: "rec.onnx",
        rec_yml: "rec.yml",
        params: "1.5M",
        description: "PP-OCRv6 边缘端模型，超轻量快速，适合实时场景 (det 1.7MB + rec 4.3MB)",
    },
];
