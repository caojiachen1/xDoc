import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetch } from "@tauri-apps/plugin-http";
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
  BrainCircuit24Regular,
} from "@fluentui/react-icons";
import "./SettingsDialog.css";

/* ── types ─────────────────────────────────────────────── */
type ZoomMode = "fit_page" | "fit_width" | "fit_height" | "actual" | "custom";
type SettingsSection = "general" | "ocr" | "llm";

interface DownloadProgress {
  model_type: string;
  filename: string;
  current: number;
  total: number;
  progress: number;
  status: string;
  message: string;
}

interface OcrDownloadState {
  downloading: boolean;
  progress: number;
  message: string;
  status: string;
}

export interface LlmSettings {
  vendor: string;
  vendorApiKeys: Record<string, string>;
  baseUrl: string;
  model: string;
}

export const VENDOR_PRESETS: Record<string, { label: string; baseUrl: string; models: string[] }> = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", models: ["gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"] },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat"] },
  volcengine: { label: "火山引擎 (豆包)", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: ["doubao-seed-2-0-mini-260215"] },
  zhipu: { label: "智谱 AI (GLM)", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-4-plus", "glm-4-flash"] },
  moonshot: { label: "Moonshot (月之暗面)", baseUrl: "https://api.moonshot.cn/v1", models: ["moonshot-v1-8k", "moonshot-v1-32k"] },
  aliyun: { label: "阿里云百炼 (千问)", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen-plus", "qwen-max"] },
  siliconflow: { label: "硅基流动 (SiliconFlow)", baseUrl: "https://api.siliconflow.cn/v1", models: ["Qwen/Qwen2.5-7B-Instruct", "deepseek-ai/DeepSeek-V3"] },
  custom: { label: "自定义", baseUrl: "", models: [] },
};

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
  pdfTextExtractionEnabled: boolean;
  onPdfTextExtractionEnabledChange: (v: boolean) => void;
  /* ocr */
  ocrEnabled: boolean;
  onOcrEnabledChange: (v: boolean) => void;
  ocrModelPath: string;
  onOcrModelPathChange: (v: string) => void;
  /* llm */
  llmSettings: LlmSettings;
  onLlmSettingsChange: (v: LlmSettings) => void;
}

const STORAGE_KEYS = {
  ocrEnabled: "xdoc.settings.ocr.enabled",
  ocrModelPath: "xdoc.settings.ocr.modelPath",
  llmVendor: "xdoc.settings.llm.vendor",
  llmVendorApiKeys: "xdoc.settings.llm.vendorApiKeys",
  llmBaseUrl: "xdoc.settings.llm.baseUrl",
  llmModel: "xdoc.settings.llm.model",
} as const;

/* ── component ──────────────────────────────────────────── */
function SettingsDialog(props: Props) {
  const {
    open, onClose,
    modelPath, modelLoaded, scoreThreshold, zoomMode,
    onSelectModel, onScoreThresholdChange, onZoomModeChange,
    pdfTextExtractionEnabled, onPdfTextExtractionEnabledChange,
    ocrEnabled, onOcrEnabledChange,
    ocrModelPath, onOcrModelPathChange,
    llmSettings, onLlmSettingsChange,
  } = props;

  const [section, setSection] = useState<SettingsSection>("general");
  const [download, setDownload] = useState<OcrDownloadState>({
    downloading: false, progress: 0, message: "", status: "idle",
  });

  // Model list fetching
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchModelsError, setFetchModelsError] = useState("");

  const unlistenRef = useRef<(() => void) | null>(null);

  /* ── download listener ─────────────────────────────── */
  useEffect(() => {
    const setup = async () => {
      unlistenRef.current = await listen<DownloadProgress>(
        "model-download-progress",
        (event) => {
          const p = event.payload;
          if (p.model_type !== "ocr") return;
          setDownload({
            downloading: p.status === "downloading" || p.status === "file_completed",
            progress: p.progress,
            message: p.message,
            status: p.status,
          });
          if (p.status === "completed") {
            onOcrModelPathChange("model/GLM-OCR-GGUF");
          }
        },
      );
    };
    setup();
    return () => {
      unlistenRef.current?.();
    };
  }, []);

  // Clear fetched models when vendor or baseUrl changes
  useEffect(() => {
    setFetchedModels([]);
    setFetchModelsError("");
  }, [llmSettings.vendor, llmSettings.baseUrl]);

  /* ── download handler ─────────────────────────────────── */
  const handleDownload = useCallback(async () => {
    setDownload({
      downloading: true,
      progress: 0,
      message: "准备下载...",
      status: "downloading",
    });
    try {
      await invoke<string>("download_ocr_models", {
        targetDir: "model/GLM-OCR-GGUF",
      });
    } catch (e) {
      setDownload({
        downloading: false,
        progress: 0,
        message: String(e),
        status: "error",
      });
    }
  }, []);

  const currentApiKey = llmSettings.vendorApiKeys[llmSettings.vendor] || "";

  const handleFetchModels = useCallback(async () => {
    if (!llmSettings.baseUrl || !currentApiKey) {
      setFetchModelsError("请先填写 API Base URL 和 API Key");
      return;
    }
    setFetchingModels(true);
    setFetchModelsError("");
    setFetchedModels([]);

    try {
      const baseUrl = llmSettings.baseUrl.replace(/\/+$/, "");
      const response = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${currentApiKey}` },
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`请求失败 (${response.status}): ${errText}`);
      }
      const data = await response.json();
      const ids: string[] = (data.data ?? [])
        .map((m: any) => m.id ?? m.model ?? m.name)
        .filter(Boolean)
        .sort();
      // Volcengine: restrict to the preset model
      const finalIds = llmSettings.vendor === "volcengine"
        ? ids.filter((id) => VENDOR_PRESETS.volcengine.models.includes(id))
        : ids;
      if (finalIds.length === 0) {
        setFetchedModels(llmSettings.vendor === "volcengine" ? VENDOR_PRESETS.volcengine.models : []);
      } else {
        setFetchedModels(finalIds);
      }
    } catch (e) {
      setFetchModelsError(String(e));
    } finally {
      setFetchingModels(false);
    }
  }, [llmSettings.baseUrl, currentApiKey]);

  /* ── render ─────────────────────────────────────────── */
  if (!open) return null;

  const isDownloading = download.downloading;

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
              <button
                className={`settings-tab ${section === "llm" ? "active" : ""}`}
                onClick={() => setSection("llm")}
              >
                <BrainCircuit24Regular />
                <span>LLM 设置</span>
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

                <Divider className="settings-divider" />

                {/* ── PDF Text Extraction ────────────── */}
                <div className="settings-field">
                  <div className="settings-field-row" style={{ justifyContent: "space-between" }}>
                    <div>
                      <Text weight="semibold">PDF 原文提取</Text>
                      <Text size={100} className="settings-hint" style={{ display: "block", marginTop: 4 }}>
                        关闭则在段落显示栏中只显示 OCR 结果
                      </Text>
                    </div>
                    <Switch
                      checked={pdfTextExtractionEnabled}
                      onChange={(_, d) => onPdfTextExtractionEnabledChange(d.checked)}
                    />
                  </div>
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
                  <Text weight="semibold">模型路径</Text>
                  <div className="settings-field-row">
                    <Input
                      value={ocrModelPath}
                      readOnly
                      placeholder="默认: model/GLM-OCR-GGUF"
                      className="settings-input-flex"
                    />
                    <Button
                      appearance="primary"
                      onClick={handleDownload}
                      disabled={isDownloading}
                    >
                      {isDownloading ? "下载中..." : "下载模型"}
                    </Button>
                  </div>
                  <Text size={100} className="settings-hint">
                    点击"下载模型"从 ModelScope 下载 OCR 模型文件到 model/GLM-OCR-GGUF 目录
                  </Text>
                </div>

                {/* ── Download Progress ──────────── */}
                {download.status !== "idle" && (
                  <div className="settings-download-progress">
                    <Divider className="settings-divider" />
                    <div className="settings-field">
                      <div className="settings-progress-header">
                        <Text weight="semibold">
                          {download.status === "downloading" && "下载中..."}
                          {download.status === "file_completed" && "处理中..."}
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

            {section === "llm" && (
              <div className="settings-form">
                {/* ── Vendor Selection ─────────────── */}
                <div className="settings-field">
                  <Text weight="semibold">模型厂商</Text>
                  <Dropdown
                    value={VENDOR_PRESETS[llmSettings.vendor]?.label ?? "自定义"}
                    selectedOptions={[llmSettings.vendor]}
                    onOptionSelect={(_, d) => {
                      const vendor = d.optionValue as string;
                      const preset = VENDOR_PRESETS[vendor];
                      onLlmSettingsChange({
                        ...llmSettings,
                        vendor,
                        baseUrl: preset?.baseUrl ?? llmSettings.baseUrl,
                        model: preset?.models?.[0] ?? llmSettings.model,
                      });
                    }}
                    className="settings-dropdown"
                    style={{ width: "100%" }}
                  >
                    {Object.entries(VENDOR_PRESETS).map(([key, preset]) => (
                      <Option key={key} value={key}>
                        {preset.label}
                      </Option>
                    ))}
                  </Dropdown>
                </div>

                <Divider className="settings-divider" />

                {/* ── Base URL ─────────────────────── */}
                <div className="settings-field">
                  <Text weight="semibold">API Base URL</Text>
                  <Input
                    value={llmSettings.baseUrl}
                    onChange={(_, d) => onLlmSettingsChange({ ...llmSettings, baseUrl: d.value })}
                    placeholder="https://api.openai.com/v1"
                    className="settings-input-flex"
                  />
                  <Text size={100} className="settings-hint">
                    选择厂商后自动填入，也可手动修改
                  </Text>
                </div>

                <Divider className="settings-divider" />

                {/* ── Model ────────────────────────── */}
                <div className="settings-field">
                  <Text weight="semibold">模型名称</Text>
                  <div className="settings-field-row">
                    {fetchedModels.length > 0 ? (
                      <Dropdown
                        value={llmSettings.model}
                        selectedOptions={[llmSettings.model]}
                        onOptionSelect={(_, d) => {
                          const model = d.optionValue as string;
                          if (model) onLlmSettingsChange({ ...llmSettings, model });
                        }}
                        className="settings-dropdown"
                        style={{ flex: 1 }}
                      >
                        {fetchedModels.map((m) => (
                          <Option key={m} value={m}>
                            {m}
                          </Option>
                        ))}
                      </Dropdown>
                    ) : llmSettings.vendor !== "custom" && VENDOR_PRESETS[llmSettings.vendor]?.models.length > 0 ? (
                      <Dropdown
                        value={llmSettings.model}
                        selectedOptions={[llmSettings.model]}
                        onOptionSelect={(_, d) => {
                          const model = d.optionValue as string;
                          if (model) onLlmSettingsChange({ ...llmSettings, model });
                        }}
                        className="settings-dropdown"
                        style={{ flex: 1 }}
                      >
                        {VENDOR_PRESETS[llmSettings.vendor].models.map((m) => (
                          <Option key={m} value={m}>
                            {m}
                          </Option>
                        ))}
                      </Dropdown>
                    ) : (
                      <Input
                        value={llmSettings.model}
                        onChange={(_, d) => onLlmSettingsChange({ ...llmSettings, model: d.value })}
                        placeholder="输入模型名称，如 gpt-4o"
                        className="settings-input-flex"
                      />
                    )}
                    <Button
                      appearance="secondary"
                      onClick={handleFetchModels}
                      disabled={fetchingModels || !llmSettings.baseUrl || !currentApiKey}
                    >
                      {fetchingModels ? "获取中..." : "获取模型列表"}
                    </Button>
                  </div>
                  {fetchModelsError && (
                    <Text size={100} style={{ color: "#ff6b6b" }}>{fetchModelsError}</Text>
                  )}
                  <Text size={100} className="settings-hint">
                    点击"获取模型列表"从 API 自动获取可用模型，或从预设/手动输入
                  </Text>
                </div>

                <Divider className="settings-divider" />

                {/* ── API Key ──────────────────────── */}
                <div className="settings-field">
                  <Text weight="semibold">API Key</Text>
                  <div className="settings-field-row">
                    <Input
                      type="password"
                      value={currentApiKey}
                      onChange={(_, d) => onLlmSettingsChange({
                        ...llmSettings,
                        vendorApiKeys: { ...llmSettings.vendorApiKeys, [llmSettings.vendor]: d.value },
                      })}
                      placeholder="输入您的 API Key"
                      className="settings-input-flex"
                    />
                  </div>
                  <Text size={100} className="settings-hint">
                    每个厂商独立保存 API Key，切换厂商时自动切换
                  </Text>
                </div>
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
