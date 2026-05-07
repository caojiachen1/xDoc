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
} from "@fluentui/react-components";
import {
  CheckmarkCircle24Regular,
  ErrorCircle24Regular,
  ArrowRight24Regular,
  ArrowDownload24Regular,
} from "@fluentui/react-icons";

const DEFAULT_LAYOUT_MODEL_PATH = "../model/PP-DocLayoutV3.onnx";
const DEFAULT_OCR_MODEL_PATH = "../model/GLM-OCR-GGUF";

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

  // Status
  const [gitOk, setGitOk] = useState<boolean | null>(null);
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

  const checkGit = async () => {
    try {
      const ok = await invoke<boolean>("check_git");
      setGitOk(ok);
    } catch {
      setGitOk(false);
    }
  };

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
    await checkGit();
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
        targetDir: "../model",
      });
      // Save the default path
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
        targetDir: "../model/GLM-OCR-GGUF",
      });
      // Save the default path
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

  const isReady = gitOk && layoutModelOk && (!ocrEnabled || ocrModelOk);

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        height: "100vh",
        backgroundColor: "rgb(32, 32, 32)",
      }}
    >
      <Card
        style={{
          width: 500,
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <Title2>环境检测</Title2>
        <Text style={{ color: "gray" }}>
          在开始使用之前，我们需要确保所有必要的环境和模型已就绪。如果模型未安装，可以在此一键下载。
        </Text>

        <Divider />

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Git */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {checking ? (
                <Spinner size="tiny" />
              ) : gitOk ? (
                <CheckmarkCircle24Regular primaryFill="green" />
              ) : (
                <ErrorCircle24Regular primaryFill="red" />
              )}
              <Text>Git 环境</Text>
            </div>
            {!gitOk && !checking && (
              <Text size={100} style={{ color: "red" }}>
                需要安装 Git
              </Text>
            )}
          </div>

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

          <Divider />

          {/* OCR Setup */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Text weight="semibold">开启 GLM-OCR</Text>
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
