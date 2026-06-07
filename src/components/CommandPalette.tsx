/**
 * CommandPalette — Ctrl+K command palette (dark theme)
 *
 * Collects commands from the app and plugins, provides fuzzy search
 * and keyboard navigation.
 */
import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { pluginManager } from "../plugin/manager";
import { createPluginContext } from "../plugin/context";
import { uiRegistry } from "../plugin/ui-extensions";

interface CommandEntry {
  id: string;
  label: string;
  shortcut?: string;
  source: "app" | "plugin";
  pluginId?: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Current PDF path (may be empty on home page) */
  currentPdfPath?: string | null;
  /** Extra app-level commands */
  appCommands?: CommandEntry[];
}

export default function CommandPalette({ open, onClose, currentPdfPath, appCommands = [] }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Collect all commands
  const allCommands = useMemo(() => {
    const cmds: CommandEntry[] = [...appCommands];

    // Plugin-registered panels (toggle commands)
    for (const [id, panel] of uiRegistry.panels) {
      cmds.push({
        id: `ui:toggle-panel:${id}`,
        label: `切换面板: ${panel.title}`,
        source: "plugin",
        pluginId: panel.pluginId,
        action: () => uiRegistry.togglePanel(id),
      });
    }

    // Plugin commands
    pluginManager.commands.forEach((cmd) => {
      cmds.push({
        id: cmd.id,
        label: cmd.label,
        shortcut: cmd.shortcut,
        source: "plugin",
        action: () => {
          const pluginId = cmd.id.split(":")[0] ?? "unknown";
          const ctx = createPluginContext({
            pluginId,
            getCurrentPdfPath: () => currentPdfPath || null,
            getLlmConfig: () => pluginManager.getLlmConfigSnapshot(),
          });
          cmd.action(ctx);
        },
      });
    });

    return cmds;
  }, [open, appCommands]);

  // Fuzzy filter
  const filtered = useMemo(() => {
    if (!query.trim()) return allCommands;
    const lower = query.toLowerCase();
    return allCommands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(lower) ||
        cmd.id.toLowerCase().includes(lower),
    );
  }, [query, allCommands]);

  // Reset selection on query change
  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  // Auto-focus input on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filtered[selectedIdx];
        if (cmd) {
          cmd.action();
          onClose();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, selectedIdx, onClose],
  );

  if (!open) return null;

  return (
    <div className="cmd-palette-overlay" onClick={onClose}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmd-palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入命令..."
        />
        <div className="cmd-palette-list">
          {filtered.length === 0 ? (
            <div className="cmd-palette-empty">无匹配命令</div>
          ) : (
            filtered.map((cmd, idx) => (
              <div
                key={cmd.id}
                className={`cmd-palette-item${idx === selectedIdx ? " selected" : ""}`}
                onClick={() => {
                  cmd.action();
                  onClose();
                }}
                onMouseEnter={() => setSelectedIdx(idx)}
              >
                <span className="cmd-palette-label">{cmd.label}</span>
                {cmd.shortcut && (
                  <span className="cmd-palette-shortcut">{cmd.shortcut}</span>
                )}
                {cmd.source === "plugin" && (
                  <span className="cmd-palette-source">插件</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
      <style>{`
        .cmd-palette-overlay {
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          z-index: 10000;
          display: flex;
          align-items: flex-start;
          justify-content: center;
          padding-top: 15vh;
          backdrop-filter: blur(4px);
        }
        .cmd-palette {
          background: #2a2a2a;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 12px;
          width: 480px;
          max-height: 400px;
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .cmd-palette-input {
          width: 100%;
          padding: 14px 18px;
          border: none;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          background: transparent;
          color: #f3f3f3;
          font-size: 15px;
          outline: none;
          box-sizing: border-box;
        }
        .cmd-palette-input::placeholder {
          color: #666;
        }
        .cmd-palette-list {
          overflow-y: auto;
          max-height: 340px;
          padding: 4px 0;
        }
        .cmd-palette-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 18px;
          cursor: pointer;
          color: #ddd;
          font-size: 14px;
          transition: background 0.1s;
        }
        .cmd-palette-item.selected {
          background: rgba(74, 123, 247, 0.2);
          color: #fff;
        }
        .cmd-palette-item:hover {
          background: rgba(255, 255, 255, 0.06);
        }
        .cmd-palette-label {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .cmd-palette-shortcut {
          font-size: 12px;
          color: #888;
          padding: 2px 6px;
          background: rgba(255, 255, 255, 0.06);
          border-radius: 4px;
          font-family: monospace;
          flex-shrink: 0;
        }
        .cmd-palette-source {
          font-size: 11px;
          color: #888;
          padding: 1px 6px;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 3px;
          flex-shrink: 0;
        }
        .cmd-palette-empty {
          padding: 20px;
          text-align: center;
          color: #666;
          font-size: 14px;
        }
      `}</style>
    </div>
  );
}
