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

const pendingCalls = new Map<string, PendingCall>();
let callIdCounter = 0;
const CALL_TIMEOUT = 30_000;

// Plugin hooks registered by the loaded code
let pluginHooks: Record<string, Function> = {};
let myPluginId = "";

// Internal event listeners (worker-side)
const eventListeners = new Map<string, Set<Function>>();

// ── Receive messages from main thread ───────────────────────────

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case "init": {
      myPluginId = msg.pluginId;
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

  getCurrentPdfPath: () => null as string | null, // sync not possible; use async
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
  invokeLlmStream: (params: unknown, onChunk: Function) => {
    // Streaming not supported in Worker — fall back to non-streaming
    return callApi("invokeLlm", [params]).then((result) => {
      onChunk?.(result, true);
      return result as string;
    });
  },
  getLlmConfig: () => null,

  storage: {
    get: (key: string) => callApi("storage.get", [key]) as Promise<string | null>,
    set: (key: string, val: string) => callApi("storage.set", [key, val]) as Promise<void>,
    delete: (key: string) => callApi("storage.delete", [key]) as Promise<void>,
    list: () => callApi("storage.list", []) as Promise<string[]>,
  },

  writeFile: (filename: string, content: string | Uint8Array) =>
    callApi("writeFile", [filename, typeof content === "string" ? content : ""]) as Promise<string>,
  readFile: (filename: string) => callApi("readFile", [filename]) as Promise<string>,

  registerPanel: () => { /* not supported in Worker */ },
  registerSidebar: () => { /* not supported in Worker */ },
  registerFloatingWindow: () => { /* not supported in Worker */ },
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
    self.postMessage({
      type: "api_call",
      callId: "fire_and_forget",
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
