import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Button,
  Card,
  Text,
  Spinner,
  Switch,
  Title2,
  Divider,
  ProgressBar,
  Dropdown,
  Option,
  Input,
} from "@fluentui/react-components";
import {
  CheckmarkCircle24Regular,
  ErrorCircle24Regular,
  ArrowRight24Regular,
  ArrowDownload24Regular,
} from "@fluentui/react-icons";
import { VENDOR_PRESETS, type LlmSettings } from "./SettingsDialog";

const DEFAULT_LAYOUT_MODEL_PATH = "model/PP-DocLayoutV3.onnx";
const DEFAULT_OCR_MODEL_PATH = "model/GLM-OCR-GGUF";

interface DownloadProgress {
  model_type: string;
  filename: string;
  current: number;
  total: number;
  progress: number;
  status: string;
  message: string;
}

interface ModelDownloadState {
  downloading: boolean;
  progress: number;
  message: string;
  status: string;
}

interface Props {
  onAllChecksPassed: () => void;
}

export default function EnvironmentCheck({ onAllChecksPassed }: Props) {
  const [checking, setChecking] = useState(true);

  // Model status
  const [layoutModelOk, setLayoutModelOk] = useState<boolean | null>(null);
  const [ocrModelOk, setOcrModelOk] = useState<boolean | null>(null);

  // OCR toggle
  const [ocrEnabled, setOcrEnabled] = useState(
    localStorage.getItem("xdoc.settings.ocr.enabled") === "true"
  );

  // Download states
  const [layoutDownload, setLayoutDownload] = useState<ModelDownloadState>({
    downloading: false,
    progress: 0,
    message: "",
    status: "idle",
  });
  const [ocrDownload, setOcrDownload] = useState<ModelDownloadState>({
    downloading: false,
    progress: 0,
    message: "",
    status: "idle",
  });

  // LLM settings
  const [llmSettings, setLlmSettings] = useState<LlmSettings>(() => {
    const vendor = localStorage.getItem("xdoc.settings.llm.vendor") || "deepseek";
    let vendorApiKeys: Record<string, string> = {};
    try {
      const raw = localStorage.getItem("xdoc.settings.llm.vendorApiKeys");
      if (raw) vendorApiKeys = JSON.parse(raw);
    } catch {}
    const preset = VENDOR_PRESETS[vendor];
    const baseUrl = localStorage.getItem("xdoc.settings.llm.baseUrl") || preset?.baseUrl || "";
    const model = localStorage.getItem("xdoc.settings.llm.model") || preset?.models?.[0] || "";
    return { vendor, vendorApiKeys, baseUrl, model };
  });

  const currentApiKey = llmSettings.vendorApiKeys[llmSettings.vendor] || "";

  // Persist LLM settings
  useEffect(() => {
    localStorage.setItem("xdoc.settings.llm.vendor", llmSettings.vendor);
    localStorage.setItem("xdoc.settings.llm.vendorApiKeys", JSON.stringify(llmSettings.vendorApiKeys));
    localStorage.setItem("xdoc.settings.llm.baseUrl", llmSettings.baseUrl);
    localStorage.setItem("xdoc.settings.llm.model", llmSettings.model);
  }, [llmSettings]);

  const unlistenRef = useRef<(() => void) | null>(null);

  // Listen for download progress events
  useEffect(() => {
    const setup = async () => {
      unlistenRef.current = await listen<DownloadProgress>(
        "model-download-progress",
        (event) => {
          const p = event.payload;
          const state: ModelDownloadState = {
            downloading: p.status === "downloading" || p.status === "file_completed",
            progress: p.progress,
            message: p.message,
            status: p.status,
          };

          if (p.model_type === "layout") {
            setLayoutDownload(state);
            if (p.status === "completed") {
              checkLayoutModel(DEFAULT_LAYOUT_MODEL_PATH);
            }
          } else if (p.model_type === "ocr") {
            setOcrDownload(state);
            if (p.status === "completed") {
              checkOcrModel(DEFAULT_OCR_MODEL_PATH);
            }
          }
        }
      );
    };
    setup();
    return () => {
      unlistenRef.current?.();
    };
  }, [ocrEnabled]);

  const checkLayoutModel = async (path: string) => {
    if (!path) {
      setLayoutModelOk(false);
      return;
    }
    try {
      const exists = await invoke<boolean>("check_model_exists", { modelPath: path });
      setLayoutModelOk(exists);
    } catch {
      setLayoutModelOk(false);
    }
  };

  const checkOcrModel = async (path: string) => {
    if (!ocrEnabled) {
      setOcrModelOk(true);
      return;
    }
    if (!path) {
      setOcrModelOk(false);
      return;
    }
    try {
      const exists = await invoke<boolean>("check_model_exists", { modelPath: path });
      setOcrModelOk(exists);
    } catch {
      setOcrModelOk(false);
    }
  };

  const runChecks = async () => {
    setChecking(true);
    await checkLayoutModel(DEFAULT_LAYOUT_MODEL_PATH);
    await checkOcrModel(DEFAULT_OCR_MODEL_PATH);
    setChecking(false);
  };

  useEffect(() => {
    runChecks();
  }, [ocrEnabled]);

  const downloadLayoutModel = async () => {
    setLayoutDownload({
      downloading: true,
      progress: 0,
      message: "准备下载...",
      status: "downloading",
    });
    try {
      await invoke<string>("download_onnx_model", {
        targetDir: "model",
      });
      localStorage.setItem("xdoc.settings.modelPath", DEFAULT_LAYOUT_MODEL_PATH);
    } catch (e) {
      setLayoutDownload({
        downloading: false,
        progress: 0,
        message: String(e),
        status: "error",
      });
    }
  };

  const downloadOcrModels = async () => {
    setOcrDownload({
      downloading: true,
      progress: 0,
      message: "准备下载...",
      status: "downloading",
    });
    try {
      await invoke<string>("download_ocr_models", {
        targetDir: "model/GLM-OCR-GGUF",
      });
      localStorage.setItem("xdoc.settings.ocr.modelPath", DEFAULT_OCR_MODEL_PATH);
    } catch (e) {
      setOcrDownload({
        downloading: false,
        progress: 0,
        message: String(e),
        status: "error",
      });
    }
  };

  const handleOcrToggle = (checked: boolean) => {
    setOcrEnabled(checked);
    localStorage.setItem("xdoc.settings.ocr.enabled", checked.toString());
  };

  const isReady = layoutModelOk && (!ocrEnabled || ocrModelOk);

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        height: "100vh",
        backgroundColor: "rgb(32, 32, 32)",
        overflow: "hidden",
        padding: "40px 0",
        boxSizing: "border-box",
      }}
    >
      <Card
        style={{
          width: 520,
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          maxHeight: "100%",
          overflow: "auto",
        }}
      >
        <Title2>初始设置</Title2>
        <Text style={{ color: "gray" }}>
          在使用之前，请确认本地模型已就绪。未安装的模型可在此一键下载，LLM 服务可选配置。
        </Text>

        <Divider />

        {/* ════ 模型配置 ════ */}
        <Text weight="semibold" style={{ fontSize: 14 }}>模型配置</Text>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Layout Model */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {checking || layoutDownload.downloading ? (
                  <Spinner size="tiny" />
                ) : layoutModelOk ? (
                  <CheckmarkCircle24Regular primaryFill="green" />
                ) : (
                  <ErrorCircle24Regular primaryFill="red" />
                )}
                <Text>布局分析模型 (PP-DocLayoutV3.onnx)</Text>
              </div>
              {!layoutModelOk && !checking && !layoutDownload.downloading && (
                <Button
                  size="small"
                  icon={<ArrowDownload24Regular />}
                  onClick={downloadLayoutModel}
                >
                  下载
                </Button>
              )}
            </div>
            <Text size={100} style={{ color: "gray" }}>
              {DEFAULT_LAYOUT_MODEL_PATH}
            </Text>
            {layoutDownload.downloading && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <ProgressBar
                  value={layoutDownload.progress / 100}
                  color={
                    layoutDownload.status === "error" ? "error" : "brand"
                  }
                />
                <Text size={100} style={{ color: layoutDownload.status === "error" ? "red" : "gray" }}>
                  {layoutDownload.message}
                </Text>
              </div>
            )}
            {!layoutModelOk &&
              !checking &&
              !layoutDownload.downloading &&
              layoutDownload.status === "error" && (
                <Text size={100} style={{ color: "red" }}>
                  下载失败: {layoutDownload.message}
                </Text>
              )}
          </div>

          {/* OCR Setup */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Text>GLM-OCR</Text>
            <Switch
              checked={ocrEnabled}
              onChange={(_, data) => handleOcrToggle(data.checked)}
            />
          </div>

          {ocrEnabled && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {checking || ocrDownload.downloading ? (
                    <Spinner size="tiny" />
                  ) : ocrModelOk ? (
                    <CheckmarkCircle24Regular primaryFill="green" />
                  ) : (
                    <ErrorCircle24Regular primaryFill="red" />
                  )}
                  <Text>OCR 模型 (GLM-OCR-GGUF)</Text>
                </div>
                {!ocrModelOk && !checking && !ocrDownload.downloading && (
                  <Button
                    size="small"
                    icon={<ArrowDownload24Regular />}
                    onClick={downloadOcrModels}
                  >
                    下载
                  </Button>
                )}
              </div>
              <Text size={100} style={{ color: "gray" }}>
                {DEFAULT_OCR_MODEL_PATH}
              </Text>
              {ocrDownload.downloading && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <ProgressBar
                    value={ocrDownload.progress / 100}
                    color={
                      ocrDownload.status === "error" ? "error" : "brand"
                    }
                  />
                  <Text
                    size={100}
                    style={{
                      color: ocrDownload.status === "error" ? "red" : "gray",
                    }}
                  >
                    {ocrDownload.message}
                  </Text>
                </div>
              )}
              {!ocrModelOk &&
                !checking &&
                !ocrDownload.downloading &&
                ocrDownload.status === "error" && (
                  <Text size={100} style={{ color: "red" }}>
                    下载失败: {ocrDownload.message}
                  </Text>
                )}
            </div>
          )}
        </div>

        <Divider />

        {/* ════ AI 服务 ════ */}
        <Text weight="semibold" style={{ fontSize: 14 }}>AI 服务 (可选)</Text>
        <Text size={100} style={{ color: "gray" }}>
          配置大语言模型后可在应用中直接使用 AI 功能，也可稍后在设置中配置。
        </Text>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Vendor */}
          <div>
            <Text size={100} weight="semibold">模型厂商</Text>
            <Dropdown
              value={VENDOR_PRESETS[llmSettings.vendor]?.label ?? "自定义"}
              selectedOptions={[llmSettings.vendor]}
              onOptionSelect={(_, d) => {
                const vendor = d.optionValue as string;
                const preset = VENDOR_PRESETS[vendor];
                setLlmSettings({
                  ...llmSettings,
                  vendor,
                  baseUrl: preset?.baseUrl ?? llmSettings.baseUrl,
                  model: preset?.models?.[0] ?? llmSettings.model,
                });
              }}
              style={{ width: "100%", marginTop: 4 }}
            >
              {Object.entries(VENDOR_PRESETS).map(([key, preset]) => (
                <Option key={key} value={key}>
                  {preset.label}
                </Option>
              ))}
            </Dropdown>
          </div>

          {/* API Key */}
          <div>
            <Text size={100} weight="semibold">API Key</Text>
            <Input
              type="password"
              value={currentApiKey}
              onChange={(_, d) =>
                setLlmSettings({
                  ...llmSettings,
                  vendorApiKeys: {
                    ...llmSettings.vendorApiKeys,
                    [llmSettings.vendor]: d.value,
                  },
                })
              }
              placeholder="输入 API Key"
              style={{ width: "100%", marginTop: 4 }}
            />
          </div>

          {/* Base URL */}
          <div>
            <Text size={100} weight="semibold">API Base URL</Text>
            <Input
              value={llmSettings.baseUrl}
              onChange={(_, d) =>
                setLlmSettings({ ...llmSettings, baseUrl: d.value })
              }
              placeholder="https://api.example.com/v1"
              style={{ width: "100%", marginTop: 4 }}
            />
            <Text size={100} style={{ color: "gray" }}>
              选择厂商后自动填入，也可手动修改
            </Text>
          </div>

          {/* Model */}
          <div>
            <Text size={100} weight="semibold">模型名称</Text>
            {VENDOR_PRESETS[llmSettings.vendor]?.models.length > 0 ? (
              <Dropdown
                value={llmSettings.model}
                selectedOptions={[llmSettings.model]}
                onOptionSelect={(_, d) => {
                  const model = d.optionValue as string;
                  if (model) setLlmSettings({ ...llmSettings, model });
                }}
                style={{ width: "100%", marginTop: 4 }}
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
                onChange={(_, d) =>
                  setLlmSettings({ ...llmSettings, model: d.value })
                }
                placeholder="输入模型名称，如 gpt-4o"
                style={{ width: "100%", marginTop: 4 }}
              />
            )}
          </div>
        </div>

        <Divider />

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button
            appearance="primary"
            disabled={!isReady || checking}
            icon={<ArrowRight24Regular />}
            iconPosition="after"
            onClick={onAllChecksPassed}
          >
            进入应用
          </Button>
        </div>
      </Card>
    </div>
  );
}
