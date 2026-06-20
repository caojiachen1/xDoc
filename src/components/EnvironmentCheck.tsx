import { useEffect, useState, useRef, useCallback } from "react";
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
  Info24Regular,
  ArrowRight24Regular,
  ArrowDownload24Regular,
} from "@fluentui/react-icons";
import { VENDOR_PRESETS, type LlmSettings } from "./SettingsDialog";

const DEFAULT_LAYOUT_MODEL_PATH = "model/PP-DocLayoutV3.onnx";

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

interface OcrModelInfo {
  id: string;
  label: string;
  engine: string;
  description: string;
  params: string;
  downloaded: boolean;
}

interface Props {
  onAllChecksPassed: () => void;
}

function getRepoDirName(id: string): string {
  const repoMap: Record<string, string> = {
    "glm-ocr": "GLM-OCR-GGUF",
    "deepseek-ocr": "DeepSeek-OCR-GGUF",
    "hunyuan-ocr": "HunyuanOCR-GGUF",
    "dots-ocr": "dots.ocr-GGUF",
    "qianfan-ocr": "Qianfan-OCR-GGUF",
    "lighton-ocr-1b": "LightOnOCR-1B-1025-GGUF",
    "ppocrv6-medium": "ppocrv6-medium",
    "ppocrv6-small": "ppocrv6-small",
    "ppocrv6-tiny": "ppocrv6-tiny",
  };
  return repoMap[id] || "GLM-OCR-GGUF";
}

export default function EnvironmentCheck({ onAllChecksPassed }: Props) {
  const [checking, setChecking] = useState(true);

  // Layout model
  const [layoutModelOk, setLayoutModelOk] = useState<boolean | null>(null);
  const [layoutDownload, setLayoutDownload] = useState<ModelDownloadState>({
    downloading: false, progress: 0, message: "", status: "idle",
  });

  // OCR settings
  const [ocrEnabled, setOcrEnabled] = useState(
    localStorage.getItem("xdoc.settings.ocr.enabled") === "true"
  );
  const [ocrModelId, setOcrModelId] = useState(
    localStorage.getItem("xdoc.settings.ocr.modelId") || "glm-ocr"
  );
  const [ocrModelPath, setOcrModelPath] = useState(
    localStorage.getItem("xdoc.settings.ocr.modelPath") || `model/${getRepoDirName("glm-ocr")}`
  );
  const [ocrModelList, setOcrModelList] = useState<OcrModelInfo[]>([]);
  const [ocrModelExists, setOcrModelExists] = useState<boolean | null>(null);
  const [ocrDownload, setOcrDownload] = useState<ModelDownloadState>({
    downloading: false, progress: 0, message: "", status: "idle",
  });

  // LLM settings
  const [llmSettings, setLlmSettings] = useState<LlmSettings>(() => {
    const vendor = localStorage.getItem("xdoc.settings.llm.vendor") || "deepseek";
    let vendorApiKeys: Record<string, string> = {};
    try {
      const raw = localStorage.getItem("xdoc.settings.llm.vendorApiKeys");
      if (raw) vendorApiKeys = JSON.parse(raw);
    } catch { /* ignore */ }
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

  // Fetch OCR model catalog
  useEffect(() => {
    invoke<OcrModelInfo[]>("list_ocr_models")
      .then(setOcrModelList)
      .catch((e) => console.warn("[OCR] list_ocr_models failed:", e));
  }, []);

  // Download progress listener
  const unlistenRef = useRef<(() => void) | null>(null);
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
            if (p.status === "completed") checkLayoutModel(DEFAULT_LAYOUT_MODEL_PATH);
          } else if (p.model_type === "ocr") {
            setOcrDownload(state);
            if (p.status === "completed") {
              checkOcrModelExists();
              invoke<OcrModelInfo[]>("list_ocr_models").then(setOcrModelList).catch(() => {});
            }
          }
        },
      );
    };
    setup();
    return () => { unlistenRef.current?.(); };
  }, []);

  const checkLayoutModel = async (path: string) => {
    if (!path) { setLayoutModelOk(false); return; }
    try {
      setLayoutModelOk(await invoke<boolean>("check_model_exists", { modelPath: path }));
    } catch { setLayoutModelOk(false); }
  };

  const checkOcrModelExists = useCallback(async () => {
    if (!ocrEnabled || !ocrModelPath) { setOcrModelExists(ocrEnabled ? false : null); return; }
    try {
      setOcrModelExists(await invoke<boolean>("check_model_exists", { modelPath: ocrModelPath }));
    } catch { setOcrModelExists(false); }
  }, [ocrEnabled, ocrModelPath]);

  useEffect(() => { checkOcrModelExists(); }, [checkOcrModelExists]);

  const runChecks = async () => {
    setChecking(true);
    await checkLayoutModel(DEFAULT_LAYOUT_MODEL_PATH);
    setChecking(false);
  };

  useEffect(() => { runChecks(); }, []);

  const downloadLayoutModel = async () => {
    setLayoutDownload({ downloading: true, progress: 0, message: "准备下载...", status: "downloading" });
    try {
      await invoke<string>("download_onnx_model", { targetDir: "model" });
      localStorage.setItem("xdoc.settings.modelPath", DEFAULT_LAYOUT_MODEL_PATH);
    } catch (e) {
      setLayoutDownload({ downloading: false, progress: 0, message: String(e), status: "error" });
    }
  };

  const downloadOcrModel = useCallback(async () => {
    const repoName = getRepoDirName(ocrModelId);
    const targetDir = `model/${repoName}`;
    const isPpocrv6 = ocrModelId.startsWith("ppocrv6");

    setOcrDownload({ downloading: true, progress: 0, message: "准备下载...", status: "downloading" });
    try {
      if (isPpocrv6) {
        await invoke<string>("download_ppocrv6_models", { ocrModelId, targetDir });
      } else {
        await invoke<string>("download_ocr_models", { ocrModelId, targetDir });
      }
    } catch (e) {
      setOcrDownload({ downloading: false, progress: 0, message: String(e), status: "error" });
    }
  }, [ocrModelId]);

  const handleOcrToggle = (checked: boolean) => {
    setOcrEnabled(checked);
    localStorage.setItem("xdoc.settings.ocr.enabled", checked.toString());
  };

  const handleOcrModelSelect = (id: string) => {
    setOcrModelId(id);
    const path = `model/${getRepoDirName(id)}`;
    setOcrModelPath(path);
    localStorage.setItem("xdoc.settings.ocr.modelId", id);
    localStorage.setItem("xdoc.settings.ocr.modelPath", path);
  };

  const isReady = !checking;
  const selectedOcrModel = ocrModelList.find((m) => m.id === ocrModelId);
  const ggufModels = ocrModelList.filter((m) => m.engine === "gguf");
  const ppocrModels = ocrModelList.filter((m) => m.engine === "ppocrv6");

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        height: "100vh",
        backgroundColor: "rgb(32, 32, 32)",
        overflow: "hidden",
        boxSizing: "border-box",
      }}
    >
      <Card
        style={{
          width: 780,
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
          本地模型和 LLM 服务均为可选配置，未安装不影响基础 PDF 阅读功能。下方可一键下载所需模型。
        </Text>

        <Divider />

        {/* ════ 模型配置 + AI 服务: 左右布局 ════ */}
        <div style={{ display: "flex", gap: 24 }}>
          {/* ── 左侧: 本地模型 ── */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
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
                      <Info24Regular primaryFill="gray" />
                    )}
                    <Text>布局分析模型 <Text size={100} style={{ color: "gray" }}>(可选)</Text></Text>
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
                <Text size={100} style={{ color: "gray" }}>
                  版面分析，识别 PDF 中的标题、段落、表格等元素
                </Text>
                {layoutDownload.downloading && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <ProgressBar
                      value={layoutDownload.progress / 100}
                      color={layoutDownload.status === "error" ? "error" : "brand"}
                    />
                    <Text size={100} style={{ color: layoutDownload.status === "error" ? "red" : "gray" }}>
                      {layoutDownload.message}
                    </Text>
                  </div>
                )}
                {!layoutModelOk && !checking && !layoutDownload.downloading && layoutDownload.status === "error" && (
                  <Text size={100} style={{ color: "red" }}>
                    下载失败: {layoutDownload.message}
                  </Text>
                )}
              </div>

              <Divider />

              {/* OCR Section */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <Text>文字识别 (OCR)</Text>
                  <Text size={100} style={{ color: "gray" }}>
                    识别扫描件中的文字，支持多种引擎
                  </Text>
                </div>
                <Switch
                  checked={ocrEnabled}
                  onChange={(_, data) => handleOcrToggle(data.checked)}
                />
              </div>

              {ocrEnabled && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {/* OCR Model selector */}
                  <div>
                    <Text size={100} weight="semibold">选择 OCR 模型</Text>
                    <Dropdown
                      value={selectedOcrModel?.label || ocrModelId}
                      selectedOptions={[ocrModelId]}
                      onOptionSelect={(_, d) => {
                        const id = d.optionValue as string;
                        if (id) handleOcrModelSelect(id);
                      }}
                      style={{ width: "100%", marginTop: 4 }}
                      size="small"
                    >
                      {ggufModels.length > 0 ? (
                        <>
                          <Option key="__gguf_header" value="" text="" disabled>
                            <Text weight="semibold" size={100}>── GGUF 模型 (llama.cpp) ──</Text>
                          </Option>
                          {ggufModels.map((m) => (
                            <Option key={m.id} value={m.id} text={m.label}>
                              {m.label} {m.params && <Text size={100} style={{ color: "gray" }}>({m.params})</Text>}{" "}
                              {m.downloaded ? "✅" : ""}
                            </Option>
                          ))}
                          <Option key="__ppocr_header" value="" text="" disabled>
                            <Text weight="semibold" size={100}>── PPOCRv6 (ONNX) ──</Text>
                          </Option>
                          {ppocrModels.map((m) => (
                            <Option key={m.id} value={m.id} text={m.label}>
                              {m.label} {m.params && <Text size={100} style={{ color: "gray" }}>({m.params})</Text>}{" "}
                              {m.downloaded ? "✅" : ""}
                            </Option>
                          ))}
                        </>
                      ) : (
                        <Option key="glm-ocr" value="glm-ocr" text="GLM-OCR">
                          GLM-OCR (智谱, 0.9B)
                        </Option>
                      )}
                    </Dropdown>
                  </div>

                  {/* Model description */}
                  {selectedOcrModel?.description && (
                    <Text size={100} style={{ color: "gray" }}>
                      {selectedOcrModel.description}
                    </Text>
                  )}

                  {/* Status & download */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {ocrDownload.downloading ? (
                        <Spinner size="tiny" />
                      ) : ocrModelExists ? (
                        <CheckmarkCircle24Regular primaryFill="green" />
                      ) : ocrModelExists === false ? (
                        <ErrorCircle24Regular primaryFill="red" />
                      ) : (
                        <Spinner size="tiny" />
                      )}
                      <Text size={200}>
                        {ocrModelExists === null ? "检查中..." : ocrModelExists ? "已安装" : "未安装"}
                      </Text>
                    </div>
                    <Button
                      size="small"
                      icon={<ArrowDownload24Regular />}
                      onClick={downloadOcrModel}
                      disabled={ocrDownload.downloading}
                    >
                      {ocrDownload.downloading ? "下载中..." : ocrModelExists ? "重新下载" : "下载"}
                    </Button>
                  </div>

                  {/* Model path */}
                  <Text size={100} style={{ color: "gray" }}>
                    {ocrModelPath}
                  </Text>

                  {/* Download progress */}
                  {ocrDownload.status !== "idle" && ocrDownload.downloading && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <ProgressBar
                        value={ocrDownload.progress / 100}
                        color={ocrDownload.status === "error" ? "error" : "brand"}
                      />
                      <Text size={100} style={{ color: ocrDownload.status === "error" ? "red" : "gray" }}>
                        {ocrDownload.message}
                      </Text>
                    </div>
                  )}
                  {!ocrDownload.downloading && ocrDownload.status === "error" && (
                    <Text size={100} style={{ color: "red" }}>
                      下载失败: {ocrDownload.message}
                    </Text>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── 右侧: AI 服务 ── */}
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: 16,
              borderLeft: "1px solid rgba(0, 0, 0, 0.06)",
              paddingLeft: 24,
            }}
          >
            <Text weight="semibold" style={{ fontSize: 14 }}>AI 服务 (可选)</Text>
            <Text size={100} style={{ color: "gray" }}>
              配置大语言模型后可在应用中直接使用 AI 翻译、问答、摘要等功能，也可稍后在设置中配置。
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
