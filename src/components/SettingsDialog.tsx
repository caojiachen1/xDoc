import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetch } from "@tauri-apps/plugin-http";
import { PluginManagerDialog } from "../plugin";
import {
  Button,
  Switch,
  Input,
  ProgressBar,
  Spinner,
  Text,
  Slider,
  Dropdown,
  Option,
} from "@fluentui/react-components";
import {
  Settings24Regular,
  Scan24Regular,
  Dismiss24Regular,
  BrainCircuit24Regular,
  TextFont24Regular,
  PuzzleCubePiece24Regular,
} from "@fluentui/react-icons";
import "./SettingsDialog.css";

/* ── types ─────────────────────────────────────────────── */
type ZoomMode = "fit_page" | "fit_width" | "fit_height" | "actual" | "custom";
type SettingsSection = "general" | "appearance" | "ocr" | "llm" | "plugin";

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

/* ── font presets ──────────────────────────────────────── */
export const FONT_PRESETS: { label: string; value: string }[] = [
  { label: "宋体 (Serif)", value: `"Times New Roman", SimSun, serif` },
  { label: "黑体 (Sans)", value: `"Microsoft YaHei", "PingFang SC", sans-serif` },
  { label: "系统默认", value: `system-ui, sans-serif` },
  { label: "等宽字体", value: `"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace` },
  { label: "楷体", value: `KaiTi, "AR PL UKai CN", serif` },
];

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
  /* appearance */
  textFontFamily: string;
  onTextFontFamilyChange: (v: string) => void;
  textFontSize: number;
  onTextFontSizeChange: (v: number) => void;
  aiFontFamily: string;
  onAiFontFamilyChange: (v: string) => void;
  aiFontSize: number;
  onAiFontSizeChange: (v: number) => void;
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

/* ── nav items ─────────────────────────────────────────── */
const NAV_ITEMS: { key: SettingsSection; label: string; icon: React.ReactNode }[] = [
  { key: "general", label: "通用", icon: <Settings24Regular /> },
  { key: "appearance", label: "外观", icon: <TextFont24Regular /> },
  { key: "ocr", label: "OCR", icon: <Scan24Regular /> },
  { key: "llm", label: "LLM", icon: <BrainCircuit24Regular /> },
  { key: "plugin", label: "插件", icon: <PuzzleCubePiece24Regular /> },
];

/* ── component ──────────────────────────────────────────── */
function SettingsDialog(props: Props) {
  const {
    open, onClose,
    modelPath, modelLoaded, scoreThreshold, zoomMode,
    onSelectModel, onScoreThresholdChange, onZoomModeChange,
    pdfTextExtractionEnabled, onPdfTextExtractionEnabledChange,
    textFontFamily, onTextFontFamilyChange,
    textFontSize, onTextFontSizeChange,
    aiFontFamily, onAiFontFamilyChange,
    aiFontSize, onAiFontSizeChange,
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

  /* ── helpers ──────────────────────────────────────────── */
  const findFontLabel = (value: string) =>
    FONT_PRESETS.find((f) => f.value === value)?.label ?? "自定义";

  /* ── render ─────────────────────────────────────────── */
  if (!open) return null;

  const isDownloading = download.downloading;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-window" onClick={(e) => e.stopPropagation()}>
        {/* ── left sidebar ─────────────────────────── */}
        <nav className="settings-sidebar">
          <div className="settings-sidebar-header">
            <Settings24Regular />
            <Text weight="semibold" size={300}>设置</Text>
          </div>
          <div className="settings-sidebar-nav">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                className={`settings-nav-item ${section === item.key ? "active" : ""}`}
                onClick={() => setSection(item.key)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </nav>

        {/* ── right content area ───────────────────── */}
        <div className="settings-main">
          <header className="settings-main-header">
            <Text weight="semibold" size={400}>
              {NAV_ITEMS.find((n) => n.key === section)?.label ?? "设置"}
            </Text>
            <Button
              appearance="transparent"
              icon={<Dismiss24Regular />}
              onClick={onClose}
              aria-label="关闭"
              size="small"
            />
          </header>

          <div className="settings-content-body">
            {/* ══════ GENERAL ══════ */}
            {section === "general" && (
              <div className="settings-form">
                <div className="sf-group">
                  <div className="sf-row">
                    <div className="sf-label">
                      <Text weight="semibold">ONNX 模型</Text>
                      <Text size={100} className="settings-hint">
                        {modelLoaded ? "✅ 已加载" : modelPath ? "⚠ 加载失败" : "未选择"}
                      </Text>
                    </div>
                    <div className="sf-control compact">
                      <Input value={modelPath || ""} readOnly placeholder="未选择模型" className="settings-input-flex" />
                      <Button appearance="primary" size="small" onClick={() => void onSelectModel()}>选择</Button>
                    </div>
                  </div>
                </div>

                <div className="sf-group">
                  <div className="sf-row">
                    <div className="sf-label">
                      <Text weight="semibold">置信度阈值</Text>
                      <Text size={100} className="settings-hint">值越低检测框越多</Text>
                    </div>
                    <div className="sf-control compact">
                      <Slider
                        min={0} max={1} step={0.05}
                        value={scoreThreshold}
                        onChange={(_, d) => onScoreThresholdChange(d.value)}
                        className="settings-slider"
                      />
                      <Text className="settings-value-label">{scoreThreshold.toFixed(2)}</Text>
                    </div>
                  </div>
                </div>

                <div className="sf-group">
                  <div className="sf-row">
                    <div className="sf-label">
                      <Text weight="semibold">默认缩放</Text>
                    </div>
                    <div className="sf-control">
                      <Dropdown
                        value={zoomModeLabels[zoomMode]}
                        selectedOptions={[zoomMode]}
                        onOptionSelect={(_, d) => {
                          const v = d.optionValue as ZoomMode;
                          if (v) onZoomModeChange(v);
                        }}
                        className="settings-dropdown"
                        size="small"
                      >
                        {zoomOptions.map((opt) => (
                          <Option key={opt.value} value={opt.value}>{opt.label}</Option>
                        ))}
                      </Dropdown>
                    </div>
                  </div>
                </div>

                <div className="sf-group">
                  <div className="sf-row">
                    <div className="sf-label">
                      <Text weight="semibold">PDF 原文提取</Text>
                      <Text size={100} className="settings-hint">关闭则只显示 OCR 结果</Text>
                    </div>
                    <div className="sf-control">
                      <Switch
                        checked={pdfTextExtractionEnabled}
                        onChange={(_, d) => onPdfTextExtractionEnabledChange(d.checked)}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ══════ APPEARANCE ══════ */}
            {section === "appearance" && (
              <div className="settings-form">
                {/* ── Paragraph Section ── */}
                <div className="sf-section-title">
                  <Text weight="semibold" size={200}>段落栏</Text>
                </div>

                <div className="sf-group">
                  <div className="sf-row">
                    <div className="sf-label">
                      <Text weight="semibold">字体</Text>
                    </div>
                    <div className="sf-control">
                      <Dropdown
                        value={findFontLabel(textFontFamily)}
                        selectedOptions={[textFontFamily]}
                        onOptionSelect={(_, d) => {
                          const v = d.optionValue as string;
                          if (v) onTextFontFamilyChange(v);
                        }}
                        className="settings-dropdown"
                        size="small"
                      >
                        {FONT_PRESETS.map((f) => (
                          <Option key={f.value} value={f.value} text={f.label}>
                            <span style={{ fontFamily: f.value }}>{f.label}</span>
                          </Option>
                        ))}
                      </Dropdown>
                    </div>
                  </div>
                </div>

                <div className="sf-group">
                  <div className="sf-row">
                    <div className="sf-label">
                      <Text weight="semibold">字号</Text>
                      <Text size={100} className="settings-hint">{textFontSize}px</Text>
                    </div>
                    <div className="sf-control compact">
                      <Slider
                        min={10} max={40} step={1}
                        value={textFontSize}
                        onChange={(_, d) => onTextFontSizeChange(d.value)}
                        className="settings-slider"
                      />
                      <div className="sf-font-preview" style={{ fontFamily: textFontFamily, fontSize: textFontSize }}>
                        段落预览 Preview
                      </div>
                    </div>
                  </div>
                </div>

                <div className="sf-separator" />

                {/* ── AI Section ── */}
                <div className="sf-section-title">
                  <Text weight="semibold" size={200}>AI 解读栏</Text>
                </div>

                <div className="sf-group">
                  <div className="sf-row">
                    <div className="sf-label">
                      <Text weight="semibold">字体</Text>
                    </div>
                    <div className="sf-control">
                      <Dropdown
                        value={findFontLabel(aiFontFamily)}
                        selectedOptions={[aiFontFamily]}
                        onOptionSelect={(_, d) => {
                          const v = d.optionValue as string;
                          if (v) onAiFontFamilyChange(v);
                        }}
                        className="settings-dropdown"
                        size="small"
                      >
                        {FONT_PRESETS.map((f) => (
                          <Option key={f.value} value={f.value} text={f.label}>
                            <span style={{ fontFamily: f.value }}>{f.label}</span>
                          </Option>
                        ))}
                      </Dropdown>
                    </div>
                  </div>
                </div>

                <div className="sf-group">
                  <div className="sf-row">
                    <div className="sf-label">
                      <Text weight="semibold">字号</Text>
                      <Text size={100} className="settings-hint">{aiFontSize}px</Text>
                    </div>
                    <div className="sf-control compact">
                      <Slider
                        min={10} max={40} step={1}
                        value={aiFontSize}
                        onChange={(_, d) => onAiFontSizeChange(d.value)}
                        className="settings-slider"
                      />
                      <div className="sf-font-preview" style={{ fontFamily: aiFontFamily, fontSize: aiFontSize }}>
                        解读预览 Preview
                      </div>
                    </div>
                  </div>
                </div>

                <div className="sf-separator" />

                {/* ── Sync button ── */}
                <div className="sf-group">
                  <div className="sf-row">
                    <div className="sf-label">
                      <Text weight="semibold">同步设置</Text>
                      <Text size={100} className="settings-hint">将段落栏的字体同步到解读栏</Text>
                    </div>
                    <div className="sf-control">
                      <Button
                        appearance="subtle"
                        size="small"
                        onClick={() => {
                          onAiFontFamilyChange(textFontFamily);
                          onAiFontSizeChange(textFontSize);
                        }}
                      >
                        同步 →
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ══════ OCR ══════ */}
            {section === "ocr" && (
              <div className="settings-form">
                <div className="sf-group">
                  <div className="sf-row">
                    <div className="sf-label">
                      <Text weight="semibold">启用 OCR</Text>
                      <Text size={100} className="settings-hint">解析时自动识别</Text>
                    </div>
                    <div className="sf-control">
                      <Switch
                        checked={ocrEnabled}
                        onChange={(_, d) => onOcrEnabledChange(d.checked)}
                        label={ocrEnabled ? "已开启" : "已关闭"}
                      />
                    </div>
                  </div>
                </div>

                <div className="sf-group">
                  <div className="sf-row">
                    <div className="sf-label">
                      <Text weight="semibold">模型路径</Text>
                      <Text size={100} className="settings-hint">从 ModelScope 下载</Text>
                    </div>
                    <div className="sf-control compact">
                      <Input value={ocrModelPath} readOnly placeholder="model/GLM-OCR-GGUF" className="settings-input-flex" />
                      <Button appearance="primary" size="small" onClick={handleDownload} disabled={isDownloading}>
                        {isDownloading ? "下载中..." : "下载"}
                      </Button>
                    </div>
                  </div>
                </div>

                {download.status !== "idle" && (
                  <div className="sf-group">
                    <div className="settings-progress-header">
                      <Text weight="semibold" size={200}>
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
                      color={download.status === "error" ? "error" : download.status === "completed" ? "success" : "brand"}
                      className="settings-progress-bar"
                    />
                    <Text size={100} className="settings-progress-text">{download.message}</Text>
                  </div>
                )}
              </div>
            )}

            {/* ══════ LLM ══════ */}
            {section === "llm" && (
              <div className="settings-form">
                <div className="sf-group">
                  <div className="sf-row">
                    <div className="sf-label"><Text weight="semibold">模型厂商</Text></div>
                    <div className="sf-control">
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
                        className="settings-dropdown-full"
                        size="small"
                      >
                        {Object.entries(VENDOR_PRESETS).map(([key, preset]) => (
                          <Option key={key} value={key}>{preset.label}</Option>
                        ))}
                      </Dropdown>
                    </div>
                  </div>
                </div>

                <div className="sf-group">
                  <div className="sf-row">
                    <div className="sf-label">
                      <Text weight="semibold">API Base URL</Text>
                      <Text size={100} className="settings-hint">选择厂商后自动填入</Text>
                    </div>
                    <div className="sf-control compact">
                      <Input
                        value={llmSettings.baseUrl}
                        onChange={(_, d) => onLlmSettingsChange({ ...llmSettings, baseUrl: d.value })}
                        placeholder="https://api.openai.com/v1"
                        className="settings-input-flex"
                        size="small"
                      />
                    </div>
                  </div>
                </div>

                <div className="sf-group">
                  <div className="sf-row">
                    <div className="sf-label">
                      <Text weight="semibold">模型名称</Text>
                      {fetchModelsError && <Text size={100} style={{ color: "#ff6b6b" }}>{fetchModelsError}</Text>}
                    </div>
                    <div className="sf-control">
                      {fetchedModels.length > 0 ? (
                        <Dropdown
                          value={llmSettings.model}
                          selectedOptions={[llmSettings.model]}
                          onOptionSelect={(_, d) => {
                            const model = d.optionValue as string;
                            if (model) onLlmSettingsChange({ ...llmSettings, model });
                          }}
                          className="settings-dropdown"
                          size="small"
                        >
                          {fetchedModels.map((m) => (
                            <Option key={m} value={m}>{m}</Option>
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
                          size="small"
                        >
                          {VENDOR_PRESETS[llmSettings.vendor].models.map((m) => (
                            <Option key={m} value={m}>{m}</Option>
                          ))}
                        </Dropdown>
                      ) : (
                        <Input
                          value={llmSettings.model}
                          onChange={(_, d) => onLlmSettingsChange({ ...llmSettings, model: d.value })}
                          placeholder="gpt-4o"
                          className="settings-dropdown"
                          size="small"
                        />
                      )}
                      <Button
                        appearance="subtle"
                        size="small"
                        onClick={handleFetchModels}
                        disabled={fetchingModels || !llmSettings.baseUrl || !currentApiKey}
                      >
                        {fetchingModels ? "获取中..." : "获取"}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="sf-group">
                  <div className="sf-row">
                    <div className="sf-label">
                      <Text weight="semibold">API Key</Text>
                      <Text size={100} className="settings-hint">每个厂商独立保存</Text>
                    </div>
                    <div className="sf-control compact">
                      <Input
                        type="password"
                        value={currentApiKey}
                        onChange={(_, d) => onLlmSettingsChange({
                          ...llmSettings,
                          vendorApiKeys: { ...llmSettings.vendorApiKeys, [llmSettings.vendor]: d.value },
                        })}
                        placeholder="输入 API Key"
                        className="settings-input-flex"
                        size="small"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {section === "plugin" && (
              <PluginManagerSection />
            )}
          </div>
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

/* ── Plugin section wrapper ────────────────────────────── */
function PluginManagerSection() {
  return (
    <div className="settings-section plugin-section">
      <PluginManagerDialog />
    </div>
  );
}

export default SettingsDialog;
export { STORAGE_KEYS };
