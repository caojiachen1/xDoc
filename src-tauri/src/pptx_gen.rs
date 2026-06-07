//! PPTX generation module (based on ppt-rs library)
//!
//! Two modes:
//! 1. Template mode: load a user-provided .pptx template and append new slides
//! 2. Built-in mode: generate a clean academic-style PPTX from scratch
//!
//! Each slide type has a different layout:
//! - title: text only (title, authors, journal, etc.)
//! - overview / methods / conclusion: text-heavy, optional image
//! - characterization / electrochemical / other: image-heavy with caption text

use anyhow::{anyhow, Result};
use ppt_rs::api::Presentation;
use ppt_rs::generator::{create_pptx_with_content, SlideContent, SlideLayout};
use ppt_rs::generator::{BulletPoint, BulletTextFormat};
use serde::{Deserialize, Serialize};
use std::path::Path;

// ── Public data structures ─────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SlideData {
    pub title: String,
    #[serde(default)]
    pub bullets: Vec<String>,
    /// Optional: base64-encoded image (embedded in the slide)
    #[serde(default)]
    pub image_base64: Option<String>,
    /// Slide type (affects layout)
    #[serde(default)]
    pub slide_type: Option<String>,
}

// ── Entry point ─────────────────────────────────────────────────

/// Generate a PPTX file
pub fn generate_pptx(
    output_path: &str,
    title: &str,
    slides: &[SlideData],
    template_path: Option<&str>,
) -> Result<()> {
    if let Some(tmpl) = template_path {
        if Path::new(tmpl).exists() {
            return generate_from_template(output_path, title, slides, tmpl);
        }
        eprintln!("[pptx_gen] Template not found at {tmpl}, falling back to built-in style");
    }
    generate_builtin(output_path, title, slides)
}

// ═══════════════════════════════════════════════════════════
//  Mode 1: Template mode (load .pptx, append new slides)
// ═══════════════════════════════════════════════════════════

fn generate_from_template(
    output_path: &str,
    _title: &str,
    slides: &[SlideData],
    template_path: &str,
) -> Result<()> {
    let mut pres = Presentation::from_path(template_path)
        .map_err(|e| anyhow!("Failed to load template: {e}"))?;

    for slide_data in slides {
        let content = build_slide_content(slide_data);
        pres = pres.add_slide(content);
    }

    pres.save(output_path)
        .map_err(|e| anyhow!("Failed to save PPTX: {e}"))?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════
//  Mode 2: Built-in mode (generate academic-style PPTX from scratch)
// ═══════════════════════════════════════════════════════════

fn generate_builtin(output_path: &str, title: &str, slides: &[SlideData]) -> Result<()> {
    let slide_contents: Vec<SlideContent> = slides
        .iter()
        .map(|s| build_slide_content(s))
        .collect();

    let pptx_bytes = create_pptx_with_content(title, slide_contents)
        .map_err(|e| anyhow!("Failed to create PPTX: {e}"))?;

    std::fs::write(output_path, pptx_bytes)
        .map_err(|e| anyhow!("Failed to write file: {e}"))?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════
//  Slide content construction (layout based on slide_type)
// ═══════════════════════════════════════════════════════════

fn build_slide_content(slide: &SlideData) -> SlideContent {
    let slide_type = slide.slide_type.as_deref().unwrap_or("overview");

    let mut content = match slide_type {
        "title" => {
            // Title page: centered layout
            SlideContent::new(&slide.title).layout(SlideLayout::CenteredTitle)
        }
        _ => SlideContent::new(&slide.title),
    };

    // Unified SimSun 18pt: title and content use same font
    content = content.title_size(18).content_size(18);

    // SimSun 18pt text format
    let text_fmt = BulletTextFormat::new()
        .font_size(18)
        .font_family("宋体");

    // Add bullet points (all using SimSun 18pt)
    for bullet in &slide.bullets {
        let bp = BulletPoint::new(bullet).with_format(text_fmt.clone());
        content.bullets.push(bp);
    }

    content
}

// ═══════════════════════════════════════════════════════════
//  Utility functions
// ═══════════════════════════════════════════════════════════

/// Strip data URI prefix from a base64 string (kept for use by other modules)
#[allow(dead_code)]
fn strip_data_uri_prefix(input: &str) -> &str {
    if let Some(pos) = input.find(',') {
        &input[pos + 1..]
    } else {
        input
    }
}

/// Convert inches to EMU (kept for use by other modules)
#[allow(dead_code)]
fn inches(n: f64) -> u32 {
    (n * 914_400.0) as u32
}
