//! Grobid assets & lib DLL auto-download and extraction commands.

use std::{
    env,
    path::{Path, PathBuf},
};

use models_cat::asynchronous::ModelsCat;
use models_cat::Repo;
use tauri::{AppHandle, Emitter};

use super::{ModelDownloadProgress, TauriProgress};

const ASSET_REPO: &str = "cjc1887415157/asset";

fn exe_dir() -> PathBuf {
    env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Recursively search up to `max_depth` levels for a directory named `target`.
fn find_subdir_recursive(base: &Path, target: &str, max_depth: usize) -> bool {
    if max_depth == 0 {
        return false;
    }
    if let Ok(entries) = std::fs::read_dir(base) {
        for entry in entries.filter_map(|e| e.ok()) {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if entry.file_name() == target {
                    return true;
                }
                if find_subdir_recursive(&entry.path(), target, max_depth - 1) {
                    return true;
                }
            }
        }
    }
    false
}

/// Check if grobid assets and lib DLLs already exist in the exe directory.
fn check_assets_exist() -> bool {
    let dir = exe_dir();
    let grobid_ok = ["grobid_assets", "grobid-assets"]
        .iter()
        .any(|name| {
            let base = dir.join(name);
            base.exists() && find_subdir_recursive(&base, "runtime", 3)
        });
    let lib_ok = dir.join("lib").exists()
        && dir
            .join("lib")
            .read_dir()
            .ok()
            .map(|mut entries| {
                entries.any(|e| {
                    e.ok()
                        .map(|e| {
                            e.path()
                                .extension()
                                .map(|ext| ext == "dll")
                                .unwrap_or(false)
                        })
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);
    grobid_ok && lib_ok
}

/// Extract a zip file from raw bytes to the target directory.
///
/// If `wrap_in` is Some(name), the zip contents will be placed inside a
/// subdirectory with that name under `target_dir`. This handles zips that
/// contain the raw contents without a parent folder.
///
/// If `wrap_in` is None, the zip is extracted directly to `target_dir`
/// preserving the original directory structure from the zip.
fn extract_zip(data: &[u8], target_dir: &Path, wrap_in: Option<&str>) -> Result<usize, String> {
    let reader = std::io::Cursor::new(data);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("无法解析 ZIP 文件: {e}"))?;

    // Determine the extraction base
    let extract_base = if let Some(wrap_name) = wrap_in {
        // Caller explicitly wants contents wrapped in a subdirectory
        target_dir.join(wrap_name)
    } else {
        // Extract directly to target directory, preserving zip structure as-is
        target_dir.to_path_buf()
    };

    let mut extracted = 0usize;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("读取 ZIP 条目失败: {e}"))?;

        let entry_name = match file.enclosed_name() {
            Some(name) => name.to_path_buf(),
            None => continue,
        };

        if entry_name.as_os_str().is_empty() {
            continue;
        }

        let out_path = extract_base.join(&entry_name);

        if file.name().ends_with('/') {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("创建目录失败 {}: {e}", out_path.display()))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("创建父目录失败 {}: {e}", parent.display()))?;
            }
            let mut out_file = std::fs::File::create(&out_path)
                .map_err(|e| format!("创建文件失败 {}: {e}", out_path.display()))?;
            std::io::copy(&mut file, &mut out_file)
                .map_err(|e| format!("写入文件失败 {}: {e}", out_path.display()))?;
            extracted += 1;
        }
    }

    eprintln!(
        "[assets] extracted {} files to {}",
        extracted,
        extract_base.display()
    );
    Ok(extracted)
}

#[tauri::command]
pub(crate) async fn check_grobid_assets_exists() -> bool {
    check_assets_exist()
}

#[tauri::command]
pub(crate) async fn download_grobid_assets(app: AppHandle) -> Result<String, String> {
    let target_dir = exe_dir();
    eprintln!("[assets] target directory: {}", target_dir.display());

    let repo = Repo::new_model(ASSET_REPO);
    let mc = ModelsCat::new(repo);

    // List available files in the repo
    let all_files = mc
        .list_hub_files()
        .await
        .map_err(|e| format!("获取文件列表失败: {e}"))?;
    eprintln!("[assets] files in repo: {:?}", all_files);

    // Filter to zip files only
    let zip_files: Vec<String> = all_files.into_iter().filter(|f| f.ends_with(".zip")).collect();

    if zip_files.is_empty() {
        return Err("仓库中没有找到 ZIP 文件".to_string());
    }
    eprintln!("[assets] zip files to download: {:?}", zip_files);

    let total = zip_files.len() as u64;

    for (i, filename) in zip_files.iter().enumerate() {
        eprintln!("[assets] downloading {}/{}: {}", i + 1, total, filename);

        let _ = app.emit(
            "model-download-progress",
            ModelDownloadProgress {
                model_type: "grobid".to_string(),
                filename: filename.to_string(),
                current: (i + 1) as u64,
                total,
                progress: (i as f64 / total as f64) * 100.0,
                status: "downloading".to_string(),
                message: format!("下载 {} ({}/{})", filename, i + 1, total),
            },
        );

        let progress = TauriProgress {
            app: app.clone(),
            model_type: "grobid".to_string(),
        };
        mc.download_with_progress(filename, progress)
            .await
            .map_err(|e| format!("下载 {} 失败: {}", filename, e))?;

        // Find the downloaded file in cache
        let cache_dir = mc.repo().cache_dir();
        let temp_zip = target_dir.join(format!("{}.tmp", filename));
        let mut found_in_cache = false;
        for entry in walkdir::WalkDir::new(&cache_dir)
            .max_depth(10)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_file() && entry.file_name() == filename.as_str() {
                eprintln!("[assets] found in cache: {}", entry.path().display());
                std::fs::copy(entry.path(), &temp_zip)
                    .map_err(|e| format!("复制 ZIP 文件失败: {e}"))?;
                found_in_cache = true;
                break;
            }
        }

        if !found_in_cache || !temp_zip.exists() {
            return Err(format!(
                "下载的 ZIP 文件未在缓存中找到: {} (cache: {})",
                filename,
                cache_dir.display()
            ));
        }

        // Read zip data
        let data = std::fs::read(&temp_zip).map_err(|e| format!("读取 ZIP 文件失败: {e}"))?;
        eprintln!("[assets] zip file size: {} bytes", data.len());

        // Determine extraction strategy based on filename:
        // - grobid_assets.zip: check if it already has grobid_assets/ wrapper
        // - lib.zip: check if it already has lib/ wrapper
        // For both: preserve the wrapper structure as-is
        let wrap_name = {
            // Check zip contents to see if it already has the expected wrapper directory
            let expected_wrapper: Option<&str> = if filename.contains("grobid") {
                Some("grobid_assets")
            } else if filename.contains("lib") {
                Some("lib")
            } else {
                // Unknown zip, extract as-is
                None
            };

            if let Some(wrapper) = expected_wrapper {
                let has_wrapper = {
                    let reader = std::io::Cursor::new(&data);
                    if let Ok(mut archive) = zip::ZipArchive::new(reader) {
                        let names: Vec<String> = (0..archive.len())
                            .filter_map(|i| {
                                archive
                                    .by_index(i)
                                    .ok()
                                    .and_then(|f| {
                                        f.enclosed_name()
                                            .map(|p| p.to_string_lossy().to_string())
                                    })
                            })
                            .collect();
                        names.iter().any(|n| n.starts_with(wrapper))
                    } else {
                        false
                    }
                };

                if has_wrapper {
                    eprintln!(
                        "[assets] {} already contains {}/ wrapper, extracting directly",
                        filename, wrapper
                    );
                    None
                } else {
                    eprintln!(
                        "[assets] wrapping {} contents in {}/",
                        filename, wrapper
                    );
                    Some(wrapper)
                }
            } else {
                None
            }
        };

        let count = extract_zip(&data, &target_dir, wrap_name)?;

        // Clean up temp file
        let _ = std::fs::remove_file(&temp_zip);

        eprintln!("[assets] {} extracted ({} files)", filename, count);

        let pct = ((i + 1) as f64 / total as f64) * 100.0;
        let _ = app.emit(
            "model-download-progress",
            ModelDownloadProgress {
                model_type: "grobid".to_string(),
                filename: filename.to_string(),
                current: (i + 1) as u64,
                total,
                progress: pct,
                status: "file_completed".to_string(),
                message: format!("{} 解压完成 ({} 个文件)", filename, count),
            },
        );
    }

    // Log directory structure for debugging
    if let Ok(entries) = std::fs::read_dir(&target_dir) {
        let dirs: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        eprintln!("[assets] directories in target: {:?}", dirs);
    }

    // Verify extraction
    if !check_assets_exist() {
        let dir = exe_dir();
        eprintln!("[assets] verification failed - debugging info:");
        eprintln!("[assets] expected: grobid_assets/runtime directory and lib/*.dll files");
        eprintln!("[assets] target dir: {}", dir.display());

        for name in &["grobid_assets", "grobid-assets"] {
            let grobid_dir = dir.join(name);
            if grobid_dir.exists() {
                eprintln!("[assets] contents of {}:", grobid_dir.display());
                if let Ok(entries) = std::fs::read_dir(&grobid_dir) {
                    for entry in entries.filter_map(|e| e.ok()) {
                        let ft = entry
                            .file_type()
                            .map(|t| if t.is_dir() { "dir" } else { "file" })
                            .unwrap_or("?");
                        eprintln!("  [{}] {}", ft, entry.file_name().to_string_lossy());
                    }
                }
                // Check if runtime exists nested
                if find_subdir_recursive(&grobid_dir, "runtime", 3) {
                    eprintln!("[assets] found 'runtime' directory nested inside {}", name);
                } else {
                    eprintln!("[assets] 'runtime' directory NOT found inside {}", name);
                }
            } else {
                eprintln!("[assets] directory does not exist: {}", grobid_dir.display());
            }
        }

        let lib_dir = dir.join("lib");
        if lib_dir.exists() {
            eprintln!("[assets] lib/ directory exists");
            if let Ok(entries) = std::fs::read_dir(&lib_dir) {
                let dlls: Vec<String> = entries
                    .filter_map(|e| e.ok())
                    .filter(|e| {
                        e.path()
                            .extension()
                            .map(|ext| ext == "dll")
                            .unwrap_or(false)
                    })
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect();
                eprintln!("[assets] DLLs in lib/: {:?}", dlls);
            }
        } else {
            eprintln!("[assets] lib/ directory does not exist");
        }

        let msg = format!(
            "下载完成但资源校验失败：grobid_assets/runtime 或 lib/*.dll 未找到，请查看控制台日志",
        );
        eprintln!("[assets] verification failed: {}", msg);

        let _ = app.emit(
            "model-download-progress",
            ModelDownloadProgress {
                model_type: "grobid".to_string(),
                filename: String::new(),
                current: 0,
                total: 0,
                progress: 0.0,
                status: "error".to_string(),
                message: msg.clone(),
            },
        );
        return Err(msg);
    }

    let _ = app.emit(
        "model-download-progress",
        ModelDownloadProgress {
            model_type: "grobid".to_string(),
            filename: String::new(),
            current: 0,
            total: 0,
            progress: 100.0,
            status: "completed".to_string(),
            message: "Grobid 资源下载完成".to_string(),
        },
    );

    Ok(target_dir.to_string_lossy().to_string())
}
