use std::env;
use std::path::{Path, PathBuf};

#[allow(dead_code)]
mod gguf_ocr;
mod settings_db;
mod plugin_host;
mod plugin_storage;
mod pptx_gen;

mod commands;

use commands::{
    grobid::GrobidEngineState,
    model,
    ocr::OcrState,
    pdf,
    ModelState,
};
use settings_db::SettingsDb;
use plugin_host::PluginState;

#[cfg(target_os = "windows")]
extern "system" {
    fn SetDllDirectoryW(lpPathName: *const u16) -> i32;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let dll_dir = commands::resolve_dll_dir();
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

    // Open (or create) the settings DB.
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
            conn.execute(
                "CREATE TABLE IF NOT EXISTS journal_rankings (
                    journal_norm TEXT PRIMARY KEY,
                    journal      TEXT NOT NULL,
                    zone         INTEGER NOT NULL,
                    is_top       INTEGER NOT NULL DEFAULT 0,
                    is_oa        INTEGER NOT NULL DEFAULT 0
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

    // Initialize journal rankings table from embedded data
    if let Err(e) = settings_db.init_journal_rankings() {
        eprintln!("[xDoc] failed to init journal rankings: {e}");
    }

    // Initialize plugin system
    let plugin_data_dir = {
        let base = if Path::new("C:\\xDoc").exists() {
            PathBuf::from("C:\\xDoc")
        } else {
            env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .unwrap_or_else(|| PathBuf::from("."))
        };
        base
    };
    let plugin_state = PluginState::new(&plugin_data_dir);
    let discovered = plugin_state.scan_plugins();
    eprintln!("[xDoc] plugin system initialized: {} plugin(s) found", discovered.len());

    tauri::Builder::default()
        .manage(ModelState {
            session: std::sync::Arc::new(std::sync::Mutex::new(None)),
            inference_cache: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            response_cache: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            prefetch_tasks: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
        })
        .manage(OcrState {
            backend: std::sync::Arc::new(std::sync::Mutex::new(None)),
            model_root: std::sync::Arc::new(std::sync::Mutex::new(None)),
            ocr_cache: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        })
        .manage(GrobidEngineState {
            status: std::sync::Arc::new(std::sync::Mutex::new("uninitialized".to_string())),
            error_msg: std::sync::Arc::new(std::sync::Mutex::new(None)),
            cached_result: std::sync::Arc::new(std::sync::Mutex::new(None)),
            init_done: std::sync::Arc::new(std::sync::Condvar::new()),
        })
        .manage(settings_db)
        .manage(plugin_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            // Model & layout detection
            model::load_model,
            model::run_doclayout,
            model::download_onnx_model,
            // PDF processing
            pdf::get_pdf_paragraphs,
            pdf::get_pdf_text,
            pdf::render_page_preview,
            pdf::prefetch_document,
            pdf::render_pdf_thumbnails,
            pdf::extract_pdf_outline,
            pdf::extract_first_page_metadata,
            pdf::read_file_base64,
            pdf::export_annotated_pdf,
            // OCR
            commands::ocr::init_ocr,
            commands::ocr::run_ocr_region,
            commands::ocr::download_ocr_models,
            // Settings & DB
            commands::settings::db_get_all_settings,
            commands::settings::db_get_setting,
            commands::settings::db_set_setting,
            commands::settings::db_delete_setting,
            commands::settings::db_get_ai_config,
            commands::settings::db_set_ai_config,
            commands::settings::db_get_path,
            commands::settings::journal_ranking,
            commands::settings::reading_log_session,
            commands::settings::reading_get_report,
            commands::settings::annotation_save,
            commands::settings::annotation_load,
            commands::settings::annotation_delete,
            // Paper management
            commands::paper::paper_copy_to_managed,
            commands::paper::paper_save,
            commands::paper::paper_list,
            commands::paper::paper_delete,
            commands::paper::paper_get_managed_dir,
            commands::paper::paper_file_size,
            commands::paper::paper_rename,
            // Grobid
            commands::grobid::grobid_ensure_ready,
            commands::grobid::grobid_parse_document,
            commands::grobid::grobid_batch_parse,
            commands::grobid::grobid_save_ref_enrichment,
            commands::grobid::grobid_clear_cache,
            // Miscellaneous
            commands::misc::check_git,
            commands::misc::check_model_exists,
            commands::misc::save_fulltext_debug,
            commands::misc::split_sentences,
            // Plugin system
            plugin_host::plugin_list,
            plugin_host::plugin_get_manifest,
            plugin_host::plugin_emit_event,
            plugin_host::plugin_read_entry,
            plugin_host::plugin_register_builtin,
            plugin_host::plugin_install_from_zip,
            // v2 plugin APIs (permission-checked)
            plugin_host::plugin_get_full_pdf_text,
            plugin_host::plugin_extract_pdf_images,
            plugin_host::plugin_extract_pdf_images_lopdf,
            plugin_host::plugin_pdf_page_count,
            plugin_host::plugin_pdf_page_text,
            plugin_host::plugin_pdf_outline,
            plugin_host::plugin_pdf_search,
            plugin_host::plugin_pdf_info,
            plugin_host::plugin_extract_first_page_metadata,
            plugin_host::plugin_generate_pptx,
            plugin_host::plugin_convert_template_to_html,
            plugin_host::plugin_storage_get,
            plugin_host::plugin_storage_set,
            plugin_host::plugin_storage_delete,
            plugin_host::plugin_storage_list,
            plugin_host::plugin_query_papers,
            plugin_host::plugin_get_paper_metadata,
            plugin_host::plugin_update_paper_metadata,
            plugin_host::plugin_get_platform,
            plugin_host::plugin_get_app_version,
            plugin_host::plugin_get_app_version_public,
            plugin_host::plugin_write_file,
            plugin_host::plugin_read_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
