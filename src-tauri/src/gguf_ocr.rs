//! Self-contained GGUF OCR backend.
//! Loads llama.cpp DLLs from a specified directory and persists the model across calls.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_float, c_int, c_uint, c_void};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use libloading::Library;

// ── Opaque types ──────────────────────────────────────────────────────────────

enum LlamaModel {}
enum LlamaContext {}
enum LlamaVocab {}
// llama_memory_t is a pointer typedef in C. Must be pointer-sized (8 bytes),
// NOT a ZST, because we pass it to/from FFI functions by value.
type LlamaMemoryT = *mut c_void;
enum MtmdContext {}
enum MtmdBitmap {}
enum MtmdInputChunk {}
enum MtmdInputChunks {}

// ── Basic types ──────────────────────────────────────────────────────────────

type LlamaToken = i32;
type LlamaPos = i32;
type LlamaSeqId = i32;

const EOS_TOKEN_IDS: [LlamaToken; 4] = [59246, 59253, 59252, 59251];
const N_VOCAB: usize = 59392;

// ── Enums ────────────────────────────────────────────────────────────────────

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GgmlType {
    F32 = 0,
    F16 = 1,
    Q8_0 = 8,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LlamaFlashAttnType {
    Auto = -1,
    Disabled = 0,
    Enabled = 1,
}

// ── Struct types ─────────────────────────────────────────────────────────────

#[repr(C)]
#[derive(Clone, Copy)]
struct LlamaBatch {
    n_tokens: c_int,
    token: *mut LlamaToken,
    embd: *mut c_float,
    pos: *mut LlamaPos,
    n_seq_id: *mut c_int,
    seq_id: *mut *mut LlamaSeqId,
    logits: *mut i8,
}

#[repr(C)]
pub(crate) struct LlamaModelParams {
    pub(crate) devices: *mut *mut c_void,
    tensor_buft_overrides: *const c_void,
    pub(crate) n_gpu_layers: c_int,
    split_mode: c_int,
    main_gpu: c_int,
    tensor_split: *const c_float,
    progress_callback: *const c_void,
    progress_callback_user_data: *mut c_void,
    kv_overrides: *const c_void,
    vocab_only: bool,
    pub(crate) use_mmap: bool,
    use_direct_io: bool,
    use_mlock: bool,
    check_tensors: bool,
    use_extra_bufts: bool,
    no_host: bool,
    no_alloc: bool,
}

#[repr(C)]
pub(crate) struct LlamaContextParams {
    pub(crate) n_ctx: c_uint,
    pub(crate) n_batch: c_uint,
    pub(crate) n_ubatch: c_uint,
    n_seq_max: c_uint,
    pub(crate) n_threads: c_int,
    pub(crate) n_threads_batch: c_int,
    rope_scaling_type: c_int,
    pooling_type: c_int,
    attention_type: c_int,
    pub(crate) flash_attn_type: LlamaFlashAttnType,
    rope_freq_base: c_float,
    rope_freq_scale: c_float,
    yarn_ext_factor: c_float,
    yarn_attn_factor: c_float,
    yarn_beta_fast: c_float,
    yarn_beta_slow: c_float,
    yarn_orig_ctx: c_uint,
    defrag_thold: c_float,
    cb_eval: *const c_void,
    cb_eval_user_data: *mut c_void,
    pub(crate) type_k: GgmlType,
    pub(crate) type_v: GgmlType,
    abort_callback: *const c_void,
    abort_callback_data: *mut c_void,
    embeddings: bool,
    pub(crate) offload_kqv: bool,
    pub(crate) no_perf: bool,
    pub(crate) op_offload: bool,
    swa_full: bool,
    kv_unified: bool,
    samplers: *const c_void,
    n_samplers: usize,
}

#[repr(C)]
pub(crate) struct MtmdInputText {
    pub(crate) text: *const c_char,
    pub(crate) add_special: bool,
    pub(crate) parse_special: bool,
}

#[repr(C)]
pub(crate) struct MtmdContextParams {
    pub(crate) use_gpu: bool,
    print_timings: bool,
    pub(crate) n_threads: c_int,
    image_marker: *const c_char,
    media_marker: *const c_char,
    pub(crate) flash_attn_type: LlamaFlashAttnType,
    pub(crate) warmup: bool,
    image_min_tokens: c_int,
    image_max_tokens: c_int,
    cb_eval: *const c_void,
    cb_eval_user_data: *mut c_void,
}

// ── Function pointer library ─────────────────────────────────────────────────

type GgmlLogCallback = Option<unsafe extern "C" fn(level: c_int, text: *const c_char, user_data: *mut c_void)>;

macro_rules! load_fn {
    ($lib:expr, $name:literal) => {{
        let sym: libloading::Symbol<unsafe extern "C" fn()> = unsafe { $lib.get($name.as_bytes()) }
            .with_context(|| format!("symbol '{}' not found", $name))?;
        let ptr: *const () = *sym as *const ();
        unsafe { std::mem::transmute_copy::<*const (), _>(&ptr) }
    }};
}

pub struct CppLib {
    _llama_lib: Library,
    _mtmd_lib: Library,

    pub(crate) llama_backend_init: unsafe extern "C" fn(),
    pub(crate) llama_backend_free: unsafe extern "C" fn(),
    pub(crate) llama_log_set: unsafe extern "C" fn(GgmlLogCallback, *mut c_void),
    pub(crate) mtmd_log_set: unsafe extern "C" fn(GgmlLogCallback, *mut c_void),
    pub(crate) mtmd_helper_log_set: unsafe extern "C" fn(GgmlLogCallback, *mut c_void),

    pub(crate) llama_model_default_params: unsafe extern "C" fn() -> LlamaModelParams,
    pub(crate) llama_context_default_params: unsafe extern "C" fn() -> LlamaContextParams,
    pub(crate) llama_model_load_from_file:
        unsafe extern "C" fn(*const c_char, LlamaModelParams) -> *mut LlamaModel,
    pub(crate) llama_model_free: unsafe extern "C" fn(*mut LlamaModel),
    pub(crate) llama_init_from_model:
        unsafe extern "C" fn(*mut LlamaModel, LlamaContextParams) -> *mut LlamaContext,
    pub(crate) llama_free: unsafe extern "C" fn(*mut LlamaContext),
    pub(crate) llama_get_memory: unsafe extern "C" fn(*const LlamaContext) -> LlamaMemoryT,
    pub(crate) llama_model_get_vocab: unsafe extern "C" fn(*const LlamaModel) -> *const LlamaVocab,

    pub(crate) llama_batch_init: unsafe extern "C" fn(c_int, c_int, c_int) -> LlamaBatch,
    pub(crate) llama_batch_free: unsafe extern "C" fn(LlamaBatch),
    pub(crate) llama_decode: unsafe extern "C" fn(*mut LlamaContext, LlamaBatch) -> c_int,
    pub(crate) llama_get_logits: unsafe extern "C" fn(*mut LlamaContext) -> *mut c_float,
    pub(crate) llama_token_to_piece: unsafe extern "C" fn(
        *const LlamaVocab, LlamaToken,
        *mut c_char, c_int, c_int, bool,
    ) -> c_int,
    pub(crate) llama_memory_clear:
        unsafe extern "C" fn(LlamaMemoryT, bool),
    pub(crate) llama_memory_seq_rm:
        unsafe extern "C" fn(LlamaMemoryT, LlamaSeqId, LlamaPos, LlamaPos) -> bool,

    pub(crate) mtmd_context_params_default: unsafe extern "C" fn() -> MtmdContextParams,
    pub(crate) mtmd_init_from_file: unsafe extern "C" fn(
        *const c_char, *const LlamaModel, MtmdContextParams,
    ) -> *mut MtmdContext,
    pub(crate) mtmd_free: unsafe extern "C" fn(*mut MtmdContext),
    pub(crate) mtmd_default_marker: unsafe extern "C" fn() -> *const c_char,
    pub(crate) mtmd_bitmap_init: unsafe extern "C" fn(c_uint, c_uint, *const u8) -> *mut MtmdBitmap,
    pub(crate) mtmd_bitmap_free: unsafe extern "C" fn(*mut MtmdBitmap),
    pub(crate) mtmd_input_chunks_init: unsafe extern "C" fn() -> *mut MtmdInputChunks,
    pub(crate) mtmd_input_chunks_size: unsafe extern "C" fn(*const MtmdInputChunks) -> usize,
    pub(crate) mtmd_input_chunks_free: unsafe extern "C" fn(*mut MtmdInputChunks),
    pub(crate) mtmd_input_chunk_get_tokens_text:
        unsafe extern "C" fn(*const MtmdInputChunk, *mut usize) -> *const LlamaToken,
    pub(crate) mtmd_input_chunk_get_n_tokens: unsafe extern "C" fn(*const MtmdInputChunk) -> usize,
    pub(crate) mtmd_input_chunk_get_n_pos: unsafe extern "C" fn(*const MtmdInputChunk) -> LlamaPos,
    pub(crate) mtmd_tokenize: unsafe extern "C" fn(
        *mut MtmdContext, *mut MtmdInputChunks, *const MtmdInputText,
        *const *const MtmdBitmap, usize,
    ) -> c_int,
    pub(crate) mtmd_helper_bitmap_init_from_file:
        unsafe extern "C" fn(*mut MtmdContext, *const c_char) -> *mut MtmdBitmap,
    pub(crate) mtmd_helper_eval_chunks: unsafe extern "C" fn(
        *mut MtmdContext, *mut LlamaContext, *const MtmdInputChunks,
        LlamaPos, LlamaSeqId, c_int, bool, *mut LlamaPos,
    ) -> c_int,
    pub(crate) mtmd_helper_get_n_tokens: unsafe extern "C" fn(*const MtmdInputChunks) -> usize,
    pub(crate) mtmd_helper_get_n_pos: unsafe extern "C" fn(*const MtmdInputChunks) -> LlamaPos,
}

impl CppLib {
    pub fn load(llama_path: &Path, mtmd_path: &Path) -> Result<Self> {
        let llama_lib = unsafe { Library::new(llama_path) }
            .with_context(|| format!("loading {}", llama_path.display()))?;
        let mtmd_lib = unsafe { Library::new(mtmd_path) }
            .with_context(|| format!("loading {}", mtmd_path.display()))?;

        Ok(Self {
            llama_backend_init: load_fn!(llama_lib, "llama_backend_init"),
            llama_backend_free: load_fn!(llama_lib, "llama_backend_free"),
            llama_log_set: load_fn!(llama_lib, "llama_log_set"),
            mtmd_log_set: load_fn!(mtmd_lib, "mtmd_log_set"),
            mtmd_helper_log_set: load_fn!(mtmd_lib, "mtmd_helper_log_set"),
            llama_model_default_params: load_fn!(llama_lib, "llama_model_default_params"),
            llama_context_default_params: load_fn!(llama_lib, "llama_context_default_params"),
            llama_model_load_from_file: load_fn!(llama_lib, "llama_model_load_from_file"),
            llama_model_free: load_fn!(llama_lib, "llama_model_free"),
            llama_init_from_model: load_fn!(llama_lib, "llama_init_from_model"),
            llama_free: load_fn!(llama_lib, "llama_free"),
            llama_get_memory: load_fn!(llama_lib, "llama_get_memory"),
            llama_model_get_vocab: load_fn!(llama_lib, "llama_model_get_vocab"),
            llama_batch_init: load_fn!(llama_lib, "llama_batch_init"),
            llama_batch_free: load_fn!(llama_lib, "llama_batch_free"),
            llama_decode: load_fn!(llama_lib, "llama_decode"),
            llama_get_logits: load_fn!(llama_lib, "llama_get_logits"),
            llama_token_to_piece: load_fn!(llama_lib, "llama_token_to_piece"),
            llama_memory_clear: load_fn!(llama_lib, "llama_memory_clear"),
            llama_memory_seq_rm: load_fn!(llama_lib, "llama_memory_seq_rm"),
            mtmd_context_params_default: load_fn!(mtmd_lib, "mtmd_context_params_default"),
            mtmd_init_from_file: load_fn!(mtmd_lib, "mtmd_init_from_file"),
            mtmd_free: load_fn!(mtmd_lib, "mtmd_free"),
            mtmd_default_marker: load_fn!(mtmd_lib, "mtmd_default_marker"),
            mtmd_bitmap_init: load_fn!(mtmd_lib, "mtmd_bitmap_init"),
            mtmd_bitmap_free: load_fn!(mtmd_lib, "mtmd_bitmap_free"),
            mtmd_input_chunks_init: load_fn!(mtmd_lib, "mtmd_input_chunks_init"),
            mtmd_input_chunks_size: load_fn!(mtmd_lib, "mtmd_input_chunks_size"),
            mtmd_input_chunks_free: load_fn!(mtmd_lib, "mtmd_input_chunks_free"),
            mtmd_input_chunk_get_tokens_text: load_fn!(mtmd_lib, "mtmd_input_chunk_get_tokens_text"),
            mtmd_input_chunk_get_n_tokens: load_fn!(mtmd_lib, "mtmd_input_chunk_get_n_tokens"),
            mtmd_input_chunk_get_n_pos: load_fn!(mtmd_lib, "mtmd_input_chunk_get_n_pos"),
            mtmd_tokenize: load_fn!(mtmd_lib, "mtmd_tokenize"),
            mtmd_helper_bitmap_init_from_file: load_fn!(
                mtmd_lib, "mtmd_helper_bitmap_init_from_file"
            ),
            mtmd_helper_eval_chunks: load_fn!(mtmd_lib, "mtmd_helper_eval_chunks"),
            mtmd_helper_get_n_tokens: load_fn!(mtmd_lib, "mtmd_helper_get_n_tokens"),
            mtmd_helper_get_n_pos: load_fn!(mtmd_lib, "mtmd_helper_get_n_pos"),
            _llama_lib: llama_lib,
            _mtmd_lib: mtmd_lib,
        })
    }
}

// ── Logging ──────────────────────────────────────────────────────────────────

static VERBOSE: AtomicBool = AtomicBool::new(false);

unsafe extern "C" fn log_callback(level: c_int, text: *const c_char, _user_data: *mut c_void) {
    if !VERBOSE.load(Ordering::Relaxed) || text.is_null() {
        return;
    }
    let text = match CStr::from_ptr(text).to_str() {
        Ok(s) => s.trim(),
        Err(_) => return,
    };
    if text.is_empty() {
        return;
    }
    let level_name = match level {
        1 => "DEBUG",
        3 => "WARN",
        4 => "ERROR",
        _ => "INFO",
    };
    eprintln!("[OCR][{level_name}] {text}");
}

fn install_log_hooks(lib: &CppLib) {
    unsafe {
        (lib.llama_log_set)(Some(log_callback), std::ptr::null_mut());
        (lib.mtmd_log_set)(Some(log_callback), std::ptr::null_mut());
        (lib.mtmd_helper_log_set)(Some(log_callback), std::ptr::null_mut());
    }
}

// ── Backend ──────────────────────────────────────────────────────────────────

// SAFETY: GgufBackend is always accessed through `Mutex`, ensuring exclusive
// access to the underlying llama.cpp context. No concurrent FFI calls possible.
unsafe impl Send for GgufBackend {}

pub struct GgufBackend {
    lib: CppLib,
    force_cpu: bool,
    loaded: bool,
    model: *mut LlamaModel,
    ctx: *mut LlamaContext,
    vocab: *const LlamaVocab,
    mtmd_ctx: *mut MtmdContext,
    loaded_model_root: Option<PathBuf>,
}

pub struct InferResult {
    pub text: String,
    pub token_count: usize,
}

impl GgufBackend {
    pub fn new(lib: CppLib, force_cpu: bool) -> Self {
        Self {
            lib,
            force_cpu,
            loaded: false,
            model: std::ptr::null_mut(),
            ctx: std::ptr::null_mut(),
            vocab: std::ptr::null(),
            mtmd_ctx: std::ptr::null_mut(),
            loaded_model_root: None,
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded
    }

    pub fn unload(&mut self) {
        if !self.loaded {
            return;
        }
        let lib = &self.lib;
        unsafe {
            if !self.mtmd_ctx.is_null() {
                (lib.mtmd_free)(self.mtmd_ctx);
            }
            if !self.ctx.is_null() {
                (lib.llama_free)(self.ctx);
            }
            if !self.model.is_null() {
                (lib.llama_model_free)(self.model);
            }
            (lib.llama_backend_free)();
        }
        self.loaded = false;
        self.model = std::ptr::null_mut();
        self.ctx = std::ptr::null_mut();
        self.vocab = std::ptr::null();
        self.mtmd_ctx = std::ptr::null_mut();
        self.loaded_model_root = None;
    }

    fn ensure_loaded(&mut self, model_root: &Path) -> Result<()> {
        if self.loaded {
            if self.loaded_model_root.as_deref() != Some(model_root) {
                self.unload();
            } else {
                return Ok(());
            }
        }

        let lib = &self.lib;
        let text_model = model_root.join("GLM-OCR-Q8_0.gguf");
        let mmproj = model_root.join("mmproj-GLM-OCR-Q8_0.gguf");

        for p in [&text_model, &mmproj] {
            if !p.exists() {
                bail!("Missing file: {}", p.display());
            }
        }

        let total_t = Instant::now();

        unsafe { (lib.llama_backend_init)(); }
        install_log_hooks(lib);

        let n_threads = std::thread::available_parallelism()
            .map(|nz| nz.get() as c_int)
            .unwrap_or(4);

        // Load text model
        let model_path_c = CString::new(text_model.to_str().unwrap())
            .map_err(|_| anyhow!("Invalid model path"))?;
        let mut mparams = unsafe { (lib.llama_model_default_params)() };
        mparams.n_gpu_layers = if self.force_cpu { 0 } else { -1 };
        mparams.use_mmap = true;

        let model = unsafe { (lib.llama_model_load_from_file)(model_path_c.as_ptr(), mparams) };
        if model.is_null() {
            bail!("Failed to load text model");
        }

        // Create context
        let mut cparams = unsafe { (lib.llama_context_default_params)() };
        cparams.n_ctx = 8192;
        cparams.n_batch = 512;
        cparams.n_ubatch = 512;
        cparams.n_threads = n_threads;
        cparams.n_threads_batch = n_threads;
        cparams.flash_attn_type = if self.force_cpu {
            LlamaFlashAttnType::Disabled
        } else {
            LlamaFlashAttnType::Enabled
        };
        cparams.offload_kqv = !self.force_cpu;
        if !self.force_cpu {
            cparams.type_k = GgmlType::Q8_0;
            cparams.type_v = GgmlType::Q8_0;
        }
        cparams.no_perf = false;
        cparams.op_offload = !self.force_cpu;

        let ctx = unsafe { (lib.llama_init_from_model)(model, cparams) };
        if ctx.is_null() {
            unsafe { (lib.llama_model_free)(model); }
            bail!("Failed to create llama context");
        }

        // Initialize multimodal context
        let mmproj_c = CString::new(mmproj.to_str().unwrap())
            .map_err(|_| anyhow!("Invalid mmproj path"))?;
        let mut mtmd_p = unsafe { (lib.mtmd_context_params_default)() };
        mtmd_p.use_gpu = !self.force_cpu;
        mtmd_p.n_threads = n_threads;
        mtmd_p.flash_attn_type = if self.force_cpu {
            LlamaFlashAttnType::Disabled
        } else {
            LlamaFlashAttnType::Enabled
        };
        mtmd_p.warmup = true;

        let mtmd_ctx = unsafe {
            (lib.mtmd_init_from_file)(mmproj_c.as_ptr(), model, mtmd_p)
        };
        if mtmd_ctx.is_null() {
            unsafe { (lib.llama_free)(ctx); (lib.llama_model_free)(model); }
            bail!("Failed to load mmproj");
        }

        let vocab = unsafe { (lib.llama_model_get_vocab)(model) };
        if vocab.is_null() {
            unsafe { (lib.llama_free)(ctx); (lib.llama_model_free)(model); }
            bail!("Failed to get vocab");
        }

        self.model = model;
        self.ctx = ctx;
        self.vocab = vocab;
        self.mtmd_ctx = mtmd_ctx;
        self.loaded = true;
        self.loaded_model_root = Some(model_root.to_path_buf());

        eprintln!(
            "[OCR] model loaded ({:.2}s), will persist across calls",
            total_t.elapsed().as_secs_f64()
        );
        Ok(())
    }

    pub fn infer(
        &mut self,
        model_root: &Path,
        image_path: &Path,
    ) -> Result<InferResult> {
        let total_t = Instant::now();

        self.ensure_loaded(model_root)?;
        let lib = &self.lib;
        let ctx = self.ctx;
        let vocab = self.vocab;
        let mtmd_ctx = self.mtmd_ctx;

        // Clear KV cache for fresh inference
        let mem = unsafe { (lib.llama_get_memory)(ctx) };
        unsafe { (lib.llama_memory_clear)(mem, true); }

        // Load image
        let image_path_c = CString::new(image_path.to_str().unwrap())
            .map_err(|_| anyhow!("Invalid image path"))?;
        let bitmap = unsafe {
            (lib.mtmd_helper_bitmap_init_from_file)(mtmd_ctx, image_path_c.as_ptr())
        };
        if bitmap.is_null() {
            bail!("Failed to load image: {}", image_path.display());
        }

        // Build prompt
        let marker = unsafe { CStr::from_ptr((lib.mtmd_default_marker)()) };
        let marker_str = marker.to_str().unwrap_or("<__media__>");
        let prompt = format!(
            "[gMASK]<sop><|user|>\n<|begin_of_image|>{}<|end_of_image|>\nText Recognition:\n<|assistant|>\n",
            marker_str
        );

        let prompt_c = CString::new(prompt.as_str()).map_err(|_| anyhow!("Invalid prompt"))?;
        let input_text = MtmdInputText {
            text: prompt_c.as_ptr(),
            add_special: false,
            parse_special: true,
        };

        // Tokenize
        let bitmaps_arr: [*const MtmdBitmap; 1] = [bitmap as *const MtmdBitmap];
        let chunks = unsafe { (lib.mtmd_input_chunks_init)() };
        if chunks.is_null() {
            unsafe { (lib.mtmd_bitmap_free)(bitmap); }
            bail!("Failed to create input chunks");
        }

        let res = unsafe {
            (lib.mtmd_tokenize)(mtmd_ctx, chunks, &input_text, bitmaps_arr.as_ptr(), 1)
        };
        unsafe { (lib.mtmd_bitmap_free)(bitmap); }
        if res != 0 {
            unsafe { (lib.mtmd_input_chunks_free)(chunks); }
            bail!("mtmd_tokenize failed with code {res}");
        }

        // Eval all chunks
        let n_batch = 512i32;
        let mut new_n_past: LlamaPos = 0;
        let eval_res = unsafe {
            (lib.mtmd_helper_eval_chunks)(
                mtmd_ctx, ctx, chunks, 0, 0, n_batch, true, &mut new_n_past,
            )
        };
        unsafe { (lib.mtmd_input_chunks_free)(chunks); }
        if eval_res != 0 {
            bail!("mtmd_helper_eval_chunks failed with code {eval_res}");
        }

        // ── Autoregressive decode ──────────────────────────────────────────

        let logits_ptr = unsafe { (lib.llama_get_logits)(ctx) };
        if logits_ptr.is_null() {
            bail!("llama_get_logits returned null");
        }
        let logits_slice = unsafe { std::slice::from_raw_parts(logits_ptr, N_VOCAB) };
        let first_token = argmax(logits_slice);

        let max_new_tokens: usize = std::env::var("OCR_MAX_NEW_TOKENS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2048);

        let mut generated: Vec<LlamaToken> = vec![first_token];
        let mut n_past = new_n_past;

        for _step in 0..max_new_tokens {
            let current_token = *generated.last().unwrap();
            if EOS_TOKEN_IDS.contains(&current_token) {
                break;
            }

            let batch = make_batch(lib, current_token, n_past);
            let dec_res = unsafe { (lib.llama_decode)(ctx, batch) };
            unsafe { (lib.llama_batch_free)(batch); }
            if dec_res != 0 {
                bail!("llama_decode failed with code {dec_res}");
            }

            let logits_ptr = unsafe { (lib.llama_get_logits)(ctx) };
            if logits_ptr.is_null() {
                bail!("llama_get_logits returned null");
            }
            let logits_slice = unsafe { std::slice::from_raw_parts(logits_ptr, N_VOCAB) };
            let next_token = argmax(logits_slice);
            generated.push(next_token);
            n_past += 1;
        }

        // Decode text
        let mut output = String::new();
        for &tok in &generated {
            if EOS_TOKEN_IDS.contains(&tok) { break; }
            let piece = token_to_string(lib, vocab, tok)?;
            output.push_str(&piece);
        }

        eprintln!(
            "[OCR] inference: {:.1}s, {} tokens, {} chars",
            total_t.elapsed().as_secs_f64(),
            generated.len(),
            output.len()
        );

        Ok(InferResult {
            text: output,
            token_count: generated.len(),
        })
    }
}

impl Drop for GgufBackend {
    fn drop(&mut self) {
        self.unload();
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn argmax(logits: &[f32]) -> LlamaToken {
    logits
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(idx, _)| idx as LlamaToken)
        .unwrap_or(EOS_TOKEN_IDS[0])
}

fn token_to_string(lib: &CppLib, vocab: *const LlamaVocab, token: LlamaToken) -> Result<String> {
    let mut buf = [0u8; 512];
    let n = unsafe {
        (lib.llama_token_to_piece)(vocab, token, buf.as_mut_ptr() as *mut c_char, buf.len() as c_int, 0, true)
    };
    if n < 0 {
        bail!("Failed to convert token {token} to string (returned {n})");
    }
    if n == 0 {
        return Ok(String::new());
    }
    let n = n as usize;
    let s = std::str::from_utf8(&buf[..n])
        .with_context(|| format!("Non-UTF-8 token output for token {token}"))?;
    Ok(s.to_string())
}

fn make_batch(lib: &CppLib, token: LlamaToken, pos: LlamaPos) -> LlamaBatch {
    let mut batch = unsafe { (lib.llama_batch_init)(1, 0, 1) };
    batch.n_tokens = 1;
    unsafe {
        *batch.token = token;
        *batch.pos = pos;
        *batch.n_seq_id = 1;
        *(*batch.seq_id).add(0) = 0;
        *batch.logits = 1;
    }
    batch
}
