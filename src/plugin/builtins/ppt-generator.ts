/**
 * PPT presentation generator plugin (refactored)
 *
 * Slide structure:
 *   1. Title page: bilingual title, section, journal, authors, brief overview
 *   2. Methods: experimental flow, materials, procedures
 *   3. Characterization: one slide per characterization figure with LLM interpretation
 *   4. Electrochemical analysis: one slide per electrochemistry figure with LLM interpretation
 *   5. Other figures: remaining images + brief description
 *   6. Conclusion
 *
 * Workflow:
 *   1. Read full PDF text + extract images + fetch metadata
 *   2. LLM classifies images (flowchart/characterization/electrochemical/other)
 *   3. LLM generates slide content
 *   4. Assemble SlideData[]
 *   5. User selects template → backend generates PPTX
 */
import type { PluginHooks, PluginContext, SlideData, PdfImageInfo, ClassifiedImage } from "../types";

// ── Registration entry ──

export function createPptGeneratorPlugin(): PluginHooks {
  return {
    contextMenuItems: () => [
      {
        id: "ppt-generator",
        label: "生成讲解 PPT",
        icon: "presentation",
        action: (paper, ctx) => {
          runPptGeneration(ctx, paper.path).catch((err) => {
            console.error("[PPT Generator]", err);
            ctx.showToast("error", `PPT 生成失败: ${err.message}`);
          });
        },
      },
    ],

    commands: () => [
      {
        id: "ppt-generator:generate",
        label: "生成当前 PDF 的讲解 PPT",
        action: async (ctx) => {
          const path = ctx.getCurrentPdfPath();
          if (!path) {
            ctx.showToast("error", "请先打开一个 PDF 文件");
            return;
          }
          await runPptGeneration(ctx, path);
        },
      },
    ],

    toolbarButtons: () => [
      {
        id: "ppt-generator",
        label: "生成 PPT",
        icon: "presentation",
        tooltip: "根据当前 PDF 生成讲解 PPT",
        placement: "reader",
        action: async (ctx) => {
          const path = ctx.getCurrentPdfPath();
          if (!path) {
            ctx.showToast("error", "请先打开一个 PDF 文件");
            return;
          }
          await runPptGeneration(ctx, path);
        },
      },
    ],
  };
}

// ── Core generation flow ──

async function runPptGeneration(ctx: PluginContext, _pdfPath: string) {
  try {
    // 1. Read full PDF text
    ctx.showToast("info", "正在读取 PDF 全文...");
    const fullText = await ctx.getPdfFullText();
    if (!fullText || fullText.trim().length < 50) {
      throw new Error("PDF 内容过短或无法提取文本，请确认 PDF 是否包含可识别的文字");
    }

    // 2. Fetch metadata
    ctx.showToast("info", "正在获取论文元数据...");
    const metadata = await ctx.getPdfMetadata() as Record<string, string | undefined>;
    const titleEn = metadata.title || "未命名文献";
    const titleZh = metadata.titleTranslation || "";
    const authors = metadata.authors || "";
    const journal = metadata.journal || metadata.journalAbbrev || "";
    const date = metadata.date || "";

    // 3. Extract embedded images
    ctx.showToast("info", "正在提取论文中的图片...");
    let images: PdfImageInfo[] = [];
    try {
      images = await ctx.extractPdfImages();
      if (images.length > 0) {
        ctx.showToast("info", `已提取 ${images.length} 张图片`);
      }
    } catch (imgErr) {
      console.warn("[PPT Generator] Image extraction failed:", imgErr);
    }

    // 4. LLM classifies images (if any)
    let classifiedImages: ClassifiedImage[] = [];
    if (images.length > 0) {
      ctx.showToast("info", "正在用 AI 分类图片...");
      classifiedImages = await classifyImagesWithLlm(ctx, fullText, images);
      ctx.showToast("info", `已分类 ${classifiedImages.length} 张图片`);
    }

    // 5. LLM generates slide content
    ctx.showToast("info", "正在用 AI 生成幻灯片内容（约 20-40 秒）...");
    const slides = await generateSlidesWithLlm(
      ctx, fullText, titleEn, titleZh, authors, journal, date, images, classifiedImages
    );

    // 6. Ask user about custom template
    let templatePath: string | undefined;
    const useTemplate = await askUserAboutTemplate();
    if (useTemplate) {
      const selected = await ctx.showOpenDialog({
        filters: { "PowerPoint 模板": ["pptx"] },
        multiple: false,
      });
      if (selected) {
        templatePath = selected;
      }
    }

    // 7. Let user choose save location
    const safeTitle = titleEn.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
    const savePath = await ctx.showSaveDialog({
      defaultName: `${safeTitle}_讲解PPT.pptx`,
      filters: { "PowerPoint 文件": ["pptx"] },
    });

    if (!savePath) {
      ctx.showToast("info", "已取消生成");
      return;
    }

    // 8. Call Rust backend to generate PPTX
    ctx.showToast("info", "正在生成 PPTX 文件...");
    await ctx.generatePptx({
      outputPath: savePath,
      title: titleZh || titleEn,
      slides,
      templatePath,
    });

    // 9. Success
    ctx.showToast("success", `PPT 已生成：${savePath}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.showToast("error", `PPT 生成失败: ${msg}`);
    throw err;
  }
}

// ── Step 1: LLM image classification ──

async function classifyImagesWithLlm(
  ctx: PluginContext,
  fullText: string,
  images: PdfImageInfo[]
): Promise<ClassifiedImage[]> {
  const imagePageList = images.map((img, idx) =>
    `图片${idx + 1}: 第${img.pageIndex + 1}页`
  ).join("\n");

  const systemPrompt = `你是一位材料科学论文图片分类专家。
请根据论文全文和每张图片所在的页码，将每张图片分类为以下类别之一：
- flowchart: 实验流程图、实验装置示意图、工艺流程图
- characterization: 表征测试图（SEM、TEM、XRD、FTIR、Raman、XPS、EDS、AFM等）
- electrochemical: 电化学测试图（CV循环伏安、EIS阻抗、充放电曲线、倍率性能、循环稳定性等）
- other: 其他图片（结果汇总图、对比图、示意图等）

同时为每张图片写一句简短的中文描述（不超过30字）。

输出严格的 JSON 数组格式（不要任何额外文字）：
[
  {"pageIndex": 0, "category": "flowchart", "caption": "实验制备流程示意图"},
  {"pageIndex": 2, "category": "characterization", "caption": "样品的SEM形貌图"},
  {"pageIndex": 3, "category": "electrochemical", "caption": "不同扫速下的CV曲线"}
]`;

  const userPrompt = `论文全文（截断至30000字符）:

${fullText.slice(0, 30000)}

---
以下是提取到的图片列表：
${imagePageList}

请对每张图片进行分类。`;

  const response = await ctx.invokeLlm({
    systemPrompt,
    userPrompt,
    temperature: 0.2,
    maxTokens: 4096,
  });

  // Parse JSON response
  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array found");
    const parsed = JSON.parse(jsonMatch[0]) as ClassifiedImage[];
    // Validate and fill missing fields
    return parsed
      .filter((item) => item.pageIndex !== undefined)
      .map((item) => ({
        pageIndex: item.pageIndex,
        category: (["flowchart", "characterization", "electrochemical", "other"].includes(item.category)
          ? item.category : "other") as ClassifiedImage["category"],
        caption: item.caption || "未命名图片",
      }));
  } catch (e) {
    console.warn("[PPT Generator] Image classification parse failed:", e, response);
    // Fallback: mark all as other
    return images.map((img) => ({
      pageIndex: img.pageIndex,
      category: "other" as const,
      caption: `第${img.pageIndex + 1}页的图片`,
    }));
  }
}

// ── Step 2: LLM generates slide content ──

async function generateSlidesWithLlm(
  ctx: PluginContext,
  fullText: string,
  titleEn: string,
  titleZh: string,
  authors: string,
  journal: string,
  date: string,
  images: PdfImageInfo[],
  classifiedImages: ClassifiedImage[]
): Promise<SlideData[]> {
  // Build image classification summary
  const imageClassification = classifiedImages.length > 0
    ? classifiedImages.map((ci) =>
        `- 第${ci.pageIndex + 1}页: [${ci.category}] ${ci.caption}`
      ).join("\n")
    : "（论文中未提取到图片）";

  // Group image indices by category (for LLM prompt)
  const flowcharts = classifiedImages.filter((c) => c.category === "flowchart");
  const characterizations = classifiedImages.filter((c) => c.category === "characterization");
  const electrochemicals = classifiedImages.filter((c) => c.category === "electrochemical");
  const others = classifiedImages.filter((c) => c.category === "other");

  const categorySummary = [
    `流程图 ${flowcharts.length} 张`,
    `表征图 ${characterizations.length} 张`,
    `电化学图 ${electrochemicals.length} 张`,
    `其他 ${others.length} 张`,
  ].join("，");

  const systemPrompt = `你是一位专业的材料科学学术演讲 PPT 生成专家。
根据论文全文和图片分类结果，生成一份结构化的中文讲解 PPT 内容。

**必须严格按照以下 Markdown 格式输出，不要添加任何额外说明文字：**

## 标题页
- 中文标题：${titleZh || "（无中文标题）"}
- English: ${titleEn}
- 作者：${authors || "未知"}
- 期刊：${journal || "未知"}${date ? " (" + date + ")" : ""}
- 简要概述：（用一两句话概括本文的核心贡献）

## 论文概述
- 研究背景与动机（2-3句）
- 核心方法与创新点（2-3句）
- 主要结论与意义（2-3句）

## 实验方法
- 实验原料与材料：（列出关键原料、试剂）
- 制备/实验流程：（简要描述实验步骤）
- （如有流程图，标注 [图:页码]）

（以下为表征测试，每种表征技术做一张幻灯片）
## 表征分析：XX测试 [图:页码]
- 测试条件说明
- 主要观察结果（2-3个要点）
- 结果解读

（以下为电化学分析，每种测试做一张幻灯片）
## 电化学性能：XX测试 [图:页码]
- 测试参数说明
- 关键数据与趋势（2-3个要点）
- 性能评价

（以下为其他图）
## 其他结果：简要标题 [图:页码]
- 图片描述（1-2句）

## 结论与展望
- 本文主要贡献（3-4个要点）
- 未来展望（1-2句）

**关键规则：**
1. [图:页码] 标注表示该幻灯片应插入对应页码的图片（页码是1-based）
2. 表征测试和电化学分析每个图分别做一张 slide
3. 每张 slide 的 bullet 项保持简洁，每项不超过两行
4. 用中文撰写，专业术语可保留英文
5. 只输出上述 Markdown 格式内容，不要任何前后说明`;

  const userPrompt = `图片分类统计：${categorySummary}

图片分类详情：
${imageClassification}

---
论文全文：

${fullText.slice(0, 30000)}`;

  const pptMarkdown = await ctx.invokeLlm({
    systemPrompt,
    userPrompt,
    temperature: 0.4,
    maxTokens: 8192,
  });

  // Parse Markdown into slide structure
  return parseMarkdownToSlides(pptMarkdown, images);
}

// ── Markdown parsing ──

function parseMarkdownToSlides(
  markdown: string,
  availableImages: PdfImageInfo[]
): SlideData[] {
  const slides: SlideData[] = [];
  const lines = markdown.split("\n");

  let currentSlide: SlideData | null = null;
  let slideIndex = 0;

  // Page number → image list mapping (supports multiple images per page)
  const pageToImages = new Map<number, string[]>();
  for (const img of availableImages) {
    const list = pageToImages.get(img.pageIndex) || [];
    list.push(img.imageBase64);
    pageToImages.set(img.pageIndex, list);
  }

  // Set of already-assigned image base64 strings (for dedup)
  const assignedBase64 = new Set<string>();

  /** Get one unassigned image from a given page number */
  const getImageForPage = (pageNum: number): string | undefined => {
    const imgs = pageToImages.get(pageNum);
    if (!imgs) return undefined;
    for (const b64 of imgs) {
      if (!assignedBase64.has(b64)) {
        assignedBase64.add(b64);
        return b64;
      }
    }
    return undefined;
  };

  for (const line of lines) {
    const titleMatch = line.match(/^##\s+(.+)/);
    if (titleMatch) {
      if (currentSlide) {
        slides.push(currentSlide);
      }
      slideIndex++;

      const rawTitle = titleMatch[1].trim();
      const figMatch = rawTitle.match(/\[图:(\d+)\]/);
      const cleanTitle = rawTitle.replace(/\s*\[图:\d+\]/g, "").trim();
      const slideType = determineSlideType(cleanTitle, slideIndex);

      currentSlide = {
        title: cleanTitle,
        bullets: [],
        slideType,
      };

      // Image annotation in title
      if (figMatch) {
        const pageNum = parseInt(figMatch[1]) - 1;
        const imgB64 = getImageForPage(pageNum);
        if (imgB64) {
          currentSlide.imageBase64 = imgB64;
        }
      }
    } else if (currentSlide) {
      const bulletMatch = line.match(/^\s*[-*]\s+(.+)/);
      if (bulletMatch) {
        let bulletText = bulletMatch[1].trim();
        // Inline image annotation in bullet
        const inlineFig = bulletText.match(/\[图:(\d+)\]/);
        if (inlineFig && !currentSlide.imageBase64) {
          const pageNum = parseInt(inlineFig[1]) - 1;
          const imgB64 = getImageForPage(pageNum);
          if (imgB64) {
            currentSlide.imageBase64 = imgB64;
          }
          bulletText = bulletText.replace(/\s*\[图:\d+\]/g, "").trim();
        }
        if (bulletText) {
          currentSlide.bullets.push(bulletText);
        }
      }
    }
  }

  if (currentSlide) {
    slides.push(currentSlide);
  }

  // No longer create extra slides for unassigned images

  return slides;
}

/** Determine slide type by title keywords and position */
function determineSlideType(title: string, slideIndex: number): SlideData["slideType"] {
  if (slideIndex === 1 || title.includes("标题")) return "title";
  if (title.includes("概述") || title.includes("总览") || title.includes("摘要")) return "overview";
  if (title.includes("方法") || title.includes("实验") || title.includes("制备") || title.includes("流程")) return "methods";
  if (title.includes("表征") || title.includes("SEM") || title.includes("TEM") || title.includes("XRD") ||
      title.includes("FTIR") || title.includes("Raman") || title.includes("XPS") || title.includes("AFM") ||
      title.includes("EDS") || title.includes("形貌")) return "characterization";
  if (title.includes("电化学") || title.includes("CV") || title.includes("EIS") || title.includes("充放电") ||
      title.includes("倍率") || title.includes("循环") || title.includes("阻抗")) return "electrochemical";
  if (title.includes("结论") || title.includes("总结") || title.includes("展望")) return "conclusion";
  return "other";
}

// ── Template selection dialog (dark theme) ──

async function askUserAboutTemplate(): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.6); z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(4px);
    `;

    const dialog = document.createElement("div");
    dialog.style.cssText = `
      background: rgb(40, 40, 40); border-radius: 12px; padding: 24px;
      max-width: 400px; width: 90%; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #f3f3f3;
    `;

    dialog.innerHTML = `
      <h3 style="margin: 0 0 16px 0; font-size: 18px; color: #f3f3f3;">选择 PPT 样式</h3>
      <div style="display: flex; flex-direction: column; gap: 10px;">
        <button id="ppt-builtin" style="
          padding: 12px 16px; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 8px;
          background: #333; cursor: pointer; text-align: left; font-size: 14px;
          color: #f3f3f3; transition: background 0.15s;
        " onmouseover="this.style.background='#3a3a3a'" onmouseout="this.style.background='#333'">
          <strong style="color: #f3f3f3;">内置学术风格</strong>
          <div style="font-size: 12px; color: #aaa; margin-top: 4px;">
            使用预设的简洁学术配色方案
          </div>
        </button>
        <button id="ppt-template" style="
          padding: 12px 16px; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 8px;
          background: #2a2a2a; cursor: pointer; text-align: left; font-size: 14px;
          color: #f3f3f3; transition: background 0.15s;
        " onmouseover="this.style.background='#333'" onmouseout="this.style.background='#2a2a2a'">
          <strong style="color: #f3f3f3;">自定义模板</strong>
          <div style="font-size: 12px; color: #aaa; margin-top: 4px;">
            选择一个 .pptx 模板文件作为背景
          </div>
        </button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const cleanup = () => {
      document.body.removeChild(overlay);
    };

    dialog.querySelector("#ppt-builtin")!.addEventListener("click", () => {
      cleanup();
      resolve(false);
    });

    dialog.querySelector("#ppt-template")!.addEventListener("click", () => {
      cleanup();
      resolve(true);
    });

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve(false);
      }
    });
  });
}
