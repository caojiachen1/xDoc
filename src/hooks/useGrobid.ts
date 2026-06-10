/**
 * useGrobid — Grobid academic paper parsing (async, batch, and structure-only).
 *
 * Manages: single-document parse, batch queue processing, cross-validation
 * with extracted metadata, and cache management.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { GrobidDocumentOutput } from "../types";
import type { PaperInfo } from "../components/HomePage";
import type { PaperMetadata } from "../utils/pdfMetadata";
import { savePaper, paperInfoToRecord } from "../utils/paperDb";

export type GrobidStatus = "pending" | "parsing" | "done" | "error";

export function useGrobid(
  documentPath: string,
  _papersList: PaperInfo[],
) {
  // ── Single-document parse state ──────────────────────────────────
  const [grobidLoading, setGrobidLoading] = useState(false);
  const [grobidDocument, setGrobidDocument] = useState<GrobidDocumentOutput | null>(null);
  const [grobidError, setGrobidError] = useState("");
  const grobidParsedPathRef = useRef("");
  const grobidCancelledRef = useRef(false);

  // ── Batch parse state ────────────────────────────────────────────
  const [grobidStatusMap, setGrobidStatusMap] = useState<Record<string, GrobidStatus>>({});
  const grobidBatchRunningRef = useRef(false);
  const grobidBatchQueueRef = useRef<string[]>([]);

  // ── Trigger Grobid parse for a single PDF ────────────────────────
  const triggerGrobidParse = useCallback((path: string, force: boolean = false) => {
    if (!path || !path.toLowerCase().endsWith(".pdf")) return;
    if (!force && grobidParsedPathRef.current === path) return;
    grobidParsedPathRef.current = path;
    grobidCancelledRef.current = false;
    setGrobidLoading(true);
    setGrobidError("");
    setGrobidDocument(null);

    invoke<GrobidDocumentOutput>("grobid_parse_document", { filePath: path })
      .then((doc) => {
        if (grobidCancelledRef.current) return;
        setGrobidDocument(doc);
        setGrobidLoading(false);
      })
      .catch((e) => {
        if (grobidCancelledRef.current) return;
        setGrobidError(String(e));
        setGrobidLoading(false);
      });
  }, []);

  // ── Re-parse structure only (keeps cached metadata/refs) ─────────
  const triggerGrobidStructureOnly = useCallback(() => {
    const path = documentPath;
    if (!path) return;
    setGrobidLoading(true);
    setGrobidError("");
    invoke<GrobidDocumentOutput>("grobid_parse_document", { filePath: path, structureOnly: true })
      .then((doc) => {
        setGrobidDocument(doc);
        setGrobidLoading(false);
      })
      .catch((e) => {
        setGrobidError(String(e));
        setGrobidLoading(false);
      });
  }, [documentPath]);

  // ── Clear Grobid cache and force re-parse ────────────────────────
  const handleClearGrobidCacheAndReparse = useCallback(async () => {
    const path = documentPath;
    if (!path) return;
    try {
      await invoke("grobid_clear_cache", { filePath: path });
    } catch (e) {
      console.warn("[Grobid] clear cache failed:", e);
    }
    setGrobidDocument(null);
    triggerGrobidParse(path, true);
  }, [documentPath, triggerGrobidParse]);

  // ── Clear metadata cache and re-extract ──────────────────────────
  const handleClearMetadataAndReparse = useCallback(async (
    resetPaper: () => PaperInfo | undefined,
    extractMetadata: (paper: PaperInfo) => Promise<void>,
  ) => {
    const paper = resetPaper();
    if (!paper) return;
    try {
      await extractMetadata(paper);
    } catch (e) {
      console.error("[App] reset metadata failed:", e);
    }
  }, []);

  // ── Batch queue processing ──────────────────────────────────────
  const processGrobidBatch = useCallback(async (
    crossValidate: (path: string, doc: GrobidDocumentOutput) => void,
  ) => {
    if (grobidBatchRunningRef.current) return;
    grobidBatchRunningRef.current = true;
    try {
      while (grobidBatchQueueRef.current.length > 0) {
        const path = grobidBatchQueueRef.current.shift()!;
        setGrobidStatusMap(prev => ({ ...prev, [path]: "parsing" }));
        try {
          const result = await invoke<GrobidDocumentOutput>("grobid_parse_document", { filePath: path });
          crossValidate(path, result);
          setGrobidStatusMap(prev => ({ ...prev, [path]: "done" }));
        } catch (e) {
          console.error(`[Grobid batch] parse failed for ${path}:`, e);
          setGrobidStatusMap(prev => ({ ...prev, [path]: "error" }));
        }
      }
    } finally {
      grobidBatchRunningRef.current = false;
    }
  }, []);

  // ── Cross-validate Grobid metadata with extracted metadata ───────
  const crossValidateGrobidMeta = useCallback((path: string, doc: GrobidDocumentOutput, currentPapers: PaperInfo[]): PaperInfo[] => {
    const paper = currentPapers.find(p => p.path === path);
    if (!paper) return currentPapers;

    const existing = paper.metadata;
    const grobid = doc.metadata;
    const merged: PaperMetadata = { ...(existing ?? {}) };

    // Title: prefer Grobid if existing is empty or filename-like
    if (grobid.title) {
      const grobidClean = grobid.title.replace(/\s+/g, " ").trim();
      const existingClean = (merged.title || "").replace(/\s+/g, " ").trim();
      if (!existingClean || existingClean.length < 5 || existingClean === paper.name.replace(/\.pdf$/i, "")) {
        merged.title = grobidClean;
      }
    }

    // Abstract
    if (!merged.abstract && grobid.abstract_text) {
      merged.abstract = grobid.abstract_text;
    }

    // Authors
    if ((!merged.authors || merged.authors.length === 0) && grobid.authors.length > 0) {
      merged.authors = grobid.authors
        .map(a => a.full_name || [a.first_name, a.middle_name, a.last_name].filter(Boolean).join(" "))
        .filter(Boolean);
    }

    // DOI
    if (!merged.doi && grobid.doi) merged.doi = grobid.doi;

    // Date
    if (!merged.date && grobid.date?.year) {
      merged.date = [grobid.date.year, grobid.date.month, grobid.date.day].filter(Boolean).join("-");
    }

    // Venue
    if (!merged.journal && grobid.venue?.name) merged.journal = grobid.venue.name;
    if (!merged.volume && grobid.venue?.volume) merged.volume = grobid.venue.volume;
    if (!merged.issue && grobid.venue?.issue) merged.issue = grobid.venue.issue;
    if (!merged.pages && grobid.venue?.pages) merged.pages = grobid.venue.pages;
    if (!merged.publisher && grobid.venue?.publisher) merged.publisher = grobid.venue.publisher;

    // Keywords
    if ((!merged.keywords || merged.keywords.length === 0) && grobid.keywords.length > 0) {
      merged.keywords = grobid.keywords;
    } else if (merged.keywords && grobid.keywords.length > 0) {
      const existingLower = new Set(merged.keywords.map(k => k.toLowerCase()));
      for (const kw of grobid.keywords) {
        if (!existingLower.has(kw.toLowerCase())) {
          merged.keywords.push(kw);
        }
      }
    }

    const updatedPaper: PaperInfo = { ...paper, metadata: merged, metadataExtracted: true };
    savePaper(paperInfoToRecord(updatedPaper)).catch(e => console.warn("[Grobid] save cross-validated metadata failed:", e));
    return currentPapers.map(p => p.id === paper.id ? updatedPaper : p);
  }, []);

  // ── Start batch parsing ──────────────────────────────────────────
  const startGrobidBatch = useCallback((papers: PaperInfo[], crossValidate: (path: string, doc: GrobidDocumentOutput) => void) => {
    const pdfPaths = papers
      .filter(p => p.path.toLowerCase().endsWith(".pdf"))
      .map(p => p.path);
    const newPaths = pdfPaths.filter(p =>
      !grobidBatchQueueRef.current.includes(p) &&
      grobidStatusMap[p] !== "done" &&
      grobidStatusMap[p] !== "parsing"
    );
    if (newPaths.length === 0) return;

    grobidBatchQueueRef.current.push(...newPaths);
    setGrobidStatusMap(prev => {
      const updated = { ...prev };
      for (const p of newPaths) updated[p] = "pending";
      return updated;
    });
    processGrobidBatch(crossValidate);
  }, [grobidStatusMap, processGrobidBatch]);

  // ── Priority parse: parse one paper first, then batch the rest ───
  const priorityGrobidParse = useCallback((path: string, papers: PaperInfo[], crossValidate: (path: string, doc: GrobidDocumentOutput) => void) => {
    if (!path || !path.toLowerCase().endsWith(".pdf")) return;

    // Remove from queue if already queued
    grobidBatchQueueRef.current = grobidBatchQueueRef.current.filter(p => p !== path);

    // Parse this one immediately
    setGrobidStatusMap(prev => ({ ...prev, [path]: "parsing" }));
    invoke<GrobidDocumentOutput>("grobid_parse_document", { filePath: path })
      .then((doc) => {
        crossValidate(path, doc);
        setGrobidStatusMap(prev => ({ ...prev, [path]: "done" }));
      })
      .catch((e) => {
        console.error(`[Grobid priority] parse failed for ${path}:`, e);
        setGrobidStatusMap(prev => ({ ...prev, [path]: "error" }));
      })
      .finally(() => {
        // After priority parse, continue with remaining batch
        const timer = setTimeout(() => startGrobidBatch(papers, crossValidate), 2000);
        return () => clearTimeout(timer);
      });
  }, [startGrobidBatch]);

  // ── Grobid event listener for async parse progress ───────────────
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<{
      status: string;
      message: string;
      result: GrobidDocumentOutput | null;
      error: string | null;
    }>("grobid-parse-event", (event) => {
      if (cancelled) return;
      const { status, result, error } = event.payload;
      if (status === "initializing" || status === "parsing") {
        setGrobidLoading(true);
        setGrobidError("");
      } else if (status === "completed") {
        setGrobidLoading(false);
        if (result) setGrobidDocument(result);
      } else if (status === "error") {
        setGrobidLoading(false);
        setGrobidError(error || "未知错误");
      }
    }).then((fn) => {
      if (cancelled) { fn(); return; }
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // ── Reset state ──────────────────────────────────────────────────
  const clearGrobidState = useCallback(() => {
    grobidCancelledRef.current = true;
    setGrobidDocument(null);
    setGrobidError("");
    setGrobidLoading(false);
    grobidParsedPathRef.current = "";
  }, []);

  return {
    grobidLoading, setGrobidLoading,
    grobidDocument, setGrobidDocument,
    grobidError, setGrobidError,
    grobidStatusMap, setGrobidStatusMap,
    grobidParsedPathRef,
    grobidCancelledRef,
    grobidBatchRunningRef,
    grobidBatchQueueRef,
    triggerGrobidParse,
    triggerGrobidStructureOnly,
    handleClearGrobidCacheAndReparse,
    handleClearMetadataAndReparse,
    processGrobidBatch,
    crossValidateGrobidMeta,
    startGrobidBatch,
    priorityGrobidParse,
    clearGrobidState,
  };
}
