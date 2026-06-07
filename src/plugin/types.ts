/**
 * Plugin system type definitions
 * Defines plugin manifests, extension points, plugin context, and other core types
 */

/** Plugin manifest (corresponds to plugin.json on the Rust side) */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
  description?: string;
  author?: string;
  permissions: string[];
  entry: {
    main?: string;
    renderer?: string;
  };
  activation: string[];
}

/** Plugin status */
export type PluginStatus = "disabled" | "enabled" | "error";

/** Plugin runtime instance */
export interface PluginInstance {
  manifest: PluginManifest;
  status: PluginStatus;
  error?: string;
  /** Whether this is a built-in plugin */
  isBuiltin?: boolean;

  /** Hooks exposed by the plugin */
  hooks: PluginHooks;
}

/** All hooks a plugin can register */
export interface PluginHooks {
  /** Add items to the paper list context menu */
  contextMenuItems?: () => PluginContextMenuItem[];
  /** Add buttons to the reader toolbar */
  toolbarButtons?: () => PluginToolbarButton[];
  /** Add commands to the "Tools" menu or command palette */
  commands?: () => PluginCommand[];
  /** Triggered when a paper is opened */
  onPdfOpened?: (ctx: PluginContext, paper: { id: string; name: string; path: string }) => Promise<void>;
  /** Triggered when the PDF full text is ready */
  onPdfTextReady?: (ctx: PluginContext, fullText: string) => Promise<void>;
  /** Plugin initialization */
  onInit?: (ctx: PluginContext) => Promise<void | PluginHooks>;
  /** Plugin destruction */
  onDestroy?: () => Promise<void>;
}

/** Context menu item */
export interface PluginContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  /** Optional: only show when condition is met */
  when?: (paper: { id: string; metadata?: Record<string, unknown> }) => boolean;
  action: (paper: { id: string; name: string; path: string }, ctx: PluginContext) => void;
}

/** Toolbar button */
export interface PluginToolbarButton {
  id: string;
  label: string;
  icon?: string;
  tooltip?: string;
  /** Placement: "reader" | "home-toolbar" */
  placement: "reader" | "home-toolbar" | "status-bar";
  action: (ctx: PluginContext) => void;
}

/** Command */
export interface PluginCommand {
  id: string;
  label: string;
  shortcut?: string;
  action: (ctx: PluginContext) => void;
}

/** PDF image info (returned from the Rust side) */
export interface PdfImageInfo {
  pageIndex: number;
  imageBase64: string;
  width: number;
  height: number;
}

/** PPT slide data (passed to the Rust side for PPTX generation) */
export interface SlideData {
  title: string;
  bullets: string[];
  /** Optional: base64-encoded image */
  imageBase64?: string;
  /** Slide type (for layout optimization) */
  slideType?: "title" | "overview" | "methods" | "characterization" | "electrochemical" | "other" | "conclusion";
}

/** Image classification result (from LLM) */
export interface ClassifiedImage {
  pageIndex: number;
  category: "flowchart" | "characterization" | "electrochemical" | "other";
  caption: string;
}

/** Progress callback */
export type ProgressCallback = (step: string, progress?: number) => void;

/**
 * Plugin context — all APIs a plugin can call
 * This is the key leak prevention measure: only expose necessary capabilities,
 * don't give plugins access to the entire window
 */
export interface PluginContext {
  /** Plugin's own ID */
  pluginId: string;

  /** ── PDF related ── */
  /** Get the currently open PDF file path */
  getCurrentPdfPath: () => string | null;
  /** Get the full text of the current PDF (calls Rust backend) */
  getPdfFullText: () => Promise<string>;
  /** Get the current PDF metadata */
  getPdfMetadata: () => Promise<Record<string, unknown>>;
  /** Extract embedded images from the PDF */
  extractPdfImages: (pageIndices?: number[]) => Promise<PdfImageInfo[]>;

  /** ── AI / LLM related ── */
  /** Call the user-configured LLM (uses the existing SettingsDialog config) */
  invokeLlm: (params: {
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    maxTokens?: number;
  }) => Promise<string>;

  /** ── File system ── */
  /** Show a save dialog */
  showSaveDialog: (options: { defaultName: string; filters: Record<string, string[]> }) => Promise<string | null>;
  /** Show an open dialog (for selecting template files, etc.) */
  showOpenDialog: (options: { filters: Record<string, string[]>; multiple?: boolean }) => Promise<string | null>;

  /** ── PPTX generation ── */
  /** Call the Rust backend to generate a PPTX file */
  generatePptx: (params: {
    outputPath: string;
    title: string;
    slides: SlideData[];
    templatePath?: string;
  }) => Promise<void>;
  /** Convert a PPTX template to HTML (for preview or as an overlay background) */
  convertTemplateToHtml: (templatePath: string) => Promise<string>;

  /** ── Events ── */
  /** Send an event to the Rust backend */
  emitBackend: (event: string, payload: unknown) => Promise<void>;
  /** Listen for frontend events */
  onEvent: (event: string, handler: (payload: unknown) => void) => () => void;
  /** Show a notification/toast to the user */
  showToast: (type: "info" | "success" | "error" | "warning", message: string) => void;
}

// ── Internal event types ────────────────────────────────────

/** Event names that plugins register on the event bus */
export const PLUGIN_EVENTS = {
  PDF_OPENED: "plugin:pdf-opened",
  PDF_TEXT_READY: "plugin:pdf-text-ready",
  PLUGIN_ENABLED: "plugin:enabled",
  PLUGIN_DISABLED: "plugin:disabled",
} as const;
