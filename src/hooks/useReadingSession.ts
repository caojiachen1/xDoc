/**
 * useReadingSession — Tracks reading time per paper and flushes to DB.
 */
import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TabInfo } from "../types";
import type { PaperInfo } from "../components/HomePage";

export function useReadingSession(
  tabs: TabInfo[],
  activeTabId: string,
  papersList: PaperInfo[],
) {
  const readingSessionRef = useRef<{
    paperId: string;
    paperPath: string;
    startTime: Date;
  } | null>(null);

  const flushReadingSession = useCallback(async () => {
    const session = readingSessionRef.current;
    if (!session) return;
    const endTime = new Date();
    const durationSeconds = Math.floor((endTime.getTime() - session.startTime.getTime()) / 1000);
    readingSessionRef.current = null;

    if (durationSeconds < 5) return; // ignore very short sessions

    try {
      const paper = papersList.find(p => p.id === session.paperId);
      await invoke("reading_log_session", {
        req: {
          paper_id: session.paperId,
          paper_name: paper?.metadata?.title || paper?.name || "",
          start_time: session.startTime.toISOString(),
          end_time: endTime.toISOString(),
          duration_seconds: durationSeconds,
        },
      });
    } catch (e) {
      console.warn("[ReadingSession] failed to record reading time:", e);
    }

    // Update lastReadDate in memory
    const paper = papersList.find(p => p.id === session.paperId);
    if (paper) {
      paper.lastReadDate = endTime.toISOString();
    }
  }, [papersList]);

  useEffect(() => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab?.type === "reader" && activeTab.documentPath) {
      const paper = papersList.find(p => p.path === activeTab.documentPath);
      if (paper) {
        readingSessionRef.current = {
          paperId: paper.id,
          paperPath: paper.path,
          startTime: new Date(),
        };
      }
    }
  }, [activeTabId, tabs, papersList]);

  useEffect(() => {
    const onBlur = () => flushReadingSession();
    const onFocus = () => {
      const activeTab = tabs.find(t => t.id === activeTabId);
      if (activeTab?.type === "reader" && activeTab.documentPath) {
        const paper = papersList.find(p => p.path === activeTab.documentPath);
        if (paper) {
          readingSessionRef.current = {
            paperId: paper.id,
            paperPath: paper.path,
            startTime: new Date(),
          };
        }
      }
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      flushReadingSession();
    };
  }, [tabs, activeTabId, papersList, flushReadingSession]);

  return { readingSessionRef, flushReadingSession };
}
