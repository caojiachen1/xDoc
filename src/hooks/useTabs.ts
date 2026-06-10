/**
 * useTabs — Tab system management (open, close, switch, reorder).
 */
import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TabInfo } from "../types";
import { HOME_TAB_ID } from "../types";
import type { PaperInfo } from "../components/HomePage";

export function useTabs(
  onDocumentChange: (path: string | null) => void,
) {
  const [tabs, setTabs] = useState<TabInfo[]>([{ id: HOME_TAB_ID, title: "主页", type: "home" }]);
  const [activeTabId, setActiveTabId] = useState(HOME_TAB_ID);
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; tabId: string } | null>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);

  const openPaperTab = useCallback((paper: PaperInfo, loadPageData: (path: string, page: number) => Promise<void>, triggerGrobid: (path: string) => void, modelLoaded: boolean, scoreThreshold: number) => {
    const existingTab = tabs.find(t => t.type === "reader" && t.documentPath === paper.path);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      onDocumentChange(paper.path);
      loadPageData(paper.path, 0);
      triggerGrobid(paper.path);
      return;
    }

    const pathParts = paper.path.replace(/\\/g, "/").split("/");
    const fileName = pathParts[pathParts.length - 1] || paper.name;
    const tabTitle = fileName.replace(/\.[^.]+$/, "");

    const newTab: TabInfo = {
      id: `tab-${Date.now()}`,
      title: tabTitle,
      type: "reader",
      documentPath: paper.path,
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
    onDocumentChange(paper.path);

    if (paper.path.toLowerCase().endsWith(".pdf")) {
      loadPageData(paper.path, 0);
      if (modelLoaded) {
        invoke("prefetch_document", {
          filePath: paper.path,
          currentPage: 0,
          scoreThreshold,
        }).catch(() => { /* best-effort */ });
      }
      triggerGrobid(paper.path);
    }
  }, [tabs, onDocumentChange]);

  const closeTab = useCallback((tabId: string, clearDoc: () => void, loadPageData: (path: string, page: number) => Promise<void>, triggerGrobid: (path: string) => void, _modelLoaded: boolean, _scoreThreshold: number) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === tabId);
      if (idx === -1) return prev;
      const newTabs = prev.filter(t => t.id !== tabId);
      if (tabId === activeTabId) {
        const newActiveIdx = Math.min(idx, newTabs.length - 1);
        const newActive = newTabs[newActiveIdx];
        if (newActive) {
          setActiveTabId(newActive.id);
          if (newActive.type === "reader" && newActive.documentPath) {
            onDocumentChange(newActive.documentPath);
            loadPageData(newActive.documentPath, 0);
            triggerGrobid(newActive.documentPath);
          } else {
            onDocumentChange(null);
            clearDoc();
          }
        }
      }
      return newTabs;
    });
  }, [activeTabId, onDocumentChange]);

  const switchToTab = useCallback((tabId: string, clearDoc: () => void, loadPageData: (path: string, page: number) => Promise<void>, triggerGrobid: (path: string) => void) => {
    setActiveTabId(tabId);
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    if (tab.type === "reader" && tab.documentPath) {
      onDocumentChange(tab.documentPath);
      loadPageData(tab.documentPath, 0);
      triggerGrobid(tab.documentPath);
    } else {
      onDocumentChange(null);
      clearDoc();
    }
  }, [tabs, onDocumentChange]);

  const addHomeTab = useCallback((clearDoc: () => void) => {
    setTabs(prev => {
      const withoutHome = prev.filter(t => t.id !== HOME_TAB_ID);
      const homeTab: TabInfo = { id: HOME_TAB_ID, title: "主页", type: "home" };
      return [...withoutHome, homeTab];
    });
    setActiveTabId(HOME_TAB_ID);
    onDocumentChange(null);
    clearDoc();
  }, [onDocumentChange]);

  return {
    tabs, setTabs,
    activeTabId, setActiveTabId,
    dragTabId, setDragTabId,
    dragOverTabId, setDragOverTabId,
    dragStartRef, tabBarRef,
    openPaperTab, closeTab, switchToTab, addHomeTab,
  };
}
