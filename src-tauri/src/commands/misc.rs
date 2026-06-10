//! Miscellaneous Tauri commands that don't fit into other domains.

use std::path::Path;

use super::resolve_model_path;

#[tauri::command]
pub(crate) async fn check_git() -> Result<bool, String> {
    match std::process::Command::new("git").arg("--version").output() {
        Ok(output) => Ok(output.status.success()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub(crate) async fn check_model_exists(model_path: String) -> bool {
    resolve_model_path(&model_path).exists()
}

#[tauri::command]
pub(crate) fn save_fulltext_debug(text: String) -> Result<String, String> {
    let path = std::env::temp_dir().join("xdoc_fulltext_debug.txt");
    std::fs::write(&path, &text).map_err(|e| format!("Failed to write: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn split_sentences(text: String, language: String) -> Vec<String> {
    sentencex::segment(&language, &text)
        .into_iter()
        .map(|s| s.to_string())
        .collect()
}

/// Get the full PDF text (concatenated text from all pages).
/// Called by the plugin system (plugin_host delegates here).
pub fn get_full_pdf_text(file_path: &str) -> Result<String, String> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }

    let bindings = super::bind_pdfium_with_candidates()?;
    let pdfium = pdfium_render::prelude::Pdfium::new(bindings);
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("Failed to open PDF: {e}"))?;

    let page_count = document.pages().len();
    let mut full_text = String::new();

    for page_idx in 0..page_count {
        if let Ok(page) = document.pages().get(page_idx as u16) {
            if let Some(text) = page.text().ok() {
                let page_text = text.all();
                if !page_text.trim().is_empty() {
                    if !full_text.is_empty() {
                        full_text.push_str("\n\n");
                    }
                    full_text.push_str(&format!("[Page {}]\n", page_idx + 1));
                    full_text.push_str(&page_text);
                }
            }
        }
    }

    Ok(full_text)
}
