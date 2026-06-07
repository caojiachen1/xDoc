import type { PaperMetadata } from "./pdfMetadata";

// ── Types ──────────────────────────────────────────────────────────────

export interface CitationStyle {
  id: string;
  name: string;
  category: string;
}

export type OutputFormat = "text" | "html" | "rtf";

// ── Available citation styles ──────────────────────────────────────────

export const CITATION_STYLES: CitationStyle[] = [
  // ── Chinese standard ──
  { id: "gbt-7714-2015", name: "GB/T 7714-2015（中国国家标准）", category: "中国标准" },

  // ── APA ──
  { id: "apa-7th", name: "APA 第7版（美国心理学会）", category: "APA" },
  { id: "apa-6th", name: "APA 第6版（美国心理学会）", category: "APA" },

  // ── MLA ──
  { id: "mla-9th", name: "MLA 第9版（现代语言协会）", category: "MLA" },
  { id: "mla-8th", name: "MLA 第8版（现代语言协会）", category: "MLA" },

  // ── Chicago ──
  { id: "chicago-17th-author-date", name: "Chicago 第17版 作者-日期制", category: "Chicago" },
  { id: "chicago-17th-notes", name: "Chicago 第17版 注释-书目制", category: "Chicago" },

  // ── Harvard ──
  { id: "harvard", name: "Harvard（哈佛引用格式）", category: "Harvard" },

  // ── Sci/eng/medicine ──
  { id: "ieee", name: "IEEE（电气电子工程师学会）", category: "理工医学" },
  { id: "vancouver", name: "Vancouver（温哥华格式）", category: "理工医学" },
  { id: "ama-11th", name: "AMA 第11版（美国医学会）", category: "理工医学" },
  { id: "nlm", name: "NLM（美国国家医学图书馆）", category: "理工医学" },
  { id: "acs", name: "ACS（美国化学会）", category: "理工医学" },
  { id: "aip", name: "AIP（美国物理联合会）", category: "理工医学" },
  { id: "aps", name: "APS（美国物理学会）", category: "理工医学" },

  // ── Journals ──
  { id: "nature", name: "Nature（《自然》期刊格式）", category: "期刊格式" },
  { id: "science", name: "Science（《科学》期刊格式）", category: "期刊格式" },
  { id: "cell", name: "Cell（《细胞》期刊格式）", category: "期刊格式" },
  { id: "pnas", name: "PNAS（美国科学院院刊格式）", category: "期刊格式" },

  // ── Other ──
  { id: "iso-690", name: "ISO 690（国际标准化组织）", category: "国际标准" },
  { id: "turabian-9th", name: "Turabian 第9版（图拉比安格式）", category: "其他" },
  { id: "din-1505-2", name: "DIN 1505-2（德国标准）", category: "其他" },
];

// ── Helper utilities ──────────────────────────────────────────────────

interface ParsedMeta {
  authors: string[];
  title: string;
  journal: string;
  publisher: string;
  year: string;
  month: string;
  day: string;
  volume: string;
  issue: string;
  pages: string;
  doi: string;
  url: string;
  issn: string;
  isbn: string;
  language: string;
}

function parseMeta(m: PaperMetadata): ParsedMeta {
  const date = m.date || "";
  let year = "", month = "", day = "";
  const ymd = date.match(/^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/);
  if (ymd) {
    year = ymd[1];
    month = ymd[2];
    day = ymd[3] || "";
  } else {
    const y = date.match(/(\d{4})/);
    if (y) year = y[1];
  }

  return {
    authors: m.authors || [],
    title: (m.title || "").replace(/\s+/g, " ").trim(),
    journal: m.journal || "",
    publisher: m.publisher || "",
    year,
    month,
    day,
    volume: m.volume || "",
    issue: m.issue || "",
    pages: m.pages || "",
    doi: m.doi || "",
    url: m.url || "",
    issn: m.issn || "",
    isbn: m.isbn || "",
    language: (m.language || "").toLowerCase(),
  };
}

// Format author name: "FirstName LastName" -> "LastName, F."
function authorInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  const initials = parts.slice(0, -1).map(p => p.charAt(0).toUpperCase() + ".").join(" ");
  return `${last}, ${initials}`;
}

// Format author: "FirstName LastName" -> "LastName, FirstName"
function authorLastFirst(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(" ");
  return `${last}, ${first}`;
}

// Format author: "FirstName LastName" -> "F. LastName"
function authorFirstInitLast(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  const initials = parts.slice(0, -1).map(p => p.charAt(0).toUpperCase() + ".").join(" ");
  return `${initials} ${last}`;
}

// Chinese author: keep original or transliterate
function authorGbt(name: string): string {
  // If Chinese characters, use as-is; otherwise use "LASTNAME FM"
  if (/[\u4e00-\u9fff]/.test(name)) return name;
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].toUpperCase();
  const last = parts[parts.length - 1].toUpperCase();
  const initials = parts.slice(0, -1).map(p => p.charAt(0).toUpperCase()).join(" ");
  return initials ? `${last} ${initials}` : last;
}

function joinAuthors(authors: string[], formatter: (a: string) => string, sep: string, lastSep: string, max?: number): string {
  let list = authors;
  if (max && list.length > max) {
    list = list.slice(0, max);
    return list.map(formatter).join(sep) + ", et al.";
  }
  if (list.length === 0) return "";
  if (list.length === 1) return formatter(list[0]);
  if (list.length === 2) return `${formatter(list[0])}${lastSep}${formatter(list[1])}`;
  const allButLast = list.slice(0, -1).map(formatter).join(sep);
  return `${allButLast}${lastSep}${formatter(list[list.length - 1])}`;
}

function fmtPages(pages: string): string {
  return pages.replace("–", "-").replace("—", "-");
}

// ── Style formatters (plain text) ─────────────────────────────────────

function fmtGbt7714(m: ParsedMeta): string {
  // GB/T 7714-2015
  const docType = m.journal ? "[J]" : (m.isbn ? "[M]" : "[Z]");
  const authorStr = joinAuthors(m.authors, authorGbt, ", ", ", ", 3);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`${m.title}${docType}`);

  if (m.journal) {
    let journalPart = m.journal;
    if (m.year) journalPart += `, ${m.year}`;
    if (m.volume) journalPart += `, ${m.volume}`;
    if (m.issue) journalPart += `(${m.issue})`;
    if (m.pages) journalPart += `: ${fmtPages(m.pages)}`;
    parts.push(journalPart);
  } else if (m.publisher) {
    let pubPart = m.publisher;
    if (m.year) pubPart += `, ${m.year}`;
    if (m.pages) pubPart += `: ${fmtPages(m.pages)}`;
    parts.push(pubPart);
  }

  if (m.doi) parts.push(`DOI: ${m.doi}`);
  return parts.join(". ") + ".";
}

function fmtApa7(m: ParsedMeta): string {
  // APA 7th Edition
  const authorStr = joinAuthors(m.authors, authorInitials, ", ", ", & ", 20);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  if (m.year) parts.push(`(${m.year})`);
  parts.push(m.title);

  if (m.journal) {
    let journalPart = `*${m.journal}*`;
    if (m.volume) journalPart += `, *${m.volume}*`;
    if (m.issue) journalPart += `(${m.issue})`;
    if (m.pages) journalPart += `, ${fmtPages(m.pages)}`;
    parts.push(journalPart);
  } else if (m.publisher) {
    parts.push(m.publisher);
  }

  if (m.doi) parts.push(`https://doi.org/${m.doi}`);
  else if (m.url) parts.push(m.url);
  return parts.join(". ") + ".";
}

function fmtApa6(m: ParsedMeta): string {
  // APA 6th Edition
  const authorStr = joinAuthors(m.authors, authorInitials, ", ", ", & ", 7);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  if (m.year) parts.push(`(${m.year})`);
  parts.push(m.title);

  if (m.journal) {
    let journalPart = `*${m.journal}*`;
    if (m.volume) journalPart += `, *${m.volume}*`;
    if (m.issue) journalPart += `(${m.issue})`;
    if (m.pages) journalPart += `, ${fmtPages(m.pages)}`;
    parts.push(journalPart);
  } else if (m.publisher) {
    parts.push(m.publisher);
  }

  if (m.doi) parts.push(`doi:${m.doi}`);
  else if (m.url) parts.push(`Retrieved from ${m.url}`);
  return parts.join(". ") + ".";
}

function fmtMla9(m: ParsedMeta): string {
  // MLA 9th Edition
  const authorStr = joinAuthors(m.authors, authorLastFirst, ", ", ", and ", 2);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`"${m.title}."`);

  if (m.journal) {
    let journalPart = `*${m.journal}*`;
    if (m.volume) journalPart += `, vol. ${m.volume}`;
    if (m.issue) journalPart += `, no. ${m.issue}`;
    if (m.year) journalPart += `, ${m.year}`;
    if (m.pages) journalPart += `, pp. ${fmtPages(m.pages)}`;
    parts.push(journalPart);
  } else if (m.publisher) {
    let pubPart = m.publisher;
    if (m.year) pubPart += `, ${m.year}`;
    parts.push(pubPart);
  }

  if (m.doi) parts.push(`doi:${m.doi}`);
  else if (m.url) parts.push(m.url);
  return parts.join(". ") + ".";
}

function fmtMla8(m: ParsedMeta): string {
  // MLA 8th Edition (similar to 9th but slightly different punctuation)
  return fmtMla9(m);
}

function fmtChicagoAuthorDate(m: ParsedMeta): string {
  // Chicago 17th - Author-Date
  const authorStr = joinAuthors(m.authors, authorLastFirst, ", ", ", and ", 10);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  if (m.year) parts.push(m.year);
  parts.push(`"${m.title}."`);

  if (m.journal) {
    let journalPart = `*${m.journal}*`;
    if (m.volume) journalPart += ` ${m.volume}`;
    if (m.issue) journalPart += `, no. ${m.issue}`;
    if (m.pages) journalPart += `: ${fmtPages(m.pages)}`;
    parts.push(journalPart);
  } else if (m.publisher) {
    parts.push(m.publisher);
  }

  if (m.doi) parts.push(`https://doi.org/${m.doi}`);
  return parts.join(". ") + ".";
}

function fmtChicagoNotes(m: ParsedMeta): string {
  // Chicago 17th - Notes and Bibliography
  const authorStr = joinAuthors(m.authors, authorFirstInitLast, ", ", ", and ", 10);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`"${m.title}."`);

  if (m.journal) {
    let journalPart = `*${m.journal}*`;
    if (m.volume) journalPart += ` ${m.volume}`;
    if (m.issue) journalPart += `, no. ${m.issue}`;
    if (m.year) journalPart += ` (${m.year})`;
    if (m.pages) journalPart += `: ${fmtPages(m.pages)}`;
    parts.push(journalPart);
  } else if (m.publisher) {
    let pubPart = m.publisher;
    if (m.year) pubPart += `, ${m.year}`;
    parts.push(pubPart);
  }

  if (m.doi) parts.push(`https://doi.org/${m.doi}`);
  return parts.join(". ") + ".";
}

function fmtHarvard(m: ParsedMeta): string {
  // Harvard style
  const authorStr = joinAuthors(m.authors, authorInitials, ", ", " and ", 3);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  if (m.year) parts.push(`(${m.year})`);
  parts.push(`'${m.title}'`);

  if (m.journal) {
    let journalPart = `*${m.journal}*`;
    if (m.volume) journalPart += `, ${m.volume}`;
    if (m.issue) journalPart += `(${m.issue})`;
    if (m.pages) journalPart += `, pp. ${fmtPages(m.pages)}`;
    parts.push(journalPart);
  } else if (m.publisher) {
    let pubPart = m.publisher;
    if (m.year) pubPart += `, ${m.year}`;
    parts.push(pubPart);
  }

  if (m.doi) parts.push(`doi: ${m.doi}`);
  return parts.join(". ") + ".";
}

function fmtIeee(m: ParsedMeta): string {
  // IEEE style
  const authorStr = joinAuthors(m.authors, authorFirstInitLast, ", ", ", and ", 6);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`"${m.title}."`);

  if (m.journal) {
    let journalPart = `*${m.journal}*`;
    if (m.volume) journalPart += `, vol. ${m.volume}`;
    if (m.issue) journalPart += `, no. ${m.issue}`;
    if (m.pages) journalPart += `, pp. ${fmtPages(m.pages)}`;
    if (m.year) journalPart += `, ${m.year}`;
    parts.push(journalPart);
  } else if (m.publisher) {
    let pubPart = m.publisher;
    if (m.year) pubPart += `, ${m.year}`;
    parts.push(pubPart);
  }

  if (m.doi) parts.push(`doi: ${m.doi}`);
  return parts.join(", ") + ".";
}

function fmtVancouver(m: ParsedMeta): string {
  // Vancouver style
  const authorStr = joinAuthors(m.authors, (name) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    const last = parts[parts.length - 1];
    const initials = parts.slice(0, -1).map(p => p.charAt(0).toUpperCase()).join("");
    return `${last} ${initials}`;
  }, ", ", ", ", 6);

  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`${m.title}.`);

  if (m.journal) {
    let journalPart = m.journal;
    if (m.year) journalPart += `. ${m.year}`;
    if (m.volume) journalPart += `;${m.volume}`;
    if (m.issue) journalPart += `(${m.issue})`;
    if (m.pages) journalPart += `:${fmtPages(m.pages)}`;
    parts.push(journalPart);
  } else if (m.publisher) {
    let pubPart = m.publisher;
    if (m.year) pubPart += `; ${m.year}`;
    parts.push(pubPart);
  }

  if (m.doi) parts.push(`doi: ${m.doi}`);
  return parts.join(" ") + ".";
}

function fmtAma11(m: ParsedMeta): string {
  // AMA 11th Edition
  const authorStr = joinAuthors(m.authors, (name) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    const last = parts[parts.length - 1];
    const initials = parts.slice(0, -1).map(p => p.charAt(0).toUpperCase()).join("");
    return `${last} ${initials}`;
  }, ", ", ", ", 6);

  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`${m.title}.`);

  if (m.journal) {
    let journalPart = `*${m.journal}*.`;
    if (m.year) journalPart += ` ${m.year}`;
    if (m.volume) journalPart += `;${m.volume}`;
    if (m.issue) journalPart += `(${m.issue})`;
    if (m.pages) journalPart += `:${fmtPages(m.pages)}`;
    parts.push(journalPart);
  } else if (m.publisher) {
    let pubPart = m.publisher;
    if (m.year) pubPart += `; ${m.year}`;
    parts.push(pubPart);
  }

  if (m.doi) parts.push(`doi:${m.doi}`);
  return parts.join(" ") + ".";
}

function fmtNlm(m: ParsedMeta): string {
  // NLM (National Library of Medicine)
  const authorStr = joinAuthors(m.authors, (name) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    const last = parts[parts.length - 1];
    const initials = parts.slice(0, -1).map(p => p.charAt(0).toUpperCase()).join("");
    return `${last} ${initials}`;
  }, ", ", ", ", 6);

  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`${m.title}.`);

  if (m.journal) {
    let journalPart = m.journal;
    if (m.year) journalPart += `. ${m.year}`;
    if (m.volume) journalPart += `;${m.volume}`;
    if (m.issue) journalPart += `(${m.issue})`;
    if (m.pages) journalPart += `:${fmtPages(m.pages)}`;
    parts.push(journalPart);
  }

  if (m.doi) parts.push(`doi: ${m.doi}`);
  return parts.join(" ") + ".";
}

function fmtAcs(m: ParsedMeta): string {
  // ACS (American Chemical Society)
  const authorStr = joinAuthors(m.authors, authorInitials, "; ", "; ", 10);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`${m.title}.`);

  if (m.journal) {
    let journalPart = `*${m.journal}*`;
    if (m.year) journalPart += ` *${m.year}*`;
    if (m.volume) journalPart += `, *${m.volume}*`;
    if (m.issue) journalPart += ` (${m.issue})`;
    if (m.pages) journalPart += `, ${fmtPages(m.pages)}`;
    parts.push(journalPart);
  }

  if (m.doi) parts.push(`DOI: ${m.doi}`);
  return parts.join(" ") + ".";
}

function fmtAip(m: ParsedMeta): string {
  // AIP (American Institute of Physics)
  const authorStr = joinAuthors(m.authors, authorFirstInitLast, ", ", ", and ", 3);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`"${m.title}."`);

  if (m.journal) {
    let journalPart = m.journal;
    if (m.volume) journalPart += ` *${m.volume}*`;
    if (m.issue) journalPart += `, ${m.issue}`;
    if (m.pages) journalPart += `, ${fmtPages(m.pages)}`;
    if (m.year) journalPart += ` (${m.year})`;
    parts.push(journalPart);
  }

  if (m.doi) parts.push(`https://doi.org/${m.doi}`);
  return parts.join(", ") + ".";
}

function fmtAps(m: ParsedMeta): string {
  // APS (American Physical Society)
  const authorStr = joinAuthors(m.authors, authorFirstInitLast, ", ", ", and ", 10);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`${m.title}.`);

  if (m.journal) {
    let journalPart = m.journal;
    if (m.volume) journalPart += ` *${m.volume}*`;
    if (m.issue) journalPart += `, ${m.issue}`;
    if (m.pages) journalPart += `, ${fmtPages(m.pages)}`;
    if (m.year) journalPart += ` (${m.year})`;
    parts.push(journalPart);
  }

  if (m.doi) parts.push(`https://doi.org/${m.doi}`);
  return parts.join(", ") + ".";
}

function fmtNature(m: ParsedMeta): string {
  // Nature format
  const authorStr = joinAuthors(m.authors, authorInitials, ", ", " & ", 5);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`${m.title}.`);

  if (m.journal) {
    let journalPart = `*${m.journal}*`;
    if (m.volume) journalPart += ` *${m.volume}*`;
    if (m.pages) journalPart += `, ${fmtPages(m.pages)}`;
    if (m.year) journalPart += ` (${m.year})`;
    parts.push(journalPart);
  }

  if (m.doi) parts.push(`https://doi.org/${m.doi}`);
  return parts.join(" ") + ".";
}

function fmtScience(m: ParsedMeta): string {
  // Science format
  const authorStr = joinAuthors(m.authors, authorFirstInitLast, ", ", ", ", 5);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`${m.title}.`);

  if (m.journal) {
    let journalPart = `*${m.journal}*`;
    if (m.volume) journalPart += ` *${m.volume}*`;
    if (m.pages) journalPart += `, ${fmtPages(m.pages)}`;
    if (m.year) journalPart += ` (${m.year})`;
    parts.push(journalPart);
  }

  if (m.doi) parts.push(`doi: ${m.doi}`);
  return parts.join(" ") + ".";
}

function fmtCell(m: ParsedMeta): string {
  // Cell format
  const authorStr = joinAuthors(m.authors, authorFirstInitLast, ", ", ", and ", 10);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`(${m.year}). ${m.title}.`);

  if (m.journal) {
    let journalPart = `*${m.journal}*`;
    if (m.volume) journalPart += ` *${m.volume}*`;
    if (m.issue) journalPart += `, ${m.issue}`;
    if (m.pages) journalPart += `, ${fmtPages(m.pages)}`;
    parts.push(journalPart);
  }

  if (m.doi) parts.push(`https://doi.org/${m.doi}`);
  return parts.join(" ") + ".";
}

function fmtPnas(m: ParsedMeta): string {
  // PNAS format
  const authorStr = joinAuthors(m.authors, authorFirstInitLast, ", ", ", ", 5);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`(${m.year}) ${m.title}.`);

  if (m.journal) {
    let journalPart = `*${m.journal}*`;
    if (m.volume) journalPart += ` ${m.volume}`;
    if (m.issue) journalPart += ` (${m.issue})`;
    if (m.pages) journalPart += `:${fmtPages(m.pages)}`;
    parts.push(journalPart);
  }

  if (m.doi) parts.push(`https://doi.org/${m.doi}`);
  return parts.join(" ") + ".";
}

function fmtIso690(m: ParsedMeta): string {
  // ISO 690
  const authorStr = joinAuthors(m.authors, authorLastFirst, ", ", ", ", 3);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr.toUpperCase());
  parts.push(`${m.title}.`);

  if (m.journal) {
    let journalPart = m.journal;
    if (m.year) journalPart += `, ${m.year}`;
    if (m.volume) journalPart += `, vol. ${m.volume}`;
    if (m.issue) journalPart += `, no. ${m.issue}`;
    if (m.pages) journalPart += `, p. ${fmtPages(m.pages)}`;
    parts.push(journalPart);
  } else if (m.publisher) {
    let pubPart = m.publisher;
    if (m.year) pubPart += `, ${m.year}`;
    parts.push(pubPart);
  }

  if (m.doi) parts.push(`DOI: ${m.doi}`);
  else if (m.url) parts.push(`Available from: ${m.url}`);
  return parts.join(". ") + ".";
}

function fmtTurabian9(m: ParsedMeta): string {
  // Turabian 9th (based on Chicago Notes)
  return fmtChicagoNotes(m);
}

function fmtDin1505(m: ParsedMeta): string {
  // DIN 1505-2
  const authorStr = joinAuthors(m.authors, authorLastFirst, " ; ", " ; ", 3);
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`${m.title}.`);

  if (m.journal) {
    let journalPart = m.journal;
    if (m.volume) journalPart += `, Bd. ${m.volume}`;
    if (m.year) journalPart += ` (${m.year})`;
    if (m.issue) journalPart += `, Nr. ${m.issue}`;
    if (m.pages) journalPart += `, S. ${fmtPages(m.pages)}`;
    parts.push(journalPart);
  } else if (m.publisher) {
    let pubPart = m.publisher;
    if (m.year) pubPart += `, ${m.year}`;
    parts.push(pubPart);
  }

  if (m.doi) parts.push(`DOI: ${m.doi}`);
  return parts.join(". ") + ".";
}

// ── Main format dispatcher ────────────────────────────────────────────

const FORMATTERS: Record<string, (m: ParsedMeta) => string> = {
  "gbt-7714-2015": fmtGbt7714,
  "apa-7th": fmtApa7,
  "apa-6th": fmtApa6,
  "mla-9th": fmtMla9,
  "mla-8th": fmtMla8,
  "chicago-17th-author-date": fmtChicagoAuthorDate,
  "chicago-17th-notes": fmtChicagoNotes,
  "harvard": fmtHarvard,
  "ieee": fmtIeee,
  "vancouver": fmtVancouver,
  "ama-11th": fmtAma11,
  "nlm": fmtNlm,
  "acs": fmtAcs,
  "aip": fmtAip,
  "aps": fmtAps,
  "nature": fmtNature,
  "science": fmtScience,
  "cell": fmtCell,
  "pnas": fmtPnas,
  "iso-690": fmtIso690,
  "turabian-9th": fmtTurabian9,
  "din-1505-2": fmtDin1505,
};

// ── Output conversion ─────────────────────────────────────────────────

/**
 * Convert a citation string (which may contain *italic* markers)
 * to plain text (strip markers).
 */
function toPlainText(s: string): string {
  return s.replace(/\*([^*]+)\*/g, "$1");
}

/**
 * Convert a citation string to HTML (convert *italic* to <i>).
 */
function toHtml(s: string): string {
  // Escape HTML entities first
  const escaped = s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  // Convert *...* to <i>...</i>
  return escaped.replace(/\*([^*]+)\*/g, "<i>$1</i>");
}

/**
 * Convert a citation string to RTF (convert *italic* to RTF italic).
 */
function toRtf(s: string): string {
  // Escape RTF special chars
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
  // Convert *...* to RTF italic
  const rtf = escaped.replace(/\*([^*]+)\*/g, "{\\i $1}");
  return `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}\\f0\\fs24 ${rtf}}`;
}

/**
 * Format a citation in the given style and output format.
 */
export function formatCitation(
  metadata: PaperMetadata,
  styleId: string,
  outputFormat: OutputFormat,
): string {
  const m = parseMeta(metadata);
  const formatter = FORMATTERS[styleId];
  if (!formatter) return `[Unsupported style: ${styleId}]`;
  const raw = formatter(m);

  switch (outputFormat) {
    case "text": return toPlainText(raw);
    case "html": return toHtml(raw);
    case "rtf": return toRtf(raw);
    default: return toPlainText(raw);
  }
}

/**
 * Get all citation styles grouped by category.
 */
export function getGroupedStyles(): Record<string, CitationStyle[]> {
  const groups: Record<string, CitationStyle[]> = {};
  for (const style of CITATION_STYLES) {
    if (!groups[style.category]) groups[style.category] = [];
    groups[style.category].push(style);
  }
  return groups;
}
