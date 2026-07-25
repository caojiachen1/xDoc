//! Markdown -> Word (.docx) converter for OCR document export.
//!
//! Produces a WordprocessingML document by hand (writing the OOXML zip
//! directly) so we can emit native, editable Word equations (OMML) and
//! embedded images — neither of which the `docx-rs` crate can generate.
//!
//! Handles the subset of Markdown produced by end-to-end OCR models:
//! headings, paragraphs, `**bold**`, bullet lists, Markdown pipe tables,
//! HTML `<table>` blocks, inline math (`$...$`, `\(...\)`), display math
//! (`$$...$$`, `\[...\]`) and images referenced as `![](xdoc-img://N)`.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;

use image::GenericImageView;
use regex::Regex;
use zip::write::FileOptions;

use crate::latex_omml::latex_to_omml;

const NS_W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_M: &str = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const NS_WP: &str =
    "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_PIC: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";

const EMU_PER_PX: i64 = 9525;
const MAX_CONTENT_WIDTH_EMU: i64 = 5_486_400; // ~6 inches

/// Convert a Markdown string to a .docx file at `output_path`.
///
/// `images` holds PNG-encoded image bytes; markdown placeholders of the form
/// `![](xdoc-img://N)` reference `images[N]`.
pub fn markdown_to_docx(
    markdown: &str,
    images: &[Vec<u8>],
    output_path: &Path,
) -> Result<(), String> {
    let mut b = DocBuilder::new(images);

    static TABLE_RE: OnceLock<Regex> = OnceLock::new();
    let table_re = TABLE_RE.get_or_init(|| Regex::new(r"(?is)<table.*?</table>").unwrap());

    let mut last = 0usize;
    for mat in table_re.find_iter(markdown) {
        if mat.start() > last {
            b.add_markdown_segment(&markdown[last..mat.start()]);
        }
        b.add_html_table(&markdown[mat.start()..mat.end()]);
        last = mat.end();
    }
    if last < markdown.len() {
        b.add_markdown_segment(&markdown[last..]);
    }

    b.write_to(output_path)
}

struct DocBuilder<'a> {
    images: &'a [Vec<u8>],
    body: String,
    rels: Vec<(String, String)>, // (rId, target)
    media: Vec<(String, Vec<u8>)>, // (filename, bytes)
    img_map: HashMap<usize, String>, // image index -> rId
    next_rid: usize,
    next_docpr: usize,
}

impl<'a> DocBuilder<'a> {
    fn new(images: &'a [Vec<u8>]) -> Self {
        DocBuilder {
            images,
            body: String::new(),
            rels: Vec::new(),
            media: Vec::new(),
            img_map: HashMap::new(),
            next_rid: 1,
            next_docpr: 1,
        }
    }

    // -- Segment handling ---------------------------------------------------

    /// Split out display-math blocks, then process the remaining text lines.
    fn add_markdown_segment(&mut self, text: &str) {
        static MATH_RE: OnceLock<Regex> = OnceLock::new();
        let math_re = MATH_RE
            .get_or_init(|| Regex::new(r"(?s)\$\$(.+?)\$\$|\\\[(.+?)\\\]").unwrap());

        let mut last = 0usize;
        for caps in math_re.captures_iter(text) {
            let m = caps.get(0).unwrap();
            if m.start() > last {
                self.process_lines(&text[last..m.start()]);
            }
            let latex = caps
                .get(1)
                .or_else(|| caps.get(2))
                .map(|g| g.as_str())
                .unwrap_or("");
            self.add_display_math(latex);
            last = m.end();
        }
        if last < text.len() {
            self.process_lines(&text[last..]);
        }
    }

    /// Process plain Markdown text line by line.
    fn process_lines(&mut self, text: &str) {
        let lines: Vec<&str> = text.lines().collect();
        let mut i = 0;
        while i < lines.len() {
            let trimmed = lines[i].trim();
            if trimmed.is_empty() {
                i += 1;
                continue;
            }

            // Horizontal rule / page separator -> empty paragraph.
            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                self.body.push_str("<w:p/>");
                i += 1;
                continue;
            }

            // Markdown pipe table (header followed by a separator row).
            if trimmed.starts_with('|')
                && i + 1 < lines.len()
                && is_separator_row(lines[i + 1])
            {
                let mut rows = vec![parse_pipe_row(trimmed)];
                i += 2;
                while i < lines.len() && lines[i].trim().starts_with('|') {
                    rows.push(parse_pipe_row(lines[i].trim()));
                    i += 1;
                }
                self.add_table(rows);
                continue;
            }

            // Heading (# .. ######).
            if let Some((level, content)) = parse_heading(trimmed) {
                let sz = match level {
                    1 => 36,
                    2 => 30,
                    3 => 26,
                    _ => 24,
                };
                let mut runs = String::new();
                self.render_inline(content, &mut runs, Some(sz), true);
                self.body.push_str("<w:p><w:pPr><w:spacing w:before=\"160\" w:after=\"80\"/></w:pPr>");
                self.body.push_str(&runs);
                self.body.push_str("</w:p>");
                i += 1;
                continue;
            }

            // Bullet list item.
            if let Some(content) = parse_list_item(trimmed) {
                let mut runs = String::new();
                append_run(&mut runs, "\u{2022} ", false, None);
                self.render_inline(content, &mut runs, None, false);
                self.body
                    .push_str("<w:p><w:pPr><w:ind w:left=\"360\"/></w:pPr>");
                self.body.push_str(&runs);
                self.body.push_str("</w:p>");
                i += 1;
                continue;
            }

            // Plain paragraph.
            let mut runs = String::new();
            self.render_inline(trimmed, &mut runs, None, false);
            self.body.push_str("<w:p>");
            self.body.push_str(&runs);
            self.body.push_str("</w:p>");
            i += 1;
        }
    }

    /// Emit a centered display equation paragraph.
    fn add_display_math(&mut self, latex: &str) {
        let latex = latex.trim();
        if latex.is_empty() {
            return;
        }
        let omml = latex_to_omml(latex);
        self.body.push_str("<w:p><m:oMathPara>");
        self.body.push_str(&omml);
        self.body.push_str("</m:oMathPara></w:p>");
    }

    // -- Inline rendering ---------------------------------------------------

    /// Render inline content (text, bold, inline math, images) into runs.
    fn render_inline(
        &mut self,
        text: &str,
        out: &mut String,
        heading_sz: Option<u32>,
        heading_bold: bool,
    ) {
        let chars: Vec<char> = text.chars().collect();
        let len = chars.len();
        let mut i = 0;
        let mut buf = String::new();

        macro_rules! flush {
            () => {
                if !buf.is_empty() {
                    append_bold_runs(out, &buf, heading_bold, heading_sz);
                    buf.clear();
                }
            };
        }

        while i < len {
            // Skip HTML <img ...> tags (OCR models may emit these; handled upstream)
            if chars[i] == '<' && i + 4 < len && chars[i + 1] == 'i' && chars[i + 2] == 'm' && chars[i + 3] == 'g' && (chars[i + 4] == ' ' || chars[i + 4] == '/') {
                if let Some(close) = find_char(&chars, i, '>') {
                    flush!();
                    i = close + 1;
                    continue;
                }
            }
            // Image: ![alt](xdoc-img://N) or ![alt](url)
            if chars[i] == '!' && i + 1 < len && chars[i + 1] == '[' {
                if let Some((url, end)) = parse_image_ref(&chars, i) {
                    flush!();
                    self.emit_image(&url, out);
                    i = end;
                    continue;
                }
            }
            // Inline math: $...$
            if chars[i] == '$' {
                if let Some(close) = find_char(&chars, i + 1, '$') {
                    if close > i + 1 {
                        let latex: String = chars[i + 1..close].iter().collect();
                        flush!();
                        out.push_str(&latex_to_omml(&latex));
                        i = close + 1;
                        continue;
                    }
                }
            }
            // Inline math: \( ... \)
            if chars[i] == '\\' && i + 1 < len && chars[i + 1] == '(' {
                if let Some(close) = find_seq(&chars, i + 2, '\\', ')') {
                    let latex: String = chars[i + 2..close].iter().collect();
                    flush!();
                    out.push_str(&latex_to_omml(&latex));
                    i = close + 2;
                    continue;
                }
            }
            buf.push(chars[i]);
            i += 1;
        }
        flush!();
    }

    /// Resolve an image reference URL and emit an inline drawing run.
    fn emit_image(&mut self, url: &str, out: &mut String) {
        let idx = url
            .strip_prefix("xdoc-img://")
            .and_then(|s| s.trim().parse::<usize>().ok());
        let idx = match idx {
            Some(i) if i < self.images.len() => i,
            _ => return, // unknown / external image: skip silently
        };
        let bytes = self.images[idx].clone();
        let (cx, cy) = image_extent(&bytes);
        let rid = self.image_rid(idx, bytes);
        let doc_pr = self.next_docpr;
        self.next_docpr += 1;

        out.push_str("<w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">");
        out.push_str(&format!("<wp:extent cx=\"{cx}\" cy=\"{cy}\"/>"));
        out.push_str("<wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/>");
        out.push_str(&format!(
            "<wp:docPr id=\"{doc_pr}\" name=\"Picture {doc_pr}\"/>"
        ));
        out.push_str("<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a=\"");
        out.push_str(NS_A);
        out.push_str("\" noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>");
        out.push_str("<a:graphic xmlns:a=\"");
        out.push_str(NS_A);
        out.push_str("\"><a:graphicData uri=\"");
        out.push_str(NS_PIC);
        out.push_str("\"><pic:pic xmlns:pic=\"");
        out.push_str(NS_PIC);
        out.push_str("\"><pic:nvPicPr>");
        out.push_str(&format!(
            "<pic:cNvPr id=\"{doc_pr}\" name=\"Picture {doc_pr}\"/><pic:cNvPicPr/></pic:nvPicPr>"
        ));
        out.push_str("<pic:blipFill><a:blip r:embed=\"");
        out.push_str(&rid);
        out.push_str("\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>");
        out.push_str("<pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/>");
        out.push_str(&format!("<a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>"));
        out.push_str("<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr>");
        out.push_str("</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>");
    }

    /// Register an image, returning its relationship id (dedup by index).
    fn image_rid(&mut self, idx: usize, bytes: Vec<u8>) -> String {
        if let Some(rid) = self.img_map.get(&idx) {
            return rid.clone();
        }
        let n = self.media.len() + 1;
        let filename = format!("image{n}.png");
        let rid = format!("rId{}", self.next_rid);
        self.next_rid += 1;
        self.rels.push((rid.clone(), format!("media/{filename}")));
        self.media.push((filename, bytes));
        self.img_map.insert(idx, rid.clone());
        rid
    }

    // -- Tables -------------------------------------------------------------

    fn add_table(&mut self, rows: Vec<Vec<String>>) {
        let cols = rows.iter().map(|r| r.len()).max().unwrap_or(1).max(1);
        self.body.push_str("<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/>");
        self.body.push_str("<w:tblBorders>");
        for edge in ["top", "left", "bottom", "right", "insideH", "insideV"] {
            self.body.push_str(&format!(
                "<w:{edge} w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>"
            ));
        }
        self.body.push_str("</w:tblBorders></w:tblPr>");
        for cells in rows {
            self.body.push_str("<w:tr>");
            for c in 0..cols {
                let text = cells.get(c).cloned().unwrap_or_default();
                self.body
                    .push_str("<w:tc><w:tcPr><w:tcW w:w=\"0\" w:type=\"auto\"/></w:tcPr><w:p>");
                let mut runs = String::new();
                self.render_inline(&text, &mut runs, None, false);
                self.body.push_str(&runs);
                self.body.push_str("</w:p></w:tc>");
            }
            self.body.push_str("</w:tr>");
        }
        self.body.push_str("</w:tbl>");
        // Empty paragraph after table (Word requirement to avoid corruption).
        self.body.push_str("<w:p/>");
    }

    /// Parse an HTML `<table>...</table>` block into a Word table.
    fn add_html_table(&mut self, html: &str) {
        static ROW_RE: OnceLock<Regex> = OnceLock::new();
        static CELL_RE: OnceLock<Regex> = OnceLock::new();
        let row_re = ROW_RE.get_or_init(|| Regex::new(r"(?is)<tr[^>]*>(.*?)</tr>").unwrap());
        let cell_re =
            CELL_RE.get_or_init(|| Regex::new(r"(?is)<t[dh][^>]*>(.*?)</t[dh]>").unwrap());

        let mut rows: Vec<Vec<String>> = Vec::new();
        for rc in row_re.captures_iter(html) {
            let mut cells: Vec<String> = Vec::new();
            for cc in cell_re.captures_iter(&rc[1]) {
                cells.push(strip_html(&cc[1]));
            }
            if !cells.is_empty() {
                rows.push(cells);
            }
        }
        if !rows.is_empty() {
            self.add_table(rows);
        }
    }

    // -- Packaging ----------------------------------------------------------

    fn write_to(self, output_path: &Path) -> Result<(), String> {
        let file = std::fs::File::create(output_path)
            .map_err(|e| format!("创建文件失败: {e}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let opts: FileOptions =
            FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        let write_part = |zip: &mut zip::ZipWriter<std::fs::File>,
                          name: &str,
                          data: &[u8]|
         -> Result<(), String> {
            zip.start_file(name, opts)
                .map_err(|e| format!("写入 {name} 失败: {e}"))?;
            zip.write_all(data)
                .map_err(|e| format!("写入 {name} 内容失败: {e}"))?;
            Ok(())
        };

        write_part(&mut zip, "[Content_Types].xml", content_types_xml().as_bytes())?;
        write_part(&mut zip, "_rels/.rels", root_rels_xml().as_bytes())?;
        write_part(&mut zip, "word/document.xml", self.document_xml().as_bytes())?;
        write_part(
            &mut zip,
            "word/_rels/document.xml.rels",
            self.document_rels_xml().as_bytes(),
        )?;
        for (filename, bytes) in &self.media {
            write_part(&mut zip, &format!("word/media/{filename}"), bytes)?;
        }

        zip.finish().map_err(|e| format!("生成 docx 失败: {e}"))?;
        Ok(())
    }

    fn document_xml(&self) -> String {
        let mut s = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>");
        s.push_str(&format!(
            "<w:document xmlns:w=\"{NS_W}\" xmlns:r=\"{NS_R}\" xmlns:m=\"{NS_M}\" xmlns:wp=\"{NS_WP}\" xmlns:a=\"{NS_A}\" xmlns:pic=\"{NS_PIC}\">"
        ));
        s.push_str("<w:body>");
        s.push_str(&self.body);
        s.push_str(
            "<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/></w:sectPr>",
        );
        s.push_str("</w:body></w:document>");
        s
    }

    fn document_rels_xml(&self) -> String {
        let mut s = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>");
        s.push_str(
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        );
        for (rid, target) in &self.rels {
            s.push_str(&format!(
                "<Relationship Id=\"{rid}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"{target}\"/>"
            ));
        }
        s.push_str("</Relationships>");
        s
    }
}

// ---------------------------------------------------------------------------
// Static package parts
// ---------------------------------------------------------------------------

fn content_types_xml() -> String {
    String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Default Extension=\"png\" ContentType=\"image/png\"/>\
<Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/>\
<Default Extension=\"jpg\" ContentType=\"image/jpeg\"/>\
<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
</Types>",
    )
}

fn root_rels_xml() -> String {
    String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>\
</Relationships>",
    )
}

// ---------------------------------------------------------------------------
// Run helpers
// ---------------------------------------------------------------------------

/// Append `**bold**`-aware text runs.
fn append_bold_runs(out: &mut String, text: &str, base_bold: bool, sz: Option<u32>) {
    for (idx, seg) in text.split("**").enumerate() {
        if seg.is_empty() {
            continue;
        }
        let bold = base_bold ^ (idx % 2 == 1);
        append_run(out, seg, bold, sz);
    }
}

/// Append a single `<w:r>` text run.
fn append_run(out: &mut String, text: &str, bold: bool, sz: Option<u32>) {
    if text.is_empty() {
        return;
    }
    out.push_str("<w:r>");
    if bold || sz.is_some() {
        out.push_str("<w:rPr>");
        if bold {
            out.push_str("<w:b/>");
        }
        if let Some(s) = sz {
            out.push_str(&format!("<w:sz w:val=\"{s}\"/><w:szCs w:val=\"{s}\"/>"));
        }
        out.push_str("</w:rPr>");
    }
    out.push_str("<w:t xml:space=\"preserve\">");
    xml_escape_into(text, out);
    out.push_str("</w:t></w:r>");
}

fn xml_escape_into(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

/// Compute the inline extent (EMU) for an image, scaled to fit page width.
fn image_extent(bytes: &[u8]) -> (i64, i64) {
    let (w, h) = image::load_from_memory(bytes)
        .map(|im| im.dimensions())
        .unwrap_or((600, 400));
    let w = w.max(1) as i64;
    let h = h.max(1) as i64;
    let mut cx = w * EMU_PER_PX;
    let mut cy = h * EMU_PER_PX;
    if cx > MAX_CONTENT_WIDTH_EMU {
        cy = cy * MAX_CONTENT_WIDTH_EMU / cx;
        cx = MAX_CONTENT_WIDTH_EMU;
    }
    (cx.max(1), cy.max(1))
}

// ---------------------------------------------------------------------------
// Markdown parsing helpers
// ---------------------------------------------------------------------------

fn parse_heading(line: &str) -> Option<(usize, &str)> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes) && line[hashes..].starts_with(' ') {
        Some((hashes, line[hashes..].trim_start()))
    } else {
        None
    }
}

fn parse_list_item(line: &str) -> Option<&str> {
    for prefix in ["- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(prefix) {
            return Some(rest);
        }
    }
    None
}

fn is_separator_row(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('|')
        && t.contains('-')
        && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
}

fn parse_pipe_row(line: &str) -> Vec<String> {
    line.trim()
        .trim_matches('|')
        .split('|')
        .map(|s| s.trim().to_string())
        .collect()
}

/// Parse `![alt](url)` starting at `start` (which points at '!'). Returns the
/// URL and the index just past the closing ')'.
fn parse_image_ref(chars: &[char], start: usize) -> Option<(String, usize)> {
    // chars[start] == '!', chars[start+1] == '['
    let mut i = start + 2;
    // skip alt text up to ']'
    while i < chars.len() && chars[i] != ']' {
        i += 1;
    }
    if i >= chars.len() || chars[i] != ']' {
        return None;
    }
    i += 1;
    if i >= chars.len() || chars[i] != '(' {
        return None;
    }
    i += 1;
    let url_start = i;
    while i < chars.len() && chars[i] != ')' {
        i += 1;
    }
    if i >= chars.len() || chars[i] != ')' {
        return None;
    }
    let url: String = chars[url_start..i].iter().collect();
    Some((url.trim().to_string(), i + 1))
}

fn find_char(chars: &[char], from: usize, target: char) -> Option<usize> {
    (from..chars.len()).find(|&i| chars[i] == target)
}

/// Find index of `a` immediately followed by `b`, searching from `from`.
fn find_seq(chars: &[char], from: usize, a: char, b: char) -> Option<usize> {
    let mut i = from;
    while i + 1 < chars.len() {
        if chars[i] == a && chars[i + 1] == b {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Strip HTML tags and decode common entities, collapsing whitespace.
fn strip_html(s: &str) -> String {
    static TAG_RE: OnceLock<Regex> = OnceLock::new();
    let tag_re = TAG_RE.get_or_init(|| Regex::new(r"(?is)<[^>]+>").unwrap());
    let no_tags = tag_re.replace_all(s, " ");
    let decoded = no_tags
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}
