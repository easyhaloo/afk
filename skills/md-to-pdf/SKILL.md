---
name: md-to-pdf
description: |
  Convert Markdown documents (with Mermaid diagrams, tables, Chinese text) into
  polished A4 PDFs.  Handles ```mermaid code blocks by rendering them to PNG
  automatically, and applies professional typography suitable for Chinese +
  English mixed content.

  Use this skill when:
  - User asks to "convert this markdown to PDF"
  - User wants to "export" a .md file as PDF
  - User needs to print, share, or present a Markdown document
  - User needs diagrams (Mermaid) rendered inside a PDF
  - User says "生成 PDF", "转 PDF", "导出 PDF"
---

# md-to-pdf — Markdown → PDF Converter

## Prerequisites (one-time setup)

```bash
# macOS
brew install pandoc
pip3 install weasyprint
npm install -g @mermaid-js/mermaid-cli

# Verify
which pandoc && which mmdc && python3 -c "import weasyprint; print('ok')"
```

## Quick Start

```bash
# Basic: input.md → input.pdf
python3 scripts/md-to-pdf.py input.md

# Custom output path
python3 scripts/md-to-pdf.py input.md output.pdf

# Help
python3 scripts/md-to-pdf.py --help
```

## Workflow

```mermaid
flowchart LR
    A["input.md"] --> B["提取 ```mermaid 块"]
    B --> C["mmdc 渲染为 PNG"]
    C --> D["替换为 ![](diagram.png)"]
    D --> E["pandoc → HTML"]
    E --> F["注入 CSS 排版"]
    F --> G["weasyprint → PDF"]
    G --> H["output.pdf"]
```

### Step-by-step

1. **Check dependencies** — verifies `pandoc`, `mmdc`, `weasyprint` are installed
2. **Extract mermaid blocks** — finds every ` ```mermaid ` block in the markdown
3. **Render diagrams** — calls `mmdc` (mermaid-cli) to convert each block to a PNG
4. **Embed images** — replaces the ` ```mermaid ` block with `![](path/to/diagram.png)`
5. **Convert to HTML** — uses `pandoc` to transform Markdown → HTML with `--math` and table support
6. **Inject CSS** — applies A4-formatted typography with Chinese-capable font stacks (`PingFang SC` for CJK, `Menlo` for code)
7. **Generate PDF** — uses `weasyprint` to render the styled HTML → PDF

## What It Handles

| Feature | Support | Notes |
|---------|---------|-------|
| ` ```mermaid ` diagrams | ✅ Auto-rendered to PNG | `flowchart`, `sequenceDiagram`, `mindmap`, etc. |
| Chinese + English text | ✅ | Font stack: PingFang SC → Menlo |
| Tables with pipe syntax | ✅ | `pandoc pipe_tables` |
| Code blocks | ✅ | Dark theme, monospace + CJK fallback |
| Math formulas | ⚠️  Partial | Requires `--math` flag in pandoc if needed |
| Image embeds | ✅ | `![](url)` in source are passed through |

## Styling Details

- **Page**: A4, 18mm/14mm margins
- **Headings**: Blue underline accent (#4361ee)
- **Tables**: Blue header row, alternating row colors
- **Code**: Dark background (#1a1a2e), light text (#e8e8f0)
- **Diagrams**: White background, 1400 px wide, auto-scaled
- **Font fallback**: SF Mono / Menlo for ASCII → PingFang SC for CJK → monospace

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| "mmdc: command not found" | mermaid-cli not installed | `npm install -g @mermaid-js/mermaid-cli` |
| "No module named weasyprint" | Python package missing | `pip3 install weasyprint` |
| Chinese text shows as boxes | Missing CJK font | Install `PingFang SC` (macOS built-in) or `Noto Sans CJK` |
| Mermaid diagram blank | mmdc rendering error | Run `mmdc -i diagram.mmd -o test.png` manually |
| Layout too wide | Code line too long | Add `white-space: pre-wrap` in CSS (already there) |

## Script Location

```
scripts/md-to-pdf.py    — standalone Python script (also copied to ~/.claude/skills/md-to-pdf/scripts/)
```

The script is self-contained — copy it anywhere and use it independently of this skill.
