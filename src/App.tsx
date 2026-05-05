import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import katex from "katex";
import "katex/dist/katex.min.css";
import SettingsDialog, { STORAGE_KEYS as OCR_STORAGE_KEYS } from "./components/SettingsDialog";
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
  "title",
  "text",
  "figure",
  "table",
  "figure_caption",
  "table_caption",
  "header",
  "footer",
  "reference",
  "equation",
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
];

type ZoomMode = "fit_page" | "fit_width" | "fit_height" | "actual" | "custom";
type TopMenuKey = "file" | "settings" | "help" | null;

export const STORAGE_KEYS = {
  modelPath: "xdoc.settings.modelPath",
  scoreThreshold: "xdoc.settings.scoreThreshold",
  zoomMode: "xdoc.settings.zoomMode",
} as const;

function App() {
  const [environmentReady, setEnvironmentReady] = useState(false);
  const [modelPath, setModelPath] = useState("");
  const [documentPath, setDocumentPath] = useState("");
  const [previewSrc, setPreviewSrc] = useState("");
  const [boxes, setBoxes] = useState<LayoutBox[]>([]);
  const [segments, setSegments] = useState<TextSegment[]>([]);
  const [selectedParagraph, setSelectedParagraph] = useState<TextSegment | null>(null);
  const [selectedWords, setSelectedWords] = useState<string>("");
  const [aiResult, setAiResult] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [scoreThreshold, setScoreThreshold] = useState(0.5);
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

  // Resize state
  const [leftPaneWidth, setLeftPaneWidth] = useState<number | string>("60%");
  const [topPaneHeight, setTopPaneHeight] = useState<number | string>("50%");

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const mainLayoutRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);

  const isPdfSelected = useMemo(() => documentPath.toLowerCase().endsWith(".pdf"), [documentPath]);

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

  const loadPdfText = async (filePath: string, targetPageIndex?: number) => {
    setErrorMessage("");
    try {
      setLoading(true);
      const pageIndex = Math.max(0, targetPageIndex ?? pdfPageIndex);

      // Use layout-guided paragraph detection when model is loaded
      const command = modelLoaded ? "get_pdf_paragraphs" : "get_pdf_text";
      const args: Record<string, unknown> = { filePath, pageIndex };
      if (modelLoaded) {
        args.scoreThreshold = scoreThreshold;
      }

      const result = await invoke<ExtractContentResponse>(command, args);

      setPreviewSrc(result.preview_data_url);
      setImageSize({ width: result.width, height: result.height });
      setPdfPageIndex(result.page_index);
      setPdfPageCount(result.page_count);
      setSegments(result.segments);
      setSelectedParagraph(null);
      setSelectedWords("");
      setAiResult("");
    } catch (e) {
      setErrorMessage(`解析文字失败: ${String(e)}`);
    } finally {
      setLoading(false);
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

  const clearCurrentDocument = () => {
    setDocumentPath("");
    setPreviewSrc("");
    setBoxes([]);
    setSegments([]);
    setSelectedParagraph(null);
    setSelectedWords("");
    setAiResult("");
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
      setSelectedWords("");
      setAiResult("");
      setImageSize({ width: 0, height: 0 });
      setDisplaySize({ width: 0, height: 0 });
      setPdfPageIndex(0);
      setPdfPageCount(0);

      if (selected.toLowerCase().endsWith(".pdf")) {
         await loadPdfText(selected, 0);
         // Also run layout model to populate cache for layout-guided paragraph detection
         if (modelLoaded) {
            await runModel(0, selected);
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

      const savedZoom = window.localStorage.getItem(STORAGE_KEYS.zoomMode) as ZoomMode | null;
      if (savedZoom && ["fit_page", "fit_width", "fit_height", "actual", "custom"].includes(savedZoom)) {
        setZoomMode(savedZoom);
      }

      const savedModelPath = window.localStorage.getItem(STORAGE_KEYS.modelPath)
        || "../model/PP-DocLayoutV3.onnx";
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
        || "../model/GLM-OCR-GGUF";
      setOcrModelPath(savedOcrPath);
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
      });

    return () => { cancelled = true; };
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

  const requestAiDescription = async (text: string) => {
    if (!text.trim()) {
      setAiResult("");
      return;
    }
    setSelectedWords(text);
    setAiResult("正在请求 AI 进行解读...\n（这是模拟结果，需要接下来接入真实的 LLM 服务如 Tauri backend 的 fetch）");
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      setAiResult(`【AI 解读功能】: ${text}\n\n该文本是通过您刚刚点击/圈选选中的段落。这里占位以便接入任何基于 Tauri backend 或者浏览器直接发出 API Fetch 的大模型提供服务。此功能将在后续由您进行扩展使用！`);
    }, 1500);
  };

  const handleTextSelection = () => {
    const selection = window.getSelection();
    if (selection && selection.toString().trim()) {
      requestAiDescription(selection.toString().trim());
    }
  };

  const segmentedParagraph = useMemo(() => {
    if (!selectedParagraph?.text) return [];
    
    // Remove original physical newlines, then add newlines after Chinese and English sentence punctuations (excluding decimal points)
    const formattedText = selectedParagraph.text
      .replace(/[\r\n]+/g, "") // Remove existing physical line breaks
      .replace(/([。！？.!?])(?!\d)(?:\s*)/g, "$1\n"); // Add explicit line break after punctuation

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
            onClick={() => {
              if (window.getSelection()?.toString() !== "") return;
              requestAiDescription(word);
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
                      onClick={async () => {
                        const newPage = Math.max(0, pdfPageIndex - 1);
                        await loadPdfText(documentPath, newPage);
                        if (modelLoaded) await runModel(newPage, documentPath);
                      }}
                      disabled={!documentPath || loading || pdfPageIndex <= 0}
                      aria-label="上一页"
                    />
                    <Button
                      className="page-arrow page-arrow-right"
                      appearance="subtle"
                      icon={<ChevronRight24Regular />}
                      onClick={async () => {
                        const newPage = pdfPageIndex + 1;
                        await loadPdfText(documentPath, newPage);
                        if (modelLoaded) await runModel(newPage, documentPath);
                      }}
                      disabled={!documentPath || loading || (pdfPageCount > 0 && pdfPageIndex >= pdfPageCount - 1)}
                      aria-label="下一页"
                    />
                  </>
                )}

                <div
                  ref={stageRef}
                  className={`visual-stage ${zoomMode === "fit_height" ? "visual-stage-fit-height" : ""} ${!previewSrc ? "visual-stage-empty" : ""}`}
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
                              onClick={() => setSelectedParagraph(seg)}
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
                          const label = `${CLASSES[box.cls_id] ?? `class_${box.cls_id}`}  #${box.read_order}  ${box.score.toFixed(2)}`;

                          return (
                            <div key={`${box.cls_id}-${box.read_order}-${idx}`}>
                              <div
                                className="bbox"
                                style={{
                                  borderColor: color,
                                  left,
                                  top,
                                  width,
                                  height,
                                }}
                              />
                              <div
                                className="bbox-label"
                                style={{
                                  backgroundColor: color,
                                  left,
                                  top: Math.max(0, top - 22),
                                }}
                              >
                                {label}
                              </div>
                            </div>
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
                <h3>选取段落及分词区域</h3>
                {selectedParagraph ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", overflow: "auto" }}>
                    {/* PDF-extracted text with word segmentation */}
                    <div>
                      <Text size={100} weight="semibold" style={{ color: "#888", marginBottom: 4, display: "block" }}>
                        PDF 原文
                      </Text>
                      <div className="ocr-latex-content" style={{ whiteSpace: "pre-wrap" }}>
                        {segmentedParagraph.map((word, idx) => (
                          <span
                            key={idx}
                            className="word-span"
                            onClick={() => {
                              if (window.getSelection()?.toString() !== "") return;
                              requestAiDescription(word);
                            }}
                          >
                            {word}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* OCR result with LaTeX rendering */}
                    {ocrEnabled && (
                      <div>
                        <Text size={100} weight="semibold" style={{ color: "#888", marginBottom: 4, display: "block" }}>
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
                            style={{ whiteSpace: "pre-wrap" }}
                          >
                            {renderOcrNodes(
                              ocrText
                                .replace(/[\r\n]+/g, "")
                                .replace(/([。！？.!?])(?!\d)(?:\s*)/g, "$1\n")
                            )}
                          </div>
                        ) : (
                          <Text size={100} style={{ opacity: 0.5 }}>点击段落以进行 OCR 识别</Text>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ opacity: 0.5 }}>（请在左侧预览中点击选中需要阅读的段落块）</div>
                )}
              </div>

              <div className="resizer-h" onMouseDown={handleMouseDownH} />

              <div className="ai-pane">
                <h3>已选中文字：{selectedWords ? `"${selectedWords}"` : "无"}</h3>
                <div style={{ whiteSpace: "pre-wrap", color: "#ccc" }}>
                  {aiResult || "（请在上方文字区域点击单词或拖拽选中文本，AI 解读内容将出现在此处）"}
                </div>
              </div>
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
        onSelectModel={selectModel}
        onScoreThresholdChange={applyScoreThreshold}
        onZoomModeChange={setZoomMode}
        ocrEnabled={ocrEnabled}
        onOcrEnabledChange={setOcrEnabled}
        ocrModelPath={ocrModelPath}
        onOcrModelPathChange={setOcrModelPath}
      />
    </div>
  );
}

export default App;
