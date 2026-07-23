# xDoc OCR 模型接入指南

本指南介绍如何为 xDoc 新增一个 OCR 模型。xDoc 的 OCR 模型目录已集中化：**所有模型定义都在一个 JSON 文件里，新增模型只需编辑该文件，无需改动任何 Rust 或前端代码。**

---

## 目录

1. [工作原理](#工作原理)
2. [目录文件位置](#目录文件位置)
3. [新增一个 GGUF 模型](#新增一个-gguf-模型)
4. [新增一个-pp-ocrv6-模型](#新增一个-pp-ocrv6-模型)
5. [字段参考](#字段参考)
6. [模型文件的存放路径](#模型文件的存放路径)
7. [验证与调试](#验证与调试)
8. [常见问题](#常见问题)

---

## 工作原理

模型目录定义在 `src-tauri/ocr_models.json` 中，通过 `include_str!` 在**编译期**嵌入二进制。首次访问时解析一次并缓存，之后整个代码库像使用静态表一样使用它。

数据流（新增模型后自动贯通，无需改代码）：

```
ocr_models.json
   │  编译期 include_str! + 运行期解析一次
   ▼
gguf_ocr_models() / ppocrv6_models()      ← Rust 目录访问入口
   │
   ├─ list_ocr_models        → 返回给前端（含 repo_dir）
   ├─ find_gguf_model(id)     → 下载 / 推理时按 id 查配置
   ├─ find_ppocrv6_model_by_id(id)
   └─ download_ocr_models / download_ppocrv6_models
   │
   ▼
前端下拉列表 & 模型路径（EnvironmentCheck.tsx / SettingsDialog.tsx）
   使用后端返回的 repo_dir 派生 `model/<repo_dir>` 路径
```

关键点：前端**不再有任何硬编码的模型映射表**，目录名（`repo_dir`）由后端计算并随 `list_ocr_models` 一起返回。

---

## 目录文件位置

```
src-tauri/ocr_models.json
```

顶层结构：

```json
{
  "_comment": "说明文字，非功能字段",
  "gguf":     [ /* llama.cpp 多模态 OCR 模型 */ ],
  "ppocrv6":  [ /* PaddleOCR ONNX 检测 + 识别模型 */ ]
}
```

- `gguf`：使用 llama.cpp 运行的 GGUF 多模态模型（主模型 + mmproj 投影文件）。
- `ppocrv6`：PaddleOCR 的 ONNX 模型，检测（det）与识别（rec）分属两个仓库。

---

## 新增一个 GGUF 模型

在 `ocr_models.json` 的 `"gguf"` 数组末尾追加一个对象即可。示例（新增一个虚构的 `example-ocr`）：

```json
{
  "label": "Example-OCR (示例厂商, 1B)",
  "id": "example-ocr",
  "repo_id": "some-org/Example-OCR-GGUF",
  "text_model_q8": "Example-OCR-Q8_0.gguf",
  "text_model_f16": null,
  "mmproj_q8": "mmproj-Example-OCR-Q8_0.gguf",
  "mmproj_f16": null,
  "prompt_template": "<|im_start|>user\n{marker}\nOCR\n<|im_end|>\n<|im_start|>assistant\n",
  "eos_token_ids": [151645, 151643],
  "n_vocab": 151936,
  "n_ctx": 8192,
  "params": "1B",
  "description": "示例 OCR 模型，支持文字/公式/表格识别"
}
```

保存后重新构建即可。该模型会自动出现在设置页与环境检查页的 GGUF 分组下拉里，下载与推理全部自动可用。

> `repo_dir`（磁盘目录名）会自动取 `repo_id` 的最后一段，本例即 `Example-OCR-GGUF`，模型下载到 `model/Example-OCR-GGUF/`。**无需手动填写。**

---

## 新增一个 PP-OCRv6 模型

在 `"ppocrv6"` 数组中追加。PP-OCRv6 的检测与识别模型来自两个不同仓库，每个仓库都含 `inference.onnx`，下载后会被重命名为 `det.onnx` / `rec.onnx` / `rec.yml`：

```json
{
  "size": "small",
  "label": "PP-OCRv6 示例 (移动端)",
  "id": "ppocrv6-example",
  "det_repo": "PaddlePaddle/PP-OCRv6_example_det_onnx",
  "rec_repo": "PaddlePaddle/PP-OCRv6_example_rec_onnx",
  "det_onnx": "det.onnx",
  "rec_onnx": "rec.onnx",
  "rec_yml": "rec.yml",
  "params": "7.7M",
  "description": "PP-OCRv6 示例模型"
}
```

> PP-OCRv6 模型的 `repo_dir` 自动等于其 `id`（因为它从多个仓库下载），本例即 `ppocrv6-example`，落盘到 `model/ppocrv6-example/`。

---

## 字段参考

### GGUF 模型字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `label` | string | 是 | 下拉框显示名 |
| `id` | string | 是 | 全局唯一标识，前端选择/持久化都用它 |
| `repo_id` | string | 是 | HuggingFace 仓库，如 `ggml-org/GLM-OCR-GGUF`；目录名自动取最后一段 |
| `text_model_q8` | string | 是 | 主模型文件名（Q8 量化），下载与存在性检测都依赖它 |
| `text_model_f16` | string \| null | 否 | 可选的 f16/bf16 版本文件名，无则填 `null` |
| `mmproj_q8` | string | 是 | 多模态投影文件（Q8） |
| `mmproj_f16` | string \| null | 否 | 可选的 f16/bf16 投影文件，无则填 `null` |
| `prompt_template` | string | 是 | 提示词模板，`{marker}` 会被替换为图像媒体标记 |
| `eos_token_ids` | int[] | 是 | 结束符 token id 列表 |
| `n_vocab` | int | 是 | 词表大小 |
| `n_ctx` | int | 是 | 上下文长度 |
| `params` | string | 是 | 参数量展示文本，如 `"0.9B"` |
| `description` | string | 是 | 模型说明，显示在选中项下方 |

> 下载时只会拉取 `text_model_q8` 与 `mmproj_q8` 两个文件；`*_f16` 字段目前仅作元信息保留。

### PP-OCRv6 模型字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `size` | string | 是 | `"tiny"` / `"small"` / `"medium"` 之一 |
| `label` | string | 是 | 下拉框显示名 |
| `id` | string | 是 | 全局唯一标识；同时用作磁盘目录名 |
| `det_repo` | string | 是 | 检测模型仓库（含 `inference.onnx`） |
| `rec_repo` | string | 是 | 识别模型仓库（含 `inference.onnx` + `inference.yml`） |
| `det_onnx` | string | 是 | 检测模型本地文件名，一般为 `det.onnx` |
| `rec_onnx` | string | 是 | 识别模型本地文件名，一般为 `rec.onnx` |
| `rec_yml` | string | 是 | 识别配置本地文件名（含字典），一般为 `rec.yml` |
| `params` | string | 是 | 参数量展示文本 |
| `description` | string | 是 | 模型说明 |

---

## 模型文件的存放路径

模型文件统一放在应用数据目录的 `model/` 下：

- GGUF：`model/<repo_id 最后一段>/`，例如 `model/GLM-OCR-GGUF/`
- PP-OCRv6：`model/<id>/`，例如 `model/ppocrv6-medium/`

“已下载”判定逻辑：

- GGUF：`model/<repo_dir>/<text_model_q8>` 存在。
- PP-OCRv6：`model/<id>/<det_onnx>` 和 `model/<id>/<rec_onnx>` 同时存在。

---

## 验证与调试

新增或修改后，建议依次执行：

```bash
# 1. 校验 JSON 语法（也可在编辑器里直接看）
#    JSON 一旦写错，应用会在首次访问目录时 panic

# 2. 后端类型检查（会重新解析并嵌入 JSON）
cd src-tauri && cargo check

# 3. 前端类型检查
npx tsc --noEmit

# 4. 启动应用，在设置 → OCR 中确认新模型出现在下拉里，
#    并测试下载与识别
```

---

## 常见问题

**Q：为什么我的模型没出现在下拉里？**
A：确认它加在了正确的数组（`gguf` 或 `ppocrv6`）里，且 JSON 语法无误（逗号、引号、`null`）。JSON 解析失败会导致目录整体加载失败。

**Q：`text_model_f16` / `mmproj_f16` 没有对应文件怎么办？**
A：填 `null`。这两个字段是可选的。

**Q：能不能自定义磁盘目录名？**
A：当前目录名是自动派生的（GGUF 取 `repo_id` 最后一段，PP-OCRv6 取 `id`），无需也无法在 JSON 中单独指定，以保证前后端一致。

**Q：改了 JSON 需要改前端代码吗？**
A：不需要。前端通过 `list_ocr_models` 拿到包含 `repo_dir` 的完整目录，自动渲染下拉与派生下载路径。

**Q：JSON 写错会怎样？**
A：因为目录在运行期解析，语法错误会在首次访问时触发 panic（而不是编译报错）。同理，`ppocrv6` 数组不能清空——`find_ppocrv6_model` 会取第一个元素作为兜底。请务必保证 JSON 合法且 `ppocrv6` 至少保留一条。
