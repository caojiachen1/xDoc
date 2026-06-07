/**
 * PluginContext implementation — sandboxed 20+ API surface for plugins (v2).
 *
 * Main-thread mode: direct Tauri invoke calls (builtin plugins).
 * Worker mode: proxy via postMessage (external plugins).
 */
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { fetch } from "@tauri-apps/plugin-http";
import { eventBus } from "./event-bus";
import type {
  PluginContext,
  PdfImageInfo,
  PdfOutlineItem,
  PdfAnnotation,
  PdfSearchResult,
  PdfInfo,
  SlideData,
  LlmInvokeParams,
  LlmCallData,
  LlmStreamCallback,
  PaperQueryFilter,
  PaperRecordSummary,
  PanelRegistration,
  SidebarRegistration,
  FloatingWindowRegistration,
  InputDialogOptions,
  ProgressDialogOptions,
  SaveDialogOptions,
  OpenDialogOptions,
  GeneratePptxParams,
  ToastType,
  LlmConfigSnapshot,
} from "./types";

// Forward ref to avoid circular imports — set by manager.ts at startup
let _interceptorRunner:
  | {
      runBefore: <T>(hook: string, pluginId: string, data: T) => Promise<T | null>;
      runAfter: <T>(hook: string, pluginId: string, data: T) => Promise<T>;
    }
  | null = null;

export function setInterceptorRunner(runner: typeof _interceptorRunner) {
  _interceptorRunner = runner;
}

// Forward ref for UI registry
let _uiRegistry: {
  registerPanel: (pluginId: string, config: PanelRegistration) => void;
  registerSidebar: (pluginId: string, config: SidebarRegistration) => void;
  registerFloatingWindow: (pluginId: string, config: FloatingWindowRegistration) => void;
} | null = null;

export function setUIRegistry(registry: typeof _uiRegistry) {
  _uiRegistry = registry;
}

// ── Options ────────────────────────────────────────────────────────

export interface PluginApiOptions {
  pluginId: string;
  getCurrentPdfPath: () => string | null;
  getLlmConfig: () => LlmConfigSnapshot | null;
}

// ── Factory ────────────────────────────────────────────────────────

/** Create a PluginContext instance, one per plugin (main-thread mode). */
export function createPluginContext(options: PluginApiOptions): PluginContext {
  const { pluginId, getCurrentPdfPath, getLlmConfig } = options;

  // ── Helper: run interceptor before hook ──
  async function runBefore<T>(hook: string, data: T): Promise<T | null> {
    if (!_interceptorRunner) return data;
    return _interceptorRunner.runBefore(hook, pluginId, data);
  }
  async function runAfter<T>(hook: string, data: T): Promise<T> {
    if (!_interceptorRunner) return data;
    return _interceptorRunner.runAfter(hook, pluginId, data);
  }

  // ── Shared LLM HTTP implementation ──
  async function executeLlmHttp(
    params: LlmInvokeParams,
    stream: boolean,
  ): Promise<{ resp: Response; baseUrl: string }> {
    const cfg = getLlmConfig();
    if (!cfg) throw new Error("LLM not configured. Please go to Settings → LLM first.");
    const baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 4096,
      stream,
    };
    if (cfg.vendor === "volcengine") {
      body.thinking = { type: "disabled" };
    }
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey ?? ""}`,
      },
      body: JSON.stringify(body),
    });
    return { resp, baseUrl };
  }

  return {
    pluginId,

    // ── PDF APIs ──────────────────────────────────────────────────

    getCurrentPdfPath,

    getPdfFullText: async () => {
      const filePath = getCurrentPdfPath();
      if (!filePath) throw new Error("No PDF is currently open");
      const pre = await runBefore("beforePdfTextExtract", { filePath });
      if (!pre) return "";
      const result = await invoke<string>("plugin_get_full_pdf_text", {
        filePath: pre.filePath,
        pluginId,
      });
      const post = await runAfter("afterPdfTextExtract", { filePath, text: result });
      return post.text;
    },

    getPdfPages: async () => {
      const filePath = getCurrentPdfPath();
      if (!filePath) throw new Error("No PDF is currently open");
      const count = await invoke<number>("plugin_pdf_page_count", {
        filePath,
        pluginId,
      });
      return { count };
    },

    getPageText: async (pageIndex: number) => {
      const filePath = getCurrentPdfPath();
      if (!filePath) throw new Error("No PDF is currently open");
      return invoke<string>("plugin_pdf_page_text", {
        filePath,
        pageIndex,
        pluginId,
      });
    },

    getPdfOutline: async (): Promise<PdfOutlineItem[]> => {
      const filePath = getCurrentPdfPath();
      if (!filePath) throw new Error("No PDF is currently open");
      const flat = await invoke<{ title: string; page_index: number; level: number }[]>(
        "plugin_pdf_outline",
        { filePath, pluginId },
      );
      // Build tree from flat list
      return buildOutlineTree(flat);
    },

    getPdfAnnotations: async (_pageIndex?: number): Promise<PdfAnnotation[]> => {
      // Annotations are stored in a separate SQLite table; fetch via existing command
      const filePath = getCurrentPdfPath();
      if (!filePath) throw new Error("No PDF is currently open");
      // For now return empty — full annotation API can be added later
      return [];
    },

    searchPdf: async (query: string, options?: { caseSensitive?: boolean }): Promise<PdfSearchResult[]> => {
      const filePath = getCurrentPdfPath();
      if (!filePath) throw new Error("No PDF is currently open");
      const results = await invoke<{ page_index: number; text: string }[]>(
        "plugin_pdf_search",
        {
          filePath,
          query,
          caseSensitive: options?.caseSensitive ?? false,
          pluginId,
        },
      );
      return results.map((r) => ({ pageIndex: r.page_index, text: r.text }));
    },

    getPdfMetadata: async () => {
      const filePath = getCurrentPdfPath();
      if (!filePath) throw new Error("No PDF is currently open");
      return invoke<Record<string, unknown>>("plugin_extract_first_page_metadata", {
        filePath,
        pluginId,
      });
    },

    getPdfInfo: async (): Promise<PdfInfo> => {
      const filePath = getCurrentPdfPath();
      if (!filePath) throw new Error("No PDF is currently open");
      const info = await invoke<{
        page_count: number;
        title?: string;
        author?: string;
        subject?: string;
        creator?: string;
        file_size?: number;
      }>("plugin_pdf_info", { filePath, pluginId });
      return {
        pageCount: info.page_count,
        title: info.title,
        author: info.author,
        subject: info.subject,
        creator: info.creator,
        fileSize: info.file_size,
      };
    },

    extractPdfImages: async (pageIndices?: number[]): Promise<PdfImageInfo[]> => {
      const filePath = getCurrentPdfPath();
      if (!filePath) throw new Error("No PDF is currently open");
      return invoke<PdfImageInfo[]>("plugin_extract_pdf_images", {
        filePath,
        pageIndices: pageIndices ?? null,
        pluginId,
      });
    },

    // ── LLM APIs ─────────────────────────────────────────────────

    invokeLlm: async (params: LlmInvokeParams): Promise<string> => {
      // Run beforeLlmCall interceptors
      let callData: LlmCallData = {
        systemPrompt: params.systemPrompt,
        userPrompt: params.userPrompt,
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 4096,
      };
      const intercepted = await runBefore("beforeLlmCall", callData);
      if (!intercepted) throw new Error("LLM call cancelled by interceptor");
      callData = intercepted;

      const { resp } = await executeLlmHttp(
        {
          systemPrompt: callData.systemPrompt,
          userPrompt: callData.userPrompt,
          temperature: callData.temperature,
          maxTokens: callData.maxTokens,
        },
        false,
      );

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        throw new Error(`LLM request failed (${resp.status}): ${errBody}`);
      }

      const json = (await resp.json()) as {
        choices: { message: { content: string } }[];
      };
      const response = json.choices?.[0]?.message?.content ?? "";

      // Run afterLlmCall interceptors
      const post = await runAfter("afterLlmCall", { request: callData, response });
      return post.response;
    },

    invokeLlmStream: async (
      params: LlmInvokeParams,
      onChunk: LlmStreamCallback,
    ): Promise<string> => {
      const { resp } = await executeLlmHttp(params, true);
      if (!resp.ok || !resp.body) {
        const errBody = await resp.text().catch(() => "");
        throw new Error(`LLM stream failed (${resp.status}): ${errBody}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") {
              onChunk("", true);
              return fullContent;
            }
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content ?? "";
              if (delta) {
                fullContent += delta;
                onChunk(delta, false);
              }
            } catch {
              /* skip malformed chunks */
            }
          }
        }
      }

      onChunk("", true);
      return fullContent;
    },

    getLlmConfig: () => {
      const cfg = getLlmConfig();
      return cfg ? { vendor: cfg.vendor, baseUrl: cfg.baseUrl, model: cfg.model } : null;
    },

    // ── Storage APIs ──────────────────────────────────────────────

    storage: {
      get: (key: string) =>
        invoke<string | null>("plugin_storage_get", { key, pluginId }),
      set: (key: string, value: string) =>
        invoke<void>("plugin_storage_set", { key, value, pluginId }),
      delete: (key: string) =>
        invoke<void>("plugin_storage_delete", { key, pluginId }),
      list: () => invoke<string[]>("plugin_storage_list", { pluginId }),
    },

    // ── File I/O (sandboxed) ──────────────────────────────────────

    writeFile: (filename: string, content: string | Uint8Array) => {
      const strContent =
        typeof content === "string"
          ? content
          : new TextDecoder().decode(content);
      return invoke<string>("plugin_write_file", {
        filename,
        content: strContent,
        pluginId,
      });
    },

    readFile: (filename: string) =>
      invoke<string>("plugin_read_file", { filename, pluginId }),

    // ── UI APIs ───────────────────────────────────────────────────

    registerPanel: (config: PanelRegistration) => {
      _uiRegistry?.registerPanel(pluginId, config);
    },

    registerSidebar: (config: SidebarRegistration) => {
      _uiRegistry?.registerSidebar(pluginId, config);
    },

    registerFloatingWindow: (config: FloatingWindowRegistration) => {
      _uiRegistry?.registerFloatingWindow(pluginId, config);
    },

    showInputDialog: async (options: InputDialogOptions): Promise<string | null> => {
      return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText =
          "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)";

        const dialog = document.createElement("div");
        dialog.style.cssText =
          "background:rgb(40,40,40);border-radius:12px;padding:24px;max-width:400px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.12);color:#f3f3f3";

        const title = document.createElement("h3");
        title.style.cssText = "margin:0 0 16px 0;font-size:16px;color:#f3f3f3";
        title.textContent = options.title;

        const input = document.createElement("input");
        input.style.cssText =
          "width:100%;padding:10px 12px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:#2a2a2a;color:#f3f3f3;font-size:14px;box-sizing:border-box;outline:none";
        input.placeholder = options.placeholder ?? "";
        input.value = options.defaultValue ?? "";

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:16px";

        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = options.cancelLabel ?? "取消";
        cancelBtn.style.cssText =
          "padding:8px 16px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:#333;color:#f3f3f3;cursor:pointer;font-size:13px";

        const confirmBtn = document.createElement("button");
        confirmBtn.textContent = options.confirmLabel ?? "确认";
        confirmBtn.style.cssText =
          "padding:8px 16px;border:none;border-radius:6px;background:#4a7bf7;color:#fff;cursor:pointer;font-size:13px";

        btnRow.append(cancelBtn, confirmBtn);
        dialog.append(title, input, btnRow);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const cleanup = () => document.body.removeChild(overlay);

        cancelBtn.onclick = () => {
          cleanup();
          resolve(null);
        };
        confirmBtn.onclick = () => {
          cleanup();
          resolve(input.value);
        };
        input.onkeydown = (e) => {
          if (e.key === "Enter") {
            cleanup();
            resolve(input.value);
          }
          if (e.key === "Escape") {
            cleanup();
            resolve(null);
          }
        };
        overlay.onclick = (e) => {
          if (e.target === overlay) {
            cleanup();
            resolve(null);
          }
        };
        setTimeout(() => input.focus(), 50);
      });
    },

    showProgressDialog: async (options: ProgressDialogOptions): Promise<void> => {
      return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText =
          "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px)";

        const dialog = document.createElement("div");
        dialog.style.cssText =
          "background:rgb(40,40,40);border-radius:12px;padding:24px;max-width:360px;width:85%;box-shadow:0 8px 32px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.12);color:#f3f3f3;text-align:center";

        dialog.innerHTML = `<h3 style="margin:0 0 12px 0;font-size:16px;color:#f3f3f3">${options.title}</h3>
          <p style="margin:0 0 16px 0;font-size:13px;color:#aaa">${options.message}</p>
          <div style="width:100%;height:4px;background:#333;border-radius:2px;overflow:hidden">
            <div style="width:${options.progress ?? -1 >= 0 ? options.progress + "%" : "100%"};height:100%;background:#4a7bf7;border-radius:2px;${(options.progress ?? -1) < 0 ? "animation:indeterminate 1.5s infinite" : ""}"></div>
          </div>`;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Auto-close after a timeout or when cancelled
        const cleanup = () => {
          if (document.body.contains(overlay)) document.body.removeChild(overlay);
          resolve();
        };

        if (options.cancellable) {
          overlay.onclick = cleanup;
        }

        // Auto-dismiss after 60s
        setTimeout(cleanup, 60_000);
      });
    },

    // ── Dialog APIs ───────────────────────────────────────────────

    showSaveDialog: async (options: SaveDialogOptions) => {
      return save({
        defaultPath: options.defaultName,
        filters: Object.entries(options.filters).map(([name, extensions]) => ({
          name,
          extensions,
        })),
      });
    },

    showOpenDialog: async (options: OpenDialogOptions) => {
      const result = await open({
        multiple: options.multiple ?? false,
        filters: Object.entries(options.filters).map(([name, extensions]) => ({
          name,
          extensions,
        })),
      });
      if (Array.isArray(result)) {
        return result[0] ?? null;
      }
      return result;
    },

    // ── System APIs ───────────────────────────────────────────────

    getPlatform: () =>
      invoke<{ os: string; arch: string }>("plugin_get_platform", { pluginId }),

    getAppVersion: () =>
      invoke<string>("plugin_get_app_version", { pluginId }),

    openExternal: async (url: string) => {
      // Use Tauri's shell.open or fallback to window.open
      try {
        await invoke("plugin_emit_event", {
          event: "plugin:open-external",
          payload: JSON.stringify({ url }),
        });
      } catch {
        window.open(url, "_blank");
      }
    },

    // ── Paper DB APIs ─────────────────────────────────────────────

    queryPapers: async (filter?: PaperQueryFilter): Promise<PaperRecordSummary[]> => {
      const results = await invoke<
        { id: string; name: string; journal?: string; date?: string; metadata_extracted: boolean }[]
      >("plugin_query_papers", {
        search: filter?.search ?? null,
        journal: filter?.journal ?? null,
        pluginId,
      });
      return results.map((r) => ({
        id: r.id,
        name: r.name,
        journal: r.journal,
        date: r.date,
        metadataExtracted: r.metadata_extracted,
      }));
    },

    getPaperMetadata: async (paperId: string) => {
      return invoke<Record<string, unknown> | null>("plugin_get_paper_metadata", {
        paperId,
        pluginId,
      });
    },

    updatePaperMetadata: async (paperId: string, updates: Record<string, unknown>) => {
      await invoke("plugin_update_paper_metadata", {
        paperId,
        updates,
        pluginId,
      });
    },

    // ── PPTX APIs ─────────────────────────────────────────────────

    generatePptx: async (params: GeneratePptxParams) => {
      await invoke("plugin_generate_pptx", {
        outputPath: params.outputPath,
        title: params.title,
        slides: params.slides.map((s: SlideData) => ({
          title: s.title,
          bullets: s.bullets,
          image_base64: s.imageBase64 ?? null,
          slide_type: s.slideType ?? null,
        })),
        templatePath: params.templatePath ?? null,
        pluginId,
      });
    },

    convertTemplateToHtml: async (templatePath: string) => {
      return invoke<string>("plugin_convert_template_to_html", {
        templatePath,
        pluginId,
      });
    },

    // ── Event APIs (using EventBus) ──────────────────────────────

    on: (event: string, handler: (payload: unknown) => void) => {
      return eventBus.on(event, handler, pluginId);
    },

    off: (event: string, handler: (payload: unknown) => void) => {
      eventBus.off(event, handler);
    },

    emit: (event: string, payload?: unknown) => {
      eventBus.emitScoped(pluginId, event, payload);
    },

    emitBackend: async (event: string, payload: unknown) => {
      await invoke("plugin_emit_event", {
        event,
        payload: JSON.stringify(payload),
      });
    },

    // ── Toast ─────────────────────────────────────────────────────

    showToast: (type: ToastType, message: string, _duration?: number) => {
      eventBus.emit("plugin:toast", { type, message });
    },
  };
}

// ── Outline tree builder ────────────────────────────────────────────

function buildOutlineTree(
  flat: { title: string; page_index: number; level: number }[],
): PdfOutlineItem[] {
  const root: PdfOutlineItem[] = [];
  const stack: { item: PdfOutlineItem; level: number }[] = [];

  for (const entry of flat) {
    const node: PdfOutlineItem = {
      title: entry.title,
      pageIndex: entry.page_index,
      level: entry.level,
      children: [],
    };

    // Pop stack until we find a parent with lower level
    while (stack.length > 0 && stack[stack.length - 1].level >= entry.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      root.push(node);
    } else {
      const parent = stack[stack.length - 1].item;
      if (!parent.children) parent.children = [];
      parent.children.push(node);
    }

    stack.push({ item: node, level: entry.level });
  }

  return root;
}
