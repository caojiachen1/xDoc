import { useState, useMemo } from "react";
import { Trash2, Search, FileText, BookOpen, Star, FolderOpen } from "lucide-react";

export interface PaperInfo {
  id: string;
  name: string;
  path: string;
  importDate: string;
  lastReadDate?: string;
  fileSize?: number;
}

type CollectionType = "all" | "recent" | "favorites";

interface HomePageProps {
  papers: PaperInfo[];
  onOpenPaper: (paper: PaperInfo) => void;
  onImportPapers: () => Promise<void>;
  onDeletePaper: (id: string) => void;
}

export default function HomePage({
  papers,
  onOpenPaper,
  onImportPapers,
  onDeletePaper,
}: HomePageProps) {
  const [selectedCollection, setSelectedCollection] =
    useState<CollectionType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null);

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
      result = result.filter((p) => p.name.toLowerCase().includes(q));
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

  const handleDeleteSelected = () => {
    if (!selectedPaperId) return;
    if (confirm("确定要删除该文献吗？")) {
      onDeletePaper(selectedPaperId);
      setSelectedPaperId(null);
    }
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

      <div className="home-content">
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

        <div className="home-paper-list">
          {filteredPapers.length > 0 ? (
            <table className="home-table">
              <thead>
                <tr>
                  <th style={{ width: "50%" }}>标题</th>
                  <th style={{ width: "15%" }}>类型</th>
                  <th style={{ width: "15%" }}>导入日期</th>
                  <th style={{ width: "10%" }}>大小</th>
                  <th style={{ width: "10%" }}>最近阅读</th>
                </tr>
              </thead>
              <tbody>
                {filteredPapers.map((paper) => (
                  <tr
                    key={paper.id}
                    className={`home-table-row ${selectedPaperId === paper.id ? "selected" : ""}`}
                    onClick={() => setSelectedPaperId(paper.id)}
                    onDoubleClick={() => handleDoubleClick(paper)}
                  >
                    <td>
                      <div className="home-paper-title">
                        <FileText size={15} style={{ flexShrink: 0 }} />
                        <span>{paper.name}</span>
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
                    ? '点击"导入文件"添加 PDF 或图片文档'
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
    </div>
  );
}
