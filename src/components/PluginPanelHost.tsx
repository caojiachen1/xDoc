/**
 * PluginPanelHost — renders plugin-registered panels, sidebars, and floating windows.
 *
 * Each extension gets a container div; the plugin's render() function is called
 * with that container, and may return a cleanup function.
 */
import { useEffect, useRef, useState } from "react";
import { uiRegistry } from "../plugin/ui-extensions";

// ── Panel Host ────────────────────────────────────────────────────

export function PluginPanelHost() {
  const [, forceUpdate] = useState(0);
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const cleanupRefs = useRef<Map<string, () => void>>(new Map());

  useEffect(() => {
    const unsub = uiRegistry.subscribe(() => forceUpdate((n) => n + 1));
    return unsub;
  }, []);

  const visiblePanels = Array.from(uiRegistry.panels.values()).filter((p) => p.visible);

  if (visiblePanels.length === 0) return null;

  return (
    <div className="plugin-panels-host">
      {visiblePanels.map((panel) => (
        <div key={panel.id} className="plugin-panel-host">
          <div className="plugin-panel-host-header">
            <span className="plugin-panel-host-title">{panel.title}</span>
            <button
              className="plugin-panel-host-close"
              onClick={() => uiRegistry.togglePanel(panel.id)}
              title="关闭"
            >
              ×
            </button>
          </div>
          <div
            className="plugin-panel-host-content"
            ref={(el) => {
              if (el && !containerRefs.current.has(panel.id)) {
                containerRefs.current.set(panel.id, el);
                try {
                  const cleanup = panel.render(el);
                  if (cleanup) {
                    cleanupRefs.current.set(panel.id, cleanup);
                    panel.cleanup = cleanup;
                  }
                } catch (err) {
                  console.warn(`[PluginPanelHost] render error for ${panel.id}:`, err);
                }
              }
            }}
          />
        </div>
      ))}
      <style>{`
        .plugin-panels-host {
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          background: #1e1e1e;
        }
        .plugin-panel-host {
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        .plugin-panel-host-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 6px 12px;
          background: rgba(255, 255, 255, 0.03);
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        .plugin-panel-host-title {
          font-size: 12px;
          font-weight: 600;
          color: #aaa;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .plugin-panel-host-close {
          border: none;
          background: transparent;
          color: #888;
          cursor: pointer;
          font-size: 16px;
          padding: 0 4px;
          line-height: 1;
        }
        .plugin-panel-host-close:hover {
          color: #fff;
        }
        .plugin-panel-host-content {
          padding: 8px 12px;
          min-height: 60px;
          max-height: 300px;
          overflow-y: auto;
          color: #ddd;
          font-size: 13px;
        }
      `}</style>
    </div>
  );
}

// ── Sidebar Host ──────────────────────────────────────────────────

export function PluginSidebarHost() {
  const [, forceUpdate] = useState(0);
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    const unsub = uiRegistry.subscribe(() => forceUpdate((n) => n + 1));
    return unsub;
  }, []);

  const visibleSidebars = Array.from(uiRegistry.sidebars.values()).filter(
    (s) => s.visible,
  );

  if (visibleSidebars.length === 0) return null;

  return (
    <div className="plugin-sidebars-host">
      {visibleSidebars.map((sidebar) => (
        <div key={sidebar.id} className="plugin-sidebar-host" style={{ width: sidebar.width }}>
          <div className="plugin-sidebar-host-header">
            <span>{sidebar.title}</span>
            <button
              onClick={() => uiRegistry.toggleSidebar(sidebar.id)}
              title="关闭"
            >
              ×
            </button>
          </div>
          <div
            className="plugin-sidebar-host-content"
            ref={(el) => {
              if (el && !containerRefs.current.has(sidebar.id)) {
                containerRefs.current.set(sidebar.id, el);
                try {
                  const cleanup = sidebar.render(el);
                  if (cleanup) sidebar.cleanup = cleanup;
                } catch (err) {
                  console.warn(`[PluginSidebarHost] render error:`, err);
                }
              }
            }}
          />
        </div>
      ))}
      <style>{`
        .plugin-sidebars-host {
          display: flex;
          flex-direction: column;
          border-left: 1px solid rgba(255, 255, 255, 0.08);
          background: #1e1e1e;
        }
        .plugin-sidebar-host {
          display: flex;
          flex-direction: column;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        .plugin-sidebar-host-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          background: rgba(255, 255, 255, 0.03);
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          font-size: 12px;
          font-weight: 600;
          color: #aaa;
        }
        .plugin-sidebar-host-header button {
          border: none;
          background: transparent;
          color: #888;
          cursor: pointer;
          font-size: 16px;
        }
        .plugin-sidebar-host-content {
          padding: 8px 12px;
          flex: 1;
          overflow-y: auto;
          color: #ddd;
          font-size: 13px;
        }
      `}</style>
    </div>
  );
}

// ── Floating Window Host ──────────────────────────────────────────

export function PluginFloatingWindowHost() {
  const [, forceUpdate] = useState(0);
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    const unsub = uiRegistry.subscribe(() => forceUpdate((n) => n + 1));
    return unsub;
  }, []);

  const visibleWindows = Array.from(uiRegistry.floatingWindows.values()).filter(
    (fw) => fw.visible,
  );

  if (visibleWindows.length === 0) return null;

  return (
    <>
      {visibleWindows.map((fw) => (
        <div
          key={fw.id}
          className="plugin-floating-window"
          style={{
            left: fw.x,
            top: fw.y,
            width: fw.width,
            height: fw.height,
          }}
        >
          <div className="plugin-floating-window-header">
            <span>{fw.title}</span>
            <button
              onClick={() => uiRegistry.toggleFloatingWindow(fw.id)}
              title="关闭"
            >
              ×
            </button>
          </div>
          <div
            className="plugin-floating-window-content"
            ref={(el) => {
              if (el && !containerRefs.current.has(fw.id)) {
                containerRefs.current.set(fw.id, el);
                try {
                  const cleanup = fw.render(el);
                  if (cleanup) fw.cleanup = cleanup;
                } catch (err) {
                  console.warn(`[PluginFloatingWindowHost] render error:`, err);
                }
              }
            }}
          />
        </div>
      ))}
      <style>{`
        .plugin-floating-window {
          position: fixed;
          z-index: 9000;
          background: #2a2a2a;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 8px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .plugin-floating-window-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          background: rgba(255, 255, 255, 0.04);
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          font-size: 13px;
          font-weight: 600;
          color: #ddd;
          cursor: move;
        }
        .plugin-floating-window-header button {
          border: none;
          background: transparent;
          color: #888;
          cursor: pointer;
          font-size: 16px;
        }
        .plugin-floating-window-header button:hover {
          color: #fff;
        }
        .plugin-floating-window-content {
          flex: 1;
          padding: 8px 12px;
          overflow-y: auto;
          color: #ddd;
          font-size: 13px;
        }
      `}</style>
    </>
  );
}
