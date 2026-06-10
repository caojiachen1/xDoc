/**
 * useZoom — Zoom, pan, display sizing, and pane resize.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZoomMode } from "../types";

export function useZoom(
  imageSize: { width: number; height: number },
  zoomMode: ZoomMode,
  setZoomMode: (mode: ZoomMode) => void,
  activeTabId: string,
  previewSrc: string,
) {
  const [customScale, setCustomScale] = useState(1);
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const requestVersionRef = useRef(0);
  const isDraggingRef = useRef(false);
  const justDraggedRef = useRef(false);

  const zoomModeRef = useRef(zoomMode);
  const customScaleRef = useRef(customScale);
  const currentVisScaleRef = useRef(1);

  useEffect(() => { zoomModeRef.current = zoomMode; }, [zoomMode]);
  useEffect(() => { customScaleRef.current = customScale; }, [customScale]);

  // ── Display size tracking ────────────────────────────────────────
  useEffect(() => {
    if (!imgRef.current) return;
    const updateDisplaySize = () => {
      if (imgRef.current) {
        setDisplaySize({ width: imgRef.current.clientWidth, height: imgRef.current.clientHeight });
      }
    };
    const observer = new ResizeObserver(updateDisplaySize);
    if (stageRef.current) observer.observe(stageRef.current);
    observer.observe(imgRef.current);
    updateDisplaySize();
    return () => observer.disconnect();
  }, [previewSrc, zoomMode, customScale]);

  useEffect(() => {
    if (imageSize.width > 0 && displaySize.width > 0) {
      currentVisScaleRef.current = displaySize.width / imageSize.width;
    }
  }, [displaySize.width, imageSize.width]);

  // ── Ctrl+Wheel zoom ─────────────────────────────────────────────
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.15 : 0.15;
        const factor = 1 + delta;
        const oldScale = currentVisScaleRef.current || 1;
        let baseScale = zoomModeRef.current === "custom" ? customScaleRef.current : oldScale;
        const newScale = Math.max(0.1, Math.min(baseScale * factor, 8.0));
        const ratio = newScale / oldScale;

        const rect = stage.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;
        const oldScrollLeft = stage.scrollLeft;
        const oldScrollTop = stage.scrollTop;

        const img = imgRef.current;
        const wrap = img?.parentElement;
        if (img && imageSize.width > 0 && imageSize.height > 0) {
          const newW = imageSize.width * newScale;
          const newH = imageSize.height * newScale;
          img.style.width = `${newW}px`;
          img.style.height = `${newH}px`;
          img.style.maxWidth = "none";
          img.style.maxHeight = "none";
          if (wrap) { wrap.style.width = `${newW}px`; wrap.style.height = `${newH}px`; }
        }

        stage.scrollLeft = (oldScrollLeft + cursorX) * ratio - cursorX;
        stage.scrollTop = (oldScrollTop + cursorY) * ratio - cursorY;

        zoomModeRef.current = "custom";
        setZoomMode("custom");
        setCustomScale(newScale);
      }
    };
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [activeTabId, imageSize.width, imageSize.height, setZoomMode]);

  // ── Zoom buttons ─────────────────────────────────────────────────
  const handleZoomIn = useCallback(() => {
    setZoomMode("custom");
    setCustomScale((prev) => {
      const base = zoomModeRef.current === "custom" ? prev : (currentVisScaleRef.current || 1);
      return Math.min(base * 1.25, 8.0);
    });
  }, [setZoomMode]);

  const handleZoomOut = useCallback(() => {
    setZoomMode("custom");
    setCustomScale((prev) => {
      const base = zoomModeRef.current === "custom" ? prev : (currentVisScaleRef.current || 1);
      return Math.max(base / 1.25, 0.1);
    });
  }, [setZoomMode]);

  const handleZoomPreset = useCallback((scale: number) => {
    setZoomMode("custom");
    setCustomScale(scale);
  }, [setZoomMode]);

  const effectiveZoomPercent = useMemo(() => {
    if (imageSize.width === 0 || displaySize.width === 0) return 100;
    return Math.round((displaySize.width / imageSize.width) * 100);
  }, [displaySize.width, imageSize.width]);

  // ── Computed styles ──────────────────────────────────────────────
  const scale = useMemo(() => {
    if (imageSize.width === 0 || imageSize.height === 0) return { x: 1, y: 1 };
    return { x: displaySize.width / imageSize.width, y: displaySize.height / imageSize.height };
  }, [displaySize.height, displaySize.width, imageSize.height, imageSize.width]);

  const imageWrapSx = useMemo(() => {
    if (zoomMode === "custom") return { width: imageSize.width * customScale, height: imageSize.height * customScale } as const;
    if (zoomMode === "fit_width") return { width: "100%" } as const;
    if (zoomMode === "fit_height") return { width: "max-content", height: "100%" } as const;
    return { width: "max-content" } as const;
  }, [zoomMode, customScale, imageSize.width, imageSize.height]);

  const previewImageSx = useMemo(() => {
    if (zoomMode === "custom") return { width: imageSize.width * customScale, height: imageSize.height * customScale, maxWidth: "none", maxHeight: "none" } as const;
    if (zoomMode === "fit_width") return { width: "100%", height: "auto", maxWidth: "none", maxHeight: "none" } as const;
    if (zoomMode === "fit_height") return { width: "auto", height: "100%", maxWidth: "none", maxHeight: "none" } as const;
    if (zoomMode === "fit_page") return { width: "auto", height: "auto", maxWidth: "100%", maxHeight: "100%" } as const;
    return { width: "auto", height: "auto", maxWidth: "none", maxHeight: "none" } as const;
  }, [zoomMode, customScale, imageSize.width, imageSize.height]);

  // ── Pane resize handlers ─────────────────────────────────────────
  const [leftPaneWidth, setLeftPaneWidth] = useState<number | string>("50%");
  const [topPaneHeight, setTopPaneHeight] = useState<number | string>("50%");

  const handleMouseDownV = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const prevSibling = e.currentTarget.previousElementSibling as HTMLElement;
    const startWidth = prevSibling?.offsetWidth || 0;
    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      if (startWidth > 0) setLeftPaneWidth(`${Math.max(200, startWidth + delta)}px`);
    };
    const onMouseUp = () => { document.removeEventListener("mousemove", onMouseMove); document.removeEventListener("mouseup", onMouseUp); };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  const handleMouseDownH = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const prevSibling = e.currentTarget.previousElementSibling as HTMLElement;
    const startHeight = prevSibling?.offsetHeight || 0;
    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY;
      if (startHeight > 0) setTopPaneHeight(`${Math.max(100, startHeight + delta)}px`);
    };
    const onMouseUp = () => { document.removeEventListener("mousemove", onMouseMove); document.removeEventListener("mouseup", onMouseUp); };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  return {
    customScale, setCustomScale,
    displaySize, setDisplaySize,
    stageRef, imgRef, requestVersionRef,
    isDraggingRef, justDraggedRef,
    handleZoomIn, handleZoomOut, handleZoomPreset,
    effectiveZoomPercent,
    scale, imageWrapSx, previewImageSx,
    leftPaneWidth, setLeftPaneWidth,
    topPaneHeight, setTopPaneHeight,
    handleMouseDownV, handleMouseDownH,
  };
}
