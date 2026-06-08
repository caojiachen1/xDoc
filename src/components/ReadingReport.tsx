import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Spinner } from "@fluentui/react-components";
import { Dismiss24Regular } from "@fluentui/react-icons";
import { BookOpen, Clock, BarChart3, Calendar, Trophy } from "lucide-react";
import "./ReadingReport.css";

interface PaperReadingRank {
  paper_id: string;
  paper_name: string;
  total_seconds: number;
}

interface DailyReading {
  date: string;
  total_seconds: number;
}

interface HourlyReading {
  hour: number;
  total_seconds: number;
}

interface ReadingReport {
  total_seconds: number;
  ranking: PaperReadingRank[];
  daily: DailyReading[];
  hourly: HourlyReading[];
}

interface Props {
  open: boolean;
  onClose: () => void;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0分钟";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}小时${minutes}分钟`;
  if (hours > 0) return `${hours}小时`;
  return `${minutes}分钟`;
}

function formatShortDuration(seconds: number): string {
  if (seconds <= 0) return "0m";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

export default function ReadingReportDialog({ open, onClose }: Props) {
  const [report, setReport] = useState<ReadingReport | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    invoke<ReadingReport>("reading_get_report")
      .then(setReport)
      .catch(e => console.error("[ReadingReport]", e))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const maxDaily = report ? Math.max(...report.daily.map(d => d.total_seconds), 1) : 1;
  const maxHourly = report ? Math.max(...report.hourly.map(h => h.total_seconds), 1) : 1;
  const maxRank = report && report.ranking.length > 0 ? report.ranking[0].total_seconds : 1;

  return (
    <div className="rr-overlay" onClick={onClose}>
      <div className="rr-window" onClick={e => e.stopPropagation()}>

        {/* ── Header ── */}
        <div className="rr-header">
          <div className="rr-header-title">
            <BookOpen />
            阅读报告
          </div>
          <Button appearance="transparent" icon={<Dismiss24Regular />} onClick={onClose} />
        </div>

        {/* ── Body ── */}
        <div className="rr-body">
          {loading && (
            <div style={{ display: "flex", justifyContent: "center", padding: 40 }}>
              <Spinner label="加载中..." />
            </div>
          )}

          {!loading && report && (
            <>
              {/* ── Total reading time ── */}
              <div className="rr-total-card">
                <Clock />
                <div>
                  <div className="rr-total-label">总阅读时长</div>
                  <div className="rr-total-value">{formatDuration(report.total_seconds)}</div>
                </div>
              </div>

              {/* ── Paper ranking ── */}
              <div>
                <div className="rr-section-title">
                  <Trophy />
                  文献阅读时长排行
                </div>
                {report.ranking.length === 0 ? (
                  <div className="rr-empty">暂无阅读记录</div>
                ) : (
                  <div className="rr-rank-list">
                    {report.ranking.slice(0, 10).map((item, idx) => {
                      const badgeClass = idx === 0 ? "gold" : idx === 1 ? "silver" : idx === 2 ? "bronze" : "";
                      return (
                        <div className="rr-rank-item" key={item.paper_id}>
                          <div className={`rr-rank-badge ${badgeClass}`}>{idx + 1}</div>
                          <div className="rr-rank-info">
                            <div className="rr-rank-name">{item.paper_name}</div>
                            <div className="rr-rank-bar-bg">
                              <div
                                className="rr-rank-bar-fill"
                                style={{ width: `${Math.max((item.total_seconds / maxRank) * 100, 2)}%` }}
                              />
                            </div>
                          </div>
                          <div className="rr-rank-time">{formatShortDuration(item.total_seconds)}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ── Daily distribution (last 30 days) ── */}
              <div>
                <div className="rr-section-title">
                  <Calendar />
                  每日阅读时长（近30天）
                </div>
                {report.daily.length === 0 ? (
                  <div className="rr-empty">暂无数据</div>
                ) : (
                  <div className="rr-chart">
                    {report.daily.map(d => {
                      const pct = (d.total_seconds / maxDaily) * 100;
                      const dateLabel = d.date.slice(5);
                      return (
                        <div className="rr-chart-col" key={d.date}>
                          <div
                            className="rr-chart-bar"
                            title={`${d.date}: ${formatDuration(d.total_seconds)}`}
                            style={{ height: `${Math.max(pct, 2)}%` }}
                          />
                          <div className="rr-chart-label">{dateLabel}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ── Hourly distribution ── */}
              <div>
                <div className="rr-section-title">
                  <BarChart3 />
                  阅读时间点分布（按小时）
                </div>
                {report.hourly.length === 0 ? (
                  <div className="rr-empty">暂无数据</div>
                ) : (
                  <div className="rr-chart">
                    {Array.from({ length: 24 }, (_, h) => {
                      const item = report.hourly.find(x => x.hour === h);
                      const seconds = item?.total_seconds ?? 0;
                      const pct = (seconds / maxHourly) * 100;
                      return (
                        <div className="rr-chart-col" key={h}>
                          <div
                            className={`rr-chart-bar${seconds === 0 ? " empty" : ""}`}
                            title={`${h}:00 — ${formatDuration(seconds)}`}
                            style={{ height: `${Math.max(pct, seconds > 0 ? 4 : 0)}%` }}
                          />
                          <div className="rr-chart-label">
                            {h % 3 === 0 ? `${h}` : ""}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="rr-footer">
          <Button appearance="secondary" onClick={onClose}>关闭</Button>
        </div>
      </div>
    </div>
  );
}
