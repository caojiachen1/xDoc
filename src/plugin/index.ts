/**
 * Plugin system entry point
 *
 * Exported for use by App.tsx / HomePage.tsx
 */
export {
  type PluginInstance,
  type PluginManifest,
  type PluginHooks,
  type PluginContext,
  type PluginContextMenuItem,
  type PluginToolbarButton,
  type PluginCommand,
  type PdfImageInfo,
  type SlideData,
  type ClassifiedImage,
  type ProgressCallback,
  PLUGIN_EVENTS,
} from "./types";

export {
  pluginManager,
  registerBuiltinPlugin,
  getRegisteredBuiltins,
  isBuiltinPlugin,
} from "./manager";

export { createPluginContext } from "./context";

export {
  usePluginInit,
  usePluginLlmConfig,
  usePluginPdfPath,
  usePluginContextMenuItems,
  usePluginToolbarButtons,
  usePluginContextMenuHandler,
} from "./host";

export { default as PluginManagerDialog } from "./PluginManagerDialog";
