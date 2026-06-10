/**
 * useSidebar — PDF sidebar (thumbnails, outline) state and drag-resize.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function useSidebar(documentPath: string, isPdfSelected: boolean) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<"thumbnails" | "outline">("thumbnails");
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [outlineItems, setOutlineItems] = useState<{ title: string; page_index: number; depth: number }[]>([]);
  const [sidebarLoading, setSidebarLoading] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // ── Reference sidebar ────────────────────────────────────────────
  const [refSidebarOpen, setRefSidebarOpen] = useState(false);
  const [refSidebarWidth, setRefSidebarWidth] = useState(320);

  // Reset sidebar when document changes
  useEffect(() => {
    setThumbnails([]);
    setOutlineItems([]);
  }, [documentPath]);

  // ── Load sidebar data ────────────────────────────────────────────
  const loadSidebarData = useCallback(async (mode: "thumbnails" | "outline") => {
    if (!documentPath || !isPdfSelected) return;
    setSidebarLoading(true);
    try {
      if (mode === "thumbnails" && thumbnails.length === 0) {
        const res = await invoke<{ thumbnails: string[]; page_count: number }>("render_pdf_thumbnails", { filePath: documentPath });
        setThumbnails(res.thumbnails);
      } else if (mode === "outline" && outlineItems.length === 0) {
        const res = await invoke<{ items: { title: string; page_index: number; depth: number }[]; page_count: number }>("extract_pdf_outline", { filePath: documentPath });
        setOutlineItems(res.items);
      }
    } catch (e) {
      console.error("Failed to load sidebar data:", e);
    } finally {
      setSidebarLoading(false);
    }
  }, [documentPath, isPdfSelected, thumbnails.length, outlineItems.length]);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      if (next) loadSidebarData(sidebarMode);
      return next;
    });
  }, [sidebarMode, loadSidebarData]);

  const switchSidebarMode = useCallback((mode: "thumbnails" | "outline") => {
    setSidebarMode(mode);
    loadSidebarData(mode);
  }, [loadSidebarData]);

  // ── Sidebar drag resize ──────────────────────────────────────────
  const handleSidebarDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarDragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!sidebarDragRef.current) return;
      const delta = ev.clientX - sidebarDragRef.current.startX;
      const newWidth = Math.max(140, Math.min(500, sidebarDragRef.current.startWidth + delta));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      sidebarDragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [sidebarWidth]);

  // ── Reference sidebar resize ─────────────────────────────────────
  const handleRefSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = refSidebarWidth;
    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      setRefSidebarWidth(Math.max(260, Math.min(600, startW + delta)));
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [refSidebarWidth]);

  return {
    sidebarOpen, setSidebarOpen,
    sidebarMode,
    thumbnails, setThumbnails,
    outlineItems, setOutlineItems,
    sidebarLoading,
    sidebarWidth,
    refSidebarOpen, setRefSidebarOpen,
    refSidebarWidth,
    toggleSidebar,
    switchSidebarMode,
    handleSidebarDragStart,
    handleRefSidebarResize,
    loadSidebarData,
  };
}
