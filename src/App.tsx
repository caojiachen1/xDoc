import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Button,
  Card,
  Menu,
  MenuButton,
  MenuDivider,
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

type ZoomMode = "fit_page" | "fit_width" | "fit_height" | "actual";
type TopMenuKey = "file" | "settings" | "help" | null;

const STORAGE_KEYS = {
  modelPath: "xdoc.settings.modelPath",
  scoreThreshold: "xdoc.settings.scoreThreshold",
  zoomMode: "xdoc.settings.zoomMode",
} as const;

function App() {
  const [modelPath, setModelPath] = useState("");
  const [documentPath, setDocumentPath] = useState("");
  const [previewSrc, setPreviewSrc] = useState("");
  const [boxes, setBoxes] = useState<LayoutBox[]>([]);
  const [loading, setLoading] = useState(false);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [scoreThreshold, setScoreThreshold] = useState(0.5);
  const [errorMessage, setErrorMessage] = useState("");
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const [pdfPageIndex, setPdfPageIndex] = useState(0);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit_page");
  const [openMenu, setOpenMenu] = useState<TopMenuKey>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

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
      setImageSize({ width: 0, height: 0 });
      setDisplaySize({ width: 0, height: 0 });
      setPdfPageIndex(0);
      setPdfPageCount(0);

      if (!modelLoaded) {
        setErrorMessage("请先在菜单栏的“设置 > ONNX 模型”中加载模型");
        return;
      }

      await runModel(0, selected);
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
    try {
      const savedThreshold = window.localStorage.getItem(STORAGE_KEYS.scoreThreshold);
      if (savedThreshold !== null) {
        const parsed = Number(savedThreshold);
        if (!Number.isNaN(parsed)) {
          setScoreThreshold(Math.min(1, Math.max(0, parsed)));
        }
      }

      const savedZoom = window.localStorage.getItem(STORAGE_KEYS.zoomMode) as ZoomMode | null;
      if (savedZoom && ["fit_page", "fit_width", "fit_height", "actual"].includes(savedZoom)) {
        setZoomMode(savedZoom);
      }

      const savedModelPath = window.localStorage.getItem(STORAGE_KEYS.modelPath);
      if (savedModelPath) {
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
      }
    } catch {
      // ignore storage failures
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.scoreThreshold, String(scoreThreshold));
    } catch {
      // ignore storage failures
    }
  }, [scoreThreshold]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.zoomMode, zoomMode);
    } catch {
      // ignore storage failures
    }
  }, [zoomMode]);

  useEffect(() => {
    try {
      if (modelPath) {
        window.localStorage.setItem(STORAGE_KEYS.modelPath, modelPath);
      } else {
        window.localStorage.removeItem(STORAGE_KEYS.modelPath);
      }
    } catch {
      // ignore storage failures
    }
  }, [modelPath]);

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
  }, [previewSrc, zoomMode]);

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
    if (zoomMode === "fit_width") {
      return { width: "100%" } as const;
    }
    if (zoomMode === "fit_height") {
      return { width: "max-content", height: "100%" } as const;
    }
    return { width: "max-content" } as const;
  }, [zoomMode]);

  const previewImageSx = useMemo(() => {
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
  }, [zoomMode]);

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

          <Menu
            positioning="below-start"
            open={openMenu === "settings"}
            onOpenChange={(_, data) => handleMenuOpenChange("settings", data.open)}
          >
            <MenuTrigger>
              <MenuButton
                appearance="transparent"
                className="menu-btn menu-btn-no-icon"
                onMouseEnter={() => handleMenuHoverSwitch("settings")}
              >
                设置
              </MenuButton>
            </MenuTrigger>
            <MenuPopover className="menu-popover-smooth">
              <MenuList>
                <MenuItem onClick={() => void selectModel()}>ONNX 模型</MenuItem>
                <MenuDivider />
                <MenuItem onClick={() => void applyScoreThreshold(0.3)}>置信度阈值 0.30 {scoreThreshold === 0.3 ? "✓" : ""}</MenuItem>
                <MenuItem onClick={() => void applyScoreThreshold(0.5)}>置信度阈值 0.50 {scoreThreshold === 0.5 ? "✓" : ""}</MenuItem>
                <MenuItem onClick={() => void applyScoreThreshold(0.7)}>置信度阈值 0.70 {scoreThreshold === 0.7 ? "✓" : ""}</MenuItem>
                <MenuDivider />
                <MenuItem onClick={() => setZoomMode("fit_page")}>缩放：适应页面 {zoomMode === "fit_page" ? "✓" : ""}</MenuItem>
                <MenuItem onClick={() => setZoomMode("fit_width")}>缩放：适应宽度 {zoomMode === "fit_width" ? "✓" : ""}</MenuItem>
                <MenuItem onClick={() => setZoomMode("fit_height")}>缩放：适应高度 {zoomMode === "fit_height" ? "✓" : ""}</MenuItem>
                <MenuItem onClick={() => setZoomMode("actual")}>缩放：原始尺寸 {zoomMode === "actual" ? "✓" : ""}</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>

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
          <div className="card-body visual-body">
            {errorMessage && (
              <MessageBar intent="error" className="error-bar">
                <MessageBarBody>{errorMessage}</MessageBarBody>
              </MessageBar>
            )}

            <div
              ref={stageRef}
              className={`visual-stage ${zoomMode === "fit_height" ? "visual-stage-fit-height" : ""} ${!previewSrc ? "visual-stage-empty" : ""}`}
            >
              {isPdfSelected && (
                <>
                  <Button
                    className="page-arrow page-arrow-left"
                    appearance="subtle"
                    icon={<ChevronLeft24Regular />}
                    onClick={() => void runModel(Math.max(0, pdfPageIndex - 1))}
                    disabled={!modelLoaded || !documentPath || loading || pdfPageIndex <= 0}
                    aria-label="上一页"
                  />
                  <Button
                    className="page-arrow page-arrow-right"
                    appearance="subtle"
                    icon={<ChevronRight24Regular />}
                    onClick={() => void runModel(pdfPageIndex + 1)}
                    disabled={!modelLoaded || !documentPath || loading || (pdfPageCount > 0 && pdfPageIndex >= pdfPageCount - 1)}
                    aria-label="下一页"
                  />
                </>
              )}

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
                  <Text className="empty-hint">请选择 PDF 或图片开始识别</Text>
                </div>
              )}
            </div>

            {isPdfSelected && (
              <div className="page-indicator-bottom">
                <Text>{pdfPageCount > 0 ? `第 ${pdfPageIndex + 1} / ${pdfPageCount} 页` : "页数未加载"}</Text>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

export default App;
