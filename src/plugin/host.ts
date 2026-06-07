/**
 * PluginHost — React integration hooks (v2)
 *
 * Provides hooks for App.tsx and other components to interact with
 * the plugin system.
 */
import { useEffect, useCallback, useState } from "react";
import { pluginManager, registerBuiltinPlugin } from "./manager";
import { createPptGeneratorPlugin } from "./builtins/ppt-generator";
import { createPluginContext } from "./context";
import { eventBus } from "./event-bus";
import { uiRegistry, type PanelState, type SidebarState, type FloatingWindowState } from "./ui-extensions";
import type {
  PluginContextMenuItem,
  PluginToolbarButton,
  PluginManifest,
} from "./types";
import type { LlmSettings } from "../components/SettingsDialog";

// ── Register builtin plugins (code + manifest) ──

registerBuiltinPlugin("ppt-generator", createPptGeneratorPlugin);

const PPT_GENERATOR_MANIFEST: PluginManifest = {
  id: "ppt-generator",
  name: "PPT 讲解生成器",
  version: "1.0.0",
  description: "根据 PDF 全文内容和嵌入图片，调用 AI 自动生成学术讲解 PPT",
  author: "xDoc",
  permissions: [
    "pdf:read",
    "llm:invoke",
    "llm:stream",
    "file:write",
    "storage:read",
    "storage:write",
    "ui:dialog",
  ],
  entry: { main: "builtin:ppt-generator" },
  activation: ["onStartupFinished"],
};

pluginManager.registerBuiltinManifest(PPT_GENERATOR_MANIFEST);

// ── Hooks ───────────────────────────────────────────────────────────

/** Plugin initialization hook, called when the App component mounts */
export function usePluginInit() {
  useEffect(() => {
    pluginManager.discoverPlugins().then((manifests) => {
      console.log(`[PluginHost] Discovered ${manifests.length} external plugin(s)`);
      // Notify all plugins that the app is ready
      setTimeout(() => pluginManager.notifyAppReady(), 100);
    });

    // Register beforeunload handler
    const handleBeforeUnload = () => {
      pluginManager.notifyBeforeUnload();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);
}

/** Sync LLM settings to the plugin manager */
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

/** Notify plugins when the PDF path changes */
export function usePluginPdfPath(pdfPath: string | null) {
  useEffect(() => {
    pluginManager.setCurrentPdfPath(pdfPath);
  }, [pdfPath]);
}

/** Get context menu items registered by plugins */
export function usePluginContextMenuItems(): PluginContextMenuItem[] {
  return pluginManager.contextMenuItems;
}

/** Get toolbar buttons registered by plugins */
export function usePluginToolbarButtons(): PluginToolbarButton[] {
  return pluginManager.toolbarButtons;
}

/** Handle plugin context menu clicks */
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
    [],
  );
  return handlePluginMenuClick;
}

// ── UI Extension hooks ─────────────────────────────────────────────

/** Get registered plugin panels (reactive) */
export function usePluginPanels(): PanelState[] {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const unsub = uiRegistry.subscribe(() => forceUpdate((n) => n + 1));
    return unsub;
  }, []);
  return Array.from(uiRegistry.panels.values());
}

/** Get registered plugin sidebars (reactive) */
export function usePluginSidebars(): SidebarState[] {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const unsub = uiRegistry.subscribe(() => forceUpdate((n) => n + 1));
    return unsub;
  }, []);
  return Array.from(uiRegistry.sidebars.values());
}

/** Get registered plugin floating windows (reactive) */
export function usePluginFloatingWindows(): FloatingWindowState[] {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const unsub = uiRegistry.subscribe(() => forceUpdate((n) => n + 1));
    return unsub;
  }, []);
  return Array.from(uiRegistry.floatingWindows.values());
}

/** Listen for plugin toast messages via EventBus */
export function usePluginToast(
  handler: (detail: { type: string; message: string }) => void,
) {
  useEffect(() => {
    const unsub = eventBus.on("plugin:toast", (payload) => {
      handler(payload as { type: string; message: string });
    });
    return unsub;
  }, [handler]);
}

/** Notify plugins when settings change */
export function usePluginSettingsNotifier(key: string, value: unknown) {
  useEffect(() => {
    if (key) {
      pluginManager.notifySettingsChanged(key, value);
    }
  }, [key, value]);
}
