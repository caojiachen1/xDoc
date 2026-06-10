/**
 * usePapers — Paper library management (import, delete, metadata extraction).
 */
import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { PaperInfo } from "../components/HomePage";
import { extractMetadataEnhanced } from "../utils/pdfMetadata";
import {
  copyToManaged,
  savePaper,
  listPapers,
  deletePaper as dbDeletePaper,
  renamePaper,
  recordToPaperInfo,
  paperInfoToRecord,
} from "../utils/paperDb";

export function usePapers(
  onPaperDeleted: (paper: PaperInfo) => void,
) {
  const [papersList, setPapersList] = useState<PaperInfo[]>([]);
  const [extractingPaperId, setExtractingPaperId] = useState<string | null>(null);

  // ── Load papers from DB (called on init) ─────────────────────────
  const loadPapersFromDb = useCallback(async () => {
    try {
      const records = await listPapers();
      const papers = records.map(recordToPaperInfo);
      // Backfill fileSize
      const needsBackfill = papers.filter(p => !p.fileSize);
      if (needsBackfill.length > 0) {
        for (const p of needsBackfill) {
          const target = p.managedPath || p.path;
          try {
            const size = await invoke<number>("paper_file_size", { filePath: target });
            p.fileSize = size;
          } catch { /* non-fatal */ }
        }
        for (const p of needsBackfill) {
          if (p.fileSize) {
            try { await savePaper(paperInfoToRecord(p)); } catch { /* non-fatal */ }
          }
        }
      }
      setPapersList(papers);
      console.log(`[App] loaded ${papers.length} papers from database`);
    } catch (e) {
      console.warn("[App] failed to load papers from DB:", e);
    }
  }, []);

  // ── Import papers via file dialog ────────────────────────────────
  const handleImportPapers = useCallback(async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "Documents", extensions: ["pdf", "png", "jpg", "jpeg", "bmp", "webp"] }],
    });
    if (selected && Array.isArray(selected)) {
      const existingPaths = new Set(papersList.map(p => p.originalPath));
      const newPapers: PaperInfo[] = [];
      for (const sourcePath of selected) {
        if (existingPaths.has(sourcePath)) continue;
        const id = `paper-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const name = sourcePath.replace(/\\/g, "/").split("/").pop() || sourcePath;
        try {
          const managedPath = await copyToManaged(sourcePath, id);
          let fileSize: number | undefined;
          try { fileSize = await invoke<number>("paper_file_size", { filePath: managedPath }); } catch {}
          const paper: PaperInfo = {
            id, name, path: managedPath, originalPath: sourcePath,
            managedPath, importDate: new Date().toISOString(), fileSize,
          };
          await savePaper(paperInfoToRecord(paper));
          newPapers.push(paper);
        } catch (e) {
          console.error(`[App] failed to import ${name}:`, e);
        }
      }
      if (newPapers.length > 0) setPapersList(prev => [...prev, ...newPapers]);
    }
  }, [papersList]);

  // ── Import from drag-and-drop paths ──────────────────────────────
  const handleDropImport = useCallback(async (paths: string[]) => {
    const existingPaths = new Set(papersList.map(p => p.originalPath));
    const newPapers: PaperInfo[] = [];
    for (const sourcePath of paths) {
      if (existingPaths.has(sourcePath)) continue;
      const id = `paper-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const name = sourcePath.replace(/\\/g, "/").split("/").pop() || sourcePath;
      try {
        const managedPath = await copyToManaged(sourcePath, id);
        let fileSize: number | undefined;
        try { fileSize = await invoke<number>("paper_file_size", { filePath: managedPath }); } catch {}
        const paper: PaperInfo = {
          id, name, path: managedPath, originalPath: sourcePath,
          managedPath, importDate: new Date().toISOString(), fileSize,
        };
        await savePaper(paperInfoToRecord(paper));
        newPapers.push(paper);
      } catch (e) {
        console.error(`[App] failed to import dropped file ${name}:`, e);
      }
    }
    if (newPapers.length > 0) setPapersList(prev => [...prev, ...newPapers]);
  }, [papersList]);

  // ── Delete paper ─────────────────────────────────────────────────
  const handleDeletePaper = useCallback(async (id: string) => {
    const paper = papersList.find(p => p.id === id);
    if (!paper) return;
    setPapersList(prev => prev.filter(p => p.id !== id));
    onPaperDeleted(paper);
    try { await dbDeletePaper(id); } catch (e) { console.error("[App] failed to delete paper from DB:", e); }
  }, [papersList, onPaperDeleted]);

  // ── Extract metadata for a paper ─────────────────────────────────
  const handleExtractMetadata = useCallback(async (paperId: string) => {
    const paper = papersList.find(p => p.id === paperId);
    if (!paper || paper.metadataExtracted) return;
    setExtractingPaperId(paperId);
    try {
      const base64Data = await invoke<string>("read_file_base64", { filePath: paper.path });
      const metadata = await extractMetadataEnhanced(paper.path, base64Data);
      let renamedPaper = { ...paper, metadata, metadataExtracted: true };
      if (metadata.title && paper.managedPath) {
        try {
          const newPath = await renamePaper(paper.managedPath, metadata.title);
          renamedPaper.path = newPath;
          renamedPaper.managedPath = newPath;
          renamedPaper.name = newPath.replace(/\\/g, "/").split("/").pop() || renamedPaper.name;
        } catch (e) { console.warn("[App] rename failed:", e); }
      }
      setPapersList(prev => prev.map(p => p.id === paperId ? renamedPaper : p));
      try { await savePaper(paperInfoToRecord(renamedPaper)); } catch (e) { console.warn("[App] save metadata failed:", e); }
    } catch (e) {
      console.error("Metadata extraction failed:", e);
      const updatedPaper: PaperInfo = { ...paper, metadataExtracted: true };
      setPapersList(prev => prev.map(p => p.id === paperId ? updatedPaper : p));
      try { await savePaper(paperInfoToRecord(updatedPaper)); } catch (e2) { console.warn("[App] save metadata flag failed:", e2); }
    } finally {
      setExtractingPaperId(null);
    }
  }, [papersList]);

  // ── Translation updates ──────────────────────────────────────────
  const handleUpdateTitleTranslation = useCallback(async (paperId: string, translation: string) => {
    setPapersList(prev => prev.map(p => {
      if (p.id !== paperId) return p;
      const updated: PaperInfo = { ...p, metadata: { ...p.metadata, titleTranslation: translation } };
      savePaper(paperInfoToRecord(updated)).catch(e => console.warn("[App] persist titleTranslation failed:", e));
      return updated;
    }));
  }, []);

  const handleUpdateAbstractTranslation = useCallback(async (paperId: string, translation: string) => {
    setPapersList(prev => prev.map(p => {
      if (p.id !== paperId) return p;
      const updated: PaperInfo = { ...p, metadata: { ...p.metadata, abstractTranslation: translation } };
      savePaper(paperInfoToRecord(updated)).catch(e => console.warn("[App] persist abstractTranslation failed:", e));
      return updated;
    }));
  }, []);

  return {
    papersList, setPapersList,
    extractingPaperId,
    loadPapersFromDb,
    handleImportPapers,
    handleDropImport,
    handleDeletePaper,
    handleExtractMetadata,
    handleUpdateTitleTranslation,
    handleUpdateAbstractTranslation,
  };
}
