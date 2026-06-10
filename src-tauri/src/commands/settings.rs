//! Settings database, reading session, annotation, and journal ranking commands.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::settings_db::{AiConfig, AnnotationRecord, JournalRanking, SettingEntry, SettingsDb};

// ── Settings CRUD ──────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) fn db_get_all_settings(db: State<'_, SettingsDb>) -> Result<Vec<SettingEntry>, String> {
    db.get_all().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn db_get_setting(key: String, db: State<'_, SettingsDb>) -> Result<Option<String>, String> {
    db.get(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn db_set_setting(key: String, value: String, db: State<'_, SettingsDb>) -> Result<(), String> {
    db.set(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn db_delete_setting(key: String, db: State<'_, SettingsDb>) -> Result<(), String> {
    db.delete(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn db_get_ai_config(db: State<'_, SettingsDb>) -> Result<AiConfig, String> {
    let vendor = db.get("llm.vendor").map_err(|e| e.to_string())?.unwrap_or_default();
    let base_url = db.get("llm.baseUrl").map_err(|e| e.to_string())?.unwrap_or_default();
    let model = db.get("llm.model").map_err(|e| e.to_string())?.unwrap_or_default();
    let vendor_api_keys = db.get_vendor_api_keys().map_err(|e| e.to_string())?;
    Ok(AiConfig {
        vendor,
        vendor_api_keys,
        base_url,
        model,
    })
}

#[tauri::command]
pub(crate) fn db_set_ai_config(config: AiConfig, db: State<'_, SettingsDb>) -> Result<(), String> {
    if !config.vendor.is_empty() {
        db.set("llm.vendor", &config.vendor).map_err(|e| e.to_string())?;
    } else {
        db.delete("llm.vendor").map_err(|e| e.to_string())?;
    }
    if !config.base_url.is_empty() {
        db.set("llm.baseUrl", &config.base_url).map_err(|e| e.to_string())?;
    } else {
        db.delete("llm.baseUrl").map_err(|e| e.to_string())?;
    }
    if !config.model.is_empty() {
        db.set("llm.model", &config.model).map_err(|e| e.to_string())?;
    } else {
        db.delete("llm.model").map_err(|e| e.to_string())?;
    }
    db.set_vendor_api_keys(&config.vendor_api_keys)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn db_get_path(db: State<'_, SettingsDb>) -> Result<String, String> {
    Ok(db.path.to_string_lossy().to_string())
}

// ── Journal ranking ────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) fn journal_ranking(
    journal_name: String,
    db: State<'_, SettingsDb>,
) -> Result<Option<JournalRanking>, String> {
    db.lookup_journal_ranking(&journal_name)
        .map_err(|e| e.to_string())
}

// ── Reading sessions ───────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct ReadingSessionRequest {
    pub paper_id: String,
    pub paper_name: String,
    pub start_time: String,
    pub end_time: String,
    pub duration_seconds: i64,
}

#[derive(Serialize)]
pub struct ReadingReportResponse {
    pub total_seconds: i64,
    pub ranking: Vec<PaperReadingRank>,
    pub daily: Vec<DailyReading>,
    pub hourly: Vec<HourlyReading>,
}

#[derive(Serialize)]
pub struct PaperReadingRank {
    pub paper_id: String,
    pub paper_name: String,
    pub total_seconds: i64,
}

#[derive(Serialize)]
pub struct DailyReading {
    pub date: String,
    pub total_seconds: i64,
}

#[derive(Serialize)]
pub struct HourlyReading {
    pub hour: i32,
    pub total_seconds: i64,
}

#[tauri::command]
pub(crate) fn reading_log_session(
    req: ReadingSessionRequest,
    db: State<'_, SettingsDb>,
) -> Result<(), String> {
    if req.duration_seconds < 5 {
        return Ok(());
    }
    db.log_reading_session(
        &req.paper_id,
        &req.paper_name,
        &req.start_time,
        &req.end_time,
        req.duration_seconds,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn reading_get_report(db: State<'_, SettingsDb>) -> Result<ReadingReportResponse, String> {
    let total_seconds = db.get_total_reading_seconds().map_err(|e| e.to_string())?;
    let ranking = db
        .get_paper_reading_ranking(20)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(paper_id, paper_name, total_seconds)| PaperReadingRank {
            paper_id,
            paper_name,
            total_seconds,
        })
        .collect();
    let daily = db
        .get_daily_reading_distribution(30)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(date, total_seconds)| DailyReading { date, total_seconds })
        .collect();
    let hourly = db
        .get_hourly_reading_distribution()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(hour, total_seconds)| HourlyReading { hour, total_seconds })
        .collect();
    Ok(ReadingReportResponse {
        total_seconds,
        ranking,
        daily,
        hourly,
    })
}

// ── Annotation persistence ─────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct AnnotationSaveRequest {
    pub file_path: String,
    pub page_index: i32,
    pub shapes_json: String,
}

#[tauri::command]
pub(crate) fn annotation_save(
    req: AnnotationSaveRequest,
    db: State<'_, SettingsDb>,
) -> Result<(), String> {
    db.save_annotations(&req.file_path, req.page_index, &req.shapes_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn annotation_load(
    file_path: String,
    db: State<'_, SettingsDb>,
) -> Result<Vec<AnnotationRecord>, String> {
    db.load_annotations(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn annotation_delete(
    file_path: String,
    db: State<'_, SettingsDb>,
) -> Result<(), String> {
    db.delete_annotations(&file_path).map_err(|e| e.to_string())
}
