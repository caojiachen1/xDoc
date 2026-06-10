/**
 * xDoc — Shared types, interfaces, and constants.
 *
 * Imported by App.tsx and all custom hooks.
 */

// ── Layout / Detection ──────────────────────────────────────────────────────

export interface LayoutBox {
  cls_id: number;
  score: number;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  read_order: number;
}

export interface TextSegment {
  text: string;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export interface DetectionResponse {
  width: number;
  height: number;
  preview_data_url: string;
  source_type: "pdf" | "image" | string;
  page_index: number;
  page_count: number;
  boxes: LayoutBox[];
}

export interface ExtractContentResponse {
  width: number;
  height: number;
  preview_data_url: string;
  page_index: number;
  page_count: number;
  segments: TextSegment[];
}

// ── Grobid ──────────────────────────────────────────────────────────────────

export interface GrobidAuthorOutput {
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
  affiliation: string | null;
  identifier: string | null;
}

export interface GrobidDateOutput {
  year: string | null;
  month: string | null;
  day: string | null;
  raw: string | null;
}

export interface GrobidVenueOutput {
  name: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
}

export interface GrobidMetadataOutput {
  title: string | null;
  authors: GrobidAuthorOutput[];
  abstract_text: string | null;
  date: GrobidDateOutput | null;
  doi: string | null;
  venue: GrobidVenueOutput | null;
  keywords: string[];
}

export interface GrobidSectionOutput {
  title: string | null;
  level: number;
  content: string;
}

export interface GrobidFigureOutput {
  id: string | null;
  caption: string | null;
  description: string | null;
}

export interface GrobidTableOutput {
  id: string | null;
  caption: string | null;
  content: string | null;
}

export interface GrobidEquationOutput {
  id: string | null;
  content: string;
  description: string | null;
}

export interface GrobidRefOutput {
  id: string | null;
  title: string | null;
  authors: string[];
  year: string | null;
  month: string | null;
  day: string | null;
  date_raw: string | null;
  venue: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  doi: string | null;
  raw: string | null;
}

export interface GrobidDocumentOutput {
  metadata: GrobidMetadataOutput;
  sections: GrobidSectionOutput[];
  figures: GrobidFigureOutput[];
  tables: GrobidTableOutput[];
  equations: GrobidEquationOutput[];
  references: GrobidRefOutput[];
}

// ── UI Enums / Types ────────────────────────────────────────────────────────

export type ZoomMode = "fit_page" | "fit_width" | "fit_height" | "actual" | "custom";
export type DragMode = "move" | "select";
export type SelectMode = "box" | "text";
export type AnnotationTool = "pen" | "eraser" | "text" | "rect" | "ellipse" | "line" | null;
export type EraserMode = "free" | "stroke";
export type TopMenuKey = "file" | "edit" | "view" | "tools" | "settings" | "help" | null;

// ── Annotations ─────────────────────────────────────────────────────────────

export interface AnnotationShape {
  id: string;
  type: "freehand" | "eraser" | "rect" | "ellipse" | "text" | "line";
  /** Normalized coordinates (0–1) relative to image dimensions */
  points: { x: number; y: number }[];
  color: string;
  size: number;
  text?: string;
  /** For text: normalized width/height of the bounding box */
  width?: number;
  height?: number;
}

// ── Tabs ────────────────────────────────────────────────────────────────────

export interface TabInfo {
  id: string;
  title: string;
  type: "home" | "reader";
  documentPath?: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

export const CLASSES = [
  "abstract",          // 0
  "algorithm",         // 1
  "aside_text",        // 2
  "chart",             // 3
  "content",           // 4
  "display_formula",   // 5
  "doc_title",         // 6
  "figure_title",      // 7
  "footer",            // 8
  "footer_image",      // 9
  "footnote",          // 10
  "formula_number",    // 11
  "header",            // 12
  "header_image",      // 13
  "image",             // 14
  "inline_formula",    // 15
  "number",            // 16
  "paragraph_title",   // 17
  "reference",         // 18
  "reference_content", // 19
  "seal",              // 20
  "table",             // 21
  "text",              // 22
  "vertical_text",     // 23
  "vision_footnote",   // 24
];

export const COLORS = [
  "#FF3838", "#FF9D97", "#FF701F", "#FFB21D", "#CFD231",
  "#48F90A", "#92CC17", "#3DDB86", "#1A9334", "#00D4BB",
  "#2C99A8", "#FF6B6B", "#FFD93D", "#6BCB77", "#4D96FF",
  "#C084FC", "#FB923C", "#34D399", "#F472B6", "#818CF8",
  "#FBBF24", "#A78BFA", "#60A5FA", "#F87171", "#38BDF8",
];

export const HOME_TAB_ID = "home";

export const STORAGE_KEYS = {
  modelPath: "xdoc.settings.modelPath",
  scoreThreshold: "xdoc.settings.scoreThreshold",
  zoomMode: "xdoc.settings.zoomMode",
  pdfTextExtractionEnabled: "xdoc.settings.pdfTextExtractionEnabled",
  llmVendor: "xdoc.settings.llm.vendor",
  llmVendorApiKeys: "xdoc.settings.llm.vendorApiKeys",
  llmBaseUrl: "xdoc.settings.llm.baseUrl",
  llmModel: "xdoc.settings.llm.model",
  textFontSize: "xdoc.settings.textFontSize",
  aiFontSize: "xdoc.settings.aiFontSize",
  textFontFamily: "xdoc.settings.textFontFamily",
  aiFontFamily: "xdoc.settings.aiFontFamily",
} as const;

// Custom eraser cursor — SVG of a tilted eraser, hotspot at the contact tip
export const ERASER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="30" viewBox="0 0 20 30">'
  + '<path d="M13,1 L19,7 L9,17 L3,11 Z" fill="%23fce4ec" stroke="%23666" stroke-width="1" stroke-linejoin="round"/>'
  + '<path d="M3,11 L9,17 L5,21 L1,17 Z" fill="%23ef9a9a" stroke="%23666" stroke-width="1" stroke-linejoin="round"/>'
  + '<line x1="6" y1="4" x2="16" y2="14" stroke="white" stroke-width="1" opacity="0.35"/>'
  + '</svg>'
)}") 6 22, auto`;

// ── Utility functions ───────────────────────────────────────────────────────

export function isVisualBox(clsId: number): boolean {
  // chart, display_formula, footer_image, header_image, image, inline_formula, seal, table
  const visual = new Set([3, 5, 9, 13, 14, 15, 20, 21]);
  return visual.has(clsId);
}

export function isGarbageBox(clsId: number): boolean {
  // footer, footer_image, header, header_image, number (page number), seal, formula_number
  const garbage = new Set([8, 9, 12, 13, 16, 20, 11]);
  return garbage.has(clsId);
}

export function isSegmentGarbage(seg: TextSegment, layoutBoxes: LayoutBox[]): boolean {
  const cx = (seg.xmin + seg.xmax) / 2;
  const cy = (seg.ymin + seg.ymax) / 2;
  return layoutBoxes.some(
    (box) =>
      isGarbageBox(box.cls_id) &&
      cx >= box.xmin && cx <= box.xmax &&
      cy >= box.ymin && cy <= box.ymax
  );
}

export const actionLabels: Record<string, string> = {
  "解读": "解读文字",
  "翻译": "翻译文字",
  "摘要": "摘要文字",
  "全文解读": "全文解读",
};

/**
 * Merge adjacent text spans on the same line within the pdfjs TextLayer
 * to prevent ::selection highlight overlap at word boundaries.
 */
export function mergeTextLayerSpans(container: HTMLElement) {
  const spans = Array.from(
    container.querySelectorAll(
      ":scope > span:not(.markedContent), :scope > .markedContent > span:not(.markedContent)"
    )
  ) as HTMLElement[];
  if (spans.length <= 1) return;

  const containerH = container.offsetHeight || 1;
  const containerW = container.offsetWidth || 1;

  const pctToPxTop = (v: string) => (parseFloat(v) || 0) / 100 * containerH;
  const pctToPxLeft = (v: string) => (parseFloat(v) || 0) / 100 * containerW;

  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d")!;

  let groupFirst: HTMLElement | null = null;
  let groupTopPx = 0;
  let groupRightPx = 0;
  let groupText = "";

  const flushGroup = () => {
    if (!groupFirst) return;
    groupFirst.textContent = groupText;

    const cs = getComputedStyle(groupFirst);
    measureCtx.font = `${cs.fontWeight} ${cs.fontStyle} ${cs.fontSize} ${cs.fontFamily}`;
    const measured = measureCtx.measureText(groupText).width;
    const leftPx = pctToPxLeft(groupFirst.style.left);
    const targetWidth = groupRightPx - leftPx;
    if (measured > 0 && targetWidth > 0) {
      groupFirst.style.setProperty("--scale-x", String(targetWidth / measured));
    } else {
      groupFirst.style.removeProperty("--scale-x");
    }
    groupFirst = null;
  };

  for (const span of spans) {
    const topPx = pctToPxTop(span.style.top);
    const leftPx = pctToPxLeft(span.style.left);
    const layoutWidth = span.offsetWidth;
    const rightPx = leftPx + layoutWidth;

    if (groupFirst && Math.abs(topPx - groupTopPx) < 2) {
      const gap = Math.max(0, leftPx - groupRightPx);
      const cs = getComputedStyle(span);
      const spaceWidth = parseFloat(cs.fontSize) / 4 || 4;
      groupText += " ".repeat(Math.max(0, Math.round(gap / spaceWidth))) + (span.textContent || "");
      groupRightPx = Math.max(groupRightPx, rightPx);
      span.remove();
    } else {
      flushGroup();
      groupFirst = span;
      groupTopPx = topPx;
      groupRightPx = rightPx;
      groupText = span.textContent || "";
    }
  }
  flushGroup();
}
