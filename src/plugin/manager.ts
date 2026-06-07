/**
 * PluginManager — Plugin lifecycle management
 *
 * Responsibilities:
 * 1. Fetch plugin manifest list from the Rust backend
 * 2. Load/unload plugins
 * 3. Collect hooks registered by plugins (context menu items, toolbar buttons, commands)
 * 4. Broadcast plugin events to the frontend UI
 */
import { invoke } from "@tauri-apps/api/core";
import {
  type PluginInstance,
  type PluginManifest,
  type PluginHooks,
  type PluginContext,
  type PluginContextMenuItem,
  type PluginToolbarButton,
  type PluginCommand,
  PLUGIN_EVENTS,
} from "./types";
import { createPluginContext } from "./context";

type Listener = () => void;

class PluginManagerClass {
  /** All discovered plugins */
  private plugins: Map<string, PluginInstance> = new Map();
  /** State change listeners */
  private listeners: Set<Listener> = new Set();

  /** ── Current PDF state (updated by App.tsx) ── */
  private currentPdfPath: string | null = null;
  private llmConfig: {
    vendor: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  } | null = null;

  /** ── Collected hooks (consumed by components) ── */
  contextMenuItems: PluginContextMenuItem[] = [];
  toolbarButtons: PluginToolbarButton[] = [];
  commands: PluginCommand[] = [];

  /** Subscribe to state changes */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((fn) => fn());
  }

  /** Called by App.tsx when a PDF is opened */
  setCurrentPdfPath(path: string | null) {
    this.currentPdfPath = path;
    if (path) {
      // Notify all plugins listening for onPdfOpened
      const paper = { id: "", name: "", path };
      this.plugins.forEach((plugin) => {
        if (plugin.status === "enabled" && plugin.hooks.onPdfOpened) {
          const ctx = this.makeContext(plugin.manifest.id);
          plugin.hooks.onPdfOpened(ctx, paper).catch((err) => {
            console.warn(`[Plugin ${plugin.manifest.id}] onPdfOpened error:`, err);
          });
        }
      });
    }
  }

  /** Called by App.tsx when the full text is ready */
  async notifyPdfTextReady(fullText: string) {
    this.plugins.forEach((plugin) => {
      if (plugin.status === "enabled" && plugin.hooks.onPdfTextReady) {
        const ctx = this.makeContext(plugin.manifest.id);
        plugin.hooks.onPdfTextReady(ctx, fullText).catch((err) => {
          console.warn(`[Plugin ${plugin.manifest.id}] onPdfTextReady error:`, err);
        });
      }
    });
  }

  /** Set LLM config (updated when SettingsDialog saves) */
  setLlmConfig(config: typeof this.llmConfig) {
    this.llmConfig = config;
  }

  /** Get a snapshot of the LLM config (for context menu handler in host.ts) */
  getLlmConfigSnapshot() {
    return this.llmConfig;
  }

  /** Register a builtin plugin manifest (so it appears in getAllPlugins) */
  registerBuiltinManifest(manifest: PluginManifest): void {
    if (!this.plugins.has(manifest.id)) {
      this.plugins.set(manifest.id, {
        manifest,
        status: "disabled",
        hooks: {},
        isBuiltin: true,
      });
      this.notify();
    }
  }

  /** ── Core: discover and load plugins ── */

  async discoverPlugins(): Promise<PluginManifest[]> {
    try {
      const manifests = await invoke<PluginManifest[]>("plugin_list");

      for (const manifest of manifests) {
        if (!this.plugins.has(manifest.id)) {
          // Initial state is disabled, do not auto-load code
          this.plugins.set(manifest.id, {
            manifest,
            status: "disabled",
            hooks: {},
          });
        }
      }

      // Auto-enable all builtin plugins
      const allPlugins = Array.from(this.plugins.entries());
      for (const [pluginId, plugin] of allPlugins) {
        if (plugin.isBuiltin && plugin.status === "disabled") {
          try {
            await this.enablePlugin(pluginId);
          } catch (err) {
            console.warn(`[PluginManager] Failed to auto-enable builtin plugin '${pluginId}':`, err);
          }
        }
      }

      this.notify();
      return manifests;
    } catch (err) {
      console.warn("[PluginManager] Failed to discover plugins:", err);
      return [];
    }
  }

  /** Enable a single plugin (load its hooks) */
  async enablePlugin(pluginId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);
    if (!entry) throw new Error(`Plugin '${pluginId}' not found`);

    try {
      // Dynamically load the plugin entry script
      const hooks = await this.loadPluginModule(entry.manifest);
      entry.hooks = hooks;
      entry.status = "enabled";
      entry.error = undefined;

      // Call onInit
      if (hooks.onInit) {
        const ctx = this.makeContext(pluginId);
        const moreHooks = await hooks.onInit(ctx);
        if (moreHooks) {
          entry.hooks = { ...entry.hooks, ...moreHooks };
        }
      }

      // Re-collect hooks
      this.collectHooks();
      this.notify();

      // Dispatch event
      window.dispatchEvent(
        new CustomEvent(PLUGIN_EVENTS.PLUGIN_ENABLED, { detail: { pluginId } })
      );
    } catch (err) {
      entry.status = "error";
      entry.error = String(err);
      this.notify();
      throw err;
    }
  }

  /** Disable a plugin */
  async disablePlugin(pluginId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;

    // Call onDestroy
    if (entry.hooks.onDestroy) {
      await entry.hooks.onDestroy().catch((err) => {
        console.warn(`[Plugin ${pluginId}] onDestroy error:`, err);
      });
    }

    entry.hooks = {};
    entry.status = "disabled";
    this.collectHooks();
    this.notify();

    window.dispatchEvent(
      new CustomEvent(PLUGIN_EVENTS.PLUGIN_DISABLED, { detail: { pluginId } })
    );
  }

  /** Get all plugin statuses */
  getAllPlugins(): PluginInstance[] {
    return Array.from(this.plugins.values());
  }

  getPlugin(pluginId: string): PluginInstance | undefined {
    return this.plugins.get(pluginId);
  }

  /** ── Private methods ── */

  private makeContext(pluginId: string): PluginContext {
    return createPluginContext({
      pluginId,
      getCurrentPdfPath: () => this.currentPdfPath,
      getLlmConfig: () => this.llmConfig,
    });
  }

  /** Dynamically load a plugin module */
  private async loadPluginModule(manifest: PluginManifest): Promise<PluginHooks> {
    // Loading strategy based on plugin entry type
    // 1. If main is a .js file path → dynamic import
    // 2. If main is a sidecar command → call via invoke
    // 3. Inline plugin → return registered hooks directly

    const mainEntry = manifest.entry.main;
    if (!mainEntry) {
      return {}; // Pure UI plugin, no loading logic needed
    }

    // Option A: Inline registration (for demos / builtin plugins)
    if (mainEntry.startsWith("builtin:")) {
      const builtinId = mainEntry.replace("builtin:", "");
      return loadBuiltinPlugin(builtinId);
    }

    // Option B: Dynamically import JS from plugins directory
    // Path format: plugins/ppt-generator/index.js
    // In Vite, the plugin directory must be configured as a dynamically-loadable static asset
    try {
      // Under Tauri, plugin JS is managed via sidecar or resource
      // Simplified here: read via Tauri invoke and eval (sandbox-limited)
      const moduleCode = await invoke<string>("plugin_read_entry", {
        pluginId: manifest.id,
        entryPath: mainEntry,
      });

      // Execute plugin code in a sandbox, passing an exports object
      const exports: { hooks?: PluginHooks } = {};
      const fn = new Function("module", "exports", moduleCode);
      fn({ exports }, exports);
      return exports.hooks ?? {};
    } catch (err) {
      console.warn(`[PluginManager] Failed to load module for ${manifest.id}:`, err);
      return {};
    }
  }

  /** Collect hooks from all enabled plugins */
  private collectHooks() {
    this.contextMenuItems = [];
    this.toolbarButtons = [];
    this.commands = [];

    this.plugins.forEach((plugin) => {
      if (plugin.status !== "enabled") return;

      if (plugin.hooks.contextMenuItems) {
        this.contextMenuItems.push(...plugin.hooks.contextMenuItems());
      }
      if (plugin.hooks.toolbarButtons) {
        this.toolbarButtons.push(...plugin.hooks.toolbarButtons());
      }
      if (plugin.hooks.commands) {
        this.commands.push(...plugin.hooks.commands());
      }
    });
  }
}

/** Singleton */
export const pluginManager = new PluginManagerClass();

// ── Inline builtin plugin registry ──────────────────────────────

type BuiltinLoader = () => PluginHooks;
const builtinRegistry = new Map<string, BuiltinLoader>();

export function registerBuiltinPlugin(name: string, loader: BuiltinLoader) {
  builtinRegistry.set(name, loader);
}

function loadBuiltinPlugin(name: string): PluginHooks {
  const loader = builtinRegistry.get(name);
  if (!loader) throw new Error(`Builtin plugin '${name}' not found`);
  return loader();
}

/** Return all builtin plugin IDs registered via registerBuiltinPlugin */
export function getRegisteredBuiltins(): string[] {
  return Array.from(builtinRegistry.keys());
}

/** Determine if a plugin is a builtin (checks manifest.entry.main starts with "builtin:") */
export function isBuiltinPlugin(pluginId: string): boolean {
  const plugin = pluginManager.getPlugin(pluginId);
  if (!plugin) return false;
  return plugin.manifest.entry.main?.startsWith("builtin:") ?? false;
}
