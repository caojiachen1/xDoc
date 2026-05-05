import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Button,
  Switch,
  Input,
  ProgressBar,
  Spinner,
  Text,
  Divider,
  Slider,
  Dropdown,
  Option,
} from "@fluentui/react-components";
import {
  Settings24Regular,
  Scan24Regular,
  Dismiss24Regular,
} from "@fluentui/react-icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import "./SettingsDialog.css";

/* ── types ─────────────────────────────────────────────── */
type ZoomMode = "fit_page" | "fit_width" | "fit_height" | "actual" | "custom";
type SettingsSection = "general" | "ocr";

interface DownloadProgress {
  progress: number;
  message: string;
  status: "downloading" | "completed" | "error" | "checking" | "idle";
}

interface Props {
  open: boolean;
  onClose: () => void;
  /* general */
  modelPath: string;
  modelLoaded: boolean;
  scoreThreshold: number;
  zoomMode: ZoomMode;
  onSelectModel: () => Promise<void>;
  onScoreThresholdChange: (v: number) => void;
  onZoomModeChange: (v: ZoomMode) => void;
  /* ocr */
  ocrEnabled: boolean;
  onOcrEnabledChange: (v: boolean) => void;
  ocrModelPath: string;
  onOcrModelPathChange: (v: string) => void;
}

const STORAGE_KEYS = {
  ocrEnabled: "xdoc.settings.ocr.enabled",
  ocrModelPath: "xdoc.settings.ocr.modelPath",
} as const;

/* ── component ──────────────────────────────────────────── */
function SettingsDialog(props: Props) {
  const {
    open, onClose,
    modelPath, modelLoaded, scoreThreshold, zoomMode,
    onSelectModel, onScoreThresholdChange, onZoomModeChange,
    ocrEnabled, onOcrEnabledChange,
    ocrModelPath, onOcrModelPathChange,
  } = props;

  const [section, setSection] = useState<SettingsSection>("general");
  const [download, setDownload] = useState<DownloadProgress>({
    progress: 0, message: "", status: "idle",
  });

  const unlistenRef = useRef<(() => void) | null>(null);

  /* ── download listener ─────────────────────────────── */
  useEffect(() => {
    const setup = async () => {
      unlistenRef.current = await listen<DownloadProgress>(
        "ocr-download-progress",
        (event) => {
          setDownload(event.payload);
        },
      );
    };
    setup();
    return () => {
      unlistenRef.current?.();
    };
  }, []);

  /* ── download & select handlers ───────────────────────── */
  const handleSelectOcrModel = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "选择 OCR 模型文件夹",
      });
      if (typeof selected === "string") {
        onOcrModelPathChange(selected);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDownload = useCallback(async () => {
    setDownload({ progress: 0, message: "启动下载...", status: "checking" });
    try {
      const REPO_URL = "https://www.modelscope.cn/ggml-org/GLM-OCR-GGUF.git";
      const targetDir = "model/GLM-OCR-GGUF";
      const result = await invoke<string>("download_ocr_model", {
        repoUrl: REPO_URL,
        targetDir,
      });
      onOcrModelPathChange(result);
    } catch (e) {
      setDownload({
        progress: 0,
        message: String(e),
        status: "error",
      });
    }
  }, [onOcrModelPathChange]);

  /* ── render ─────────────────────────────────────────── */
  if (!open) return null;

  const isDownloading = download.status === "downloading" || download.status === "checking";

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-window" onClick={(e) => e.stopPropagation()}>
        {/* ── top header with tabs ───────────────── */}
        <header className="settings-top-bar">
          <div className="settings-top-left">
            <Settings24Regular />
            <Text weight="semibold" className="settings-top-title">设置</Text>
            <nav className="settings-top-tabs">
              <button
                className={`settings-tab ${section === "general" ? "active" : ""}`}
                onClick={() => setSection("general")}
              >
                <Settings24Regular />
                <span>通用设置</span>
              </button>
              <button
                className={`settings-tab ${section === "ocr" ? "active" : ""}`}
                onClick={() => setSection("ocr")}
              >
                <Scan24Regular />
                <span>OCR 设置</span>
              </button>
            </nav>
          </div>
          <Button
            appearance="transparent"
            icon={<Dismiss24Regular />}
            onClick={onClose}
            aria-label="关闭"
          />
        </header>

        <div className="settings-content-body">
            {section === "general" && (
              <div className="settings-form">
                {/* ── ONNX Model ──────────────────── */}
                <div className="settings-field">
                  <Text weight="semibold">ONNX 模型</Text>
                  <div className="settings-field-row">
                    <Input
                      value={modelPath || ""}
                      readOnly
                      placeholder="未选择模型文件"
                      className="settings-input-flex"
                    />
                    <Button appearance="primary" onClick={() => void onSelectModel()}>
                      选择模型
                    </Button>
                  </div>
                  <Text size={100} className="settings-hint">
                    {modelLoaded ? "✅ 模型已加载" : modelPath ? "⚠ 模型加载失败" : "请选择 .onnx 模型文件"}
                  </Text>
                </div>

                <Divider className="settings-divider" />

                {/* ── Score Threshold ────────────── */}
                <div className="settings-field">
                  <Text weight="semibold">置信度阈值</Text>
                  <div className="settings-field-row">
                    <Slider
                      min={0}
                      max={1}
                      step={0.05}
                      value={scoreThreshold}
                      onChange={(_, d) => onScoreThresholdChange(d.value)}
                      className="settings-slider"
                    />
                    <Text className="settings-value-label">{scoreThreshold.toFixed(2)}</Text>
                  </div>
                  <Text size={100} className="settings-hint">
                    值越低检测框越多，值越高检测框越精准
                  </Text>
                </div>

                <Divider className="settings-divider" />

                {/* ── Zoom Mode ─────────────────── */}
                <div className="settings-field">
                  <Text weight="semibold">默认缩放</Text>
                  <Dropdown
                    value={zoomModeLabels[zoomMode]}
                    selectedOptions={[zoomMode]}
                    onOptionSelect={(_, d) => {
                      const v = d.optionValue as ZoomMode;
                      if (v) onZoomModeChange(v);
                    }}
                    className="settings-dropdown"
                  >
                    {zoomOptions.map((opt) => (
                      <Option key={opt.value} value={opt.value}>
                        {opt.label}
                      </Option>
                    ))}
                  </Dropdown>
                </div>
              </div>
            )}

            {section === "ocr" && (
              <div className="settings-form">
                {/* ── OCR Enable ─────────────────── */}
                <div className="settings-field">
                  <Text weight="semibold">启用 OCR</Text>
                  <div className="settings-field-row">
                    <Switch
                      checked={ocrEnabled}
                      onChange={(_, d) => onOcrEnabledChange(d.checked)}
                      label={ocrEnabled ? "已开启" : "已关闭"}
                    />
                  </div>
                  <Text size={100} className="settings-hint">
                    开启后将在文档解析时自动运行 OCR 识别
                  </Text>
                </div>

                <Divider className="settings-divider" />

                {/* ── Local Model Path ───────────── */}
                <div className="settings-field">
                  <Text weight="semibold">本地模型路径</Text>
                  <div className="settings-field-row">
                    <Input
                      value={ocrModelPath}
                      onChange={(_, d) => onOcrModelPathChange(d.value)}
                      placeholder="未选择，本地如果没有可以点击左侧选择或者右侧下载"
                      disabled={isDownloading}
                      className="settings-input-flex"
                    />
                    <Button
                      appearance="secondary"
                      onClick={handleSelectOcrModel}
                      disabled={isDownloading}
                    >
                      选择文件夹
                    </Button>
                    {!ocrModelPath && (
                      <Button
                        appearance="primary"
                        onClick={handleDownload}
                        disabled={isDownloading}
                      >
                        {isDownloading ? "下载中..." : "自动下载"}
                      </Button>
                    )}
                  </div>
                  <Text size={100} className="settings-hint">
                    点击"自动下载"从默认仓库克隆模型文件到根目录的 model 文件夹中
                  </Text>
                </div>

                {/* ── Download Progress ──────────── */}
                {download.status !== "idle" && (
                  <div className="settings-download-progress">
                    <Divider className="settings-divider" />
                    <div className="settings-field">
                      <div className="settings-progress-header">
                        <Text weight="semibold">
                          {download.status === "checking" && "检查环境..."}
                          {download.status === "downloading" && "下载中..."}
                          {download.status === "completed" && "下载完成"}
                          {download.status === "error" && "下载失败"}
                        </Text>
                        {isDownloading && <Spinner size="tiny" />}
                      </div>
                      <ProgressBar
                        max={100}
                        value={download.progress}
                        color={
                          download.status === "error"
                            ? "error"
                            : download.status === "completed"
                              ? "success"
                              : "brand"
                        }
                        className="settings-progress-bar"
                      />
                      <Text size={100} className="settings-progress-text">
                        {download.message}
                      </Text>
                    </div>
                  </div>
                )}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

/* ── helpers ────────────────────────────────────────────── */
const zoomModeLabels: Record<ZoomMode, string> = {
  fit_page: "适应页面",
  fit_width: "适应宽度",
  fit_height: "适应高度",
  actual: "原始尺寸",
  custom: "自定义",
};

const zoomOptions: { value: ZoomMode; label: string }[] = [
  { value: "fit_page", label: "适应页面" },
  { value: "fit_width", label: "适应宽度" },
  { value: "fit_height", label: "适应高度" },
  { value: "actual", label: "原始尺寸" },
];

export default SettingsDialog;
export { STORAGE_KEYS };
