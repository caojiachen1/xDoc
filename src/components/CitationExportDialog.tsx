import { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, Copy, Check, FileText, Code } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { PaperMetadata } from "../utils/pdfMetadata";
import {
  formatCitation,
  getGroupedStyles,
  CITATION_STYLES,
  type OutputFormat,
} from "../utils/citationFormatter";

interface CitationExportDialogProps {
  paperTitle: string;
  metadata: PaperMetadata;
  onClose: () => void;
}

export default function CitationExportDialog({
  paperTitle,
  metadata,
  onClose,
}: CitationExportDialogProps) {
  const [selectedStyleId, setSelectedStyleId] = useState(CITATION_STYLES[0].id);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("text");
  const [copied, setCopied] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const groupedStyles = useMemo(() => getGroupedStyles(), []);

  // Filter styles by search
  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) return groupedStyles;
    const q = searchQuery.toLowerCase();
    const result: Record<string, typeof CITATION_STYLES> = {};
    for (const [cat, styles] of Object.entries(groupedStyles)) {
      const matched = styles.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          cat.toLowerCase().includes(q)
      );
      if (matched.length > 0) result[cat] = matched;
    }
    return result;
  }, [searchQuery, groupedStyles]);

  const citationText = useMemo(
    () => formatCitation(metadata, selectedStyleId, outputFormat),
    [metadata, selectedStyleId, outputFormat]
  );

  const handleCopy = async () => {
    await navigator.clipboard.writeText(citationText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExportFile = async () => {
    const ext = outputFormat === "html" ? "html" : outputFormat === "rtf" ? "rtf" : "txt";
    const defaultName = `${paperTitle.replace(/[/\\?%*:|"<>]/g, "_").substring(0, 50)}_citation.${ext}`;
    const filePath = await save({
      defaultPath: defaultName,
      filters: [
        { name: "引用文件", extensions: [ext] },
      ],
    });
    if (!filePath) return;

    let content = citationText;
    if (outputFormat === "html") {
      content = `<!DOCTYPE html>\n<html><head><meta charset="UTF-8"><title>Citation</title></head>\n<body><p>${citationText}</p></body></html>`;
    }
    await writeTextFile(filePath, content);
    onClose();
  };

  // Preview: convert *italic* markers to actual italic for display
  const previewHtml = useMemo(() => {
    const escaped = citationText
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return escaped.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  }, [citationText]);

  return createPortal(
    <div className="citation-overlay" onClick={onClose}>
      <div className="citation-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="citation-header">
          <div className="citation-header-title">
            <FileText size={15} />
            <span>导出参考文献引用</span>
          </div>
          <button className="citation-close-btn" onClick={onClose} title="关闭">
            <X size={15} />
          </button>
        </div>

        {/* Paper title */}
        <div className="citation-paper-title">{paperTitle}</div>

        {/* Search */}
        <div className="citation-search">
          <input
            type="text"
            placeholder="搜索引用格式..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="citation-search-input"
          />
        </div>

        {/* Body: style list + preview */}
        <div className="citation-body">
          {/* Style list */}
          <div className="citation-style-list">
            {Object.entries(filteredGroups).map(([category, styles]) => (
              <div key={category} className="citation-style-group">
                <div className="citation-style-group-label">{category}</div>
                {styles.map((style) => (
                  <div
                    key={style.id}
                    className={`citation-style-item ${selectedStyleId === style.id ? "active" : ""}`}
                    onClick={() => setSelectedStyleId(style.id)}
                  >
                    {style.name}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Preview + output */}
          <div className="citation-preview-panel">
            <div className="citation-preview-label">预览</div>
            <div
              className="citation-preview"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />

            <div className="citation-output-section">
              <div className="citation-output-label">输出方式</div>
              <div className="citation-output-buttons">
                <button
                  className={`citation-output-btn ${outputFormat === "text" ? "active" : ""}`}
                  onClick={() => setOutputFormat("text")}
                >
                  <Copy size={13} />
                  纯文本
                </button>
                <button
                  className={`citation-output-btn ${outputFormat === "html" ? "active" : ""}`}
                  onClick={() => setOutputFormat("html")}
                >
                  <Code size={13} />
                  HTML
                </button>
                <button
                  className={`citation-output-btn ${outputFormat === "rtf" ? "active" : ""}`}
                  onClick={() => setOutputFormat("rtf")}
                >
                  <FileText size={13} />
                  RTF
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="citation-footer">
          <button className="citation-btn" onClick={handleCopy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "已复制" : "复制到剪贴板"}
          </button>
          <button className="citation-btn primary" onClick={handleExportFile}>
            <FileText size={14} />
            导出文件
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
