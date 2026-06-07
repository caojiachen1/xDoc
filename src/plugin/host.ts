/**
 * PluginHost — Plugin integration component
 *
 * Do not render directly; used as a logic layer inside App.tsx:
 * Initializes the plugin system and provides integration hooks
 */
import { useEffect, useCallback } from "react";
import { pluginManager, registerBuiltinPlugin } from "./manager";
import { createPptGeneratorPlugin } from "./builtins/ppt-generator";
import { createPluginContext } from "./context";
import type { PluginContextMenuItem, PluginToolbarButton, PluginManifest } from "./types";
import type { LlmSettings } from "../components/SettingsDialog";

// ── Register builtin plugins (code + manifest) ──

registerBuiltinPlugin("ppt-generator", createPptGeneratorPlugin);

const PPT_GENERATOR_MANIFEST: PluginManifest = {
  id: "ppt-generator",
  name: "PPT 讲解生成器",
  version: "1.0.0",
  description: "根据 PDF 全文内容和嵌入图片，调用 AI 自动生成学术讲解 PPT",
  author: "xDoc",
  permissions: ["pdf:read", "llm:invoke", "file:write"],
  entry: { main: "builtin:ppt-generator" },
  activation: ["onStartupFinished"],
};

pluginManager.registerBuiltinManifest(PPT_GENERATOR_MANIFEST);

/**
 * Plugin initialization hook, called when the App component mounts
 */
export function usePluginInit() {
  useEffect(() => {
    pluginManager.discoverPlugins().then((manifests) => {
      console.log(`[PluginHost] Discovered ${manifests.length} external plugin(s)`);
    });
  }, []);
}

/**
 * Sync LLM settings to the plugin manager when they change
 */
export function usePluginLlmConfig(llmSettings: LlmSettings | undefined) {
  useEffect(() => {
    if (!llmSettings) {
      pluginManager.setLlmConfig(null);
      return;
    }
    const apiKey = llmSettings.vendorApiKeys[llmSettings.vendor];
    pluginManager.setLlmConfig({
      vendor: llmSettings.vendor,
      baseUrl: llmSettings.baseUrl,
      apiKey: apiKey || "",
      model: llmSettings.model,
    });
  }, [llmSettings]);
}

/**
 * Notify plugins when the PDF path changes
 */
export function usePluginPdfPath(pdfPath: string | null) {
  useEffect(() => {
    pluginManager.setCurrentPdfPath(pdfPath);
  }, [pdfPath]);
}

/**
 * Hook: get context menu items registered by plugins
 */
export function usePluginContextMenuItems(): PluginContextMenuItem[] {
  return pluginManager.contextMenuItems;
}

/**
 * Hook: get toolbar buttons registered by plugins
 */
export function usePluginToolbarButtons(): PluginToolbarButton[] {
  return pluginManager.toolbarButtons;
}

/**
 * Handle plugin context menu clicks
 * Provided for HomePage.tsx's contextMenu
 */
export function usePluginContextMenuHandler() {
  const handlePluginMenuClick = useCallback(
    (item: PluginContextMenuItem, paper: { id: string; name: string; path: string }) => {
      const ctx = createPluginContext({
        pluginId: item.id,
        getCurrentPdfPath: () => paper.path,
        getLlmConfig: () => pluginManager.getLlmConfigSnapshot(),
      });
      item.action(paper, ctx);
    },
    []
  );

  return handlePluginMenuClick;
}
