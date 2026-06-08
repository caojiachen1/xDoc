/**
 * Plugin system entry point (v2)
 *
 * Re-exports all public types, singletons, and React hooks.
 */

// ── Types ──────────────────────────────────────────────────────────

export {
  type PluginInstance,
  type PluginManifest,
  type PluginHooks,
  type PluginContext,
  type PluginPermission,
  type PluginStatus,
  type PluginContextMenuItem,
  type PluginToolbarButton,
  type PluginCommand,
  type PdfImageInfo,
  type PdfOutlineItem,
  type PdfAnnotation,
  type PdfSearchResult,
  type PdfInfo,
  type SlideData,
  type ClassifiedImage,
  type ProgressCallback,
  type LlmInvokeParams,
  type LlmCallData,
  type LlmConfigSnapshot,
  type LlmStreamCallback,
  type PaperQueryFilter,
  type PaperRecordSummary,
  type PanelRegistration,
  type SidebarRegistration,
  type FloatingWindowRegistration,
  type InputDialogOptions,
  type ProgressDialogOptions,
  type SaveDialogOptions,
  type OpenDialogOptions,
  type GeneratePptxParams,
  type ToastType,
  type ExportData,
  type EventBus,
  type EventHandler,
  type WorkerMessageType,
  type WorkerUIRegistration,
  type PluginLifecycleHooks,
  type PluginInterceptorHooks,
  type PluginUIHooks,
  PLUGIN_EVENTS,
} from "./types";

// ── Singletons ─────────────────────────────────────────────────────

export {
  pluginManager,
  registerBuiltinPlugin,
  getRegisteredBuiltins,
  isBuiltinPlugin,
} from "./manager";

export { eventBus } from "./event-bus";
export { interceptorPipeline } from "./interceptors";
export { uiRegistry } from "./ui-extensions";
export type { PanelState, SidebarState, FloatingWindowState } from "./ui-extensions";

export { createPluginContext } from "./context";

export { loadPluginInWorker, activeWorkers, syncWorkerState, syncAllWorkers } from "./sandbox/worker-host";

// ── React hooks ────────────────────────────────────────────────────

export {
  usePluginInit,
  usePluginLlmConfig,
  usePluginPdfPath,
  usePluginContextMenuItems,
  usePluginToolbarButtons,
  usePluginContextMenuHandler,
  usePluginPanels,
  usePluginSidebars,
  usePluginFloatingWindows,
  usePluginToast,
  usePluginSettingsNotifier,
} from "./host";

export { default as PluginManagerDialog } from "./PluginManagerDialog";
