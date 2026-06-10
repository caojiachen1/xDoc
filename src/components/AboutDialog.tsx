/**
 * AboutDialog — xDoc 关于对话框
 *
 * 展示应用介绍、版本信息、核心功能、技术栈和快捷键说明。
 * 风格与 SettingsDialog 保持一致（深色主题）。
 */
import { useEffect, useState } from "react";
import { Button, Text } from "@fluentui/react-components";
import { Dismiss24Regular } from "@fluentui/react-icons";
import "./AboutDialog.css";

type AboutSection = "overview" | "features" | "shortcuts" | "tech";

interface Props {
  open: boolean;
  onClose: () => void;
}

const NAV_ITEMS: { key: AboutSection; label: string; icon: string }[] = [
  { key: "overview", label: "概览", icon: "📄" },
  { key: "features", label: "核心功能", icon: "✨" },
  { key: "shortcuts", label: "快捷键", icon: "⌨️" },
  { key: "tech", label: "技术栈", icon: "🧩" },
];

const SHORTCUTS: { label: string; keys: string }[] = [
  { label: "打开文件", keys: "Ctrl + O" },
  { label: "新建窗口", keys: "Ctrl + N" },
  { label: "设置", keys: "Ctrl + ," },
  { label: "命令面板", keys: "Ctrl + K" },
  { label: "放大", keys: "Ctrl + =" },
  { label: "缩小", keys: "Ctrl + -" },
  { label: "重置缩放", keys: "Ctrl + 0" },
];

const FEATURES: { title: string; desc: string }[] = [
  { title: "智能布局检测", desc: "基于 ONNX 模型自动识别文档中的标题、段落、图片、表格、公式等元素" },
  { title: "OCR 文字识别", desc: "集成 GLM-OCR 模型，支持对扫描版 PDF 进行高精度文字提取" },
  { title: "AI 智能解读", desc: "对接多种大语言模型，对选定段落进行翻译、摘要、深度解读" },
  { title: "全文解读", desc: "一键提取所有页面文本并生成全文 AI 分析报告" },
  { title: "PDF 标注", desc: "支持画笔、橡皮擦、矩形、椭圆、文字等多种标注工具" },
  { title: "GROBID 元数据", desc: "自动解析论文标题、作者、摘要、参考文献等学术元数据" },
  { title: "多标签浏览", desc: "同时打开多篇文档，支持标签拖拽排序与快速切换" },
  { title: "引文导出", desc: "支持 GB/T 7714、APA、MLA 等多种引用格式一键导出" },
  { title: "参考文献侧栏", desc: "自动提取参考文献，支持 CrossRef 补全 DOI、摘要等详细信息" },
  { title: "插件系统", desc: "支持自定义插件扩展，提供面板、侧栏、浮动窗口等多种 UI 扩展方式" },
];

const TECH_STACK: { category: string; items: string[] }[] = [
  { category: "桌面框架", items: ["Tauri v2", "WebView2"] },
  { category: "前端", items: ["React 19", "TypeScript", "Vite"] },
  { category: "UI 组件", items: ["Fluent UI React v9", "Lucide Icons"] },
  { category: "PDF 渲染", items: ["PDF.js (pdfjs-dist)", "PDFium (原生)"] },
  { category: "AI / ML", items: ["llama.cpp (GGUF)", "ONNX Runtime", "GLM-OCR"] },
  { category: "学术解析", items: ["GROBID", "CrossRef API"] },
  { category: "数据存储", items: ["SQLite (rusqlite)", "localStorage"] },
];

export default function AboutDialog({ open, onClose }: Props) {
  const [section, setSection] = useState<AboutSection>("overview");

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="about-overlay" onClick={onClose}>
      <div className="about-window" onClick={(e) => e.stopPropagation()}>
        {/* ── left sidebar ── */}
        <nav className="about-sidebar">
          <div className="about-sidebar-header">
            <div className="about-logo">xDoc</div>
            <Text size={100} className="about-version">v0.1.0</Text>
          </div>
          <div className="about-sidebar-nav">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                className={`about-nav-item ${section === item.key ? "active" : ""}`}
                onClick={() => setSection(item.key)}
              >
                <span className="about-nav-icon">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
          <div className="about-sidebar-footer">
            <Text size={100} className="about-footer-text">
              com.caoji.xdoc
            </Text>
          </div>
        </nav>

        {/* ── right content ── */}
        <div className="about-main">
          <header className="about-main-header">
            <Text weight="semibold" size={400}>
              {NAV_ITEMS.find((n) => n.key === section)?.label ?? "关于"}
            </Text>
            <Button
              appearance="transparent"
              icon={<Dismiss24Regular />}
              onClick={onClose}
              aria-label="关闭"
              size="small"
            />
          </header>

          <div className="about-content-body">
            {/* ══════ OVERVIEW ══════ */}
            {section === "overview" && (
              <div className="about-section">
                <div className="about-hero">
                  <div className="about-hero-logo">xDoc</div>
                  <Text className="about-hero-tagline">
                    智能文档阅读与分析平台
                  </Text>
                  <Text size={200} className="about-hero-version">
                    版本 0.1.0
                  </Text>
                </div>

                <div className="about-desc">
                  <Text size={200}>
                    xDoc 是一款面向学术研究者和文档工作者的桌面应用，集成了先进的 AI
                    模型和专业文档解析能力。它能够智能识别文档结构、提取关键信息，
                    并通过大语言模型提供深度的文本解读与分析。
                  </Text>
                </div>

                <div className="about-highlights">
                  <div className="about-highlight-item">
                    <span className="about-highlight-icon">🔍</span>
                    <div>
                      <Text weight="semibold" size={200}>精准检测</Text>
                      <Text size={100} className="about-highlight-desc">
                        支持 25 类文档元素的智能识别
                      </Text>
                    </div>
                  </div>
                  <div className="about-highlight-item">
                    <span className="about-highlight-icon">🤖</span>
                    <div>
                      <Text weight="semibold" size={200}>AI 驱动</Text>
                      <Text size={100} className="about-highlight-desc">
                        多厂商大模型无缝对接
                      </Text>
                    </div>
                  </div>
                  <div className="about-highlight-item">
                    <span className="about-highlight-icon">📚</span>
                    <div>
                      <Text weight="semibold" size={200}>学术友好</Text>
                      <Text size={100} className="about-highlight-desc">
                        GROBID 元数据解析与引文导出
                      </Text>
                    </div>
                  </div>
                  <div className="about-highlight-item">
                    <span className="about-highlight-icon">🧩</span>
                    <div>
                      <Text weight="semibold" size={200}>可扩展</Text>
                      <Text size={100} className="about-highlight-desc">
                        插件系统支持自定义功能扩展
                      </Text>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ══════ FEATURES ══════ */}
            {section === "features" && (
              <div className="about-section">
                <div className="about-feature-list">
                  {FEATURES.map((f, idx) => (
                    <div key={idx} className="about-feature-card">
                      <Text weight="semibold" size={200} className="about-feature-title">
                        {f.title}
                      </Text>
                      <Text size={100} className="about-feature-desc">
                        {f.desc}
                      </Text>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ══════ SHORTCUTS ══════ */}
            {section === "shortcuts" && (
              <div className="about-section">
                <div className="about-shortcut-list">
                  {SHORTCUTS.map((s, idx) => (
                    <div key={idx} className="about-shortcut-row">
                      <Text size={200}>{s.label}</Text>
                      <kbd className="about-kbd">{s.keys}</kbd>
                    </div>
                  ))}
                </div>
                <div className="about-shortcut-hint">
                  <Text size={100} className="about-hint-text">
                    更多快捷键可在命令面板 (Ctrl+K) 中查看
                  </Text>
                </div>
              </div>
            )}

            {/* ══════ TECH STACK ══════ */}
            {section === "tech" && (
              <div className="about-section">
                <div className="about-tech-list">
                  {TECH_STACK.map((group, idx) => (
                    <div key={idx} className="about-tech-group">
                      <Text weight="semibold" size={200} className="about-tech-category">
                        {group.category}
                      </Text>
                      <div className="about-tech-tags">
                        {group.items.map((item) => (
                          <span key={item} className="about-tech-tag">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
