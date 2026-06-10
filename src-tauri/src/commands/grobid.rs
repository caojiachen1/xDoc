//! Grobid academic paper parsing engine — types, state, commands, and helpers.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

// ── Grobid output types ────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GrobidAuthorOutput {
    pub first_name: Option<String>,
    pub middle_name: Option<String>,
    pub last_name: Option<String>,
    pub full_name: Option<String>,
    pub email: Option<String>,
    pub affiliation: Option<String>,
    pub identifier: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GrobidDateOutput {
    pub year: Option<String>,
    pub month: Option<String>,
    pub day: Option<String>,
    pub raw: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GrobidVenueOutput {
    pub name: Option<String>,
    pub volume: Option<String>,
    pub issue: Option<String>,
    pub pages: Option<String>,
    pub publisher: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GrobidMetadataOutput {
    pub title: Option<String>,
    pub authors: Vec<GrobidAuthorOutput>,
    pub abstract_text: Option<String>,
    pub date: Option<GrobidDateOutput>,
    pub doi: Option<String>,
    pub venue: Option<GrobidVenueOutput>,
    pub keywords: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GrobidSectionOutput {
    pub title: Option<String>,
    pub level: u8,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GrobidFigureOutput {
    pub id: Option<String>,
    pub caption: Option<String>,
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GrobidTableOutput {
    pub id: Option<String>,
    pub caption: Option<String>,
    pub content: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GrobidEquationOutput {
    pub id: Option<String>,
    pub content: String,
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GrobidRefRankingCache {
    pub journal: String,
    pub zone: i32,
    pub is_top: bool,
    pub is_oa: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GrobidRefOutput {
    pub id: Option<String>,
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub year: Option<String>,
    pub month: Option<String>,
    pub day: Option<String>,
    pub date_raw: Option<String>,
    pub venue: Option<String>,
    pub volume: Option<String>,
    pub issue: Option<String>,
    pub pages: Option<String>,
    pub publisher: Option<String>,
    pub doi: Option<String>,
    pub raw: Option<String>,
    #[serde(default)]
    pub crossref_journal: Option<String>,
    #[serde(default)]
    pub crossref_abstract: Option<String>,
    #[serde(default)]
    pub crossref_doi: Option<String>,
    #[serde(default)]
    pub crossref_url: Option<String>,
    #[serde(default)]
    pub crossref_authors: Option<Vec<String>>,
    #[serde(default)]
    pub crossref_date: Option<String>,
    #[serde(default)]
    pub ranking: Option<GrobidRefRankingCache>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GrobidDocumentOutput {
    pub metadata: GrobidMetadataOutput,
    pub sections: Vec<GrobidSectionOutput>,
    pub figures: Vec<GrobidFigureOutput>,
    pub tables: Vec<GrobidTableOutput>,
    pub equations: Vec<GrobidEquationOutput>,
    pub references: Vec<GrobidRefOutput>,
}

// ── Grobid engine state ────────────────────────────────────────────────────

pub struct GrobidEngineState {
    pub status: Arc<Mutex<String>>,
    pub error_msg: Arc<Mutex<Option<String>>>,
    pub cached_result: Arc<Mutex<Option<(String, GrobidDocumentOutput)>>>,
    pub init_done: Arc<std::sync::Condvar>,
}

// ── Internal types ─────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct GrobidParseEvent {
    status: String,
    message: String,
    file_path: Option<String>,
    result: Option<GrobidDocumentOutput>,
    error: Option<String>,
}

// ── Shared helpers ─────────────────────────────────────────────────────────

pub(crate) fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else {
            std::fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

// ── Grobid JSON file cache helpers ─────────────────────────────────────────

fn grobid_cache_path(pdf_path: &Path) -> PathBuf {
    let stem = pdf_path.file_stem().unwrap_or_default().to_string_lossy();
    pdf_path.with_file_name(format!("{}.grobid.json", stem))
}

fn load_grobid_json_cache(pdf_path: &Path) -> Option<GrobidDocumentOutput> {
    let cache_path = grobid_cache_path(pdf_path);
    if !cache_path.exists() {
        eprintln!("[xDoc:grobid] JSON cache miss: {} (not found)", cache_path.display());
        return None;
    }
    match std::fs::read_to_string(&cache_path) {
        Ok(content) => match serde_json::from_str::<GrobidDocumentOutput>(&content) {
            Ok(doc) => {
                eprintln!(
                    "[xDoc:grobid] JSON cache HIT: {} ({} sections, {} refs)",
                    cache_path.display(),
                    doc.sections.len(),
                    doc.references.len()
                );
                Some(doc)
            }
            Err(e) => {
                eprintln!("[xDoc:grobid] JSON cache parse error: {e}");
                None
            }
        },
        Err(e) => {
            eprintln!("[xDoc:grobid] JSON cache read error: {e}");
            None
        }
    }
}

fn save_grobid_json_cache(pdf_path: &Path, result: &GrobidDocumentOutput) {
    let cache_path = grobid_cache_path(pdf_path);
    match serde_json::to_string_pretty(result) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&cache_path, json) {
                eprintln!(
                    "[xDoc:grobid] Failed to write JSON cache to {}: {e}",
                    cache_path.display()
                );
            } else {
                eprintln!("[xDoc:grobid] JSON cache saved to: {}", cache_path.display());
            }
        }
        Err(e) => {
            eprintln!("[xDoc:grobid] JSON cache serialize error: {e}");
        }
    }
}

// ── Structure extraction ───────────────────────────────────────────────────

fn extract_structure(
    path: &Path,
) -> (
    Vec<GrobidSectionOutput>,
    Vec<GrobidFigureOutput>,
    Vec<GrobidTableOutput>,
) {
    // Strategy 1: fulltext_to_structured
    eprintln!(
        "[xDoc:grobid] Strategy 1: calling fulltext_to_structured for {}",
        path.display()
    );
    match grobid_rs::fulltext_to_structured(path) {
        Ok(doc) => {
            let sections_count = doc
                .full_text
                .as_ref()
                .map(|ft| ft.sections.len())
                .unwrap_or(0);
            eprintln!(
                "[xDoc:grobid] Strategy 1 OK: full_text={}, sections={}, figures={}, tables={}",
                doc.full_text.is_some(),
                sections_count,
                doc.full_text.as_ref().map(|ft| ft.figures.len()).unwrap_or(0),
                doc.full_text.as_ref().map(|ft| ft.tables.len()).unwrap_or(0),
            );
            if let Some(ft) = &doc.full_text {
                for (i, sec) in ft.sections.iter().enumerate() {
                    eprintln!(
                        "[xDoc:grobid]   section[{}]: level={}, title={:?}, content_len={}, subsections={}",
                        i,
                        sec.level,
                        sec.title.as_deref().unwrap_or("(none)"),
                        sec.content.len(),
                        sec.subsections.len()
                    );
                }
                let sections = flatten_sections(&ft.sections);
                let figures: Vec<GrobidFigureOutput> = ft
                    .figures
                    .iter()
                    .map(|f| GrobidFigureOutput {
                        id: f.id.clone(),
                        caption: f.caption.clone(),
                        description: f.description.clone(),
                    })
                    .collect();
                let tables: Vec<GrobidTableOutput> = ft
                    .tables
                    .iter()
                    .map(|t| GrobidTableOutput {
                        id: t.id.clone(),
                        caption: t.caption.clone(),
                        content: t.content.clone(),
                    })
                    .collect();
                eprintln!(
                    "[xDoc:grobid] extracted: {} sections (flattened), {} figures, {} tables",
                    sections.len(),
                    figures.len(),
                    tables.len()
                );
                return (sections, figures, tables);
            } else {
                eprintln!("[xDoc:grobid] Strategy 1: full_text is None — trying fallback");
            }
        }
        Err(e) => {
            eprintln!("[xDoc:grobid] Strategy 1 FAILED: {e}");
        }
    }

    // Strategy 2: fulltext_to_tei → manual TEI XML parsing
    eprintln!(
        "[xDoc:grobid] Strategy 2: calling fulltext_to_tei for {}",
        path.display()
    );
    match grobid_rs::fulltext_to_tei(path) {
        Ok(tei_xml) => {
            eprintln!(
                "[xDoc:grobid] Strategy 2: got TEI XML ({} chars), doing manual parse",
                tei_xml.len()
            );
            let (sections, figures, tables) = parse_tei_xml_manual(&tei_xml);
            if !sections.is_empty() || !figures.is_empty() || !tables.is_empty() {
                eprintln!(
                    "[xDoc:grobid] Manual TEI parse: {} sections, {} figures, {} tables",
                    sections.len(),
                    figures.len(),
                    tables.len()
                );
                return (sections, figures, tables);
            }
            eprintln!("[xDoc:grobid] Manual TEI parse found nothing useful");
        }
        Err(e) => {
            eprintln!("[xDoc:grobid] Strategy 2: fulltext_to_tei FAILED: {e}");
        }
    }

    eprintln!("[xDoc:grobid] All structure extraction strategies failed → empty structure");
    (Vec::new(), Vec::new(), Vec::new())
}

fn flatten_sections(sections: &[grobid_rs::Section]) -> Vec<GrobidSectionOutput> {
    let mut result = Vec::new();
    for sec in sections {
        result.push(GrobidSectionOutput {
            title: sec.title.clone(),
            level: sec.level,
            content: sec.content.clone(),
        });
        if !sec.subsections.is_empty() {
            result.extend(flatten_sections(&sec.subsections));
        }
    }
    result
}

// ── Manual TEI XML parser ──────────────────────────────────────────────────

fn parse_tei_xml_manual(
    tei_xml: &str,
) -> (
    Vec<GrobidSectionOutput>,
    Vec<GrobidFigureOutput>,
    Vec<GrobidTableOutput>,
) {
    use regex::Regex;

    let mut sections = Vec::new();
    let mut figures = Vec::new();
    let mut tables = Vec::new();

    let body_re = Regex::new(r"(?is)<body[^>]*>(.*?)</body>").ok();
    let body = body_re
        .and_then(|re| re.captures(tei_xml))
        .map(|caps| caps.get(1).map(|m| m.as_str()).unwrap_or(""))
        .unwrap_or(tei_xml);

    let div_re = Regex::new(r"(?is)<div\b[^>]*>(.*?)</div>").ok();
    let head_re = Regex::new(r"(?is)<head\b[^>]*>(.*?)</head>").ok();
    let p_re = Regex::new(r"(?is)<p\b[^>]*>(.*?)</p>").ok();
    let tag_re = Regex::new(r"<[^>]+>").ok();

    if let Some(div_regex) = &div_re {
        for cap in div_regex.captures_iter(body) {
            let div_content = cap.get(1).map(|m| m.as_str()).unwrap_or("");

            let title = head_re.as_ref().and_then(|re| {
                re.captures(div_content).and_then(|c| c.get(1)).map(|m| {
                    let raw = m.as_str();
                    tag_re
                        .as_ref()
                        .map(|tr| tr.replace_all(raw, "").trim().to_string())
                        .unwrap_or(raw.to_string())
                })
            });

            let mut para_texts: Vec<String> = Vec::new();
            if let Some(p_regex) = &p_re {
                for p_cap in p_regex.captures_iter(div_content) {
                    let raw = p_cap.get(1).map(|m| m.as_str()).unwrap_or("");
                    let clean = tag_re
                        .as_ref()
                        .map(|tr| tr.replace_all(raw, "").trim().to_string())
                        .unwrap_or(raw.to_string());
                    if !clean.is_empty() {
                        para_texts.push(clean);
                    }
                }
            }

            let content = para_texts.join(" ");
            if title.is_some() || !content.is_empty() {
                sections.push(GrobidSectionOutput {
                    title,
                    level: 1,
                    content: if content.len() > 2000 {
                        content[..2000].to_string()
                    } else {
                        content
                    },
                });
            }
        }
    }

    for sec in sections.iter_mut() {
        if let Some(ref title_text) = sec.title {
            let trimmed = title_text.trim();
            if trimmed
                .chars()
                .next()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
            {
                let dot_count = trimmed
                    .chars()
                    .take_while(|c| c.is_ascii_digit() || *c == '.')
                    .filter(|c| *c == '.')
                    .count();
                sec.level = (dot_count + 1).min(6) as u8;
            }
        }
    }

    // Extract figures
    let figure_re =
        Regex::new(r#"(?is)<figure\b[^>]*type\s*=\s*"figure"[^>]*>(.*?)</figure>"#).ok();
    let figdesc_re = Regex::new(r"(?is)<figDesc\b[^>]*>(.*?)</figDesc>").ok();
    let label_re = Regex::new(r"(?is)<label\b[^>]*>(.*?)</label>").ok();

    if let Some(f_re) = &figure_re {
        for cap in f_re.captures_iter(body) {
            let fig_content = cap.get(1).map(|m| m.as_str()).unwrap_or("");

            let caption = figdesc_re.as_ref().and_then(|re| {
                re.captures(fig_content).and_then(|c| c.get(1)).map(|m| {
                    let raw = m.as_str();
                    tag_re
                        .as_ref()
                        .map(|tr| tr.replace_all(raw, "").trim().to_string())
                        .unwrap_or(raw.to_string())
                })
            });

            let label = label_re.as_ref().and_then(|re| {
                re.captures(fig_content).and_then(|c| c.get(1)).map(|m| {
                    let raw = m.as_str();
                    tag_re
                        .as_ref()
                        .map(|tr| tr.replace_all(raw, "").trim().to_string())
                        .unwrap_or(raw.to_string())
                })
            });

            let id = Regex::new(r#"xml:id\s*=\s*"([^"]+)""#)
                .ok()
                .and_then(|re| {
                    re.captures(fig_content)
                        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
                });

            figures.push(GrobidFigureOutput {
                id: id.or(label),
                caption,
                description: None,
            });
        }
    }

    if figures.is_empty() {
        let generic_fig_re = Regex::new(r"(?is)<figure\b[^>]*>(.*?)</figure>").ok();
        if let Some(f_re) = &generic_fig_re {
            for cap in f_re.captures_iter(body) {
                let fig_content = cap.get(1).map(|m| m.as_str()).unwrap_or("");
                if fig_content.contains("type=\"table\"") || fig_content.contains("type='table'") {
                    continue;
                }
                let caption = figdesc_re.as_ref().and_then(|re| {
                    re.captures(fig_content).and_then(|c| c.get(1)).map(|m| {
                        let raw = m.as_str();
                        tag_re
                            .as_ref()
                            .map(|tr| tr.replace_all(raw, "").trim().to_string())
                            .unwrap_or(raw.to_string())
                    })
                });
                let label = label_re.as_ref().and_then(|re| {
                    re.captures(fig_content).and_then(|c| c.get(1)).map(|m| {
                        let raw = m.as_str();
                        tag_re
                            .as_ref()
                            .map(|tr| tr.replace_all(raw, "").trim().to_string())
                            .unwrap_or(raw.to_string())
                    })
                });
                if caption.is_some() || label.is_some() {
                    let id = Regex::new(r#"xml:id\s*=\s*"([^"]+)""#)
                        .ok()
                        .and_then(|re| {
                            re.captures(fig_content)
                                .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
                        });
                    figures.push(GrobidFigureOutput {
                        id: id.or(label),
                        caption,
                        description: None,
                    });
                }
            }
        }
    }

    // Extract tables
    let table_re =
        Regex::new(r#"(?is)<figure\b[^>]*type\s*=\s*"table"[^>]*>(.*?)</figure>"#).ok();
    if let Some(t_re) = &table_re {
        for cap in t_re.captures_iter(body) {
            let tbl_content = cap.get(1).map(|m| m.as_str()).unwrap_or("");

            let caption = figdesc_re.as_ref().and_then(|re| {
                re.captures(tbl_content).and_then(|c| c.get(1)).map(|m| {
                    let raw = m.as_str();
                    tag_re
                        .as_ref()
                        .map(|tr| tr.replace_all(raw, "").trim().to_string())
                        .unwrap_or(raw.to_string())
                })
            });

            let label = label_re.as_ref().and_then(|re| {
                re.captures(tbl_content).and_then(|c| c.get(1)).map(|m| {
                    let raw = m.as_str();
                    tag_re
                        .as_ref()
                        .map(|tr| tr.replace_all(raw, "").trim().to_string())
                        .unwrap_or(raw.to_string())
                })
            });

            let id = Regex::new(r#"xml:id\s*=\s*"([^"]+)""#)
                .ok()
                .and_then(|re| {
                    re.captures(tbl_content)
                        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
                });

            tables.push(GrobidTableOutput {
                id: id.or(label),
                caption,
                content: None,
            });
        }
    }

    if tables.is_empty() {
        let generic_table_re = Regex::new(r"(?is)<table\b[^>]*>(.*?)</table>").ok();
        if let Some(t_re) = &generic_table_re {
            for (idx, cap) in t_re.captures_iter(body).enumerate() {
                let tbl_content = cap.get(1).map(|m| m.as_str()).unwrap_or("");
                let caption = figdesc_re.as_ref().and_then(|re| {
                    re.captures(tbl_content).and_then(|c| c.get(1)).map(|m| {
                        let raw = m.as_str();
                        tag_re
                            .as_ref()
                            .map(|tr| tr.replace_all(raw, "").trim().to_string())
                            .unwrap_or(raw.to_string())
                    })
                });
                tables.push(GrobidTableOutput {
                    id: Some(format!("T{}", idx + 1)),
                    caption,
                    content: None,
                });
            }
        }
    }

    eprintln!(
        "[xDoc:grobid] manual TEI parse: {} sections, {} figures, {} tables",
        sections.len(),
        figures.len(),
        tables.len()
    );

    (sections, figures, tables)
}

// ── Condvar helper ─────────────────────────────────────────────────────────

fn wait_for_grobid_done(
    status: Arc<Mutex<String>>,
    init_done: Arc<std::sync::Condvar>,
    timeout_secs: u64,
) -> Result<String, String> {
    let guard = status.lock().unwrap();
    let (guard, timeout_result) = init_done
        .wait_timeout_while(
            guard,
            std::time::Duration::from_secs(timeout_secs),
            |s| *s == "initializing" || *s == "uninitialized",
        )
        .map_err(|_| "Timed out waiting for Grobid engine initialization".to_string())?;
    if timeout_result.timed_out() {
        return Err("Timed out waiting for Grobid engine initialization".to_string());
    }
    let status_str = guard.clone();
    drop(guard);
    if status_str == "ready" {
        Ok(status_str)
    } else if status_str == "error" {
        Err("Grobid engine initialization failed".to_string())
    } else {
        Err(format!(
            "Grobid engine in unexpected state: {status_str}"
        ))
    }
}

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn grobid_ensure_ready(
    state: State<'_, GrobidEngineState>,
) -> Result<String, String> {
    let should_init = {
        let mut guard = state.status.lock().unwrap();
        match guard.as_str() {
            "ready" => return Ok("ready".to_string()),
            "error" => {
                let err = state
                    .error_msg
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| "unknown error".to_string());
                return Err(format!(
                    "Grobid engine previously failed to initialize: {err}"
                ));
            }
            "initializing" | "uninitialized" => {
                if *guard == "initializing" {
                    false
                } else {
                    *guard = "initializing".to_string();
                    true
                }
            }
            other => {
                return Err(format!("Grobid engine in unexpected state: {other}"));
            }
        }
    };

    if !should_init {
        eprintln!("[xDoc:grobid] ensure_ready: init already in progress, waiting…");
        let status_arc = state.status.clone();
        let init_done = state.init_done.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            wait_for_grobid_done(status_arc, init_done, 300)
        })
        .await
        .map_err(|e| format!("spawn_blocking failed: {e}"))?;
    }

    let dev_path = PathBuf::from(env!("GROBID_RS_ASSETS_PATH"));
    let base_path = if dev_path.join("runtime").exists() {
        dev_path
    } else {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_default();
        ["grobid-assets", "grobid_assets", "grobid-0.9.1"]
            .iter()
            .map(|name| exe_dir.join(name))
            .find(|p| p.join("runtime").exists())
            .unwrap_or(dev_path)
    };
    let status_arc = state.status.clone();
    let error_arc = state.error_msg.clone();
    let init_done = state.init_done.clone();

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let grobid_dir = base_path.join("grobid");
        let runtime_dir = base_path.join("runtime");

        if !runtime_dir.exists() {
            return Err(format!(
                "Grobid runtime directory not found: {}",
                runtime_dir.display()
            ));
        }

        let grobid_home_dst = grobid_dir.join("grobid-home");
        if !grobid_home_dst.join("models").exists() {
            let grobid_home_src = base_path.join("grobid-home");
            if grobid_home_src.exists() {
                std::fs::create_dir_all(&grobid_dir)
                    .map_err(|e| format!("Failed to create grobid dir: {e}"))?;
                copy_dir_recursive(&grobid_home_src, &grobid_home_dst)
                    .map_err(|e| format!("Failed to copy grobid-home: {e}"))?;
            }
        }

        let jar_name = "grobid-core-0.9.1-onejar.jar";
        let expected_jar = grobid_dir.join("grobid-core/build/libs").join(jar_name);
        if !expected_jar.exists() {
            let src_jar = base_path.join(jar_name);
            if src_jar.exists() {
                let jar_dir = expected_jar.parent().unwrap();
                std::fs::create_dir_all(jar_dir)
                    .map_err(|e| format!("Failed to create JAR directory: {e}"))?;
                std::fs::copy(&src_jar, &expected_jar)
                    .map_err(|e| format!("Failed to copy JAR: {e}"))?;
            }
        }

        let config = grobid_rs::GrobidConfig::builder()
            .base_path(&base_path)
            .build();

        match grobid_rs::init(&config) {
            Ok(()) => Ok(()),
            Err(e) => Err(format!("Grobid init failed: {e}")),
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"));

    let final_result = match result {
        Ok(Ok(())) => {
            *status_arc.lock().unwrap() = "ready".to_string();
            Ok("ready".to_string())
        }
        Ok(Err(e)) => {
            *status_arc.lock().unwrap() = "error".to_string();
            *error_arc.lock().unwrap() = Some(e.clone());
            Err(e)
        }
        Err(e) => {
            *status_arc.lock().unwrap() = "error".to_string();
            *error_arc.lock().unwrap() = Some(e.clone());
            Err(e)
        }
    };
    init_done.notify_all();
    final_result
}

#[tauri::command]
pub(crate) async fn grobid_parse_document(
    app: AppHandle,
    file_path: String,
    force: Option<bool>,
    structure_only: Option<bool>,
    state: State<'_, GrobidEngineState>,
) -> Result<GrobidDocumentOutput, String> {
    let force_reparse = force.unwrap_or(false);
    let structure_only = structure_only.unwrap_or(false);

    // Structure-only re-parse
    if structure_only {
        let cached = state.cached_result.lock().unwrap().clone();
        if let Some((ref cached_path, ref cached_doc)) = cached {
            if cached_path == &file_path {
                let path = PathBuf::from(&file_path);
                let app_clone = app.clone();

                let _ = app.emit(
                    "grobid-parse-event",
                    GrobidParseEvent {
                        status: "parsing".to_string(),
                        message: "正在重新解析文档结构…".to_string(),
                        file_path: Some(file_path.clone()),
                        result: None,
                        error: None,
                    },
                );

                let cached_meta = cached_doc.metadata.clone();
                let cached_refs = cached_doc.references.clone();
                let cached_result_arc = state.cached_result.clone();

                let parse_result =
                    tauri::async_runtime::spawn_blocking(
                        move || -> Result<GrobidDocumentOutput, String> {
                            eprintln!(
                                "[xDoc:grobid] structure_only re-parse for {}",
                                path.display()
                            );
                            let (sections, figures, tables) = extract_structure(&path);

                            Ok(GrobidDocumentOutput {
                                metadata: cached_meta,
                                sections,
                                figures,
                                tables,
                                equations: Vec::new(),
                                references: cached_refs,
                            })
                        },
                    )
                    .await
                    .map_err(|e| format!("spawn_blocking failed: {e}"))?;

                match parse_result {
                    Ok(result) => {
                        *cached_result_arc.lock().unwrap() =
                            Some((file_path.clone(), result.clone()));
                        let pdf_path = PathBuf::from(&file_path);
                        save_grobid_json_cache(&pdf_path, &result);
                        let _ = app_clone.emit(
                            "grobid-parse-event",
                            GrobidParseEvent {
                                status: "completed".to_string(),
                                message: format!(
                                    "结构重解析完成: {} 章节, {} 图片, {} 表格",
                                    result.sections.len(),
                                    result.figures.len(),
                                    result.tables.len()
                                ),
                                file_path: Some(file_path.clone()),
                                result: Some(result.clone()),
                                error: None,
                            },
                        );
                        return Ok(result);
                    }
                    Err(e) => {
                        let _ = app_clone.emit(
                            "grobid-parse-event",
                            GrobidParseEvent {
                                status: "error".to_string(),
                                message: format!("结构重解析失败: {e}"),
                                file_path: Some(file_path.clone()),
                                result: None,
                                error: Some(e.clone()),
                            },
                        );
                        return Err(e);
                    }
                }
            }
        }
        eprintln!(
            "[xDoc:grobid] structure_only requested but no cache for {}, doing full parse",
            file_path
        );
    }

    // Check caches
    let mut cached_meta_opt: Option<GrobidMetadataOutput> = None;
    let mut cached_refs_opt: Option<Vec<GrobidRefOutput>> = None;
    let mut cached_sections_opt: Option<Vec<GrobidSectionOutput>> = None;
    let mut cached_figures_opt: Option<Vec<GrobidFigureOutput>> = None;
    let mut cached_tables_opt: Option<Vec<GrobidTableOutput>> = None;
    let mut need_structure = true;
    let mut need_references = true;

    if !force_reparse {
        let mem_cached = {
            let guard = state.cached_result.lock().unwrap();
            if let Some((ref p, ref r)) = *guard {
                if p == &file_path {
                    eprintln!("[xDoc:grobid] in-memory cache HIT for {}", file_path);
                    Some(r.clone())
                } else {
                    eprintln!(
                        "[xDoc:grobid] in-memory cache MISS (cached={}, requested={})",
                        p, file_path
                    );
                    None
                }
            } else {
                None
            }
        };
        let file_cached = if mem_cached.is_none() {
            load_grobid_json_cache(&PathBuf::from(&file_path))
        } else {
            None
        };

        if let Some(doc) = mem_cached.or(file_cached) {
            let has_sections = !doc.sections.is_empty();
            let has_references = !doc.references.is_empty();

            if has_sections && has_references {
                eprintln!("[xDoc:grobid] using complete cache for {}", file_path);
                *state.cached_result.lock().unwrap() = Some((file_path.clone(), doc.clone()));
                let _ = app.emit(
                    "grobid-parse-event",
                    GrobidParseEvent {
                        status: "completed".to_string(),
                        message: "使用缓存结果".to_string(),
                        file_path: Some(file_path.clone()),
                        result: Some(doc.clone()),
                        error: None,
                    },
                );
                return Ok(doc);
            }

            need_structure = !has_sections;
            need_references = !has_references;
            eprintln!(
                "[xDoc:grobid] partial cache for {} (sections={}, refs={}), will re-parse missing parts",
                file_path,
                if has_sections { "ok" } else { "MISSING" },
                if has_references { "ok" } else { "MISSING" }
            );
            cached_meta_opt = Some(doc.metadata);
            if has_sections {
                cached_sections_opt = Some(doc.sections);
                cached_figures_opt = Some(doc.figures);
                cached_tables_opt = Some(doc.tables);
            }
            if has_references {
                cached_refs_opt = Some(doc.references);
            }
        } else {
            eprintln!(
                "[xDoc:grobid] no cache found for {}, will do full parse",
                file_path
            );
        }
    }

    // Ensure engine is ready
    let status = { state.status.lock().unwrap().clone() };
    if status != "ready" {
        let _ = app.emit(
            "grobid-parse-event",
            GrobidParseEvent {
                status: "initializing".to_string(),
                message: "正在初始化 Grobid 引擎…".to_string(),
                file_path: Some(file_path.clone()),
                result: None,
                error: None,
            },
        );

        if let Err(e) = grobid_ensure_ready(state.clone()).await {
            let _ = app.emit(
                "grobid-parse-event",
                GrobidParseEvent {
                    status: "error".to_string(),
                    message: format!("引擎初始化失败: {e}"),
                    file_path: Some(file_path.clone()),
                    result: None,
                    error: Some(e.clone()),
                },
            );
            return Err(e);
        }
    }

    let parse_desc = if need_structure && need_references {
        "正在重新解析结构和参考文献…".to_string()
    } else if need_structure {
        "正在重新解析文档结构…".to_string()
    } else if need_references {
        "正在重新解析参考文献…".to_string()
    } else {
        "正在解析 PDF…".to_string()
    };
    let _ = app.emit(
        "grobid-parse-event",
        GrobidParseEvent {
            status: "parsing".to_string(),
            message: parse_desc,
            file_path: Some(file_path.clone()),
            result: None,
            error: None,
        },
    );

    let path = PathBuf::from(&file_path);
    let app_clone = app.clone();
    let cached_result_arc = state.cached_result.clone();

    let parse_result = tauri::async_runtime::spawn_blocking(move || -> Result<GrobidDocumentOutput, String> {
        let (sections, figures, tables) = if need_structure {
            eprintln!("[xDoc:grobid] re-parsing structure (sections missing from cache)");
            extract_structure(&path)
        } else {
            eprintln!("[xDoc:grobid] using cached sections, skipping structure re-parse");
            (
                cached_sections_opt.unwrap_or_default(),
                cached_figures_opt.unwrap_or_default(),
                cached_tables_opt.unwrap_or_default(),
            )
        };

        let metadata = if cached_meta_opt.is_some() {
            eprintln!("[xDoc:grobid] using cached metadata, skipping header re-parse");
            cached_meta_opt.clone().unwrap()
        } else {
            match grobid_rs::process_header_structured(&path) {
                Ok(meta) => GrobidMetadataOutput {
                    title: meta.title.clone(),
                    authors: meta
                        .authors
                        .iter()
                        .map(|a| GrobidAuthorOutput {
                            first_name: a.first_name.clone(),
                            middle_name: a.middle_name.clone(),
                            last_name: a.last_name.clone(),
                            full_name: a.full_name.clone(),
                            email: a.email.clone(),
                            affiliation: a.affiliation.clone(),
                            identifier: a.identifier.clone(),
                        })
                        .collect(),
                    abstract_text: meta.abstract_text.clone(),
                    date: meta.date.as_ref().map(|d| GrobidDateOutput {
                        year: d.year.clone(),
                        month: d.month.clone(),
                        day: d.day.clone(),
                        raw: d.raw.clone(),
                    }),
                    doi: meta.doi.clone(),
                    venue: meta.venue.as_ref().map(|v| GrobidVenueOutput {
                        name: v.name.clone(),
                        volume: v.volume.clone(),
                        issue: v.issue.clone(),
                        pages: v.pages.clone(),
                        publisher: v.publisher.clone(),
                    }),
                    keywords: meta.keywords.clone(),
                },
                Err(e) => {
                    eprintln!("[xDoc:grobid] header parsing failed: {e}");
                    GrobidMetadataOutput {
                        title: None,
                        authors: Vec::new(),
                        abstract_text: None,
                        date: None,
                        doi: None,
                        venue: None,
                        keywords: Vec::new(),
                    }
                }
            }
        };

        let references = if !need_references {
            eprintln!("[xDoc:grobid] using cached references, skipping references re-parse");
            cached_refs_opt.unwrap_or_default()
        } else {
            eprintln!("[xDoc:grobid] re-parsing references (missing from cache)");
            match grobid_rs::process_references_structured(&path) {
                Ok(refs) => refs
                    .iter()
                    .map(|r| GrobidRefOutput {
                        id: r.id.clone(),
                        title: r.title.clone(),
                        authors: r.authors.clone(),
                        year: r.date.as_ref().and_then(|d| d.year.clone()),
                        month: r.date.as_ref().and_then(|d| d.month.clone()),
                        day: r.date.as_ref().and_then(|d| d.day.clone()),
                        date_raw: r.date.as_ref().and_then(|d| d.raw.clone()),
                        venue: r.venue.clone(),
                        volume: r.volume.clone(),
                        issue: r.issue.clone(),
                        pages: r.pages.clone(),
                        publisher: r.publisher.clone(),
                        doi: r.doi.clone(),
                        raw: r.raw.clone(),
                        crossref_journal: None,
                        crossref_abstract: None,
                        crossref_doi: None,
                        crossref_url: None,
                        crossref_authors: None,
                        crossref_date: None,
                        ranking: None,
                    })
                    .collect(),
                Err(e) => {
                    eprintln!("[xDoc:grobid] references parsing failed: {e}");
                    cached_refs_opt.unwrap_or_default()
                }
            }
        };

        Ok(GrobidDocumentOutput {
            metadata,
            sections,
            figures,
            tables,
            equations: Vec::new(),
            references,
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?;

    match parse_result {
        Ok(result) => {
            *cached_result_arc.lock().unwrap() = Some((file_path.clone(), result.clone()));
            let pdf_path = PathBuf::from(&file_path);
            save_grobid_json_cache(&pdf_path, &result);

            let _ = app_clone.emit(
                "grobid-parse-event",
                GrobidParseEvent {
                    status: "completed".to_string(),
                    message: format!(
                        "解析完成: {} 条参考文献, {} 章节",
                        result.references.len(),
                        result.sections.len()
                    ),
                    file_path: Some(file_path.clone()),
                    result: Some(result.clone()),
                    error: None,
                },
            );
            Ok(result)
        }
        Err(e) => {
            let _ = app_clone.emit(
                "grobid-parse-event",
                GrobidParseEvent {
                    status: "error".to_string(),
                    message: format!("解析失败: {e}"),
                    file_path: Some(file_path.clone()),
                    result: None,
                    error: Some(e.clone()),
                },
            );
            Err(e)
        }
    }
}

#[tauri::command]
pub(crate) async fn grobid_batch_parse(
    app: AppHandle,
    paths: Vec<String>,
    state: State<'_, GrobidEngineState>,
) -> Result<Vec<String>, String> {
    eprintln!("[xDoc:grobid] batch parse: {} files", paths.len());

    if let Err(e) = grobid_ensure_ready(state.clone()).await {
        eprintln!("[xDoc:grobid] batch: engine init failed: {e}");
        for file_path in &paths {
            let _ = app.emit(
                "grobid-parse-event",
                GrobidParseEvent {
                    status: "error".to_string(),
                    message: format!("引擎初始化失败: {e}"),
                    file_path: Some(file_path.clone()),
                    result: None,
                    error: Some(e.clone()),
                },
            );
        }
        return Err(e);
    }

    let mut parsed_paths = Vec::new();

    for file_path in &paths {
        match grobid_parse_document(
            app.clone(),
            file_path.clone(),
            Some(false),
            Some(false),
            state.clone(),
        )
        .await
        {
            Ok(_) => {
                parsed_paths.push(file_path.clone());
            }
            Err(e) => {
                eprintln!("[xDoc:grobid] batch: failed to parse {}: {}", file_path, e);
                let _ = app.emit(
                    "grobid-parse-event",
                    GrobidParseEvent {
                        status: "error".to_string(),
                        message: format!("解析失败: {}", e),
                        file_path: Some(file_path.clone()),
                        result: None,
                        error: Some(e),
                    },
                );
            }
        }
    }

    eprintln!(
        "[xDoc:grobid] batch parse done: {}/{} succeeded",
        parsed_paths.len(),
        paths.len()
    );
    Ok(parsed_paths)
}

#[tauri::command]
pub(crate) async fn grobid_save_ref_enrichment(
    file_path: String,
    ref_index: usize,
    crossref_journal: Option<String>,
    crossref_abstract: Option<String>,
    crossref_doi: Option<String>,
    crossref_url: Option<String>,
    crossref_authors: Option<Vec<String>>,
    crossref_date: Option<String>,
    ranking_journal: Option<String>,
    ranking_zone: Option<i32>,
    ranking_is_top: Option<bool>,
    ranking_is_oa: Option<bool>,
) -> Result<(), String> {
    let pdf_path = PathBuf::from(&file_path);
    let cache_path = grobid_cache_path(&pdf_path);

    let mut doc =
        load_grobid_json_cache(&pdf_path).ok_or_else(|| "No cache file found".to_string())?;

    if ref_index < doc.references.len() {
        let r = &mut doc.references[ref_index];
        if let Some(v) = crossref_journal {
            r.crossref_journal = Some(v);
        }
        if let Some(v) = crossref_abstract {
            r.crossref_abstract = Some(v);
        }
        if let Some(v) = crossref_doi {
            r.crossref_doi = Some(v);
        }
        if let Some(v) = crossref_url {
            r.crossref_url = Some(v);
        }
        if let Some(v) = crossref_authors {
            r.crossref_authors = Some(v);
        }
        if let Some(v) = crossref_date {
            r.crossref_date = Some(v);
        }
        if let (Some(journal), Some(zone)) = (ranking_journal, ranking_zone) {
            r.ranking = Some(GrobidRefRankingCache {
                journal,
                zone,
                is_top: ranking_is_top.unwrap_or(false),
                is_oa: ranking_is_oa.unwrap_or(false),
            });
        }
    } else {
        return Err(format!(
            "ref_index {} out of range (refs: {})",
            ref_index,
            doc.references.len()
        ));
    }

    save_grobid_json_cache(&pdf_path, &doc);
    eprintln!(
        "[xDoc:grobid] saved enrichment for ref {} in {}",
        ref_index,
        cache_path.display()
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn grobid_clear_cache(
    file_path: String,
    state: State<'_, GrobidEngineState>,
) -> Result<(), String> {
    let pdf_path = PathBuf::from(&file_path);
    let cache_path = grobid_cache_path(&pdf_path);
    if cache_path.exists() {
        std::fs::remove_file(&cache_path)
            .map_err(|e| format!("Failed to delete cache file: {e}"))?;
        eprintln!("[xDoc:grobid] deleted JSON cache: {}", cache_path.display());
    }
    *state.cached_result.lock().unwrap() = None;
    Ok(())
}
