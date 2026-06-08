/**
 * plugin-worker.ts — WebWorker entry for external plugin execution.
 *
 * Isolates plugin code from the main thread. All API calls go through
 * postMessage to the main thread (worker-host.ts).
 */

/// <reference lib="webworker" />

declare const self: DedicatedWorkerGlobalScope;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingStream {
  onChunk: (chunk: string, done: boolean) => void;
  resolve: (fullContent: string) => void;
  reject: (error: Error) => void;
  fullContent: string;
  timer: ReturnType<typeof setTimeout>;
}

const pendingCalls = new Map<string, PendingCall>();
const pendingStreams = new Map<string, PendingStream>();
let callIdCounter = 0;
const CALL_TIMEOUT = 30_000;
const STREAM_TIMEOUT = 120_000; // 2 min for long-running streams

// Plugin hooks registered by the loaded code
let pluginHooks: Record<string, Function> = {};
let myPluginId = "";

// Cached state synced from host
let cachedCurrentPdfPath: string | null = null;
let cachedLlmConfig: Record<string, unknown> | null = null;

// Internal event listeners (worker-side)
const eventListeners = new Map<string, Set<Function>>();

// ── Receive messages from main thread ───────────────────────────

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case "init": {
      myPluginId = msg.pluginId;
      // Cache initial state from host
      if (msg.currentPdfPath !== undefined) cachedCurrentPdfPath = msg.currentPdfPath;
      if (msg.llmConfig !== undefined) cachedLlmConfig = msg.llmConfig;
      try {
        const exports: Record<string, unknown> = {};
        // Execute plugin code inside the Worker scope
        const fn = new Function("module", "exports", msg.code);
        fn({ exports }, exports);
        pluginHooks = (exports.hooks as Record<string, Function>) ?? {};
        self.postMessage({ type: "init_result", success: true });
      } catch (err) {
        self.postMessage({
          type: "init_result",
          success: false,
          error: String(err),
        });
      }
      break;
    }

    case "api_result": {
      const pending = pendingCalls.get(msg.callId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingCalls.delete(msg.callId);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.result);
        }
      }
      break;
    }

    case "hook_call": {
      try {
        const hook = pluginHooks[msg.hookName];
        if (!hook) {
          self.postMessage({
            type: "hook_result",
            callId: msg.callId,
            data: msg.data,
            passThrough: true,
          });
          return;
        }
        const result = await hook(proxyContext, msg.data);
        self.postMessage({
          type: "hook_result",
          callId: msg.callId,
          data: result ?? msg.data,
        });
      } catch (err) {
        self.postMessage({
          type: "hook_result",
          callId: msg.callId,
          error: String(err),
        });
      }
      break;
    }

    case "event_receive": {
      const listeners = eventListeners.get(msg.event);
      if (listeners) {
        for (const fn of listeners) {
          try {
            fn(msg.payload);
          } catch {
            /* ignore */
          }
        }
      }
      break;
    }

    // ── Streaming chunk from host ─────────────────────────────────
    case "stream_chunk": {
      const stream = pendingStreams.get(msg.callId);
      if (stream) {
        if (msg.done) {
          clearTimeout(stream.timer);
          stream.onChunk(msg.chunk, true);
          stream.resolve(stream.fullContent);
          pendingStreams.delete(msg.callId);
        } else {
          stream.fullContent += msg.chunk;
          stream.onChunk(msg.chunk, false);
        }
      }
      break;
    }

    // ── State sync from host ──────────────────────────────────────
    case "state_update": {
      if (msg.currentPdfPath !== undefined) cachedCurrentPdfPath = msg.currentPdfPath;
      if (msg.llmConfig !== undefined) cachedLlmConfig = msg.llmConfig;
      break;
    }
  }
};

// ── API call helper ────────────────────────────────────────────────

function callApi(method: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const callId = `call_${++callIdCounter}_${Date.now()}`;
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      reject(new Error(`API call '${method}' timed out after ${CALL_TIMEOUT}ms`));
    }, CALL_TIMEOUT);
    pendingCalls.set(callId, { resolve, reject, timer });
    self.postMessage({ type: "api_call", callId, method, args });
  });
}

// ── Proxy PluginContext (all methods via postMessage) ─────────────

const proxyContext = {
  pluginId: "",

  // Use cached value from host state sync
  getCurrentPdfPath: () => cachedCurrentPdfPath,

  getPdfFullText: () => callApi("getPdfFullText", []) as Promise<string>,
  getPdfPages: () => callApi("getPdfPages", []) as Promise<{ count: number }>,
  getPageText: (idx: number) => callApi("getPageText", [idx]) as Promise<string>,
  getPdfOutline: () => callApi("getPdfOutline", []) as Promise<unknown[]>,
  getPdfAnnotations: (page?: number) => callApi("getPdfAnnotations", [page]) as Promise<unknown[]>,
  searchPdf: (q: string, opts?: unknown) => callApi("searchPdf", [q, opts]) as Promise<unknown[]>,
  getPdfMetadata: () => callApi("getPdfMetadata", []) as Promise<Record<string, unknown>>,
  getPdfInfo: () => callApi("getPdfInfo", []) as Promise<unknown>,
  extractPdfImages: (pages?: number[]) => callApi("extractPdfImages", [pages]),

  invokeLlm: (params: unknown) => callApi("invokeLlm", [params]) as Promise<string>,

  // ── True streaming LLM via chunked message protocol ─────────────
  invokeLlmStream: (params: unknown, onChunk: Function) => {
    return new Promise<string>((resolve, reject) => {
      const callId = `stream_${++callIdCounter}_${Date.now()}`;
      const timer = setTimeout(() => {
        pendingStreams.delete(callId);
        reject(new Error(`Stream '${callId}' timed out after ${STREAM_TIMEOUT}ms`));
      }, STREAM_TIMEOUT);
      pendingStreams.set(callId, {
        onChunk: onChunk as (chunk: string, done: boolean) => void,
        resolve,
        reject,
        fullContent: "",
        timer,
      });
      self.postMessage({ type: "stream_call", callId, params });
    });
  },

  // Use cached value from host state sync
  getLlmConfig: () => cachedLlmConfig,

  storage: {
    get: (key: string) => callApi("storage.get", [key]) as Promise<string | null>,
    set: (key: string, val: string) => callApi("storage.set", [key, val]) as Promise<void>,
    delete: (key: string) => callApi("storage.delete", [key]) as Promise<void>,
    list: () => callApi("storage.list", []) as Promise<string[]>,
  },

  writeFile: (filename: string, content: string | Uint8Array) => {
    // Serialize Uint8Array to base64 for postMessage transfer
    if (content instanceof Uint8Array) {
      const bytes = content;
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const b64 = btoa(binary);
      return callApi("writeFile", [filename, b64, true]) as Promise<string>;
    }
    return callApi("writeFile", [filename, content, false]) as Promise<string>;
  },
  readFile: (filename: string) => callApi("readFile", [filename]) as Promise<string>,

  // ── UI registration via message protocol ────────────────────────
  registerPanel: (config: {
    id: string;
    title: string;
    icon?: string;
    position?: "bottom" | "right";
    html?: string;
  }) => {
    self.postMessage({
      type: "ui_register",
      uiType: "panel",
      config: {
        id: config.id,
        title: config.title,
        icon: config.icon,
        position: config.position,
        html: config.html,
      },
    });
  },
  registerSidebar: (config: {
    id: string;
    title: string;
    icon?: string;
    side?: "left" | "right";
    width?: number;
    html?: string;
  }) => {
    self.postMessage({
      type: "ui_register",
      uiType: "sidebar",
      config: {
        id: config.id,
        title: config.title,
        icon: config.icon,
        side: config.side,
        width: config.width,
        html: config.html,
      },
    });
  },
  registerFloatingWindow: (config: {
    id: string;
    title: string;
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    draggable?: boolean;
    resizable?: boolean;
    html?: string;
  }) => {
    self.postMessage({
      type: "ui_register",
      uiType: "floatingWindow",
      config: {
        id: config.id,
        title: config.title,
        width: config.width,
        height: config.height,
        x: config.x,
        y: config.y,
        draggable: config.draggable,
        resizable: config.resizable,
        html: config.html,
      },
    });
  },

  showInputDialog: (opts: unknown) => callApi("showInputDialog", [opts]) as Promise<string | null>,
  showProgressDialog: (opts: unknown) => callApi("showProgressDialog", [opts]) as Promise<void>,

  showSaveDialog: (opts: unknown) => callApi("showSaveDialog", [opts]) as Promise<string | null>,
  showOpenDialog: (opts: unknown) => callApi("showOpenDialog", [opts]) as Promise<string | null>,

  getPlatform: () => callApi("getPlatform", []) as Promise<{ os: string; arch: string }>,
  getAppVersion: () => callApi("getAppVersion", []) as Promise<string>,
  openExternal: (url: string) => callApi("openExternal", [url]) as Promise<void>,

  queryPapers: (filter?: unknown) => callApi("queryPapers", [filter]) as Promise<unknown[]>,
  getPaperMetadata: (id: string) => callApi("getPaperMetadata", [id]) as Promise<unknown>,
  updatePaperMetadata: (id: string, updates: unknown) =>
    callApi("updatePaperMetadata", [id, updates]) as Promise<void>,

  generatePptx: (params: unknown) => callApi("generatePptx", [params]) as Promise<void>,
  convertTemplateToHtml: (path: string) => callApi("convertTemplateToHtml", [path]) as Promise<string>,

  on: (event: string, handler: Function) => {
    if (!eventListeners.has(event)) eventListeners.set(event, new Set());
    eventListeners.get(event)!.add(handler);
    self.postMessage({ type: "event_subscribe", event });
    return () => {
      eventListeners.get(event)?.delete(handler);
      self.postMessage({ type: "event_unsubscribe", event });
    };
  },
  off: (event: string, handler: Function) => {
    eventListeners.get(event)?.delete(handler);
    self.postMessage({ type: "event_unsubscribe", event });
  },
  emit: (event: string, payload?: unknown) => {
    self.postMessage({ type: "event_emit", event, payload });
  },
  emitBackend: (event: string, payload: unknown) =>
    callApi("emitBackend", [event, payload]) as Promise<void>,

  showToast: (type: string, message: string) => {
    // Use a unique callId so fire-and-forget doesn't collide
    const callId = `toast_${++callIdCounter}_${Date.now()}`;
    self.postMessage({
      type: "api_call",
      callId,
      method: "showToast",
      args: [type, message],
    });
  },
};

// Set pluginId after init message
Object.defineProperty(proxyContext, "pluginId", {
  get: () => myPluginId,
});

export {};
