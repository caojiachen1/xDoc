import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Button,
  Card,
  Text,
  Spinner,
  Switch,
  Input,
  Title2,
  Divider,
} from "@fluentui/react-components";
import { CheckmarkCircle24Regular, ErrorCircle24Regular, FolderOpen24Regular, ArrowRight24Regular } from "@fluentui/react-icons";
import { STORAGE_KEYS as APP_KEYS } from "../App";
import { STORAGE_KEYS as OCR_KEYS } from "./SettingsDialog";

interface Props {
  onAllChecksPassed: () => void;
}

export default function EnvironmentCheck({ onAllChecksPassed }: Props) {
  const [checking, setChecking] = useState(true);

  // Status
  const [gitOk, setGitOk] = useState<boolean | null>(null);
  const [layoutModelOk, setLayoutModelOk] = useState<boolean | null>(null);
  const [ocrModelOk, setOcrModelOk] = useState<boolean | null>(null);

  // Values
  const [layoutModelPath, setLayoutModelPath] = useState(localStorage.getItem(APP_KEYS?.modelPath || "xdoc.settings.modelPath") || "");
  const [ocrEnabled, setOcrEnabled] = useState(localStorage.getItem(OCR_KEYS?.ocrEnabled || "xdoc.settings.ocr.enabled") === "true");
  const [ocrModelPath, setOcrModelPath] = useState(localStorage.getItem(OCR_KEYS?.ocrModelPath || "xdoc.settings.ocr.modelPath") || "");

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
      // In a real app we might check if 'configuration.json' exists in this directory, 
      // but simplistic check for the folder for now.
      setOcrModelOk(exists);
    } catch {
      setOcrModelOk(false);
    }
  };

  const runChecks = async () => {
    setChecking(true);
    await checkGit();
    await checkLayoutModel(layoutModelPath);
    await checkOcrModel(ocrModelPath);
    setChecking(false);
  };

  useEffect(() => {
    runChecks();
  }, [ocrEnabled]);

  const selectLayoutModel = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "ONNX", extensions: ["onnx"] }],
        title: "选择 Layout 模型 (PP-DocLayoutV3.onnx)",
      });
      if (typeof selected === "string") {
        setLayoutModelPath(selected);
        localStorage.setItem("xdoc.settings.modelPath", selected);
        runChecks();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const selectOcrModelFolder = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "选择 OCR 模型文件夹 (GLM-OCR-GGUF)",
      });
      if (typeof selected === "string") {
        setOcrModelPath(selected);
        localStorage.setItem("xdoc.settings.ocr.modelPath", selected);
        runChecks();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleOcrToggle = (checked: boolean) => {
    setOcrEnabled(checked);
    localStorage.setItem("xdoc.settings.ocr.enabled", checked.toString());
  };

  const isReady = gitOk && layoutModelOk && (!ocrEnabled || ocrModelOk);

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh", backgroundColor: "rgb(32, 32, 32)" }}>
      <Card style={{ width: 500, padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
        <Title2>环境检测</Title2>
        <Text style={{ color: "gray" }}>在开始使用之前，我们需要确保所有必要的环境和模型已就绪。</Text>

        <Divider />

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Git */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {checking ? <Spinner size="tiny" /> : gitOk ? <CheckmarkCircle24Regular primaryFill="green" /> : <ErrorCircle24Regular primaryFill="red" />}
              <Text>Git 环境</Text>
            </div>
            {!gitOk && !checking && <Text size={100} style={{ color: "red" }}>需要安装 Git</Text>}
          </div>

          {/* Layout Model */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {checking ? <Spinner size="tiny" /> : layoutModelOk ? <CheckmarkCircle24Regular primaryFill="green" /> : <ErrorCircle24Regular primaryFill="red" />}
                <Text>布局分析模型 (PP-DocLayoutV3.onnx)</Text>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Input value={layoutModelPath} readOnly style={{ flex: 1 }} placeholder="模型路径" />
              <Button icon={<FolderOpen24Regular />} onClick={selectLayoutModel}>选择文件</Button>
            </div>
            {!layoutModelOk && !checking && <Text size={100} style={{ color: "red" }}>请选择有效的模型文件</Text>}
          </div>

          <Divider />

          {/* OCR Setup */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Text weight="semibold">开启 GLM-OCR</Text>
            <Switch checked={ocrEnabled} onChange={(_, data) => handleOcrToggle(data.checked)} />
          </div>

          {ocrEnabled && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {checking ? <Spinner size="tiny" /> : ocrModelOk ? <CheckmarkCircle24Regular primaryFill="green" /> : <ErrorCircle24Regular primaryFill="red" />}
                  <Text>OCR 模型目录 (GLM-OCR-GGUF)</Text>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Input value={ocrModelPath} readOnly style={{ flex: 1 }} placeholder="目录路径" />
                <Button icon={<FolderOpen24Regular />} onClick={selectOcrModelFolder}>选择目录</Button>
              </div>
              <Text size={100} style={{ color: "gray" }}>
                您也可以在进入应用后在设置中下载该模型。
              </Text>
              {!ocrModelOk && !checking && <Text size={100} style={{ color: "red" }}>请选择有效的模型目录</Text>}
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
