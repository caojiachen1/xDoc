/**
 * useOcr — OCR backend initialization, region recognition, and sentence splitting.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TextSegment } from "../types";

export function useOcr(
  ocrEnabled: boolean,
  ocrModelPath: string,
  documentPath: string,
  pdfPageIndex: number,
  selectedParagraph: TextSegment | null,
  selectedParagraphPageRef: { current: number },
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
      invoke<string>("init_ocr", { ocrModelPath })
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
  }, [ocrEnabled, ocrModelPath]);

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

    const unlistenPromise = listen<{ piece: string }>("ocr-stream-token", (event) => {
      if (!cancelled) setOcrText(prev => prev + event.payload.piece);
    });

    invoke<{ text: string }>("run_ocr_region", {
      filePath: documentPath,
      pageIndex: pdfPageIndex,
      xmin: selectedParagraph.xmin,
      ymin: selectedParagraph.ymin,
      xmax: selectedParagraph.xmax,
      ymax: selectedParagraph.ymax,
    })
      .then((result) => { if (!cancelled) setOcrText(result.text); })
      .catch((e) => { if (!cancelled) setOcrError(`OCR 识别失败: ${String(e)}`); })
      .finally(() => {
        if (!cancelled) setOcrLoading(false);
        unlistenPromise.then(unlisten => unlisten());
      });

    return () => {
      cancelled = true;
      unlistenPromise.then(unlisten => unlisten());
    };
  }, [selectedParagraph, ocrEnabled, ocrInitialized, documentPath, pdfPageIndex]);

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

  return {
    ocrText, setOcrText,
    ocrLoading,
    ocrInitialized,
    ocrError,
    splitParagraphWords,
    splitOcrText,
  };
}
