#!/usr/bin/env python3
"""
md-to-pdf — Convert Markdown (with Mermaid diagrams) to a polished PDF.

Prerequisites (install once):
    brew install pandoc
    pip3 install weasyprint
    npm install -g @mermaid-js/mermaid-cli

Usage:
    ./md-to-pdf.py input.md [output.pdf]

If output.pdf is omitted, it replaces the .md suffix with .pdf in the input path.
"""

import os, re, subprocess, sys, tempfile, textwrap, shutil
from pathlib import Path


def check_deps():
    """Verify required tools are available."""
    missing = []
    for cmd, hint in [
        ('pandoc', 'brew install pandoc'),
        ('mmdc', 'npm install -g @mermaid-js/mermaid-cli'),
    ]:
        if not shutil.which(cmd):
            missing.append(f'  {cmd} — {hint}')
    try:
        import weasyprint  # noqa: F401
    except ImportError:
        missing.append('  weasyprint — pip3 install weasyprint')
    if missing:
        print('❌ Missing dependencies:')
        print('\n'.join(missing))
        sys.exit(1)


def extract_mermaid_blocks(text: str):
    """Return list of dicts {start, end, code, group} for every ```mermaid block."""
    pat = re.compile(r'^```mermaid\n(.*?)^```', re.MULTILINE | re.DOTALL)
    return [{'start': m.start(), 'end': m.end(),
             'code': m.group(1).strip(), 'group': m.group(0)}
            for m in pat.finditer(text)]


def _fix_mermaid_syntax(code: str) -> str | None:
    """Best-effort sanitisation of mermaid flowchart syntax before rendering.

    Returns None for unsupported diagram types (signals caller to fall back to code block).

    Known breakage patterns (mermaid v11):
      1. Inner square brackets in node text  e.g.  R["Root: [30 | 70]"]
      2. Unbalanced / nested double quotes   e.g.  P["role限定 "你是专家""]
      3. Bare edge labels without quotes      e.g.  A --|text| B
      4. Bidirectional arrows  <-->  (not supported in flowchart)
      5. Bare word edges       A -- B  (should be A --> B)
      6. graph TB/TD  (should be flowchart TB/TD for v11)
    """
    lines = code.split('\n')

    # Strip YAML frontmatter (--- blocks)
    if lines and lines[0].strip() == '---':
        end = -1
        for i in range(1, len(lines)):
            if lines[i].strip() == '---':
                end = i
                break
        if end > 0:
            lines = lines[end+1:]

    # Return None for unsupported diagram types
    first_stripped = lines[0].strip() if lines else ''
    dtype = first_stripped.split()[0] if first_stripped else ''
    if dtype in ('radar',):
        return None

    out = []

    for line in lines:
        s = line.strip()

        # --- skip non-node lines ---
        if s.startswith('style ') or s.startswith('linkStyle') or s.startswith('classDef') or s.startswith('class '):
            out.append(line)
            continue

        # --- Fix 6: graph TB/TD -> flowchart TB/TD ---
        if re.match(r'\s*graph\s+(TB|TD|LR|RL)\b', line):
            line = re.sub(r'\bgraph\b', 'flowchart', line, count=1)

        # --- Fix 4: bidirectional arrows ---
        line = line.replace('<-->', '--')

        # --- Fix 3: bare edge labels  --|text|  → -->|"text"| ---
        line = re.sub(r'--\|([^""][^|]*?)\|', lambda m: '-->|"' + m.group(1).strip() + '"|', line)
        # Also fix --|"text"| → -->|"text"| (bare double-arrow without >
        line = line.replace('--|', '-->|')

        # --- Fix 5: bare word edges  A -- B  → A --> B ---
        if re.match(r'\s*\w+\s+--\s+\w+', line) and '-->' not in line and '<--' not in line:
            line = re.sub(r'(\w+)\s+--\s+(\w+)(?!\s*[\-<|"\'])', r'\1 --> \2', line)

        # --- Fix 1 & 2: node text brackets & quotes ---
        m = re.match(r'^(\s*\w+)(\[)(.*)', line)
        if m and not s.startswith('subgraph ') and s != 'end':
            indent = m.group(1)
            rest = line[len(indent):]  # starts with [ then content then ] then trailing

            # Find the matching close bracket (skip nested)
            bracket_depth = 0
            in_content = False
            close_pos = -1
            for i, ch in enumerate(rest):
                if ch == '[':
                    bracket_depth += 1
                    in_content = True
                elif ch == ']':
                    bracket_depth -= 1
                    if bracket_depth == 0 and in_content:
                        close_pos = i
                        break

            if close_pos > 0:
                raw_content = rest[1:close_pos]  # everything between [ and ]
                trailing = rest[close_pos+1:]

                # Determine if original had outer quotes
                already_quoted = (raw_content.startswith('"') and raw_content.endswith('"'))

                if already_quoted:
                    # Keep outer " quotes, fix inner content only
                    inner = raw_content[1:-1]
                    inner = inner.replace('"', "'")       # inner " → '
                    inner = inner.replace('[', '(').replace(']', ')')  # inner brackets → parens
                    content = '"' + inner + '"'
                else:
                    # No outer quotes — fix content and add quotes if needed
                    fixed = raw_content.replace('"', "'")
                    fixed = fixed.replace('[', '(').replace(']', ')')
                    has_special = any(c in fixed for c in "/@#=!&<>?;:\\|+~`%'")
                    if has_special:
                        content = '"' + fixed + '"'
                    else:
                        content = fixed

                line = indent + '[' + content + ']' + trailing

        out.append(line)

    return '\n'.join(out)


def render_mermaid(code: str, stem: str, workdir: str) -> str | None:
    """Render a mermaid code block to a PNG file.  Returns the PNG path or None."""
    fixed = _fix_mermaid_syntax(code)
    if fixed is None:
        return None  # unsupported diagram type, caller will fall back to code block
    mmd = os.path.join(workdir, f'd_{stem}.mmd')
    with open(mmd, 'w') as f:
        f.write(fixed)
    png = mmd.replace('.mmd', '.png')
    result = subprocess.run(
        ['mmdc', '-i', mmd, '-o', png, '-b', 'white', '--width', '1400'],
        capture_output=True, text=True, timeout=60,
    )
    return png if os.path.exists(png) else None


def make_html(markdown: str, title: str) -> str:
    """Convert Markdown → HTML via pandoc, inject CSS, and return the HTML string."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
        f.write(markdown)
        md_path = f.name
    html_path = md_path + '.html'
    subprocess.run([
        'pandoc', md_path,
        '-f', 'markdown+pipe_tables+multiline_tables-yaml_metadata_block',
        '-t', 'html',
        '--metadata', f'title={title}',
        '-s', '-o', html_path,
    ], check=True, timeout=120)
    html = Path(html_path).read_text(encoding='utf-8')
    os.unlink(md_path)
    os.unlink(html_path)

    # Inject CSS
    css = textwrap.dedent("""\
    <style>
    @page { margin: 18mm 14mm; size: A4; }
    body { font-family: 'Helvetica Neue','PingFang SC','Microsoft YaHei',sans-serif;
           font-size: 10.5pt; line-height: 1.65; color: #222; }
    h1 { font-size: 20pt; color: #1a1a2e; border-bottom: 3px solid #4361ee; padding-bottom: 6px; }
    h2 { font-size: 16pt; color: #1a1a2e; border-bottom: 1px solid #ddd; padding-bottom: 4px;
         margin-top: 30px; page-break-before: always; }
    h2:first-of-type { page-break-before: avoid; }
    h3 { font-size: 13pt; color: #2d2d5e; margin-top: 22px; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 9pt; page-break-inside: avoid; }
    th { background-color: #4361ee; color: white; }
    th, td { border: 1px solid #bbb; padding: 4px 7px; text-align: left; }
    tr:nth-child(even) { background-color: #f5f7ff; }
    code { background-color: #e8edf5; padding: 1px 5px; border-radius: 4px; font-size: 9pt;
           color: #1a1a2e; font-weight: 500;
           font-family: 'SF Mono', Menlo, Courier, 'PingFang SC', 'STHeiti',
           'Noto Sans CJK SC', monospace; }
    pre { background-color: #f8f9fb; color: #2c3e50; padding: 12px 16px; border-radius: 6px;
          font-size: 9pt; line-height: 1.55; page-break-inside: avoid; overflow-x: auto;
          border: 1px solid #e0e4ea; border-left: 4px solid #4361ee;
          font-family: 'SF Mono', Menlo, Courier, 'PingFang SC', 'STHeiti',
          'Noto Sans CJK SC', monospace; white-space: pre-wrap; word-break: break-word;
          box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    pre code { background: none; color: #2c3e50; font-family: inherit; font-weight: 400; }
    blockquote { border-left: 4px solid #4361ee; margin: 12px 0; padding: 8px 12px; background: #f5f7ff; }
    img { max-width: 100%; height: auto; margin: 8px 0; page-break-inside: avoid; }
    ul, ol { margin: 6px 0; padding-left: 18px; }
    li { margin: 2px 0; }
    p { margin: 6px 0; }
    </style>
    """)
    html = html.replace('</head>', css + '</head>')
    return html


def review_pdf(pdf_path: str, md_path: str) -> dict:
    """Post-generation review: check PDF quality and return a report dict."""
    report = {
        'pdf_path': pdf_path,
        'pdf_size_kb': os.path.getsize(pdf_path) // 1024 if os.path.exists(pdf_path) else 0,
        'pages': 0,
        'images': 0,
        'mermaid_total': 0,
        'mermaid_rendered': 0,
        'mermaid_fallback': 0,
        'fallback_lines': [],
        'chinese_lines': 0,
        'total_lines': 0,
        'issues': [],
    }

    # --- PDF page count ---
    try:
        from PyPDF2 import PdfReader
        reader = PdfReader(pdf_path)
        report['pages'] = len(reader.pages)
    except Exception:
        pass

    # --- Image count via pdfimages ---
    try:
        result = subprocess.run(
            ['pdfimages', '-list', pdf_path],
            capture_output=True, text=True, timeout=30,
        )
        img_lines = [l for l in result.stdout.strip().split('\n')
                     if l.strip() and not l.startswith('page')]
        report['images'] = len(img_lines)
    except Exception:
        pass

    # --- Text extraction & mermaid fallback detection ---
    try:
        result = subprocess.run(
            ['pdftotext', pdf_path, '-'],
            capture_output=True, text=True, timeout=60,
        )
        lines = result.stdout.strip().split('\n')
        report['total_lines'] = len(lines)

        # Count Chinese lines
        report['chinese_lines'] = sum(
            1 for l in lines if any('一' <= c <= '鿿' for c in l)
        )

        # Detect mermaid fallback: flowchart/graph/sequenceDiagram appearing as plain text
        mermaid_kw = ['flowchart TD', 'flowchart TB', 'flowchart LR',
                       'graph TB', 'graph TD', 'graph LR',
                       'sequenceDiagram', 'stateDiagram', 'mindmap']
        for line in lines:
            s = line.strip()
            for kw in mermaid_kw:
                if s.startswith(kw):
                    report['mermaid_fallback'] += 1
                    report['fallback_lines'].append(s[:100])
                    break
    except Exception:
        pass

    # --- Count mermaid blocks in source markdown ---
    try:
        md_text = Path(md_path).read_text(encoding='utf-8')
        pat = re.compile(r'^```mermaid', re.MULTILINE)
        report['mermaid_total'] = len(list(pat.finditer(md_text)))
        report['mermaid_rendered'] = report['mermaid_total'] - report['mermaid_fallback']
    except Exception:
        pass

    # --- Issue detection ---
    if report['mermaid_fallback'] > 0:
        report['issues'].append(
            f"⚠️  {report['mermaid_fallback']} mermaid diagram(s) fell back to plain code"
        )
    if report['pdf_size_kb'] < 10:
        report['issues'].append("⚠️  PDF file suspiciously small (< 10 KB)")
    if report['pages'] == 0:
        report['issues'].append("❌  Could not read PDF page count")
    if report['chinese_lines'] == 0 and report['total_lines'] > 0:
        report['issues'].append("⚠️  No Chinese text detected — possible encoding issue")

    return report


def print_review(report: dict):
    """Pretty-print the review report."""
    print('\n' + '=' * 60)
    print('📋 PDF Review Report')
    print('=' * 60)
    print(f'  📄 File:       {report["pdf_path"]}')
    print(f'  📊 Size:       {report["pdf_size_kb"]:,} KB ({report["pdf_size_kb"]/1024:.1f} MB)')
    print(f'  📖 Pages:      {report["pages"]}')
    print(f'  🖼️  Images:     {report["images"]}')
    print(f'  📝 Text lines: {report["total_lines"]:,}')
    print(f'  🇨🇳 Chinese:   {report["chinese_lines"]:,} lines')
    print()

    # Mermaid stats
    total = report['mermaid_total']
    rendered = report['mermaid_rendered']
    fallback = report['mermaid_fallback']
    if total > 0:
        rate = rendered / total * 100
        print(f'  📊 Mermaid diagrams: {rendered}/{total} rendered ({rate:.1f}%)')
        if fallback > 0:
            print(f'     ⚠️  {fallback} fell back to code block:')
            for line in report['fallback_lines'][:5]:
                print(f'        → {line[:80]}')
    else:
        print(f'  📊 Mermaid diagrams: none found')
    print()

    # Issues
    if report['issues']:
        print('  Issues:')
        for issue in report['issues']:
            print(f'    {issue}')
    else:
        print('  ✅ No issues detected')

    print('=' * 60)
    return len(report['issues']) == 0


def convert(md_path: str, pdf_path: str) -> bool:
    """Main conversion routine.  Returns True on success."""
    md_text = Path(md_path).read_text(encoding='utf-8')

    # 1. Extract and render mermaid blocks
    blocks = extract_mermaid_blocks(md_text)
    workdir = tempfile.mkdtemp(prefix='md2pdf_')
    print(f'  📊 {len(blocks)} mermaid diagram(s) found')

    rendered_count = 0
    fallback_count = 0

    for i, blk in enumerate(blocks, 1):
        print(f'     Rendering {i}/{len(blocks)}...', end=' ')
        png = render_mermaid(blk['code'], f'{i:02d}', workdir)
        if png:
            md_text = md_text.replace(blk['group'], f'\n\n![](file://{png})\n\n', 1)
            rendered_count += 1
            print('✅')
        else:
            md_text = md_text.replace(blk['group'], f'\n```\n{blk["code"]}\n```\n', 1)
            fallback_count += 1
            print('⚠️  (fallback to plain code)')

    # 2. Convert Markdown → HTML with pandoc
    title = Path(md_path).stem.replace('-', ' ').title()
    html = make_html(md_text, title)

    # 3. WeasyPrint → PDF
    tmp_html = os.path.join(workdir, 'out.html')
    Path(tmp_html).write_text(html, encoding='utf-8')
    print('  🖨️  Generating PDF...')
    subprocess.run(
        ['python3', '-m', 'weasyprint', tmp_html, pdf_path],
        capture_output=True, text=True, timeout=120,
    )

    shutil.rmtree(workdir, ignore_errors=True)

    success = os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 0
    if not success:
        return False

    # 4. Post-generation review
    report = review_pdf(pdf_path, md_path)
    clean = print_review(report)

    return success


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ('-h', '--help'):
        print(__doc__.strip())
        return

    md_path = sys.argv[1]
    if len(sys.argv) >= 3:
        pdf_path = sys.argv[2]
    else:
        pdf_path = re.sub(r'\.md$', '.pdf', md_path, flags=re.IGNORECASE)
        if pdf_path == md_path:
            pdf_path = md_path + '.pdf'

    if not os.path.isfile(md_path):
        print(f'❌ Input file not found: {md_path}')
        sys.exit(1)

    check_deps()
    print(f'📄 {Path(md_path).name} → {Path(pdf_path).name}')
    ok = convert(md_path, pdf_path)
    if ok:
        size = os.path.getsize(pdf_path) // 1024
        print(f'✅ Done — {pdf_path} ({size} KB)')
    else:
        print(f'❌ Conversion failed')
        sys.exit(1)


if __name__ == '__main__':
    main()
