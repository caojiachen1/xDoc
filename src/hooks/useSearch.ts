/**
 * useSearch — Single-paper search dialog state management.
 *
 * Provides dialog open/close and navigation to search results within
 * the currently open document.
 */
import { useCallback, useState } from "react";

export function useSearch(loadPageData: (path: string, page: number) => void) {
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);

  const openSearchDialog = useCallback(() => {
    setSearchDialogOpen(true);
  }, []);

  const closeSearchDialog = useCallback(() => {
    setSearchDialogOpen(false);
  }, []);

  /**
   * Navigate to a search result: jump to the specified page in the current document.
   */
  const handleOpenSearchResult = useCallback(
    (filePath: string, pageIndex: number) => {
      loadPageData(filePath, pageIndex);
      setSearchDialogOpen(false);
    },
    [loadPageData],
  );

  return {
    searchDialogOpen,
    openSearchDialog,
    closeSearchDialog,
    handleOpenSearchResult,
  };
}
