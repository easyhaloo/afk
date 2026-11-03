# AFK 架构图规范与 Eraser 源文件

本目录保存 AFK 架构图的可编辑源文件、视觉规范和生成说明。图中事实以当前源码与 `docs/architecture/` 下的架构文档为准；SVG/PNG 只是发布产物，不是唯一源文件。

## 推荐工具链

- **Eraser**：从公开 GitHub 仓库生成代码库架构图，使用 Diagram-as-Code 维护结构与关系，再使用画布微调布局。
- **Figma / FigJam**：用于最终视觉评审、演示排版和多方协作，不作为技术关系的唯一事实源。
- **GitHub**：保存本目录的 Diagram-as-Code、规范和最终导出的 SVG/PNG。

Eraser 可以直接读取公开 GitHub 仓库生成代码库图；也可在画布中使用 AI Diagram，根据自然语言或代码生成可继续编辑的图。官方文档：
- [Eraser Quickstart](https://docs.eraser.io/quickstart)
- [Codebase Diagrams](https://docs.eraser.io/codebase-diagrams)
- [Architecture Diagram Syntax](https://docs.eraser.io/architecture-diagram-syntax)
- [Export](https://docs.eraser.io/export)
- [Git Sync](https://docs.eraser.io/git-sync)

## 图集

| 源文件 | 视图 | 用途 |
| --- | --- | --- |
| [afk-system-architecture.eraser](./afk-system-architecture.eraser) | 系统全景 | 产品入口、共享包、Runtime 内部结构、扩展适配器和外部系统 |
| [afk-package-dependencies.eraser](./afk-package-dependencies.eraser) | 包依赖 | CLI/Desktop 与 workspace packages 的实际依赖方向 |
| [afk-execution-lifecycle.eraser](./afk-execution-lifecycle.eraser) | 执行闭环 | 工作项从 Provider Backlog 到人工合并的状态流转 |
| [afk-runtime-topology.eraser](./afk-runtime-topology.eraser) | 运行时拓扑 | CLI、Desktop Main/Worker、Agent 进程、Sandbox 与本地数据边界 |

## 视觉设计系统

### 画布与布局

- 默认横向 16:9 或宽屏画布；全景图可以采用 16:10。
- 主阅读方向固定为从左到右；流程图只在时序或阶段更容易理解时使用从上到下。
- 使用分组表达边界，最多三层嵌套；不要用大量孤立卡片替代真实架构关系。
- 主模块之间留出明显间距；连接线尽量短、少交叉，连接标签使用动词或契约名。
- 全景图控制在 20–25 个主要节点；复杂细节拆到独立视图，不把所有实现文件塞进总览。

### 颜色语义

| 颜色 | 语义 | 建议色 |
| --- | --- | --- |
| 蓝色 | 产品入口、应用服务、控制流程 | `#3977C8` |
| 青绿色 | Core、领域模型、稳定契约 | `#27877A` |
| 紫色 | Agent、Skills、Workflow Graph | `#8060B5` |
| 琥珀色 | QA、人工审核、注意事项 | `#C58A38` |
| 石板灰 | 基础设施、数据存储、外部边界 | `#64748B` |
| 红色 | 失败、阻断、安全边界 | `#C85C5C` |

颜色用于表达语义，不作为装饰；同一语义在所有图中必须保持一致。避免彩虹色、渐变堆叠和大面积高饱和背景。

### 图形与连线

- 圆角矩形：产品、服务、模块和能力。
- 圆柱/数据库图标：持久化数据。
- 终端/机器人图标：外部 Agent 进程。
- 六边形/容器边界：执行隔离区或信任边界。
- 实线箭头：同步调用或控制流。
- 虚线箭头：事件、异步通知或非强制关联。
- 双向箭头：明确的请求/响应或读写交互；不能因为“有关联”就使用双向箭头。

### 文本规范

- 中文为主，稳定的代码标识保留英文，例如 `@afk/runtime`、`QARunner`、`executeWorkItem`。
- 节点标题尽量不超过两行；职责说明只保留一行短语。
- 连接线标注动作或数据，例如“执行用例”“读审计事件”“认领租约”。
- 不展示与当前实现不符的目标架构、计划中模块或已删除的命令。

## 架构事实与绘图约束

1. `@afk/core` 是纯模型、事件、Reducer、策略和 Ports，不依赖 Node.js、Electron、React 或具体 Provider SDK。
2. `@afk/application` 依赖 Core，承载共享用例、Inventory、执行查询和观察契约。
3. `@afk/runtime` 依赖 Core、Application 和 Workflow Graph，组合执行编排及 Node 基础设施适配器。
4. CLI 与 Desktop 是两个产品入口；Desktop Renderer 不直接导入 Runtime。Electron Main 通过 typed IPC 提供能力，Managed execution 使用 detached Node Worker 调用共享 Runtime。
5. Provider Backlog 是业务状态权威来源；本地 Inventory 是缓存/索引，不能绘制成外部状态的权威替代品。
6. Agent Provider 与 Sandbox Provider 是正交扩展轴，不能合并成一个“Agent 类型”。
7. `afk run` 运行实现阶段；`afk execute` 管理实现、独立 QA、变更请求和人工合并门禁；`afk loop` 只轮询一个 Manifest 绑定的工作项。
8. AFK 不承担需求规划和工作项拆分，也不自动完成最终人工合并。

## 使用 Eraser 生成与导入

### 方式 A：从公开仓库生成

1. 打开 [Eraser](https://app.eraser.io/) 并创建 Canvas。
2. 新建 AI Diagram，选择 Codebase Diagram / Add repo。
3. 选择公开仓库 `easyhaloo/afk`；公开仓库不需要先建立私有仓库连接。
4. 使用下面的“全景图生成提示词”，指定要参考 `packages/`、`apps/cli/`、`apps/desktop/electron/`、`apps/desktop/src/`、`skills/` 和 `docs/architecture/`。
5. 核对依赖方向和执行语义，再进行视觉微调。

### 方式 B：使用本目录的 Diagram-as-Code

1. 打开 Eraser Canvas。
2. 插入 Diagram as Code。
3. 复制对应 `.eraser` 文件的完整内容到代码编辑器。
4. 生成后检查节点和连线；必要时在画布上做局部布局调整。
5. 导出 SVG（文档展示）及 PNG（预览）；保留 `.eraser` 源文件。

Eraser 的 SVG/PNG/PDF 导出适用于画布内容；draw.io、Visio 和 PowerPoint 导出存在图类型或套餐限制，使用时以 Eraser 当前导出面板为准。

## 全景图生成提示词

```text
为 GitHub 仓库 easyhaloo/afk 绘制一张专业的软件系统架构全景图，中文为主，保留代码包名和关键类名。

先阅读并交叉核对：
- docs/architecture/system-architecture-design.md
- docs/architecture/overview.md
- docs/architecture/full-workflow-e2e-architecture.md
- packages/core、packages/application、packages/runtime、packages/workflow-graph
- apps/cli
- apps/desktop/electron、apps/desktop/src

必须呈现：
1. 产品入口：CLI/TUI、Electron Desktop、Agent Skills。
2. 共享包：Core、Application、Runtime、Workflow Graph，以及真实依赖方向。
3. Runtime 内部 Domain、Application Services、Infrastructure 的职责。
4. 独立扩展轴：Backlog/Branch/Change Provider、Agent Provider、Sandbox Provider。
5. 托管执行闭环：Backlog → Eligibility/Claim → Manifest → Implementation → Independent QA → PR/MR → Human Merge。
6. 本地审计、Runtime 状态、预算、Journal 与只读观察入口。
7. 外部系统和信任边界。

视觉要求：
- 采用干净的企业级技术架构图风格，浅色背景、深蓝标题、低饱和蓝/青绿/紫/琥珀色。
- 使用清晰的分组、圆角模块、适量技术图标和正交连接线。
- 主阅读方向从左到右；不要使用装饰性渐变、卡通元素或过密小字。
- 节点不超过 25 个；复杂实现细节通过分图表达。
- 用实线表示同步调用/控制流，虚线表示事件/辅助关联。
- 不得臆造 Temporal、微服务、服务端部署、全局多任务调度器等仓库中不存在的能力。
- Desktop Renderer 不得直接连接 Runtime；必须经过 Preload IPC / Electron Main，Managed execution 通过独立 Worker。
- Provider Backlog 是业务状态权威来源；最终合并必须经过人工门禁。
```

## 更新与审查流程

- 架构实现发生变化时，先核验源码和架构文档，再更新对应视图源文件。
- 先审关系正确性，再做视觉微调；不能为了布局而改变依赖箭头语义。
- 每次导出时检查 SVG 中文字体回退、文字裁切、连接线穿越和图例完整性。
- README 只引用经人工/CI 核验的导出图片；保留可编辑源文件和生成提示词。
- 若引入自动同步，先验证 Eraser Git Sync 的分支、文件和 PR 规则，避免直接覆盖受保护的 `main`。
