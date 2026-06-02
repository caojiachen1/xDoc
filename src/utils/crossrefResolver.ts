import { fetch } from "@tauri-apps/plugin-http";
import type { PaperMetadata } from "./pdfMetadata";

const TIMEOUT_MS = 8000;

function withTimeout(signal?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort());
  }
  return controller.signal;
}

function stripMarkup(text: string): string {
  return text.replace(/<\/?[^>]+>/g, "").replace(/\{|\}/g, "");
}

// ── CrossRef DOI Resolution ──────────────────────────────────────────

export async function resolveDoi(
  doi: string,
): Promise<Partial<PaperMetadata> | null> {
  const cleanDoi = doi.trim();
  if (!cleanDoi) return null;

  try {
    const url = `https://api.crossref.org/works/${encodeURIComponent(cleanDoi)}?mailto=xdoc@app.local`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: withTimeout(),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    return parseCrossRefMessage(json.message);
  } catch {
    return null;
  }
}

function parseCrossRefMessage(msg: Record<string, unknown>): Partial<PaperMetadata> {
  if (!msg) return {};
  const result: Partial<PaperMetadata> = {};

  // Title
  const titles = msg.title as string[] | undefined;
  if (titles?.[0]) {
    let title = stripMarkup(titles[0]);
    const subtitles = msg.subtitle as string[] | undefined;
    if (subtitles?.[0]) {
      const sub = stripMarkup(subtitles[0]);
      if (!title.toLowerCase().includes(sub.toLowerCase())) {
        title += title.endsWith(":") ? ` ${sub}` : `: ${sub}`;
      }
    }
    result.title = title;
  }

  // Authors
  const authors = msg.author as Array<Record<string, unknown>> | undefined;
  if (authors?.length) {
    result.authors = authors.map((a) => {
      if (a.name) return String(a.name);
      const given = (a.given as string) || "";
      const family = (a.family as string) || "";
      return given ? `${given} ${family}` : family;
    }).filter(Boolean);
  }

  // Abstract (may contain JATS/HTML tags)
  if (typeof msg.abstract === "string" && msg.abstract) {
    result.abstract = stripMarkup(msg.abstract).trim();
  }

  // Journal
  const containerTitle = msg["container-title"] as string[] | undefined;
  if (containerTitle?.[0]) {
    result.journal = containerTitle[0];
  }

  // Journal abbreviation
  const shortTitle = msg["short-container-title"] as string[] | undefined;
  if (shortTitle?.[0] && shortTitle[0] !== containerTitle?.[0]) {
    result.journalAbbrev = shortTitle[0];
  }

  // Publisher
  if (typeof msg.publisher === "string") {
    result.publisher = msg.publisher;
  }

  // Date
  const issued = msg.issued as Record<string, unknown> | undefined;
  const dateParts = issued?.["date-parts"] as number[][] | undefined;
  if (dateParts?.[0]) {
    const [year, month, day] = dateParts[0];
    if (year) {
      if (month && day) {
        result.date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      } else if (month) {
        result.date = `${year}-${String(month).padStart(2, "0")}`;
      } else {
        result.date = String(year);
      }
    }
  }

  // Volume, Issue, Pages
  if (msg.volume) result.volume = String(msg.volume);
  if (msg.issue) result.issue = String(msg.issue);
  if (msg.page) result.pages = String(msg.page);

  // DOI
  if (msg.DOI) result.doi = String(msg.DOI);

  // URL
  if (msg.URL) result.url = String(msg.URL);

  // ISSN
  const issn = msg.ISSN as string[] | undefined;
  if (issn?.[0]) result.issn = issn[0];

  // ISBN
  const isbn = msg.ISBN as string[] | undefined;
  if (isbn?.[0]) result.isbn = isbn[0];

  // Language
  if (typeof msg.language === "string") result.language = msg.language;

  // Keywords (CrossRef uses "subject")
  const subjects = msg.subject as string[] | undefined;
  if (subjects?.length) {
    result.keywords = subjects.map((s) => s.trim()).filter(Boolean);
  }

  return result;
}

// ── arXiv Resolution ─────────────────────────────────────────────────

export function detectArxivId(text: string): string | null {
  // New format: arXiv:2401.12345
  const newMatch = text.match(/arXiv:(\d{4}\.\d{4,5})/i);
  if (newMatch) return newMatch[1];

  // Old format: arXiv:cs/0703142
  const oldMatch = text.match(/arXiv:([a-z-]+\/\d{7})/i);
  if (oldMatch) return oldMatch[1];

  // URL format: arxiv.org/abs/2401.12345
  const urlMatch = text.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})/i);
  if (urlMatch) return urlMatch[1];

  // DOI format: 10.48550/arXiv.2401.12345
  const doiMatch = text.match(/10\.48550\/arXiv\.(\d{4}\.\d{4,5})/i);
  if (doiMatch) return doiMatch[1];

  return null;
}

export async function resolveArxiv(
  arxivId: string,
): Promise<Partial<PaperMetadata> | null> {
  const cleanId = arxivId.trim();
  if (!cleanId) return null;

  try {
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanId)}`;
    const resp = await fetch(url, { signal: withTimeout() });
    if (!resp.ok) return null;
    const xmlText = await resp.text();
    return parseArxivResponse(xmlText);
  } catch {
    return null;
  }
}

function parseArxivResponse(xmlText: string): Partial<PaperMetadata> | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const entry = doc.querySelector("entry");
  if (!entry) return null;

  const getText = (sel: string): string | null =>
    entry.querySelector(sel)?.textContent?.trim()?.replace(/\s+/g, " ") || null;

  const result: Partial<PaperMetadata> = {};

  const title = getText("title");
  if (title) result.title = title;

  const summary = getText("summary");
  if (summary) result.abstract = summary;

  // Authors
  const authorEls = entry.querySelectorAll("author > name");
  if (authorEls.length > 0) {
    result.authors = Array.from(authorEls)
      .map((el) => el.textContent?.trim() || "")
      .filter(Boolean);
  }

  // Date
  const published = getText("published");
  if (published) {
    const year = published.substring(0, 4);
    if (/^\d{4}$/.test(year)) result.date = year;
  }

  // URL
  const id = getText("id");
  if (id) result.url = id;

  // Check if there's a DOI link in the entry
  const links = entry.querySelectorAll("link");
  for (const link of links) {
    const href = link.getAttribute("href") || "";
    if (href.includes("doi.org/")) {
      const doi = href.split("doi.org/").pop();
      if (doi) result.doi = doi;
    }
  }

  result.language = "en";

  return result;
}

// ── CrossRef Title Search (last resort fallback) ─────────────────────

export async function searchByTitle(
  title: string,
): Promise<Partial<PaperMetadata> | null> {
  const clean = title.trim();
  if (!clean || clean.length < 5) return null;

  try {
    const url = `https://api.crossref.org/works?query.title=${encodeURIComponent(clean)}&rows=1&mailto=xdoc@app.local`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: withTimeout(),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const items = json.message?.items;
    if (!items?.length) return null;

    const candidate = items[0];
    const candidateTitle = candidate.title?.[0] || "";

    // Simple word-overlap similarity check
    const similarity = wordOverlap(clean.toLowerCase(), candidateTitle.toLowerCase());
    if (similarity < 0.7) return null;

    return parseCrossRefMessage(candidate);
  } catch {
    return null;
  }
}

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(b.split(/\s+/).filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) common++;
  }
  return common / Math.max(wordsA.size, wordsB.size);
}
