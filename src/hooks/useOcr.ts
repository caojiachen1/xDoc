/**
 * useOcr — OCR backend initialization, region recognition, and sentence splitting.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TextSegment } from "../types";
import { getOcrCacheText } from "../utils/paperDb";

/** Strips LLM special tokens (e.g. <|endofassistant|>, <s>, [INST]) from text. */
function cleanSpecialTokens(text: string): string {
  return text
    .replace(/<\|[^|]+\|>/g, "")   // <|endofassistant|>, <|im_end|>, etc.
    .replace(/<\/?s>/g, "")         // <s>, </s>
    .replace(/\[INST\]|\[\/INST\]/g, "");
}

/**
 * Removes chain-of-thought <think>...</think> content from OCR output.
 * Safe for streaming: operates on the full accumulated buffer each call so
 * tags split across chunks resolve correctly.
 */
function stripThinkBlocks(text: string): string {
  // Drop fully-closed think blocks (OvisOCR2 emits reasoning before the answer).
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Drop an unclosed <think> that is still being streamed.
  const open = out.toLowerCase().lastIndexOf("<think>");
  if (open !== -1) out = out.slice(0, open);
  // Hold back a trailing partial "<think>" opening tag so it doesn't flash.
  const lt = out.lastIndexOf("<");
  if (lt !== -1) {
    const tail = out.slice(lt).toLowerCase();
    if ("<think>".startsWith(tail) && tail.length < "<think>".length) {
      out = out.slice(0, lt);
    }
  }
  return out;
}

export function useOcr(
  ocrEnabled: boolean,
  ocrModelPath: string,
  ocrModelId: string,
  documentPath: string,
  pdfPageIndex: number,
  selectedParagraph: TextSegment | null,
  selectedParagraphPageRef: { current: number },
  paperId?: string,
) {
  const [ocrText, setOcrText] = useState("");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrInitialized, setOcrInitialized] = useState(false);
  const [ocrError, setOcrError] = useState("");
  const [splitParagraphWords, setSplitParagraphWords] = useState<string[]>([]);
  const [splitOcrText, setSplitOcrText] = useState("");

  // ── Initialize OCR backend ───────────────────────────────────────
  useEffect(() => {
    if (ocrEnabled && ocrModelPath) {
      setOcrError("");
      const modelId = ocrModelId || "glm-ocr";
      invoke<string>("init_ocr", { ocrModelPath, ocrModelId: modelId })
        .then((msg) => {
          console.log("[OCR] initialized:", msg);
          setOcrInitialized(true);
        })
        .catch((e) => {
          console.error("[OCR] init failed:", e);
          setOcrError(`OCR 初始化失败: ${String(e)}`);
          setOcrInitialized(false);
        });
    } else {
      setOcrInitialized(false);
    }
  }, [ocrEnabled, ocrModelPath, ocrModelId]);

  // ── Run OCR when a paragraph is selected ─────────────────────────
  useEffect(() => {
    if (!selectedParagraph || !ocrEnabled || !ocrInitialized || !documentPath) {
      setOcrText("");
      return;
    }
    if (selectedParagraphPageRef.current !== pdfPageIndex) return;

    let cancelled = false;
    setOcrLoading(true);
    setOcrError("");
    setOcrText("");

    // Try DB persistent cache first (only when paperId is available)
    const cachePromise = paperId
      ? getOcrCacheText(paperId, pdfPageIndex, selectedParagraph.xmin, selectedParagraph.ymin, selectedParagraph.xmax, selectedParagraph.ymax)
      : Promise.resolve(null);

    cachePromise
      .then((cached) => {
        if (cancelled) return null;
        if (cached != null && cached !== "") {
          // Cache hit — use cached text directly
          setOcrText(stripThinkBlocks(cached));
          setOcrLoading(false);
          return null; // signal: no OCR needed
        }
        // Cache miss — run OCR with streaming
        let rawBuffer = "";
        const unlistenPromise = listen<{ piece: string }>("ocr-stream-token", (event) => {
          if (!cancelled) {
            rawBuffer += event.payload.piece;
            setOcrText(cleanSpecialTokens(stripThinkBlocks(rawBuffer)));
          }
        });

        return invoke<{ text: string }>("run_ocr_region", {
          filePath: documentPath,
          pageIndex: pdfPageIndex,
          xmin: selectedParagraph.xmin,
          ymin: selectedParagraph.ymin,
          xmax: selectedParagraph.xmax,
          ymax: selectedParagraph.ymax,
          paperId: paperId ?? null,
        })
          .then((result) => { if (!cancelled) setOcrText(cleanSpecialTokens(stripThinkBlocks(result.text))); })
          .catch((e) => { if (!cancelled) setOcrError(`OCR 识别失败: ${String(e)}`); })
          .finally(() => {
            if (!cancelled) setOcrLoading(false);
            unlistenPromise.then(unlisten => unlisten());
          });
      })
      .catch((e) => {
        if (!cancelled) setOcrError(`OCR 缓存查询失败: ${String(e)}`);
      })
      .finally(() => {
        if (!cancelled) setOcrLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedParagraph, ocrEnabled, ocrInitialized, documentPath, pdfPageIndex, paperId]);

  // ── Sentence splitting for PDF paragraph text ────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!selectedParagraph?.text) { setSplitParagraphWords([]); return; }
    const rawText = selectedParagraph.text.replace(/[\r\n]+/g, "");
    invoke<string[]>("split_sentences", { text: rawText, language: "en" })
      .then((sentences) => {
        if (cancelled) return;
        const formattedText = sentences.join("\n");
        try {
          // @ts-ignore
          const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
          // @ts-ignore
          setSplitParagraphWords(Array.from(segmenter.segment(formattedText)).map((s: any) => s.segment));
        } catch {
          setSplitParagraphWords(formattedText.split(/(?=[\u4e00-\u9fa5])/));
        }
      })
      .catch(() => {
        if (cancelled) return;
        try {
          // @ts-ignore
          const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
          // @ts-ignore
          setSplitParagraphWords(Array.from(segmenter.segment(rawText)).map((s: any) => s.segment));
        } catch {
          setSplitParagraphWords(rawText.split(/(?=[\u4e00-\u9fa5])/));
        }
      });
    return () => { cancelled = true; };
  }, [selectedParagraph?.text]);

  // ── Sentence splitting for OCR text ──────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!ocrText) { setSplitOcrText(""); return; }
    const rawText = ocrText.replace(/[\r\n]+/g, "");
    invoke<string[]>("split_sentences", { text: rawText, language: "en" })
      .then((sentences) => { if (!cancelled) setSplitOcrText(sentences.join("\n")); })
      .catch(() => { if (!cancelled) setSplitOcrText(rawText); });
    return () => { cancelled = true; };
  }, [ocrText]);

  // ── Refresh OCR (ignore cache) ───────────────────────────────────
  const selectedParagraphRef = useRef(selectedParagraph);
  selectedParagraphRef.current = selectedParagraph;

  const refreshOcr = useCallback(() => {
    const para = selectedParagraphRef.current;
    if (!para || !ocrEnabled || !ocrInitialized || !documentPath) return;
    if (selectedParagraphPageRef.current !== pdfPageIndex) return;

    let cancelled = false;
    setOcrLoading(true);
    setOcrError("");
    setOcrText("");

    let rawBuffer = "";
    const unlistenPromise = listen<{ piece: string }>("ocr-stream-token", (event) => {
      if (!cancelled) {
        rawBuffer += event.payload.piece;
        setOcrText(cleanSpecialTokens(stripThinkBlocks(rawBuffer)));
      }
    });

    invoke<{ text: string }>("run_ocr_region", {
      filePath: documentPath,
      pageIndex: pdfPageIndex,
      xmin: para.xmin,
      ymin: para.ymin,
      xmax: para.xmax,
      ymax: para.ymax,
      paperId: paperId ?? null,
      forceRefresh: true,
    })
      .then((result) => { if (!cancelled) setOcrText(cleanSpecialTokens(stripThinkBlocks(result.text))); })
      .catch((e) => { if (!cancelled) setOcrError(`OCR 识别失败: ${String(e)}`); })
      .finally(() => {
        if (!cancelled) setOcrLoading(false);
        unlistenPromise.then(unlisten => unlisten());
      });

    return () => {
      cancelled = true;
      unlistenPromise.then(unlisten => unlisten());
    };
  }, [ocrEnabled, ocrInitialized, documentPath, pdfPageIndex, selectedParagraphPageRef, paperId]);

  return {
    ocrText, setOcrText,
    ocrLoading,
    ocrInitialized,
    ocrError,
    splitParagraphWords,
    splitOcrText,
    refreshOcr,
  };
}
