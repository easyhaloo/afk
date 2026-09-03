# AFK Native Graph Engine：以 TypeScript 内建 Archify 式可验证工作流图能力

**作者：Manus AI**  
**状态：架构蓝图，建议进入 RFC**  
**目标：以 AFK 自有 TypeScript 代码实现工作流图的配置、布局、路由、验证与渲染，不把 Archify CLI 作为产品运行时依赖。**

## 结论

建议新建零运行时依赖的共享包 **`@afk/workflow-graph`**，将当前 `desktop-client/src/main.tsx` 中的临时布局、SVG path 和几何判断迁移为可测试的 TypeScript 内核。它应当借鉴 Archify 的产品原则——typed IR、确定性布局、关系可验证、有限 trace、最终收据——但使用 AFK 的领域模型、配置和界面语言，而不是复制 Archify viewer 或把外部 HTML 嵌入 Electron。[1] [2]

这条路线比“把 Archify HTML 内嵌进当前桌面端”更适合 AFK。它既能维持 AFK 对执行事实的权威，也能使配置画布、CLI 校验、桌面端渲染和未来导出使用同一套图计算结果。Archify 可继续作为设计对照、fixture 互操作工具和视觉质量基准，但不进入最终用户的运行时依赖链。

> **AFK Native Graph Engine 的职责是把已解析的 AFK workflow 变成一份确定性、可验证、可渲染的图快照；它不能反向定义或改变 AFK 的执行语义。**

| 方案 | 优点 | 主要问题 | 结论 |
|---|---|---|---|
| 直接调用 Archify CLI | 可快速获得完整 HTML viewer | 外部运行时、版本耦合、双产物模型、Electron 加载边界更复杂 | 适合作为审阅/导出适配器，而非默认引擎。|
| 将 Archify HTML 内嵌在主画布 | 视觉效果直接 | 编辑与审阅混杂、脚本隔离风险、无法与原生 Inspector 协同 | 不建议。|
| 原生 TypeScript 图引擎 | 同一语义可供 CLI/主进程/renderer 使用；测试与状态治理统一 | 需要分阶段实现布局与验证 | **建议采用。** |

## 1. 设计目标与非目标

原生引擎的第一个版本应准确表达 AFK 已有的 workflow 模板事实：`steps`、`kind`、`role`、`provider`、`action`、`dependsOn` 和 `when`。它需要为主路径、并行步骤、系统操作和条件分支提供确定性布局与正交关系；还需要生成机器可读的几何诊断，而不是只“画出来看起来像”。Archify 的 workflow 指南强调有界的、以事实为中心的技术图，而不是将未掌握的数据编造成完整系统地图；AFK 应保持同一约束。[1] [2]

原生引擎不应在 v1 试图复刻 Archify 的全部产品能力。PATH、MAP、LENS、guided story、品牌抓取、HTML 分享卡与 WebM 导出都必须等待 AFK 拥有对应的真实数据模型和明确用户场景。AFK 也不应在引擎内部执行 Agent、读取项目任意文件或订阅长驻后台事件。

| 能力 | v1 | 后续条件 | 明确不做 |
|---|---|---|---|
| Workflow 图 | 支持 | 已有模板字段即可支持 | 无。|
| 自动布局与正交路由 | 支持 | 纯函数 + geometry validator | 不让坐标改变执行顺序。|
| 手工节点拖拽 / pinned layout | 支持 | 保存到 `desktop.workflowGraph.layouts` | 不将位置写回 YAML step 语义。|
| 条件边与标签 | 支持 | 仅来自 `when` | 不把条件当当前运行状态。|
| Run overlay | 第二阶段 | run event 必须关联 `stepId` | 不根据 prompt 或终端文本推断。|
| HTML/SVG/PNG 导出 | 第二阶段 | 纯 SVG renderer 与导出接口稳定 | 不嵌入未受控远程内容。|
| Architecture / sequence / lifecycle | 独立 RFC | AFK 形成对应事实模型 | 不复用 workflow 字段强行构造。|

## 2. 推荐的代码边界

当前桌面端已有 React、TypeScript、SVG 和受控 Electron IPC，但工作流图逻辑集中在 `desktop-client/src/main.tsx`。这使布局、路径、节点尺寸、主题样式和交互状态容易漂移；近期出现的 SVG 高度与节点常量错位就是一个具象风险。应将纯计算从 UI 中剥离为共享包，保证 CLI 检查、主进程产物生成与 renderer 都依赖同一实现。

```text
packages/afk-workflow-graph/
  src/
    ir.ts                 # 版本化图 IR、配置和收据类型
    project.ts            # WorkflowTemplate -> GraphDefinition
    normalize.ts          # 稳定 ID、拓扑排序、默认轨道与阶段
    layout.ts             # 分层、轨道高度、pinned override 合并
    routing.ts            # 端口分散、正交路由、标签锚点
    validate.ts           # 语义、几何、可读性与视觉约束
    receipt.ts            # input/layout/output hash 与诊断收据
    theme.ts              # semantic token，不含 React/CSS
    index.ts
  test/
    fixtures/*.ts
    layout.test.ts
    routing.test.ts
    validate.test.ts
    determinism.test.ts

src/application/workflows/
  graph-snapshot.ts       # AFK CLI 调用共享包的适配器

desktop-client/
  electron/graph-ipc.ts   # 受控快照/导出 IPC
  src/workflow-graph/
    GraphSurface.tsx      # 只消费 GraphSnapshot
    GraphInspector.tsx
    graph.css
```

共享包应是**浏览器与 Node 兼容**的纯 TypeScript，不导入 React、Electron、文件系统、YAML parser 或子进程。输入 YAML 的解析继续由 AFK domain 层承担；持久化继续由 Electron main process 承担；React 只渲染由内核产出的 `GraphSnapshot`。这样的分层可以让同一个 fixture 在 Vitest、Electron CDP 和未来 CLI 中检查。

| 层 | 输入 | 输出 | 禁止依赖 |
|---|---|---|---|
| `@afk/workflow-graph` | `WorkflowGraphDefinition`、可选 layout preferences | `GraphSnapshot`、`GraphReceipt` | React、Electron、Node fs、YAML、DOM。|
| AFK application adapter | 已解析 `WorkflowTemplate`、可选 run facts | `WorkflowGraphDefinition` | renderer 状态。|
| Electron main | workspace、已解析快照、用户受控 layout patch | IPC DTO、原子保存结果 | renderer 指定命令或路径。|
| React renderer | `GraphSnapshot`、局部 selection/pan/zoom state | SVG/HTML UI | 业务 YAML 解析、文件写入。|

## 3. 版本化配置与 IR

AFK YAML 继续是执行配置；图引擎使用一份**派生 IR**，而不是让用户编辑第二份 steps/edges 定义。所有业务关系都只能由 `dependsOn` 与 `when` 投影。项目可保存的仅是视觉偏好、固定节点位置和展开状态。

```ts
export interface WorkflowGraphDefinition {
  schemaVersion: 1;
  kind: 'workflow';
  source: {
    templateId: string;
    templateVersion?: number;
    contentHash: string;
    generatedAt: string;
  };
  steps: ReadonlyArray<GraphStep>;
  options: {
    layout: 'layered-lanes';
    direction: 'left-to-right';
    tracks: 'auto';
    nodeSize: { width: 164; height: 94 };
    motion: 'finite-trace' | 'none';
  };
  preferences?: WorkflowGraphPreferences;
}

export interface GraphStep {
  id: string;
  order: number;
  role: string;
  kind: 'agent' | 'system';
  provider?: string;
  action?: string;
  dependsOn: readonly string[];
  when?: { step: string; equals: string };
}

export interface WorkflowGraphPreferences {
  pinned?: Record<string, { x: number; y: number }>;
  collapsedTracks?: readonly GraphTrackId[];
  presentation?: 'classic' | 'signal-flow';
}
```

对应的项目配置建议保留在既有 `.afk/config.yml` 的 `desktop` 命名空间，而不是新建业务 workflow 文件。`pinned` 只是一项视觉覆盖；若节点 ID 在模板中不再存在，读取时应丢弃该覆盖并记录非致命诊断。

```yaml
desktop:
  workflowGraph:
    layouts:
      sequential-review:
        presentation: signal-flow
        pinned:
          review: { x: 410, y: 54 }
```

| 配置类别 | 保存位置 | 写入者 | 是否影响 CLI 执行 |
|---|---|---|---|
| step、依赖、条件、prompt、provider | `.afk/workflows/*.yml` | AFK / 受控 workflow 编辑器 | 是。|
| 当前 template | `.afk/config.yml.template` | AFK Control | 是。|
| layout、pinned、presentation | `.afk/config.yml.desktop.workflowGraph` | AFK Control | 否。|
| 运行坐标、路由、验证收据 | `.afk/cache/graph/` | 主进程 | 否。|

## 4. 纯内核：标准化、布局、路由与验证

### 4.1 标准化

`normalizeDefinition()` 首先检查 ID 唯一性、缺失依赖、条件引用、环路和稳定排序。稳定排序的优先级为 YAML 原始 `steps` 顺序、父节点中位轨道位置和 ID；同一个输入在不同平台上必须产生相同输出。若图不是 DAG，布局器不应尝试“猜测”环路语义，而是返回 `semantic/cycle` 诊断。

### 4.2 阶段与轨道布局

阶段列等于拓扑深度。轨道是有严格映射规则的有限枚举：`agent`、`system`、`conditional`。`when` 优先于 `kind`，因此条件 Agent 会进入条件轨道；这是“条件定义”而非“异常状态”。同列的并行节点采用确定性行距；下一层通过父节点的垂直中位数排序，以降低无意义的边交叉。

```ts
export type GraphTrackId = 'agent' | 'system' | 'conditional';

export function trackOf(step: GraphStep): GraphTrackId {
  if (step.when) return 'conditional';
  return step.kind === 'system' ? 'system' : 'agent';
}
```

布局器输出的不是 React style，而是不可变几何快照。其 `world`、`phaseBounds`、`trackBounds`、node rect 与 edge route 都带显式尺寸，因此 SVG 与 DOM 节点不再分别维护 `154×104`、`164×94` 之类易漂移常量。

### 4.3 端口分散和正交路由

每个边的起点和终点首先从节点矩形计算；共享端点按相邻边顺序分配有限的 y-port offset，而不是让所有并行边穿过同一个中心点。相同行走轨道的边使用一段水平线；跨轨道边使用仅位于 source/target 之间净空的水平—垂直—水平路径。路由器必须以 node rectangles、track labels 和 edge labels 作为障碍物。

```ts
export interface OrthogonalRoute {
  edgeId: string;
  sourcePort: Point;
  targetPort: Point;
  points: readonly Point[];
  label?: { text: string; anchor: Point; bounds: Rect };
}
```

当局部规则无法找到无碰撞路径时，v1 应返回 `geometry/no-route`，而不是偷偷绘制穿过节点的线。v1.1 可以加入受限 Manhattan 搜索；但搜索必须使用确定性 tie-break，并受 node count、world size 与时间预算限制。

### 4.4 验证器与收据

验证器是该引擎与一般画布代码最重要的差异。它至少分为四类：语义、几何、标签和构图。每条诊断都需要携带稳定 code、subject、evidence 与 supported fixes，以便 UI 直接呈现可行动的错误信息。这个模式与 Archify 对 typed JSON、路由/标签校验和最终接受收据的强调一致。[1] [2]

| 检查域 | 示例规则 | 失败示例 |
|---|---|---|
| `semantic/*` | step ID 唯一；依赖存在；无 cycle；when 引用存在 | `semantic/missing-dependency`。|
| `geometry/*` | 路由起止点位于对应端口；不得穿过无关节点 | `geometry/node-intrusion`。|
| `label/*` | 条件标签不与节点、关系或 Inspector safe area 相交 | `label/collision`。|
| `composition/*` | 并行节点不交叠；阶段/轨道可读；world 不裁切 | `composition/overlap`。|
| `integrity/*` | Definition、snapshot、receipt 的 SHA-256 一致 | `integrity/stale-input`。|

`GraphReceipt` 应区分 `accepted`、`rejected`、`stale` 和 `degraded`。只有 `accepted` 快照可以作为导出或共享基线；`degraded` 只允许本地编辑预览，不允许覆盖最后可信布局。这个行为应当对用户可见，而不是静默地展示一个错误图。

## 5. Electron 与桌面端结合

React 工作流编辑器可以在收到 `GraphSnapshot` 后只处理局部交互：选择、悬浮、panning、zoom、Inspector 折叠和动画触发。布局不是 React effect 中重新计算的副作用；模板、偏好或容器尺寸变化才会调用引擎。渲染器不获取文件路径、YAML 原始内容或 shell 权限。

```text
Renderer action
  -> preload graph API (typed whitelist)
  -> Electron main validates workspace/template ID
  -> graph service reads parsed AFK snapshot
  -> @afk/workflow-graph computes/validates snapshot
  -> main returns GraphSnapshot + GraphReceipt
  -> GraphSurface renders SVG paths + HTML nodes
```

| UI 部位 | 原生引擎输入 | 交互输出 | 说明 |
|---|---|---|---|
| 工作流主画布 | `GraphSnapshot` | selection、pan、zoom | 不重算业务关系。|
| Inspector | selected node 的语义/运行 facts | 受控 config patch | 编辑仍写回 AFK YAML/config。|
| 自动整理 | Definition + visual preferences | 新 `pinned` / layout receipt | 只改变视觉设置。|
| 路径强调 | selected edge set | finite trace token | 一次性 140–200ms；拖拽时暂停。|
| 导出 | accepted snapshot | SVG/HTML/PNG request | 主进程生成，renderer 无路径权限。|

建议保留现有 native canvas，先把它的布局与 routing 替换为 `GraphSnapshot`。随后可新增“审阅”视图：同一快照在更宽的只读页面中显示轨道、诊断与 receipt，而不是嵌入外部脚本 viewer。这样 Inspector、主题、字体、密度、快捷键和测试体系都继续由 AFK Control 自己掌控。

Electron 官方安全建议仍然适用：renderer 应保持 sandbox、context isolation 与 `nodeIntegration: false`；preload 只暴露具体验证过的接口；任何导出路径均由主进程或系统保存对话框生成。[3]

## 6. 迁移策略

迁移必须让现有用户的自定义工作流可用，并能够逐次验证，不得一次性替换编辑器。建议通过 feature flag `desktop.workflowGraph.engine: 'legacy' | 'native'` 进行灰度。native 模式每次生成 `GraphSnapshot` 后，可以在开发/测试环境与 legacy 几何结果做差异报告；只有在内置 fixtures 和 CDP 回归通过后才成为默认。

| 阶段 | 变更 | 兼容保证 | 退出条件 |
|---|---|---|---|
| N0：抽取 | 将常量、拓扑、路由抽为纯函数，但仍由旧 UI 调用 | 当前画布、保存格式不变 | 六个模板的快照测试固定。|
| N1：验证 | 接入 `GraphReceipt`，开发模式展示 diagnostics | legacy 绘制仍可回退 | 无语义/几何误报。|
| N2：渲染 | `GraphSurface` 取代 `main.tsx` 内嵌 SVG/layout | `desktop.canvas.nodes` 继续读取 | CDP 几何、多视口、主题回归通过。|
| N3：偏好 | 引入 `desktop.workflowGraph.layouts` 与 pinned nodes | 原 `canvasNodes` 自动迁移 | 保存/回读保持无损。|
| N4：导出 | 由 accepted snapshot 导出 SVG/HTML/PNG | 不依赖外部 Archify CLI | 安全与文件写入回归通过。|

## 7. 验收与质量门槛

原生引擎需要像业务逻辑一样测试，而不能只依赖视觉截图。每一个 builtin template 与项目 custom template 都要接受：拓扑准确、route 端点准确、无节点穿越、无标签碰撞、无 node overlap、确定性 hash 一致、多视口可读和 reduced-motion 静态化。当前 AFK Control 的 CDP 回归已验证端点误差、条件标签、并行布局和自定义保存；这些应迁入包级单测和 UI 集成测试，而不是保留在一份巨大脚本中。

```text
Required acceptance
  semantic checks: 100% of steps / dependsOn / when mapped
  geometry checks: endpoint error <= 1px; 0 node intrusions; 0 overlaps
  determinism: same definition + preferences => same snapshot hash
  UI: 1440×920, 1100×720, 1024×768, 768×720 no document overflow
  accessibility: keyboard selection; reduced-motion has no trace animation
  persistence: custom Agent/QA produces executable project template exactly once
```

## 8. 实施建议

建议批准 N0–N2 作为一个独立的图引擎工作流，而不是继续在 `main.tsx` 末尾追加 CSS 覆盖。首先将当前已经验证的六个内置模板、一个自定义 Agent/QA 模板和一个条件模板固化为 fixtures；然后实现 `ir → normalize → layout → route → validate → receipt` 的纯函数链；最后替换 renderer。N3 与 N4 需要等 N2 稳定后再讨论。

这个方案保留了 Archify 最有价值的部分：明确的配置 IR、可证明的路由、有限而有意义的动效和可审阅的产物；同时它让 AFK 成为自身视觉与执行模型的所有者，不再依赖外部 HTML viewer 作为关键运行时组件。

## References

[1]: https://github.com/tt-a1i/archify/blob/main/archify/SKILL.md "Archify SKILL.md"
[2]: https://tt-a1i.github.io/archify/guide.html "Archify Scenario Guide"
[3]: https://www.electronjs.org/docs/latest/tutorial/security "Electron Security"
