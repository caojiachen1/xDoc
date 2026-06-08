/**
 * UIExtensionRegistry — manages plugin-registered panels, sidebars, and floating windows.
 */
import type {
  PanelRegistration,
  SidebarRegistration,
  FloatingWindowRegistration,
} from "./types";

// ── State types (internal) ────────────────────────────────────────

export interface PanelState {
  id: string;
  pluginId: string;
  title: string;
  icon?: string;
  position: "bottom" | "right";
  visible: boolean;
  /** HTML content for iframe rendering (worker plugins) */
  html?: string;
  cleanup?: () => void;
  render?: (container: HTMLElement) => void | (() => void);
  onShow?: () => void;
  onHide?: () => void;
  onResize?: (size: { width: number; height: number }) => void;
}

export interface SidebarState {
  id: string;
  pluginId: string;
  title: string;
  icon?: string;
  side: "left" | "right";
  width: number;
  visible: boolean;
  /** HTML content for iframe rendering (worker plugins) */
  html?: string;
  cleanup?: () => void;
  render?: (container: HTMLElement) => void | (() => void);
}

export interface FloatingWindowState {
  id: string;
  pluginId: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  draggable: boolean;
  resizable: boolean;
  visible: boolean;
  /** HTML content for iframe rendering (worker plugins) */
  html?: string;
  cleanup?: () => void;
  render?: (container: HTMLElement) => void | (() => void);
}

// ── Registry ───────────────────────────────────────────────────────

type Listener = () => void;

class UIExtensionRegistry {
  panels: Map<string, PanelState> = new Map();
  sidebars: Map<string, SidebarState> = new Map();
  floatingWindows: Map<string, FloatingWindowState> = new Map();

  private listeners: Set<Listener> = new Set();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((fn) => fn());
  }

  registerPanel(pluginId: string, config: PanelRegistration) {
    const id = `${pluginId}:${config.id}`;
    this.panels.set(id, {
      id,
      pluginId,
      title: config.title,
      icon: config.icon,
      position: config.position ?? "bottom",
      visible: false,
      html: config.html,
      render: config.render,
      onShow: config.onShow,
      onHide: config.onHide,
      onResize: config.onResize,
    });
    this.notify();
  }

  registerSidebar(pluginId: string, config: SidebarRegistration) {
    const id = `${pluginId}:${config.id}`;
    this.sidebars.set(id, {
      id,
      pluginId,
      title: config.title,
      icon: config.icon,
      side: config.side ?? "right",
      width: config.width ?? 300,
      visible: false,
      html: config.html,
      render: config.render,
    });
    this.notify();
  }

  registerFloatingWindow(pluginId: string, config: FloatingWindowRegistration) {
    const id = `${pluginId}:${config.id}`;
    this.floatingWindows.set(id, {
      id,
      pluginId,
      title: config.title,
      x: config.x ?? 100,
      y: config.y ?? 100,
      width: config.width ?? 400,
      height: config.height ?? 300,
      draggable: config.draggable ?? true,
      resizable: config.resizable ?? true,
      visible: false,
      html: config.html,
      render: config.render,
    });
    this.notify();
  }

  togglePanel(id: string) {
    const panel = this.panels.get(id);
    if (panel) {
      panel.visible = !panel.visible;
      if (panel.visible) panel.onShow?.();
      else panel.onHide?.();
      this.notify();
    }
  }

  toggleSidebar(id: string) {
    const sidebar = this.sidebars.get(id);
    if (sidebar) {
      sidebar.visible = !sidebar.visible;
      this.notify();
    }
  }

  toggleFloatingWindow(id: string) {
    const fw = this.floatingWindows.get(id);
    if (fw) {
      fw.visible = !fw.visible;
      this.notify();
    }
  }

  /** Remove all UI extensions registered by a specific plugin */
  cleanupPlugin(pluginId: string) {
    for (const [id, panel] of this.panels) {
      if (panel.pluginId === pluginId) {
        panel.cleanup?.();
        this.panels.delete(id);
      }
    }
    for (const [id, sidebar] of this.sidebars) {
      if (sidebar.pluginId === pluginId) {
        sidebar.cleanup?.();
        this.sidebars.delete(id);
      }
    }
    for (const [id, fw] of this.floatingWindows) {
      if (fw.pluginId === pluginId) {
        fw.cleanup?.();
        this.floatingWindows.delete(id);
      }
    }
    this.notify();
  }
}

/** Singleton registry */
export const uiRegistry = new UIExtensionRegistry();
