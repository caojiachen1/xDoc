import { getDocument } from "pdfjs-dist";
// Import worker module directly — runs on main thread ("fake worker" mode).
// This avoids Web Worker loading issues in Tauri's webview where Worker URL
// resolution can silently fail, causing getDocument() to hang forever.
import * as pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs";
import { invoke } from "@tauri-apps/api/core";
import { resolveDoi, resolveArxiv, detectArxivId, searchByTitle } from "./crossrefResolver";

// Register the worker module on the global scope so pdfjs finds it
// via globalThis.pdfjsWorker?.WorkerMessageHandler and uses the fake-worker path.
(globalThis as Record<string, unknown>).pdfjsWorker = pdfjsWorker;

export interface PaperMetadata {
  title?: string;
  titleTranslation?: string;
  authors?: string[];
  abstract?: string;
  abstractTranslation?: string;
  journal?: string;
  publisher?: string;
  date?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  url?: string;
  journalAbbrev?: string;
  issn?: string;
  isbn?: string;
  language?: string;
  keywords?: string[];
  category?: string; // e.g. "journal-article", "book-chapter", "proceedings-article"
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function cleanString(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseAuthors(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  // Split by comma, semicolon, or "and"
  const parts = raw.split(/[,;]|\band\b/i).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function parseXmpMetadata(xmpXml: string): Partial<PaperMetadata> {
  const result: Partial<PaperMetadata> = {};
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmpXml, "application/xml");

    // Dublin Core namespace
    const dcNs = "http://purl.org/dc/elements/1.1/";
    const prismNs = "http://prismstandard.org/namespaces/basic/2.0/";
    const pdfNs = "http://ns.adobe.com/pdf/1.3/";

    const getTextContent = (el: Element | null): string | undefined => {
      if (!el) return undefined;
      // Try rdf:li first (bag/seq containers)
      const li = el.getElementsByTagName("rdf:li")[0];
      if (li) return cleanString(li.textContent);
      return cleanString(el.textContent);
    };

    const getDcElement = (localName: string) =>
      doc.getElementsByTagNameNS(dcNs, localName)[0];
    const getPrismElement = (localName: string) =>
      doc.getElementsByTagNameNS(prismNs, localName)[0];
    const getPdfElement = (localName: string) =>
      doc.getElementsByTagNameNS(pdfNs, localName)[0];

    // Title
    result.title = getTextContent(getDcElement("title"));

    // Authors/Creators
    const creatorEl = getDcElement("creator");
    if (creatorEl) {
      const creatorText = getTextContent(creatorEl);
      if (creatorText) {
        result.authors = parseAuthors(creatorText);
      }
    }

    // Abstract/Description
    result.abstract = getTextContent(getDcElement("description"));

    // Keywords/Subjects
    const subjectEl = getDcElement("subject");
    if (subjectEl) {
      const lis = subjectEl.getElementsByTagName("rdf:li");
      if (lis.length > 0) {
        result.keywords = Array.from(lis).map((li) => li.textContent?.trim() || "").filter(Boolean);
      }
    }

    // Publisher
    result.publisher = getTextContent(getDcElement("publisher"));

    // Language
    result.language = getTextContent(getDcElement("language"));

    // Date
    result.date = getTextContent(getDcElement("date"));

    // PRISM metadata
    result.doi = cleanString(getPrismElement("doi")?.textContent) ??
                 cleanString(getPrismElement("digitalObjectIdentifier")?.textContent);
    result.volume = cleanString(getPrismElement("volume")?.textContent);
    result.issue = cleanString(getPrismElement("number")?.textContent) ??
                   cleanString(getPrismElement("issue")?.textContent);
    result.pages = cleanString(getPrismElement("startingPage")?.textContent);
    const endPage = cleanString(getPrismElement("endingPage")?.textContent);
    if (result.pages && endPage) result.pages = `${result.pages}–${endPage}`;
    result.issn = cleanString(getPrismElement("issn")?.textContent);
    result.isbn = cleanString(getPrismElement("isbn")?.textContent);
    result.journal = getTextContent(getPrismElement("publicationName")) ??
                     getTextContent(getPrismElement("pubTitle"));
    result.journalAbbrev = cleanString(getPrismElement("shortTitle")?.textContent);
    result.url = cleanString(getPrismElement("url")?.textContent) ??
                 cleanString(getPrismElement("aggregationType")?.textContent);

    // PDF namespace
    if (!result.keywords) {
      const pdfKeywords = getPdfElement("Keywords");
      if (pdfKeywords) {
        const text = pdfKeywords.textContent?.trim();
        if (text) result.keywords = text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      }
    }
  } catch {
    // XMP parsing failure is non-fatal
  }
  return result;
}

function extractFromFirstPageText(text: string): Partial<PaperMetadata> {
  const result: Partial<PaperMetadata> = {};

  // DOI — very reliable pattern
  const doiMatch = text.match(/10\.\d{4,9}\/[^\s,;"'<>}\]]+/);
  if (doiMatch) {
    result.doi = doiMatch[0].replace(/[.)}>\]]+$/, "");
  }

  // Abstract
  const abstractMatch = text.match(
    /(?:Abstract|摘\s*要)[：:\s]*\n?([\s\S]{20,800}?)(?=\n(?:Keywords|关键词|Key\s*words|Introduction|1\s*[.\s]|一\s*[、.]|$))/i
  );
  if (abstractMatch) {
    result.abstract = abstractMatch[1].trim().replace(/\s+/g, " ");
  }

  // Date
  if (!result.date) {
    const dateMatch = text.match(/(\d{4})[-/.]\s*(\d{1,2})[-/.]\s*(\d{1,2})/);
    if (dateMatch) {
      result.date = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;
    } else {
      // Try "Month Year" pattern
      const monthYearMatch = text.match(
        /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i
      );
      if (monthYearMatch) result.date = monthYearMatch[0];
    }
  }

  // Volume
  const volMatch = text.match(/(?:Vol(?:ume)?\.?\s*)(\d+)/i);
  if (volMatch) result.volume = volMatch[1];

  // Issue
  const issueMatch = text.match(/(?:No\.?\s*|Issue\s*)(\d+)/i);
  if (issueMatch) result.issue = issueMatch[1];

  // Pages
  const pagesMatch = text.match(/(?:pp?\.?\s*)(\d+)\s*[-–]\s*(\d+)/i);
  if (pagesMatch) result.pages = `${pagesMatch[1]}–${pagesMatch[2]}`;

  // URL
  const urlMatch = text.match(/https?:\/\/[^\s<>"]+/);
  if (urlMatch) result.url = urlMatch[0].replace(/[.)>,;]+$/, "");

  return result;
}

export async function extractMetadata(base64Data: string): Promise<PaperMetadata> {
  const t0 = performance.now();
  const log = (step: string) => console.log(`[pdfMeta:L1+2] ${step} (+${(performance.now() - t0).toFixed(0)}ms)`);

  log("converting base64 to Uint8Array...");
  const uint8Array = base64ToUint8Array(base64Data);
  log(`Uint8Array ready (${(uint8Array.length / 1024).toFixed(0)} KB)`);

  log("calling getDocument()...");
  const loadingTask = getDocument({ data: uint8Array });
  log("waiting for loadingTask.promise...");
  const doc = await loadingTask.promise;
  log("PDF document loaded");

  const result: PaperMetadata = {};

  try {
    // 1. Extract from Info Dictionary and XMP
    log("extracting Info Dict + XMP metadata...");
    const meta = await doc.getMetadata();
    log("getMetadata() resolved");
    const info = meta.info as Record<string, unknown>;

    if (info) {
      result.title = cleanString(info.Title as string);
      if (info.Author) {
        result.authors = parseAuthors(info.Author as string);
      }
      result.abstract = cleanString(info.Subject as string);
      if (info.Keywords) {
        result.keywords = (info.Keywords as string)
          .split(/[,;]/)
          .map((s: string) => s.trim())
          .filter(Boolean);
      }
      if (info.CreationDate) {
        // PDF date format: D:YYYYMMDDHHmmss+HH'mm'
        const dateStr = (info.CreationDate as string).replace(/^D:/, "");
        const y = dateStr.substring(0, 4);
        const m = dateStr.substring(4, 6);
        const d = dateStr.substring(6, 8);
        if (y && m && d && /^\d{4}$/.test(y)) {
          result.date = `${y}-${m}-${d}`;
        }
      }
    }

    // 2. XMP metadata (richer source)
    if (meta.metadata) {
      const xmpRaw = (meta.metadata as unknown as { getAll?: () => string }).getAll?.();
      if (xmpRaw) {
        const xmp = parseXmpMetadata(xmpRaw);
        // Merge XMP data, preferring XMP over Info Dictionary for most fields
        for (const [key, value] of Object.entries(xmp)) {
          if (value !== undefined && value !== null) {
            const k = key as keyof PaperMetadata;
            if (!result[k] || (Array.isArray(value) && (value as unknown[]).length > 0)) {
              (result as Record<string, unknown>)[k] = value;
            }
          }
        }
      }
    }

    // 3. First page text extraction for missing fields
    const missingDoi = !result.doi;
    const missingAbstract = !result.abstract;
    const missingDate = !result.date;

    if (missingDoi || missingAbstract || missingDate) {
      try {
        log("extracting first page text for missing fields...");
        const page = await doc.getPage(1);
        const textContent = await page.getTextContent();
        log(`first page text: ${textContent.items.length} items`);
        const fullText = textContent.items
          .map((item) => ("str" in item ? (item as { str: string }).str : ""))
          .join(" ");

        const extracted = extractFromFirstPageText(fullText);
        if (missingDoi && extracted.doi) result.doi = extracted.doi;
        if (missingAbstract && extracted.abstract) result.abstract = extracted.abstract;
        if (missingDate && extracted.date) result.date = extracted.date;
        if (!result.volume && extracted.volume) result.volume = extracted.volume;
        if (!result.issue && extracted.issue) result.issue = extracted.issue;
        if (!result.pages && extracted.pages) result.pages = extracted.pages;
        if (!result.url && extracted.url) result.url = extracted.url;
      } catch {
        // First page extraction failure is non-fatal
      }
    }
  } finally {
    log("destroying loadingTask...");
    await loadingTask.destroy();
    log(`extractMetadata done (total ${(performance.now() - t0).toFixed(0)}ms)`);
  }

  return result;
}

// ── Backend response type ────────────────────────────────────────────

interface FontTextSegment {
  text: string;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  font_name: string;
  font_size: number;
  is_bold: boolean;
  is_italic: boolean;
}

interface FirstPageMetadataResponse {
  title_by_layout: string | null;
  abstract_by_layout: string | null;
  title_by_font: string | null;
  doi: string | null;
  arxiv_id: string | null;
  all_segments: FontTextSegment[];
  page_width: number;
  page_height: number;
}

// ── Cross-validation helpers ─────────────────────────────────────────

function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(a: string, b: string): number {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const wordsA = new Set(na.split(" ").filter((w) => w.length > 2));
  const wordsB = new Set(nb.split(" ").filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  for (const w of wordsA) if (wordsB.has(w)) common++;
  return common / Math.max(wordsA.size, wordsB.size);
}

function crossValidateTitle(
  existingTitle: string | undefined,
  layoutTitle: string | null,
  fontTitle: string | null,
): string | undefined {
  const candidates: { source: string; value: string }[] = [];
  if (layoutTitle) candidates.push({ source: "layout", value: layoutTitle });
  if (fontTitle) candidates.push({ source: "font", value: fontTitle });
  if (existingTitle) candidates.push({ source: "xmp", value: existingTitle });

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0].value;

  // Check pairwise similarity — if any two agree, use that value
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (titleSimilarity(candidates[i].value, candidates[j].value) > 0.7) {
        return candidates[i].value;
      }
    }
  }

  // No agreement — use highest priority (layout > font > xmp)
  return candidates[0].value;
}

// ── Enhanced metadata extraction (5 layers + cross-validation) ───────

export async function extractMetadataEnhanced(
  filePath: string,
  base64Data: string,
): Promise<PaperMetadata> {
  const t0 = performance.now();
  const log = (step: string) => console.log(`[pdfMeta:enhanced] ${step} (+${(performance.now() - t0).toFixed(0)}ms)`);

  // Layer 1+2: pdfjs Info Dict + XMP (existing logic)
  log("starting Layer 1+2 (pdfjs)...");
  const result = await extractMetadata(base64Data);
  log(`Layer 1+2 done: title=${JSON.stringify(result.title)}, doi=${result.doi}`);

  // Layer 3: Backend layout + font analysis
  log("starting Layer 3 (backend layout + font)...");
  let backend: FirstPageMetadataResponse | null = null;
  try {
    backend = await invoke<FirstPageMetadataResponse>(
      "extract_first_page_metadata",
      { filePath, scoreThreshold: 0.5 },
    );
    log(`Layer 3 done: title_layout=${JSON.stringify(backend.title_by_layout)}, doi=${backend.doi}, segments=${backend.all_segments.length}`);
  } catch (e) {
    log(`Layer 3 FAILED: ${e}`);
    console.warn("Backend metadata extraction failed:", e);
  }

  if (backend) {
    // Merge DOI from backend (backend regex may find what pdfjs missed)
    if (!result.doi && backend.doi) result.doi = backend.doi;

    // Detect arXiv ID from segments or existing text
    const arxivId = backend.arxiv_id || detectArxivId(
      backend.all_segments.map((s) => s.text).join(" "),
    );

    // Cross-validate title
    const validatedTitle = crossValidateTitle(
      result.title,
      backend.title_by_layout,
      backend.title_by_font,
    );
    if (validatedTitle) result.title = validatedTitle;

    // Merge layout-detected abstract (usually more accurate than regex)
    if (backend.abstract_by_layout) {
      result.abstract = backend.abstract_by_layout;
    }

    // Layer 4: Remote API resolution
    // Priority: DOI (CrossRef) > arXiv > title search
    let remote: Partial<PaperMetadata> | null = null;

    if (result.doi) {
      log(`starting Layer 4: CrossRef DOI resolve (${result.doi})...`);
      try {
        remote = await resolveDoi(result.doi);
        log(`Layer 4 CrossRef done: ${remote ? "got data" : "null"}`);
      } catch (e) {
        log(`Layer 4 CrossRef FAILED: ${e}`);
      }
    }

    if (!remote && arxivId) {
      log(`starting Layer 4: arXiv resolve (${arxivId})...`);
      try {
        remote = await resolveArxiv(arxivId);
        log(`Layer 4 arXiv done: ${remote ? "got data" : "null"}`);
        // If arXiv entry has a DOI, try CrossRef for richer data
        if (remote?.doi && remote.doi !== result.doi) {
          try {
            const crossRefData = await resolveDoi(remote.doi);
            if (crossRefData) remote = { ...remote, ...crossRefData };
          } catch {
            // CrossRef failure — use arXiv data
          }
        }
      } catch (e) {
        log(`Layer 4 arXiv FAILED: ${e}`);
      }
    }

    if (!remote && result.title && result.title.length > 10) {
      log(`starting Layer 4: CrossRef title search...`);
      try {
        remote = await searchByTitle(result.title);
        log(`Layer 4 title search done: ${remote ? "got data" : "null"}`);
      } catch (e) {
        log(`Layer 4 title search FAILED: ${e}`);
      }
    }

    // Layer 5: Merge remote data (highest priority — authoritative source)
    if (remote) {
      log("Layer 5: merging remote data...");
      const keys = Object.keys(remote) as (keyof PaperMetadata)[];
      for (const key of keys) {
        const val = remote[key];
        if (val !== undefined && val !== null) {
          if (Array.isArray(val)) {
            if (val.length > 0) {
              (result as Record<string, unknown>)[key] = val;
            }
          } else if (typeof val === "string" && val.trim()) {
            (result as Record<string, unknown>)[key] = val;
          }
        }
      }
    }
  }

  log(`extractMetadataEnhanced done (total ${(performance.now() - t0).toFixed(0)}ms)`);
  return result;
}
