/**
 * useSettings — Manages all application settings state and persistence to SQLite.
 *
 * Covers: model path, score threshold, zoom mode, OCR config, font settings,
 * LLM settings, and their two-way sync with the Rust settings database.
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { VENDOR_PRESETS, FONT_PRESETS, type LlmSettings } from "../components/SettingsDialog";
import type { ZoomMode } from "../types";

export function useSettings(environmentReady: boolean) {
  // ── Model ────────────────────────────────────────────────────────
  const [modelPath, setModelPath] = useState("");
  const [modelLoaded, setModelLoaded] = useState(false);
  const [scoreThreshold, setScoreThreshold] = useState(0.5);
  const [pdfTextExtractionEnabled, setPdfTextExtractionEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  // ── View ─────────────────────────────────────────────────────────
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit_page");

  // ── OCR settings ─────────────────────────────────────────────────
  const [ocrEnabled, setOcrEnabled] = useState(true);
  const [ocrModelPath, setOcrModelPath] = useState("");

  // ── Font settings ────────────────────────────────────────────────
  const [textFontSize, setTextFontSize] = useState(15);
  const [aiFontSize, setAiFontSize] = useState(14);
  const [textFontFamily, setTextFontFamily] = useState(FONT_PRESETS[0].value);
  const [aiFontFamily, setAiFontFamily] = useState(FONT_PRESETS[0].value);

  // ── LLM settings ─────────────────────────────────────────────────
  const [llmSettings, setLlmSettings] = useState<LlmSettings>({
    vendor: "deepseek",
    vendorApiKeys: {},
    baseUrl: VENDOR_PRESETS.deepseek.baseUrl,
    model: VENDOR_PRESETS.deepseek.models[0],
  });

  // ── Model operations ─────────────────────────────────────────────
  const selectModel = useCallback(async () => {
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
  }, []);

  const applyScoreThreshold = useCallback(async (nextThreshold: number) => {
    setScoreThreshold(nextThreshold);
    // Caller should invoke runModel with the new threshold if needed
  }, []);

  // ── Load settings from DB on environment ready ───────────────────
  useEffect(() => {
    if (!environmentReady) return;
    (async () => {
      type DbEntry = { key: string; value: string };
      let rows: DbEntry[] = [];
      try {
        rows = await invoke<DbEntry[]>("db_get_all_settings");
      } catch (e) {
        console.warn("[settings] db_get_all_settings failed, falling back to defaults:", e);
      }
      const map: Record<string, string> = {};
      for (const r of rows) map[r.key] = r.value;

      const readNum = (key: string): number | null => {
        const v = map[key];
        if (v === undefined) return null;
        const n = Number(v);
        return Number.isNaN(n) ? null : n;
      };
      const readBool = (key: string, def: boolean): boolean => {
        const v = map[key];
        return v === undefined ? def : v === "true";
      };
      const readStr = (key: string, def: string): string => {
        const v = map[key];
        return v === undefined || v === null ? def : v;
      };

      const savedThreshold = readNum("ui.scoreThreshold");
      if (savedThreshold !== null) {
        setScoreThreshold(Math.min(1, Math.max(0, savedThreshold)));
      }

      setPdfTextExtractionEnabled(readBool("ui.pdfTextExtractionEnabled", true));

      const savedZoom = readStr("ui.zoomMode", "") as ZoomMode;
      if (savedZoom && ["fit_page", "fit_width", "fit_height", "actual", "custom"].includes(savedZoom)) {
        setZoomMode(savedZoom);
      }

      const savedModelPath = readStr("ui.modelPath", "") || "model/PP-DocLayoutV3.onnx";
      setModelPath(savedModelPath);
      setLoading(true);
      invoke("load_model", { modelPath: savedModelPath })
        .then(() => { setModelLoaded(true); })
        .catch((e) => {
          setModelLoaded(false);
          setErrorMessage(`自动加载模型失败: ${String(e)}`);
        })
        .finally(() => { setLoading(false); });

      // OCR settings
      setOcrEnabled(readBool("ocr.enabled", true));
      setOcrModelPath(readStr("ocr.modelPath", "") || "model/GLM-OCR-GGUF");

      // Font size settings
      const savedTextFontSize = readNum("ui.textFontSize");
      if (savedTextFontSize !== null) setTextFontSize(Math.max(10, Math.min(40, savedTextFontSize)));
      const savedAiFontSize = readNum("ui.aiFontSize");
      if (savedAiFontSize !== null) setAiFontSize(Math.max(10, Math.min(40, savedAiFontSize)));

      // Font family settings
      const savedTextFontFamily = readStr("ui.textFontFamily", "");
      if (savedTextFontFamily) setTextFontFamily(savedTextFontFamily);
      const savedAiFontFamily = readStr("ui.aiFontFamily", "");
      if (savedAiFontFamily) setAiFontFamily(savedAiFontFamily);

      // LLM settings
      const savedLlmVendor = readStr("llm.vendor", "deepseek");
      let savedVendorApiKeys: Record<string, string> = {};
      try {
        const raw = map["llm.vendorApiKeys"];
        if (raw) savedVendorApiKeys = JSON.parse(raw);
      } catch { /* ignore parse errors */ }
      const savedLlmBaseUrl = readStr("llm.baseUrl", "")
        || VENDOR_PRESETS[savedLlmVendor]?.baseUrl
        || VENDOR_PRESETS.deepseek.baseUrl;
      const savedLlmModel = readStr("llm.model", "")
        || VENDOR_PRESETS[savedLlmVendor]?.models?.[0]
        || VENDOR_PRESETS.deepseek.models[0];
      setLlmSettings({
        vendor: savedLlmVendor,
        vendorApiKeys: savedVendorApiKeys,
        baseUrl: savedLlmBaseUrl,
        model: savedLlmModel,
      });
    })();
  }, [environmentReady]);

  // ── Persist individual settings to DB ────────────────────────────
  useEffect(() => {
    if (!environmentReady) return;
    void invoke("db_set_setting", { key: "ui.scoreThreshold", value: String(scoreThreshold) })
      .catch((e) => console.warn("[settings] persist ui.scoreThreshold failed:", e));
  }, [scoreThreshold, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    void invoke("db_set_setting", { key: "ui.pdfTextExtractionEnabled", value: String(pdfTextExtractionEnabled) })
      .catch((e) => console.warn("[settings] persist ui.pdfTextExtractionEnabled failed:", e));
  }, [pdfTextExtractionEnabled, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    void invoke("db_set_setting", { key: "ui.zoomMode", value: zoomMode })
      .catch((e) => console.warn("[settings] persist ui.zoomMode failed:", e));
  }, [zoomMode, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    const op = modelPath
      ? invoke("db_set_setting", { key: "ui.modelPath", value: modelPath })
      : invoke("db_delete_setting", { key: "ui.modelPath" });
    void op.catch((e) => console.warn("[settings] persist ui.modelPath failed:", e));
  }, [modelPath, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    void invoke("db_set_setting", { key: "ocr.enabled", value: String(ocrEnabled) })
      .catch((e) => console.warn("[settings] persist ocr.enabled failed:", e));
  }, [ocrEnabled, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    void invoke("db_set_setting", { key: "ocr.modelPath", value: ocrModelPath })
      .catch((e) => console.warn("[settings] persist ocr.modelPath failed:", e));
  }, [ocrModelPath, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    void invoke("db_set_ai_config", {
      config: {
        vendor: llmSettings.vendor,
        vendor_api_keys: llmSettings.vendorApiKeys,
        base_url: llmSettings.baseUrl,
        model: llmSettings.model,
      },
    }).catch((e) => console.warn("[settings] persist llm config failed:", e));
  }, [llmSettings, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    void invoke("db_set_setting", { key: "ui.textFontSize", value: String(textFontSize) })
      .catch((e) => console.warn("[settings] persist ui.textFontSize failed:", e));
  }, [textFontSize, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    void invoke("db_set_setting", { key: "ui.aiFontSize", value: String(aiFontSize) })
      .catch((e) => console.warn("[settings] persist ui.aiFontSize failed:", e));
  }, [aiFontSize, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    void invoke("db_set_setting", { key: "ui.textFontFamily", value: textFontFamily })
      .catch((e) => console.warn("[settings] persist ui.textFontFamily failed:", e));
  }, [textFontFamily, environmentReady]);

  useEffect(() => {
    if (!environmentReady) return;
    void invoke("db_set_setting", { key: "ui.aiFontFamily", value: aiFontFamily })
      .catch((e) => console.warn("[settings] persist ui.aiFontFamily failed:", e));
  }, [aiFontFamily, environmentReady]);

  return {
    // Model
    modelPath, setModelPath,
    modelLoaded, setModelLoaded,
    scoreThreshold, setScoreThreshold,
    pdfTextExtractionEnabled, setPdfTextExtractionEnabled,
    loading, setLoading,
    errorMessage, setErrorMessage,
    // View
    zoomMode, setZoomMode,
    // OCR
    ocrEnabled, setOcrEnabled,
    ocrModelPath, setOcrModelPath,
    // Font
    textFontSize, setTextFontSize,
    aiFontSize, setAiFontSize,
    textFontFamily, setTextFontFamily,
    aiFontFamily, setAiFontFamily,
    // LLM
    llmSettings, setLlmSettings,
    // Operations
    selectModel,
    applyScoreThreshold,
  };
}
