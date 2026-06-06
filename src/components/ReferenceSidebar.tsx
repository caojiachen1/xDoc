import { useState, useEffect, useCallback, useRef } from "react";
import {
  BookOpen,
  FileText,
  Users,
  Calendar,
  Hash,
  ExternalLink,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Library,
  Loader2,
  AlertCircle,
  Globe,
  Building2,
  Tag,
  ListTree,
  Image,
  Table,
} from "lucide-react";
import { resolveDoi, searchByTitle } from "../utils/crossrefResolver";
import { lookupJournalRanking, type JournalRanking } from "../utils/paperDb";
import type { PaperInfo } from "./HomePage";
import type { PaperMetadata } from "../utils/pdfMetadata";

// ── Grobid output interfaces (matching Rust backend) ────────────────────────
interface GrobidAuthorOutput {
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
  affiliation: string | null;
  identifier: string | null;
}
interface GrobidDateOutput {
  year: string | null;
  month: string | null;
  day: string | null;
  raw: string | null;
}
interface GrobidVenueOutput {
  name: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
}
interface GrobidMetadataOutput {
  title: string | null;
  authors: GrobidAuthorOutput[];
  abstract_text: string | null;
  date: GrobidDateOutput | null;
  doi: string | null;
  venue: GrobidVenueOutput | null;
  keywords: string[];
}
interface GrobidSectionOutput {
  title: string | null;
  level: number;
  content: string;
}
interface GrobidFigureOutput {
  id: string | null;
  caption: string | null;
  description: string | null;
}
interface GrobidTableOutput {
  id: string | null;
  caption: string | null;
  content: string | null;
}
interface GrobidRefOutput {
  id: string | null;
  title: string | null;
  authors: string[];
  year: string | null;
  month: string | null;
  day: string | null;
  date_raw: string | null;
  venue: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  doi: string | null;
  raw: string | null;
}
interface GrobidEquationOutput {
  id: string | null;
  content: string;
  description: string | null;
}
interface GrobidDocumentOutput {
  metadata: GrobidMetadataOutput;
  sections: GrobidSectionOutput[];
  figures: GrobidFigureOutput[];
  tables: GrobidTableOutput[];
  equations: GrobidEquationOutput[];
  references: GrobidRefOutput[];
}

// ── Legacy GrobidReference (from old API, kept for CrossRef enrichment) ──────
interface GrobidReference {
  title: string | null;
  authors: string[];
  year: string | null;
  journal: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  publisher: string | null;
  url: string | null;
  raw_text: string | null;
}

interface EnrichedReference extends GrobidReference {
  crossrefTitle?: string;
  crossrefAbstract?: string;
  crossrefDoi?: string;
  crossrefUrl?: string;
  crossrefAuthors?: string[];
  crossrefJournal?: string;
  crossrefDate?: string;
  enriching?: boolean;
  enriched?: boolean;
  expanded?: boolean;
  ranking?: JournalRanking | null;
  rankingLoading?: boolean;
}

type SidebarTab = "info" | "references" | "structure";

interface ReferenceSidebarProps {
  paper: PaperInfo | null;
  documentPath: string;
  width?: number;
  grobidDocument: GrobidDocumentOutput | null;
  grobidLoading: boolean;
  grobidError: string;
  onReparse?: () => void;
  onReparseStructure?: () => void;
}

export default function ReferenceSidebar({
  paper,
  documentPath: _documentPath,
  width,
  grobidDocument,
  grobidLoading,
  grobidError,
  onReparse,
  onReparseStructure,
}: ReferenceSidebarProps) {
  const [activeTab, setActiveTab] = useState<SidebarTab>("info");
  const [references, setReferences] = useState<EnrichedReference[]>([]);
  const [enrichingCount, setEnrichingCount] = useState(0);
  const [expandedSection, setExpandedSection] = useState<number | null>(null);
  const abortRef = useRef(false);

  const metadata: PaperMetadata | undefined = paper?.metadata;
  const grobidMeta = grobidDocument?.metadata;

  // Convert GrobidRefOutput to EnrichedReference for CrossRef enrichment
  useEffect(() => {
    if (!grobidDocument) {
      setReferences([]);
      return;
    }
    const refs: EnrichedReference[] = grobidDocument.references.map((r) => ({
      title: r.title,
      authors: r.authors,
      year: r.year,
      journal: r.venue,
      volume: r.volume,
      issue: r.issue,
      pages: r.pages,
      doi: r.doi,
      publisher: r.publisher,
      url: null,
      raw_text: r.raw,
      expanded: false,
    }));
    setReferences(refs);
  }, [grobidDocument]);

  // Enrich a single reference with CrossRef data
  const enrichReference = useCallback(
    async (index: number) => {
      const ref = references[index];
      if (!ref || ref.enriching || ref.enriched) return;

      setReferences((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], enriching: true };
        return next;
      });
      setEnrichingCount((c) => c + 1);

      try {
        let crossrefData: Partial<PaperMetadata> | null = null;
        if (ref.doi) {
          crossrefData = await resolveDoi(ref.doi);
        }
        if (!crossrefData && ref.title) {
          crossrefData = await searchByTitle(ref.title);
        }

        setReferences((prev) => {
          const next = [...prev];
          if (next[index]) {
            next[index] = {
              ...next[index],
              enriching: false,
              enriched: true,
              crossrefTitle: crossrefData?.title,
              crossrefAbstract: crossrefData?.abstract,
              crossrefDoi: crossrefData?.doi,
              crossrefUrl: crossrefData?.url,
              crossrefAuthors: crossrefData?.authors,
              crossrefJournal: crossrefData?.journal,
              crossrefDate: crossrefData?.date,
            };
          }
          return next;
        });
      } catch {
        setReferences((prev) => {
          const next = [...prev];
          if (next[index]) {
            next[index] = { ...next[index], enriching: false, enriched: true };
          }
          return next;
        });
      } finally {
        setEnrichingCount((c) => c - 1);
      }
    },
    [references]
  );

  // Enrich all references
  const enrichAll = useCallback(async () => {
    for (let i = 0; i < references.length; i++) {
      if (abortRef.current) break;
      if (!references[i].enriched && !references[i].enriching) {
        await enrichReference(i);
      }
    }
  }, [references, enrichReference]);

  // Toggle reference expansion
  const toggleExpand = (index: number) => {
    setReferences((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], expanded: !next[index].expanded };
      return next;
    });
  };

  // ── Journal ranking lookup ──────────────────────────────────────────────────
  // Cache for journal ranking lookups (shared across all references)
  const rankingCacheRef = useRef<Map<string, JournalRanking | null>>(new Map());
  // Track which (journal_name) combos have been looked up to avoid redundant calls
  const rankingLookedUpRef = useRef<Set<string>>(new Set());
  // Track which ref indices have been auto-enriched via CrossRef for ranking
  const autoEnrichedForRankingRef = useRef<Set<number>>(new Set());

  // Lookup rankings when references or their CrossRef journals change.
  // For refs without a ranking, auto-call CrossRef to get journal info, then re-query.
  useEffect(() => {
    if (references.length === 0) return;
    let cancelled = false;

    const lookupAll = async () => {
      for (let i = 0; i < references.length; i++) {
        if (cancelled) break;
        const ref = references[i];

        const journal = ref.crossrefJournal || ref.journal;

        // ── Step 1: If we have a journal, try direct ranking lookup ──
        if (journal) {
          const lookupKey = journal.toLowerCase().trim();
          if (!rankingLookedUpRef.current.has(lookupKey)) {
            // Check in-memory cache first
            if (rankingCacheRef.current.has(journal)) {
              const cached = rankingCacheRef.current.get(journal);
              rankingLookedUpRef.current.add(lookupKey);
              setReferences((prev) => {
                const next = [...prev];
                if (next[i]) next[i] = { ...next[i], ranking: cached ?? null };
                return next;
              });
            } else {
              // Query ranking
              setReferences((prev) => {
                const next = [...prev];
                if (next[i]) next[i] = { ...next[i], rankingLoading: true };
                return next;
              });
              try {
                const result = await lookupJournalRanking(journal);
                rankingCacheRef.current.set(journal, result);
                rankingLookedUpRef.current.add(lookupKey);
                if (!cancelled) {
                  setReferences((prev) => {
                    const next = [...prev];
                    if (next[i]) next[i] = { ...next[i], ranking: result, rankingLoading: false };
                    return next;
                  });
                }
              } catch {
                rankingCacheRef.current.set(journal, null);
                rankingLookedUpRef.current.add(lookupKey);
                if (!cancelled) {
                  setReferences((prev) => {
                    const next = [...prev];
                    if (next[i]) next[i] = { ...next[i], ranking: null, rankingLoading: false };
                    return next;
                  });
                }
              }
            }
          }
        }

        // ── Step 2: If still no ranking, auto-enrich via CrossRef title search ──
        if (cancelled) break;
        // Re-read current ref from state snapshot
        const currentRef = references[i];
        const hasRanking = currentRef.ranking !== undefined && currentRef.ranking !== null;
        const alreadyAutoEnriched = autoEnrichedForRankingRef.current.has(i);
        const hasTitle = currentRef.title && currentRef.title.length > 5;

        if (!hasRanking && !alreadyAutoEnriched && hasTitle && !currentRef.enriching) {
          autoEnrichedForRankingRef.current.add(i);

          // Mark as enriching
          setReferences((prev) => {
            const next = [...prev];
            if (next[i]) next[i] = { ...next[i], enriching: true };
            return next;
          });
          setEnrichingCount((c) => c + 1);

          try {
            // Try DOI first, then title search
            let crossrefData: Partial<PaperMetadata> | null = null;
            if (currentRef.doi) {
              crossrefData = await resolveDoi(currentRef.doi);
            }
            if (!crossrefData && currentRef.title) {
              crossrefData = await searchByTitle(currentRef.title);
            }

            if (crossrefData && !cancelled) {
              // Update ref with CrossRef data
              setReferences((prev) => {
                const next = [...prev];
                if (next[i]) {
                  next[i] = {
                    ...next[i],
                    enriching: false,
                    enriched: true,
                    crossrefTitle: crossrefData?.title || next[i].crossrefTitle,
                    crossrefAbstract: crossrefData?.abstract || next[i].crossrefAbstract,
                    crossrefDoi: crossrefData?.doi || next[i].crossrefDoi,
                    crossrefUrl: crossrefData?.url || next[i].crossrefUrl,
                    crossrefAuthors: crossrefData?.authors || next[i].crossrefAuthors,
                    crossrefJournal: crossrefData?.journal || next[i].crossrefJournal,
                    crossrefDate: crossrefData?.date || next[i].crossrefDate,
                  };
                }
                return next;
              });

              // If CrossRef gave us a journal, look up ranking
              const newJournal = crossrefData.journal;
              if (newJournal) {
                const newLookupKey = newJournal.toLowerCase().trim();
                if (!rankingLookedUpRef.current.has(newLookupKey)) {
                  try {
                    const ranking = await lookupJournalRanking(newJournal);
                    rankingCacheRef.current.set(newJournal, ranking);
                    rankingLookedUpRef.current.add(newLookupKey);
                    if (!cancelled) {
                      setReferences((prev) => {
                        const next = [...prev];
                        if (next[i]) next[i] = { ...next[i], ranking };
                        return next;
                      });
                    }
                  } catch {
                    // ranking lookup failure is non-fatal
                  }
                }
              }
            } else if (!cancelled) {
              // CrossRef returned nothing — just clear enriching state
              setReferences((prev) => {
                const next = [...prev];
                if (next[i]) next[i] = { ...next[i], enriching: false, enriched: true };
                return next;
              });
            }
          } catch {
            if (!cancelled) {
              setReferences((prev) => {
                const next = [...prev];
                if (next[i]) next[i] = { ...next[i], enriching: false, enriched: true };
                return next;
              });
            }
          } finally {
            setEnrichingCount((c) => c - 1);
          }
        }
      }
    };

    lookupAll();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [references.map(r => `${r.crossrefJournal || r.journal}|${r.enriched}|${r.ranking !== undefined && r.ranking !== null}`).join(",")]);

  const zoneLabel = (zone: number) => {
    const map: Record<number, string> = { 1: "一区", 2: "二区", 3: "三区", 4: "四区" };
    return map[zone] || `${zone}区`;
  };

  const renderRankingBadges = (ref: EnrichedReference) => {
    if (!ref.ranking) return null;
    const r = ref.ranking;
    return (
      <span className="ref-ranking-badges">
        <span className={`ranking-badge zone-${r.zone}`}>{zoneLabel(r.zone)}</span>
        {r.is_top && <span className="ranking-badge top-badge">Top</span>}
        {r.is_oa && <span className="ranking-badge oa-badge">OA</span>}
      </span>
    );
  };

  const formatAuthors = (authors: string[], max = 3): string => {
    if (authors.length === 0) return "";
    if (authors.length <= max) return authors.join(", ");
    return `${authors.slice(0, max).join(", ")} 等`;
  };

  const formatGrobidAuthors = (authors: GrobidAuthorOutput[]): string => {
    const names = authors
      .map((a) => a.full_name || [a.first_name, a.middle_name, a.last_name].filter(Boolean).join(" "))
      .filter(Boolean);
    if (names.length === 0) return "";
    if (names.length <= 3) return names.join(", ");
    return `${names.slice(0, 3).join(", ")} 等 (${names.length}人)`;
  };

  const displayTitle = (ref: EnrichedReference): string => {
    return ref.crossrefTitle || ref.title || ref.raw_text?.slice(0, 80) || "未知标题";
  };

  const displayAuthors = (ref: EnrichedReference): string[] => {
    return ref.crossrefAuthors && ref.crossrefAuthors.length > 0
      ? ref.crossrefAuthors
      : ref.authors;
  };

  const displayJournal = (ref: EnrichedReference): string | null => {
    return ref.crossrefJournal || ref.journal;
  };

  // ── Render helpers ────────────────────────────────────────────────────────
  const renderInfoTab = () => {
    // Prefer grobid metadata, fall back to paper.metadata
    const hasGrobidMeta = grobidMeta && (grobidMeta.title || grobidMeta.authors.length > 0 || grobidMeta.abstract_text);

    // Re-parse button component
    const reparseButton = onReparse ? (
      <button
        className="ref-reparse-btn"
        onClick={onReparse}
        disabled={grobidLoading}
        title="重新用 Grobid 解析当前文档"
      >
        <RefreshCw size={12} className={grobidLoading ? "spin" : ""} />
        {grobidLoading ? "解析中…" : "重新解析"}
      </button>
    ) : null;

    if (hasGrobidMeta) {
      return (
        <div className="ref-info-section">
          {reparseButton}
          {grobidMeta.title && (
            <div className="ref-info-title">{grobidMeta.title}</div>
          )}

          {grobidMeta.authors.length > 0 && (
            <div className="ref-info-field">
              <Users size={13} className="ref-info-icon" />
              <div className="ref-info-value">
                <div className="ref-info-label">作者</div>
                <div className="ref-info-text">
                  {formatGrobidAuthors(grobidMeta.authors)}
                </div>
              </div>
            </div>
          )}

          {grobidMeta.abstract_text && (
            <div className="ref-info-field">
              <FileText size={13} className="ref-info-icon" />
              <div className="ref-info-value">
                <div className="ref-info-label">摘要</div>
                <div className="ref-info-text ref-info-abstract">{grobidMeta.abstract_text}</div>
              </div>
            </div>
          )}

          {grobidMeta.venue?.name && (
            <div className="ref-info-field">
              <Building2 size={13} className="ref-info-icon" />
              <div className="ref-info-value">
                <div className="ref-info-label">期刊/会议</div>
                <div className="ref-info-text">{grobidMeta.venue.name}</div>
              </div>
            </div>
          )}

          {grobidMeta.venue?.publisher && (
            <div className="ref-info-field">
              <Globe size={13} className="ref-info-icon" />
              <div className="ref-info-value">
                <div className="ref-info-label">出版社</div>
                <div className="ref-info-text">{grobidMeta.venue.publisher}</div>
              </div>
            </div>
          )}

          {grobidMeta.date && (
            <div className="ref-info-field">
              <Calendar size={13} className="ref-info-icon" />
              <div className="ref-info-value">
                <div className="ref-info-label">日期</div>
                <div className="ref-info-text">
                  {[grobidMeta.date.year, grobidMeta.date.month, grobidMeta.date.day]
                    .filter(Boolean)
                    .join("-") || grobidMeta.date.raw || ""}
                </div>
              </div>
            </div>
          )}

          {(grobidMeta.venue?.volume || grobidMeta.venue?.issue || grobidMeta.venue?.pages) && (
            <div className="ref-info-field">
              <Hash size={13} className="ref-info-icon" />
              <div className="ref-info-value">
                <div className="ref-info-label">卷/期/页</div>
                <div className="ref-info-text">
                  {[
                    grobidMeta.venue.volume && `Vol. ${grobidMeta.venue.volume}`,
                    grobidMeta.venue.issue && `No. ${grobidMeta.venue.issue}`,
                    grobidMeta.venue.pages && `pp. ${grobidMeta.venue.pages}`,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </div>
              </div>
            </div>
          )}

          {grobidMeta.doi && (
            <div className="ref-info-field">
              <ExternalLink size={13} className="ref-info-icon" />
              <div className="ref-info-value">
                <div className="ref-info-label">DOI</div>
                <div className="ref-info-text">
                  <a
                    href={`https://doi.org/${grobidMeta.doi}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ref-info-link"
                  >
                    {grobidMeta.doi}
                  </a>
                </div>
              </div>
            </div>
          )}

          {grobidMeta.keywords.length > 0 && (
            <div className="ref-info-field">
              <Tag size={13} className="ref-info-icon" />
              <div className="ref-info-value">
                <div className="ref-info-label">关键词</div>
                <div className="ref-info-tags">
                  {grobidMeta.keywords.map((kw, i) => (
                    <span key={i} className="ref-info-tag">{kw}</span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Grobid author details with affiliations */}
          {grobidMeta.authors.some(a => a.affiliation || a.email || a.identifier) && (
            <div className="ref-info-field">
              <Users size={13} className="ref-info-icon" />
              <div className="ref-info-value">
                <div className="ref-info-label">作者详情</div>
                <div className="ref-info-text" style={{ fontSize: 12 }}>
                  {grobidMeta.authors.map((a, i) => {
                    const name = a.full_name || [a.first_name, a.last_name].filter(Boolean).join(" ") || "未知";
                    const parts = [name];
                    if (a.affiliation) parts.push(a.affiliation);
                    if (a.email) parts.push(a.email);
                    if (a.identifier) parts.push(`ORCID: ${a.identifier}`);
                    return <div key={i} style={{ marginBottom: 4 }}>{parts.join(" · ")}</div>;
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    // Fallback to paper.metadata
    if (metadata) {
      return (
        <div className="ref-info-section">
          {metadata.title && (
            <div className="ref-info-title">{metadata.title}</div>
          )}
          {metadata.authors && metadata.authors.length > 0 && (
            <div className="ref-info-field">
              <Users size={13} className="ref-info-icon" />
              <div className="ref-info-value">
                <div className="ref-info-label">作者</div>
                <div className="ref-info-text">{metadata.authors.join(", ")}</div>
              </div>
            </div>
          )}
          {metadata.abstract && (
            <div className="ref-info-field">
              <FileText size={13} className="ref-info-icon" />
              <div className="ref-info-value">
                <div className="ref-info-label">摘要</div>
                <div className="ref-info-text ref-info-abstract">{metadata.abstract}</div>
              </div>
            </div>
          )}
          {metadata.journal && (
            <div className="ref-info-field">
              <Building2 size={13} className="ref-info-icon" />
              <div className="ref-info-value">
                <div className="ref-info-label">期刊</div>
                <div className="ref-info-text">{metadata.journal}</div>
              </div>
            </div>
          )}
          {metadata.doi && (
            <div className="ref-info-field">
              <ExternalLink size={13} className="ref-info-icon" />
              <div className="ref-info-value">
                <div className="ref-info-label">DOI</div>
                <div className="ref-info-text">
                  <a href={`https://doi.org/${metadata.doi}`} target="_blank" rel="noopener noreferrer" className="ref-info-link">
                    {metadata.doi}
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="ref-empty">
        <BookOpen size={28} style={{ opacity: 0.3, marginBottom: 8 }} />
        <div>等待 Grobid 解析…</div>
        <div className="ref-empty-hint">打开 PDF 后自动提取文献信息</div>
        {reparseButton}
      </div>
    );
  };

  const renderReferencesTab = () => {
    return (
      <div className="ref-refs-section">
        {/* Toolbar */}
        <div className="ref-refs-toolbar">
          <span className="ref-refs-count">
            {references.length > 0
              ? `${references.length} 篇参考文献`
              : grobidLoading
              ? "解析中…"
              : "未提取"}
          </span>
          <div className="ref-refs-actions">
            {references.length > 0 && (
              <button
                className="ref-refs-btn"
                onClick={enrichAll}
                disabled={enrichingCount > 0}
                title="通过 CrossRef 补全所有文献信息"
              >
                <RefreshCw size={12} className={enrichingCount > 0 ? "spin" : ""} />
                {enrichingCount > 0 ? `补全中 (${enrichingCount})` : "CrossRef 补全"}
              </button>
            )}
          </div>
        </div>

        {/* Loading state */}
        {grobidLoading && (
          <div className="ref-loading">
            <Loader2 size={20} className="spin" />
            <span>正在用 Grobid 解析参考文献…</span>
          </div>
        )}

        {/* Error state */}
        {grobidError && (
          <div className="ref-error">
            <AlertCircle size={14} />
            <span>{grobidError}</span>
          </div>
        )}

        {/* Empty state */}
        {!grobidLoading && references.length === 0 && !grobidError && (
          <div className="ref-empty">
            <Library size={28} style={{ opacity: 0.3, marginBottom: 8 }} />
            <div>暂无参考文献</div>
            <div className="ref-empty-hint">打开 PDF 后自动提取</div>
          </div>
        )}

        {/* Reference list */}
        <div className="ref-list">
          {references.map((ref, idx) => (
            <div key={idx} className={`ref-item ${ref.expanded ? "expanded" : ""}`}>
              <div className="ref-item-header" onClick={() => toggleExpand(idx)}>
                <span className="ref-item-index">{idx + 1}</span>
                <div className="ref-item-title">{displayTitle(ref)}</div>
                {ref.expanded ? (
                  <ChevronDown size={14} className="ref-item-chevron" />
                ) : (
                  <ChevronRight size={14} className="ref-item-chevron" />
                )}
              </div>

              {/* Compact info row */}
              <div className="ref-item-meta">
                {displayAuthors(ref).length > 0 && (
                  <span className="ref-item-authors">
                    {formatAuthors(displayAuthors(ref))}
                  </span>
                )}
                {ref.year && <span className="ref-item-year">{ref.year}</span>}
                {displayJournal(ref) && (
                  <span className="ref-item-journal">{displayJournal(ref)}</span>
                )}
                {renderRankingBadges(ref)}
              </div>

              {/* Expanded details */}
              {ref.expanded && (
                <div className="ref-item-details">
                  {ref.crossrefAbstract && (
                    <div className="ref-detail-abstract">
                      <div className="ref-detail-label">摘要</div>
                      <div className="ref-detail-text">{ref.crossrefAbstract}</div>
                    </div>
                  )}

                  <div className="ref-detail-grid">
                    {(ref.crossrefDoi || ref.doi) && (
                      <div className="ref-detail-item">
                        <span className="ref-detail-label">DOI</span>
                        <a
                          href={`https://doi.org/${ref.crossrefDoi || ref.doi}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ref-info-link"
                        >
                          {ref.crossrefDoi || ref.doi}
                        </a>
                      </div>
                    )}
                    {(ref.volume || ref.issue) && (
                      <div className="ref-detail-item">
                        <span className="ref-detail-label">卷/期</span>
                        <span>
                          {ref.volume && `Vol. ${ref.volume}`}
                          {ref.volume && ref.issue && " "}
                          {ref.issue && `No. ${ref.issue}`}
                        </span>
                      </div>
                    )}
                    {ref.pages && (
                      <div className="ref-detail-item">
                        <span className="ref-detail-label">页码</span>
                        <span>{ref.pages}</span>
                      </div>
                    )}
                    {ref.publisher && (
                      <div className="ref-detail-item">
                        <span className="ref-detail-label">出版社</span>
                        <span>{ref.publisher}</span>
                      </div>
                    )}
                  </div>

                  {/* Enrich button for individual reference */}
                  {!ref.enriched && !ref.enriching && (
                    <button
                      className="ref-enrich-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        enrichReference(idx);
                      }}
                    >
                      <RefreshCw size={11} />
                      CrossRef 补全
                    </button>
                  )}
                  {ref.enriching && (
                    <div className="ref-enriching">
                      <Loader2 size={11} className="spin" />
                      正在查询 CrossRef…
                    </div>
                  )}

                  {/* Raw text fallback */}
                  {ref.raw_text && !ref.crossrefAbstract && (
                    <div className="ref-detail-raw">
                      <div className="ref-detail-label">原始文本</div>
                      <div className="ref-detail-text ref-detail-raw-text">
                        {ref.raw_text}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderStructureTab = () => {
    // Structure-only re-parse button (does not re-parse references)
    const reparseStructBtn = onReparseStructure ? (
      <button
        className="ref-reparse-btn"
        onClick={onReparseStructure}
        disabled={grobidLoading}
        title="仅重新解析文档结构（章节/图片/表格），不重新解析参考文献"
      >
        <RefreshCw size={12} className={grobidLoading ? "spin" : ""} />
        {grobidLoading ? "解析中…" : "重新解析结构"}
      </button>
    ) : null;

    if (!grobidDocument) {
      return (
        <div className="ref-empty">
          <ListTree size={28} style={{ opacity: 0.3, marginBottom: 8 }} />
          <div>等待解析…</div>
          {reparseStructBtn}
        </div>
      );
    }

    const { sections, figures, tables, equations } = grobidDocument;
    const hasStructure = sections.length > 0 || figures.length > 0 || tables.length > 0 || (equations && equations.length > 0);

    if (!hasStructure) {
      return (
        <div className="ref-empty">
          <ListTree size={28} style={{ opacity: 0.3, marginBottom: 8 }} />
          <div>未检测到文档结构</div>
          <div className="ref-empty-hint">部分 PDF 可能无法提取完整结构</div>
          {reparseStructBtn}
        </div>
      );
    }

    // Color palette for section depth levels
    const levelColors = ["#2196F3", "#4CAF50", "#FF9800", "#9C27B0", "#F44336", "#00BCD4"];
    const getLevelColor = (level: number) => levelColors[(level - 1) % levelColors.length];

    return (
      <div className="ref-refs-section">
        {/* Toolbar */}
        <div className="ref-refs-toolbar">
          <span className="ref-refs-count">
            {sections.length > 0 && `${sections.length} 章节`}
            {figures.length > 0 && ` · ${figures.length} 图片`}
            {tables.length > 0 && ` · ${tables.length} 表格`}
            {equations && equations.length > 0 && ` · ${equations.length} 公式`}
          </span>
          {reparseStructBtn}
        </div>

        {/* Loading overlay */}
        {grobidLoading && (
          <div className="ref-loading">
            <Loader2 size={20} className="spin" />
            <span>正在重新解析文档结构…</span>
          </div>
        )}

        <div className="ref-list">
          {/* ── Document Structure Tree ── */}
          {sections.length > 0 && (
            <>
              <div className="structure-section-header">
                <ListTree size={13} />
                <span>章节结构</span>
              </div>
              {sections.map((sec, idx) => {
                const depth = Math.max(0, sec.level - 1);
                const color = getLevelColor(sec.level);
                return (
                  <div
                    key={`sec-${idx}`}
                    className={`structure-item ${expandedSection === idx ? "expanded" : ""}`}
                    style={{ paddingLeft: 8 + depth * 16 }}
                  >
                    <div
                      className="structure-item-header"
                      onClick={() => setExpandedSection(expandedSection === idx ? null : idx)}
                    >
                      {/* Depth indicator bar */}
                      <span
                        className="structure-level-bar"
                        style={{ backgroundColor: color }}
                      />
                      {/* Level badge */}
                      <span
                        className="structure-level-badge"
                        style={{ backgroundColor: color + "18", color, borderColor: color + "40" }}
                      >
                        H{sec.level}
                      </span>
                      {/* Section title */}
                      <div className="structure-item-title">
                        {sec.title || "未命名章节"}
                      </div>
                      {/* Expand chevron */}
                      {sec.content ? (
                        expandedSection === idx ? (
                          <ChevronDown size={14} className="ref-item-chevron" />
                        ) : (
                          <ChevronRight size={14} className="ref-item-chevron" />
                        )
                      ) : null}
                    </div>
                    {/* Expanded content preview */}
                    {expandedSection === idx && sec.content && (
                      <div className="structure-item-content" style={{ borderLeftColor: color + "40" }}>
                        <div className="structure-content-text">
                          {sec.content.length > 600 ? sec.content.slice(0, 600) + "…" : sec.content}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {/* ── Figures ── */}
          {figures.length > 0 && (
            <>
              <div className="structure-section-header" style={{ marginTop: 12 }}>
                <Image size={13} />
                <span>图片 ({figures.length})</span>
              </div>
              {figures.map((fig, idx) => (
                <div key={`fig-${idx}`} className="structure-asset-item">
                  <span className="structure-asset-icon" style={{ backgroundColor: "#fff3e0", color: "#e65100" }}>
                    F
                  </span>
                  <span className="structure-asset-id">{fig.id || `图 ${idx + 1}`}</span>
                  <span className="structure-asset-caption">{fig.caption || fig.description || "无标题"}</span>
                </div>
              ))}
            </>
          )}

          {/* ── Tables ── */}
          {tables.length > 0 && (
            <>
              <div className="structure-section-header" style={{ marginTop: 12 }}>
                <Table size={13} />
                <span>表格 ({tables.length})</span>
              </div>
              {tables.map((tbl, idx) => (
                <div key={`tbl-${idx}`} className="structure-asset-item">
                  <span className="structure-asset-icon" style={{ backgroundColor: "#e8f5e9", color: "#2e7d32" }}>
                    T
                  </span>
                  <span className="structure-asset-id">{tbl.id || `表 ${idx + 1}`}</span>
                  <span className="structure-asset-caption">{tbl.caption || "无标题"}</span>
                </div>
              ))}
            </>
          )}

          {/* ── Equations ── */}
          {equations && equations.length > 0 && (
            <>
              <div className="structure-section-header" style={{ marginTop: 12 }}>
                <Hash size={13} />
                <span>公式 ({equations.length})</span>
              </div>
              {equations.map((eq, idx) => (
                <div key={`eq-${idx}`} className="structure-asset-item">
                  <span className="structure-asset-icon" style={{ backgroundColor: "#ede7f6", color: "#4527a0" }}>
                    E
                  </span>
                  <span className="structure-asset-id">{eq.id || `式 ${idx + 1}`}</span>
                  <span className="structure-asset-caption">{eq.description || eq.content?.slice(0, 60) || "无描述"}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="ref-sidebar" style={width ? { width } : undefined}>
      {/* Header */}
      <div className="ref-sidebar-header">
        <div className="ref-sidebar-tabs">
          <button
            className={`ref-sidebar-tab ${activeTab === "info" ? "active" : ""}`}
            onClick={() => setActiveTab("info")}
          >
            <BookOpen size={13} />
            <span>文献信息</span>
          </button>
          <button
            className={`ref-sidebar-tab ${activeTab === "references" ? "active" : ""}`}
            onClick={() => setActiveTab("references")}
          >
            <Library size={13} />
            <span>参考文献</span>
            {references.length > 0 && (
              <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>
                ({references.length})
              </span>
            )}
          </button>
          <button
            className={`ref-sidebar-tab ${activeTab === "structure" ? "active" : ""}`}
            onClick={() => setActiveTab("structure")}
          >
            <ListTree size={13} />
            <span>结构</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="ref-sidebar-content">
        {activeTab === "info" && renderInfoTab()}
        {activeTab === "references" && renderReferencesTab()}
        {activeTab === "structure" && renderStructureTab()}
      </div>
    </div>
  );
}
