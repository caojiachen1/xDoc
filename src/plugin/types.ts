/**
 * Plugin system type definitions (v2)
 *
 * Covers: permissions, 20+ fine-grained APIs, lifecycle hooks,
 * data-flow interceptors, UI extensions, Worker protocol.
 */

// ── Permissions ───────────────────────────────────────────────────

export type PluginPermission =
  | "pdf:read"
  | "llm:invoke"
  | "llm:stream"
  | "file:write"
  | "file:read"
  | "storage:read"
  | "storage:write"
  | "ui:panel"
  | "ui:sidebar"
  | "ui:floating"
  | "ui:dialog"
  | "paper:read"
  | "paper:write"
  | "system:info"
  | "system:external";

// ── Manifest ─────────────────────────────────────────────────────

/** Plugin manifest (corresponds to plugin.json on the Rust side) */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
  description?: string;
  author?: string;
  permissions: PluginPermission[];
  entry: {
    main?: string;
    renderer?: string;
  };
  activation: string[];
  /** "main-thread" keeps builtin behaviour; "worker" (default for external) isolates in Worker */
  sandboxMode?: "main-thread" | "worker";
}

// ── Plugin status ─────────────────────────────────────────────────

export type PluginStatus = "disabled" | "enabled" | "error";

// ── Plugin instance ───────────────────────────────────────────────

export interface PluginInstance {
  manifest: PluginManifest;
  status: PluginStatus;
  error?: string;
  isBuiltin?: boolean;
  hooks: PluginHooks;
  /** Active Worker handle (null for main-thread plugins) */
  workerHost?: unknown;
}

// ── PDF auxiliary types ──────────────────────────────────────────

export interface PdfImageInfo {
  pageIndex: number;
  imageBase64: string;
  width: number;
  height: number;
}

export interface PdfOutlineItem {
  title: string;
  pageIndex: number;
  level: number;
  children?: PdfOutlineItem[];
}

export interface PdfAnnotation {
  pageIndex: number;
  type: string;
  contents?: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface PdfSearchResult {
  pageIndex: number;
  text: string;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface PdfInfo {
  pageCount: number;
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
  fileSize?: number;
}

// ── LLM types ────────────────────────────────────────────────────

export interface LlmInvokeParams {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmCallData {
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
}

export interface LlmConfigSnapshot {
  vendor: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export type LlmStreamCallback = (chunk: string, done: boolean) => void;

// ── Paper DB types ────────────────────────────────────────────────

export interface PaperQueryFilter {
  search?: string;
  journal?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export interface PaperRecordSummary {
  id: string;
  name: string;
  journal?: string;
  date?: string;
  metadataExtracted: boolean;
}

// ── Export data (for interceptors) ────────────────────────────────

export interface ExportData {
  type: "pptx" | "pdf" | "markdown" | string;
  outputPath: string;
  data: unknown;
}

// ── Dialog option types ──────────────────────────────────────────

export interface SaveDialogOptions {
  defaultName: string;
  filters: Record<string, string[]>;
}

export interface OpenDialogOptions {
  filters: Record<string, string[]>;
  multiple?: boolean;
}

export interface InputDialogOptions {
  title: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ProgressDialogOptions {
  title: string;
  message: string;
  /** 0-100 or -1 for indeterminate */
  progress?: number;
  cancellable?: boolean;
}

export type ToastType = "info" | "success" | "error" | "warning";

// ── PPTX types ───────────────────────────────────────────────────

export interface SlideData {
  title: string;
  bullets: string[];
  imageBase64?: string;
  slideType?:
    | "title"
    | "overview"
    | "methods"
    | "characterization"
    | "electrochemical"
    | "other"
    | "conclusion";
}

export interface ClassifiedImage {
  pageIndex: number;
  category: "flowchart" | "characterization" | "electrochemical" | "other";
  caption: string;
}

export interface GeneratePptxParams {
  outputPath: string;
  title: string;
  slides: SlideData[];
  templatePath?: string;
}

export type ProgressCallback = (step: string, progress?: number) => void;

// ── UI Extension registration types ──────────────────────────────

export interface PanelRegistration {
  id: string;
  title: string;
  icon?: string;
  position?: "bottom" | "right";
  /** HTML content to render in a sandboxed iframe (for worker plugins) */
  html?: string;
  onShow?: () => void;
  onHide?: () => void;
  onResize?: (size: { width: number; height: number }) => void;
  render?: (container: HTMLElement) => void | (() => void);
}

export interface SidebarRegistration {
  id: string;
  title: string;
  icon?: string;
  side?: "left" | "right";
  width?: number;
  /** HTML content to render in a sandboxed iframe (for worker plugins) */
  html?: string;
  render?: (container: HTMLElement) => void | (() => void);
}

export interface FloatingWindowRegistration {
  id: string;
  title: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  draggable?: boolean;
  resizable?: boolean;
  /** HTML content to render in a sandboxed iframe (for worker plugins) */
  html?: string;
  render?: (container: HTMLElement) => void | (() => void);
}

// ── Worker UI registration (serializable, no render functions) ────

export interface WorkerUIRegistration {
  id: string;
  title: string;
  icon?: string;
  /** HTML content to render in a sandboxed iframe (worker-only) */
  html?: string;
  position?: "bottom" | "right";
  side?: "left" | "right";
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  draggable?: boolean;
  resizable?: boolean;
}

// ── Context menu / toolbar / command types ────────────────────────

export interface PluginContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  when?: (paper: { id: string; metadata?: Record<string, unknown> }) => boolean;
  action: (paper: { id: string; name: string; path: string }, ctx: PluginContext) => void;
}

export interface PluginToolbarButton {
  id: string;
  label: string;
  icon?: string;
  tooltip?: string;
  placement: "reader" | "home-toolbar" | "status-bar";
  action: (ctx: PluginContext) => void;
}

export interface PluginCommand {
  id: string;
  label: string;
  shortcut?: string;
  action: (ctx: PluginContext) => void;
}

// ── Plugin hooks (all optional) ──────────────────────────────────

/** Lifecycle hooks */
export interface PluginLifecycleHooks {
  /** Plugin activation (preferred over onInit) */
  onActivate?: (ctx: PluginContext) => Promise<void | PluginHooks>;
  /** Plugin deactivation (preferred over onDestroy) */
  onDeactivate?: () => Promise<void>;
  /** @deprecated Use onActivate */
  onInit?: (ctx: PluginContext) => Promise<void | PluginHooks>;
  /** @deprecated Use onDeactivate */
  onDestroy?: () => Promise<void>;
  /** After all plugins have been loaded */
  onAppReady?: (ctx: PluginContext) => Promise<void>;
  /** A paper PDF was opened */
  onPdfOpened?: (
    ctx: PluginContext,
    paper: { id: string; name: string; path: string },
  ) => Promise<void>;
  /** The current PDF was closed */
  onPdfClosed?: (ctx: PluginContext) => Promise<void>;
  /** PDF full text extraction complete */
  onPdfTextReady?: (ctx: PluginContext, fullText: string) => Promise<void>;
  /** App settings changed */
  onSettingsChanged?: (
    ctx: PluginContext,
    key: string,
    value: unknown,
  ) => Promise<void>;
  /** App is about to close */
  onBeforeUnload?: (ctx: PluginContext) => Promise<void>;
}

/** Data-flow interceptor hooks (middleware-style) */
export interface PluginInterceptorHooks {
  beforePdfTextExtract?: (
    ctx: PluginContext,
    data: { filePath: string },
  ) => Promise<{ filePath: string } | null>;
  afterPdfTextExtract?: (
    ctx: PluginContext,
    data: { filePath: string; text: string },
  ) => Promise<{ text: string }>;
  beforeOcr?: (
    ctx: PluginContext,
    data: { filePath: string; pageIndex: number },
  ) => Promise<{ filePath: string; pageIndex: number } | null>;
  afterOcr?: (
    ctx: PluginContext,
    data: { filePath: string; pageIndex: number; text: string },
  ) => Promise<{ text: string }>;
  beforeLlmCall?: (
    ctx: PluginContext,
    data: LlmCallData,
  ) => Promise<LlmCallData | null>;
  afterLlmCall?: (
    ctx: PluginContext,
    data: { request: LlmCallData; response: string },
  ) => Promise<{ response: string }>;
  beforeExport?: (
    ctx: PluginContext,
    data: ExportData,
  ) => Promise<ExportData | null>;
  afterExport?: (
    ctx: PluginContext,
    data: { outputPath: string; success: boolean },
  ) => Promise<void>;
}

/** UI extension hooks */
export interface PluginUIHooks {
  panels?: () => PanelRegistration[];
  sidebars?: () => SidebarRegistration[];
  floatingWindows?: () => FloatingWindowRegistration[];
}

/** Combined hook surface */
export interface PluginHooks
  extends PluginLifecycleHooks,
    PluginInterceptorHooks,
    PluginUIHooks {
  contextMenuItems?: () => PluginContextMenuItem[];
  toolbarButtons?: () => PluginToolbarButton[];
  commands?: () => PluginCommand[];
}

// ── Plugin Context — the API surface available to plugins ──────────

/**
 * PluginContext — every API a plugin can call.
 * 20+ fine-grained APIs grouped by domain.
 */
export interface PluginContext {
  /** Plugin's own ID */
  pluginId: string;

  // ── PDF (9 APIs) ────────────────────────────────────────────
  getCurrentPdfPath: () => string | null;
  getPdfFullText: () => Promise<string>;
  getPdfPages: () => Promise<{ count: number }>;
  getPageText: (pageIndex: number) => Promise<string>;
  getPdfOutline: () => Promise<PdfOutlineItem[]>;
  getPdfAnnotations: (pageIndex?: number) => Promise<PdfAnnotation[]>;
  searchPdf: (
    query: string,
    options?: { caseSensitive?: boolean },
  ) => Promise<PdfSearchResult[]>;
  getPdfMetadata: () => Promise<Record<string, unknown>>;
  getPdfInfo: () => Promise<PdfInfo>;
  extractPdfImages: (pageIndices?: number[]) => Promise<PdfImageInfo[]>;

  // ── LLM (3 APIs) ────────────────────────────────────────────
  invokeLlm: (params: LlmInvokeParams) => Promise<string>;
  invokeLlmStream: (
    params: LlmInvokeParams,
    onChunk: LlmStreamCallback,
  ) => Promise<string>;
  getLlmConfig: () => LlmConfigSnapshot | null;

  // ── Storage (4 APIs) ────────────────────────────────────────
  storage: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
    list: () => Promise<string[]>;
  };

  // ── File I/O (2 APIs, sandboxed to plugin data dir) ──────────
  writeFile: (
    filename: string,
    content: string | Uint8Array,
  ) => Promise<string>;
  readFile: (filename: string) => Promise<string>;

  // ── UI (5 APIs) ─────────────────────────────────────────────
  registerPanel: (config: PanelRegistration) => void;
  registerSidebar: (config: SidebarRegistration) => void;
  registerFloatingWindow: (config: FloatingWindowRegistration) => void;
  showInputDialog: (options: InputDialogOptions) => Promise<string | null>;
  showProgressDialog: (options: ProgressDialogOptions) => Promise<void>;

  // ── Dialogs (2 APIs) ────────────────────────────────────────
  showSaveDialog: (options: SaveDialogOptions) => Promise<string | null>;
  showOpenDialog: (options: OpenDialogOptions) => Promise<string | null>;

  // ── System (3 APIs) ─────────────────────────────────────────
  getPlatform: () => Promise<{ os: string; arch: string }>;
  getAppVersion: () => Promise<string>;
  openExternal: (url: string) => Promise<void>;

  // ── Paper DB (3 APIs) ────────────────────────────────────────
  queryPapers: (
    filter?: PaperQueryFilter,
  ) => Promise<PaperRecordSummary[]>;
  getPaperMetadata: (
    paperId: string,
  ) => Promise<Record<string, unknown> | null>;
  updatePaperMetadata: (
    paperId: string,
    updates: Record<string, unknown>,
  ) => Promise<void>;

  // ── PPTX (2 APIs) ────────────────────────────────────────────
  generatePptx: (params: GeneratePptxParams) => Promise<void>;
  convertTemplateToHtml: (templatePath: string) => Promise<string>;

  // ── Events (4 APIs) ─────────────────────────────────────────
  on: (event: string, handler: (payload: unknown) => void) => () => void;
  off: (event: string, handler: (payload: unknown) => void) => void;
  emit: (event: string, payload?: unknown) => void;
  emitBackend: (event: string, payload: unknown) => Promise<void>;

  // ── Toast (1 API) ────────────────────────────────────────────
  showToast: (type: ToastType, message: string, duration?: number) => void;
}

// ── Event Bus types ───────────────────────────────────────────────

export type EventHandler = (payload: unknown) => void;

export interface EventBus {
  on(event: string, handler: EventHandler, pluginId?: string): () => void;
  off(event: string, handler: EventHandler): void;
  emit(event: string, payload?: unknown): void;
  emitScoped(scope: string, event: string, payload?: unknown): void;
  cleanupPlugin(pluginId: string): void;
}

// ── Worker communication protocol ─────────────────────────────────

export type WorkerMessageType =
  | { type: "init"; code: string; pluginId: string; currentPdfPath?: string | null; llmConfig?: LlmConfigSnapshot | null }
  | { type: "init_result"; success: boolean; error?: string }
  | { type: "api_call"; callId: string; method: string; args: unknown[] }
  | {
      type: "api_result";
      callId: string;
      result?: unknown;
      error?: string;
    }
  | { type: "hook_call"; callId: string; hookName: string; data: unknown }
  | {
      type: "hook_result";
      callId: string;
      data?: unknown;
      error?: string;
      passThrough?: boolean;
    }
  | { type: "event_subscribe"; event: string }
  | { type: "event_unsubscribe"; event: string }
  | { type: "event_emit"; event: string; payload: unknown }
  | { type: "event_receive"; event: string; payload: unknown }
  // ── Streaming LLM protocol ──────────────────────────────────────
  | { type: "stream_call"; callId: string; params: LlmInvokeParams }
  | { type: "stream_chunk"; callId: string; chunk: string; done: boolean }
  // ── UI registration protocol ────────────────────────────────────
  | { type: "ui_register"; uiType: "panel" | "sidebar" | "floatingWindow"; config: WorkerUIRegistration }
  // ── State sync (host → worker) ─────────────────────────────────
  | { type: "state_update"; currentPdfPath?: string | null; llmConfig?: LlmConfigSnapshot | null };

// ── Internal event names ─────────────────────────────────────────

export const PLUGIN_EVENTS = {
  PDF_OPENED: "plugin:pdf-opened",
  PDF_CLOSED: "plugin:pdf-closed",
  PDF_TEXT_READY: "plugin:pdf-text-ready",
  PLUGIN_ENABLED: "plugin:enabled",
  PLUGIN_DISABLED: "plugin:disabled",
  APP_READY: "plugin:app-ready",
  SETTINGS_CHANGED: "plugin:settings-changed",
  BEFORE_UNLOAD: "plugin:before-unload",
} as const;
