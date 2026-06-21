/**
 * GlobalSearchDialog — Single-paper full-text & semantic search.
 *
 * Ctrl+F to open.  Searches ONLY the currently open PDF.
 *   1. 全文搜索  — SQL LIKE keyword search (CJK-friendly)
 *   2. 语义搜索  — LLM-powered semantic matching (supports cross-language)
 *
 * UI: Fluent UI dark theme, consistent with SettingsDialog / ReadingReport.
 */
import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import {
  Button,
  Input,
  Spinner,
  Text,
  Badge,
  Tooltip,
  ProgressBar,
} from "@fluentui/react-components";
import {
  Search24Regular,
  Dismiss20Regular,
  Database24Regular,
  Document20Regular,
  Sparkle24Regular,
  ArrowRight16Regular,
  DocumentText24Regular,
  Eye24Regular,
} from "@fluentui/react-icons";
import { fetch } from "@tauri-apps/plugin-http";
import { listen } from "@tauri-apps/api/event";
import type { PaperInfo } from "./HomePage";
import type { LlmSettings } from "./SettingsDialog";
import { renderLatexToHtml } from "../utils/latex";
import {
  searchPaper,
  searchIndexPaper,
  searchIndexPaperOcr,
  searchIndexStatus,
  searchExtractPages,
  type SearchResult,
  type PageText,
} from "../utils/paperDb";

interface GlobalSearchDialogProps {
  open: boolean;
  onClose: () => void;
  currentPaper: PaperInfo | null;
  onOpenResult: (pageIndex: number) => void;
  llmSettings?: LlmSettings;
  searchIndexMode: "pdf" | "ocr";
  onSearchIndexModeChange: (mode: "pdf" | "ocr") => void;
  ocrEnabled: boolean;
}

type SearchMode = "fulltext" | "semantic";

interface SemanticResult {
  page_index: number;
  snippet: string;
  score: number;
  reasoning?: string;
}

export default function GlobalSearchDialog({
  open,
  onClose,
  currentPaper,
  onOpenResult,
  llmSettings,
  searchIndexMode,
  onSearchIndexModeChange,
  ocrEnabled,
}: GlobalSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("fulltext");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [semanticResults, setSemanticResults] = useState<SemanticResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [semanticSearching, setSemanticSearching] = useState(false);
  const [semanticStatus, setSemanticStatus] = useState("");
  const [isIndexed, setIsIndexed] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [ocrIndexProgress, setOcrIndexProgress] = useState<{
    page: number;
    total_pages: number;
    status: string;
    paragraph: number;
    total_paragraphs: number;
    message: string;
  } | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultsListRef = useRef<HTMLDivElement>(null);

  // ── Reset on open ────────────────────────────────────────
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSemanticResults([]);
      setSelectedIdx(0);
      setSemanticStatus("");
      setOcrIndexProgress(null);
      setIndexError(null);
      // Check if current paper is indexed
      if (currentPaper) {
        searchIndexStatus()
          .then((ids) => setIsIndexed(ids.includes(currentPaper.id)))
          .catch(() => setIsIndexed(false));
      }
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [open, currentPaper]);

  // ── Listen for OCR index progress events ─────────────────
  const prevProgressRef = useRef<{ page: number; status: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const unlisten = listen<{
      page: number;
      total_pages: number;
      status: string;
      paragraph: number;
      total_paragraphs: number;
      message: string;
    }>("ocr-index-progress", (event) => {
      const p = event.payload;
      setOcrIndexProgress(p);
      // Log on page change or status transition
      const prev = prevProgressRef.current;
      if (!prev || prev.page !== p.page || prev.status !== p.status) {
        if (p.status === "detecting") {
          console.log(`[search-index] OCR 进度: 第 ${p.page + 1}/${p.total_pages} 页 — 版面分析中`);
        } else if (p.status === "ocr" && p.paragraph === 1) {
          console.log(`[search-index] OCR 进度: 第 ${p.page + 1}/${p.total_pages} 页 — 开始识别 ${p.total_paragraphs} 个段落`);
        } else if (p.status === "indexing") {
          console.log(`[search-index] OCR 进度: 正在写入搜索索引...`);
        } else if (p.status === "done") {
          console.log(`[search-index] OCR 进度: 完成`);
          setTimeout(() => setOcrIndexProgress(null), 2000);
        }
      }
      prevProgressRef.current = { page: p.page, status: p.status };
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [open]);

  // ── Debounced full-text search (single paper) ───────────
  useEffect(() => {
    if (mode !== "fulltext" || !query.trim() || !currentPaper) {
      if (mode === "fulltext") setResults([]);
      return;
    }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setSearching(true);
      searchPaper(currentPaper.id, query, 100)
        .then((r) => {
          setResults(r);
          setSelectedIdx(0);
        })
        .catch((e) => console.warn("[search] failed:", e))
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [query, mode, currentPaper]);

  // ── Semantic search (LLM with full page text) ──────────
  const runSemanticSearch = useCallback(async (presetQuery?: string) => {
    const q = presetQuery ?? query;
    if (!q.trim() || !llmSettings || !currentPaper) return;
    setSemanticSearching(true);
    setSemanticResults([]);
    setSemanticStatus("正在提取文档文本...");

    try {
      // Step 1: Get all page texts
      const extracted = await searchExtractPages(
        currentPaper.id,
        currentPaper.path,
      );
      const { pages, language } = extracted;
      if (pages.length === 0) {
        setSemanticStatus("文档中没有可搜索的文本内容");
        setSemanticSearching(false);
        return;
      }

      setSemanticStatus(`正在分析 ${pages.length} 页内容...`);

      // Step 2: Call LLM
      const apiKey = llmSettings.vendorApiKeys[llmSettings.vendor];
      if (!apiKey || !llmSettings.baseUrl) {
        setSemanticStatus("未配置 LLM API，无法进行语义搜索");
        setSemanticSearching(false);
        return;
      }

      const baseUrl = llmSettings.baseUrl.replace(/\/+$/, "");
      // Build page text blocks (truncate very long pages)
      const pagesText = pages
        .map(
          (p: PageText) =>
            `--- 第 ${p.page_index + 1} 页 ---\n${p.text.substring(0, 2000)}`,
        )
        .join("\n\n");

      const body: Record<string, unknown> = {
        model: llmSettings.model,
        messages: [
          {
            role: "system",
            content: `你是一个学术论文智能搜索助手。用户会提供一个搜索意图和一篇文档的各页内容。

你的任务：
1. 理解用户的搜索意图（可能是中文或英文，文档也可能是任何语言）
2. 找到与用户意图**语义相关**的页面——不要求文字完全匹配，只要内容概念相关即可
3. 例如：用户搜"论文中实验部分"，你应该找到包含实验方法、实验设置、实验结果的页面，即使页面中没有"实验部分"这四个字
4. 例如：用户搜"related work"，你应该找到文献综述、相关工作讨论的页面
5. 例如：用户搜"结论与展望"，应找到总结和未来工作讨论的页面

输出JSON数组，格式为：
[{"page": 页码(从1开始), "score": 1-10分相关度, "snippet": "该页最相关的100字左右摘要", "reasoning": "简短说明为何相关"}]

只返回JSON数组，不要输出其他内容。如果完全没有相关页面，返回空数组 []。`,
          },
          {
            role: "user",
            content: `搜索意图: ${query}\n文档语言: ${language || "未知"}\n\n文档内容:\n${pagesText}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 4096,
        stream: false,
      };
      if (llmSettings.vendor === "volcengine") {
        body.thinking = { type: "disabled" };
      }

      setSemanticStatus("AI 正在分析语义相关性...");
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) throw new Error(`LLM error ${resp.status}`);
      const json = await resp.json();
      const content = (
        json as { choices: { message: { content: string } }[] }
      ).choices?.[0]?.message?.content?.trim();

      if (!content) {
        setSemanticStatus("AI 未返回有效结果");
        setSemanticResults([]);
      } else {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const rankings = JSON.parse(jsonMatch[0]) as {
            page: number;
            score: number;
            snippet?: string;
            reasoning?: string;
          }[];
          const scored: SemanticResult[] = rankings
            .filter((r) => r.score >= 3)
            .map((r) => ({
              page_index: r.page - 1, // Convert to 0-based
              snippet: r.snippet || "",
              score: r.score,
              reasoning: r.reasoning,
            }))
            .sort((a, b) => b.score - a.score);
          setSemanticResults(scored);
          setSemanticStatus(
            scored.length > 0 ? `找到 ${scored.length} 个相关页面` : "未找到相关页面",
          );
        } else {
          setSemanticStatus("AI 返回格式异常");
          setSemanticResults([]);
        }
      }
    } catch (e) {
      console.warn("[search] semantic search failed:", e);
      setSemanticStatus("语义搜索失败，请检查 LLM 配置");
    } finally {
      setSemanticSearching(false);
    }
  }, [query, llmSettings, currentPaper]);

  // ── Index current paper ──────────────────────────────────
  const handleIndex = useCallback(async () => {
    if (!currentPaper) return;
    const startTime = Date.now();
    const modeLabel = searchIndexMode === "ocr" ? "OCR" : "PDF";
    console.log(`[search-index] 开始${modeLabel}索引（强制刷新）: paper_id=${currentPaper.id}, path=${currentPaper.path}`);
    setIndexing(true);
    setIndexError(null);
    setOcrIndexProgress(null);
    try {
      if (searchIndexMode === "ocr") {
        const pageCount = await searchIndexPaperOcr(
          currentPaper.id, currentPaper.path, undefined, true,
        );
        console.log(`[search-index] OCR 索引完成: ${pageCount} 页, 耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
      } else {
        const pageCount = await searchIndexPaper(currentPaper.id, currentPaper.path);
        console.log(`[search-index] PDF 索引完成: ${pageCount} 页, 耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
      }
      setIsIndexed(true);
    } catch (e) {
      const errMsg = String(e);
      console.error(`[search-index] ${modeLabel}索引失败 (耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s):`, e);
      setIndexError(errMsg);
    } finally {
      setIndexing(false);
    }
  }, [currentPaper, searchIndexMode]);

  // ── Keyboard navigation ──────────────────────────────────
  const displayResults = mode === "fulltext" ? results : semanticResults;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, displayResults.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (
          mode === "semantic" &&
          semanticResults.length === 0 &&
          query.trim() &&
          !semanticSearching
        ) {
          runSemanticSearch(query);
        } else if (displayResults[selectedIdx]) {
          const r = displayResults[selectedIdx];
          onOpenResult(r.page_index);
          onClose();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [
      displayResults,
      selectedIdx,
      onOpenResult,
      onClose,
      mode,
      query,
      semanticResults,
      semanticSearching,
      runSemanticSearch,
    ],
  );

  // Scroll selected item into view
  useEffect(() => {
    const container = resultsListRef.current;
    if (!container) return;
    const item = container.children[selectedIdx] as HTMLElement | undefined;
    if (item) item.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  // Paper display name
  const paperTitle = useMemo(() => {
    if (!currentPaper) return null;
    return currentPaper.metadata?.title || currentPaper.name;
  }, [currentPaper]);

  if (!open) return null;

  const isSemantic = mode === "semantic";
  const isLoading = isSemantic ? semanticSearching : searching;
  const hasNoDoc = !currentPaper;

  return (
    <div className="gs-overlay" onClick={onClose}>
      <div
        className="gs-window"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* ── Header ───────────────────────────────────────── */}
        <div className="gs-header">
          <div className="gs-header-top">
            <div className="gs-header-title">
              <Search24Regular />
              <Text size={400} weight="semibold">
                搜索
              </Text>
            </div>
            <div className="gs-header-actions">
              {currentPaper && (
                <>
                  {/* Index mode toggle — only show when OCR is enabled */}
                  {ocrEnabled && (
                    <div style={{ display: "flex", gap: "2px", marginRight: "4px" }}>
                      <Tooltip
                        content="使用 PDF 直接提取的文字建立索引（速度快，精度一般）"
                        relationship="label"
                      >
                        <Button
                          size="small"
                          appearance={searchIndexMode === "pdf" ? "primary" : "subtle"}
                          icon={<DocumentText24Regular />}
                          onClick={() => onSearchIndexModeChange("pdf")}
                          disabled={indexing}
                        >
                          PDF
                        </Button>
                      </Tooltip>
                      <Tooltip
                        content="使用 OCR 识别的文字建立索引（速度慢，精度高）"
                        relationship="label"
                      >
                        <Button
                          size="small"
                          appearance={searchIndexMode === "ocr" ? "primary" : "subtle"}
                          icon={<Eye24Regular />}
                          onClick={() => onSearchIndexModeChange("ocr")}
                          disabled={indexing}
                        >
                          OCR
                        </Button>
                      </Tooltip>
                    </div>
                  )}
                  <Tooltip
                    content={
                      indexError
                        ? `索引失败: ${indexError}`
                        : indexing
                          ? "正在建立索引..."
                          : isIndexed
                            ? `点击重新建立索引（当前：${searchIndexMode === "ocr" ? "OCR" : "PDF"}）`
                            : `点击建立文档索引（${searchIndexMode === "ocr" ? "OCR" : "PDF"}）`
                    }
                    relationship="label"
                  >
                    <Button
                      size="small"
                      appearance={indexError ? "outline" : isIndexed && !indexing ? "subtle" : "outline"}
                      style={indexError ? { borderColor: "#e74c3c", color: "#e74c3c" } : undefined}
                      icon={
                        indexing ? (
                          <Spinner size="extra-tiny" appearance="inverted" />
                        ) : (
                          <Database24Regular />
                        )
                      }
                      onClick={handleIndex}
                      disabled={indexing}
                    >
                      {indexing
                        ? ocrIndexProgress
                          ? `${ocrIndexProgress.page + 1}/${ocrIndexProgress.total_pages}`
                          : "索引中..."
                        : indexError
                          ? "失败"
                          : isIndexed
                            ? "已索引"
                            : searchIndexMode === "ocr"
                              ? "OCR 索引"
                              : "建立索引"}
                    </Button>
                  </Tooltip>
                </>
              )}
              <Button
                icon={<Dismiss20Regular />}
                appearance="subtle"
                size="small"
                onClick={onClose}
              />
            </div>
          </div>

          {/* Mode toggle + Search input */}
          <div className="gs-mode-row">
            <Button
              size="small"
              appearance={!isSemantic ? "primary" : "subtle"}
              icon={<Search24Regular />}
              onClick={() => {
                setMode("fulltext");
                setSelectedIdx(0);
              }}
            >
              全文搜索
            </Button>
            <Button
              size="small"
              appearance={isSemantic ? "primary" : "subtle"}
              icon={<Sparkle24Regular />}
              onClick={() => {
                setMode("semantic");
                setSelectedIdx(0);
              }}
              disabled={!llmSettings}
            >
              语义搜索
            </Button>
          </div>

          {/* Search input */}
          <div className="gs-search-bar">
            <Search24Regular className="gs-search-icon" />
            <Input
              ref={inputRef}
              className="gs-search-input"
              appearance="outline"
              size="large"
              value={query}
              onChange={(_, d) => setQuery(d.value)}
              placeholder={
                hasNoDoc
                  ? "请先打开一个 PDF 文档..."
                  : isSemantic
                    ? "输入搜索意图（如：实验部分、方法论、结论...）"
                    : "搜索当前文档..."
              }
              disabled={hasNoDoc}
              contentAfter={
                <>
                  {isSemantic &&
                    query.trim() &&
                    !semanticSearching &&
                    semanticResults.length === 0 && (
                      <Button
                        size="small"
                        appearance="primary"
                        icon={<Sparkle24Regular />}
                        onClick={() => runSemanticSearch(query)}
                        disabled={hasNoDoc}
                      >
                        搜索
                      </Button>
                    )}
                  {semanticSearching && (
                    <Spinner size="extra-tiny" appearance="inverted" />
                  )}
                  {query && !semanticSearching && (
                    <Button
                      icon={<Dismiss20Regular />}
                      appearance="subtle"
                      size="small"
                      onClick={() => {
                        setQuery("");
                        setSemanticResults([]);
                        setSemanticStatus("");
                      }}
                    />
                  )}
                </>
              }
            />
          </div>
        </div>

          {/* Semantic search presets — between header and body */}
          {isSemantic && !query.trim() && (
            <div className="gs-presets" style={{ display: "flex", flexWrap: "wrap", gap: "4px", padding: "8px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
              {[
                "摘要", "引言", "相关工作", "方法论",
                "实验部分", "结果与讨论", "结论", "未来工作",
              ].map((preset) => (
                <Button
                  key={preset}
                  size="small"
                  appearance="outline"
                  onClick={() => {
                    setQuery(preset);
                    setSelectedIdx(0);
                    runSemanticSearch(preset);
                  }}
                  disabled={hasNoDoc}
                >
                  {preset}
                </Button>
              ))}
            </div>
          )}

          {/* ── Results body ─────────────────────────────────── */}
        <div className="gs-body" ref={resultsListRef}>
          {/* No document open */}
          {hasNoDoc && (
            <div className="gs-status">
              <Text size={200}>请先打开一个 PDF 文档再进行搜索</Text>
            </div>
          )}

          {/* Loading */}
          {isLoading && (
            <div className="gs-status">
              <Spinner size="small" appearance="inverted" />
              <Text size={200}>
                {semanticStatus || (isSemantic ? "AI 正在分析..." : "搜索中...")}
              </Text>
            </div>
          )}

          {/* Indexing progress / error */}
          {indexing && !ocrIndexProgress && (
            <div className="gs-status">
              <Spinner size="small" appearance="inverted" />
              <Text size={200}>正在准备索引...</Text>
            </div>
          )}
          {ocrIndexProgress && (
            <div className="gs-status" style={{ gap: "6px" }}>
              {indexing && <Spinner size="small" appearance="inverted" />}
              <Text size={200}>{ocrIndexProgress.message}</Text>
              <div style={{ width: "100%", padding: "0 16px" }}>
                <ProgressBar
                  value={
                    ocrIndexProgress.status === "done" ? 1
                    : ocrIndexProgress.total_pages > 0
                      ? (ocrIndexProgress.page + (ocrIndexProgress.total_paragraphs > 0 ? ocrIndexProgress.paragraph / ocrIndexProgress.total_paragraphs : 0)) / ocrIndexProgress.total_pages
                      : 0
                  }
                  thickness="large"
                  color={indexing ? "brand" : "success"}
                />
              </div>
              <Text size={100} style={{ opacity: 0.7 }}>
                第 {ocrIndexProgress.page + 1} / {ocrIndexProgress.total_pages} 页
                {ocrIndexProgress.total_paragraphs > 0 &&
                  ` · 段落 ${ocrIndexProgress.paragraph} / ${ocrIndexProgress.total_paragraphs}`}
              </Text>
            </div>
          )}
          {indexError && !indexing && (
            <div className="gs-status" style={{ gap: "4px" }}>
              <Text size={200} style={{ color: "#e74c3c" }}>
                索引失败: {indexError}
              </Text>
              <Text size={100} style={{ opacity: 0.7 }}>
                请检查 OCR 模型是否已正确加载，或查看 DevTools Console 获取详细日志
              </Text>
            </div>
          )}

          {/* Empty with query (not loading) */}
          {!isLoading && query.trim() && displayResults.length === 0 && !hasNoDoc && (
            <div className="gs-status">
              <Text size={200}>
                {mode === "fulltext" && !isIndexed
                  ? '请先点击"建立索引"按钮'
                  : semanticStatus || "未找到匹配结果"}
              </Text>
            </div>
          )}

          {/* Full-text results */}
          {!isLoading &&
            mode === "fulltext" &&
            results.map((r, idx) => (
              <div
                key={`ft-${r.page_index}-${idx}`}
                className={`gs-result ${idx === selectedIdx ? "selected" : ""}`}
                onClick={() => {
                  onOpenResult(r.page_index);
                  onClose();
                }}
                onMouseEnter={() => setSelectedIdx(idx)}
              >
                <div className="gs-result-header">
                  <Document20Regular className="gs-result-icon" />
                  <Badge appearance="filled" color="informative" size="small">
                    第 {r.page_index + 1} 页
                  </Badge>
                </div>
                <div
                  className="gs-result-snippet"
                  dangerouslySetInnerHTML={{ __html: renderLatexToHtml(r.snippet) }}
                />
              </div>
            ))}

          {/* Semantic results */}
          {!isLoading &&
            isSemantic &&
            semanticResults.map((r, idx) => (
              <div
                key={`sem-${r.page_index}-${idx}`}
                className={`gs-result ${idx === selectedIdx ? "selected" : ""}`}
                onClick={() => {
                  onOpenResult(r.page_index);
                  onClose();
                }}
                onMouseEnter={() => setSelectedIdx(idx)}
              >
                <div className="gs-result-header">
                  <Document20Regular className="gs-result-icon" />
                  <Badge appearance="filled" color="informative" size="small">
                    第 {r.page_index + 1} 页
                  </Badge>
                  {r.score > 0 && (
                    <Badge
                      appearance="filled"
                      size="small"
                      color={
                        r.score >= 7
                          ? "success"
                          : r.score >= 4
                            ? "warning"
                            : "informative"
                      }
                    >
                      {r.score}分相关
                    </Badge>
                  )}
                </div>
                {r.snippet && (
                  <div
                    className="gs-result-snippet"
                    dangerouslySetInnerHTML={{
                      __html: renderLatexToHtml(
                        r.snippet.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                      ),
                    }}
                  />
                )}
                {r.reasoning && (
                  <div className="gs-result-reason">
                    <Sparkle24Regular />
                    <Text size={100}>{r.reasoning}</Text>
                  </div>
                )}
              </div>
            ))}

          {/* Hint / empty state */}
          {!isLoading && !query.trim() && !hasNoDoc && (
            <div className="gs-hint">
              <Text size={400} weight="semibold" className="gs-hint-title">
                文档内搜索
              </Text>
              <Text size={200} className="gs-hint-desc">
                在当前打开的文档中搜索内容。全文搜索精确匹配关键词，语义搜索理解你的意图找到相关段落。
              </Text>
              {!isIndexed && currentPaper && (
                <div className="gs-hint-action">
                  <ArrowRight16Regular />
                  <Text size={200}>
                    点击右上方{searchIndexMode === "ocr" ? `\u201COCR 索引\u201D` : `\u201C建立索引\u201D`}按钮以启用全文搜索
                  </Text>
                </div>
              )}
              <div className="gs-hint-keys">
                <kbd>↑↓</kbd> 导航 <kbd>Enter</kbd> 跳转 <kbd>Esc</kbd> 关闭
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────── */}
        <div className="gs-footer">
          <Text size={100} className="gs-footer-text">
            {query.trim()
              ? `${displayResults.length} 条结果`
              : currentPaper
                ? isIndexed
                  ? `已索引（${searchIndexMode === "ocr" ? "OCR" : "PDF"}）`
                  : "未索引"
                : "无文档"}
          </Text>
          <Text size={100} className="gs-footer-text">
            <kbd>↑↓</kbd> 导航 · <kbd>Enter</kbd> 跳转 · <kbd>Esc</kbd> 关闭
          </Text>
        </div>
      </div>
    </div>
  );
}
