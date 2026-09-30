# JumpServer Auto-Sync — 原型图

3 种风格对照，每种风格各 4 个页面状态（顶部 tab 切换）。

## 选定：✅ Style C — AFK current (graphite)

> **C 与 AFK 现有桌面视觉完全一致**，便于落地时复用 control.css / palette.css 的设计 token。

对比候选：

| 文件 | 风格 | 主色 | 字体 | 选定 |
|------|------|------|------|------|
| [style-a-vscode-dark.html](style-a-vscode-dark.html) | VSCode 深色 | `#007acc` 蓝 + `#3aa56d` 绿 | SF Pro + JetBrains Mono | — |
| [style-b-notion-light.html](style-b-notion-light.html) | Notion 浅色 | `#2383e2` 蓝 + `#0f7b0f` 绿 | Inter | — |
| [style-c-afk-current.html](style-c-afk-current.html) | AFK 当前（graphite） | `#6d5dfc` 靛 + `#627f6c` 绿 | System + AFK tokens | **✅** |

## 4 个页面状态（每个 HTML 都包含）

1. **List View** — 主机列表（堡垒机卡片 + 同步过来的主机表）
2. **Add Bastion Dialog** — 添加堡垒机模态框（含 Test Connection & Preview）
3. **Detail View** — 单个堡垒机展开（连接状态 + 同步日志 + 该堡垒机下主机）
4. **Error / Anomaly** — 异常状态（网络失败 / session 过期 / Windows 资产跳过）

## Mock 数据（三种风格一致）

- **堡垒机**: `dev-jumpserver-wangwendi` @ `dev-jumpserver.fangcloud.net:2222` (wangwendi)
- **资产总数**: 30（16 Linux + 14 Windows）
- **样本 Linux 资产**: bisheng, aidoc, aidoc-worker2, coze, dev-lsp, group-demo-ai知识库, llm-wiki, opensandbox, tmp-wwd-ck8-onebox, wpsV7-new, arm, cad_hc, 拱墅区数智人demo, test_oos, test_sharepoint, i-bp1b1r9kxhfhu5qzt5pq
- **样本 Windows 资产（默认跳过）**: i-23wevejyi, i-bp12teimcjm9g31k0qh9, i-bp1g8nzni5ljcgbzbne2, ...

## 选哪个？

**已选定 → C (AFK current graphite)**，理由：与现有桌面视觉一致，复用现有 CSS token。

A / B 保留作为对比参考，不删，方便日后改版时回看。

## 评审后下一步

确认风格后，进 plan mode 落正式实施文档 + 任务拆分。
