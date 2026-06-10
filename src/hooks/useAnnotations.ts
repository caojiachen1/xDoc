/**
 * useAnnotations — PDF annotation state, drawing, undo/redo, persistence.
 *
 * Manages: annotation tool mode, color, size, shape state, canvas rendering,
 * pointer event handlers, undo/redo history, auto-save to DB, and export.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  annotationSave,
  annotationLoad,
  annotationDelete,
  exportAnnotatedPdf,
  type PageAnnotations,
} from "../utils/paperDb";
import type { AnnotationTool, AnnotationShape, EraserMode } from "../types";
import { ERASER_CURSOR } from "../types";

export function useAnnotations(
  documentPath: string,
  pdfPageIndex: number,
  displaySize: { width: number; height: number },
) {
  // ── State ────────────────────────────────────────────────────────
  const [annotationMode, setAnnotationMode] = useState<AnnotationTool>(null);
  const [annotationColor, setAnnotationColor] = useState("#FF3838");
  const [annotationSize, setAnnotationSize] = useState(2);
  const [annotations, setAnnotations] = useState<AnnotationShape[]>([]);
  const [annotationHistory, setAnnotationHistory] = useState<AnnotationShape[][]>([]);
  const [annotationRedoStack, setAnnotationRedoStack] = useState<AnnotationShape[][]>([]);
  const [eraserMode, setEraserMode] = useState<EraserMode>("free");
  const [exporting, setExporting] = useState(false);

  // ── Refs ─────────────────────────────────────────────────────────
  const pageAnnotationsRef = useRef<Map<number, AnnotationShape[]>>(new Map());
  const annotationPageRef = useRef(0);
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
  const annotationDrawingRef = useRef(false);
  const annotationCurrentShapeRef = useRef<AnnotationShape | null>(null);
  const annotationSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Core state operations ────────────────────────────────────────
  const pushAnnotationState = useCallback((newAnnotations: AnnotationShape[]) => {
    setAnnotationHistory(prev => [...prev.slice(-100), annotations]);
    setAnnotationRedoStack([]);
    setAnnotations(newAnnotations);
    pageAnnotationsRef.current.set(annotationPageRef.current, newAnnotations);
  }, [annotations]);

  const handleAnnotationUndo = useCallback(() => {
    setAnnotationHistory(prev => {
      if (prev.length === 0) return prev;
      const newHistory = [...prev];
      const lastState = newHistory.pop()!;
      setAnnotationRedoStack(r => [...r, annotations]);
      setAnnotations(lastState);
      pageAnnotationsRef.current.set(annotationPageRef.current, lastState);
      return newHistory;
    });
  }, [annotations]);

  const handleAnnotationRedo = useCallback(() => {
    setAnnotationRedoStack(prev => {
      if (prev.length === 0) return prev;
      const newStack = [...prev];
      const nextState = newStack.pop()!;
      setAnnotationHistory(h => [...h, annotations]);
      setAnnotations(nextState);
      pageAnnotationsRef.current.set(annotationPageRef.current, nextState);
      return newStack;
    });
  }, [annotations]);

  const handleAnnotationModeChange = useCallback((mode: AnnotationTool) => {
    annotationDrawingRef.current = false;
    annotationCurrentShapeRef.current = null;
    setAnnotationMode(prev => prev === mode ? null : mode);
  }, []);

  // ── Auto-save (debounced) ────────────────────────────────────────
  useEffect(() => {
    if (!documentPath) return;
    if (annotationSaveTimerRef.current) clearTimeout(annotationSaveTimerRef.current);
    annotationSaveTimerRef.current = setTimeout(() => {
      if (documentPath) {
        annotationSave(documentPath, pdfPageIndex, JSON.stringify(annotations)).catch(e =>
          console.error("Failed to save annotations:", e)
        );
      }
    }, 800);
    return () => {
      if (annotationSaveTimerRef.current) clearTimeout(annotationSaveTimerRef.current);
    };
  }, [annotations, documentPath, pdfPageIndex]);

  // ── Load annotations when document opens ─────────────────────────
  useEffect(() => {
    if (!documentPath) return;
    annotationLoad(documentPath)
      .then(records => {
        const map = new Map<number, AnnotationShape[]>();
        for (const rec of records) {
          try { map.set(rec.page_index, JSON.parse(rec.shapes_json)); } catch { /* skip bad records */ }
        }
        pageAnnotationsRef.current = map;
        annotationPageRef.current = pdfPageIndex;
        setAnnotations(map.get(pdfPageIndex) ?? []);
      })
      .catch(e => console.error("Failed to load annotations:", e));
  }, [documentPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save annotations when switching pages ────────────────────────
  useEffect(() => {
    pageAnnotationsRef.current.set(annotationPageRef.current, annotations);
    annotationPageRef.current = pdfPageIndex;
    setAnnotations(pageAnnotationsRef.current.get(pdfPageIndex) ?? []);
    setAnnotationHistory([]);
    setAnnotationRedoStack([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfPageIndex]);

  // ── Clear all annotations ────────────────────────────────────────
  const handleClearAnnotations = useCallback(() => {
    if (!documentPath) return;
    setAnnotations([]);
    setAnnotationHistory([]);
    setAnnotationRedoStack([]);
    pageAnnotationsRef.current.clear();
    annotationDelete(documentPath).catch(e => console.error("Failed to delete annotations:", e));
  }, [documentPath]);

  // ── Export annotations to PDF ────────────────────────────────────
  const handleExportAnnotations = useCallback(async () => {
    if (!documentPath || exporting) return;
    setExporting(true);
    try {
      const pageAnns: PageAnnotations[] = [];
      pageAnnotationsRef.current.forEach((shapes, pageIdx) => {
        if (shapes.length > 0) {
          pageAnns.push({
            page_index: pageIdx,
            shapes: shapes.map(s => ({ type: s.type, points: s.points, color: s.color, size: s.size, text: s.text })),
          });
        }
      });
      if (pageAnns.length === 0) return;
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({
        defaultPath: documentPath.replace(/\.pdf$/i, "_annotated.pdf"),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!dest) return;
      await exportAnnotatedPdf(documentPath, dest, pageAnns);
    } catch (e) {
      console.error("Export annotations failed:", e);
    } finally {
      setExporting(false);
    }
  }, [documentPath, exporting]);

  // ── Stroke eraser ────────────────────────────────────────────────
  const handleStrokeErase = useCallback((nx: number, ny: number) => {
    const threshold = 0.02;
    const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
      const dx = bx - ax, dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) return Math.hypot(px - ax, py - ay);
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };
    for (let i = annotations.length - 1; i >= 0; i--) {
      const shape = annotations[i];
      if (shape.type === "text" || shape.type === "rect" || shape.type === "ellipse" || shape.type === "line") continue;
      let hit = false;
      for (const pt of shape.points) {
        if (Math.hypot(pt.x - nx, pt.y - ny) < threshold) { hit = true; break; }
      }
      if (!hit) {
        for (let j = 1; j < shape.points.length; j++) {
          const a = shape.points[j - 1], b = shape.points[j];
          if (segDist(nx, ny, a.x, a.y, b.x, b.y) < threshold) { hit = true; break; }
        }
      }
      if (hit) {
        pushAnnotationState(annotations.filter((_, idx) => idx !== i));
        return;
      }
    }
  }, [annotations, pushAnnotationState]);

  // ── Canvas rendering ─────────────────────────────────────────────
  function drawAnnotationShape(c: CanvasRenderingContext2D, s: AnnotationShape, ds: { width: number; height: number }) {
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    c.lineWidth = s.size;
    c.lineCap = "round";
    c.lineJoin = "round";
    if (s.type === "eraser") {
      c.globalCompositeOperation = "destination-out";
      c.strokeStyle = "rgba(0,0,0,1)";
    } else {
      c.globalCompositeOperation = "source-over";
    }
    if ((s.type === "freehand" || s.type === "eraser") && s.points.length > 0) {
      c.beginPath();
      c.moveTo(s.points[0].x * ds.width, s.points[0].y * ds.height);
      for (let i = 1; i < s.points.length; i++) {
        c.lineTo(s.points[i].x * ds.width, s.points[i].y * ds.height);
      }
      c.stroke();
    } else if (s.type === "rect" && s.points.length >= 2) {
      const x = s.points[0].x * ds.width;
      const y = s.points[0].y * ds.height;
      const w = (s.points[1].x - s.points[0].x) * ds.width;
      const h = (s.points[1].y - s.points[0].y) * ds.height;
      c.strokeRect(x, y, w, h);
    } else if (s.type === "ellipse" && s.points.length >= 2) {
      const cx = ((s.points[0].x + s.points[1].x) / 2) * ds.width;
      const cy = ((s.points[0].y + s.points[1].y) / 2) * ds.height;
      const rx = Math.abs(s.points[1].x - s.points[0].x) / 2 * ds.width;
      const ry = Math.abs(s.points[1].y - s.points[0].y) / 2 * ds.height;
      c.beginPath();
      c.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
      c.stroke();
    } else if (s.type === "line" && s.points.length >= 2) {
      c.beginPath();
      c.moveTo(s.points[0].x * ds.width, s.points[0].y * ds.height);
      c.lineTo(s.points[1].x * ds.width, s.points[1].y * ds.height);
      c.stroke();
    } else if (s.type === "text" && s.text) {
      c.globalCompositeOperation = "source-over";
      c.font = `${s.size * 8}px sans-serif`;
      c.textBaseline = "top";
      c.fillText(s.text, s.points[0].x * ds.width, s.points[0].y * ds.height);
    }
    c.globalCompositeOperation = "source-over";
  }

  const setupAnnotationCanvas = useCallback(() => {
    const canvas = annotationCanvasRef.current;
    if (!canvas || displaySize.width === 0 || displaySize.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = displaySize.width * dpr;
    canvas.height = displaySize.height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    annotations.forEach(shape => drawAnnotationShape(ctx, shape, displaySize));
  }, [annotations, displaySize]);

  // Redraw canvas on state change
  useEffect(() => { setupAnnotationCanvas(); }, [setupAnnotationCanvas]);

  // ── Pointer event handlers ───────────────────────────────────────
  const handleAnnotationPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!annotationMode) return;
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    if (annotationMode === "eraser" && eraserMode === "stroke") {
      handleStrokeErase(nx, ny);
      return;
    }

    annotationDrawingRef.current = true;
    canvas.setPointerCapture(e.pointerId);

    if (annotationMode === "text") {
      annotationDrawingRef.current = false;
      canvas.releasePointerCapture(e.pointerId);
      if (canvas.parentElement?.querySelector("textarea[data-ann-text]")) return;
      const textarea = document.createElement("textarea");
      textarea.setAttribute("data-ann-text", "");
      Object.assign(textarea.style, {
        position: "absolute", left: `${nx * 100}%`, top: `${ny * 100}%`,
        color: annotationColor, fontSize: `${annotationSize * 8}px`,
        fontFamily: "sans-serif", background: "transparent", border: "1px solid #000",
        outline: "none", zIndex: "20", minWidth: "120px", minHeight: "28px",
        resize: "both", overflow: "hidden", padding: "2px",
      });
      canvas.parentElement?.appendChild(textarea);
      requestAnimationFrame(() => textarea.focus());
      const finish = () => {
        const text = textarea.value.trim();
        if (text) {
          const shape: AnnotationShape = {
            id: `a-${Date.now()}`, type: "text", points: [{ x: nx, y: ny }],
            color: annotationColor, size: annotationSize, text,
          };
          pushAnnotationState([...annotations, shape]);
        }
        textarea.remove();
      };
      textarea.addEventListener("blur", finish, { once: true });
      return;
    }

    const typeMap = { pen: "freehand" as const, eraser: "eraser" as const, rect: "rect" as const, ellipse: "ellipse" as const, line: "line" as const };
    annotationCurrentShapeRef.current = {
      id: `a-${Date.now()}`, type: typeMap[annotationMode],
      points: [{ x: nx, y: ny }], color: annotationColor, size: annotationSize,
    };
  }, [annotationMode, annotationColor, annotationSize, annotations, pushAnnotationState, eraserMode, handleStrokeErase]);

  const handleAnnotationPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!annotationDrawingRef.current || !annotationCurrentShapeRef.current || !annotationMode) return;
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    const shape = annotationCurrentShapeRef.current;

    if (shape.type === "freehand" || shape.type === "eraser") {
      shape.points.push({ x: nx, y: ny });
    } else {
      shape.points = [shape.points[0], { x: nx, y: ny }];
    }

    // Live preview
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const all = [...annotations, shape];
    all.forEach(s => drawAnnotationShape(ctx, s, displaySize));
  }, [annotations, annotationMode, displaySize]);

  const handleAnnotationPointerUp = useCallback(() => {
    if (!annotationDrawingRef.current || !annotationCurrentShapeRef.current) return;
    annotationDrawingRef.current = false;
    const shape = annotationCurrentShapeRef.current;
    annotationCurrentShapeRef.current = null;

    // Reject degenerate shapes
    if (shape.type === "rect" || shape.type === "ellipse" || shape.type === "line") {
      if (shape.points.length < 2) return;
      const dx = Math.abs(shape.points[1].x - shape.points[0].x);
      const dy = Math.abs(shape.points[1].y - shape.points[0].y);
      if (dx < 0.001 && dy < 0.001) return;
    }
    pushAnnotationState([...annotations, shape]);
  }, [annotations, pushAnnotationState]);

  // ── Reset state (on document close) ──────────────────────────────
  const clearAnnotationState = useCallback(() => {
    setAnnotationMode(null);
    setAnnotations([]);
    setAnnotationHistory([]);
    setAnnotationRedoStack([]);
    pageAnnotationsRef.current.clear();
    annotationPageRef.current = 0;
  }, []);

  return {
    // State
    annotationMode, annotationColor, annotationSize,
    annotations, annotationHistory, annotationRedoStack,
    eraserMode, exporting,
    // Setters
    setAnnotationMode, setAnnotationColor, setAnnotationSize, setEraserMode,
    // Refs
    annotationCanvasRef, annotationDrawingRef, annotationCurrentShapeRef,
    pageAnnotationsRef, annotationPageRef,
    // Handlers
    handleAnnotationModeChange, handleAnnotationUndo, handleAnnotationRedo,
    handleClearAnnotations, handleExportAnnotations,
    handleAnnotationPointerDown, handleAnnotationPointerMove, handleAnnotationPointerUp,
    pushAnnotationState,
    // Canvas
    setupAnnotationCanvas,
    // Reset
    clearAnnotationState,
    // Constant
    ERASER_CURSOR,
  };
}
