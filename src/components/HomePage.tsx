import { useState, useMemo, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Trash2, Search, FileText, BookOpen, Star, FolderOpen, Info, Upload, Copy, Check, Folder, RefreshCw, CheckCircle, Loader2, XCircle } from "lucide-react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PaperMetadata } from "../utils/pdfMetadata";
import { lookupJournalRanking, type JournalRanking } from "../utils/paperDb";

export type GrobidStatus = "pending" | "parsing" | "done" | "error";

export interface PaperInfo {
  id: string;
  name: string;
  path: string;
  originalPath?: string;
  managedPath?: string;
  importDate: string;
  lastReadDate?: string;
  fileSize?: number;
  metadata?: PaperMetadata;
  metadataExtracted?: boolean;
}

type CollectionType = "all" | "recent" | "favorites";

interface HomePageProps {
  papers: PaperInfo[];
  onOpenPaper: (paper: PaperInfo) => void;
  onImportPapers: () => Promise<void>;
  onDeletePaper: (id: string) => void;
  onDropImport: (paths: string[]) => void;
  onExtractMetadata: (paperId: string) => void;
  extractingPaperId?: string | null;
  grobidStatusMap?: Record<string, GrobidStatus>;
}

const METADATA_FIELDS: { key: keyof PaperMetadata; label: string }[] = [
  { key: "title", label: "标题" },
  { key: "titleTranslation", label: "标题翻译" },
  { key: "authors", label: "作者" },
  { key: "abstract", label: "摘要" },
  { key: "journal", label: "出版物" },
  { key: "publisher", label: "出版社" },
  { key: "date", label: "日期" },
  { key: "volume", label: "卷次" },
  { key: "issue", label: "期号" },
  { key: "pages", label: "页码" },
  { key: "journalAbbrev", label: "刊名简称" },
  { key: "doi", label: "DOI" },
  { key: "url", label: "网址" },
  { key: "issn", label: "ISSN" },
  { key: "isbn", label: "ISBN" },
  { key: "language", label: "语言" },
  { key: "keywords", label: "关键词" },
];

const ALLOWED_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "bmp", "webp"];

export default function HomePage({
  papers,
  onOpenPaper,
  onImportPapers,
  onDeletePaper,
  onDropImport,
  onExtractMetadata,
  extractingPaperId,
  grobidStatusMap,
}: HomePageProps) {
  const [selectedCollection, setSelectedCollection] =
    useState<CollectionType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; paper: PaperInfo } | null>(null);
  const [journalRanking, setJournalRanking] = useState<JournalRanking | null>(null);

  // Close context menu on click / scroll
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener("click", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  // Reset copied-field indicator on any click outside the copy buttons
  useEffect(() => {
    if (!copiedField) return;
    const reset = () => setCopiedField(null);
    document.addEventListener("click", reset);
    return () => document.removeEventListener("click", reset);
  }, [copiedField]);

  // Auto-trigger metadata extraction when selecting a paper without metadata
  useEffect(() => {
    if (!selectedPaperId) return;
    const paper = papers.find((p) => p.id === selectedPaperId);
    if (paper && !paper.metadataExtracted && !extractingPaperId) {
      onExtractMetadata(paper.id);
    }
  }, [selectedPaperId, papers, extractingPaperId, onExtractMetadata]);

  const selectedPaper = useMemo(
    () => papers.find((p) => p.id === selectedPaperId) ?? null,
    [papers, selectedPaperId]
  );

  // Fetch journal ranking when selected paper's journal changes
  useEffect(() => {
    const journal = selectedPaper?.metadata?.journal;
    const journalAbbrev = selectedPaper?.metadata?.journalAbbrev;
    if (!journal && !journalAbbrev) {
      setJournalRanking(null);
      return;
    }
    let cancelled = false;
    const tryLookup = async () => {
      // Try full name first, then abbreviation
      if (journal) {
        const r = await lookupJournalRanking(journal);
        if (r) { if (!cancelled) setJournalRanking(r); return; }
      }
      if (journalAbbrev && journalAbbrev !== journal) {
        const r = await lookupJournalRanking(journalAbbrev);
        if (r) { if (!cancelled) setJournalRanking(r); return; }
      }
      if (!cancelled) setJournalRanking(null);
    };
    tryLookup().catch(() => { if (!cancelled) setJournalRanking(null); });
    return () => { cancelled = true; };
  }, [selectedPaper?.metadata?.journal, selectedPaper?.metadata?.journalAbbrev]);

  const filteredPapers = useMemo(() => {
    let result = papers;
    if (selectedCollection === "recent") {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      result = result.filter((p) => new Date(p.importDate).getTime() > sevenDaysAgo);
    } else if (selectedCollection === "favorites") {
      result = [];
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.metadata?.title?.toLowerCase().includes(q) ||
          p.metadata?.authors?.some((a) => a.toLowerCase().includes(q))
      );
    }
    return result;
  }, [papers, selectedCollection, searchQuery]);

  const collections: {
    key: CollectionType;
    label: string;
    icon: React.ReactNode;
  }[] = [
    { key: "all", label: "全部文献", icon: <FolderOpen size={15} /> },
    { key: "recent", label: "最近导入", icon: <BookOpen size={15} /> },
    { key: "favorites", label: "收藏", icon: <Star size={15} /> },
  ];

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return "-";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleDoubleClick = (paper: PaperInfo) => {
    onOpenPaper(paper);
  };

  const handleDeleteSelected = async () => {
    if (!selectedPaperId) return;
    const yes = await confirm("确定要删除该文献吗？", { title: "删除确认", kind: "warning" });
    if (yes) {
      onDeletePaper(selectedPaperId);
      setSelectedPaperId(null);
    }
  };

  // ── Drag and Drop ──────────────────────────────────────────────────────────
  // Use Tauri's native file-drop event for reliable file path access.
  // HTML5 drag events are kept only for the visual overlay feedback.
  const dragCounterRef = { current: 0 };

  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenDrop = win.onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        const paths = event.payload.paths.filter((p) => {
          const ext = p.split(".").pop()?.toLowerCase() ?? "";
          return ALLOWED_EXTENSIONS.includes(ext);
        });
        if (paths.length > 0) {
          onDropImport(paths);
        }
        setIsDragOver(false);
        dragCounterRef.current = 0;
      } else if (event.payload.type === "enter") {
        setIsDragOver(true);
      } else if (event.payload.type === "leave") {
        setIsDragOver(false);
        dragCounterRef.current = 0;
      }
    });

    return () => {
      unlistenDrop.then((fn) => fn());
    };
  }, [onDropImport]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      dragCounterRef.current = 0;
      // Actual file import is handled by Tauri's onFileDropEvent.
      // This handler only resets the visual drag overlay state.
    },
    []
  );

  // ── Metadata display helpers ───────────────────────────────────────────────
  const zoneLabel = (zone: number) => {
    const map: Record<number, string> = { 1: "一区", 2: "二区", 3: "三区", 4: "四区" };
    return map[zone] || `${zone}区`;
  };

  const renderMetadataValue = (key: keyof PaperMetadata, value: unknown) => {
    if (key === "authors" && Array.isArray(value)) {
      return (
        <div className="home-metadata-authors">
          {value.map((author: string, i: number) => (
            <span key={i} className="home-metadata-author">
              {author}
            </span>
          ))}
        </div>
      );
    }
    if (key === "keywords" && Array.isArray(value)) {
      return (
        <div className="home-metadata-keywords">
          {(value as string[]).map((kw, i) => (
            <span key={i} className="home-metadata-tag">
              {kw}
            </span>
          ))}
        </div>
      );
    }
    if (key === "url" || key === "doi") {
      const href = key === "doi" ? `https://doi.org/${value}` : String(value);
      return (
        <a
          className="home-metadata-link"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {String(value)}
        </a>
      );
    }
    if (key === "abstract") {
      return <div className="home-metadata-abstract">{String(value)}</div>;
    }
    return <span>{String(value)}</span>;
  };

  return (
    <div className="home-page">
      <div className="home-sidebar">
        <div className="home-sidebar-header">我的文库</div>
        {collections.map((col) => (
          <div
            key={col.key}
            className={`home-sidebar-item ${selectedCollection === col.key ? "active" : ""}`}
            onClick={() => setSelectedCollection(col.key)}
          >
            <span className="home-sidebar-icon">{col.icon}</span>
            <span>{col.label}</span>
            <span className="home-sidebar-count">
              {col.key === "all"
                ? papers.length
                : col.key === "recent"
                  ? filteredPapers.length
                  : 0}
            </span>
          </div>
        ))}
      </div>

      <div
        className="home-content"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div className="home-drop-overlay">
            <Upload size={32} />
            <span>释放以导入文件</span>
          </div>
        )}

        <div className="home-toolbar">
          <button className="home-toolbar-btn primary" onClick={onImportPapers}>
            <FileText size={14} />
            导入文件
          </button>
          <button
            className="home-toolbar-btn"
            onClick={handleDeleteSelected}
            disabled={!selectedPaperId}
          >
            <Trash2 size={14} />
            删除
          </button>
          <div style={{ flex: 1 }} />
          <div className="home-search-box">
            <Search size={14} style={{ opacity: 0.5, flexShrink: 0 }} />
            <input
              type="text"
              placeholder="搜索文献..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="home-search-input"
            />
          </div>
        </div>

        <div className="home-paper-list" onClick={() => setSelectedPaperId(null)}>
          {filteredPapers.length > 0 ? (
            <table className="home-table">
              <thead>
                <tr>
                  <th style={{ width: "5%" }}></th>
                  <th style={{ width: "49%" }}>标题</th>
                  <th style={{ width: "8%" }}>类型</th>
                  <th style={{ width: "13%" }}>导入日期</th>
                  <th style={{ width: "10%" }}>大小</th>
                  <th style={{ width: "15%" }}>最近阅读</th>
                </tr>
              </thead>
              <tbody>
                {filteredPapers.map((paper) => (
                  <tr
                    key={paper.id}
                    className={`home-table-row ${selectedPaperId === paper.id ? "selected" : ""}`}
                    onClick={(e) => { e.stopPropagation(); setSelectedPaperId(paper.id); }}
                    onDoubleClick={() => handleDoubleClick(paper)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setSelectedPaperId(paper.id);
                      setContextMenu({ x: e.clientX, y: e.clientY, paper });
                    }}
                  >
                    <td style={{ textAlign: "center" }}>
                      {(() => {
                        const st = grobidStatusMap?.[paper.path];
                        if (st === "parsing") return <span title="正在解析…"><Loader2 size={14} className="grobid-status-spinning" /></span>;
                        if (st === "done") return <span title="已解析"><CheckCircle size={14} className="grobid-status-done" /></span>;
                        if (st === "error") return <span title="解析失败"><XCircle size={14} className="grobid-status-error" /></span>;
                        return <span className="grobid-status-pending" title="待解析">—</span>;
                      })()}
                    </td>
                    <td>
                      <div className="home-paper-title">
                        <FileText size={15} style={{ flexShrink: 0 }} />
                        <span>
                          {paper.metadata?.title || paper.name}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="home-paper-type">
                        {paper.path.toLowerCase().endsWith(".pdf") ? "PDF" : "图片"}
                      </span>
                    </td>
                    <td>{formatDate(paper.importDate)}</td>
                    <td>{formatFileSize(paper.fileSize)}</td>
                    <td>
                      {paper.lastReadDate
                        ? formatDate(paper.lastReadDate)
                        : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="home-empty">
              <FileText size={48} style={{ opacity: 0.3 }} />
              <div className="home-empty-title">暂无文献</div>
              <div className="home-empty-hint">
                {searchQuery
                  ? "未找到匹配的文献"
                  : selectedCollection === "all"
                    ? '拖拽 PDF 文件到此处，或点击"导入文件"'
                    : "此分类下暂无文献"}
              </div>
              {!searchQuery && selectedCollection === "all" && (
                <button
                  className="home-toolbar-btn primary"
                  onClick={onImportPapers}
                  style={{ marginTop: 8 }}
                >
                  <FileText size={14} />
                  导入文件
                </button>
              )}
            </div>
          )}
        </div>

        <div className="home-status-bar">
          共 {filteredPapers.length} 篇文献
          {searchQuery && ` (筛选自 ${papers.length} 篇)`}
        </div>
      </div>

      {/* ── Metadata Sidebar Panel ── */}
      <div className="home-metadata-panel">
        <div className="home-metadata-header">
          <Info size={15} />
          <span>信息</span>
        </div>

        <div className="home-metadata-body">
          {!selectedPaper ? (
            <div className="home-metadata-empty-center">
              <Info size={32} style={{ opacity: 0.2 }} />
              <span>此视图有 {filteredPapers.length} 个条目</span>
            </div>
          ) : extractingPaperId === selectedPaper.id ? (
            <div className="home-metadata-loading">
              <div className="home-metadata-spinner" />
              <span>正在解析元数据...</span>
            </div>
          ) : selectedPaper.metadata ? (
            METADATA_FIELDS.map(({ key, label }) => {
                const value = selectedPaper.metadata?.[key];
                if (value === undefined || value === null) return null;
                if (Array.isArray(value) && value.length === 0) return null;
                if (typeof value === "string" && !value.trim()) return null;

                // Build plain-text for clipboard copy
                const copyText = Array.isArray(value)
                  ? value.join(", ")
                  : key === "doi"
                    ? `https://doi.org/${value}`
                    : String(value);

                const row = (
                  <div key={key} className="home-metadata-row">
                    <div className="home-metadata-label">{label}</div>
                    <div className="home-metadata-value">
                      {renderMetadataValue(key, value)}
                      <button
                        className={`home-metadata-copy ${copiedField === key ? "copied" : ""}`}
                        title="复制"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(copyText);
                          setCopiedField(key);
                        }}
                      >
                        {copiedField === key
                          ? <Check size={12} />
                          : <Copy size={12} />}
                      </button>
                    </div>
                  </div>
                );

                // Show CAS ranking badges right after the journal field
                if (key === "journal" && journalRanking) {
                  return (
                    <div key={key}>
                      {row}
                      <div className="home-metadata-row journal-ranking-row">
                        <div className="home-metadata-label">中科院分区</div>
                        <div className="home-metadata-value journal-ranking-badges">
                          <span className={`ranking-badge zone-${journalRanking.zone}`}>
                            {zoneLabel(journalRanking.zone)}
                          </span>
                          {journalRanking.is_top && (
                            <span className="ranking-badge top-badge">Top</span>
                          )}
                          {journalRanking.is_oa && (
                            <span className="ranking-badge oa-badge">OA</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                }

                return row;
              })
            ) : (
              <div className="home-metadata-empty">
                {selectedPaper.metadataExtracted
                  ? "未能提取到元数据"
                  : "点击以解析元数据"}
              </div>
            )}
          </div>
        </div>

      {/* ── Context Menu (rendered via Portal to avoid containing-block issues) ── */}
      {contextMenu && createPortal(
        <div
          className="context-menu-overlay"
          onClick={() => setContextMenu(null)}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="context-menu-item"
              onClick={() => {
                onOpenPaper(contextMenu.paper);
                setContextMenu(null);
              }}
            >
              <BookOpen size={14} />
              <span>打开</span>
            </div>
            <div
              className="context-menu-item"
              onClick={() => {
                invoke("plugin:opener|reveal_item_in_dir", { paths: [contextMenu.paper.path] }).catch(console.error);
                setContextMenu(null);
              }}
            >
              <Folder size={14} />
              <span>在文件夹中显示</span>
            </div>
            <div className="context-menu-separator" />
            <div
              className="context-menu-item"
              onClick={() => {
                navigator.clipboard.writeText(contextMenu.paper.path);
                setContextMenu(null);
              }}
            >
              <Copy size={14} />
              <span>复制路径</span>
            </div>
            <div
              className="context-menu-item"
              onClick={() => {
                onExtractMetadata(contextMenu.paper.id);
                setContextMenu(null);
              }}
            >
              <RefreshCw size={14} />
              <span>提取元数据</span>
            </div>
            <div className="context-menu-separator" />
            <div
              className="context-menu-item danger"
              onClick={async () => {
                const ok = await confirm(`确定要删除「${contextMenu.paper.name}」吗？`);
                if (ok) onDeletePaper(contextMenu.paper.id);
                setContextMenu(null);
              }}
            >
              <Trash2 size={14} />
              <span>删除</span>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
