//! Paper library management commands.

use std::path::Path;
use tauri::State;

use crate::settings_db::{get_papers_dir, PaperRecord, SettingsDb};

#[tauri::command]
pub(crate) fn paper_copy_to_managed(source_path: String, _paper_id: String) -> Result<String, String> {
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

#[tauri::command]
pub(crate) fn paper_save(paper: PaperRecord, db: State<'_, SettingsDb>) -> Result<(), String> {
    db.upsert_paper(&paper).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn paper_list(db: State<'_, SettingsDb>) -> Result<Vec<PaperRecord>, String> {
    db.list_papers().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn paper_delete(id: String, db: State<'_, SettingsDb>) -> Result<(), String> {
    let managed_path = db
        .get_paper_managed_path(&id)
        .map_err(|e| e.to_string())?;

    db.delete_paper(&id).map_err(|e| e.to_string())?;

    if let Some(mp) = managed_path {
        let p = Path::new(&mp);
        if p.exists() {
            let _ = std::fs::remove_file(p);
        }
    }

    Ok(())
}

#[tauri::command]
pub(crate) fn paper_get_managed_dir() -> Result<String, String> {
    Ok(get_papers_dir().to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn paper_file_size(file_path: String) -> Result<i64, String> {
    let p = Path::new(&file_path);
    if !p.exists() {
        return Err(format!("File not found: {}", file_path));
    }
    p.metadata()
        .map(|m| m.len() as i64)
        .map_err(|e| format!("Failed to get file size: {e}"))
}

#[tauri::command]
pub(crate) fn paper_rename(old_path: String, new_title: String) -> Result<String, String> {
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

    let sanitized: String = new_title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .collect();
    let sanitized = sanitized.trim().to_string();
    if sanitized.is_empty() {
        return Ok(old_path);
    }

    let new_name = if ext.is_empty() {
        sanitized.clone()
    } else {
        format!("{}.{}", sanitized, ext)
    };
    let new_path = parent.join(&new_name);

    if old == new_path {
        return Ok(new_path.to_string_lossy().to_string());
    }

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
