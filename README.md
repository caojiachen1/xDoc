# xDoc

Document layout analysis and OCR tool built with Tauri, React, and TypeScript.

## Features

- PDF and image document layout analysis (PP-DocLayoutV3 ONNX)
- OCR text recognition (GLM-OCR GGUF)
- AI-powered text analysis via LLM APIs

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/) (latest stable)
- [pnpm](https://pnpm.io/)

### Setup

```bash
pnpm install
```

### Run

```bash
pnpm tauri dev
```

### Build

```bash
pnpm tauri build
```