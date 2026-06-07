/**
 * PluginManagerDialog — Plugin management UI
 *
 * Displays all discovered plugins (including built-in ones), allows enabling/disabling external plugins.
 * Supports drag-and-drop .zip file import and manual zip file selection.
 * Embedded in the "Plugins" tab of SettingsDialog.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { pluginManager } from "./manager";
import type { PluginInstance } from "./types";

// ── Utility functions ─────────────────────────────────────────────

/** Check if a plugin is a built-in plugin */
function isBuiltin(plugin: PluginInstance): boolean {
  return !!plugin.manifest.entry.main?.startsWith("builtin:");
}

interface PluginManagerProps {
  /** Optional rescan callback */
  onRefresh?: () => void;
}

export default function PluginManagerDialog({ onRefresh }: PluginManagerProps) {
  const [plugins, setPlugins] = useState<PluginInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const dragCounter = useRef(0);

  const refresh = useCallback(() => {
    setPlugins(pluginManager.getAllPlugins());
    setLoading(false);
  }, []);

  // First-time plugin discovery
  useEffect(() => {
    pluginManager.discoverPlugins().then(refresh);
    const unsub = pluginManager.subscribe(refresh);
    return unsub;
  }, [refresh]);

  const handleToggle = async (pluginId: string, currentStatus: string) => {
    setToggling((prev) => new Set(prev).add(pluginId));
    try {
      if (currentStatus === "enabled") {
        await pluginManager.disablePlugin(pluginId);
      } else {
        await pluginManager.enablePlugin(pluginId);
      }
    } catch (err) {
      console.error(`[PluginManager] toggle ${pluginId} failed:`, err);
    } finally {
      setToggling((prev) => {
        const next = new Set(prev);
        next.delete(pluginId);
        return next;
      });
    }
  };

  /** Install a zip plugin and refresh the list */
  const installFromZip = async (zipPath: string) => {
    setImporting(true);
    setImportError(null);
    try {
      await invoke("plugin_install_from_zip", { zipPath });
      // Rescan plugin directory
      setLoading(true);
      await pluginManager.discoverPlugins();
      refresh();
      onRefresh?.();
    } catch (err) {
      console.error("[PluginManager] install from zip failed:", err);
      setImportError(String(err));
    } finally {
      setImporting(false);
    }
  };

  /** Manual import button: open file picker dialog */
  const handleManualImport = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "插件包", extensions: ["zip"] }],
      });
      if (selected) {
        await installFromZip(selected as string);
      }
    } catch (err) {
      console.error("[PluginManager] manual import failed:", err);
      setImportError(String(err));
    }
  };

  // ── Drag & drop event handling ──────────────────────────────────────────

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (e.dataTransfer?.types.includes("Files")) {
      setDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) {
      setDragOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    dragCounter.current = 0;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const zipFile = Array.from(files).find((f) => f.name.endsWith(".zip"));
    if (!zipFile) {
      setImportError("请拖入 .zip 格式的插件包文件");
      return;
    }

    // Get path from dropped file (file.path is available under Tauri webview)
    const filePath = (zipFile as File & { path?: string }).path;
    if (!filePath) {
      setImportError("无法获取拖文件的路径，请使用手动导入按钮");
      return;
    }

    await installFromZip(filePath);
  };

  if (loading) {
    return (
      <div style={{ padding: 16, textAlign: "center", opacity: 0.5, color: "#aaa" }}>
        正在扫描插件...
      </div>
    );
  }

  // Group: built-in plugins / external plugins
  const builtinPlugins = plugins.filter(isBuiltin);
  const externalPlugins = plugins.filter((p) => !isBuiltin(p));

  return (
    <div className="plugin-manager">
      {/* ── Header: title + actions ───────────────────────────────── */}
      <div className="plugin-manager-header">
        <h3 style={{ margin: 0 }}>插件管理</h3>
        <div className="plugin-header-actions">
          <button
            className="home-toolbar-btn plugin-import-btn"
            onClick={handleManualImport}
            disabled={importing}
            title="选择 .zip 插件包导入"
          >
            {importing ? "导入中..." : "导入插件"}
          </button>
          <button
            className="home-toolbar-btn"
            onClick={async () => {
              setLoading(true);
              await pluginManager.discoverPlugins();
              refresh();
              onRefresh?.();
            }}
            title="重新扫描插件目录"
          >
            刷新
          </button>
        </div>
      </div>

      {/* ── Error message ──────────────────────────────────────────── */}
      {importError && (
        <div className="plugin-import-error">
          <span>导入失败：{importError}</span>
          <button
            className="plugin-import-error-close"
            onClick={() => setImportError(null)}
            title="关闭"
          >
            ×
          </button>
        </div>
      )}

      {/* ── Drop zone ──────────────────────────────────────────── */}
      <div
        className={`plugin-dropzone${dragOver ? " plugin-dropzone-active" : ""}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div className="plugin-dropzone-inner">
          {importing ? (
            <>
              <span className="plugin-dropzone-icon">⏳</span>
              <span className="plugin-dropzone-text">正在安装插件...</span>
            </>
          ) : dragOver ? (
            <>
              <span className="plugin-dropzone-icon">📦</span>
              <span className="plugin-dropzone-text plugin-dropzone-text-active">
                松开以安装插件
              </span>
            </>
          ) : (
            <>
              <span className="plugin-dropzone-icon">📁</span>
              <span className="plugin-dropzone-text">
                将 <code>.zip</code> 插件包拖到此处安装
              </span>
              <span className="plugin-dropzone-hint">
                或点击上方"导入插件"按钮选择文件
              </span>
            </>
          )}
        </div>
      </div>

      {/* ── Plugin list ─────────────────────────────────────────── */}
      {plugins.length === 0 ? (
        <div style={{ textAlign: "center", padding: 32, opacity: 0.4, color: "#aaa" }}>
          <p>暂无插件</p>
          <p style={{ fontSize: 13 }}>
            将插件目录放在应用数据目录下的 plugins/ 中，
            <br />
            或拖拽 / 导入 .zip 插件包
          </p>
        </div>
      ) : (
        <div className="plugin-list">
          {/* ── Built-in plugins ──────────────────────────────────────── */}
          {builtinPlugins.length > 0 && (
            <div className="plugin-section">
              <div className="plugin-section-title">内置插件</div>
              {builtinPlugins.map((plugin) => (
                <PluginCard
                  key={plugin.manifest.id}
                  plugin={plugin}
                  isBuiltinPlugin={true}
                  toggling={toggling.has(plugin.manifest.id)}
                  onToggle={() => {}}
                />
              ))}
            </div>
          )}

          {/* ── External plugins ──────────────────────────────────────── */}
          {externalPlugins.length > 0 && (
            <div className="plugin-section">
              {builtinPlugins.length > 0 && (
                <div className="plugin-section-title">外部插件</div>
              )}
              {externalPlugins.map((plugin) => (
                <PluginCard
                  key={plugin.manifest.id}
                  plugin={plugin}
                  isBuiltinPlugin={false}
                  toggling={toggling.has(plugin.manifest.id)}
                  onToggle={() =>
                    handleToggle(plugin.manifest.id, plugin.status)
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}

      <style>{`
        .plugin-manager {
          padding: 8px 0;
          color: #e0e0e0;
        }

        /* ── Header bar ── */
        .plugin-manager-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
          color: #f3f3f3;
        }
        .plugin-header-actions {
          display: flex;
          gap: 8px;
        }
        .plugin-import-btn {
          font-weight: 500;
        }

        /* ── Error state ── */
        .plugin-import-error {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 8px 12px;
          margin-bottom: 10px;
          font-size: 12px;
          color: #ff6b6b;
          background: rgba(255, 80, 80, 0.12);
          border: 1px solid rgba(255, 80, 80, 0.25);
          border-radius: 6px;
          word-break: break-all;
        }
        .plugin-import-error-close {
          flex-shrink: 0;
          border: none;
          background: transparent;
          color: #ff6b6b;
          cursor: pointer;
          font-size: 16px;
          line-height: 1;
          padding: 0 2px;
          opacity: 0.6;
        }
        .plugin-import-error-close:hover {
          opacity: 1;
        }

        /* ── Drop zone ── */
        .plugin-dropzone {
          border: 2px dashed rgba(255, 255, 255, 0.15);
          border-radius: 8px;
          margin-bottom: 14px;
          padding: 18px 12px;
          text-align: center;
          transition: border-color 0.2s, background 0.2s;
          cursor: default;
          user-select: none;
        }
        .plugin-dropzone:hover {
          border-color: rgba(255, 255, 255, 0.25);
          background: rgba(255, 255, 255, 0.04);
        }
        .plugin-dropzone-active {
          border-color: rgba(255, 255, 255, 0.4) !important;
          border-width: 2px;
          background: rgba(255, 255, 255, 0.08) !important;
        }
        .plugin-dropzone-inner {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
        }
        .plugin-dropzone-icon {
          font-size: 22px;
          line-height: 1;
          margin-bottom: 2px;
        }
        .plugin-dropzone-text {
          font-size: 13px;
          color: #aaa;
        }
        .plugin-dropzone-text-active {
          color: #ddd;
          font-weight: 600;
        }
        .plugin-dropzone-hint {
          font-size: 11px;
          color: #666;
          margin-top: 2px;
        }
        .plugin-dropzone code {
          background: rgba(255, 255, 255, 0.08);
          padding: 1px 5px;
          border-radius: 3px;
          font-size: 12px;
          color: #ccc;
        }

        /* ── Plugin list / sections ── */
        .plugin-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .plugin-section {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .plugin-section-title {
          font-size: 11px;
          font-weight: 600;
          color: #888;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-top: 4px;
          margin-bottom: -2px;
          padding-left: 2px;
        }

        /* ── Plugin card ── */
        .plugin-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 6px;
          background: #2a2a2a;
        }
        .plugin-item.plugin-enabled {
          border-color: rgba(255, 255, 255, 0.15);
          background: #333;
        }
        .plugin-item.plugin-error {
          border-color: rgba(255, 80, 80, 0.4);
          background: rgba(255, 50, 50, 0.08);
        }
        .plugin-item.plugin-builtin {
          border-color: rgba(255, 255, 255, 0.12);
          background: #333;
        }
        .plugin-info {
          flex: 1;
          min-width: 0;
        }
        .plugin-name {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 4px;
          flex-wrap: wrap;
        }
        .plugin-name strong {
          color: #eee;
        }
        .plugin-version {
          font-size: 12px;
          color: #888;
        }
        .plugin-author {
          font-size: 12px;
          color: #777;
        }
        .plugin-desc {
          font-size: 13px;
          color: #aaa;
          margin-bottom: 4px;
        }
        .plugin-error {
          font-size: 12px;
          color: #ff6b6b;
          margin-bottom: 2px;
        }
        .plugin-permissions {
          font-size: 11px;
          color: #888;
        }
        .plugin-permissions-list {
          display: inline-flex;
          flex-wrap: wrap;
          gap: 4px;
          margin-left: 4px;
        }
        .plugin-perm-tag {
          display: inline-block;
          padding: 1px 6px;
          font-size: 11px;
          color: #aaa;
          background: rgba(255, 255, 255, 0.06);
          border-radius: 3px;
          border: 1px solid rgba(255, 255, 255, 0.08);
        }

        /* ── Built-in badge ── */
        .plugin-badge-builtin {
          display: inline-block;
          padding: 1px 7px;
          font-size: 11px;
          font-weight: 600;
          color: #fff;
          background: #666;
          border-radius: 4px;
          line-height: 1.6;
          vertical-align: middle;
          letter-spacing: 0.02em;
        }

        /* ── Toggle / actions ── */
        .plugin-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-left: 16px;
          flex-shrink: 0;
        }
        .plugin-status-label {
          font-size: 12px;
          min-width: 48px;
          text-align: right;
        }
        .plugin-switch {
          position: relative;
          display: inline-block;
          width: 40px;
          height: 22px;
        }
        .plugin-switch input {
          opacity: 0;
          width: 0;
          height: 0;
        }
        .plugin-switch-slider {
          position: absolute;
          cursor: pointer;
          top: 0; left: 0; right: 0; bottom: 0;
          background: #555;
          border-radius: 22px;
          transition: 0.3s;
        }
        .plugin-switch-slider::before {
          content: "";
          position: absolute;
          height: 16px; width: 16px;
          left: 3px; bottom: 3px;
          background: #ccc;
          border-radius: 50%;
          transition: 0.3s;
        }
        .plugin-switch input:checked + .plugin-switch-slider {
          background: #4caf50;
        }
        .plugin-switch input:checked + .plugin-switch-slider::before {
          transform: translateX(18px);
          background: white;
        }
        .plugin-switch input:disabled + .plugin-switch-slider {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}

// ── Plugin card sub-component ─────────────────────────────────────────

interface PluginCardProps {
  plugin: PluginInstance;
  isBuiltinPlugin: boolean;
  toggling: boolean;
  onToggle: () => void;
}

function PluginCard({ plugin, isBuiltinPlugin, toggling, onToggle }: PluginCardProps) {
  const itemClass = [
    "plugin-item",
    isBuiltinPlugin ? "plugin-builtin" : `plugin-${plugin.status}`,
  ].join(" ");

  return (
    <div className={itemClass}>
      <div className="plugin-info">
        {/* Name row */}
        <div className="plugin-name">
          <strong>{plugin.manifest.name}</strong>
          <span className="plugin-version">v{plugin.manifest.version}</span>
          {isBuiltinPlugin && <span className="plugin-badge-builtin">内置</span>}
          {plugin.manifest.author && (
            <span className="plugin-author">by {plugin.manifest.author}</span>
          )}
        </div>

        {/* Description */}
        {plugin.manifest.description && (
          <div className="plugin-desc">{plugin.manifest.description}</div>
        )}

        {/* Error */}
        {plugin.error && <div className="plugin-error">错误: {plugin.error}</div>}

        {/* Permissions */}
        {plugin.manifest.permissions.length > 0 && (
          <div className="plugin-permissions">
            权限:
            <span className="plugin-permissions-list">
              {plugin.manifest.permissions.map((perm) => (
                <span key={perm} className="plugin-perm-tag">
                  {perm}
                </span>
              ))}
            </span>
          </div>
        )}
      </div>

      {/* Right actions */}
      <div className="plugin-actions">
        {isBuiltinPlugin ? (
          /* Built-in: toggle always on and disabled */
          <>  
            <label className="plugin-switch">
              <input type="checkbox" checked disabled />
              <span className="plugin-switch-slider" />
            </label>
            <span className="plugin-status-label" style={{ color: "#aaa" }}>
              已启用
            </span>
          </>
        ) : (
          /* External: toggle can be switched */
          <>  
            <label className="plugin-switch">
              <input
                type="checkbox"
                checked={plugin.status === "enabled"}
                disabled={toggling}
                onChange={onToggle}
              />
              <span className="plugin-switch-slider" />
            </label>
            <span
              className="plugin-status-label"
              style={{
                color:
                  plugin.status === "enabled"
                    ? "#8bc34a"
                    : plugin.status === "error"
                      ? "#ff6b6b"
                      : "#777",
              }}
            >
              {toggling
                ? "切换中..."
                : plugin.status === "enabled"
                  ? "已启用"
                  : plugin.status === "error"
                    ? "错误"
                    : "已禁用"}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
