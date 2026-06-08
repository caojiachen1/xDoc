/**
 * worker-host.ts — main-thread manager for plugin WebWorkers.
 *
 * Creates a Worker, forwards API calls, and creates a proxy PluginHooks
 * object that the PluginManager can call from the main thread.
 *
 * Also handles:
 * - Streaming LLM chunk forwarding (worker ←→ main thread)
 * - UI registration forwarding (worker → uiRegistry)
 * - State sync (currentPdfPath, llmConfig → worker cache)
 */
import { createPluginContext, type PluginApiOptions } from "../context";
import { eventBus } from "../event-bus";
import { uiRegistry } from "../ui-extensions";
import type { PluginHooks, WorkerMessageType, WorkerUIRegistration } from "../types";

// ── Types ───────────────────────────────────────────────────────────

interface PendingHook {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface WorkerHost {
  worker: Worker;
  pluginId: string;
  pendingHooks: Map<string, PendingHook>;
  eventSubscriptions: Set<string>;
  cleanup: () => void;
}

/** Active workers keyed by pluginId */
export const activeWorkers = new Map<string, WorkerHost>();

// ── Public API ─────────────────────────────────────────────────────

/**
 * Load an external plugin's code inside a WebWorker and return
 * a proxy PluginHooks object that the manager can invoke.
 */
export async function loadPluginInWorker(
  pluginId: string,
  code: string,
  contextOptions: PluginApiOptions,
): Promise<PluginHooks> {
  const worker = new Worker(
    new URL("./plugin-worker.ts", import.meta.url),
    { type: "module" },
  );

  // Create a real main-thread context to fulfil API calls from the worker
  const mainCtx = createPluginContext({ ...contextOptions });

  const host: WorkerHost = {
    worker,
    pluginId,
    pendingHooks: new Map(),
    eventSubscriptions: new Set(),
    cleanup: () => {
      worker.terminate();
      eventBus.cleanupPlugin(pluginId);
      // Unsubscribe all events
      for (const event of host.eventSubscriptions) {
        eventBus.off(event, () => {});
      }
      activeWorkers.delete(pluginId);
    },
  };

  activeWorkers.set(pluginId, host);

  // Handle messages from the Worker
  worker.onmessage = async (e: MessageEvent<WorkerMessageType>) => {
    const msg = e.data;

    switch (msg.type) {
      case "api_call": {
        const m = msg as Extract<WorkerMessageType, { type: "api_call" }>;
        try {
          const result = await executeApiCall(mainCtx, m.method, m.args);
          worker.postMessage({
            type: "api_result",
            callId: m.callId,
            result,
          });
        } catch (err) {
          worker.postMessage({
            type: "api_result",
            callId: m.callId,
            error: String(err),
          });
        }
        break;
      }

      case "hook_result": {
        const m = msg as Extract<WorkerMessageType, { type: "hook_result" }>;
        const pending = host.pendingHooks.get(m.callId);
        if (pending) {
          host.pendingHooks.delete(m.callId);
          if (m.error) {
            pending.reject(new Error(m.error));
          } else {
            pending.resolve(m.data);
          }
        }
        break;
      }

      // ── Streaming LLM: worker → host → main-thread context ───────
      case "stream_call": {
        const m = msg as Extract<WorkerMessageType, { type: "stream_call" }>;
        try {
          await mainCtx.invokeLlmStream(m.params, (chunk: string, done: boolean) => {
            worker.postMessage({
              type: "stream_chunk",
              callId: m.callId,
              chunk,
              done,
            });
          });
        } catch (err) {
          worker.postMessage({
            type: "stream_chunk",
            callId: m.callId,
            chunk: "",
            done: true,
          });
          console.warn(`[WorkerHost] stream_call error for '${pluginId}':`, err);
        }
        break;
      }

      // ── UI registration: worker → host uiRegistry ─────────────────
      case "ui_register": {
        const m = msg as Extract<WorkerMessageType, { type: "ui_register" }>;
        handleUIRegistration(pluginId, m.uiType, m.config);
        break;
      }

      case "event_subscribe": {
        const m = msg as Extract<WorkerMessageType, { type: "event_subscribe" }>;
        host.eventSubscriptions.add(m.event);
        eventBus.on(
          m.event,
          (payload) => {
            worker.postMessage({ type: "event_receive", event: m.event, payload });
          },
          pluginId,
        );
        break;
      }

      case "event_unsubscribe": {
        const m = msg as Extract<WorkerMessageType, { type: "event_unsubscribe" }>;
        host.eventSubscriptions.delete(m.event);
        break;
      }

      case "event_emit": {
        const m = msg as Extract<WorkerMessageType, { type: "event_emit" }>;
        eventBus.emitScoped(pluginId, m.event, m.payload);
        break;
      }
    }
  };

  worker.onerror = (err) => {
    console.error(`[WorkerHost] plugin '${pluginId}' worker error:`, err);
  };

  // Send init message with initial state snapshot
  return new Promise<PluginHooks>((resolve, reject) => {
    const initHandler = (e: MessageEvent) => {
      if (e.data.type === "init_result") {
        worker.removeEventListener("message", initHandler);
        if (e.data.success) {
          resolve(createWorkerHookProxy(host));
        } else {
          host.cleanup();
          reject(new Error(e.data.error));
        }
      }
    };
    worker.addEventListener("message", initHandler);
    worker.postMessage({
      type: "init",
      code,
      pluginId,
      // Send initial state for worker cache
      currentPdfPath: contextOptions.getCurrentPdfPath(),
      llmConfig: contextOptions.getLlmConfig(),
    });
  });
}

// ── State sync API (called by manager when PDF or LLM config changes) ──

/**
 * Notify a worker about state changes (currentPdfPath, llmConfig).
 * Call this from the manager whenever these values change.
 */
export function syncWorkerState(pluginId: string, state: {
  currentPdfPath?: string | null;
  llmConfig?: unknown;
}) {
  const host = activeWorkers.get(pluginId);
  if (host) {
    host.worker.postMessage({ type: "state_update", ...state });
  }
}

/** Sync state to ALL active workers */
export function syncAllWorkers(state: {
  currentPdfPath?: string | null;
  llmConfig?: unknown;
}) {
  for (const [, host] of activeWorkers) {
    host.worker.postMessage({ type: "state_update", ...state });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Resolve a dotted method name on the context and call it.
 */
async function executeApiCall(
  ctx: ReturnType<typeof createPluginContext>,
  method: string,
  args: unknown[],
): Promise<unknown> {
  // Special case: writeFile with base64 flag from worker
  if (method === "writeFile" && args[2] === true) {
    const b64 = args[1] as string;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return ctx.writeFile(args[0] as string, bytes);
  }

  const parts = method.split(".");
  let target: unknown = ctx;
  for (const part of parts) {
    if (target == null) throw new Error(`Unknown API method: ${method}`);
    target = (target as Record<string, unknown>)[part];
  }
  if (typeof target === "function") {
    return (target as Function)(...args);
  }
  return target;
}

/**
 * Handle UI registration messages from the worker.
 * Creates a real registration in the uiRegistry with a no-op render
 * (the html content will be rendered via iframe in the host UI layer).
 */
function handleUIRegistration(
  pluginId: string,
  uiType: "panel" | "sidebar" | "floatingWindow",
  config: WorkerUIRegistration,
) {
  // Create a registration with a render function that creates an iframe
  const renderFn = config.html
    ? (container: HTMLElement) => {
        const iframe = document.createElement("iframe");
        iframe.style.cssText = "width:100%;height:100%;border:none;border-radius:inherit";
        iframe.sandbox.add("allow-scripts");
        container.appendChild(iframe);
        // Write HTML content into the iframe
        const doc = iframe.contentDocument;
        if (doc) {
          doc.open();
          doc.write(config.html!);
          doc.close();
        }
        return () => {
          container.removeChild(iframe);
        };
      }
    : undefined;

  const registrationConfig = {
    id: config.id,
    title: config.title,
    icon: config.icon,
    html: config.html,
    render: renderFn,
  };

  switch (uiType) {
    case "panel":
      uiRegistry.registerPanel(pluginId, {
        ...registrationConfig,
        position: config.position,
      });
      break;
    case "sidebar":
      uiRegistry.registerSidebar(pluginId, {
        ...registrationConfig,
        side: config.side,
        width: config.width,
      });
      break;
    case "floatingWindow":
      uiRegistry.registerFloatingWindow(pluginId, {
        ...registrationConfig,
        width: config.width,
        height: config.height,
        x: config.x,
        y: config.y,
        draggable: config.draggable,
        resizable: config.resizable,
      });
      break;
  }
}

/**
 * Create a PluginHooks proxy that, when called from the main thread,
 * forwards the call to the Worker and returns a Promise.
 */
function createWorkerHookProxy(host: WorkerHost): PluginHooks {
  const HOOK_NAMES = [
    "onActivate",
    "onDeactivate",
    "onInit",
    "onDestroy",
    "onAppReady",
    "onPdfOpened",
    "onPdfClosed",
    "onPdfTextReady",
    "onSettingsChanged",
    "onBeforeUnload",
    "beforePdfTextExtract",
    "afterPdfTextExtract",
    "beforeOcr",
    "afterOcr",
    "beforeLlmCall",
    "afterLlmCall",
    "beforeExport",
    "afterExport",
    "contextMenuItems",
    "toolbarButtons",
    "commands",
  ];

  const hooks: Record<string, Function> = {};

  for (const name of HOOK_NAMES) {
    hooks[name] = (ctx: unknown, data?: unknown) => {
      return new Promise((resolve, reject) => {
        const callId = `hook_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        host.pendingHooks.set(callId, { resolve, reject });
        host.worker.postMessage({
          type: "hook_call",
          callId,
          hookName: name,
          data: data ?? ctx,
        });

        // Hook timeout (10s) — pass-through on timeout
        setTimeout(() => {
          if (host.pendingHooks.has(callId)) {
            host.pendingHooks.delete(callId);
            resolve(data);
          }
        }, 10_000);
      });
    };
  }

  return hooks as unknown as PluginHooks;
}
