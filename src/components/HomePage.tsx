import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { Trash2, Search, FileText, BookOpen, Star, FolderOpen, Info, Upload, Copy, Check, Folder, RefreshCw, CheckCircle, Loader2, XCircle, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Quote, Languages } from "lucide-react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PaperMetadata } from "../utils/pdfMetadata";
import { lookupJournalRanking, type JournalRanking } from "../utils/paperDb";
import type { LlmSettings } from "./SettingsDialog";
import CitationExportDialog from "./CitationExportDialog";

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
  llmSettings?: LlmSettings;
  onUpdateTitleTranslation?: (paperId: string, translation: string) => void;
  onUpdateAbstractTranslation?: (paperId: string, translation: string) => void;
}

const METADATA_FIELDS: { key: keyof PaperMetadata; label: string }[] = [
  { key: "title", label: "标题" },
  { key: "titleTranslation", label: "标题翻译" },
  { key: "authors", label: "作者" },
  { key: "abstract", label: "摘要" },
  { key: "abstractTranslation", label: "摘要翻译" },
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
  llmSettings,
  onUpdateTitleTranslation,
  onUpdateAbstractTranslation,
}: HomePageProps) {
  const [selectedCollection, setSelectedCollection] =
    useState<CollectionType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; paper: PaperInfo } | null>(null);
  const [journalRanking, setJournalRanking] = useState<JournalRanking | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [infoPanelVisible, setInfoPanelVisible] = useState(true);
  const [citationDialogPaper, setCitationDialogPaper] = useState<PaperInfo | null>(null);
  const [rankingMap, setRankingMap] = useState<Map<string, JournalRanking | null>>(new Map());
  const rankingMapRef = useRef(rankingMap);
  rankingMapRef.current = rankingMap;
  const [showChinese, setShowChinese] = useState(false);
  const [translatingIds, setTranslatingIds] = useState<Set<string>>(new Set());
  const [translatingAbstractId, setTranslatingAbstractId] = useState<string | null>(null);
  const [showTranslatedAbstract, setShowTranslatedAbstract] = useState(false);

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

  // Reset abstract translation view when selecting a different paper
  useEffect(() => {
    setShowTranslatedAbstract(false);
  }, [selectedPaperId]);

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

  // Translate a single paper's title via LLM
  const translatePaperTitle = useCallback(async (paper: PaperInfo) => {
    if (!llmSettings || !onUpdateTitleTranslation) return;
    const title = paper.metadata?.title;
    if (!title || paper.metadata?.titleTranslation) return;

    const apiKey = llmSettings.vendorApiKeys[llmSettings.vendor];
    if (!apiKey || !llmSettings.baseUrl) return;

    setTranslatingIds(prev => new Set(prev).add(paper.id));
    try {
      const baseUrl = llmSettings.baseUrl.replace(/\/+$/, "");
      const body: Record<string, unknown> = {
        model: llmSettings.model,
        messages: [
          { role: "system", content: "你是一位专业的学术论文标题翻译专家。请将以下英文论文标题翻译成准确、流畅的中文。只输出翻译结果，不要任何额外内容。" },
          { role: "user", content: title },
        ],
        temperature: 0.3,
        max_tokens: 256,
        stream: false,
      };
      if (llmSettings.vendor === "volcengine") {
        body.thinking = { type: "disabled" };
      }
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`LLM error ${resp.status}`);
      const json = await resp.json();
      const translated = (json as { choices: { message: { content: string } }[] }).choices?.[0]?.message?.content?.trim();
      if (translated) {
        onUpdateTitleTranslation(paper.id, translated);
      }
    } catch (e) {
      console.warn(`[HomePage] translate title failed for "${title}":`, e);
    } finally {
      setTranslatingIds(prev => {
        const next = new Set(prev);
        next.delete(paper.id);
        return next;
      });
    }
  }, [llmSettings, onUpdateTitleTranslation]);

  // Translate a paper's abstract via LLM
  const translatePaperAbstract = useCallback(async (paper: PaperInfo) => {
    if (!llmSettings || !onUpdateAbstractTranslation) return;
    const abstract = paper.metadata?.abstract;
    if (!abstract || paper.metadata?.abstractTranslation) return;

    const apiKey = llmSettings.vendorApiKeys[llmSettings.vendor];
    if (!apiKey || !llmSettings.baseUrl) return;

    // Strip leading "Abstract" label before sending to LLM
    const cleanedAbstract = cleanAbstract(abstract);

    setTranslatingAbstractId(paper.id);
    try {
      const baseUrl = llmSettings.baseUrl.replace(/\/+$/, "");
      const body: Record<string, unknown> = {
        model: llmSettings.model,
        messages: [
          { role: "system", content: "你是一位专业的学术论文摘要翻译专家。请将以下英文论文摘要翻译成准确、流畅的中文。保留原文的段落结构。只输出纯文本翻译结果，不要使用任何 Markdown 格式（如加粗、斜体、标题、列表符号等）。不要添加任何额外说明或注释。" },
          { role: "user", content: cleanedAbstract },
        ],
        temperature: 0.3,
        max_tokens: 4096,
        stream: false,
      };
      if (llmSettings.vendor === "volcengine") {
        body.thinking = { type: "disabled" };
      }
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`LLM error ${resp.status}`);
      const json = await resp.json();
      const translated = (json as { choices: { message: { content: string } }[] }).choices?.[0]?.message?.content?.trim();
      if (translated) {
        onUpdateAbstractTranslation(paper.id, translated);
      }
    } catch (e) {
      console.warn(`[HomePage] translate abstract failed for "${paper.name}":`, e);
    } finally {
      setTranslatingAbstractId(null);
    }
  }, [llmSettings, onUpdateAbstractTranslation]);

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

  // Auto-translate all visible papers when Chinese mode is enabled
  useEffect(() => {
    if (!showChinese || !llmSettings) return;
    for (const paper of filteredPapers) {
      if (paper.metadata?.title && !paper.metadata?.titleTranslation && !translatingIds.has(paper.id)) {
        translatePaperTitle(paper);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showChinese, filteredPapers, llmSettings]);

  // Batch-fetch journal rankings for all filtered papers
  useEffect(() => {
    let cancelled = false;
    const currentMap = rankingMapRef.current;
    const journalsToFetch = new Set<string>();
    for (const p of filteredPapers) {
      const j = p.metadata?.journal;
      const ja = p.metadata?.journalAbbrev;
      if (j && !currentMap.has(j)) journalsToFetch.add(j);
      if (ja && ja !== j && !currentMap.has(ja)) journalsToFetch.add(ja);
    }
    if (journalsToFetch.size === 0) return;
    const fetchAll = async () => {
      const updates = new Map<string, JournalRanking | null>();
      for (const journal of journalsToFetch) {
        try {
          const r = await lookupJournalRanking(journal);
          updates.set(journal, r);
        } catch {
          updates.set(journal, null);
        }
      }
      if (!cancelled) {
        setRankingMap(prev => {
          const merged = new Map(prev);
          for (const [k, v] of updates) merged.set(k, v);
          return merged;
        });
      }
    };
    fetchAll();
    return () => { cancelled = true; };
  }, [filteredPapers]);

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

  // Derive document category from metadata
  const deriveCategory = (metadata?: PaperMetadata): string => {
    if (!metadata) return "-";
    if (metadata.category) {
      const cat = metadata.category.toLowerCase();
      if (cat.includes("journal")) return "期刊文章";
      if (cat.includes("proceedings") || cat.includes("conference")) return "会议论文";
      if (cat.includes("book")) return "书籍/章节";
      if (cat.includes("report")) return "报告";
      if (cat.includes("thesis") || cat.includes("dissertation")) return "学位论文";
      if (cat.includes("preprint") || cat.includes("posted-content")) return "预印本";
      return "文献";
    }
    if (metadata.journal) return "期刊文章";
    if (metadata.isbn) return "书籍/章节";
    if (metadata.url?.includes("arxiv")) return "预印本";
    return "文献";
  };

  // Strip leading "Abstract" label from abstract text
  const cleanAbstract = (text: string): string => {
    return text.replace(/^(?:Abstract|ABSTRACT|abstract|摘要)[\s:：\-—]+/, "").trim();
  };

  // Get ranking for a paper from the batch-fetched map
  const getPaperRanking = (paper: PaperInfo): JournalRanking | null => {
    const j = paper.metadata?.journal;
    const ja = paper.metadata?.journalAbbrev;
    if (j && rankingMap.has(j)) return rankingMap.get(j) ?? null;
    if (ja && rankingMap.has(ja)) return rankingMap.get(ja) ?? null;
    return null;
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
      return <div className="home-metadata-abstract">{cleanAbstract(String(value))}</div>;
    }
    return <span>{String(value)}</span>;
  };

  return (
    <div className="home-page">
      {sidebarVisible && (
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
      )}

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
          <button
            className={`home-toolbar-btn title-lang-toggle ${showChinese ? "active" : ""}`}
            onClick={() => setShowChinese(v => !v)}
            title={showChinese ? "显示原标题 (English)" : "显示中文翻译标题"}
          >
            <Languages size={14} />
            {showChinese ? "中文" : "EN"}
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
          <button
            className={`home-toolbar-btn ${!sidebarVisible ? "primary" : ""}`}
            onClick={() => setSidebarVisible(v => !v)}
            title={sidebarVisible ? "隐藏文库栏" : "显示文库栏"}
          >
            {sidebarVisible ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
          <button
            className={`home-toolbar-btn ${!infoPanelVisible ? "primary" : ""}`}
            onClick={() => setInfoPanelVisible(v => !v)}
            title={infoPanelVisible ? "隐藏信息栏" : "显示信息栏"}
          >
            {infoPanelVisible ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          </button>
        </div>

        <div className="home-paper-list" onClick={() => setSelectedPaperId(null)}>
          {filteredPapers.length > 0 ? (
            <table className="home-table">
              <thead>
                <tr>
                  <th style={{ width: "3%" }}></th>
                  <th style={{ width: "28%" }}>标题</th>
                  <th style={{ width: "18%" }}>作者</th>
                  <th style={{ width: "12%" }}>期刊</th>
                  <th style={{ width: "7%" }}>分区</th>
                  <th style={{ width: "6%" }}>类目</th>
                  <th style={{ width: "8%" }}>发表时间</th>
                  <th style={{ width: "6%" }}>大小</th>
                  <th style={{ width: "12%" }}>最近阅读</th>
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
                          {showChinese
                            ? (paper.metadata?.titleTranslation
                                || (translatingIds.has(paper.id)
                                    ? "翻译中…"
                                    : (paper.metadata?.title || paper.name)))
                            : (paper.metadata?.title || paper.name)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="home-paper-authors" title={paper.metadata?.authors?.join(", ") || ""}>
                        {paper.metadata?.authors?.length
                          ? paper.metadata.authors.join(", ")
                          : "-"}
                      </span>
                    </td>
                    <td>
                      <span className="home-paper-journal">
                        {paper.metadata?.journal || paper.metadata?.journalAbbrev || "-"}
                      </span>
                    </td>
                    <td>
                      {(() => {
                        const r = getPaperRanking(paper);
                        if (!r) return <span style={{ opacity: 0.4 }}>-</span>;
                        return (
                          <span className={`ranking-badge zone-${r.zone}`}>
                            {zoneLabel(r.zone)}
                          </span>
                        );
                      })()}
                    </td>
                    <td>
                      <span className="home-paper-category">{deriveCategory(paper.metadata)}</span>
                    </td>
                    <td>{paper.metadata?.date || "-"}</td>
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
      {infoPanelVisible && (
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
                    <div className="home-metadata-label">
                      {label}
                      {key === "abstract" && selectedPaper.metadata?.abstract && (
                        <button
                          className={`abstract-translate-btn ${showTranslatedAbstract && selectedPaper.metadata?.abstractTranslation ? "active" : ""}`}
                          title={showTranslatedAbstract ? "显示原文" : "翻译摘要为中文"}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (selectedPaper.metadata?.abstractTranslation) {
                              setShowTranslatedAbstract(v => !v);
                            } else {
                              translatePaperAbstract(selectedPaper);
                            }
                          }}
                        >
                          {translatingAbstractId === selectedPaper.id
                            ? <Loader2 size={11} className="grobid-status-spinning" />
                            : <Languages size={11} />}
                        </button>
                      )}
                    </div>
                    <div className="home-metadata-value">
                      {key === "abstract" && showTranslatedAbstract && selectedPaper.metadata?.abstractTranslation
                        ? <div className="home-metadata-abstract">{cleanAbstract(selectedPaper.metadata.abstractTranslation)}</div>
                        : renderMetadataValue(key, value)}
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
      )}

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
            <div
              className="context-menu-item"
              onClick={() => {
                setCitationDialogPaper(contextMenu.paper);
                setContextMenu(null);
              }}
            >
              <Quote size={14} />
              <span>导出参考文献引用</span>
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

      {/* ── Citation Export Dialog ── */}
      {citationDialogPaper && citationDialogPaper.metadata && (
        <CitationExportDialog
          paperTitle={citationDialogPaper.metadata.title || citationDialogPaper.name}
          metadata={citationDialogPaper.metadata}
          onClose={() => setCitationDialogPaper(null)}
        />
      )}
    </div>
  );
}
