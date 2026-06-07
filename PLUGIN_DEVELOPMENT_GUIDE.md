# xDoc 插件开发指南

本指南将帮助你为 xDoc 开发自定义插件。xDoc 的插件系统采用类似 Zotero 的架构：每个插件是一个独立目录，包含清单文件和代码，通过标准 API（PluginContext）与主程序交互。

---

## 目录

1. [快速开始](#快速开始)
2. [插件目录结构](#插件目录结构)
3. [插件清单 plugin.json](#插件清单-pluginjson)
4. [插件入口文件](#插件入口文件)
5. [PluginContext API 参考](#plugincontext-api-参考)
6. [钩子系统 Hooks](#钩子系统-hooks)
7. [内置插件示例：PPT 讲解生成器](#内置插件示例ppt-讲解生成器)
8. [打包与分发](#打包与分发)
9. [权限系统](#权限系统)
10. [调试技巧](#调试技巧)
11. [常见问题](#常见问题)
12. [完整示例插件](#完整示例插件)

---

## 快速开始

### 第一步：创建插件目录

在 xDoc 的数据目录下创建 `plugins/` 子目录（通常是 `C:\xDoc\plugins\`），然后新建你的插件文件夹：

```
C:\xDoc\plugins\
  my-plugin\
    plugin.json
    index.js
```

### 第二步：编写清单文件

`plugin.json`：

```json
{
  "id": "my-plugin",
  "name": "我的第一个插件",
  "version": "1.0.0",
  "description": "这是一个示例插件",
  "author": "你的名字",
  "permissions": ["pdf:read", "llm:invoke"],
  "entry": {
    "main": "index.js"
  },
  "activation": ["onStartupFinished"]
}
```

### 第三步：编写入口文件

`index.js`：

```javascript
exports.hooks = {
  contextMenuItems: function() {
    return [{
      id: "my-plugin:hello",
      label: "打招呼",
      action: function(paper, ctx) {
        ctx.showToast("success", "你好！当前论文：" + paper.name);
      }
    }];
  },

  toolbarButtons: function() {
    return [{
      id: "my-plugin:toolbar-btn",
      label: "我的按钮",
      tooltip: "点击执行操作",
      placement: "reader",
      action: function(ctx) {
        var path = ctx.getCurrentPdfPath();
        if (path) {
          ctx.showToast("info", "当前文件：" + path);
        }
      }
    }];
  }
};
```

### 第四步：安装并启用

1. 打开 xDoc
2. 进入 **设置 → 插件**
3. 点击"刷新"，你的插件会出现在列表中
4. 打开开关启用插件

或者，你也可以将插件目录打包为 `.zip` 文件，通过拖拽导入。

---

## 插件目录结构

一个完整的插件目录可以包含以下文件：

```
my-plugin/
├── plugin.json          ← 必需：插件清单
├── index.js             ← 必需：插件入口代码
├── README.md            ← 可选：插件说明
├── icon.png             ← 可选：插件图标（未来支持）
└── assets/              ← 可选：插件资源文件
    └── template.pptx
```

### 核心规则

- **必须有 `plugin.json`**：没有清单文件的目录不会被识别
- **`entry.main` 指向的文件必须存在**：这是插件的入口点
- **`id` 必须唯一**：不能与其他已安装的插件冲突
- 目录名建议与 `id` 一致（非强制）

---

## 插件清单 plugin.json

### 完整字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 插件唯一标识符，建议使用小写字母+连字符 |
| `name` | string | 是 | 插件显示名称 |
| `version` | string | 是 | 语义化版本号，如 `"1.0.0"` |
| `minAppVersion` | string | 否 | 最低兼容的 xDoc 版本 |
| `description` | string | 否 | 插件功能描述，显示在插件管理页面 |
| `author` | string | 否 | 作者名称 |
| `permissions` | string[] | 是 | 权限声明列表（见下文） |
| `entry` | object | 是 | 入口配置 |
| `entry.main` | string | 否 | 主逻辑入口文件路径（相对于插件目录） |
| `entry.renderer` | string | 否 | 可选的 Web 面板 HTML 文件（未来支持） |
| `activation` | string[] | 是 | 激活条件列表 |

### 激活条件

| 值 | 说明 |
|----|------|
| `"onStartupFinished"` | 应用启动完成后激活（最常用） |
| `"onPdfOpened"` | 当用户打开 PDF 时激活 |
| `"onCommand"` | 当用户执行特定命令时激活（未来支持） |

### 清单示例

```json
{
  "id": "paper-summarizer",
  "name": "论文摘要生成器",
  "version": "2.1.0",
  "minAppVersion": "0.1.0",
  "description": "使用 AI 为论文生成结构化摘要，支持中英文",
  "author": "xDoc Community",
  "permissions": ["pdf:read", "llm:invoke", "file:write"],
  "entry": {
    "main": "index.js"
  },
  "activation": ["onStartupFinished"]
}
```

---

## 插件入口文件

入口文件是一个标准的 JavaScript 文件（CommonJS 模块格式）。它必须导出一个 `hooks` 对象。

### 基本结构

```javascript
// index.js

exports.hooks = {
  // 插件初始化时调用
  onInit: async function(ctx) {
    console.log("[MyPlugin] 初始化完成");
    // 可以返回额外的钩子
    return {
      contextMenuItems: function() { /* ... */ }
    };
  },

  // 插件卸载时调用
  onDestroy: async function() {
    console.log("[MyPlugin] 正在清理资源");
  },

  // 右键菜单项
  contextMenuItems: function() {
    return [ /* ... */ ];
  },

  // 工具栏按钮
  toolbarButtons: function() {
    return [ /* ... */ ];
  },

  // 命令
  commands: function() {
    return [ /* ... */ ];
  },

  // 生命周期钩子
  onPdfOpened: async function(ctx, paper) {
    console.log("[MyPlugin] 打开了论文：" + paper.name);
  },

  onPdfTextReady: async function(ctx, fullText) {
    console.log("[MyPlugin] 全文长度：" + fullText.length);
  }
};
```

### 重要注意事项

1. **不要使用 ES Module 语法**（`import/export`），入口文件使用 CommonJS（`require/module.exports`）
2. **不要访问 `window`、`document`** 等全局对象，所有操作通过 `ctx`（PluginContext）完成
3. **`onInit` 可以返回额外的钩子**，这些钩子会与静态定义的钩子合并
4. **所有 async 函数都应捕获异常**，未捕获的异常会导致插件进入 error 状态

---

## PluginContext API 参考

`PluginContext`（简称 `ctx`）是插件与主程序交互的唯一通道。以下是所有可用的 API：

### PDF 相关

#### `ctx.getCurrentPdfPath(): string | null`

返回当前打开的 PDF 文件路径。如果没有打开任何 PDF，返回 `null`。

```javascript
var path = ctx.getCurrentPdfPath();
if (!path) {
  ctx.showToast("warning", "请先打开一个 PDF 文件");
  return;
}
```

#### `ctx.getPdfFullText(): Promise<string>`

获取当前 PDF 的全部文本内容（所有页面的文字拼接）。

```javascript
var text = await ctx.getPdfFullText();
console.log("全文长度：" + text.length + " 字符");
```

注意：返回的文本包含 `[Page N]` 标记，用于标识页码。

#### `ctx.getPdfMetadata(): Promise<Record<string, unknown>>`

获取 PDF 的元数据（标题、作者、DOI 等）。

```javascript
var meta = await ctx.getPdfMetadata();
console.log("标题：" + meta.title);
console.log("作者：" + meta.authors);
```

#### `ctx.extractPdfImages(pageIndices?: number[]): Promise<PdfImageInfo[]>`

提取 PDF 中嵌入的图片（如论文中的 Figure）。

参数：
- `pageIndices`（可选）：只提取指定页面的图片，不传则提取所有页面

返回：
```typescript
interface PdfImageInfo {
  pageIndex: number;    // 页码（0-indexed）
  imageBase64: string;  // base64 编码的图片数据
  width: number;        // 图片宽度（像素）
  height: number;       // 图片高度（像素）
}
```

```javascript
var images = await ctx.extractPdfImages([0, 1, 2]); // 提取前3页的图片
images.forEach(function(img) {
  console.log("第" + (img.pageIndex + 1) + "页的图片：" + img.width + "x" + img.height);
});
```

### AI / LLM 相关

#### `ctx.invokeLlm(params): Promise<string>`

调用用户在设置中配置的 LLM（大语言模型）。

参数：
```typescript
{
  systemPrompt: string;    // 系统提示词
  userPrompt: string;      // 用户提示词
  temperature?: number;    // 温度参数（默认 0.7）
  maxTokens?: number;      // 最大输出 token 数（默认 4096）
}
```

```javascript
var result = await ctx.invokeLlm({
  systemPrompt: "你是一位论文审稿专家，请用中文总结以下论文的要点。",
  userPrompt: "论文内容：\n" + fullText.slice(0, 10000),
  temperature: 0.3,
  maxTokens: 2048
});
```

注意：如果用户未配置 LLM，此方法会抛出错误。建议在调用前提示用户。

### 文件系统

#### `ctx.showSaveDialog(options): Promise<string | null>`

弹出文件保存对话框。

```javascript
var savePath = await ctx.showSaveDialog({
  defaultName: "output.txt",
  filters: { "文本文件": ["txt"], "所有文件": ["*"] }
});
if (savePath) {
  // 用户选择了保存路径
}
```

#### `ctx.showOpenDialog(options): Promise<string | null>`

弹出文件打开对话框。

```javascript
var filePath = await ctx.showOpenDialog({
  filters: { "模板文件": ["pptx", "docx"] },
  multiple: false
});
```

### PPTX 生成

#### `ctx.generatePptx(params): Promise<void>`

调用 Rust 后端生成 PPTX 文件。

```javascript
await ctx.generatePptx({
  outputPath: "C:\\Users\\xxx\\output.pptx",
  title: "论文标题",
  slides: [
    { title: "标题页", bullets: ["论文标题", "作者"] },
    { title: "背景", bullets: ["要点1", "要点2"] },
    { title: "方法", bullets: ["步骤1", "步骤2"], imageBase64: "..." }
  ],
  templatePath: "C:\\Users\\xxx\\template.pptx"  // 可选
});
```

### 事件与通知

#### `ctx.showToast(type, message): void`

向用户显示通知。

```javascript
ctx.showToast("info", "正在处理...");
ctx.showToast("success", "处理完成！");
ctx.showToast("warning", "结果可能不准确");
ctx.showToast("error", "处理失败：" + errorMessage);
```

#### `ctx.emitBackend(event, payload): Promise<void>`

向 Rust 后端发送事件。

#### `ctx.onEvent(event, handler): () => void`

监听前端事件。返回一个取消监听的函数。

```javascript
var unlisten = ctx.onEvent("some-event", function(payload) {
  console.log("收到事件：", payload);
});
// 取消监听
unlisten();
```

---

## 钩子系统 Hooks

### 右键菜单项 contextMenuItems

在文献列表的右键菜单中添加项目。

```javascript
contextMenuItems: function() {
  return [
    {
      id: "my-plugin:action1",
      label: "执行操作 A",
      when: function(paper) {
        // 可选：条件显示（例如只在 PDF 文件上显示）
        return paper.name.endsWith(".pdf");
      },
      action: function(paper, ctx) {
        // paper = { id, name, path }
        ctx.showToast("info", "对 " + paper.name + " 执行操作 A");
      }
    }
  ];
}
```

### 工具栏按钮 toolbarButtons

在 PDF 阅读器工具栏中添加按钮。

```javascript
toolbarButtons: function() {
  return [
    {
      id: "my-plugin:btn",
      label: "我的工具",
      tooltip: "点击执行某个操作",
      placement: "reader",  // "reader" | "home-toolbar" | "status-bar"
      action: async function(ctx) {
        var text = await ctx.getPdfFullText();
        // 处理 text...
      }
    }
  ];
}
```

placement 可选值：
- `"reader"` — PDF 阅读器顶部工具栏
- `"home-toolbar"` — 主页工具栏（未来支持）
- `"status-bar"` — 底部状态栏（未来支持）

### 命令 commands

添加到命令面板（Ctrl+K，未来支持）。

```javascript
commands: function() {
  return [
    {
      id: "my-plugin:cmd1",
      label: "执行命令 1",
      shortcut: "Ctrl+Shift+P",  // 可选
      action: function(ctx) {
        // ...
      }
    }
  ];
}
```

---

## 内置插件示例：PPT 讲解生成器

xDoc 内置了 "PPT 讲解生成器" 插件，它的完整工作流程如下：

### 入口方式（3 种）

1. **右键菜单**：在文献列表中右键 → "生成讲解 PPT"
2. **工具栏按钮**：打开 PDF 后，工具栏出现"生成 PPT"按钮
3. **命令面板**：搜索"生成当前 PDF 的讲解 PPT"

### 工作流程

```
用户触发 → 读取 PDF 全文 → 提取嵌入图片(Figures)
     → 调用 LLM 生成幻灯片大纲
     → 用户选择样式（内置 / 自定义模板）
     → 选择保存路径
     → Rust 后端生成 PPTX 文件
     → 通知用户
```

### 关键实现

- LLM 提示词中包含了图片页码信息，让 AI 标注 `[图:N]` 分配图片位置
- 支持用户导入 `.pptx` 模板文件，程序会读取模板的版式和主题
- 内置样式采用简洁学术风配色（深蓝+红色强调线）

---

## 打包与分发

### zip 包格式

将插件目录打包为 `.zip` 文件即可分发：

```
my-plugin.zip
└── my-plugin/
    ├── plugin.json
    ├── index.js
    └── README.md
```

注意：zip 文件的顶层必须是一个目录（即插件目录），不能直接把文件放在 zip 根目录。

### 安装方式

用户可以通过以下方式安装：

1. **拖拽导入**：将 `.zip` 文件拖到插件管理页面的拖拽区域
2. **手动导入**：点击"导入插件"按钮选择 `.zip` 文件
3. **手动复制**：解压后将插件目录放到 `plugins/` 下

---

## 权限系统

插件必须声明所需权限，未声明的权限对应的 API 调用可能失败。

| 权限 | 说明 | 关联 API |
|------|------|----------|
| `pdf:read` | 读取 PDF 内容和元数据 | `getPdfFullText`, `getPdfMetadata`, `extractPdfImages` |
| `llm:invoke` | 调用 LLM | `invokeLlm` |
| `file:write` | 写入文件 | `generatePptx`, `showSaveDialog` |
| `file:read` | 读取文件 | `showOpenDialog` |
| `event:emit` | 发送事件 | `emitBackend` |

在 `plugin.json` 中声明：

```json
{
  "permissions": ["pdf:read", "llm:invoke", "file:write"]
}
```

---

## 调试技巧

### 1. 查看控制台日志

在 xDoc 中使用 `Ctrl+Shift+I` 打开开发者工具（DevTools），在 Console 面板查看插件日志。

你的 `console.log` 输出会带有 `[MyPlugin]` 前缀（如果你在代码中手动添加）。

### 2. 使用 Toast 通知

用 `ctx.showToast("info", message)` 在前端显示调试信息。

### 3. 错误处理

始终用 try-catch 包裹异步操作：

```javascript
action: async function(paper, ctx) {
  try {
    var text = await ctx.getPdfFullText();
    // 处理...
  } catch (err) {
    ctx.showToast("error", "失败：" + err.message);
  }
}
```

### 4. 检查插件状态

在设置 → 插件页面，检查你的插件是否显示"错误"状态。如果有，错误信息会显示在插件卡片中。

---

## 常见问题

### Q: 插件加载后右键菜单没有出现？

A: 确认以下几点：
1. 插件状态为"已启用"（开关已打开）
2. `contextMenuItems()` 返回了非空数组
3. 检查 DevTools 控制台是否有报错

### Q: `ctx.getPdfFullText()` 报错 "No PDF is currently open"？

A: 这个 API 需要用户先打开一个 PDF 文件。建议在调用前检查 `ctx.getCurrentPdfPath()` 是否为 null。

### Q: `ctx.invokeLlm()` 报错 "LLM not configured"？

A: 用户需要先在设置中配置 LLM（厂商、API Key、模型等）。你的插件可以在调用前提示用户。

### Q: 插件代码中可以使用 `require()` 吗？

A: 当前的插件沙箱环境中不支持 `require()`。所有功能应通过 `PluginContext` 提供的 API 实现。未来版本可能会支持有限的模块加载。

### Q: 如何获取 PDF 的页数？

A: 通过 `getPdfFullText()` 返回的文本中的 `[Page N]` 标记来推算，或解析返回文本的页码信息。

---

## 完整示例插件

以下是一个完整的"论文关键词提取器"插件示例：

### plugin.json

```json
{
  "id": "keyword-extractor",
  "name": "关键词提取器",
  "version": "1.0.0",
  "description": "使用 AI 从论文中提取关键术语和主题",
  "author": "Demo Author",
  "permissions": ["pdf:read", "llm:invoke"],
  "entry": { "main": "index.js" },
  "activation": ["onStartupFinished"]
}
```

### index.js

```javascript
exports.hooks = {

  contextMenuItems: function() {
    return [{
      id: "keyword-extractor:extract",
      label: "提取关键词",
      action: function(paper, ctx) {
        extractKeywords(ctx).catch(function(err) {
          ctx.showToast("error", "提取失败：" + err.message);
        });
      }
    }];
  },

  toolbarButtons: function() {
    return [{
      id: "keyword-extractor:btn",
      label: "提取关键词",
      tooltip: "从当前 PDF 中提取关键词",
      placement: "reader",
      action: function(ctx) {
        extractKeywords(ctx).catch(function(err) {
          ctx.showToast("error", "提取失败：" + err.message);
        });
      }
    }];
  }
};

async function extractKeywords(ctx) {
  var path = ctx.getCurrentPdfPath();
  if (!path) {
    ctx.showToast("warning", "请先打开一个 PDF 文件");
    return;
  }

  ctx.showToast("info", "正在读取 PDF 全文...");
  var fullText = await ctx.getPdfFullText();

  if (!fullText || fullText.trim().length < 100) {
    ctx.showToast("error", "PDF 内容过短或无法提取文本");
    return;
  }

  ctx.showToast("info", "正在用 AI 提取关键词...");
  var result = await ctx.invokeLlm({
    systemPrompt: "你是一位学术文本分析专家。从以下论文文本中提取 10 个最重要的关键词和 3 个核心研究主题。输出格式为 JSON：{\"keywords\": [\"...\"], \"themes\": [\"...\"]}",
    userPrompt: fullText.slice(0, 15000),
    temperature: 0.3,
    maxTokens: 1024
  });

  // 显示结果
  ctx.showToast("success", "关键词提取完成！\n" + result.slice(0, 200));
}
```

### 安装步骤

1. 在 `C:\xDoc\plugins\` 下创建 `keyword-extractor` 目录
2. 将上述两个文件放入
3. 打开 xDoc → 设置 → 插件 → 刷新
4. 启用"关键词提取器"
5. 右键任意论文 → "提取关键词"

---

*本指南适用于 xDoc v0.1.0 及以上版本。如有问题或建议，欢迎反馈。*
