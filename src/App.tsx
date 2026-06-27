import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getDocument, TextLayer } from "pdfjs-dist";
import * as pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Button,
  Card,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
} from "@fluentui/react-components";
import { ChevronLeft24Regular, ChevronRight24Regular } from "@fluentui/react-icons";
import { Bot, Languages, FileText, X, ZoomIn, ZoomOut, Hand, MousePointer, ChevronDown, LayoutPanelLeft, Images, ListTree, Pencil, Eraser, Type, Square, Circle, Minus, Undo2, Redo2, Trash2, Download, BookOpen, RefreshCw } from "lucide-react";
import katex from "katex";
import "katex/dist/katex.min.css";
import SettingsDialog from "./components/SettingsDialog";
import { latexToHtmlPreprocess } from "./utils/latex";
import EnvironmentCheck from "./components/EnvironmentCheck";
import HomePage, { type PaperInfo } from "./components/HomePage";
import ReferenceSidebar from "./components/ReferenceSidebar";
import {
  usePluginInit,
  usePluginLlmConfig,
  usePluginPdfPath,
  usePluginToolbarButtons,
  usePluginToast,
} from "./plugin";
import { createPluginContext } from "./plugin/context";
import { pluginManager } from "./plugin/manager";
import CommandPalette from "./components/CommandPalette";
import GlobalSearchDialog from "./components/GlobalSearchDialog";
import "./components/GlobalSearchDialog.css";
import ReadingReportDialog from "./components/ReadingReport";
import AboutDialog from "./components/AboutDialog";
import {
  PluginPanelHost,
  PluginSidebarHost,
  PluginFloatingWindowHost,
} from "./components/PluginPanelHost";
import {
  CLASSES,
  COLORS,
  HOME_TAB_ID,
  ERASER_CURSOR,
  isVisualBox,
  actionLabels,
  type LayoutBox,
  type TextSegment,
  type DetectionResponse,
  type ExtractContentResponse,
  type DragMode,
  type SelectMode,
  type TopMenuKey,
} from "./types";
import {
  useSettings,
  useGrobid,
  useAnnotations,
  useTabs,
  usePapers,
  useAiChat,
  useOcr,
  useSidebar,
  useZoom,
  useReadingSession,
  useSearch,
} from "./hooks";
import "./App.css";

// Register pdfjs worker on global scope (fake-worker mode for Tauri webview)
(globalThis as Record<string, unknown>).pdfjsWorker = pdfjsWorker;

function App() {
  // ── Local state (not managed by hooks) ─────────────────────────────────────
  const [environmentReady, setEnvironmentReady] = useState(false);
  const [documentPath, setDocumentPath] = useState("");
  const [previewSrc, setPreviewSrc] = useState("");
  const [boxes, setBoxes] = useState<LayoutBox[]>([]);
  const [segments, setSegments] = useState<TextSegment[]>([]);
  const [selectedParagraph, setSelectedParagraph] = useState<TextSegment | null>(null);
  const [selectedFigure, setSelectedFigure] = useState<LayoutBox | null>(null);
  const [figureImageDataUrl, setFigureImageDataUrl] = useState<string>("");
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [pdfPageIndex, setPdfPageIndex] = useState(0);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [openMenu, setOpenMenu] = useState<TopMenuKey>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showRawOcr, setShowRawOcr] = useState(false);
  const [dragMode, setDragMode] = useState<DragMode>("select");
  const [selectMode, setSelectMode] = useState<SelectMode>("box");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [showReadingReport, setShowReadingReport] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [homeSelectedPaperPath, setHomeSelectedPaperPath] = useState<string | null>(null);

  // ── Local refs ─────────────────────────────────────────────────────────────
  const textLayerRef = useRef<HTMLDivElement>(null);
  const pdfJsDocRef = useRef<any>(null);
  const textLayerInstanceRef = useRef<any>(null);
  const mainLayoutRef = useRef<HTMLDivElement>(null);

  // ── PDF custom text selection state ────────────────────────────────────────
  const pdfTextItemsRef = useRef<any[]>([]);
  const pdfSelectionRef = useRef<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  const pdfSelectingRef = useRef(false);
  const pdfSelectionStartRef = useRef<{ x: number; y: number } | null>(null);
  const pdfDragStartXRef = useRef(0); // Original drag start X (for first line left boundary)
  const pdfDragStartYRef = useRef(0); // Original drag start Y (for first line identification)
  const pdfSelectedTextRef = useRef("");
  const pdfSelectionOverlayRef = useRef<HTMLDivElement>(null);
  const pdfViewportScaleRef = useRef(1);
  const pdfPageHRef = useRef(0);
  const pdfViewportRef = useRef<any>(null);
  const layoutBoxesRef = useRef<LayoutBox[]>([]);
  const DRAG_THRESHOLD = 3;

  // ── Hook initialization (order matters: zoom before annotations, aiChat before ocr) ──
  const settings = useSettings(environmentReady);
  const zoom = useZoom(imageSize, settings.zoomMode, settings.setZoomMode, "", "");
  const tabs = useTabs((path) => setDocumentPath(path || ""));
  const papers = usePapers((paper) => {
    const tab = tabs.tabs.find(t => t.type === "reader" && t.documentPath === paper.path);
    if (tab) tabs.closeTab(tab.id, clearCurrentDocument, loadPageData, grobid.triggerGrobidParse, settings.modelLoaded, settings.scoreThreshold);
  }, (_paperId, oldPath, newPath) => {
    const tab = tabs.tabs.find(t => t.type === "reader" && t.documentPath === oldPath);
    if (tab) {
      tabs.setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, documentPath: newPath } : t));
      if (documentPath === oldPath) {
        setDocumentPath(newPath);
        loadPageData(newPath, pdfPageIndex);
        grobid.triggerGrobidParse(newPath);
      }
    }
  }, settings.llmSettings);
  const grobid = useGrobid(documentPath, papers.papersList);
  const annotations = useAnnotations(documentPath, pdfPageIndex, zoom.displaySize);
  const isPdfSelected = useMemo(() => documentPath.toLowerCase().endsWith(".pdf"), [documentPath]);
  const aiChat = useAiChat(
    settings.llmSettings, documentPath, pdfPageIndex, pdfPageCount,
    isPdfSelected, settings.scoreThreshold, settings.modelLoaded,
    selectedParagraph, figureImageDataUrl, settings.setErrorMessage,
  );
  const ocr = useOcr(
    settings.ocrEnabled, settings.ocrModelPath, settings.ocrModelId, documentPath,
    pdfPageIndex, selectedParagraph, aiChat.selectedParagraphPageRef,
    papers.papersList.find(p => p.path === documentPath)?.id,
  );
  const sidebar = useSidebar(documentPath, isPdfSelected);
  void useReadingSession(tabs.tabs, tabs.activeTabId, papers.papersList);

  // ── Plugin system integration ──────────────────────────────────────────────
  usePluginInit();
  usePluginLlmConfig(settings.llmSettings);
  usePluginPdfPath(documentPath || null);
  const pluginToolbarBtns = usePluginToolbarButtons();

  // Plugin toast notification listener (via EventBus v2)
  usePluginToast((detail) => {
    const { message } = detail;
    const toast = document.createElement("div");
    toast.style.cssText = `
      position: fixed; bottom: 24px; right: 24px; z-index: 10000;
      background: #2a2a2a; color: #e0e0e0; padding: 12px 20px;
      border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      font-size: 13px; max-width: 420px; word-break: break-word;
      animation: slideInRight 0.3s ease-out;
      backdrop-filter: blur(8px);
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.3s";
      setTimeout(() => document.body.removeChild(toast), 300);
    }, 4000);
  });

  // ── PDF selection coordinate helpers ──────────────────────────────────────
  const pdfToSelectionCoords = useCallback((e: React.PointerEvent) => {
    const container = textLayerRef.current;
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  // ── PDF selection hit-testing ─────────────────────────────────────────────
  const hitTestTextItems = useCallback((_selRect: { x: number; y: number; w: number; h: number }) => {
    const items = pdfTextItemsRef.current;
    if (!items || items.length === 0) return [];

    const scale = pdfViewportScaleRef.current;
    const pageH = pdfPageHRef.current;
    if (scale <= 0 || pageH <= 0) return [];

    // Use RAW start/end from pdfSelectionRef — preserves drag direction
    const sel = pdfSelectionRef.current;
    if (!sel) return [];

    const rawStartX = sel.startX / scale;
    const rawStartY = sel.startY / scale;
    const rawEndX = sel.endX / scale;
    const rawEndY = sel.endY / scale;

    // Bounding box for vertical range detection
    const selTop = Math.min(rawStartY, rawEndY);
    const selBottom = Math.max(rawStartY, rawEndY);

    // Compute average line height from items for threshold
    let avgH = 12;
    let hCount = 0;
    for (const item of items) {
      if (item.transform) {
        avgH += item.height || Math.abs(item.transform[3]) || 10;
        hCount++;
      }
    }
    if (hCount > 0) avgH /= hCount;
    const isMultiLine = selBottom - selTop > avgH;

    // ── Find the text block (layout box) ──
    let blockLeft = 0;
    let blockRight = Math.max(rawStartX, rawEndX);

    const lxBoxes = layoutBoxesRef.current;
    if (lxBoxes.length > 0) {
      const cx = (rawStartX + rawEndX) / 2;
      const cy = (rawStartY + rawEndY) / 2;
      const sxScale = zoom.scale.x || 1;
      const syScale = zoom.scale.y || 1;

      let found = false;
      for (const box of lxBoxes) {
        const bL = box.xmin * sxScale / scale;
        const bT = box.ymin * syScale / scale;
        const bR = box.xmax * sxScale / scale;
        const bB = box.ymax * syScale / scale;
        if (cx >= bL && cx <= bR && cy >= bT && cy <= bB) {
          blockLeft = bL; blockRight = bR; found = true; break;
        }
      }
      if (!found) {
        let bestDist = Infinity;
        for (const box of lxBoxes) {
          const bL = box.xmin * sxScale / scale;
          const bR = box.xmax * sxScale / scale;
          const bT = box.ymin * syScale / scale;
          const bB = box.ymax * syScale / scale;
          const dist = Math.hypot(cx - (bL + bR) / 2, cy - (bT + bB) / 2);
          if (dist < bestDist) { bestDist = dist; blockLeft = bL; blockRight = bR; }
        }
      }
    }

    // ── Build item data: match DOM spans (visual position) to textContent items (text) ──
    type ItemD = { str: string; xPdf: number; yPdf: number; wPdf: number; hPdf: number; yTopPdf: number; spanEl: HTMLSpanElement | null };
    const allItems: ItemD[] = [];

    // Read rendered span positions from DOM
    const container = textLayerRef.current;
    const containerRect = container?.getBoundingClientRect();
    const domSpans: Array<{ el: HTMLSpanElement; xPdf: number; yPdf: number; wPdf: number; hPdf: number }> = [];

    if (container && containerRect) {
      const spans = container.querySelectorAll(
        ":scope > span:not(.markedContent), :scope > .markedContent > span:not(.markedContent)"
      );
      spans.forEach((span) => {
        const spanEl = span as HTMLSpanElement;
        const rect = spanEl.getBoundingClientRect();
        const xPdf = (rect.left - containerRect.left) / scale;
        const yPdf = (rect.top - containerRect.top) / scale;
        const wPdf = rect.width / scale;
        const hPdf = rect.height / scale;
        if (wPdf > 0 && hPdf > 0) domSpans.push({ el: spanEl, xPdf, yPdf, wPdf, hPdf });
      });
    }

    // Match each textContent item to the closest DOM span by position
    for (const item of items) {
      if (!item.str || !item.transform) continue;
      const tx = item.transform;
      const itemX = tx[4];
      const itemY = tx[5];
      const wPdf = item.width || 0;
      const fontSize = Math.abs(tx[3]) || item.height || 10;
      const itemYtop = pageH - itemY - fontSize;

      // Find closest DOM span by center distance
      let bestSpan: typeof domSpans[0] | null = null;
      let bestDist = Infinity;
      const itemCX = itemX + wPdf / 2;
      const itemCY = itemYtop + fontSize / 2;

      for (const sp of domSpans) {
        const spCX = sp.xPdf + sp.wPdf / 2;
        const spCY = sp.yPdf + sp.hPdf / 2;
        const dist = Math.hypot(itemCX - spCX, itemCY - spCY);
        if (dist < bestDist) { bestDist = dist; bestSpan = sp; }
      }

      if (bestSpan && bestDist < fontSize * 2) {
        // Use DOM span's visual position (accurate) with item's text (correct)
        allItems.push({
          str: item.str,
          xPdf: bestSpan.xPdf,
          yPdf: bestSpan.yPdf,
          wPdf: bestSpan.wPdf,
          hPdf: bestSpan.hPdf,
          yTopPdf: bestSpan.yPdf + bestSpan.hPdf,
          spanEl: bestSpan.el,
        });
      } else {
        // Fallback: compute from transform
        const yPdf = pageH - itemY - fontSize;
        allItems.push({ str: item.str, xPdf: itemX, yPdf, wPdf, hPdf: fontSize, yTopPdf: yPdf + fontSize, spanEl: null });
      }
    }

    // ── Character-level selection ──
    // Each text item → one highlight. Merge adjacent on same line.

    // Find anchor items (closest to drag start/end) for first/last line detection
    let anchorStartY = rawStartY;
    let anchorStartH = avgH;
    let bestStartDist = Infinity;
    let anchorEndY = rawEndY;
    let anchorEndH = avgH;
    let bestEndDist = Infinity;
    for (const it of allItems) {
      const d1 = Math.abs(it.yPdf + it.hPdf / 2 - rawStartY);
      const d2 = Math.abs(it.yPdf + it.hPdf / 2 - rawEndY);
      if (d1 < bestStartDist) { bestStartDist = d1; anchorStartY = it.yPdf; anchorStartH = it.hPdf; }
      if (d2 < bestEndDist) { bestEndDist = d2; anchorEndY = it.yPdf; anchorEndH = it.hPdf; }
    }

    const matched: Array<{ str: string; x: number; y: number; w: number; h: number; yPdf: number; hPdf: number }> = [];

    for (const it of allItems) {
      if (it.yTopPdf < selTop || it.yPdf > selBottom) continue;

      let lineLeft: number;
      let lineRight: number;

      if (!isMultiLine) {
        lineLeft = Math.min(rawStartX, rawEndX);
        lineRight = Math.max(rawStartX, rawEndX);
      } else {
        // Compare item Y to fixed anchor Y (not rawStartY which can fall between lines)
        const onFirstLine = Math.abs(it.yPdf - anchorStartY) < anchorStartH * 0.3;
        const onLastLine = Math.abs(it.yPdf - anchorEndY) < anchorEndH * 0.3;

        if (onFirstLine && !onLastLine) {
          lineLeft = rawStartX;
          lineRight = blockRight;
        } else if (onLastLine) {
          lineLeft = blockLeft;
          lineRight = rawEndX;
        } else {
          lineLeft = blockLeft;
          lineRight = blockRight;
        }
      }

      const lMin = Math.min(lineLeft, lineRight);
      const lMax = Math.max(lineLeft, lineRight);
      if (it.xPdf + it.wPdf < lMin || it.xPdf > lMax) continue;

      const chars = it.str.split("");
      const n = chars.length;
      if (n === 0) continue;

      const charRects: Array<{ left: number; right: number }> = [];
      if (it.spanEl && it.spanEl.firstChild && it.spanEl.firstChild.nodeType === Node.TEXT_NODE) {
        const textNode = it.spanEl.firstChild as Text;
        const range = document.createRange();
        for (let i = 0; i < chars.length; i++) {
          try {
            range.setStart(textNode, i);
            range.setEnd(textNode, i + 1);
            const rect = range.getBoundingClientRect();
            if (rect.width > 0) {
              charRects.push({
                left: (rect.left - containerRect!.left) / scale,
                right: (rect.right - containerRect!.left) / scale,
              });
            } else {
              const fallbackLeft = it.xPdf + (it.wPdf / n) * i;
              const fallbackRight = fallbackLeft + (it.wPdf / n);
              charRects.push({ left: fallbackLeft, right: fallbackRight });
            }
          } catch {
            const fallbackLeft = it.xPdf + (it.wPdf / n) * i;
            const fallbackRight = fallbackLeft + (it.wPdf / n);
            charRects.push({ left: fallbackLeft, right: fallbackRight });
          }
        }
        try { range.detach(); } catch { /* noop */ }
      }

      const charLeft = (idx: number) => charRects[idx]?.left ?? (it.xPdf + (it.wPdf / n) * idx);
      const charRight = (idx: number) => charRects[idx]?.right ?? (it.xPdf + (it.wPdf / n) * (idx + 1));
      const avgCharW = it.wPdf / n;

      let firstIdx = -1;
      let lastIdx = -1;
      for (let i = 0; i < n; i++) {
        const cLeft = charLeft(i);
        const cRight = charRight(i);
        const startTol = i === 0 ? Math.min(2, avgCharW * 0.35) : 0;
        if (cRight > lMin - startTol && cLeft < lMax) {
          if (firstIdx === -1) firstIdx = i;
          lastIdx = i;
        }
      }
      if (firstIdx === -1) continue;

      const hl = charLeft(firstIdx);
      const hr = charRight(lastIdx);
      const hStr = chars.slice(firstIdx, lastIdx + 1).join("");
      if (hStr.length === 0) continue;

      // Merge with previous highlight if on the same visual line (no gap limit)
      const prev = matched[matched.length - 1];
      const sameLine = prev && Math.abs(prev.yPdf - it.yPdf) < Math.max(prev.hPdf, it.hPdf) * 0.6;
      if (prev && sameLine) {
        const gap = hl * scale - (prev.x + prev.w);
        if (gap > 3) prev.str += " ";
        
        prev.w = hr * scale - prev.x;
        prev.str += hStr;
        prev.yPdf = Math.min(prev.yPdf, it.yPdf);
        prev.hPdf = Math.max(prev.hPdf, it.hPdf);
        prev.y = prev.yPdf * scale;
        prev.h = prev.hPdf * scale + 3;
      } else {
        matched.push({
          str: hStr,
          x: hl * scale,
          y: it.yPdf * scale,
          w: (hr - hl) * scale,
          h: it.hPdf * scale + 3,
          yPdf: it.yPdf,
          hPdf: it.hPdf,
        });
      }
    }

    // Strip internal fields from output
    return matched.map(m => ({ str: m.str, x: m.x, y: m.y, w: m.w, h: m.h }));
  }, [zoom.displaySize, zoom.scale]);

  // ── PDF custom pointer event handlers ────────────────────────────────────
  const handlePdfPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (annotations.annotationMode) return;

    const pos = pdfToSelectionCoords(e);
    pdfSelectedTextRef.current = "";
    pdfSelectionStartRef.current = pos;
    pdfDragStartXRef.current = pos.x; // Remember exact drag start X for first line
    pdfDragStartYRef.current = pos.y; // Remember exact drag start Y for first line
    pdfSelectionRef.current = { startX: pos.x, startY: pos.y, endX: pos.x, endY: pos.y };
    pdfSelectingRef.current = false;

    if (pdfSelectionOverlayRef.current) pdfSelectionOverlayRef.current.innerHTML = "";
    aiChat.setPdfFloatingMenu(prev => prev.visible ? { ...prev, visible: false } : prev);
    window.getSelection()?.removeAllRanges();
  }, [annotations.annotationMode, pdfToSelectionCoords, aiChat]);

  const handlePdfPointerMove = useCallback((e: React.PointerEvent) => {
    if (!pdfSelectionStartRef.current) return;

    const pos = pdfToSelectionCoords(e);
    const start = pdfSelectionStartRef.current;
    const dx = pos.x - start.x;
    const dy = pos.y - start.y;

    if (!pdfSelectingRef.current && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;

    if (!pdfSelectingRef.current) {
      pdfSelectingRef.current = true;
      textLayerRef.current?.setPointerCapture(e.pointerId);
    }

    e.preventDefault();

    pdfSelectionRef.current = {
      startX: start.x, startY: start.y,
      endX: pos.x, endY: pos.y,
    };

    const rectX = Math.min(start.x, pos.x);
    const rectY = Math.min(start.y, pos.y);
    const rectW = Math.abs(dx);
    const rectH = Math.abs(dy);

    const matched = hitTestTextItems({ x: rectX, y: rectY, w: rectW, h: rectH });
    const overlay = pdfSelectionOverlayRef.current;
    if (overlay) {
      overlay.innerHTML = "";
      for (const item of matched) {
        const div = document.createElement("div");
        div.className = "pdf-selection-highlight";
        div.style.left = `${item.x}px`;
        div.style.top = `${item.y}px`;
        div.style.width = `${item.w}px`;
        div.style.height = `${item.h}px`;
        overlay.appendChild(div);
      }
    }
  }, [pdfToSelectionCoords, hitTestTextItems]);

  const handlePdfPointerUp = useCallback((e: React.PointerEvent) => {
    if (!pdfSelectingRef.current) {
      pdfSelectionStartRef.current = null;
      pdfSelectionRef.current = null;
      return;
    }

    pdfSelectingRef.current = false;
    textLayerRef.current?.releasePointerCapture(e.pointerId);
    pdfSelectionStartRef.current = null;

    const sel = pdfSelectionRef.current;
    if (!sel) return;

    const rectX = Math.min(sel.startX, sel.endX);
    const rectY = Math.min(sel.startY, sel.endY);
    const rectW = Math.abs(sel.endX - sel.startX);
    const rectH = Math.abs(sel.endY - sel.startY);
    const finalRect = { x: rectX, y: rectY, w: rectW, h: rectH };

    const matched = hitTestTextItems(finalRect);
    // Build text with proper line breaks and spacing
    let text = "";
    for (let i = 0; i < matched.length; i++) {
      if (i > 0) {
        const prevEnd = matched[i - 1].y + matched[i - 1].h;
        const currStart = matched[i].y;
        // Different line → newline; same line → space
        if (currStart > prevEnd + 2) {
          text += "\n";
        } else {
          // Same line: add space if there's a gap between highlights
          const gap = matched[i].x - (matched[i - 1].x + matched[i - 1].w);
          if (gap > 3) text += " ";
        }
      }
      text += matched[i].str;
    }
    pdfSelectedTextRef.current = text;

    const overlay = pdfSelectionOverlayRef.current;
    if (overlay) {
      overlay.innerHTML = "";
      for (const item of matched) {
        const div = document.createElement("div");
        div.className = "pdf-selection-highlight";
        div.style.left = `${item.x}px`;
        div.style.top = `${item.y}px`;
        div.style.width = `${item.w}px`;
        div.style.height = `${item.h}px`;
        overlay.appendChild(div);
      }
    }

    if (text.trim()) {
      const wrapEl = textLayerRef.current?.parentElement;
      if (!wrapEl) return;
      const wrapRect = wrapEl.getBoundingClientRect();

      const menuW = 260;
      const menuH = 40;
      let menuX = rectX + rectW / 2 - menuW / 2;
      let menuY = rectY - menuH - 4;

      menuX = Math.max(4, Math.min(menuX, wrapRect.width - menuW - 4));
      if (menuY < 4) menuY = rectY + rectH + 4;
      menuY = Math.max(4, menuY);

      aiChat.setPdfFloatingMenu({ visible: true, x: menuX, y: menuY, selectedText: text });
    } else {
      if (overlay) overlay.innerHTML = "";
      aiChat.setPdfFloatingMenu(prev => prev.visible ? { ...prev, visible: false } : prev);
    }
  }, [hitTestTextItems, aiChat]);

  const clearPdfSelection = useCallback(() => {
    pdfSelectionRef.current = null;
    pdfSelectionStartRef.current = null;
    pdfSelectingRef.current = false;
    pdfSelectedTextRef.current = "";
    if (pdfSelectionOverlayRef.current) pdfSelectionOverlayRef.current.innerHTML = "";
  }, []);

  // ── Computed values ────────────────────────────────────────────────────────
  const currentPaper = useMemo(() => papers.papersList.find(p => p.path === documentPath) || null, [papers.papersList, documentPath]);

  const effectivePdfPath = useMemo(() => {
    if (documentPath) return documentPath;
    if (homeSelectedPaperPath) return homeSelectedPaperPath;
    const readerTabs = tabs.tabs.filter(t => t.type === "reader" && t.documentPath);
    if (readerTabs.length > 0) return readerTabs[readerTabs.length - 1].documentPath!;
    return null;
  }, [documentPath, homeSelectedPaperPath, tabs.tabs]);

  // ── Home page paper selection handler (for command palette) ─────────────────
  const handleHomeSelectPaper = useCallback((paper: PaperInfo | null) => {
    setHomeSelectedPaperPath(paper?.path ?? null);
  }, []);

  // ── Keyboard shortcuts (Ctrl+K, Ctrl+O, Ctrl+N, Ctrl+,, etc.) ─────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      switch (e.key) {
        case "k":
          e.preventDefault();
          setCommandPaletteOpen((prev) => !prev);
          break;
        case "f":
          e.preventDefault();
          search.openSearchDialog();
          break;
        case "o":
          e.preventDefault();
          void selectDocument();
          break;
        case "n":
          e.preventDefault();
          tabs.setTabs([{ id: HOME_TAB_ID, title: "主页", type: "home" }]);
          tabs.setActiveTabId(HOME_TAB_ID);
          clearCurrentDocument();
          break;
        case ",":
          e.preventDefault();
          setSettingsOpen((prev) => !prev);
          break;
        case "=":
        case "+":
          if (isPdfSelected) { e.preventDefault(); zoom.handleZoomIn(); }
          break;
        case "-":
          if (isPdfSelected) { e.preventDefault(); zoom.handleZoomOut(); }
          break;
        case "0":
          if (isPdfSelected) { e.preventDefault(); zoom.handleZoomPreset(1.0); }
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isPdfSelected]);

  // ── Auto-switch to text mode when layout model is not available ────────────
  useEffect(() => {
    if (!settings.modelLoaded && selectMode === "box") {
      setSelectMode("text");
      aiChat.setPdfFloatingMenu({ visible: false, x: 0, y: 0, selectedText: "" });
      window.getSelection()?.removeAllRanges();
      clearPdfSelection();
    }
  }, [settings.modelLoaded, selectMode, clearPdfSelection]);

  // ── runModel — runs layout detection on a document ─────────────────────────
  const runModel = async (targetPageIndex?: number, targetFilePath?: string, thresholdOverride?: number) => {
    const activeFilePath = targetFilePath ?? documentPath;
    if (!settings.modelLoaded || !activeFilePath) return;

    const activeIsPdf = activeFilePath.toLowerCase().endsWith(".pdf");
    const activeThreshold = thresholdOverride ?? settings.scoreThreshold;

    settings.setErrorMessage("");
    try {
      settings.setLoading(true);
      const pageIndex = activeIsPdf ? Math.max(0, targetPageIndex ?? pdfPageIndex) : 0;
      const result = await invoke<DetectionResponse>("run_doclayout", {
        filePath: activeFilePath,
        scoreThreshold: activeThreshold,
        pageIndex,
      });

      setPreviewSrc(result.preview_data_url);
      setImageSize({ width: result.width, height: result.height });
      setPdfPageIndex(result.page_index);
      setPdfPageCount(result.page_count);
      setBoxes(result.boxes);
    } catch (e) {
      settings.setErrorMessage(`检测失败: ${String(e)}`);
    } finally {
      settings.setLoading(false);
    }
  };

  // ── loadPageData — loads a PDF page (text + layout) ────────────────────────
  const loadPageData = async (filePath: string, newPage: number) => {
    const version = ++zoom.requestVersionRef.current;
    const isCurrent = () => zoom.requestVersionRef.current === version;
    const isPdf = filePath.toLowerCase().endsWith(".pdf");

    setPdfPageIndex(newPage);
    settings.setErrorMessage("");
    settings.setLoading(true);

    try {
      if (isPdf && settings.modelLoaded) {
        const textResult = await invoke<ExtractContentResponse>("get_pdf_paragraphs", {
          filePath,
          pageIndex: newPage,
          scoreThreshold: settings.scoreThreshold,
        });
        if (!isCurrent()) return;

        setPreviewSrc(textResult.preview_data_url);
        setImageSize({ width: textResult.width, height: textResult.height });
        setPdfPageIndex(textResult.page_index);
        setPdfPageCount(textResult.page_count);
        setSegments(textResult.segments);

        const modelResult = await invoke<DetectionResponse>("run_doclayout", {
          filePath,
          scoreThreshold: settings.scoreThreshold,
          pageIndex: newPage,
        });
        if (!isCurrent()) return;

        setPreviewSrc(modelResult.preview_data_url);
        setBoxes(modelResult.boxes);
      } else if (isPdf) {
        const textResult = await invoke<ExtractContentResponse>("get_pdf_text", {
          filePath,
          pageIndex: newPage,
        });
        if (!isCurrent()) return;

        setPreviewSrc(textResult.preview_data_url);
        setImageSize({ width: textResult.width, height: textResult.height });
        setPdfPageIndex(textResult.page_index);
        setPdfPageCount(textResult.page_count);
        setSegments(textResult.segments);
      } else if (settings.modelLoaded) {
        const modelResult = await invoke<DetectionResponse>("run_doclayout", {
          filePath,
          scoreThreshold: settings.scoreThreshold,
          pageIndex: 0,
        });
        if (!isCurrent()) return;

        setPreviewSrc(modelResult.preview_data_url);
        setImageSize({ width: modelResult.width, height: modelResult.height });
        setPdfPageIndex(modelResult.page_index);
        setPdfPageCount(modelResult.page_count);
        setBoxes(modelResult.boxes);
      }
    } catch (e) {
      if (!isCurrent()) return;
      settings.setErrorMessage(`页面加载失败: ${String(e)}`);
    } finally {
      if (isCurrent()) {
        settings.setLoading(false);
      }
    }
  };

  // ── Search hook (needs loadPageData defined above) ──────────────────────
  const search = useSearch(loadPageData);

  // ── clearCurrentDocument — resets all document-related state ───────────────
  const clearCurrentDocument = () => {
    setDocumentPath("");
    setPreviewSrc("");
    setBoxes([]);
    setSegments([]);
    setSelectedParagraph(null);
    setSelectedFigure(null);
    setFigureImageDataUrl("");
    aiChat.setAiResult("");
    aiChat.setAiAction("");
    setImageSize({ width: 0, height: 0 });
    zoom.setDisplaySize({ width: 0, height: 0 });
    setPdfPageIndex(0);
    setPdfPageCount(0);
    settings.setErrorMessage("");
    sidebar.setThumbnails([]);
    sidebar.setOutlineItems([]);
    sidebar.setSidebarOpen(false);
    sidebar.setRefSidebarOpen(false);
    // Clear grobid state
    grobid.grobidCancelledRef.current = true;
    grobid.setGrobidDocument(null);
    grobid.setGrobidError("");
    grobid.setGrobidLoading(false);
    grobid.grobidParsedPathRef.current = "";
    // Clear annotation state
    annotations.clearAnnotationState();
    // Clear select mode state
    setSelectMode("box");
    aiChat.setPdfFloatingMenu({ visible: false, x: 0, y: 0, selectedText: "" });
    // Clean up pdfjs document
    if (pdfJsDocRef.current) {
      try {
        if (typeof pdfJsDocRef.current.destroy === "function") {
          pdfJsDocRef.current.destroy().catch(() => {});
        }
      } catch (_) { /* ignore */ }
      pdfJsDocRef.current = null;
    }
  };

  // ── selectDocument — open file dialog and load a document ──────────────────
  const selectDocument = async () => {
    settings.setErrorMessage("");
    const selected = await open({
      multiple: false,
      filters: [{ name: "Documents", extensions: ["pdf", "png", "jpg", "jpeg", "bmp", "webp"] }],
    });

    if (selected && typeof selected === "string") {
      setDocumentPath(selected);
      setPreviewSrc("");
      setBoxes([]);
      setSegments([]);
      setSelectedParagraph(null);
      setSelectedFigure(null);
      setFigureImageDataUrl("");
      aiChat.setAiResult("");
      aiChat.setAiAction("");
      setImageSize({ width: 0, height: 0 });
      zoom.setDisplaySize({ width: 0, height: 0 });
      setPdfPageIndex(0);
      setPdfPageCount(0);

      if (selected.toLowerCase().endsWith(".pdf")) {
         await loadPageData(selected, 0);
         if (settings.modelLoaded) {
           invoke("prefetch_document", {
             filePath: selected,
             currentPage: 0,
             scoreThreshold: settings.scoreThreshold,
           }).catch(() => { /* best-effort */ });
         }
         grobid.triggerGrobidParse(selected);
      } else if (settings.modelLoaded) {
         await runModel(0, selected);
      } else {
         settings.setErrorMessage("布局模型未安装，无法分析图片文件。可先安装布局模型或打开 PDF 文档。");
      }
    }
  };

  // ── Menu handlers ──────────────────────────────────────────────────────────
  const handleMenuOpenChange = (menuKey: Exclude<TopMenuKey, null>, nextOpen: boolean) => {
    setOpenMenu(nextOpen ? menuKey : null);
  };

  const handleMenuHoverSwitch = (menuKey: Exclude<TopMenuKey, null>) => {
    if (openMenu && openMenu !== menuKey) {
      setOpenMenu(menuKey);
    }
  };

  // ── Grobid cross-validate wrapper (updates papers list) ───────────────────
  // Use functional updater to always get the LATEST list (avoids stale closure)
  const crossValidateAndUpdate = useCallback((path: string, doc: import("./types").GrobidDocumentOutput) => {
    papers.setPapersList(prev => grobid.crossValidateGrobidMeta(path, doc, prev));
  }, [grobid.crossValidateGrobidMeta, papers.setPapersList]);

  // ── Grobid batch with engine init ─────────────────────────────────────────
  const batchParseWithInit = useCallback((papersList: PaperInfo[]) => {
    invoke("grobid_ensure_ready").then(() => {
      grobid.startGrobidBatch(papersList, crossValidateAndUpdate);
    }).catch(e => {
      console.error("[Grobid] engine init failed:", e);
    });
  }, [grobid.startGrobidBatch, crossValidateAndUpdate]);

  // ── Priority parse with engine init ───────────────────────────────────────
  const _priorityParseWithInit = useCallback((path: string) => {
    invoke("grobid_ensure_ready").then(() => {
      grobid.priorityGrobidParse(path, papers.papersList, crossValidateAndUpdate);
    }).catch(e => {
      console.error("[Grobid] engine init failed:", e);
    });
  }, [grobid.priorityGrobidParse, papers.papersList, crossValidateAndUpdate]);
  void _priorityParseWithInit;

  // ── Auto-start batch parsing when papers list changes ─────────────────────
  useEffect(() => {
    if (papers.papersList.length > 0) {
      const timer = setTimeout(() => batchParseWithInit(papers.papersList), 2000);
      return () => clearTimeout(timer);
    }
  }, [papers.papersList.length]);

  // ── Grobid auto-trigger when activeTabId changes ───────────────────────────
  useEffect(() => {
    const activeTab = tabs.tabs.find(t => t.id === tabs.activeTabId);
    if (activeTab?.type === "reader" && activeTab.documentPath) {
      grobid.triggerGrobidParse(activeTab.documentPath);
    }
  }, [tabs.activeTabId]);

  // ── Load papers from DB on init ────────────────────────────────────────────
  useEffect(() => {
    if (environmentReady) {
      papers.loadPapersFromDb();
    }
  }, [environmentReady]);

  // ── Load pdfjs document when a PDF file is opened ──────────────────────────
  useEffect(() => {
    if (!documentPath || !isPdfSelected) {
      pdfJsDocRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const base64Data = await invoke<string>("read_file_base64", { filePath: documentPath });
        if (cancelled) return;
        const uint8Array = new Uint8Array(atob(base64Data).length);
        const binStr = atob(base64Data);
        for (let i = 0; i < binStr.length; i++) uint8Array[i] = binStr.charCodeAt(i);
        const loadingTask = getDocument({ data: uint8Array });
        const doc = await loadingTask.promise;
        if (cancelled) { loadingTask.destroy(); return; }
        pdfJsDocRef.current = doc;
      } catch (e) {
        console.warn("[TextLayer] Failed to load pdfjs document:", e);
      }
    })();
    return () => {
      cancelled = true;
      if (pdfJsDocRef.current) {
        try {
          if (typeof pdfJsDocRef.current.destroy === "function") {
            pdfJsDocRef.current.destroy().catch(() => {});
          }
        } catch (_) { /* ignore */ }
        pdfJsDocRef.current = null;
      }
    };
  }, [documentPath, isPdfSelected]);

  // ── Sync layout boxes to ref for hit-testing ─────────────────────────────
  useEffect(() => { layoutBoxesRef.current = boxes; }, [boxes]);

  // ── Render pdfjs TextLayer when in text mode ──────────────────────────────
  useEffect(() => {
    if (selectMode !== "text" || !isPdfSelected || !pdfJsDocRef.current ||
        !textLayerRef.current || zoom.displaySize.width === 0 || zoom.displaySize.height === 0) {
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const container = textLayerRef.current;
        if (!container) return;
        container.innerHTML = "";

        const doc = pdfJsDocRef.current;
        if (!doc) return;

        const page = await doc.getPage(pdfPageIndex + 1);
        if (cancelled) return;

        const textContent = await page.getTextContent();
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const scale = zoom.displaySize.width / baseViewport.width;
        const viewport = page.getViewport({ scale });

        container.style.setProperty("--total-scale-factor", String(scale));
        container.style.setProperty("--scale-round-x", "1px");
        container.style.setProperty("--scale-round-y", "1px");

        const textLayer = new TextLayer({
          textContentSource: textContent,
          container,
          viewport,
        });
        textLayerInstanceRef.current = textLayer;
        await textLayer.render();
        if (!cancelled) {
          pdfTextItemsRef.current = textContent.items;
          pdfViewportScaleRef.current = scale;
          pdfPageHRef.current = baseViewport.height;
          pdfViewportRef.current = viewport;
        }
      } catch (e) {
        if (!cancelled) console.warn("[TextLayer] render failed:", e);
      }
    })();

    return () => {
      cancelled = true;
      textLayerInstanceRef.current = null;
    };
  }, [selectMode, pdfPageIndex, zoom.displaySize.width, zoom.displaySize.height, isPdfSelected]);

  // ── Drag-to-pan (move mode) ────────────────────────────────────────────────
  useEffect(() => {
    const stage = zoom.stageRef.current;
    if (!stage || dragMode !== "move") return;

    let capturedPointerId: number | null = null;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".pdf-toolbar") || target.closest(".page-arrow")) return;
      if (annotations.annotationMode) return;

      e.preventDefault();

      zoom.isDraggingRef.current = true;
      stage.classList.add("visual-stage-dragging");

      stage.setPointerCapture(e.pointerId);
      capturedPointerId = e.pointerId;

      const startX = e.clientX;
      const startY = e.clientY;
      const startScrollLeft = stage.scrollLeft;
      const startScrollTop = stage.scrollTop;

      const onPointerMove = (e: PointerEvent) => {
        if (!zoom.isDraggingRef.current) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        stage.scrollLeft = startScrollLeft - dx;
        stage.scrollTop = startScrollTop - dy;
      };

      const onPointerUp = () => {
        zoom.isDraggingRef.current = false;
        zoom.justDraggedRef.current = true;
        stage.classList.remove("visual-stage-dragging");
        if (capturedPointerId !== null) {
          try { stage.releasePointerCapture(capturedPointerId); } catch { /* already released */ }
          capturedPointerId = null;
        }
        stage.removeEventListener("pointermove", onPointerMove);
        stage.removeEventListener("pointerup", onPointerUp);
        stage.removeEventListener("pointercancel", onPointerUp);
        setTimeout(() => { zoom.justDraggedRef.current = false; }, 150);
      };

      stage.addEventListener("pointermove", onPointerMove);
      stage.addEventListener("pointerup", onPointerUp);
      stage.addEventListener("pointercancel", onPointerUp);
    };

    stage.addEventListener("pointerdown", onPointerDown);
    return () => {
      stage.removeEventListener("pointerdown", onPointerDown);
      stage.classList.remove("visual-stage-dragging");
      if (capturedPointerId !== null) {
        try { stage.releasePointerCapture(capturedPointerId); } catch { /* */ }
        capturedPointerId = null;
      }
    };
  }, [dragMode, tabs.activeTabId, annotations.annotationMode]);

  // ── Floating menu dismiss listeners ────────────────────────────────────────
  const dismissFloatingMenu = () => {
    aiChat.setFloatingMenu({ visible: false, x: 0, y: 0, selectedText: "" });
  };

  useEffect(() => {
    if (!aiChat.floatingMenu.visible) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".floating-ai-menu")) {
        dismissFloatingMenu();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissFloatingMenu();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [aiChat.floatingMenu.visible]);

  useEffect(() => {
    if (!aiChat.pdfFloatingMenu.visible) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".pdf-floating-ai-menu")) {
        aiChat.setPdfFloatingMenu({ visible: false, x: 0, y: 0, selectedText: "" });
        clearPdfSelection();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        aiChat.setPdfFloatingMenu({ visible: false, x: 0, y: 0, selectedText: "" });
        clearPdfSelection();
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [aiChat.pdfFloatingMenu.visible]);

  useEffect(() => {
    if (selectMode !== "text" || !isPdfSelected || annotations.annotationMode) return;

    const handleCopy = (e: ClipboardEvent) => {
      const selectedText = pdfSelectedTextRef.current;
      if (!selectedText.trim()) return;

      const target = e.target as HTMLElement | null;
      if (target && !target.closest(".pdf-text-layer")) return;

      e.preventDefault();
      if (e.clipboardData) {
        e.clipboardData.setData("text/plain", selectedText);
      } else if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(selectedText);
      }
    };

    document.addEventListener("copy", handleCopy);
    return () => document.removeEventListener("copy", handleCopy);
  }, [selectMode, isPdfSelected, annotations.annotationMode]);

  // ── selectFigure — extracts a figure image from the preview ────────────────
  const selectFigure = async (box: LayoutBox) => {
    if (selectedParagraph && aiChat.aiResult) {
      const currentKey = `${aiChat.selectedParagraphPageRef.current}:${selectedParagraph.text}`;
      aiChat.paragraphAiCacheRef.current.set(currentKey, {
        aiAction: aiChat.aiAction,
        aiResult: aiChat.aiResult,
        qaHistory: aiChat.qaHistory,
        qaSourceText: aiChat.qaSourceTextRef.current,
      });
    }
    aiChat.selectedFigurePageRef.current = pdfPageIndex;
    setSelectedParagraph(null);
    setSelectedFigure(box);
    aiChat.setAiResult("");
    aiChat.setAiAction("");

    const naturalW = imageSize.width;
    const naturalH = imageSize.height;
    if (naturalW === 0 || naturalH === 0 || !previewSrc) return;

    try {
      const sx = box.xmin;
      const sy = box.ymin;
      const sw = box.xmax - box.xmin;
      const sh = box.ymax - box.ymin;

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, sw);
      canvas.height = Math.max(1, sh);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const fullImg = new Image();
      fullImg.src = previewSrc;
      await new Promise<void>((resolve, reject) => {
        fullImg.onload = () => resolve();
        fullImg.onerror = () => reject(new Error("image load failed"));
      });
      ctx.drawImage(fullImg, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      setFigureImageDataUrl(canvas.toDataURL("image/png"));
    } catch {
      setFigureImageDataUrl("");
    }
  };

  // ── Text selection handlers ────────────────────────────────────────────────
  const handleTextSelection = (_e: React.MouseEvent) => {
    const selection = window.getSelection();
    if (!selection || !selection.toString().trim()) {
      aiChat.setFloatingMenu(prev => prev.visible ? { ...prev, visible: false } : prev);
      return;
    }

    const selectedText = selection.toString().trim();
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    const paneEl = aiChat.rightPaneRef.current;
    const paneRect = paneEl?.getBoundingClientRect();
    const menuW = 260;
    const menuH = 40;

    let menuX = rect.right + 6;
    let menuY = rect.top - menuH - 4;

    if (paneRect) {
      if (menuX + menuW > paneRect.right - 4) {
        menuX = rect.left - menuW - 6;
      }
      menuX = Math.max(menuX, paneRect.left + 4);
      menuX = Math.min(menuX, paneRect.right - menuW - 4);

      if (menuY < paneRect.top) {
        menuY = rect.bottom + 4;
      }
      menuY = Math.max(menuY, paneRect.top + 4);
      menuY = Math.min(menuY, paneRect.bottom - menuH - 4);
    } else {
      if (menuX + menuW > window.innerWidth - 4) {
        menuX = rect.left - menuW - 6;
      }
      menuX = Math.max(4, Math.min(menuX, window.innerWidth - menuW - 4));
      if (menuY < 0) {
        menuY = rect.bottom + 4;
      }
      menuY = Math.max(4, Math.min(menuY, window.innerHeight - menuH - 4));
    }

    aiChat.setFloatingMenu({
      visible: true,
      x: menuX,
      y: menuY,
      selectedText,
    });
  };


  const handlePdfFloatingAction = (action: string) => {
    if (aiChat.pdfFloatingMenu.selectedText) {
      aiChat.setAiAction(actionLabels[action] || action);
      aiChat.requestAiDescription(aiChat.pdfFloatingMenu.selectedText, action);
    }
    aiChat.setPdfFloatingMenu({ visible: false, x: 0, y: 0, selectedText: "" });
  };

  const showFloatingMenu = (text: string, x: number, y: number) => {
    const menuW = 260;
    const menuH = 40;
    const paneEl = aiChat.rightPaneRef.current;
    const paneRect = paneEl?.getBoundingClientRect();

    let menuX = x + 6;
    let menuY = y - menuH - 4;

    if (paneRect) {
      if (menuX + menuW > paneRect.right - 4) menuX = x - menuW - 6;
      menuX = Math.max(paneRect.left + 4, Math.min(menuX, paneRect.right - menuW - 4));
      if (menuY < paneRect.top) menuY = y + 4;
      menuY = Math.max(paneRect.top + 4, Math.min(menuY, paneRect.bottom - menuH - 4));
    } else {
      if (menuX + menuW > window.innerWidth - 4) menuX = x - menuW - 6;
      menuX = Math.max(4, Math.min(menuX, window.innerWidth - menuW - 4));
      if (menuY < 0) menuY = y + 4;
      menuY = Math.max(4, Math.min(menuY, window.innerHeight - menuH - 4));
    }

    aiChat.setFloatingMenu({ visible: true, x: menuX, y: menuY, selectedText: text });
  };

  const handleFloatingAction = (action: string) => {
    if (aiChat.floatingMenu.selectedText) {
      aiChat.setAiAction(actionLabels[action] || action);
      aiChat.requestAiDescription(aiChat.floatingMenu.selectedText, action);
    }
  };

  // ── getPaneFullText — gather all visible text for batch AI ─────────────────
  const getPaneFullText = (): string => {
    let parts: string[] = [];
    if (selectedParagraph?.text && ocr.splitParagraphWords.length > 0) {
      parts.push(ocr.splitParagraphWords.join(""));
    }
    if (ocr.ocrText && ocr.splitOcrText) {
      parts.push(ocr.splitOcrText);
    }
    return parts.join("\n---\n");
  };

  const handleBatchAiAction = (action: string) => {
    const text = getPaneFullText();
    if (!text.trim()) return;
    aiChat.setAiAction(actionLabels[action] || action);
    aiChat.requestAiDescription(text, action);
  };

  // ── renderOcrNodes — local version with word-click floating menu ───────────
  const renderOcrNodes = useCallback((text: string): React.ReactNode[] => {
    if (!text) return [];

    // Step 0: Preprocess LaTeX → HTML/KaTeX intermediate form
    const processed = latexToHtmlPreprocess(text);

    const nodes: React.ReactNode[] = [];
    let tokenIndex = 0;

    const splitTextIntoWords = (str: string) => {
      try {
        // @ts-ignore
        const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
        // @ts-ignore
        return Array.from(segmenter.segment(str)).map((s: any) => s.segment);
      } catch {
        return str.split(/(?=[\u4e00-\u9fa5])/);
      }
    };

    const pushText = (str: string) => {
      if (!str) return;
      const words = splitTextIntoWords(str);
      words.forEach((word, wIdx) => {
        nodes.push(
          <span
            key={`text-${tokenIndex}-${wIdx}`}
            className="word-span"
            onClick={(e) => {
              if (window.getSelection()?.toString() !== "") return;
              showFloatingMenu(word, e.clientX, e.clientY);
            }}
          >
            {word}
          </span>
        );
      });
      tokenIndex++;
    };

    // Split by HTML table blocks (original + converted from LaTeX tabular)
    const tableParts = processed.split(/(<table[\s\S]*?<\/table>)/);

    for (const part of tableParts) {
      if (/^<table[\s\S]*?<\/table>$/.test(part)) {
        nodes.push(
          <div
            key={`table-${tokenIndex++}`}
            className="ocr-html-table"
            dangerouslySetInnerHTML={{ __html: part }}
          />
        );
        continue;
      }

      // ── Display math ($$...$$) ──
      const displayParts = part.split(/(\$\$[\s\S]*?\$\$)/);
      for (let i = 0; i < displayParts.length; i++) {
        const dPart = displayParts[i];
        if (dPart.startsWith('$$') && dPart.endsWith('$$')) {
          const math = dPart.slice(2, -2);
          try {
            const html = katex.renderToString(math, { displayMode: true, throwOnError: false });
            nodes.push(<span key={`math-d-${tokenIndex++}`} dangerouslySetInnerHTML={{ __html: html }} />);
          } catch { pushText(dPart); }
        } else {
          // ── Inline math ($...$) ──
          const inlineParts = dPart.split(/(\$(?!\$)[\s\S]*?[^\\]\$)/);
          for (let j = 0; j < inlineParts.length; j++) {
            const inPart = inlineParts[j];
            if (inPart.startsWith('$') && inPart.endsWith('$') && !inPart.startsWith('$$')) {
              const inMath = inPart.slice(1, -1);
              try {
                const html = katex.renderToString(inMath, { displayMode: false, throwOnError: false });
                nodes.push(<span key={`math-i-${tokenIndex++}`} dangerouslySetInnerHTML={{ __html: html }} />);
              } catch { pushText(inPart); }
            } else { pushText(inPart); }
          }
        }
      }
    }

    return nodes;
  }, []);

  // ── Redraw annotation canvas when displaySize/annotations change ───────────
  useEffect(() => { annotations.setupAnnotationCanvas(); }, [annotations.setupAnnotationCanvas]);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (!environmentReady) {
    return <EnvironmentCheck onAllChecksPassed={() => setEnvironmentReady(true)} />;
  }

  return (
    <div className="app-root">
      <div className="app-shell">
        <div className="top-menu-bar">
          {/* ── 文件菜单 ── */}
          <Menu
            positioning="below-start"
            open={openMenu === "file"}
            onOpenChange={(_, data) => handleMenuOpenChange("file", data.open)}
          >
            <MenuTrigger>
              <MenuButton
                appearance="transparent"
                className="menu-btn menu-btn-no-icon"
                onMouseEnter={() => handleMenuHoverSwitch("file")}
              >
                文件
              </MenuButton>
            </MenuTrigger>
            <MenuPopover className="menu-popover-smooth">
              <MenuList>
                <MenuItem onClick={() => {
                  tabs.setTabs([{ id: HOME_TAB_ID, title: "主页", type: "home" }]);
                  tabs.setActiveTabId(HOME_TAB_ID);
                  clearCurrentDocument();
                }}>新建</MenuItem>
                <MenuItem onClick={() => void selectDocument()}>打开</MenuItem>
                <MenuItem onClick={() => void papers.handleImportPapers()}>导入文件</MenuItem>
                <div className="menu-divider" />
                <MenuItem onClick={() => setShowReadingReport(true)}>阅读报告</MenuItem>
                <div className="menu-divider" />
                <MenuItem onClick={() => setSettingsOpen(true)}>设置</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>

          {/* ── 编辑菜单 ── */}
          <Menu
            positioning="below-start"
            open={openMenu === "edit"}
            onOpenChange={(_, data) => handleMenuOpenChange("edit", data.open)}
          >
            <MenuTrigger>
              <MenuButton
                appearance="transparent"
                className="menu-btn menu-btn-no-icon"
                onMouseEnter={() => handleMenuHoverSwitch("edit")}
              >
                编辑
              </MenuButton>
            </MenuTrigger>
            <MenuPopover className="menu-popover-smooth">
              <MenuList>
                <MenuItem
                  onClick={annotations.handleAnnotationUndo}
                  disabled={!isPdfSelected || annotations.annotationHistory.length === 0}
                >撤销</MenuItem>
                <MenuItem
                  onClick={annotations.handleAnnotationRedo}
                  disabled={!isPdfSelected || annotations.annotationRedoStack.length === 0}
                >重做</MenuItem>
                <div className="menu-divider" />
                <MenuItem
                  onClick={annotations.handleClearAnnotations}
                  disabled={!isPdfSelected}
                >清除标注</MenuItem>
                <MenuItem
                  onClick={() => void annotations.handleExportAnnotations()}
                  disabled={!isPdfSelected || annotations.exporting}
                >导出标注 PDF</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>

          {/* ── 视图菜单 ── */}
          <Menu
            positioning="below-start"
            open={openMenu === "view"}
            onOpenChange={(_, data) => handleMenuOpenChange("view", data.open)}
          >
            <MenuTrigger>
              <MenuButton
                appearance="transparent"
                className="menu-btn menu-btn-no-icon"
                onMouseEnter={() => handleMenuHoverSwitch("view")}
              >
                视图
              </MenuButton>
            </MenuTrigger>
            <MenuPopover className="menu-popover-smooth">
              <MenuList>
                <MenuItem
                  onClick={zoom.handleZoomIn}
                  disabled={!isPdfSelected}
                >放大</MenuItem>
                <MenuItem
                  onClick={zoom.handleZoomOut}
                  disabled={!isPdfSelected}
                >缩小</MenuItem>
                <MenuItem
                  onClick={() => zoom.handleZoomPreset(1.0)}
                  disabled={!isPdfSelected}
                >重置缩放</MenuItem>
                <div className="menu-divider" />
                <MenuItem
                  onClick={() => sidebar.setSidebarOpen(v => !v)}
                  disabled={!isPdfSelected}
                >{sidebar.sidebarOpen ? "隐藏侧边栏" : "显示侧边栏"}</MenuItem>
                <MenuItem
                  onClick={() => sidebar.setRefSidebarOpen(v => !v)}
                  disabled={!isPdfSelected}
                >{sidebar.refSidebarOpen ? "隐藏参考文献栏" : "显示参考文献栏"}</MenuItem>
                <div className="menu-divider" />
                <MenuItem onClick={() => search.openSearchDialog()}>全局搜索 (Ctrl+F)</MenuItem>
                <MenuItem onClick={() => setCommandPaletteOpen(v => !v)}>命令面板</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>

          {/* ── 工具菜单 ── */}
          <Menu
            positioning="below-start"
            open={openMenu === "tools"}
            onOpenChange={(_, data) => handleMenuOpenChange("tools", data.open)}
          >
            <MenuTrigger>
              <MenuButton
                appearance="transparent"
                className="menu-btn menu-btn-no-icon"
                onMouseEnter={() => handleMenuHoverSwitch("tools")}
              >
                工具
              </MenuButton>
            </MenuTrigger>
            <MenuPopover className="menu-popover-smooth">
              <MenuList>
                <MenuItem
                  onClick={() => void aiChat.handleFulltextAiAction()}
                  disabled={!documentPath || !settings.modelLoaded || settings.loading || aiChat.fulltextExtracting}
                >全文解读</MenuItem>
                <div className="menu-divider" />
                <MenuItem
                  onClick={() => annotations.handleAnnotationModeChange(annotations.annotationMode === "pen" ? null : "pen")}
                  disabled={!isPdfSelected}
                >{annotations.annotationMode === "pen" ? "退出标注" : "画笔标注"}</MenuItem>
                <MenuItem
                  onClick={() => annotations.handleAnnotationModeChange(annotations.annotationMode === "eraser" ? null : "eraser")}
                  disabled={!isPdfSelected}
                >{annotations.annotationMode === "eraser" ? "退出橡皮擦" : "橡皮擦"}</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>

          {/* ── 帮助菜单 ── */}
          <Menu
            positioning="below-start"
            open={openMenu === "help"}
            onOpenChange={(_, data) => handleMenuOpenChange("help", data.open)}
          >
            <MenuTrigger>
              <MenuButton
                appearance="transparent"
                className="menu-btn menu-btn-no-icon"
                onMouseEnter={() => handleMenuHoverSwitch("help")}
              >
                帮助
              </MenuButton>
            </MenuTrigger>
            <MenuPopover className="menu-popover-smooth">
              <MenuList>
                <MenuItem onClick={() => setShowAbout(true)}>关于 xDoc</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>

          <div className="menu-spacer" />
          {settings.loading && <Spinner size="tiny" />}
          {isPdfSelected && (
            aiChat.fulltextExtracting ? (
              <Button
                appearance="transparent"
                className="menu-btn"
                onClick={aiChat.handleFulltextCancel}
                title="取消全文提取"
              >
                <Spinner size="tiny" style={{ marginRight: 4 }} />
                取消 ({aiChat.fulltextProgress.current}/{aiChat.fulltextProgress.total})
              </Button>
            ) : (
              <Button
                appearance="transparent"
                className="menu-btn"
                onClick={() => void aiChat.handleFulltextAiAction()}
                disabled={!documentPath || !settings.modelLoaded || settings.loading}
                title={settings.modelLoaded ? "提取所有页面文本并进行 AI 解读" : "请先加载模型"}
              >
                全文解读
              </Button>
            )
          )}
        </div>

        {/* ── Tab Bar ── */}
        <div
          className="tab-bar"
          ref={tabs.tabBarRef}
          onPointerMove={(e) => {
            if (!tabs.dragStartRef.current) return;
            const { x, y, tabId } = tabs.dragStartRef.current;
            if (!tabs.dragTabId && (Math.abs(e.clientX - x) > 5 || Math.abs(e.clientY - y) > 5)) {
              tabs.setDragTabId(tabId);
            }
            if (tabs.dragTabId) {
              const el = document.elementFromPoint(e.clientX, e.clientY);
              const tabEl = el?.closest("[data-tab-id]") as HTMLElement | null;
              const overId = tabEl?.dataset.tabId ?? null;
              if (overId && overId !== tabs.dragTabId) {
                tabs.setDragOverTabId(overId);
              } else {
                tabs.setDragOverTabId(null);
              }
            }
          }}
          onPointerUp={() => {
            if (tabs.dragTabId && tabs.dragOverTabId && tabs.dragTabId !== tabs.dragOverTabId) {
              tabs.setTabs(prev => {
                const fromIdx = prev.findIndex(t => t.id === tabs.dragTabId);
                const toIdx = prev.findIndex(t => t.id === tabs.dragOverTabId);
                if (fromIdx === -1 || toIdx === -1) return prev;
                const newTabs = [...prev];
                const [moved] = newTabs.splice(fromIdx, 1);
                newTabs.splice(toIdx, 0, moved);
                return newTabs;
              });
            }
            tabs.dragStartRef.current = null;
            tabs.setDragTabId(null);
            tabs.setDragOverTabId(null);
          }}
        >
          {tabs.tabs.map((tab) => (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={`tab-item ${tabs.activeTabId === tab.id ? "active" : ""} ${tabs.dragTabId === tab.id ? "dragging" : ""} ${tabs.dragOverTabId === tab.id && tabs.dragTabId !== tab.id ? "drag-over" : ""}`}
              onClick={() => { if (!tabs.dragTabId) tabs.switchToTab(tab.id, clearCurrentDocument, loadPageData, grobid.triggerGrobidParse); }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                tabs.dragStartRef.current = { x: e.clientX, y: e.clientY, tabId: tab.id };
              }}
            >
              <span className="tab-title">{tab.title}</span>
              {tab.type === "reader" && (
                <button
                  className="tab-close-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    tabs.closeTab(tab.id, clearCurrentDocument, loadPageData, grobid.triggerGrobidParse, settings.modelLoaded, settings.scoreThreshold);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  title="关闭标签"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
          <button
            className="tab-add-btn"
            onClick={() => {
              tabs.addHomeTab(clearCurrentDocument);
            }}
            title="返回主页"
          >
            +
          </button>
          {tabs.activeTabId !== HOME_TAB_ID && isPdfSelected && (
            <button
              className={`tab-ref-toggle-btn ${sidebar.refSidebarOpen ? "active" : ""}`}
              onClick={() => sidebar.setRefSidebarOpen(v => !v)}
              title="文献信息 & 参考文献"
              style={sidebar.refSidebarOpen ? { color: "#00D4BB", background: "rgba(0,212,187,0.12)" } : {}}
            ><BookOpen size={14} /></button>
          )}
        </div>

        {tabs.activeTabId === HOME_TAB_ID ? (
          <Card className="panel-card">
            <HomePage
              papers={papers.papersList}
              onOpenPaper={(paper) => tabs.openPaperTab(paper, loadPageData, grobid.triggerGrobidParse, settings.modelLoaded, settings.scoreThreshold)}
              onImportPapers={papers.handleImportPapers}
              onDeletePaper={papers.handleDeletePaper}
              onDropImport={papers.handleDropImport}
              onExtractMetadata={papers.handleExtractMetadata}
              extractingPaperId={papers.extractingPaperId}
              grobidStatusMap={grobid.grobidStatusMap}
              llmSettings={settings.llmSettings}
              onUpdateTitleTranslation={papers.handleUpdateTitleTranslation}
              onUpdateAbstractTranslation={papers.handleUpdateAbstractTranslation}
              onSelectPaper={handleHomeSelectPaper}
            />
          </Card>
        ) : (
        <Card className="panel-card visual-card">
          <div className="main-layout" ref={mainLayoutRef}>
            <div className="pdf-pane" style={{ 
              width: zoom.leftPaneWidth, 
              flex: typeof zoom.leftPaneWidth === "string" ? `0 0 ${zoom.leftPaneWidth}` : "none" 
            }}>
              <div className="visual-body">
                {settings.errorMessage && (
                  <MessageBar intent="error" className="error-bar">
                    <MessageBarBody>{settings.errorMessage}</MessageBarBody>
                  </MessageBar>
                )}

                {isPdfSelected && previewSrc && (
                  <div className="pdf-toolbar">
                    <Button
                      appearance={sidebar.sidebarOpen ? "subtle" : "transparent"}
                      size="small"
                      className={`toolbar-btn ${sidebar.sidebarOpen ? "toolbar-btn-active" : ""}`}
                      icon={<LayoutPanelLeft size={15} />}
                      onClick={sidebar.toggleSidebar}
                      title="文献大纲"
                    />
                    <div className="pdf-toolbar-separator" />
                    <div className="pdf-toolbar-group">
                      <Button
                        appearance="subtle"
                        size="small"
                        className="toolbar-btn"
                        icon={<ZoomOut size={15} />}
                        onClick={zoom.handleZoomOut}
                        title="缩小"
                      />
                      <Menu positioning="below-end">
                        <MenuTrigger>
                          <Button
                            appearance="subtle"
                            size="small"
                            className="toolbar-btn zoom-label-btn"
                            title="缩放比例"
                          >
                            <span className="zoom-label">{zoom.effectiveZoomPercent}%</span>
                            <ChevronDown size={12} />
                          </Button>
                        </MenuTrigger>
                        <MenuPopover className="menu-popover-smooth">
                          <MenuList>
                            <MenuItem onClick={() => zoom.handleZoomPreset(0.5)}>50%</MenuItem>
                            <MenuItem onClick={() => zoom.handleZoomPreset(0.75)}>75%</MenuItem>
                            <MenuItem onClick={() => zoom.handleZoomPreset(1.0)}>100%</MenuItem>
                            <MenuItem onClick={() => zoom.handleZoomPreset(1.25)}>125%</MenuItem>
                            <MenuItem onClick={() => zoom.handleZoomPreset(1.5)}>150%</MenuItem>
                            <MenuItem onClick={() => zoom.handleZoomPreset(2.0)}>200%</MenuItem>
                            <div className="toolbar-menu-divider" />
                            <MenuItem onClick={() => settings.setZoomMode("fit_page")}>适应页面</MenuItem>
                            <MenuItem onClick={() => settings.setZoomMode("fit_width")}>适应宽度</MenuItem>
                            <MenuItem onClick={() => settings.setZoomMode("fit_height")}>适应高度</MenuItem>
                          </MenuList>
                        </MenuPopover>
                      </Menu>
                      <Button
                        appearance="subtle"
                        size="small"
                        className="toolbar-btn"
                        icon={<ZoomIn size={15} />}
                        onClick={zoom.handleZoomIn}
                        title="放大"
                      />
                    </div>
                    <div className="pdf-toolbar-separator" />
                    <div className="pdf-toolbar-group">
                      <Button
                        appearance={dragMode === "move" ? "subtle" : "transparent"}
                        size="small"
                        className={`toolbar-btn ${dragMode === "move" ? "toolbar-btn-active" : ""}`}
                        icon={<Hand size={15} />}
                        onClick={() => setDragMode("move")}
                        title="移动模式 - 拖拽平移"
                      />
                      <Button
                        appearance={dragMode === "select" ? "subtle" : "transparent"}
                        size="small"
                        className={`toolbar-btn ${dragMode === "select" ? "toolbar-btn-active" : ""}`}
                        icon={<MousePointer size={15} />}
                        onClick={() => setDragMode("select")}
                        title="框选模式 - 选择内容"
                      />
                    </div>
                    <div className="pdf-toolbar-separator" />
                    <div className="pdf-toolbar-group">
                      <Button
                        appearance={selectMode === "text" ? "subtle" : "transparent"}
                        size="small"
                        className={`toolbar-btn ${selectMode === "text" ? "toolbar-btn-active" : ""}`}
                        icon={<Type size={15} />}
                        onClick={() => {
                          setSelectMode("text");
                          aiChat.setPdfFloatingMenu({ visible: false, x: 0, y: 0, selectedText: "" });
                          window.getSelection()?.removeAllRanges();
                          clearPdfSelection();
                        }}
                        title="文字选择模式"
                      />
                      <Button
                        appearance={selectMode === "box" ? "subtle" : "transparent"}
                        size="small"
                        disabled={!settings.modelLoaded}
                        className={`toolbar-btn ${selectMode === "box" && settings.modelLoaded ? "toolbar-btn-active" : ""}`}
                        icon={<Square size={15} />}
                        onClick={() => {
                          setSelectMode("box");
                          aiChat.setPdfFloatingMenu({ visible: false, x: 0, y: 0, selectedText: "" });
                          window.getSelection()?.removeAllRanges();
                          clearPdfSelection();
                        }}
                        title={settings.modelLoaded ? "框选模式" : "需安装布局模型"}
                      />
                    </div>
                    <div className="pdf-toolbar-separator" />
                    <div className="pdf-toolbar-group">
                      <Button
                        appearance={annotations.annotationMode === "pen" ? "subtle" : "transparent"}
                        size="small"
                        className={`toolbar-btn ${annotations.annotationMode === "pen" ? "toolbar-btn-active" : ""}`}
                        icon={<Pencil size={15} />}
                        onClick={() => annotations.handleAnnotationModeChange("pen")}
                        title="画笔"
                      />
                      <Button
                        appearance={annotations.annotationMode === "rect" ? "subtle" : "transparent"}
                        size="small"
                        className={`toolbar-btn ${annotations.annotationMode === "rect" ? "toolbar-btn-active" : ""}`}
                        icon={<Square size={15} />}
                        onClick={() => annotations.handleAnnotationModeChange("rect")}
                        title="矩形"
                      />
                      <Button
                        appearance={annotations.annotationMode === "ellipse" ? "subtle" : "transparent"}
                        size="small"
                        className={`toolbar-btn ${annotations.annotationMode === "ellipse" ? "toolbar-btn-active" : ""}`}
                        icon={<Circle size={15} />}
                        onClick={() => annotations.handleAnnotationModeChange("ellipse")}
                        title="椭圆"
                      />
                      <Button
                        appearance={annotations.annotationMode === "line" ? "subtle" : "transparent"}
                        size="small"
                        className={`toolbar-btn ${annotations.annotationMode === "line" ? "toolbar-btn-active" : ""}`}
                        icon={<Minus size={15} />}
                        onClick={() => annotations.handleAnnotationModeChange("line")}
                        title="直线"
                      />
                      <Button
                        appearance={annotations.annotationMode === "text" ? "subtle" : "transparent"}
                        size="small"
                        className={`toolbar-btn ${annotations.annotationMode === "text" ? "toolbar-btn-active" : ""}`}
                        icon={<Type size={15} />}
                        onClick={() => annotations.handleAnnotationModeChange("text")}
                        title="文字标注"
                      />
                      <Button
                        appearance={annotations.annotationMode === "eraser" ? "subtle" : "transparent"}
                        size="small"
                        className={`toolbar-btn ${annotations.annotationMode === "eraser" ? "toolbar-btn-active" : ""}`}
                        icon={<Eraser size={15} />}
                        onClick={() => annotations.handleAnnotationModeChange("eraser")}
                        title="橡皮擦"
                      />
                      {annotations.annotationMode === "eraser" && (
                        <div className="eraser-mode-toggle">
                          <button
                            className={`eraser-mode-btn ${annotations.eraserMode === "free" ? "active" : ""}`}
                            onClick={() => annotations.setEraserMode("free")}
                            title="自由擦除 — 按轨迹擦除"
                          >自由</button>
                          <button
                            className={`eraser-mode-btn ${annotations.eraserMode === "stroke" ? "active" : ""}`}
                            onClick={() => annotations.setEraserMode("stroke")}
                            title="整条擦除 — 点击删除整条笔画"
                          >整条</button>
                        </div>
                      )}
                    </div>
                    {annotations.annotationMode && (
                      <>
                        <div className="pdf-toolbar-separator" />
                        <div className="pdf-toolbar-group annotation-controls">
                          {annotations.annotationMode !== "eraser" && (
                            <>
                              <div className="annotation-color-swatches">
                                {["#FF3838", "#4D96FF", "#48F90A", "#FFB21D", "#C084FC", "#FFFFFF", "#000000"].map(c => (
                                  <div
                                    key={c}
                                    className={`annotation-swatch ${annotations.annotationColor === c ? "annotation-swatch-active" : ""}`}
                                    style={{ background: c }}
                                    onClick={() => annotations.setAnnotationColor(c)}
                                  />
                                ))}
                              </div>
                              <select
                                className="annotation-size-select"
                                value={annotations.annotationSize}
                                onChange={e => annotations.setAnnotationSize(Number(e.target.value))}
                              >
                                <option value={1}>细</option>
                                <option value={2}>中</option>
                                <option value={4}>粗</option>
                                <option value={6}>特粗</option>
                              </select>
                            </>
                          )}
                        </div>
                        <div className="pdf-toolbar-separator" />
                        <div className="pdf-toolbar-group">
                          <Button
                            appearance="transparent"
                            size="small"
                            className="toolbar-btn"
                            icon={<Undo2 size={15} />}
                            onClick={annotations.handleAnnotationUndo}
                            disabled={annotations.annotationHistory.length === 0}
                            title="撤销"
                          />
                          <Button
                            appearance="transparent"
                            size="small"
                            className="toolbar-btn"
                            icon={<Redo2 size={15} />}
                            onClick={annotations.handleAnnotationRedo}
                            disabled={annotations.annotationRedoStack.length === 0}
                            title="重做"
                          />
                        </div>
                        <div className="pdf-toolbar-separator" />
                        <div className="pdf-toolbar-group">
                          <Button
                            appearance="transparent"
                            size="small"
                            className="toolbar-btn"
                            icon={<Trash2 size={15} />}
                            onClick={annotations.handleClearAnnotations}
                            title="清空所有标注"
                          />
                          <Button
                            appearance="transparent"
                            size="small"
                            className="toolbar-btn"
                            icon={<Download size={15} />}
                            onClick={annotations.handleExportAnnotations}
                            disabled={annotations.exporting}
                            title="导出标注到新 PDF"
                          />
                        </div>
                      </>
                    )}

                    {/* ── Plugin toolbar buttons ── */}
                    {pluginToolbarBtns.filter(b => b.placement === "reader").length > 0 && (
                      <>
                        <div className="pdf-toolbar-separator" />
                        <div className="pdf-toolbar-group">
                          {pluginToolbarBtns
                            .filter(b => b.placement === "reader")
                            .map((btn) => (
                              <Button
                                key={btn.id}
                                appearance="transparent"
                                size="small"
                                className="toolbar-btn"
                                onClick={() => {
                                  const ctx = createPluginContext({
                                    pluginId: btn.id,
                                    getCurrentPdfPath: () => documentPath || null,
                                    getLlmConfig: () => pluginManager.getLlmConfigSnapshot(),
                                  });
                                  btn.action(ctx);
                                }}
                                title={btn.tooltip || btn.label}
                              >
                                {btn.label}
                              </Button>
                            ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                <div className="pdf-view-row">
                {isPdfSelected && previewSrc && sidebar.sidebarOpen && (
                  <div className="pdf-sidebar" style={{ width: sidebar.sidebarWidth }}>
                    <div className="pdf-sidebar-tabs">
                      <button
                        className={`pdf-sidebar-tab ${sidebar.sidebarMode === "thumbnails" ? "active" : ""}`}
                        onClick={() => sidebar.switchSidebarMode("thumbnails")}
                      >
                        <Images size={13} />
                        <span>缩略图</span>
                      </button>
                      <button
                        className={`pdf-sidebar-tab ${sidebar.sidebarMode === "outline" ? "active" : ""}`}
                        onClick={() => sidebar.switchSidebarMode("outline")}
                      >
                        <ListTree size={13} />
                        <span>大纲</span>
                      </button>
                    </div>
                    <div className="pdf-sidebar-content">
                      {sidebar.sidebarLoading ? (
                        <div className="pdf-sidebar-loading"><Spinner size="small" /></div>
                      ) : sidebar.sidebarMode === "thumbnails" ? (
                        <div className="pdf-sidebar-thumbnails">
                          {sidebar.thumbnails.map((thumb, idx) => (
                            <div
                              key={idx}
                              className={`pdf-thumbnail ${idx === pdfPageIndex ? "active" : ""}`}
                              onClick={() => {
                                if (idx !== pdfPageIndex) void loadPageData(documentPath, idx);
                              }}
                            >
                              <img src={thumb} alt={`第 ${idx + 1} 页`} />
                              <span className="pdf-thumbnail-label">{idx + 1}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="pdf-sidebar-outline">
                          {sidebar.outlineItems.length === 0 ? (
                            <div className="pdf-sidebar-empty">此文档无大纲</div>
                          ) : (
                            sidebar.outlineItems.map((item, idx) => (
                              <div
                                key={idx}
                                className={`pdf-outline-item ${item.page_index === pdfPageIndex ? "active" : ""}`}
                                style={{ paddingLeft: 8 + item.depth * 14 }}
                                onClick={() => {
                                  if (item.page_index !== pdfPageIndex) void loadPageData(documentPath, item.page_index);
                                }}
                                title={item.title}
                              >
                                {item.title}
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {isPdfSelected && previewSrc && sidebar.sidebarOpen && (
                  <div
                    className="resizer-v"
                    onMouseDown={sidebar.handleSidebarDragStart}
                  />
                )}

                {isPdfSelected && previewSrc && (
                  <>
                    <Button
                      className="page-arrow page-arrow-left"
                      appearance="subtle"
                      icon={<ChevronLeft24Regular />}
                      onClick={() => {
                        const newPage = Math.max(0, pdfPageIndex - 1);
                        void loadPageData(documentPath, newPage);
                      }}
                      disabled={!documentPath || pdfPageIndex <= 0}
                      aria-label="上一页"
                    />
                    <Button
                      className="page-arrow page-arrow-right"
                      appearance="subtle"
                      icon={<ChevronRight24Regular />}
                      onClick={() => {
                        const newPage = pdfPageIndex + 1;
                        void loadPageData(documentPath, newPage);
                      }}
                      disabled={!documentPath || (pdfPageCount > 0 && pdfPageIndex >= pdfPageCount - 1)}
                      aria-label="下一页"
                    />
                  </>
                )}

                <div className="pdf-stage-column">
                <div
                  ref={zoom.stageRef}
                  className={`visual-stage ${!previewSrc ? "visual-stage-empty" : ""} ${dragMode === "move" && previewSrc ? "visual-stage-move" : ""}`}
                  onClick={(e) => {
                    if (zoom.justDraggedRef.current) return;
                    if (annotations.annotationMode) return;
                    const target = e.target as HTMLElement;
                    if (target.closest(".bbox")) return;
                    if (selectedParagraph && aiChat.aiResult) {
                      const currentKey = `${aiChat.selectedParagraphPageRef.current}:${selectedParagraph.text}`;
                      aiChat.paragraphAiCacheRef.current.set(currentKey, {
                        aiAction: aiChat.aiAction,
                        aiResult: aiChat.aiResult,
                        qaHistory: aiChat.qaHistory,
                        qaSourceText: aiChat.qaSourceTextRef.current,
                      });
                    }
                    setSelectedParagraph(null);
                    setSelectedFigure(null);
                    setFigureImageDataUrl("");
                    if (aiChat.fulltextAiResultRef.current) {
                      aiChat.setAiAction("全文解读");
                      aiChat.setAiResult(aiChat.fulltextAiResultRef.current);
                      aiChat.setQaHistory(aiChat.fulltextQaHistoryRef.current);
                      aiChat.qaSourceTextRef.current = aiChat.fulltextSourceTextRef.current;
                    } else {
                      aiChat.setAiAction("");
                      aiChat.setAiResult("");
                      aiChat.setQaHistory([]);
                    }
                  }}
                >
                  {previewSrc ? (
                    <div className="image-wrap" style={zoom.imageWrapSx}>
                      <img
                        ref={zoom.imgRef}
                        src={previewSrc}
                        alt="Document Preview"
                        className="preview-image"
                        style={zoom.previewImageSx}
                        onLoad={() => {
                          if (zoom.imgRef.current) {
                            zoom.setDisplaySize({
                              width: zoom.imgRef.current.clientWidth,
                              height: zoom.imgRef.current.clientHeight,
                            });
                          }
                        }}
                      />

                      <div className="overlay-layer" style={{ display: selectMode === "text" ? "none" : undefined }}>
                        {segments.map((seg, idx) => {
                          const left = Math.max(0, seg.xmin * zoom.scale.x);
                          const top = Math.max(0, seg.ymin * zoom.scale.y);
                          const width = Math.max(1, (seg.xmax - seg.xmin) * zoom.scale.x);
                          const height = Math.max(1, (seg.ymax - seg.ymin) * zoom.scale.y);

                          const isSelected = selectedParagraph === seg;
                          return (
                            <div
                              key={`text-${idx}`}
                              className="bbox"
                              style={{
                                left,
                                top,
                                width,
                                height,
                                borderColor: isSelected ? "#00D4BB" : "transparent",
                                backgroundColor: isSelected ? "rgba(0, 212, 187, 0.2)" : "rgba(255,255,255,0)",
                                cursor: dragMode === "move" ? undefined : "pointer",
                                pointerEvents: dragMode === "move" ? "none" : "auto",
                              }}
                              onClick={() => {
                                if (selectedParagraph && selectedParagraph !== seg && aiChat.aiResult) {
                                  const currentKey = `${aiChat.selectedParagraphPageRef.current}:${selectedParagraph.text}`;
                                  aiChat.paragraphAiCacheRef.current.set(currentKey, {
                                    aiAction: aiChat.aiAction,
                                    aiResult: aiChat.aiResult,
                                    qaHistory: aiChat.qaHistory,
                                    qaSourceText: aiChat.qaSourceTextRef.current,
                                  });
                                }
                                const newKey = `${pdfPageIndex}:${seg.text}`;
                                const cached = aiChat.paragraphAiCacheRef.current.get(newKey);
                                aiChat.selectedParagraphPageRef.current = pdfPageIndex;
                                setSelectedFigure(null);
                                setFigureImageDataUrl("");
                                setSelectedParagraph(seg);
                                if (cached) {
                                  aiChat.setAiAction(cached.aiAction);
                                  aiChat.setAiResult(cached.aiResult);
                                  aiChat.setQaHistory(cached.qaHistory);
                                  aiChat.qaSourceTextRef.current = cached.qaSourceText;
                                } else {
                                  aiChat.setAiAction("");
                                  aiChat.setAiResult("");
                                  aiChat.setQaHistory([]);
                                  aiChat.qaSourceTextRef.current = "";
                                }
                              }}
                              onMouseEnter={(e) => {
                                if (selectedParagraph !== seg) {
                                  e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.1)";
                                }
                              }}
                              onMouseLeave={(e) => {
                                if (selectedParagraph !== seg) {
                                  e.currentTarget.style.backgroundColor = "transparent";
                                }
                              }}
                            />
                          );
                        })}

                        {boxes.map((box, idx) => {
                          const color = COLORS[box.cls_id % COLORS.length];
                          const left = Math.max(0, box.xmin * zoom.scale.x);
                          const top = Math.max(0, box.ymin * zoom.scale.y);
                          const width = Math.max(1, (box.xmax - box.xmin) * zoom.scale.x);
                          const height = Math.max(1, (box.ymax - box.ymin) * zoom.scale.y);
                          const clickable = isVisualBox(box.cls_id);
                          const isFigSelected = selectedFigure === box;

                          return (
                            <div
                              key={`${box.cls_id}-${box.read_order}-${idx}`}
                              className="bbox"
                              style={{
                                borderColor: isFigSelected ? color : `${color}59`,
                                borderWidth: isFigSelected ? 1 : 1,
                                backgroundColor: isFigSelected ? "rgba(128, 128, 128, 0.12)" : "transparent",
                                left,
                                top,
                                width,
                                height,
                                cursor: dragMode === "move" ? undefined : (clickable ? "pointer" : undefined),
                                pointerEvents: dragMode === "move" ? "none" : (clickable ? "auto" : undefined),
                              }}
                              onClick={clickable ? () => selectFigure(box) : undefined}
                            />
                          );
                        })}
                      </div>
                      {/* PDF Text Layer — visible in text selection mode */}
                      {selectMode === "text" && (
                        <>
                          <div
                            ref={textLayerRef}
                            className="pdf-text-layer"
                            style={{
                              width: zoom.displaySize.width,
                              height: zoom.displaySize.height,
                              pointerEvents: annotations.annotationMode ? "none" : "auto",
                            }}
                            onPointerDown={handlePdfPointerDown}
                            onPointerMove={handlePdfPointerMove}
                            onPointerUp={handlePdfPointerUp}
                          />
                          <div
                            ref={pdfSelectionOverlayRef}
                            className="pdf-selection-overlay"
                            style={{
                              width: zoom.displaySize.width,
                              height: zoom.displaySize.height,
                              pointerEvents: "none",
                            }}
                          />
                        </>
                      )}
                      {/* Annotation canvas overlay — sits above bboxes */}
                      <canvas
                        ref={annotations.annotationCanvasRef}
                        className="annotation-canvas"
                        style={{
                          width: zoom.displaySize.width,
                          height: zoom.displaySize.height,
                          pointerEvents: annotations.annotationMode ? "auto" : "none",
                          cursor: annotations.annotationMode
                            ? annotations.annotationMode === "text"
                              ? "text"
                              : annotations.annotationMode === "eraser"
                                ? ERASER_CURSOR
                                : "crosshair"
                            : undefined,
                        }}
                        onPointerDown={annotations.handleAnnotationPointerDown}
                        onPointerMove={annotations.handleAnnotationPointerMove}
                        onPointerUp={annotations.handleAnnotationPointerUp}
                        onPointerCancel={() => {
                          annotations.annotationDrawingRef.current = false;
                          annotations.annotationCurrentShapeRef.current = null;
                        }}
                      />
                      {/* PDF text selection floating AI menu */}
                      {aiChat.pdfFloatingMenu.visible && (
                        <div
                          className="pdf-floating-ai-menu"
                          style={{ left: aiChat.pdfFloatingMenu.x, top: aiChat.pdfFloatingMenu.y }}
                        >
                          <button
                            className="floating-ai-btn"
                            onClick={(e) => { e.stopPropagation(); handlePdfFloatingAction("解读"); }}
                          >
                            AI 解读
                          </button>
                          <button
                            className="floating-ai-btn"
                            onClick={(e) => { e.stopPropagation(); handlePdfFloatingAction("翻译"); }}
                          >
                            AI 翻译
                          </button>
                          <button
                            className="floating-ai-btn"
                            onClick={(e) => { e.stopPropagation(); handlePdfFloatingAction("摘要"); }}
                          >
                            AI 摘要
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="empty-state">
                      <Button className="empty-open-btn" appearance="primary" onClick={() => void selectDocument()} disabled={settings.loading}>
                        选择文件
                      </Button>
                      <Text className="empty-hint">请选择 PDF 或图片开始</Text>
                    </div>
                  )}
                </div>

                {isPdfSelected && (
                  <div className="page-indicator-bottom">
                    <Text>{pdfPageCount > 0 ? `第 ${pdfPageIndex + 1} / ${pdfPageCount} 页` : "页数未加载"}</Text>
                  </div>
                )}
                </div>
                </div>
              </div>
            </div>

            <div className="resizer-v" onMouseDown={zoom.handleMouseDownV} />

            <div className="right-pane" ref={aiChat.rightPaneRef}>
              {selectMode === "box" && (
                <>
              <div className="text-pane" onMouseUp={handleTextSelection} style={{
                height: zoom.topPaneHeight,
                flex: typeof zoom.topPaneHeight === "string" ? `0 0 ${zoom.topPaneHeight}` : "none",
                fontFamily: settings.textFontFamily
              }}>
                {/* ── Panel header ── */}
                <div className="pane-header">
                  <h3 className="pane-title">选取段落及分词区域</h3>
                  <div className="pane-header-actions">
                    <button
                      className="font-size-btn"
                      onClick={() => settings.setTextFontSize(s => Math.max(10, s - 1))}
                      title="缩小字号"
                    >A-</button>
                    <span className="font-size-label">{settings.textFontSize}</span>
                    <button
                      className="font-size-btn"
                      onClick={() => settings.setTextFontSize(s => Math.min(40, s + 1))}
                      title="放大字号"
                    >A+</button>
                  </div>
                  {selectedFigure ? (
                    <button className="batch-ai-btn" onClick={aiChat.handleImageAiAction}>
                      <Bot size={13} /> 解读图片
                    </button>
                  ) : (selectedParagraph || ocr.ocrText) ? (
                    <>
                      <button className="batch-ai-btn" onClick={() => handleBatchAiAction("解读")}>
                        <Bot size={13} /> 解读
                      </button>
                      <button className="batch-ai-btn" onClick={() => handleBatchAiAction("翻译")}>
                        <Languages size={13} /> 翻译
                      </button>
                      <button className="batch-ai-btn" onClick={() => handleBatchAiAction("摘要")}>
                        <FileText size={13} /> 摘要
                      </button>
                    </>
                  ) : null}
                </div>

                {/* ── Content area ── */}
                <div className="pane-body">
                  {/* ── Figure image display ── */}
                  {selectedFigure ? (
                    <div className="pane-section-card">
                      <div className="pane-section-label">
                        {CLASSES[selectedFigure.cls_id] ?? "figure"} #{selectedFigure.read_order}
                      </div>
                      {figureImageDataUrl ? (
                        <img
                          src={figureImageDataUrl}
                          alt="Selected figure"
                          className="pane-figure-img"
                        />
                      ) : (
                        <div className="pane-placeholder">加载图片中...</div>
                      )}
                    </div>
                  ) : selectedParagraph ? (
                    <>
                      {/* PDF-extracted text with word segmentation */}
                      {settings.pdfTextExtractionEnabled && (
                        <div className="pane-section-card">
                          <div className="pane-section-label">PDF 原文</div>
                          <div className="ocr-latex-content pane-text-content" style={{ fontSize: settings.textFontSize }}>
                            {ocr.splitParagraphWords.map((word, idx) => (
                              <span
                                key={idx}
                                className="word-span"
                                onClick={(e) => {
                                  if (window.getSelection()?.toString() !== "") return;
                                  showFloatingMenu(word, e.clientX, e.clientY);
                                }}
                              >
                                {word}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* OCR result with LaTeX rendering */}
                      {settings.ocrEnabled && (
                        <div className="pane-section-card">
                          <div className="pane-section-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <span>OCR 识别结果</span>
                            {ocr.ocrText && (
                              <div style={{ display: "flex", gap: "4px" }}>
                                <button
                                  className="ref-reparse-btn"
                                  onClick={() => setShowRawOcr(!showRawOcr)}
                                  title={showRawOcr ? "显示解析后的格式" : "显示原始文本"}
                                  style={{ padding: "1px 5px", fontSize: 11 }}
                                >
                                  {showRawOcr ? "格式" : "源文本"}
                                </button>
                                <button
                                  className="ref-reparse-btn"
                                  onClick={ocr.refreshOcr}
                                  disabled={ocr.ocrLoading}
                                  title="忽略缓存，重新识别当前区域"
                                  style={{ padding: "1px 5px", fontSize: 11 }}
                                >
                                  <RefreshCw size={11} className={ocr.ocrLoading ? "spin" : ""} />
                                  刷新
                                </button>
                              </div>
                            )}
                          </div>
                          {ocr.ocrLoading ? (
                            <div className="pane-placeholder">
                              <Spinner size="tiny" />
                              <span>OCR 识别中...</span>
                            </div>
                          ) : ocr.ocrError ? (
                            <div className="pane-placeholder pane-error">{ocr.ocrError}</div>
                          ) : ocr.ocrText ? (
                            <div
                              className={showRawOcr ? "pane-text-content" : "ocr-latex-content pane-text-content"}
                              style={{ fontSize: settings.textFontSize, whiteSpace: showRawOcr ? "pre-wrap" : undefined }}
                            >
                              {showRawOcr
                                ? ocr.ocrText
                                : renderOcrNodes(ocr.splitOcrText)
                              }
                            </div>
                          ) : (
                            <div className="pane-placeholder">点击段落以进行 OCR 识别</div>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="pane-empty">
                      <FileText size={24} style={{ opacity: 0.25 }} />
                      <span>请在左侧预览中点击选中需要阅读的段落块或图片区域</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="resizer-h" onMouseDown={zoom.handleMouseDownH} />
                </>
              )}

              <div className="ai-pane" style={selectMode === "text" ? { flex: 1, fontFamily: settings.aiFontFamily } : { fontFamily: settings.aiFontFamily }}>
                {/* ── Panel header ── */}
                <div className="pane-header">
                  <h3 className="pane-title">{aiChat.aiAction || "AI 解读"}</h3>
                  <div className="pane-header-actions">
                    <button
                      className="font-size-btn"
                      onClick={() => settings.setAiFontSize(s => Math.max(10, s - 1))}
                      title="缩小字号"
                    >A-</button>
                    <span className="font-size-label">{settings.aiFontSize}</span>
                    <button
                      className="font-size-btn"
                      onClick={() => settings.setAiFontSize(s => Math.min(40, s + 1))}
                      title="放大字号"
                    >A+</button>
                  </div>
                </div>

                {/* ── Scrollable content ── */}
                <div className="ai-pane-scroll" ref={aiChat.aiScrollRef}>
                  <div className="ai-content" style={{ fontSize: settings.aiFontSize }}>
                    {aiChat.aiResult
                      ? aiChat.renderAiContent(aiChat.aiResult)
                      : aiChat.fulltextAiResultRef.current
                        ? aiChat.renderAiContent(aiChat.fulltextAiResultRef.current)
                        : (
                          <div className="pane-empty">
                            <Bot size={24} style={{ opacity: 0.25 }} />
                            <span>点击单词或选中文字，选择 AI 解读 / 翻译 / 摘要</span>
                          </div>
                        )}
                  </div>

                  {/* Q&A follow-up history */}
                  {aiChat.qaHistory.length > 0 && (
                    <div className="qa-history" style={{ fontSize: settings.aiFontSize }}>
                      {aiChat.qaHistory.map((qa, idx) => (
                        <div key={idx} className="qa-pair">
                          <div className="qa-question">Q: {qa.question}</div>
                          <div className="qa-answer">
                            {qa.answer ? aiChat.renderAiContent(qa.answer) : <Spinner size="tiny" />}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Q&A input - pinned to bottom */}
                {(aiChat.aiResult || aiChat.fulltextAiResultRef.current) && (
                  <div className="qa-input-row">
                    <input
                      className="qa-input"
                      type="text"
                      placeholder="输入追问..."
                      value={aiChat.qaInput}
                      onChange={e => aiChat.setQaInput(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void aiChat.handleQaSubmit(); } }}
                      disabled={aiChat.qaLoading}
                    />
                    <button
                      className="qa-send-btn"
                      onClick={() => void aiChat.handleQaSubmit()}
                      disabled={aiChat.qaLoading || !aiChat.qaInput.trim()}
                    >
                      {aiChat.qaLoading ? <Spinner size="tiny" /> : "发送"}
                    </button>
                  </div>
                )}
              </div>

              {/* Floating AI Action Menu */}
              {aiChat.floatingMenu.visible && (
                <div
                  className="floating-ai-menu"
                  style={{ left: aiChat.floatingMenu.x, top: aiChat.floatingMenu.y }}
                >
                  <button
                    className="floating-ai-btn"
                    onClick={(e) => { e.stopPropagation(); handleFloatingAction("解读"); }}
                  >
                    🤖 AI 解读
                  </button>
                  <button
                    className="floating-ai-btn"
                    onClick={(e) => { e.stopPropagation(); handleFloatingAction("翻译"); }}
                  >
                    🌐 AI 翻译
                  </button>
                  <button
                    className="floating-ai-btn"
                    onClick={(e) => { e.stopPropagation(); handleFloatingAction("摘要"); }}
                  >
                    📝 AI 摘要
                  </button>
                </div>
              )}
            </div>

            {sidebar.refSidebarOpen && (
              <>
                <div className="resizer-v" onMouseDown={sidebar.handleRefSidebarResize} />
                <ReferenceSidebar
                  paper={currentPaper}
                  documentPath={documentPath}
                  width={sidebar.refSidebarWidth}
                  grobidDocument={grobid.grobidDocument}
                  grobidLoading={grobid.grobidLoading}
                  grobidError={grobid.grobidError}
                  onReparse={() => grobid.triggerGrobidParse(documentPath, true)}
                  onReparseStructure={grobid.triggerGrobidStructureOnly}
                  onClearCacheAndReparse={grobid.handleClearGrobidCacheAndReparse}
                  onClearMetadata={() => {
                    if (currentPaper) papers.handleExtractMetadata(currentPaper.id, true);
                  }}
                  onExtractMetadata={papers.handleExtractMetadata}
                  metadataExtracting={!!currentPaper && papers.extractingPaperId === currentPaper.id}
                />
              </>
            )}
          </div>
        </Card>
        )}
      </div>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        modelPath={settings.modelPath}
        modelLoaded={settings.modelLoaded}
        scoreThreshold={settings.scoreThreshold}
        zoomMode={settings.zoomMode}
        pdfTextExtractionEnabled={settings.pdfTextExtractionEnabled}
        onSelectModel={settings.selectModel}
        onScoreThresholdChange={settings.applyScoreThreshold}
        onZoomModeChange={settings.setZoomMode}
        onPdfTextExtractionEnabledChange={settings.setPdfTextExtractionEnabled}
        textFontFamily={settings.textFontFamily}
        onTextFontFamilyChange={settings.setTextFontFamily}
        textFontSize={settings.textFontSize}
        onTextFontSizeChange={settings.setTextFontSize}
        aiFontFamily={settings.aiFontFamily}
        onAiFontFamilyChange={settings.setAiFontFamily}
        aiFontSize={settings.aiFontSize}
        onAiFontSizeChange={settings.setAiFontSize}
        ocrEnabled={settings.ocrEnabled}
        onOcrEnabledChange={settings.setOcrEnabled}
        ocrModelPath={settings.ocrModelPath}
        onOcrModelPathChange={settings.setOcrModelPath}
        ocrModelId={settings.ocrModelId}
        onOcrModelIdChange={settings.setOcrModelId}
        llmSettings={settings.llmSettings}
        onLlmSettingsChange={settings.setLlmSettings}
      />
      <ReadingReportDialog
        open={showReadingReport}
        onClose={() => setShowReadingReport(false)}
      />
      <AboutDialog
        open={showAbout}
        onClose={() => setShowAbout(false)}
      />

      {/* Plugin UI extensions */}
      <PluginPanelHost />
      <PluginSidebarHost />
      <PluginFloatingWindowHost />
      {/* Command palette (Ctrl+K) */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        currentPdfPath={effectivePdfPath}
      />
      {/* Global search dialog (Ctrl+F) */}
      <GlobalSearchDialog
        open={search.searchDialogOpen}
        onClose={search.closeSearchDialog}
        currentPaper={currentPaper}
        onOpenResult={(pageIndex) => {
          if (documentPath) loadPageData(documentPath, pageIndex);
          search.closeSearchDialog();
        }}
        llmSettings={settings.llmSettings}
        searchIndexMode={settings.searchIndexMode}
        onSearchIndexModeChange={settings.setSearchIndexMode}
        ocrEnabled={settings.ocrEnabled}
      />
    </div>
  );
}

export default App;
