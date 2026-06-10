/**
 * useAiChat — AI chat interaction: streaming requests, Q&A, fulltext analysis.
 *
 * Manages: AI result streaming, Q&A follow-up history, fulltext extraction,
 * image analysis, and floating menu positioning.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { marked } from "marked";
import katex from "katex";
import type { LlmSettings } from "../components/SettingsDialog";
import type { TextSegment, DetectionResponse, ExtractContentResponse } from "../types";
import { isSegmentGarbage } from "../types";

export function useAiChat(
  llmSettings: LlmSettings,
  documentPath: string,
  _pdfPageIndex: number,
  pdfPageCount: number,
  isPdfSelected: boolean,
  scoreThreshold: number,
  modelLoaded: boolean,
  selectedParagraph: TextSegment | null,
  figureImageDataUrl: string,
  setErrorMessage: (msg: string) => void,
) {
  // ── AI state ─────────────────────────────────────────────────────
  const [aiAction, setAiAction] = useState("");
  const [aiResult, setAiResult] = useState("");
  const [qaHistory, setQaHistory] = useState<{ question: string; answer: string }[]>([]);
  const [qaInput, setQaInput] = useState("");
  const [qaLoading, setQaLoading] = useState(false);
  const qaSourceTextRef = useRef("");
  const aiScrollRef = useRef<HTMLDivElement>(null);

  // ── Fulltext memory ──────────────────────────────────────────────
  const fulltextAiResultRef = useRef("");
  const fulltextQaHistoryRef = useRef<{ question: string; answer: string }[]>([]);
  const fulltextSourceTextRef = useRef("");

  // ── Paragraph AI cache ───────────────────────────────────────────
  const paragraphAiCacheRef = useRef<Map<string, {
    aiAction: string;
    aiResult: string;
    qaHistory: { question: string; answer: string }[];
    qaSourceText: string;
  }>>(new Map());
  const selectedParagraphPageRef = useRef(-1);
  const selectedFigurePageRef = useRef(-1);

  // ── Fulltext extraction ──────────────────────────────────────────
  const [fulltextExtracting, setFulltextExtracting] = useState(false);
  const [fulltextProgress, setFulltextProgress] = useState({ current: 0, total: 0 });
  const fulltextCancelRef = useRef(false);

  // ── Floating menus ───────────────────────────────────────────────
  const [floatingMenu, setFloatingMenu] = useState<{ visible: boolean; x: number; y: number; selectedText: string }>({ visible: false, x: 0, y: 0, selectedText: "" });
  const [pdfFloatingMenu, setPdfFloatingMenu] = useState<{ visible: boolean; x: number; y: number; selectedText: string }>({ visible: false, x: 0, y: 0, selectedText: "" });
  const rightPaneRef = useRef<HTMLDivElement>(null);

  // ── AI streaming request ─────────────────────────────────────────
  const requestAiDescription = useCallback(async (text: string, action: string = "解读", imageDataUrl?: string): Promise<string> => {
    if (!text.trim() && !imageDataUrl) { setAiResult(""); return ""; }
    setAiResult(`正在请求 AI ${action}...`);
    setFloatingMenu({ visible: false, x: 0, y: 0, selectedText: "" });
    setQaHistory([]);
    setQaInput("");
    setQaLoading(false);
    qaSourceTextRef.current = text;

    const aiCacheKey = selectedParagraph
      ? `${selectedParagraphPageRef.current}:${selectedParagraph.text}`
      : null;
    const saveAiResultToCache = (finalResult: string) => {
      if (aiCacheKey && finalResult) {
        paragraphAiCacheRef.current.set(aiCacheKey, { aiAction: action, aiResult: finalResult, qaHistory: [], qaSourceText: text });
      }
    };

    const apiKey = llmSettings.vendorApiKeys[llmSettings.vendor];
    if (!apiKey || !llmSettings.baseUrl) { setAiResult(""); return ""; }

    try {
      const systemPrompts: Record<string, string> = {
        "解读": "简洁明了地解读以下文本，抓住核心要点，不要展开冗长分析。用中文回复。",
        "翻译": "将以下文本翻译成中文。如果原文已是中文，则翻译成英文。只输出翻译结果。",
        "摘要": "用一两句话摘要以下文本的核心内容。用中文回复。",
        "全文解读": "你是一位专业的文档分析专家。以下是从一份PDF文档中按页面顺序提取的全文内容。请提供全面深入的解读分析，包括：\n1. 文档主题和核心观点概述\n2. 主要内容结构梳理\n3. 关键论点和重要发现\n4. 总结评价\n请用中文回复，使用 Markdown 格式组织内容。",
      };
      const systemPrompt = systemPrompts[action] || systemPrompts["解读"];
      const baseUrl = llmSettings.baseUrl.replace(/\/+$/, "");

      const userContent: unknown = imageDataUrl
        ? [{ type: "text", text }, { type: "image_url", image_url: { url: imageDataUrl } }]
        : text;

      const requestBody: Record<string, unknown> = {
        model: llmSettings.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: 0.7,
        max_tokens: action === "全文解读" ? 8192 : 2048,
        stream: true,
      };
      if (llmSettings.vendor === "volcengine") requestBody.thinking = { type: "disabled" };

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API 请求失败 (${response.status}): ${errText}`);
      }

      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let result = "";
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data: ")) continue;
              const data = trimmed.slice(6);
              if (data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) { result += delta; setAiResult(result); }
              } catch { /* skip */ }
            }
          }
        } catch {
          if (result) { const interrupted = result + "\n\n[流式输出中断]"; setAiResult(interrupted); return interrupted; }
          else throw new Error("流式读取失败");
        }
        saveAiResultToCache(result);
        return result;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) { setAiResult(content); saveAiResultToCache(content); return content; }
      setAiResult("AI 返回了空内容"); saveAiResultToCache("AI 返回了空内容"); return "AI 返回了空内容";
    } catch (e) {
      const errMsg = `请求失败: ${String(e)}`;
      setAiResult(errMsg);
      return errMsg;
    }
  }, [llmSettings, selectedParagraph]);

  // ── Q&A submit ───────────────────────────────────────────────────
  const handleQaSubmit = useCallback(async () => {
    const question = qaInput.trim();
    if (!question || qaLoading) return;
    const apiKey = llmSettings.vendorApiKeys[llmSettings.vendor];
    if (!apiKey || !llmSettings.baseUrl) return;
    setQaInput("");
    setQaLoading(true);
    setQaHistory(prev => [...prev, { question, answer: "" }]);

    try {
      const systemPrompt = "你是一位专业的文档分析助手。以下是文档的原文内容以及之前的AI解读。请根据用户的问题进行回答，用中文回复，简洁准确。";
      const baseUrl = llmSettings.baseUrl.replace(/\/+$/, "");
      const messages: { role: string; content: string }[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: qaSourceTextRef.current },
        { role: "assistant", content: aiResult },
      ];
      for (const qa of qaHistory) {
        messages.push({ role: "user", content: qa.question });
        messages.push({ role: "assistant", content: qa.answer });
      }
      messages.push({ role: "user", content: question });

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: llmSettings.model, messages, temperature: 0.7, max_tokens: 2048, stream: true }),
      });

      if (!response.ok) throw new Error(`API 请求失败 (${response.status})`);
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let result = ""; let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n"); buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;
            try { const parsed = JSON.parse(data); const delta = parsed.choices?.[0]?.delta?.content; if (delta) { result += delta; setQaHistory(prev => { const updated = [...prev]; updated[updated.length - 1] = { question, answer: result }; return updated; }); } } catch { /* skip */ }
          }
        }
      } else {
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        setQaHistory(prev => { const updated = [...prev]; updated[updated.length - 1] = { question, answer: content || "AI 返回了空内容" }; return updated; });
      }
    } catch (e) {
      setQaHistory(prev => { const updated = [...prev]; updated[updated.length - 1] = { question, answer: `请求失败: ${String(e)}` }; return updated; });
    } finally {
      setQaLoading(false);
    }
  }, [qaInput, qaLoading, qaHistory, aiResult, llmSettings]);

  // ── Fulltext AI ──────────────────────────────────────────────────
  const handleFulltextAiAction = useCallback(async () => {
    if (!isPdfSelected || !documentPath || fulltextExtracting) return;
    const apiKey = llmSettings.vendorApiKeys[llmSettings.vendor];
    if (!apiKey || !llmSettings.baseUrl) { setErrorMessage("请先在设置中配置 LLM API Key"); return; }
    if (!modelLoaded) { setErrorMessage("请先加载模型后再使用全文解读"); return; }

    setFulltextExtracting(true);
    fulltextCancelRef.current = false;
    setFulltextProgress({ current: 0, total: pdfPageCount });
    setAiAction("全文解读");
    setAiResult(`正在提取全文内容 (0/${pdfPageCount} 页)...`);

    try {
      const allTextParts: string[] = [];
      for (let page = 0; page < pdfPageCount; page++) {
        if (fulltextCancelRef.current) { setAiResult("已取消全文提取"); return; }
        setFulltextProgress({ current: page + 1, total: pdfPageCount });
        setAiResult(`正在提取全文内容 (${page + 1}/${pdfPageCount} 页)...`);
        const result = await invoke<ExtractContentResponse>("get_pdf_paragraphs", { filePath: documentPath, pageIndex: page, scoreThreshold });
        if (fulltextCancelRef.current) { setAiResult("已取消全文提取"); return; }
        const layoutResult = await invoke<DetectionResponse>("run_doclayout", { filePath: documentPath, scoreThreshold, pageIndex: page });
        const textSegments = result.segments.filter(seg => !isSegmentGarbage(seg, layoutResult.boxes) && seg.text.trim());
        if (textSegments.length > 0) allTextParts.push(textSegments.map(s => s.text.trim()).join("\n"));
      }
      if (fulltextCancelRef.current) { setAiResult("已取消全文提取"); return; }
      const fullText = allTextParts.join("\n\n");
      if (!fullText.trim()) { setAiResult("未提取到文本内容"); return; }
      try { await invoke<string>("save_fulltext_debug", { text: fullText }); } catch { /* non-critical */ }
      setAiResult("正在请求 AI 全文解读...");
      const aiText = await requestAiDescription(fullText, "全文解读");
      fulltextAiResultRef.current = aiText;
      fulltextQaHistoryRef.current = [];
      fulltextSourceTextRef.current = fullText;
    } catch (e) {
      setErrorMessage(`全文提取失败: ${String(e)}`);
      setAiResult("");
    } finally {
      setFulltextExtracting(false);
      setFulltextProgress({ current: 0, total: 0 });
    }
  }, [isPdfSelected, documentPath, fulltextExtracting, pdfPageCount, llmSettings, modelLoaded, scoreThreshold, requestAiDescription, setErrorMessage]);

  const handleFulltextCancel = useCallback(() => { fulltextCancelRef.current = true; }, []);

  // ── Image AI ─────────────────────────────────────────────────────
  const handleImageAiAction = useCallback(() => {
    if (!figureImageDataUrl) return;
    setAiAction("解读图片");
    requestAiDescription("请解读这张图片的内容", "解读", figureImageDataUrl);
  }, [figureImageDataUrl, requestAiDescription]);

  // ── Auto-scroll AI pane ──────────────────────────────────────────
  useEffect(() => {
    if (aiScrollRef.current) aiScrollRef.current.scrollTop = aiScrollRef.current.scrollHeight;
  }, [aiResult, qaHistory]);

  // ── Sync fulltext Q&A memory ─────────────────────────────────────
  useEffect(() => {
    if (aiAction === "全文解读") fulltextQaHistoryRef.current = qaHistory;
  }, [qaHistory, aiAction]);

  // ── Markdown + LaTeX renderer for AI content ─────────────────────
  const renderAiContent = useCallback((text: string): React.ReactNode => {
    if (!text) return null;
    const parts: { type: "md" | "math_d" | "math_i"; content: string }[] = [];
    let remaining = text;

    const displayRe = /\$\$([\s\S]*?)\$\$/g;
    let lastIdx = 0; let match: RegExpExecArray | null;
    while ((match = displayRe.exec(remaining)) !== null) {
      if (match.index > lastIdx) parts.push({ type: "md", content: remaining.slice(lastIdx, match.index) });
      parts.push({ type: "math_d", content: match[1] });
      lastIdx = displayRe.lastIndex;
    }
    if (lastIdx < remaining.length) remaining = remaining.slice(lastIdx); else remaining = "";

    const inlineRe = /\$(?!\$)([\s\S]*?[^\\])\$/g;
    const mdParts: { type: "md" | "math_i"; content: string }[] = [];
    lastIdx = 0;
    while ((match = inlineRe.exec(remaining)) !== null) {
      if (match.index > lastIdx) mdParts.push({ type: "md", content: remaining.slice(lastIdx, match.index) });
      mdParts.push({ type: "math_i", content: match[1] });
      lastIdx = inlineRe.lastIndex;
    }
    if (lastIdx < remaining.length) mdParts.push({ type: "md", content: remaining.slice(lastIdx) });
    parts.push(...mdParts);

    const nodes: React.ReactNode[] = [];
    let key = 0;
    for (const part of parts) {
      if (part.type === "math_d") {
        try { const html = katex.renderToString(part.content, { displayMode: true, throwOnError: false }); nodes.push(<span key={key++} dangerouslySetInnerHTML={{ __html: html }} />); }
        catch { nodes.push(<span key={key++} className="math-fallback">{`$$${part.content}$$`}</span>); }
      } else if (part.type === "math_i") {
        try { const html = katex.renderToString(part.content, { displayMode: false, throwOnError: false }); nodes.push(<span key={key++} dangerouslySetInnerHTML={{ __html: html }} />); }
        catch { nodes.push(<span key={key++} className="math-fallback">{`$${part.content}$`}</span>); }
      } else {
        const mdHtml = marked.parse(part.content, { async: false }) as string;
        nodes.push(<span key={key++} dangerouslySetInnerHTML={{ __html: mdHtml }} />);
      }
    }
    return <div className="ai-markdown-content">{nodes}</div>;
  }, []);

  // ── OCR nodes renderer ──────────────────────────────────────────
  const renderOcrNodes = useCallback((text: string): React.ReactNode[] => {
    if (!text) return [];
    const nodes: React.ReactNode[] = [];
    let tokenIndex = 0;
    const splitTextIntoWords = (str: string) => {
      try {
        // @ts-ignore
        const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
        // @ts-ignore
        return Array.from(segmenter.segment(str)).map((s: any) => s.segment);
      } catch { return str.split(/(?=[\u4e00-\u9fa5])/); }
    };
    const pushText = (str: string) => {
      if (!str) return;
      const words = splitTextIntoWords(str);
      words.forEach((word, wIdx) => {
        nodes.push(<span key={`text-${tokenIndex}-${wIdx}`} className="word-span">{word}</span>);
      });
      tokenIndex++;
    };
    const displayParts = text.split(/(\$\$[\s\S]*?\$\$)/);
    for (let i = 0; i < displayParts.length; i++) {
      const part = displayParts[i];
      if (part.startsWith('$$') && part.endsWith('$$')) {
        try { const html = katex.renderToString(part.slice(2, -2), { displayMode: true, throwOnError: false }); nodes.push(<span key={`math-d-${tokenIndex++}`} dangerouslySetInnerHTML={{ __html: html }} />); }
        catch { pushText(part); }
      } else {
        const inlineParts = part.split(/(\$(?!\$)[\s\S]*?[^\\]\$)/);
        for (let j = 0; j < inlineParts.length; j++) {
          const inPart = inlineParts[j];
          if (inPart.startsWith('$') && inPart.endsWith('$') && !inPart.startsWith('$$')) {
            try { const html = katex.renderToString(inPart.slice(1, -1), { displayMode: false, throwOnError: false }); nodes.push(<span key={`math-i-${tokenIndex++}`} dangerouslySetInnerHTML={{ __html: html }} />); }
            catch { pushText(inPart); }
          } else { pushText(inPart); }
        }
      }
    }
    return nodes;
  }, []);

  // ── Clear AI state ───────────────────────────────────────────────
  const clearAiState = useCallback(() => {
    setAiResult("");
    setAiAction("");
  }, []);

  return {
    // AI state
    aiAction, setAiAction,
    aiResult, setAiResult,
    qaHistory, setQaHistory,
    qaInput, setQaInput,
    qaLoading,
    qaSourceTextRef, aiScrollRef,
    // Fulltext
    fulltextExtracting, fulltextProgress,
    fulltextAiResultRef, fulltextQaHistoryRef, fulltextSourceTextRef,
    fulltextCancelRef,
    // Paragraph cache
    paragraphAiCacheRef,
    selectedParagraphPageRef, selectedFigurePageRef,
    // Floating menus
    floatingMenu, setFloatingMenu,
    pdfFloatingMenu, setPdfFloatingMenu,
    rightPaneRef,
    // Operations
    requestAiDescription,
    handleQaSubmit,
    handleFulltextAiAction,
    handleFulltextCancel,
    handleImageAiAction,
    // Renderers
    renderAiContent,
    renderOcrNodes,
    // Reset
    clearAiState,
  };
}
