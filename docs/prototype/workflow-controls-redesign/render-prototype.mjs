import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outputDir = dirname(fileURLToPath(import.meta.url));
const width = 1600;
const height = 1000;
const colors = {
  bg: '#eef0ec', dark: '#4e5450', dark2: '#eef2ed', panel: '#ffffff', panelSoft: '#f7f8f5',
  text: '#30342f', muted: '#737a73', subtle: '#9aa19a', border: '#dfe2dc', borderStrong: '#c9cfc7',
  accent: '#5268a2', accentSoft: '#eef2fb', green: '#4f8b7d', greenSoft: '#edf7f3',
  amber: '#b9792d', amberSoft: '#fff5e9', red: '#a6534d', redSoft: '#fff1ef', neutralSoft: '#f1f2ef', orange: '#d57d22'
};

const escapeText = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const rect = (x, y, w, h, fill, rx = 0, stroke = 'none', strokeWidth = 1, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" ${extra}/>`;
const text = (x, y, value, size = 12, fill = colors.text, weight = 500, anchor = 'start', family = 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif', extra = '') => `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" ${extra}>${escapeText(value)}</text>`;
const line = (x1, y1, x2, y2, stroke = colors.border, strokeWidth = 1, extra = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${strokeWidth}" ${extra}/>`;
const circle = (cx, cy, r, fill, stroke = 'none', strokeWidth = 1) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;

function pill(x, y, label, tone = 'neutral') {
  const tones = {
    accent: [colors.accentSoft, colors.accent, '#ccd6ee'], success: [colors.greenSoft, colors.green, '#cee5dc'],
    warning: [colors.amberSoft, colors.amber, '#efd9b8'], danger: [colors.redSoft, colors.red, '#ebcfcb'], neutral: [colors.neutralSoft, '#737a72', '#dfe2dc']
  };
  const [, color] = tones[tone];
  return `${circle(x + 3, y + 8, 2.5, color)}${text(x + 10, y + 11, label, 7.8, color, 700)}`;
}

function iconButton(x, y, glyph, accent = false, size = 28) {
  const fill = accent ? colors.accent : colors.panel;
  const stroke = accent ? colors.accent : colors.border;
  const color = accent ? '#ffffff' : '#687068';
  return `${rect(x, y, size, size, fill, 4, stroke)}${line(x + 6, y + .5, x + size - 6, y + .5, accent ? '#858f88' : '#b8c2b9', 1)}${text(x + size / 2, y + size / 2 + 4, glyph, size <= 28 ? 13 : 15, color, 520, 'middle')}`;
}

function textButton(x, y, label, kind = 'secondary', w = 88) {
  const palette = kind === 'primary'
    ? ['#343936', '#343936', '#ffffff']
    : kind === 'tertiary' ? ['transparent', 'transparent', colors.muted] : [colors.panel, colors.border, '#505750'];
  return `${rect(x, y, w, 26, palette[0], 4, palette[1])}${kind === 'primary' ? line(x + 7, y + .5, x + w - 7, y + .5, '#707771', 1) : ''}${text(x + w / 2, y + 17, label, 8.2, palette[2], 700, 'middle')}`;
}

function sidebar(x, y, h, activeLabel = '工作流') {
  const items = [['▦', 'Backlog'], ['◇', '工作流'], ['⌁', '运行记录'], ['⚙', '设置']];
  let body = rect(x, y, 118, h, colors.panel, 13, colors.border);
  body += text(x + 24, y + 37, 'A', 24, '#565d58', 850, 'middle') + text(x + 47, y + 29, 'AFK / CONTROL', 9.5, '#303530', 800, 'start', 'ui-monospace, SFMono-Regular, monospace', 'letter-spacing="1"');
  body += text(x + 47, y + 42, 'LOCAL OPERATIONS', 5.8, '#9ca29c', 600, 'start', 'ui-monospace, SFMono-Regular, monospace', 'letter-spacing=".8"');
  body += line(x + 13, y + 59, x + 105, y + 59, '#eceee9');
  items.forEach(([glyph, label], index) => {
    const itemY = y + 90 + index * 43 + (index === 3 ? 25 : 0);
    const active = label === activeLabel;
    if (active) body += rect(x + 7, itemY - 21, 104, 34, colors.dark2, 8) + rect(x, itemY - 15, 3, 22, colors.orange, 1.5);
    body += text(x + 25, itemY + 1, glyph, 13, active ? '#718078' : '#8c938c', 500, 'middle');
    body += text(x + 43, itemY, label, 9.5, active ? colors.orange : '#697069', active ? 720 : 550);
  });
  body += line(x + 13, y + h - 54, x + 105, y + h - 54, '#eceee9');
  body += text(x + 14, y + h - 32, 'main · clean', 7.5, '#929992', 500, 'start', 'ui-monospace, SFMono-Regular, monospace');
  body += text(x + 14, y + h - 18, 'AFK Desktop 0.8', 7.5, '#b0b5b0', 500, 'start', 'ui-monospace, SFMono-Regular, monospace');
  return body;
}

function workflowCard(x, y, w, title, description, source, status, tone, meta, selected = false) {
  let card = `<g filter="url(#cardShadow)">` + rect(x, y, w, 190, colors.panel, 12, selected ? '#aab7d0' : colors.border, selected ? 1.4 : 1) + '</g>';
  card += text(x + 16, y + 23, source, 7.5, '#858c84', 700, 'start', 'ui-monospace, SFMono-Regular, monospace', 'letter-spacing="1"');
  card += text(x + w - 18, y + 24, '•••', 11, '#929890', 600, 'middle');
  card += text(x + 16, y + 64, title, 13, colors.text, 730);
  card += text(x + 16, y + 85, description, 8.5, colors.muted, 500);
  card += line(x + 16, y + 124, x + w - 16, y + 124, '#edf0eb');
  card += pill(x + 16, y + 145, status, tone);
  card += text(x + 16, y + 179, meta, 7.5, colors.subtle, 500, 'start', 'ui-monospace, SFMono-Regular, monospace');
  card += text(x + w - 20, y + 158, '↗', 13, selected ? colors.accent : '#858c85', 550, 'middle');
  return card;
}

function libraryScreen(x, y, w, h) {
  let out = `<g>` + rect(x, y, w, h, colors.panel, 14, '#cfd4cc') + sidebar(x, y, h);
  const contentX = x + 118;
  out += rect(contentX, y, w - 118, h, colors.panel, 0);
  out += rect(contentX, y, w - 118, 32, '#fafbf9', 0) + line(contentX, y + 32, x + w, y + 32, colors.border);
  out += text(contentX + 16, y + 20, 'AFK  ›  工作流', 7.5, '#929892', 600, 'start', 'ui-monospace, SFMono-Regular, monospace');
  out += text(contentX + 31, y + 68, 'WORKFLOWS', 8, colors.accent, 800, 'start', 'ui-monospace, SFMono-Regular, monospace', 'letter-spacing="1.3"');
  out += text(contentX + 31, y + 98, '工作流', 23, colors.text, 750);
  out += text(contentX + 31, y + 119, '选择模板，查看配置与最近运行状态。', 9.5, colors.muted, 500);
  out += iconButton(x + w - 49, y + 64, '+', false, 26);
  out += rect(contentX + 31, y + 145, 158, 29, colors.panel, 6, colors.border);
  out += rect(contentX + 34, y + 148, 47, 23, '#f0f2ee', 4) + text(contentX + 57, y + 163, '全部 5', 8, colors.text, 700, 'middle');
  out += text(contentX + 108, y + 163, '运行中 1', 8, colors.muted, 650, 'middle');
  out += text(contentX + 160, y + 163, '异常 1', 8, colors.muted, 650, 'middle');
  out += text(x + w - 31, y + 165, '按最近更新排序', 7.5, colors.subtle, 500, 'end', 'ui-monospace, SFMono-Regular, monospace');
  const cardW = (w - 118 - 77) / 2;
  out += workflowCard(contentX + 31, y + 193, cardW, 'Sequential Review', '实现、审阅与修复串行推进', 'MANAGED', '当前模板', 'accent', '6 步 · 4 Agent · 8 分钟前', true);
  out += workflowCard(contentX + 46 + cardW, y + 193, cardW, 'Parallel Implementation', '多 Agent 并行实现与统一验收', 'BUILT-IN', '运行中', 'accent', '8 步 · 6 Agent · 已运行 14 分钟');
  out += workflowCard(contentX + 31, y + 398, cardW, 'Release Guardrail', '构建、回归检查与发布门禁', 'PROJECT', '已阻塞', 'warning', '5 步 · 阻塞于 QA 验证');
  out += workflowCard(contentX + 46 + cardW, y + 398, cardW, 'Research First', '先研究上下文，再进入执行计划', 'BUILT-IN', '已完成', 'success', '7 步 · 昨天 18:42 完成');
  out += text(contentX + 31, y + h - 24, '状态不仅表示“当前模板”，还承载最近一次运行结果。', 8, colors.subtle, 500);
  out += `</g>`;
  return out;
}

function node(x, y, title, meta, status, tone = 'neutral', selected = false, dashed = false) {
  const toneColor = tone === 'accent' ? colors.accent : tone === 'success' ? colors.green : tone === 'warning' ? colors.amber : '#858c84';
  let out = `<g filter="url(#nodeShadow)">` + rect(x, y, 112, 76, colors.panel, 10, selected ? '#8799bc' : '#d1d7cf', selected ? 1.5 : 1, dashed ? 'stroke-dasharray="4 3"' : '') + '</g>';
  out += rect(x + 10, y + 10, 23, 23, selected ? colors.accentSoft : '#f0f2ee', 7);
  out += text(x + 21.5, y + 26, selected ? '⌁' : '◇', 11, selected ? colors.accent : '#737b72', 600, 'middle');
  out += circle(x + 67, y + 19, 2.5, toneColor) + text(x + 74, y + 22, status, 6.6, toneColor, 700);
  out += text(x + 10, y + 51, title, 9.5, colors.text, 700) + text(x + 10, y + 66, meta, 6.8, colors.subtle, 500, 'start', 'ui-monospace, SFMono-Regular, monospace');
  return out;
}

function studioScreen(x, y, w, h) {
  let out = `<g>` + rect(x, y, w, h, colors.panel, 14, '#cfd4cc') + sidebar(x, y, h);
  const contentX = x + 118;
  const headerH = 54;
  const inspectorW = 174;
  out += rect(contentX, y, w - 118, h, colors.panelSoft, 0);
  out += rect(contentX, y, w - 118, 32, '#fafbf9', 0) + line(contentX, y + 32, x + w, y + 32, colors.border);
  out += text(contentX + 16, y + 20, 'AFK  ›  工作流', 7.5, '#929892', 600, 'start', 'ui-monospace, SFMono-Regular, monospace');
  const topbarY = y + 32;
  out += rect(contentX, topbarY, w - 118, headerH, colors.panel, 0);
  out += line(contentX, topbarY + headerH, x + w, topbarY + headerH, colors.border);
  out += text(contentX + 14, topbarY + 29, '‹ 工作流', 8.5, colors.muted, 600);
  out += text(contentX + 130, topbarY + 23, 'AFK 内置', 6.5, colors.subtle, 650, 'start', 'ui-monospace, SFMono-Regular, monospace');
  out += text(contentX + 130, topbarY + 39, 'Sequential Review', 11, colors.text, 720);
  out += pill(x + w - 176, topbarY + 20, '未保存', 'warning');
  out += textButton(x + w - 105, topbarY + 14, '保存', 'primary', 56);
  const toolbarY = topbarY + headerH;
  const canvasW = w - 118 - inspectorW;
  out += rect(contentX, toolbarY, w - 118 - inspectorW, 38, '#fbfcfa', 0);
  out += line(contentX, toolbarY + 38, x + w - inspectorW, toolbarY + 38, colors.border);
  out += text(contentX + 13, toolbarY + 24, '执行画布', 9, colors.text, 700);
  out += iconButton(contentX + canvasW - 35, toolbarY + 7, '+', false, 24);
  out += text(x + w - inspectorW - 12, toolbarY + 24, '拖拽 · 缩放 · 平移', 6.7, colors.subtle, 500, 'end', 'ui-monospace, SFMono-Regular, monospace');
  const canvasY = toolbarY + 38;
  out += `<pattern id="dots-${x}" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#d8ddd5"/></pattern>`;
  out += rect(contentX, canvasY, canvasW, h - headerH - 70, `url(#dots-${x})`, 0);
  out += text(contentX + 20, canvasY + 29, 'AGENT FLOW', 6.8, '#9aa198', 700, 'start', 'ui-monospace, SFMono-Regular, monospace', 'letter-spacing="1"');
  out += text(contentX + 20, canvasY + 254, 'SYSTEM & GUARDRAILS', 6.8, '#9aa198', 700, 'start', 'ui-monospace, SFMono-Regular, monospace', 'letter-spacing="1"');
  const nx = contentX + 26;
  out += line(nx + 112, canvasY + 131, nx + 156, canvasY + 92, colors.accent, 1.7) + line(nx + 268, canvasY + 92, nx + 312, canvasY + 131, colors.accent, 1.7);
  out += line(nx + 120, canvasY + 318, nx + 210, canvasY + 124, '#c1c8bf', 1.4) + line(nx + 298, canvasY + 318, nx + 355, canvasY + 161, '#c1c8bf', 1.4);
  out += node(nx, canvasY + 94, '准备上下文', '01 · SYSTEM', '已完成', 'success');
  out += node(nx + 156, canvasY + 52, '实现任务', '02 · CODEX · 04:18', '运行中', 'accent', true);
  out += node(nx + 312, canvasY + 94, '代码审阅', '03 · REVIEWER', '等待中');
  out += node(nx + 64, canvasY + 281, '安全约束', 'GATE · SYSTEM', '通过', 'success', false, true);
  out += node(nx + 244, canvasY + 281, '完成验证', 'GATE · QA', '未开始', 'neutral', false, true);
  out += rect(contentX + canvasW - 131, y + h - 49, 117, 34, colors.panel, 9, colors.border) + text(contentX + canvasW - 112, y + h - 28, '−', 15, colors.muted, 500, 'middle') + text(contentX + canvasW - 72, y + h - 29, '100%', 7, colors.subtle, 600, 'middle', 'ui-monospace, SFMono-Regular, monospace') + text(contentX + canvasW - 34, y + h - 28, '+', 14, colors.muted, 500, 'middle');
  const ix = x + w - inspectorW;
  out += rect(ix, topbarY + headerH, inspectorW, h - headerH - 32, colors.panel, 0) + line(ix, topbarY + headerH, ix, y + h, colors.border);
  out += rect(ix + 14, y + 104, 28, 28, colors.accentSoft, 8) + text(ix + 28, y + 123, '⌁', 12, colors.accent, 600, 'middle');
  out += pill(ix + 111, y + 114, '运行中', 'accent');
  out += text(ix + 14, y + 155, '实现任务', 12, colors.text, 730) + text(ix + 14, y + 173, '执行编码任务并持续汇报进度。', 7.5, colors.muted, 500);
  out += line(ix + 14, y + 192, x + w - 14, y + 192, colors.border);
  out += text(ix + 14, y + 216, 'EXECUTION', 7, colors.subtle, 700, 'start', 'ui-monospace, SFMono-Regular, monospace', 'letter-spacing="1"');
  [['执行器', 'CODEX'], ['角色', 'IMPLEMENTER'], ['重试', '0 / 3']].forEach(([label, value], index) => {
    const rowY = y + 243 + index * 35;
    out += text(ix + 14, rowY, label, 8, colors.muted, 500) + text(x + w - 14, rowY, value, 7, '#464c45', 650, 'end', 'ui-monospace, SFMono-Regular, monospace');
    out += line(ix + 14, rowY + 12, x + w - 14, rowY + 12, '#edf0eb');
  });
  out += text(ix + 14, y + 370, 'LIVE STATUS', 7, colors.subtle, 700, 'start', 'ui-monospace, SFMono-Regular, monospace', 'letter-spacing="1"');
  [['已运行', '04:18'], ['上下文', '42%'], ['最近活动', '12 SEC AGO']].forEach(([label, value], index) => {
    const rowY = y + 397 + index * 35;
    out += text(ix + 14, rowY, label, 8, colors.muted, 500) + text(x + w - 14, rowY, value, 7, '#464c45', 650, 'end', 'ui-monospace, SFMono-Regular, monospace');
    out += line(ix + 14, rowY + 12, x + w - 14, rowY + 12, '#edf0eb');
  });
  out += textButton(ix + 14, y + h - 43, '运行详情  →', 'tertiary', 92);
  out += `</g>`;
  return out;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="screenShadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#344033" flood-opacity=".13"/></filter>
    <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="5" stdDeviation="8" flood-color="#344033" flood-opacity=".06"/></filter>
    <filter id="nodeShadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#344033" flood-opacity=".075"/></filter>
  </defs>
  ${rect(0, 0, width, height, colors.bg)}
  ${text(42, 49, 'WORKFLOW UI REDESIGN', 10, colors.accent, 800, 'start', 'ui-monospace, SFMono-Regular, monospace', 'letter-spacing="2"')}
  ${text(42, 82, '按钮与状态标签 · 当前设计 × Manus / Codex', 26, colors.text, 760)}
  ${text(1558, 78, 'HI-FI PROTOTYPE · V3', 9, colors.subtle, 650, 'end', 'ui-monospace, SFMono-Regular, monospace')}
  <g filter="url(#screenShadow)">${libraryScreen(34, 112, 754, 840)}</g>
  <g filter="url(#screenShadow)">${studioScreen(812, 112, 754, 840)}</g>
  ${rect(52, 127, 84, 22, '#fff4e7', 11, '#f0d5b2')}${text(94, 142, '列表状态', 8.5, colors.orange, 700, 'middle')}
  ${rect(830, 127, 84, 22, '#fff4e7', 11, '#f0d5b2')}${text(872, 142, '画布状态', 8.5, colors.orange, 700, 'middle')}
</svg>`;

writeFileSync(join(outputDir, 'workflow-controls-redesign.svg'), svg);
