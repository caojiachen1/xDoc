/**
 * PluginManager — Plugin lifecycle management (v2)
 *
 * Responsibilities:
 * 1. Fetch plugin manifest list from the Rust backend
 * 2. Load/unload plugins (main-thread or WebWorker)
 * 3. Collect hooks (context menu, toolbar, commands, panels, etc.)
 * 4. Broadcast lifecycle events via EventBus
 * 5. Manage interceptor pipeline and UI extension registry
 * 6. Persist plugin enabled/disabled state
 * 7. Validate minAppVersion on discovery
 * 8. Sync state changes to active workers
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
import { loadPluginInWorker, activeWorkers, syncAllWorkers } from "./sandbox/worker-host";

type Listener = () => void;

/** Storage key prefix for persisted plugin states */
const PLUGIN_STATE_STORAGE_KEY = "__plugin_manager__";

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

    // Sync state to all active workers
    syncAllWorkers({ currentPdfPath: path });

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
    // Sync state to all active workers
    syncAllWorkers({ llmConfig: config });
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

      // Get current app version for minAppVersion validation
      let appVersion = "0.0.0";
      try {
        appVersion = await invoke<string>("plugin_get_app_version_public");
      } catch {
        console.warn("[PluginManager] Could not determine app version");
      }

      for (const manifest of manifests) {
        // Validate minAppVersion
        if (manifest.minAppVersion && !isVersionSatisfied(appVersion, manifest.minAppVersion)) {
          console.warn(
            `[PluginManager] Plugin '${manifest.id}' requires app version >= ${manifest.minAppVersion}, ` +
            `but current is ${appVersion}. Skipping.`,
          );
          // Still register but mark as error
          this.plugins.set(manifest.id, {
            manifest,
            status: "error",
            hooks: {},
            error: `Requires app version >= ${manifest.minAppVersion} (current: ${appVersion})`,
          });
          continue;
        }

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

      // Restore persisted enabled/disabled states for external plugins
      await this.restorePluginStates();

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

      // Persist state
      await this.savePluginStates();

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

    // Persist state
    await this.savePluginStates();

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

  /** Collect hooks from all enabled plugins (with id-based dedup) */
  private collectHooks() {
    const menuIds = new Set<string>();
    const toolbarIds = new Set<string>();
    const commandIds = new Set<string>();

    this.contextMenuItems = [];
    this.toolbarButtons = [];
    this.commands = [];

    this.plugins.forEach((plugin) => {
      if (plugin.status !== "enabled") return;

      if (plugin.hooks.contextMenuItems) {
        for (const item of plugin.hooks.contextMenuItems()) {
          if (!menuIds.has(item.id)) {
            menuIds.add(item.id);
            this.contextMenuItems.push(item);
          } else {
            console.warn(
              `[PluginManager] Duplicate context menu item '${item.id}' from '${plugin.manifest.id}' ignored`,
            );
          }
        }
      }
      if (plugin.hooks.toolbarButtons) {
        for (const btn of plugin.hooks.toolbarButtons()) {
          if (!toolbarIds.has(btn.id)) {
            toolbarIds.add(btn.id);
            this.toolbarButtons.push(btn);
          } else {
            console.warn(
              `[PluginManager] Duplicate toolbar button '${btn.id}' from '${plugin.manifest.id}' ignored`,
            );
          }
        }
      }
      if (plugin.hooks.commands) {
        for (const cmd of plugin.hooks.commands()) {
          if (!commandIds.has(cmd.id)) {
            commandIds.add(cmd.id);
            this.commands.push(cmd);
          } else {
            console.warn(
              `[PluginManager] Duplicate command '${cmd.id}' from '${plugin.manifest.id}' ignored`,
            );
          }
        }
      }
    });
  }

  // ── Persistence ──

  /** Save enabled/disabled state of external plugins to storage */
  private async savePluginStates(): Promise<void> {
    try {
      const states: Record<string, "enabled" | "disabled"> = {};
      for (const [id, plugin] of this.plugins) {
        if (!plugin.isBuiltin) {
          states[id] = plugin.status === "enabled" ? "enabled" : "disabled";
        }
      }
      await invoke<void>("plugin_storage_set", {
        key: PLUGIN_STATE_STORAGE_KEY,
        value: JSON.stringify(states),
        pluginId: "__plugin_manager__",
      });
    } catch (err) {
      console.warn("[PluginManager] Failed to persist plugin states:", err);
    }
  }

  /** Restore enabled/disabled states from storage and auto-enable external plugins */
  private async restorePluginStates(): Promise<void> {
    try {
      const raw = await invoke<string | null>("plugin_storage_get", {
        key: PLUGIN_STATE_STORAGE_KEY,
        pluginId: "__plugin_manager__",
      });
      if (!raw) return;

      const states = JSON.parse(raw) as Record<string, "enabled" | "disabled">;

      for (const [pluginId, savedStatus] of Object.entries(states)) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin || plugin.isBuiltin) continue;
        if (plugin.status === "error") continue; // Don't re-enable broken plugins

        if (savedStatus === "enabled" && plugin.status === "disabled") {
          try {
            await this.enablePlugin(pluginId);
          } catch (err) {
            console.warn(
              `[PluginManager] Failed to restore plugin '${pluginId}':`,
              err,
            );
          }
        }
      }
    } catch (err) {
      console.warn("[PluginManager] Failed to restore plugin states:", err);
    }
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

// ── Version comparison utility ──

/**
 * Compare two semver strings.
 * Returns: -1 if a < b, 0 if equal, 1 if a > b.
 */
function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Check if currentVersion >= requiredVersion (semver).
 */
function isVersionSatisfied(currentVersion: string, requiredVersion: string): boolean {
  return compareSemver(currentVersion, requiredVersion) >= 0;
}
