/**
 * EventBus — structured pub/sub replacing window.CustomEvent for plugins.
 *
 * Features:
 * - Plugin-scoped subscriptions (auto-cleanup via cleanupPlugin)
 * - Dual-dispatch: fires internal callbacks AND window.CustomEvent (transition compat)
 * - Namespaced events: "app:*", "plugin:{id}:*"
 */
import type { EventBus as EventBusInterface, EventHandler } from "./types";

interface HandlerEntry {
  fn: EventHandler;
  pluginId?: string;
}

class EventBusImpl implements EventBusInterface {
  private handlers: Map<string, Set<HandlerEntry>> = new Map();

  on(event: string, handler: EventHandler, pluginId?: string): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    const entry: HandlerEntry = { fn: handler, pluginId };
    this.handlers.get(event)!.add(entry);
    return () => {
      this.handlers.get(event)?.delete(entry);
    };
  }

  off(event: string, handler: EventHandler): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const entry of set) {
      if (entry.fn === handler) {
        set.delete(entry);
        break;
      }
    }
  }

  emit(event: string, payload?: unknown): void {
    const set = this.handlers.get(event);
    if (set) {
      for (const { fn } of set) {
        try {
          fn(payload);
        } catch (e) {
          console.warn(`[EventBus] handler error for "${event}":`, e);
        }
      }
    }
    // Also dispatch via window for backward-compat transition period
    try {
      window.dispatchEvent(new CustomEvent(event, { detail: payload }));
    } catch {
      // SSR or non-browser environment — skip
    }
  }

  emitScoped(scope: string, event: string, payload?: unknown): void {
    this.emit(`${scope}:${event}`, payload);
  }

  /** Remove all handlers registered by a specific plugin */
  cleanupPlugin(pluginId: string): void {
    for (const [, set] of this.handlers) {
      for (const entry of set) {
        if (entry.pluginId === pluginId) {
          set.delete(entry);
        }
      }
    }
  }
}

/** Singleton event bus */
export const eventBus = new EventBusImpl();
