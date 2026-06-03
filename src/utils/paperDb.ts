import { invoke } from "@tauri-apps/api/core";
import type { PaperInfo } from "../components/HomePage";
import type { PaperMetadata } from "./pdfMetadata";

/**
 * Mirrors the Rust PaperRecord struct stored in SQLite.
 */
export interface PaperRecord {
  id: string;
  name: string;
  original_path: string;
  managed_path: string | null;
  import_date: string;
  last_read_date: string | null;
  file_size: number | null;
  title: string | null;
  title_translation: string | null;
  authors: string | null; // JSON array
  abstract_text: string | null;
  journal: string | null;
  publisher: string | null;
  date: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  url: string | null;
  journal_abbrev: string | null;
  issn: string | null;
  isbn: string | null;
  language: string | null;
  keywords: string | null; // JSON array
  metadata_extracted: boolean;
}

// ── Tauri command wrappers ────────────────────────────────────────────────

export async function copyToManaged(
  sourcePath: string,
  paperId: string
): Promise<string> {
  return invoke<string>("paper_copy_to_managed", {
    sourcePath,
    paperId,
  });
}

export async function savePaper(record: PaperRecord): Promise<void> {
  return invoke("paper_save", { paper: record });
}

export async function listPapers(): Promise<PaperRecord[]> {
  return invoke<PaperRecord[]>("paper_list");
}

export async function deletePaper(id: string): Promise<void> {
  return invoke("paper_delete", { id });
}

export async function renamePaper(
  oldPath: string,
  newTitle: string
): Promise<string> {
  return invoke<string>("paper_rename", { oldPath, newTitle });
}

// ── Converters ────────────────────────────────────────────────────────────

function safeJsonParse<T>(json: string | null): T | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

function toJsonOrNull(arr: string[] | undefined): string | null {
  if (!arr || arr.length === 0) return null;
  return JSON.stringify(arr);
}

export function recordToPaperInfo(record: PaperRecord): PaperInfo {
  const filePath = record.managed_path || record.original_path;

  const metadata: PaperMetadata | undefined = record.metadata_extracted
    ? {
        title: record.title ?? undefined,
        titleTranslation: record.title_translation ?? undefined,
        authors: safeJsonParse<string[]>(record.authors),
        abstract: record.abstract_text ?? undefined,
        journal: record.journal ?? undefined,
        publisher: record.publisher ?? undefined,
        date: record.date ?? undefined,
        volume: record.volume ?? undefined,
        issue: record.issue ?? undefined,
        pages: record.pages ?? undefined,
        doi: record.doi ?? undefined,
        url: record.url ?? undefined,
        journalAbbrev: record.journal_abbrev ?? undefined,
        issn: record.issn ?? undefined,
        isbn: record.isbn ?? undefined,
        language: record.language ?? undefined,
        keywords: safeJsonParse<string[]>(record.keywords),
      }
    : undefined;

  return {
    id: record.id,
    name: record.name,
    path: filePath,
    originalPath: record.original_path,
    managedPath: record.managed_path ?? undefined,
    importDate: record.import_date,
    lastReadDate: record.last_read_date ?? undefined,
    fileSize: record.file_size ?? undefined,
    metadata,
    metadataExtracted: record.metadata_extracted,
  };
}

export function paperInfoToRecord(paper: PaperInfo): PaperRecord {
  return {
    id: paper.id,
    name: paper.name,
    original_path: paper.originalPath || paper.path,
    managed_path: paper.managedPath || null,
    import_date: paper.importDate,
    last_read_date: paper.lastReadDate || null,
    file_size: paper.fileSize ?? null,
    title: paper.metadata?.title || null,
    title_translation: paper.metadata?.titleTranslation || null,
    authors: toJsonOrNull(paper.metadata?.authors),
    abstract_text: paper.metadata?.abstract || null,
    journal: paper.metadata?.journal || null,
    publisher: paper.metadata?.publisher || null,
    date: paper.metadata?.date || null,
    volume: paper.metadata?.volume || null,
    issue: paper.metadata?.issue || null,
    pages: paper.metadata?.pages || null,
    doi: paper.metadata?.doi || null,
    url: paper.metadata?.url || null,
    journal_abbrev: paper.metadata?.journalAbbrev || null,
    issn: paper.metadata?.issn || null,
    isbn: paper.metadata?.isbn || null,
    language: paper.metadata?.language || null,
    keywords: toJsonOrNull(paper.metadata?.keywords),
    metadata_extracted: paper.metadataExtracted || false,
  };
}

// ── Annotation persistence ──────────────────────────────────────────────

export interface AnnotationRecord {
  file_path: string;
  page_index: number;
  shapes_json: string;
}

export async function annotationSave(
  filePath: string,
  pageIndex: number,
  shapesJson: string
): Promise<void> {
  return invoke("annotation_save", {
    req: { file_path: filePath, page_index: pageIndex, shapes_json: shapesJson },
  });
}

export async function annotationLoad(
  filePath: string
): Promise<AnnotationRecord[]> {
  return invoke<AnnotationRecord[]>("annotation_load", { filePath });
}

export async function annotationDelete(
  filePath: string
): Promise<void> {
  return invoke("annotation_delete", { filePath });
}

export interface ExportPoint { x: number; y: number }
export interface ExportShape {
  type: string;
  points: ExportPoint[];
  color: string;
  size: number;
  text?: string;
}
export interface PageAnnotations {
  page_index: number;
  shapes: ExportShape[];
}

export async function exportAnnotatedPdf(
  sourcePath: string,
  outputPath: string,
  annotations: PageAnnotations[]
): Promise<string> {
  return invoke<string>("export_annotated_pdf", {
    sourcePath,
    outputPath,
    annotations,
  });
}

// ── Journal ranking (CAS 分区表) ──────────────────────────────────────

export interface JournalRanking {
  journal: string;
  zone: number;       // 1–4
  is_top: boolean;
  is_oa: boolean;
}

export async function lookupJournalRanking(
  journalName: string
): Promise<JournalRanking | null> {
  return invoke<JournalRanking | null>("journal_ranking", {
    journalName,
  });
}
