/**
 * PluginManager — Plugin lifecycle management (v2)
 *
 * Responsibilities:
 * 1. Fetch plugin manifest list from the Rust backend
 * 2. Load/unload plugins (main-thread or WebWorker)
 * 3. Collect hooks (context menu, toolbar, commands, panels, etc.)
 * 4. Broadcast lifecycle events via EventBus
 * 5. Manage interceptor pipeline and UI extension registry
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
  type LlmConfigSnapshot,
  PLUGIN_EVENTS,
} from "./types";
import { createPluginContext, setInterceptorRunner, setUIRegistry } from "./context";
import { eventBus } from "./event-bus";
import { interceptorPipeline, setManagerRef } from "./interceptors";
import { uiRegistry } from "./ui-extensions";
import { loadPluginInWorker, activeWorkers } from "./sandbox/worker-host";

type Listener = () => void;

class PluginManagerClass {
  /** All discovered plugins */
  private plugins: Map<string, PluginInstance> = new Map();
  /** State change listeners */
  private listeners: Set<Listener> = new Set();

  /** Current PDF state (updated by App.tsx) */
  private currentPdfPath: string | null = null;
  private llmConfig: LlmConfigSnapshot | null = null;

  /** Collected hooks (consumed by components) */
  contextMenuItems: PluginContextMenuItem[] = [];
  toolbarButtons: PluginToolbarButton[] = [];
  commands: PluginCommand[] = [];

  constructor() {
    // Wire up interceptor runner so context.ts can use it
    setInterceptorRunner({
      runBefore: (hook, pluginId, data) =>
        interceptorPipeline.runBefore(hook, pluginId, data),
      runAfter: (hook, pluginId, data) =>
        interceptorPipeline.runAfter(hook, pluginId, data),
    });

    // Inject manager reference into interceptors (avoids circular import)
    setManagerRef({
      getAllPlugins: () => this.getAllPlugins(),
      makeContextFor: (pluginId: string) => this.makeContextFor(pluginId),
    });

    // Wire up UI registry so context.ts can use it
    setUIRegistry({
      registerPanel: (pluginId, config) => uiRegistry.registerPanel(pluginId, config),
      registerSidebar: (pluginId, config) => uiRegistry.registerSidebar(pluginId, config),
      registerFloatingWindow: (pluginId, config) =>
        uiRegistry.registerFloatingWindow(pluginId, config),
    });
  }

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
    const wasPath = this.currentPdfPath;
    this.currentPdfPath = path;

    if (path && !wasPath) {
      // PDF opened
      const paper = { id: "", name: "", path };
      this.plugins.forEach((plugin) => {
        if (plugin.status === "enabled" && plugin.hooks.onPdfOpened) {
          const ctx = this.makeContextFor(plugin.manifest.id);
          plugin.hooks.onPdfOpened(ctx, paper).catch((err) => {
            console.warn(`[Plugin ${plugin.manifest.id}] onPdfOpened error:`, err);
          });
        }
      });
      eventBus.emit(PLUGIN_EVENTS.PDF_OPENED, paper);
    } else if (!path && wasPath) {
      // PDF closed
      this.plugins.forEach((plugin) => {
        if (plugin.status === "enabled" && plugin.hooks.onPdfClosed) {
          const ctx = this.makeContextFor(plugin.manifest.id);
          plugin.hooks.onPdfClosed(ctx).catch((err) => {
            console.warn(`[Plugin ${plugin.manifest.id}] onPdfClosed error:`, err);
          });
        }
      });
      eventBus.emit(PLUGIN_EVENTS.PDF_CLOSED);
    } else if (path && wasPath && path !== wasPath) {
      // PDF switched
      const paper = { id: "", name: "", path };
      this.plugins.forEach((plugin) => {
        if (plugin.status === "enabled" && plugin.hooks.onPdfOpened) {
          const ctx = this.makeContextFor(plugin.manifest.id);
          plugin.hooks.onPdfOpened(ctx, paper).catch(console.warn);
        }
      });
      eventBus.emit(PLUGIN_EVENTS.PDF_OPENED, paper);
    }
  }

  /** Called by App.tsx when the full text is ready */
  async notifyPdfTextReady(fullText: string) {
    this.plugins.forEach((plugin) => {
      if (plugin.status === "enabled" && plugin.hooks.onPdfTextReady) {
        const ctx = this.makeContextFor(plugin.manifest.id);
        plugin.hooks.onPdfTextReady(ctx, fullText).catch((err) => {
          console.warn(`[Plugin ${plugin.manifest.id}] onPdfTextReady error:`, err);
        });
      }
    });
    eventBus.emit(PLUGIN_EVENTS.PDF_TEXT_READY, fullText);
  }

  /** Set LLM config (updated when SettingsDialog saves) */
  setLlmConfig(config: LlmConfigSnapshot | null) {
    this.llmConfig = config;
  }

  /** Get a snapshot of the LLM config */
  getLlmConfigSnapshot(): LlmConfigSnapshot | null {
    return this.llmConfig;
  }

  /** Register a builtin plugin manifest */
  registerBuiltinManifest(manifest: PluginManifest): void {
    if (!this.plugins.has(manifest.id)) {
      this.plugins.set(manifest.id, {
        manifest,
        status: "disabled",
        hooks: {},
        isBuiltin: true,
      });
      // Tell Rust side this is builtin (for permission bypass)
      invoke("plugin_register_builtin", { pluginId: manifest.id }).catch(() => {});
      this.notify();
    }
  }

  // ── Core: discover and load plugins ──

  async discoverPlugins(): Promise<PluginManifest[]> {
    try {
      const manifests = await invoke<PluginManifest[]>("plugin_list");
      for (const manifest of manifests) {
        if (!this.plugins.has(manifest.id)) {
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
            console.warn(
              `[PluginManager] Failed to auto-enable builtin plugin '${pluginId}':`,
              err,
            );
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
      const hooks = await this.loadPluginModule(entry.manifest);
      entry.hooks = hooks;
      entry.status = "enabled";
      entry.error = undefined;

      // Call onActivate (preferred) or onInit (deprecated compat)
      if (hooks.onActivate) {
        const ctx = this.makeContextFor(pluginId);
        const moreHooks = await hooks.onActivate(ctx);
        if (moreHooks) {
          entry.hooks = { ...entry.hooks, ...moreHooks };
        }
      } else if (hooks.onInit) {
        const ctx = this.makeContextFor(pluginId);
        const moreHooks = await hooks.onInit(ctx);
        if (moreHooks) {
          entry.hooks = { ...entry.hooks, ...moreHooks };
        }
      }

      // Collect UI extension registrations
      this.collectUIExtensions(pluginId, entry.hooks);

      // Re-collect hooks
      this.collectHooks();
      this.notify();

      eventBus.emit(PLUGIN_EVENTS.PLUGIN_ENABLED, { pluginId });
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

    // Call onDeactivate (preferred) or onDestroy (deprecated compat)
    if (entry.hooks.onDeactivate) {
      await entry.hooks.onDeactivate().catch((err) => {
        console.warn(`[Plugin ${pluginId}] onDeactivate error:`, err);
      });
    } else if (entry.hooks.onDestroy) {
      await entry.hooks.onDestroy().catch((err) => {
        console.warn(`[Plugin ${pluginId}] onDestroy error:`, err);
      });
    }

    // Terminate Worker if active
    const workerHost = activeWorkers.get(pluginId);
    if (workerHost) {
      workerHost.cleanup();
    }

    // Cleanup event bus subscriptions
    eventBus.cleanupPlugin(pluginId);

    // Cleanup UI extensions
    uiRegistry.cleanupPlugin(pluginId);

    entry.hooks = {};
    entry.status = "disabled";
    this.collectHooks();
    this.notify();

    eventBus.emit(PLUGIN_EVENTS.PLUGIN_DISABLED, { pluginId });
  }

  /** Get all plugin statuses */
  getAllPlugins(): PluginInstance[] {
    return Array.from(this.plugins.values());
  }

  getPlugin(pluginId: string): PluginInstance | undefined {
    return this.plugins.get(pluginId);
  }

  // ── Lifecycle notification methods ──

  async notifyAppReady() {
    for (const [, plugin] of this.plugins) {
      if (plugin.status === "enabled" && plugin.hooks.onAppReady) {
        const ctx = this.makeContextFor(plugin.manifest.id);
        await plugin.hooks.onAppReady(ctx).catch(console.warn);
      }
    }
    eventBus.emit(PLUGIN_EVENTS.APP_READY);
  }

  async notifySettingsChanged(key: string, value: unknown) {
    for (const [, plugin] of this.plugins) {
      if (plugin.status === "enabled" && plugin.hooks.onSettingsChanged) {
        const ctx = this.makeContextFor(plugin.manifest.id);
        await plugin.hooks.onSettingsChanged(ctx, key, value).catch(console.warn);
      }
    }
    eventBus.emit(PLUGIN_EVENTS.SETTINGS_CHANGED, { key, value });
  }

  async notifyBeforeUnload() {
    for (const [, plugin] of this.plugins) {
      if (plugin.status === "enabled" && plugin.hooks.onBeforeUnload) {
        const ctx = this.makeContextFor(plugin.manifest.id);
        await plugin.hooks.onBeforeUnload(ctx).catch(console.warn);
      }
    }
    eventBus.emit(PLUGIN_EVENTS.BEFORE_UNLOAD);
  }

  // ── Public: create context for a plugin (used by interceptors) ──

  makeContextFor(pluginId: string): PluginContext {
    return createPluginContext({
      pluginId,
      getCurrentPdfPath: () => this.currentPdfPath,
      getLlmConfig: () => this.llmConfig,
    });
  }

  // ── Private methods ──

  /** Dynamically load a plugin module */
  private async loadPluginModule(manifest: PluginManifest): Promise<PluginHooks> {
    const mainEntry = manifest.entry.main;
    if (!mainEntry) {
      return {}; // Pure UI plugin
    }

    // Builtin: main-thread execution
    if (mainEntry.startsWith("builtin:")) {
      const builtinId = mainEntry.replace("builtin:", "");
      return loadBuiltinPlugin(builtinId);
    }

    // External plugin: WebWorker sandbox
    try {
      const moduleCode = await invoke<string>("plugin_read_entry", {
        pluginId: manifest.id,
        entryPath: mainEntry,
      });

      const hooks = await loadPluginInWorker(manifest.id, moduleCode, {
        pluginId: manifest.id,
        getCurrentPdfPath: () => this.currentPdfPath,
        getLlmConfig: () => this.llmConfig,
      });

      return hooks;
    } catch (err) {
      console.warn(
        `[PluginManager] Failed to load module for ${manifest.id}:`,
        err,
      );
      return {};
    }
  }

  /** Collect UI extension registrations from hooks */
  private collectUIExtensions(pluginId: string, hooks: PluginHooks) {
    if (hooks.panels) {
      for (const panel of hooks.panels()) {
        uiRegistry.registerPanel(pluginId, panel);
      }
    }
    if (hooks.sidebars) {
      for (const sidebar of hooks.sidebars()) {
        uiRegistry.registerSidebar(pluginId, sidebar);
      }
    }
    if (hooks.floatingWindows) {
      for (const fw of hooks.floatingWindows()) {
        uiRegistry.registerFloatingWindow(pluginId, fw);
      }
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

// ── Inline builtin plugin registry ──

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

/** Return all builtin plugin IDs */
export function getRegisteredBuiltins(): string[] {
  return Array.from(builtinRegistry.keys());
}

/** Check if a plugin is builtin */
export function isBuiltinPlugin(pluginId: string): boolean {
  const plugin = pluginManager.getPlugin(pluginId);
  if (!plugin) return false;
  return plugin.manifest.entry.main?.startsWith("builtin:") ?? false;
}
