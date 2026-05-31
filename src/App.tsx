import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { fetch } from "@tauri-apps/plugin-http";
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
import { Bot, Languages, FileText } from "lucide-react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { marked } from "marked";
import SettingsDialog, { STORAGE_KEYS as OCR_STORAGE_KEYS, VENDOR_PRESETS, type LlmSettings } from "./components/SettingsDialog";
import EnvironmentCheck from "./components/EnvironmentCheck";
import "./App.css";

interface LayoutBox {
  cls_id: number;
  score: number;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  read_order: number;
}

interface TextSegment {
  text: string;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

interface ExtractContentResponse {
  width: number;
  height: number;
  preview_data_url: string;
  page_index: number;
  page_count: number;
  segments: TextSegment[];
}

interface DetectionResponse {
  width: number;
  height: number;
  preview_data_url: string;
  source_type: "pdf" | "image" | string;
  page_index: number;
  page_count: number;
  boxes: LayoutBox[];
}

const CLASSES = [
  "abstract",          // 0
  "algorithm",         // 1
  "aside_text",        // 2
  "chart",             // 3
  "content",           // 4
  "display_formula",   // 5
  "doc_title",         // 6
  "figure_title",      // 7
  "footer",            // 8
  "footer_image",      // 9
  "footnote",          // 10
  "formula_number",    // 11
  "header",            // 12
  "header_image",      // 13
  "image",             // 14
  "inline_formula",    // 15
  "number",            // 16
  "paragraph_title",   // 17
  "reference",         // 18
  "reference_content", // 19
  "seal",              // 20
  "table",             // 21
  "text",              // 22
  "vertical_text",     // 23
  "vision_footnote",   // 24
];

const COLORS = [
  "#FF3838",
  "#FF9D97",
  "#FF701F",
  "#FFB21D",
  "#CFD231",
  "#48F90A",
  "#92CC17",
  "#3DDB86",
  "#1A9334",
  "#00D4BB",
  "#2C99A8",
  "#FF6B6B",
  "#FFD93D",
  "#6BCB77",
  "#4D96FF",
  "#C084FC",
  "#FB923C",
  "#34D399",
  "#F472B6",
  "#818CF8",
  "#FBBF24",
  "#A78BFA",
  "#60A5FA",
  "#F87171",
  "#38BDF8",
];

type ZoomMode = "fit_page" | "fit_width" | "fit_height" | "actual" | "custom";
type TopMenuKey = "file" | "settings" | "help" | null;

export const STORAGE_KEYS = {
  modelPath: "xdoc.settings.modelPath",
  scoreThreshold: "xdoc.settings.scoreThreshold",
  zoomMode: "xdoc.settings.zoomMode",
  pdfTextExtractionEnabled: "xdoc.settings.pdfTextExtractionEnabled",
  llmVendor: "xdoc.settings.llm.vendor",
  llmVendorApiKeys: "xdoc.settings.llm.vendorApiKeys",
  llmBaseUrl: "xdoc.settings.llm.baseUrl",
  llmModel: "xdoc.settings.llm.model",
  textFontSize: "xdoc.settings.textFontSize",
  aiFontSize: "xdoc.settings.aiFontSize",
} as const;

function App() {
  const [environmentReady, setEnvironmentReady] = useState(false);
  const [modelPath, setModelPath] = useState("");
  const [documentPath, setDocumentPath] = useState("");
  const [previewSrc, setPreviewSrc] = useState("");
  const [boxes, setBoxes] = useState<LayoutBox[]>([]);
  const [segments, setSegments] = useState<TextSegment[]>([]);
  const [selectedParagraph, setSelectedParagraph] = useState<TextSegment | null>(null);
  const [selectedFigure, setSelectedFigure] = useState<LayoutBox | null>(null);
  const [figureImageDataUrl, setFigureImageDataUrl] = useState<string>("");
  const [aiAction, setAiAction] = useState<string>("");
  const [aiResult, setAiResult] = useState<string>("");

  // Q&A follow-up state
  const [qaHistory, setQaHistory] = useState<{ question: string; answer: string }[]>([]);
  const [qaInput, setQaInput] = useState("");
  const [qaLoading, setQaLoading] = useState(false);
  const qaSourceTextRef = useRef("");
  const aiScrollRef = useRef<HTMLDivElement>(null);
  // Fulltext memory — persists across selection changes
  const fulltextAiResultRef = useRef("");
  const fulltextQaHistoryRef = useRef<{ question: string; answer: string }[]>([]);
  const fulltextSourceTextRef = useRef("");
  const [loading, setLoading] = useState(false);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [scoreThreshold, setScoreThreshold] = useState(0.5);
  const [pdfTextExtractionEnabled, setPdfTextExtractionEnabled] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const [pdfPageIndex, setPdfPageIndex] = useState(0);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit_page");
  const [customScale, setCustomScale] = useState(1);
  const [openMenu, setOpenMenu] = useState<TopMenuKey>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // OCR settings
  const [ocrEnabled, setOcrEnabled] = useState(true);
  const [ocrModelPath, setOcrModelPath] = useState("");

  // OCR runtime state
  const [ocrText, setOcrText] = useState("");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrInitialized, setOcrInitialized] = useState(false);
  const [ocrError, setOcrError] = useState("");

  // Fulltext extraction state
  const [fulltextExtracting, setFulltextExtracting] = useState(false);
  const [fulltextProgress, setFulltextProgress] = useState({ current: 0, total: 0 });
  const fulltextCancelRef = useRef(false);

  // LLM settings
  const [llmSettings, setLlmSettings] = useState<LlmSettings>({
    vendor: "deepseek",
    vendorApiKeys: {},
    baseUrl: VENDOR_PRESETS.deepseek.baseUrl,
    model: VENDOR_PRESETS.deepseek.models[0],
  });

  // Floating menu state
  const [floatingMenu, setFloatingMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    selectedText: string;
  }>({ visible: false, x: 0, y: 0, selectedText: "" });

  // Font size state
  const [textFontSize, setTextFontSize] = useState(15);
  const [aiFontSize, setAiFontSize] = useState(14);

  // Resize state
  const [leftPaneWidth, setLeftPaneWidth] = useState<number | string>("60%");
  const [topPaneHeight, setTopPaneHeight] = useState<number | string>("50%");

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const mainLayoutRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  const requestVersionRef = useRef(0);

  const isPdfSelected = useMemo(() => documentPath.toLowerCase().endsWith(".pdf"), [documentPath]);

  const isVisualBox = (clsId: number) => {
    // chart, display_formula, footer_image, header_image, image, inline_formula, seal, table
    const visual = new Set([3, 5, 9, 13, 14, 15, 20, 21]);
    return visual.has(clsId);
  };

  const isGarbageBox = (clsId: number) => {
    // footer, footer_image, header, header_image, number (page number), seal, formula_number
    const garbage = new Set([8, 9, 12, 13, 16, 20, 11]);
    return garbage.has(clsId);
  };

  const isSegmentGarbage = (seg: TextSegment, layoutBoxes: LayoutBox[]): boolean => {
    const cx = (seg.xmin + seg.xmax) / 2;
    const cy = (seg.ymin + seg.ymax) / 2;
    return layoutBoxes.some(
      (box) =>
        isGarbageBox(box.cls_id) &&
        cx >= box.xmin && cx <= box.xmax &&
        cy >= box.ymin && cy <= box.ymax
    );
  };

  const selectFigure = async (box: LayoutBox) => {
    setSelectedParagraph(null);
    setSelectedFigure(box);
    setAiResult("");
    setAiAction("");

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

  const selectModel = async () => {
    setErrorMessage("");
    const selected = await open({
      multiple: false,
      filters: [{ name: "ONNX Model", extensions: ["onnx"] }],
    });

    if (selected && typeof selected === "string") {
      setModelPath(selected);
      try {
        setLoading(true);
        await invoke("load_model", { modelPath: selected });
        setModelLoaded(true);
      } catch (e) {
        setModelLoaded(false);
        setErrorMessage(`模型加载失败: ${String(e)}`);
      } finally {
        setLoading(false);
      }
    }
  };

  const runModel = async (targetPageIndex?: number, targetFilePath?: string, thresholdOverride?: number) => {
    const activeFilePath = targetFilePath ?? documentPath;
    if (!modelLoaded || !activeFilePath) return;

    const activeIsPdf = activeFilePath.toLowerCase().endsWith(".pdf");
    const activeThreshold = thresholdOverride ?? scoreThreshold;

    setErrorMessage("");
    try {
      setLoading(true);
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
      setErrorMessage(`检测失败: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const loadPageData = async (filePath: string, newPage: number) => {
    const version = ++requestVersionRef.current;
    const isCurrent = () => requestVersionRef.current === version;
    const isPdf = filePath.toLowerCase().endsWith(".pdf");

    // Immediately update page index for instant UI feedback
    setPdfPageIndex(newPage);
    setSelectedParagraph(null);
    setSelectedFigure(null);
    setFigureImageDataUrl("");
    // Preserve fulltext AI result across page navigation
    if (aiAction !== "全文解读") {
      setAiResult("");
      setAiAction("");
    }
    setErrorMessage("");
    setLoading(true);

    try {
      if (isPdf && modelLoaded) {
        // Step 1: text extraction + inference (populates inference_cache as side effect)
        const textResult = await invoke<ExtractContentResponse>("get_pdf_paragraphs", {
          filePath,
          pageIndex: newPage,
          scoreThreshold,
        });
        if (!isCurrent()) return;

        setPreviewSrc(textResult.preview_data_url);
        setImageSize({ width: textResult.width, height: textResult.height });
        setPdfPageIndex(textResult.page_index);
        setPdfPageCount(textResult.page_count);
        setSegments(textResult.segments);

        // Step 2: layout boxes — cache hit now that step 1 populated inference_cache
        const modelResult = await invoke<DetectionResponse>("run_doclayout", {
          filePath,
          scoreThreshold,
          pageIndex: newPage,
        });
        if (!isCurrent()) return;

        setPreviewSrc(modelResult.preview_data_url);
        setBoxes(modelResult.boxes);
      } else if (isPdf) {
        // No model loaded — just get text
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
      } else if (modelLoaded) {
        // Image file
        const modelResult = await invoke<DetectionResponse>("run_doclayout", {
          filePath,
          scoreThreshold,
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
      setErrorMessage(`页面加载失败: ${String(e)}`);
    } finally {
      if (isCurrent()) {
        setLoading(false);
      }
    }
  };

  const clearCurrentDocument = () => {
    setDocumentPath("");
    setPreviewSrc("");
    setBoxes([]);
    setSegments([]);
    setSelectedParagraph(null);
    setSelectedFigure(null);
    setFigureImageDataUrl("");
    setAiResult("");
    setAiAction("");
    setImageSize({ width: 0, height: 0 });
    setDisplaySize({ width: 0, height: 0 });
    setPdfPageIndex(0);
    setPdfPageCount(0);
    setErrorMessage("");
  };

  const applyScoreThreshold = async (nextThreshold: number) => {
    setScoreThreshold(nextThreshold);
    if (documentPath && modelLoaded) {
      await runModel(isPdfSelected ? pdfPageIndex : 0, documentPath, nextThreshold);
    }
  };

  const selectDocument = async () => {
    setErrorMessage("");
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
      setAiResult("");
      setAiAction("");
      setImageSize({ width: 0, height: 0 });
      setDisplaySize({ width: 0, height: 0 });
      setPdfPageIndex(0);
      setPdfPageCount(0);

      if (selected.toLowerCase().endsWith(".pdf")) {
         await loadPageData(selected, 0);
         // Aggressive prefetch: fire background sweep of all remaining pages
         if (modelLoaded) {
           invoke("prefetch_document", {
             filePath: selected,
             currentPage: 0,
             scoreThreshold,
           }).catch(() => { /* best-effort */ });
         }
      } else if (modelLoaded) {
         await runModel(0, selected);
      } else {
         setErrorMessage("请先在菜单栏的“设置 > ONNX 模型”中加载模型");
      }
    }
  };

  const handleMenuOpenChange = (menuKey: Exclude<TopMenuKey, null>, nextOpen: boolean) => {
    setOpenMenu(nextOpen ? menuKey : null);
  };

  const handleMenuHoverSwitch = (menuKey: Exclude<TopMenuKey, null>) => {
    if (openMenu && openMenu !== menuKey) {
      setOpenMenu(menuKey);
    }
  };

  useEffect(() => {
    if (!environmentReady) return;
    try {
      const savedThreshold = window.localStorage.getItem(STORAGE_KEYS.scoreThreshold);
      if (savedThreshold !== null) {
        const parsed = Number(savedThreshold);
        if (!Number.isNaN(parsed)) {
          setScoreThreshold(Math.min(1, Math.max(0, parsed)));
        }
      }

      const savedPdfText = window.localStorage.getItem(STORAGE_KEYS.pdfTextExtractionEnabled);
      setPdfTextExtractionEnabled(savedPdfText === null ? true : savedPdfText === "true");

      const savedZoom = window.localStorage.getItem(STORAGE_KEYS.zoomMode) as ZoomMode | null;
      if (savedZoom && ["fit_page", "fit_width", "fit_height", "actual", "custom"].includes(savedZoom)) {
        setZoomMode(savedZoom);
      }

      const savedModelPath = window.localStorage.getItem(STORAGE_KEYS.modelPath)
        || "model/PP-DocLayoutV3.onnx";
      setModelPath(savedModelPath);
      setLoading(true);
      invoke("load_model", { modelPath: savedModelPath })
        .then(() => {
          setModelLoaded(true);
        })
        .catch((e) => {
          setModelLoaded(false);
          setErrorMessage(`自动加载模型失败: ${String(e)}`);
        })
        .finally(() => {
          setLoading(false);
        });

      // OCR settings
      const savedOcrEnabled = window.localStorage.getItem(OCR_STORAGE_KEYS.ocrEnabled);
      setOcrEnabled(savedOcrEnabled === null ? true : savedOcrEnabled === "true");
      const savedOcrPath = window.localStorage.getItem(OCR_STORAGE_KEYS.ocrModelPath)
        || "model/GLM-OCR-GGUF";
      setOcrModelPath(savedOcrPath);

      // Font size settings
      const savedTextFontSize = window.localStorage.getItem(STORAGE_KEYS.textFontSize);
      if (savedTextFontSize !== null) {
        const parsed = Number(savedTextFontSize);
        if (!Number.isNaN(parsed)) {
          setTextFontSize(Math.max(10, Math.min(40, parsed)));
        }
      }
      const savedAiFontSize = window.localStorage.getItem(STORAGE_KEYS.aiFontSize);
      if (savedAiFontSize !== null) {
        const parsed = Number(savedAiFontSize);
        if (!Number.isNaN(parsed)) {
          setAiFontSize(Math.max(10, Math.min(40, parsed)));
        }
      }

      // LLM settings
      const savedLlmVendor = window.localStorage.getItem(STORAGE_KEYS.llmVendor) || "deepseek";
      let savedVendorApiKeys: Record<string, string> = {};
      try {
        const raw = window.localStorage.getItem(STORAGE_KEYS.llmVendorApiKeys);
        if (raw) savedVendorApiKeys = JSON.parse(raw);
      } catch { /* ignore parse errors */ }
      const savedLlmBaseUrl = window.localStorage.getItem(STORAGE_KEYS.llmBaseUrl)
        || VENDOR_PRESETS[savedLlmVendor]?.baseUrl
        || VENDOR_PRESETS.deepseek.baseUrl;
      const savedLlmModel = window.localStorage.getItem(STORAGE_KEYS.llmModel)
        || VENDOR_PRESETS[savedLlmVendor]?.models?.[0]
        || VENDOR_PRESETS.deepseek.models[0];
      setLlmSettings({
        vendor: savedLlmVendor,
        vendorApiKeys: savedVendorApiKeys,
        baseUrl: savedLlmBaseUrl,
        model: savedLlmModel,
      });
    } catch {
      // ignore storage failures
    }
  }, [environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    try {
      window.localStorage.setItem(STORAGE_KEYS.scoreThreshold, String(scoreThreshold));
    } catch {
      // ignore storage failures
    }
  }, [scoreThreshold, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    try {
      window.localStorage.setItem(STORAGE_KEYS.pdfTextExtractionEnabled, String(pdfTextExtractionEnabled));
    } catch {
      // ignore storage failures
    }
  }, [pdfTextExtractionEnabled, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    try {
      window.localStorage.setItem(STORAGE_KEYS.zoomMode, zoomMode);
    } catch {
      // ignore storage failures
    }
  }, [zoomMode, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    try {
      if (modelPath) {
        window.localStorage.setItem(STORAGE_KEYS.modelPath, modelPath);
      } else {
        window.localStorage.removeItem(STORAGE_KEYS.modelPath);
      }
    } catch {
      // ignore storage failures
    }
  }, [modelPath, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    try {
      window.localStorage.setItem(OCR_STORAGE_KEYS.ocrEnabled, String(ocrEnabled));
    } catch { /* ignore */ }
  }, [ocrEnabled, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    try {
      window.localStorage.setItem(OCR_STORAGE_KEYS.ocrModelPath, ocrModelPath);
    } catch { /* ignore */ }
  }, [ocrModelPath, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    try {
      window.localStorage.setItem(STORAGE_KEYS.llmVendor, llmSettings.vendor);
      window.localStorage.setItem(STORAGE_KEYS.llmVendorApiKeys, JSON.stringify(llmSettings.vendorApiKeys));
      window.localStorage.setItem(STORAGE_KEYS.llmBaseUrl, llmSettings.baseUrl);
      window.localStorage.setItem(STORAGE_KEYS.llmModel, llmSettings.model);
    } catch { /* ignore */ }
  }, [llmSettings, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    try {
      window.localStorage.setItem(STORAGE_KEYS.textFontSize, String(textFontSize));
    } catch { /* ignore */ }
  }, [textFontSize, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    try {
      window.localStorage.setItem(STORAGE_KEYS.aiFontSize, String(aiFontSize));
    } catch { /* ignore */ }
  }, [aiFontSize, environmentReady]);

  // Initialize OCR backend when enabled and model path is set
  useEffect(() => {
    if (ocrEnabled && ocrModelPath) {
      setOcrError("");
      invoke<string>("init_ocr", { ocrModelPath })
        .then((msg) => {
          console.log("[OCR] initialized:", msg);
          setOcrInitialized(true);
        })
        .catch((e) => {
          console.error("[OCR] init failed:", e);
          setOcrError(`OCR 初始化失败: ${String(e)}`);
          setOcrInitialized(false);
        });
    } else {
      setOcrInitialized(false);
    }
  }, [ocrEnabled, ocrModelPath]);

  // Run OCR when a paragraph is selected and OCR is enabled
  useEffect(() => {
    if (!selectedParagraph || !ocrEnabled || !ocrInitialized || !documentPath) {
      setOcrText("");
      return;
    }

    let cancelled = false;
    setOcrLoading(true);
    setOcrError("");
    setOcrText("");

    const unlistenPromise = listen<{ piece: string }>("ocr-stream-token", (event) => {
      if (!cancelled) {
        setOcrText(prev => prev + event.payload.piece);
      }
    });

    invoke<{ text: string }>("run_ocr_region", {
      filePath: documentPath,
      pageIndex: pdfPageIndex,
      xmin: selectedParagraph.xmin,
      ymin: selectedParagraph.ymin,
      xmax: selectedParagraph.xmax,
      ymax: selectedParagraph.ymax,
    })
      .then((result) => {
        if (!cancelled) {
          setOcrText(result.text);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setOcrError(`OCR 识别失败: ${String(e)}`);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setOcrLoading(false);
        }
        unlistenPromise.then(unlisten => unlisten());
      });

    return () => {
      cancelled = true;
      unlistenPromise.then(unlisten => unlisten());
    };
  }, [selectedParagraph, ocrEnabled, ocrInitialized, documentPath, pdfPageIndex]);

  useEffect(() => {
    if (!imgRef.current) return;

    const updateDisplaySize = () => {
      if (imgRef.current) {
        setDisplaySize({
          width: imgRef.current.clientWidth,
          height: imgRef.current.clientHeight,
        });
      }
    };

    const observer = new ResizeObserver(updateDisplaySize);
    if (stageRef.current) observer.observe(stageRef.current);
    observer.observe(imgRef.current);

    updateDisplaySize();
    return () => observer.disconnect();
  }, [previewSrc, zoomMode, customScale]);

  const zoomModeRef = useRef(zoomMode);
  const customScaleRef = useRef(customScale);
  const currentVisScaleRef = useRef(1);

  useEffect(() => { zoomModeRef.current = zoomMode; }, [zoomMode]);
  useEffect(() => { customScaleRef.current = customScale; }, [customScale]);

  useEffect(() => {
    if (imageSize.width > 0 && displaySize.width > 0) {
      // Calculate what internal scale is mapped equivalent currently giving the display vs natural size
      currentVisScaleRef.current = displaySize.width / imageSize.width;
    }
  }, [displaySize.width, imageSize.width]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault(); 
        const delta = e.deltaY > 0 ? -0.15 : 0.15;
        const factor = 1 + delta;

        setZoomMode("custom");

        setCustomScale((prevScale) => {
          let baseScale = prevScale;
          if (zoomModeRef.current !== "custom") {
            baseScale = currentVisScaleRef.current || 1;
            zoomModeRef.current = "custom"; // 马上同步防止下一次事件跳档
          }
          return Math.max(0.1, Math.min(baseScale * factor, 8.0));
        });
      }
    };

    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, []);

  const scale = useMemo(() => {
    if (imageSize.width === 0 || imageSize.height === 0) {
      return { x: 1, y: 1 };
    }
    return {
      x: displaySize.width / imageSize.width,
      y: displaySize.height / imageSize.height,
    };
  }, [displaySize.height, displaySize.width, imageSize.height, imageSize.width]);

  const imageWrapSx = useMemo(() => {
    if (zoomMode === "custom") {
      return { width: imageSize.width * customScale, height: imageSize.height * customScale } as const;
    }
    if (zoomMode === "fit_width") {
      return { width: "100%" } as const;
    }
    if (zoomMode === "fit_height") {
      return { width: "max-content", height: "100%" } as const;
    }
    return { width: "max-content" } as const;
  }, [zoomMode, customScale, imageSize.width, imageSize.height]);

  const previewImageSx = useMemo(() => {
    if (zoomMode === "custom") {
      return { width: imageSize.width * customScale, height: imageSize.height * customScale, maxWidth: "none", maxHeight: "none" } as const;
    }
    if (zoomMode === "fit_width") {
      return { width: "100%", height: "auto", maxWidth: "none", maxHeight: "none" } as const;
    }
    if (zoomMode === "fit_height") {
      return { width: "auto", height: "100%", maxWidth: "none", maxHeight: "none" } as const;
    }
    if (zoomMode === "fit_page") {
      return { width: "auto", height: "auto", maxWidth: "100%", maxHeight: "100%" } as const;
    }
    return { width: "auto", height: "auto", maxWidth: "none", maxHeight: "none" } as const;
  }, [zoomMode, customScale, imageSize.width, imageSize.height]);

  const requestAiDescription = async (text: string, action: string = "解读", imageDataUrl?: string): Promise<string> => {
    if (!text.trim() && !imageDataUrl) {
      setAiResult("");
      return "";
    }
    setAiResult(`正在请求 AI ${action}...`);
    setFloatingMenu({ visible: false, x: 0, y: 0, selectedText: "" });
    // Reset Q&A state for new action
    setQaHistory([]);
    setQaInput("");
    setQaLoading(false);
    qaSourceTextRef.current = text;

    const apiKey = llmSettings.vendorApiKeys[llmSettings.vendor];
    if (!apiKey || !llmSettings.baseUrl) {
      setAiResult("");
      return "";
    }

    try {
      const systemPrompts: Record<string, string> = {
        "解读": "简洁明了地解读以下文本，抓住核心要点，不要展开冗长分析。用中文回复。",
        "翻译": "将以下文本翻译成中文。如果原文已是中文，则翻译成英文。只输出翻译结果。",
        "摘要": "用一两句话摘要以下文本的核心内容。用中文回复。",
        "全文解读": "你是一位专业的文档分析专家。以下是从一份PDF文档中按页面顺序提取的全文内容。请提供全面深入的解读分析，包括：\n1. 文档主题和核心观点概述\n2. 主要内容结构梳理\n3. 关键论点和重要发现\n4. 总结评价\n请用中文回复，使用 Markdown 格式组织内容。",
      };

      const systemPrompt = systemPrompts[action] || systemPrompts["解读"];
      const baseUrl = llmSettings.baseUrl.replace(/\/+$/, "");

      // Build user message: multimodal if image is provided
      const userContent: unknown = imageDataUrl
        ? [
            { type: "text", text },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ]
        : text;

      const requestBody: Record<string, unknown> = {
        model: llmSettings.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: 0.7,
        max_tokens: action === "全文解读" ? 8192 : 2048,
        stream: true,
      };

      // Volcengine Ark: disable thinking mode for seed models
      if (llmSettings.vendor === "volcengine") {
        requestBody.thinking = { type: "disabled" };
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API 请求失败 (${response.status}): ${errText}`);
      }

      // Try streaming via SSE
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let result = "";
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data: ")) continue;
              const data = trimmed.slice(6);
              if (data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  result += delta;
                  setAiResult(result);
                }
              } catch {
                // skip unparseable chunks
              }
            }
          }
        } catch {
          if (result) {
            const interrupted = result + "\n\n[流式输出中断]";
            setAiResult(interrupted);
            return interrupted;
          } else {
            throw new Error("流式读取失败");
          }
        }
        return result;
      }

      // Fallback: non-streaming response
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        setAiResult(content);
        return content;
      } else {
        setAiResult("AI 返回了空内容");
        return "AI 返回了空内容";
      }
    } catch (e) {
      const errMsg = `请求失败: ${String(e)}`;
      setAiResult(errMsg);
      return errMsg;
    }
  };

  const handleTextSelection = (_e: React.MouseEvent) => {
    const selection = window.getSelection();
    if (!selection || !selection.toString().trim()) {
      // Close floating menu if no selection
      setFloatingMenu(prev => prev.visible ? { ...prev, visible: false } : prev);
      return;
    }

    const selectedText = selection.toString().trim();
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    // Get right pane bounds to constrain floating menu
    const paneEl = rightPaneRef.current;
    const paneRect = paneEl?.getBoundingClientRect();
    const menuW = 260; // estimated menu width
    const menuH = 40;  // estimated menu height

    // Default: position above-right of selection end
    let menuX = rect.right + 6;
    let menuY = rect.top - menuH - 4;

    // Constrain within right pane horizontally
    if (paneRect) {
      // If menu would overflow right edge, flip to left of selection
      if (menuX + menuW > paneRect.right - 4) {
        menuX = rect.left - menuW - 6;
      }
      // If still overflowing left edge, clamp
      menuX = Math.max(menuX, paneRect.left + 4);
      menuX = Math.min(menuX, paneRect.right - menuW - 4);

      // Vertically: if not enough space above, show below the selection
      if (menuY < paneRect.top) {
        menuY = rect.bottom + 4;
      }
      // Clamp vertically within pane
      menuY = Math.max(menuY, paneRect.top + 4);
      menuY = Math.min(menuY, paneRect.bottom - menuH - 4);
    } else {
      // Fallback to window constraints
      if (menuX + menuW > window.innerWidth - 4) {
        menuX = rect.left - menuW - 6;
      }
      menuX = Math.max(4, Math.min(menuX, window.innerWidth - menuW - 4));
      if (menuY < 0) {
        menuY = rect.bottom + 4;
      }
      menuY = Math.max(4, Math.min(menuY, window.innerHeight - menuH - 4));
    }

    setFloatingMenu({
      visible: true,
      x: menuX,
      y: menuY,
      selectedText,
    });
  };

  const showFloatingMenu = (text: string, x: number, y: number) => {
    const menuW = 260;
    const menuH = 40;
    const paneEl = rightPaneRef.current;
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

    setFloatingMenu({ visible: true, x: menuX, y: menuY, selectedText: text });
  };

  const actionLabels: Record<string, string> = {
    "解读": "解读文字",
    "翻译": "翻译文字",
    "摘要": "摘要文字",
    "全文解读": "全文解读",
  };

  const handleFloatingAction = (action: string) => {
    if (floatingMenu.selectedText) {
      setAiAction(actionLabels[action] || action);
      requestAiDescription(floatingMenu.selectedText, action);
    }
  };

  // Gather all visible text in the text-pane for batch AI actions
  const getPaneFullText = (): string => {
    let parts: string[] = [];
    if (selectedParagraph?.text) {
      parts.push(selectedParagraph.text
        .replace(/[\r\n]+/g, "")
        .replace(/(?<!\b(?:al|etc|fig|eq|vs|ref|sec|[a-zA-Z]))(?<!\.)([。！？.!?])(?!\d|\.)(?:\s*)/gi, "$1\n")
      );
    }
    if (ocrText) {
      parts.push(ocrText
        .replace(/[\r\n]+/g, "")
        .replace(/(?<!\b(?:al|etc|fig|eq|vs|ref|sec|[a-zA-Z]))(?<!\.)([。！？.!?])(?!\d|\.)(?:\s*)/gi, "$1\n")
      );
    }
    return parts.join("\n---\n");
  };

  const handleBatchAiAction = (action: string) => {
    const text = getPaneFullText();
    if (!text.trim()) return;
    setAiAction(actionLabels[action] || action);
    requestAiDescription(text, action);
  };

  const handleImageAiAction = () => {
    if (!figureImageDataUrl) return;
    setAiAction("解读图片");
    requestAiDescription("请解读这张图片的内容", "解读", figureImageDataUrl);
  };

  const handleFulltextAiAction = async () => {
    if (!isPdfSelected || !documentPath || fulltextExtracting) return;

    const apiKey = llmSettings.vendorApiKeys[llmSettings.vendor];
    if (!apiKey || !llmSettings.baseUrl) {
      setErrorMessage("请先在设置中配置 LLM API Key");
      return;
    }
    if (!modelLoaded) {
      setErrorMessage("请先加载模型后再使用全文解读");
      return;
    }

    setFulltextExtracting(true);
    fulltextCancelRef.current = false;
    setFulltextProgress({ current: 0, total: pdfPageCount });
    setAiAction("全文解读");
    setAiResult(`正在提取全文内容 (0/${pdfPageCount} 页)...`);

    try {
      const allTextParts: string[] = [];

      for (let page = 0; page < pdfPageCount; page++) {
        if (fulltextCancelRef.current) {
          setAiResult("已取消全文提取");
          return;
        }

        setFulltextProgress({ current: page + 1, total: pdfPageCount });
        setAiResult(`正在提取全文内容 (${page + 1}/${pdfPageCount} 页)...`);

        const result = await invoke<ExtractContentResponse>("get_pdf_paragraphs", {
          filePath: documentPath,
          pageIndex: page,
          scoreThreshold,
        });

        if (fulltextCancelRef.current) {
          setAiResult("已取消全文提取");
          return;
        }

        // Use per-page layout boxes for visual filtering (hits inference cache)
        const layoutResult = await invoke<DetectionResponse>("run_doclayout", {
          filePath: documentPath,
          scoreThreshold,
          pageIndex: page,
        });
        const pageBoxes = layoutResult.boxes;

        const textSegments = result.segments.filter(
          (seg) => !isSegmentGarbage(seg, pageBoxes) && seg.text.trim()
        );

        if (textSegments.length > 0) {
          const pageText = textSegments.map((s) => s.text.trim()).join("\n");
          allTextParts.push(pageText);
        }
      }

      if (fulltextCancelRef.current) {
        setAiResult("已取消全文提取");
        return;
      }

      const fullText = allTextParts.join("\n\n");
      if (!fullText.trim()) {
        setAiResult("未提取到文本内容");
        return;
      }

      // Save fulltext to temp file for debugging
      try {
        const savedPath = await invoke<string>("save_fulltext_debug", { text: fullText });
        console.log("Fulltext saved to:", savedPath);
      } catch {
        // non-critical, ignore
      }

      setAiResult("正在请求 AI 全文解读...");
      const aiText = await requestAiDescription(fullText, "全文解读");
      // Persist fulltext content in memory
      fulltextAiResultRef.current = aiText;
      fulltextQaHistoryRef.current = [];
      fulltextSourceTextRef.current = fullText;
    } catch (e) {
      setErrorMessage(`全文提取失败: ${String(e)}`);
      setAiResult("");
    } finally {
      setFulltextExtracting(false);
      setFulltextProgress({ current: 0, total: 0 });
    }
  };

  const handleFulltextCancel = () => {
    fulltextCancelRef.current = true;
  };

  const handleQaSubmit = async () => {
    const question = qaInput.trim();
    if (!question || qaLoading) return;

    const apiKey = llmSettings.vendorApiKeys[llmSettings.vendor];
    if (!apiKey || !llmSettings.baseUrl) return;

    setQaInput("");
    setQaLoading(true);

    // Add question with empty answer immediately
    setQaHistory(prev => [...prev, { question, answer: "" }]);

    try {
      const systemPrompt = "你是一位专业的文档分析助手。以下是文档的原文内容以及之前的AI解读。请根据用户的问题进行回答，用中文回复，简洁准确。";
      const baseUrl = llmSettings.baseUrl.replace(/\/+$/, "");

      // Build conversation messages (snapshot current history before this question)
      const messages: { role: string; content: string }[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: qaSourceTextRef.current },
        { role: "assistant", content: aiResult },
      ];
      for (const qa of qaHistory) {
        messages.push({ role: "user", content: qa.question });
        messages.push({ role: "assistant", content: qa.answer });
      }
      messages.push({ role: "user", content: question });

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: llmSettings.model,
          messages,
          temperature: 0.7,
          max_tokens: 2048,
          stream: true,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API 请求失败 (${response.status}): ${errText}`);
      }

      // Stream the answer
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let result = "";
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                result += delta;
                setQaHistory(prev => {
                  const updated = [...prev];
                  updated[updated.length - 1] = { question, answer: result };
                  return updated;
                });
              }
            } catch {
              // skip unparseable chunks
            }
          }
        }
      } else {
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        setQaHistory(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { question, answer: content || "AI 返回了空内容" };
          return updated;
        });
      }
    } catch (e) {
      setQaHistory(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { question, answer: `请求失败: ${String(e)}` };
        return updated;
      });
    } finally {
      setQaLoading(false);
    }
  };

  // Auto-scroll AI pane to bottom
  useEffect(() => {
    if (aiScrollRef.current) {
      aiScrollRef.current.scrollTop = aiScrollRef.current.scrollHeight;
    }
  }, [aiResult, qaHistory]);

  // Sync fulltext Q&A memory when in fulltext mode
  useEffect(() => {
    if (aiAction === "全文解读") {
      fulltextQaHistoryRef.current = qaHistory;
    }
  }, [qaHistory, aiAction]);

  const dismissFloatingMenu = () => {
    setFloatingMenu({ visible: false, x: 0, y: 0, selectedText: "" });
  };

  // Global click listener to dismiss floating menu
  useEffect(() => {
    if (!floatingMenu.visible) return;
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
  }, [floatingMenu.visible]);

  const segmentedParagraph = useMemo(() => {
    if (!selectedParagraph?.text) return [];
    
    // Remove original physical newlines, then add newlines after Chinese and English sentence punctuations (excluding decimal points and common abbreviations)
    const formattedText = selectedParagraph.text
      .replace(/[\r\n]+/g, "") // Remove existing physical line breaks
      .replace(/(?<!\b(?:al|etc|fig|eq|vs|ref|sec|[a-zA-Z]))(?<!\.)([。！？.!?])(?!\d|\.)(?:\s*)/gi, "$1\n"); // Add explicit line break after punctuation

    try {
      // @ts-ignore
      const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
      // @ts-ignore
      return Array.from(segmenter.segment(formattedText)).map((s: any) => s.segment);
    } catch {
      return formattedText.split(/(?=[\u4e00-\u9fa5])/); // simple fallback
    }
  }, [selectedParagraph?.text]);

  // LaTeX renderer: converts text to clickable words and $...$, $$...$$ math to HTML nodes
  const renderOcrNodes = useCallback((text: string): React.ReactNode[] => {
    if (!text) return [];

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

    // 1. Split on display math $$...$$
    const displayParts = text.split(/(\$\$[\s\S]*?\$\$)/);
    for (let i = 0; i < displayParts.length; i++) {
      const part = displayParts[i];
      if (part.startsWith('$$') && part.endsWith('$$')) {
        const math = part.slice(2, -2);
        try {
          const html = katex.renderToString(math, { displayMode: true, throwOnError: false });
          nodes.push(<span key={`math-d-${tokenIndex++}`} dangerouslySetInnerHTML={{ __html: html }} />);
        } catch {
          pushText(part);
        }
      } else {
        // 2. Split on inline math $...$
        const inlineParts = part.split(/(\$(?!\$)[\s\S]*?[^\\]\$)/);
        for (let j = 0; j < inlineParts.length; j++) {
          const inPart = inlineParts[j];
          if (inPart.startsWith('$') && inPart.endsWith('$') && !inPart.startsWith('$$')) {
            const inMath = inPart.slice(1, -1);
            try {
              const html = katex.renderToString(inMath, { displayMode: false, throwOnError: false });
              nodes.push(<span key={`math-i-${tokenIndex++}`} dangerouslySetInnerHTML={{ __html: html }} />);
            } catch {
              pushText(inPart);
            }
          } else {
            pushText(inPart);
          }
        }
      }
    }

    return nodes;
  }, []);

  // Markdown + LaTeX renderer for AI response
  const renderAiContent = useCallback((text: string): React.ReactNode => {
    if (!text) return null;

    // Escape user text for safe HTML injection after markdown rendering
    const parts: { type: "md" | "math_d" | "math_i"; content: string }[] = [];
    let remaining = text;

    // 1. Extract display math $$...$$
    const displayRe = /\$\$([\s\S]*?)\$\$/g;
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    while ((match = displayRe.exec(remaining)) !== null) {
      if (match.index > lastIdx) {
        parts.push({ type: "md", content: remaining.slice(lastIdx, match.index) });
      }
      parts.push({ type: "math_d", content: match[1] });
      lastIdx = displayRe.lastIndex;
    }
    if (lastIdx < remaining.length) {
      remaining = remaining.slice(lastIdx);
    } else {
      remaining = "";
    }

    // 2. Extract inline math $...$ from remaining
    const inlineRe = /\$(?!\$)([\s\S]*?[^\\])\$/g;
    const mdParts: { type: "md" | "math_i"; content: string }[] = [];
    lastIdx = 0;
    while ((match = inlineRe.exec(remaining)) !== null) {
      if (match.index > lastIdx) {
        mdParts.push({ type: "md", content: remaining.slice(lastIdx, match.index) });
      }
      mdParts.push({ type: "math_i", content: match[1] });
      lastIdx = inlineRe.lastIndex;
    }
    if (lastIdx < remaining.length) {
      mdParts.push({ type: "md", content: remaining.slice(lastIdx) });
    }
    parts.push(...mdParts);

    // 3. Render each part
    const nodes: React.ReactNode[] = [];
    let key = 0;
    for (const part of parts) {
      if (part.type === "math_d") {
        try {
          const html = katex.renderToString(part.content, { displayMode: true, throwOnError: false });
          nodes.push(<span key={key++} dangerouslySetInnerHTML={{ __html: html }} />);
        } catch {
          nodes.push(<span key={key++} className="math-fallback">{`$$${part.content}$$`}</span>);
        }
      } else if (part.type === "math_i") {
        try {
          const html = katex.renderToString(part.content, { displayMode: false, throwOnError: false });
          nodes.push(<span key={key++} dangerouslySetInnerHTML={{ __html: html }} />);
        } catch {
          nodes.push(<span key={key++} className="math-fallback">{`$${part.content}$`}</span>);
        }
      } else {
        const mdHtml = marked.parse(part.content, { async: false }) as string;
        nodes.push(<span key={key++} dangerouslySetInnerHTML={{ __html: mdHtml }} />);
      }
    }
    return <div className="ai-markdown-content">{nodes}</div>;
  }, []);

  const handleMouseDownV = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const target = e.currentTarget as HTMLElement;
    const prevSibling = target.previousElementSibling as HTMLElement;
    const startWidth = prevSibling?.offsetWidth || 0;
    
    const onMouseMove = (moveEvent: MouseEvent) => {
       const delta = moveEvent.clientX - startX;
       if (startWidth > 0) {
         setLeftPaneWidth(`${Math.max(200, startWidth + delta)}px`);
       }
    };
    
    const onMouseUp = () => {
       document.removeEventListener("mousemove", onMouseMove);
       document.removeEventListener("mouseup", onMouseUp);
    };
    
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const handleMouseDownH = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const target = e.currentTarget as HTMLElement;
    const prevSibling = target.previousElementSibling as HTMLElement;
    const startHeight = prevSibling?.offsetHeight || 0;
    
    const onMouseMove = (moveEvent: MouseEvent) => {
       const delta = moveEvent.clientY - startY;
       if (startHeight > 0) {
         setTopPaneHeight(`${Math.max(100, startHeight + delta)}px`);
       }
    };
    
    const onMouseUp = () => {
       document.removeEventListener("mousemove", onMouseMove);
       document.removeEventListener("mouseup", onMouseUp);
    };
    
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  if (!environmentReady) {
    return <EnvironmentCheck onAllChecksPassed={() => setEnvironmentReady(true)} />;
  }

  return (
    <div className="app-root">
      <div className="app-shell">
        <div className="top-menu-bar">
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
                <MenuItem onClick={clearCurrentDocument}>新建</MenuItem>
                <MenuItem onClick={() => void selectDocument()}>打开</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>

          <Button
            appearance="transparent"
            className="menu-btn menu-btn-no-icon"
            onClick={() => setSettingsOpen(true)}
          >
            设置
          </Button>

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
                <MenuItem>关于 xDoc</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>

          <div className="menu-spacer" />
          <Text className="menu-status">{modelPath ? "模型已加载" : "模型未设置"}</Text>
          <Text className="menu-status">阈值: {scoreThreshold.toFixed(2)}</Text>
          {loading && <Spinner size="tiny" />}
          {isPdfSelected && (
            fulltextExtracting ? (
              <Button
                appearance="transparent"
                className="menu-btn"
                onClick={handleFulltextCancel}
                title="取消全文提取"
              >
                <Spinner size="tiny" style={{ marginRight: 4 }} />
                取消 ({fulltextProgress.current}/{fulltextProgress.total})
              </Button>
            ) : (
              <Button
                appearance="transparent"
                className="menu-btn"
                onClick={() => void handleFulltextAiAction()}
                disabled={!documentPath || !modelLoaded || loading}
                title={modelLoaded ? "提取所有页面文本并进行 AI 解读" : "请先加载模型"}
              >
                全文解读
              </Button>
            )
          )}
        </div>

        <Card className="panel-card visual-card">
          <div className="main-layout" ref={mainLayoutRef}>
            <div className="pdf-pane" style={{ 
              width: leftPaneWidth, 
              flex: typeof leftPaneWidth === "string" ? `0 0 ${leftPaneWidth}` : "none" 
            }}>
              <div className="visual-body">
                {errorMessage && (
                  <MessageBar intent="error" className="error-bar">
                    <MessageBarBody>{errorMessage}</MessageBarBody>
                  </MessageBar>
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

                <div
                  ref={stageRef}
                  className={`visual-stage ${zoomMode === "fit_height" ? "visual-stage-fit-height" : ""} ${!previewSrc ? "visual-stage-empty" : ""}`}
                  onClick={(e) => {
                    // Only trigger on clicks directly on the stage or image-wrap (blank area)
                    const target = e.target as HTMLElement;
                    if (target.closest(".bbox")) return;
                    setSelectedParagraph(null);
                    setSelectedFigure(null);
                    setFigureImageDataUrl("");
                    if (fulltextAiResultRef.current) {
                      setAiAction("全文解读");
                      setAiResult(fulltextAiResultRef.current);
                      setQaHistory(fulltextQaHistoryRef.current);
                      qaSourceTextRef.current = fulltextSourceTextRef.current;
                    } else {
                      setAiAction("");
                      setAiResult("");
                      setQaHistory([]);
                    }
                  }}
                >
                  {previewSrc ? (
                    <div className="image-wrap" style={imageWrapSx}>
                      <img
                        ref={imgRef}
                        src={previewSrc}
                        alt="Document Preview"
                        className="preview-image"
                        style={previewImageSx}
                        onLoad={() => {
                          if (imgRef.current) {
                            setDisplaySize({
                              width: imgRef.current.clientWidth,
                              height: imgRef.current.clientHeight,
                            });
                          }
                        }}
                      />

                      <div className="overlay-layer" style={{ width: displaySize.width, height: displaySize.height }}>
                        {segments.map((seg, idx) => {
                          const left = Math.max(0, seg.xmin * scale.x);
                          const top = Math.max(0, seg.ymin * scale.y);
                          const width = Math.max(1, (seg.xmax - seg.xmin) * scale.x);
                          const height = Math.max(1, (seg.ymax - seg.ymin) * scale.y);

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
                                cursor: "pointer",
                                pointerEvents: "auto",
                              }}
                              onClick={() => { setSelectedFigure(null); setFigureImageDataUrl(""); setSelectedParagraph(seg); }}
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
                          const left = Math.max(0, box.xmin * scale.x);
                          const top = Math.max(0, box.ymin * scale.y);
                          const width = Math.max(1, (box.xmax - box.xmin) * scale.x);
                          const height = Math.max(1, (box.ymax - box.ymin) * scale.y);
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
                                cursor: clickable ? "pointer" : undefined,
                                pointerEvents: clickable ? "auto" : undefined,
                              }}
                              onClick={clickable ? () => selectFigure(box) : undefined}
                            />
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="empty-state">
                      <Button className="empty-open-btn" appearance="primary" onClick={() => void selectDocument()} disabled={loading}>
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

            <div className="resizer-v" onMouseDown={handleMouseDownV} />

            <div className="right-pane" ref={rightPaneRef}>
              <div className="text-pane" onMouseUp={handleTextSelection} style={{
                height: topPaneHeight,
                flex: typeof topPaneHeight === "string" ? `0 0 ${topPaneHeight}` : "none"
              }}>
                {/* ── Header with batch AI action buttons ── */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                  <h3 style={{ margin: 0, flex: "0 0 auto" }}>选取段落及分词区域</h3>
                  <div style={{ display: "flex", gap: 2, alignItems: "center", marginLeft: "auto" }}>
                    <button
                      className="font-size-btn"
                      onClick={() => setTextFontSize(s => Math.max(10, s - 1))}
                      title="缩小字号"
                    >A-</button>
                    <span style={{ fontSize: 11, color: "#bbb", minWidth: 24, textAlign: "center" }}>{textFontSize}</span>
                    <button
                      className="font-size-btn"
                      onClick={() => setTextFontSize(s => Math.min(40, s + 1))}
                      title="放大字号"
                    >A+</button>
                  </div>
                  {selectedFigure ? (
                    <button className="batch-ai-btn" onClick={handleImageAiAction}>
                      <Bot size={13} /> 解读图片
                    </button>
                  ) : (selectedParagraph || ocrText) ? (
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

                {/* ── Figure image display ── */}
                {selectedFigure ? (
                  <div style={{ overflow: "hidden" }}>
                    <Text size={100} weight="semibold" style={{ color: "#ffffff", marginBottom: 4, display: "block" }}>
                      {CLASSES[selectedFigure.cls_id] ?? "figure"} #{selectedFigure.read_order}
                    </Text>
                    {figureImageDataUrl ? (
                      <img
                        src={figureImageDataUrl}
                        alt="Selected figure"
                        style={{ display: "block", maxWidth: "100%", height: "auto", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)" }}
                      />
                    ) : (
                      <Text size={100} style={{ opacity: 0.5 }}>加载图片中...</Text>
                    )}
                  </div>
                ) : selectedParagraph ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", overflow: "auto" }}>
                    {/* PDF-extracted text with word segmentation */}
                    {pdfTextExtractionEnabled && (
                      <div>
                        <Text size={100} weight="semibold" style={{ color: "#ffffff", marginBottom: 4, display: "block" }}>
                          PDF 原文
                        </Text>
                        <div className="ocr-latex-content" style={{ whiteSpace: "pre-wrap", fontSize: textFontSize }}>
                          {segmentedParagraph.map((word, idx) => (
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
                    {ocrEnabled && (
                      <div>
                        <Text size={100} weight="semibold" style={{ color: "#ffffff", marginBottom: 4, display: "block" }}>
                          OCR 识别结果
                        </Text>
                        {ocrLoading ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <Spinner size="tiny" />
                            <Text size={100} style={{ opacity: 0.6 }}>OCR 识别中...</Text>
                          </div>
                        ) : ocrError ? (
                          <Text size={100} style={{ color: "#ff6b6b" }}>{ocrError}</Text>
                        ) : ocrText ? (
                          <div
                            className="ocr-latex-content"
                            style={{ whiteSpace: "pre-wrap", fontSize: textFontSize }}
                          >
                            {renderOcrNodes(
                              ocrText
                                .replace(/[\r\n]+/g, "")
                                .replace(/(?<!\b(?:al|etc|fig|eq|vs|ref|sec|[a-zA-Z]))(?<!\.)([。！？.!?])(?!\d|\.)(?:\s*)/gi, "$1\n")
                            )}
                          </div>
                        ) : (
                          <Text size={100} style={{ opacity: 0.5 }}>点击段落以进行 OCR 识别</Text>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ opacity: 0.5 }}>（请在左侧预览中点击选中需要阅读的段落块或图片区域）</div>
                )}
              </div>

              <div className="resizer-h" onMouseDown={handleMouseDownH} />

              <div className="ai-pane">
                <div className="ai-pane-scroll" ref={aiScrollRef}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                    <h3 style={{ margin: 0 }}>{aiAction || "AI 解读"}</h3>
                    <div style={{ display: "flex", gap: 2, alignItems: "center", marginLeft: "auto" }}>
                      <button
                        className="font-size-btn"
                        onClick={() => setAiFontSize(s => Math.max(10, s - 1))}
                        title="缩小字号"
                      >A-</button>
                      <span style={{ fontSize: 11, color: "#bbb", minWidth: 24, textAlign: "center" }}>{aiFontSize}</span>
                      <button
                        className="font-size-btn"
                        onClick={() => setAiFontSize(s => Math.min(40, s + 1))}
                        title="放大字号"
                      >A+</button>
                    </div>
                  </div>
                  <div style={{ color: "#ffffff", fontSize: aiFontSize }}>
                    {aiResult
                      ? renderAiContent(aiResult)
                      : fulltextAiResultRef.current
                        ? renderAiContent(fulltextAiResultRef.current)
                        : "（点击单词或选中文字，选择 AI 解读 / 翻译 / 摘要）"}
                  </div>

                  {/* Q&A follow-up history */}
                  {qaHistory.length > 0 && (
                    <div className="qa-history" style={{ fontSize: aiFontSize }}>
                      {qaHistory.map((qa, idx) => (
                        <div key={idx} className="qa-pair">
                          <div className="qa-question">Q: {qa.question}</div>
                          <div className="qa-answer">
                            {qa.answer ? renderAiContent(qa.answer) : <Spinner size="tiny" />}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Q&A input - pinned to bottom */}
                {(aiResult || fulltextAiResultRef.current) && (
                  <div className="qa-input-row">
                    <input
                      className="qa-input"
                      type="text"
                      placeholder="输入追问..."
                      value={qaInput}
                      onChange={e => setQaInput(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleQaSubmit(); } }}
                      disabled={qaLoading}
                    />
                    <button
                      className="qa-send-btn"
                      onClick={() => void handleQaSubmit()}
                      disabled={qaLoading || !qaInput.trim()}
                    >
                      {qaLoading ? <Spinner size="tiny" /> : "发送"}
                    </button>
                  </div>
                )}
              </div>

              {/* Floating AI Action Menu */}
              {floatingMenu.visible && (
                <div
                  className="floating-ai-menu"
                  style={{ left: floatingMenu.x, top: floatingMenu.y }}
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
          </div>
        </Card>
      </div>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        modelPath={modelPath}
        modelLoaded={modelLoaded}
        scoreThreshold={scoreThreshold}
        zoomMode={zoomMode}
        pdfTextExtractionEnabled={pdfTextExtractionEnabled}
        onSelectModel={selectModel}
        onScoreThresholdChange={applyScoreThreshold}
        onZoomModeChange={setZoomMode}
        onPdfTextExtractionEnabledChange={setPdfTextExtractionEnabled}
        ocrEnabled={ocrEnabled}
        onOcrEnabledChange={setOcrEnabled}
        ocrModelPath={ocrModelPath}
        onOcrModelPathChange={setOcrModelPath}
        llmSettings={llmSettings}
        onLlmSettingsChange={setLlmSettings}
      />
    </div>
  );
}

export default App;
