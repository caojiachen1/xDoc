use anyhow::Result;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, State};

use crate::pptx_gen::SlideData;

/// Plugin manifest
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub min_app_version: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub permissions: Vec<String>,
    pub entry: PluginEntry,
    pub activation: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PluginEntry {
    /// Main entry point (sidecar binary or shell script path)
    pub main: Option<String>,
    /// Optional: HTML file to render a web panel
    pub renderer: Option<String>,
}

/// Registered extension points
#[derive(Default)]
#[allow(dead_code)]
pub struct ExtensionRegistry {
    /// plugin_id -> Vec<extension_point_name>
    pub hooks: Mutex<HashMap<String, Vec<String>>>,
}

/// Plugin manager state
#[allow(dead_code)]
pub struct PluginState {
    /// Installed plugin manifests
    pub manifests: Mutex<HashMap<String, PluginManifest>>,
    /// Plugin data directory: {app_data}/plugins/
    pub plugins_dir: PathBuf,
    /// Extension point registry
    pub registry: ExtensionRegistry,
}

impl PluginState {
    pub fn new(app_data_dir: &Path) -> Self {
        let plugins_dir = app_data_dir.join("plugins");
        fs::create_dir_all(&plugins_dir).ok();
        Self {
            manifests: Mutex::new(HashMap::new()),
            plugins_dir,
            registry: ExtensionRegistry::default(),
        }
    }

    /// Scan all plugins under plugins_dir
    pub fn scan_plugins(&self) -> Vec<String> {
        let mut ids = Vec::new();
        let mut manifests = self.manifests.lock();

        let entries = match fs::read_dir(&self.plugins_dir) {
            Ok(e) => e,
            Err(_) => return ids,
        };

        for entry in entries.flatten() {
            let plugin_dir = entry.path();
            if !plugin_dir.is_dir() {
                continue;
            }
            let manifest_path = plugin_dir.join("plugin.json");
            if !manifest_path.exists() {
                continue;
            }
            match fs::read_to_string(&manifest_path) {
                Ok(content) => match serde_json::from_str::<PluginManifest>(&content) {
                    Ok(manifest) => {
                        let id = manifest.id.clone();
                        manifests.insert(id.clone(), manifest);
                        ids.push(id);
                    }
                    Err(e) => {
                        eprintln!("[plugin_host] invalid manifest at {:?}: {e}", manifest_path);
                    }
                },
                Err(e) => {
                    eprintln!("[plugin_host] failed to read {:?}: {e}", manifest_path);
                }
            }
        }
        ids
    }

    /// Check if a plugin has a given permission
    pub fn has_permission(&self, plugin_id: &str, permission: &str) -> bool {
        self.manifests
            .lock()
            .get(plugin_id)
            .map(|m| m.permissions.iter().any(|p| p == permission))
            .unwrap_or(false)
    }

    /// Read plugin entry file content (for frontend dynamic loading)
    pub fn read_entry(&self, plugin_id: &str, entry_path: &str) -> Result<String, String> {
        let plugin_dir = self.plugins_dir.join(plugin_id);
        let full_path = plugin_dir.join(entry_path);

        if !full_path.exists() {
            return Err(format!("Entry file not found: {}", full_path.display()));
        }

        fs::read_to_string(&full_path)
            .map_err(|e| format!("Failed to read entry: {e}"))
    }
}

// ── Tauri Commands ──────────────────────────────────────

#[tauri::command]
pub fn plugin_list(state: State<'_, PluginState>) -> Vec<PluginManifest> {
    state.manifests.lock().values().cloned().collect()
}

#[tauri::command]
pub fn plugin_get_manifest(
    plugin_id: String,
    state: State<'_, PluginState>,
) -> Result<PluginManifest, String> {
    state
        .manifests
        .lock()
        .get(&plugin_id)
        .cloned()
        .ok_or_else(|| format!("Plugin '{}' not found", plugin_id))
}

#[tauri::command]
pub fn plugin_emit_event(
    app: AppHandle,
    event: String,
    payload: String,
) -> Result<(), String> {
    let _ = app.emit(&event, payload)
        .map_err(|e| format!("Failed to emit event: {e}"));
    Ok(())
}

/// Read plugin entry file (for frontend dynamic loading of external plugin code)
#[tauri::command]
pub fn plugin_read_entry(
    plugin_id: String,
    entry_path: String,
    state: State<'_, PluginState>,
) -> Result<String, String> {
    state.read_entry(&plugin_id, &entry_path)
}

/// Core API provided to plugins: get the full PDF text
#[tauri::command]
pub async fn get_full_pdf_text(file_path: String) -> Result<String, String> {
    crate::get_full_pdf_text(&file_path)
}

/// Extract embedded images from PDF (paper figures)
/// Returns: Vec<{ page_index, image_base64 }>
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PdfImageInfo {
    pub page_index: u32,
    pub image_base64: String,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn extract_pdf_images(
    file_path: String,
    page_indices: Option<Vec<u32>>,
) -> Result<Vec<PdfImageInfo>, String> {
    crate::extract_pdf_images(&file_path, page_indices.as_deref())
}

/// Extract images via lopdf directly from PDF dictionaries (fallback)
/// Tries this when pdfium extraction fails; handles Gray/CMYK/Indexed color spaces more accurately
#[tauri::command]
pub async fn extract_pdf_images_lopdf(
    file_path: String,
    page_indices: Option<Vec<u32>>,
) -> Result<Vec<PdfImageInfo>, String> {
    crate::extract_pdf_images_with_lopdf(&file_path, page_indices.as_deref())
}

/// Generate a PPTX file
#[tauri::command]
pub async fn generate_pptx(
    output_path: String,
    title: String,
    slides: Vec<SlideData>,
    template_path: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::pptx_gen::generate_pptx(
            &output_path,
            &title,
            &slides,
            template_path.as_deref(),
        )
        .map_err(|e| format!("PPTX generation failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?
}

/// Convert a PPTX template to HTML (via pptx2html-core)
/// Returns a complete HTML string for template preview or as a content overlay background
#[tauri::command]
pub async fn convert_template_to_html(template_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&template_path);
        pptx2html_core::convert_file(path)
            .map_err(|e| format!("Template-to-HTML conversion failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?
}

/// Install a plugin from a zip file
/// The zip must contain a top-level directory (the plugin directory) with plugin.json inside
#[tauri::command]
pub async fn plugin_install_from_zip(
    zip_path: String,
    state: State<'_, PluginState>,
) -> Result<String, String> {
    use std::io::Read;

    let zip_bytes = fs::read(&zip_path)
        .map_err(|e| format!("Failed to read zip file: {e}"))?;

    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("Invalid zip file: {e}"))?;

    // Find the top-level directory name containing plugin.json
    let mut plugin_dir_name: Option<String> = None;
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name().to_string();
            if name.ends_with("/plugin.json") || name.contains("/plugin.json") {
                // Extract the top-level directory name
                if let Some(slash_pos) = name.find('/') {
                    let dir = &name[..slash_pos];
                    plugin_dir_name = Some(dir.to_string());
                    break;
                }
            }
        }
    }

    // If plugin.json is at root level (no subdirectory), use the zip filename
    let install_name = plugin_dir_name.unwrap_or_else(|| {
        Path::new(&zip_path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown-plugin".to_string())
    });

    let install_dir = state.plugins_dir.join(&install_name);
    fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create plugin dir: {e}"))?;

    // Extract all files
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;
        let name = entry.name().to_string();

        // Skip directory entries
        if name.ends_with('/') {
            continue;
        }

        // Strip top-level directory prefix, put directly under install_dir
        let relative_path = if let Some(slash_pos) = name.find('/') {
            &name[slash_pos + 1..]
        } else {
            &name
        };

        if relative_path.is_empty() {
            continue;
        }

        let target_path = install_dir.join(relative_path);

        // Ensure parent directory exists
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).ok();
        }

        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read entry {name}: {e}"))?;
        fs::write(&target_path, &buf)
            .map_err(|e| format!("Failed to write {relative_path}: {e}"))?;
    }

    // Verify plugin.json exists
    let manifest_path = install_dir.join("plugin.json");
    if !manifest_path.exists() {
        return Err("plugin.json not found in zip, please verify the plugin package format".to_string());
    }

    // Rescan plugins
    state.scan_plugins();

    Ok(install_name)
}
