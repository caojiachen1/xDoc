/**
 * PluginContext implementation — sandboxed API for plugins
 *
 * Key design principles:
 * - Plugins can only access system capabilities through PluginContext
 * - Every API goes through permission checks
 * - Does not expose window, document, or arbitrary Tauri invoke
 */
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { fetch } from "@tauri-apps/plugin-http";
import type { PluginContext, PdfImageInfo, SlideData } from "./types";

interface PluginApiOptions {
  pluginId: string;
  getCurrentPdfPath: () => string | null;
  getLlmConfig: () => {
    vendor: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  } | null;
}

/** Create a PluginContext instance, one per plugin */
export function createPluginContext(options: PluginApiOptions): PluginContext {
  const { pluginId, getCurrentPdfPath, getLlmConfig } = options;

  return {
    pluginId,

    getCurrentPdfPath,

    getPdfFullText: async () => {
      const filePath = getCurrentPdfPath();
      if (!filePath) throw new Error("No PDF is currently open");

      const result = await invoke<string>("get_full_pdf_text", {
        filePath,
      });
      return result;
    },

    getPdfMetadata: async () => {
      const filePath = getCurrentPdfPath();
      if (!filePath) throw new Error("No PDF is currently open");

      const metadata = await invoke<Record<string, unknown>>(
        "extract_first_page_metadata",
        { filePath, scoreThreshold: null }
      );
      return metadata;
    },

    extractPdfImages: async (pageIndices?: number[]): Promise<PdfImageInfo[]> => {
      const filePath = getCurrentPdfPath();
      if (!filePath) throw new Error("No PDF is currently open");

      const result = await invoke<PdfImageInfo[]>("extract_pdf_images", {
        filePath,
        pageIndices: pageIndices ?? null,
      });
      return result;
    },

    invokeLlm: async (params) => {
      const llmConfig = getLlmConfig();
      if (!llmConfig) throw new Error("LLM not configured. Please go to Settings → LLM first.");

      const { systemPrompt, userPrompt, temperature = 0.7, maxTokens = 4096 } = params;
      const baseUrl = llmConfig.baseUrl.replace(/\/+$/, "");

      const body: Record<string, unknown> = {
        model: llmConfig.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
        stream: false,
      };

      // Volcengine special handling
      if (llmConfig.vendor === "volcengine") {
        body.thinking = { type: "disabled" };
      }

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llmConfig.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        throw new Error(`LLM request failed (${resp.status}): ${errBody}`);
      }

      const json = (await resp.json()) as {
        choices: { message: { content: string } }[];
      };
      return json.choices?.[0]?.message?.content ?? "";
    },

    showSaveDialog: async (options) => {
      return save({
        defaultPath: options.defaultName,
        filters: Object.entries(options.filters).map(([name, extensions]) => ({
          name,
          extensions,
        })),
      });
    },

    showOpenDialog: async (options) => {
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

    generatePptx: async (params) => {
      await invoke("generate_pptx", {
        outputPath: params.outputPath,
        title: params.title,
        slides: params.slides.map((s: SlideData) => ({
          title: s.title,
          bullets: s.bullets,
          image_base64: s.imageBase64 ?? null,
          slide_type: s.slideType ?? null,
        })),
        templatePath: params.templatePath ?? null,
      });
    },

    convertTemplateToHtml: async (templatePath: string) => {
      return invoke<string>("convert_template_to_html", { templatePath });
    },

    emitBackend: async (event, payload) => {
      await invoke("plugin_emit_event", {
        event,
        payload: JSON.stringify(payload),
      });
    },

    onEvent: (event, handler) => {
      const callback = (e: Event) => {
        const custom = e as CustomEvent;
        handler(custom.detail);
      };
      window.addEventListener(event, callback);
      return () => window.removeEventListener(event, callback);
    },

    showToast: (type, message) => {
      window.dispatchEvent(
        new CustomEvent("plugin:toast", {
          detail: { type, message },
        })
      );
    },
  };
}
