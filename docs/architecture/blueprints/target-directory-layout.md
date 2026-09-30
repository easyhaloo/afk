# AFK 目标目录布局

**作者：** Mavis
**状态：** 提案，尚未采纳。本文档描述**目标态**，不描述当前代码库。
**范围：** 仓库根、`src/`、`packages/`、`docs/` 的组织规则；不含 `desktop-client/` 内部（其结构已符合目标）。
**决策依据：** 社区目录组织共识（单一源码根 / 功能内聚 / 命名说产品语言 / 单一命名约定 / 工具兜底），见文末「参考」。

---

## 1. 四条轴及其优先级

当前仓库实际按四条互不相容的轴切分，但从未声明优先级——这是「找不到东西」的根因。
目标布局把它们排成**有序**规则：

> **轴 1 运行边界** → **轴 2 依赖方向** → **轴 3 功能内聚** → **轴 4 读者类型**

- **轴 1 运行边界**：加载它的进程有几个？1 个 → `src/`；多个 → `packages/`；完全独立 → `desktop-client/`。
- **轴 2 依赖方向**：只在**同一个仓**内分层，依赖单向向下，永不反向。分层由 `pnpm architecture:check` 强制。
- **轴 3 功能内聚**：层**内部**按业务能力分组（`task-cockpit/`），**不按**文件类型（`components/`、`utils/`、`types/`）。
- **轴 4 读者类型**：只影响 `docs/`。代码与 agent 制品不受影响。

**不可跨越的两条边界**（硬约束）：

1. `skills/` 与 `docs/` 是**非代码制品**，任何 `.ts` 文件不得 import 它们。
2. `src/` 与 `packages/` 的产物不得互相内联拷贝逻辑；共享走 `packages/` 导出。

---

## 2. 目标目录树

```
afk/
├── packages/                        ← 轴 1：被 >1 个进程加载
│   ├── afk-core/                    ← 纯领域内核（零 I/O、零框架、零 node 内置模块）
│   │   └── src/  model · reducer · events · ports · execution-base-policy
│   ├── afk-contracts/               ← 跨进程端口契约 + 只读投影（待更名，见 §5.7）
│   │   └── src/  ports · execution-query · provider-inventory · observation · inventory
│   └── afk-workflow-graph/          ← 工作流图数据结构
│
├── src/                             ← 轴 1：CLI + TUI 进程的唯一源码根
│   ├── domain/                      ← 轴 2 L1 领域：类型 · reducer · 端口定义
│   │   ├── work-item/               ← 工作项身份（单数，规范名）
│   │   ├── backlog/
│   │   ├── branches/
│   │   ├── tracker/
│   │   ├── agents/                  ← 仅 provider 端口与能力声明
│   │   └── templates/               ← 模板数据结构与编译（不含 fs 读取）
│   │
│   ├── application/                 ← 轴 2 L2 用例：编排 workflow / run 状态
│   │   ├── workflows/               ← 主导航入口，改动最频繁
│   │   ├── runners/                 ← 执行器（原 modules/，见 §5.6）
│   │   ├── runtime/
│   │   ├── sessions/
│   │   ├── visualizations/
│   │   └── work-item/               ← 用例侧（与 domain 同名，见 §5.1）
│   │
│   ├── infrastructure/              ← 轴 2 L3 外部世界：全部 I/O 收敛于此
│   │   ├── git/  github/  gitlab/   ← 版本与工单系统
│   │   ├── sandbox/  tmux/  process/← 执行环境
│   │   ├── provider/                ← agent provider 适配器（实际 spawn 在此）
│   │   ├── tracker/                 ← provider 实现
│   │   ├── io/  config/  runtime/
│   │   └── observability/           ← 审计主干写入端
│   │
│   ├── cli/                         ← 轴 2 L4 入口：命令表面唯一真源
│   │   ├── command-registry.ts      ← 支持的命令即此表
│   │   ├── composition-root.ts      ← 唯一装配点
│   │   └── commands/                ← 一命令一文件
│   │
│   ├── views/                       ← 轴 2 L4 入口：Ink TUI，按功能分组
│   │   ├── board/                   ← 看板（task-cockpit/、navigation/ 为其子模块）
│   │   ├── app/  stats/  plugins/   ← 其余功能区
│   │   └── shared/                  ← 跨功能 UI 原语（唯一的 UI 例外）
│   │
│   ├── observability/               ← 横切：审计主干的查询 / 投影
│   ├── coordinator/                 ← 横切：跨切面协调
│   ├── plugin-sdk/                  ← 边界：对外插件契约（稳定的对外 API）
│   └── types/                       ← 仅 ambient .d.ts，不放业务类型
│
├── desktop-client/                  ← 轴 1：Electron 独立包（结构已达标，不动）
├── skills/                          ← 轴 4：agent 行为制品（142 文件，不可 import）
├── docs/                            ← 轴 4：人读文档
│   ├── architecture/                ← 现状：现在已经是什么
│   │   ├── blueprints/              ← 提案：建议采纳什么（含本文）
│   │   └── observability/
│   ├── adr/                         ← 已生效：编号永久决策记录
│   ├── guides/  product/  research/ ← 参考：怎么用 / 要什么 / 调研
├── tests/                           ← 跨层不变量：架构守卫 · 契约 · 端到端
├── scripts/  assets/  docker/
```

---

## 2.1 已核验：运行边界是干净的

实测 `desktop-client/` 对 `src/` 的 import 数为 **0**。它只通过 `packages/*` 复用领域
语义（`package.json` 里 `build:application` 显式编译 `../packages/afk-core` 与
`../packages/afk-application`）。

这条边界值得保持：**`src/` 可以任意重构而不影响 Electron**，反之亦然。
任何未来让 `desktop-client` 直接引用 `src/` 的改动都应视为破坏轴 1。

---

## 3. 目录职责声明

| 目录 | 职责 | 可依赖 | 禁止事项 |
| --- | --- | --- | --- |
| `packages/afk-core/` | 领域内核：状态机、事件、端口契约。CLI 与 Electron 共享同一份语义 | 无（零依赖） | 任何 `node:*`、任何 I/O、任何框架 |
| `packages/afk-contracts/` | 跨进程只读投影与端口：让 Electron 不必复制业务模型 | `afk-core` | 编排逻辑、副作用 |
| `packages/afk-workflow-graph/` | 工作流图结构与校验 | `afk-core` | I/O |
| `src/domain/` | CLI 侧领域类型、reducer、端口**定义** | `afk-core`、`shared` | **一切 I/O**；依赖 application 及以下 |
| `src/application/` | 用例编排：workflow / run / session 生命周期 | `domain`、`core`、`infrastructure`、`shared` | 依赖 `cli`、`views`；直接 spawn 进程 |
| `src/infrastructure/` | 全部 I/O：git、tmux、sandbox、tracker、文件、进程 | `domain`、`core`、`shared` | 业务决策；依赖 `application` 及以上 |
| `src/cli/` | 命令表面、参数解析、输出格式。**唯一真源** | `application`、`domain`、`infrastructure`、`shared`、`views` | 业务逻辑下沉；命令重复注册 |
| `src/views/` | Ink 渲染。按功能分组 | `application`、`domain`、`infrastructure`、`shared` | 业务逻辑；`components/utils/types` 式类型分组 |
| `src/observability/` | 审计主干的查询与投影 | `application`、`domain`、`infrastructure`、`core` | 写审计事件（属 infrastructure） |
| `src/coordinator/` | 跨切面协调：把用例与执行环境接起来 | `application`、`infrastructure` | 沉淀通用工具 |
| `src/plugin-sdk/` | 对外插件契约。**兼容性承诺面** | `domain` | 反向依赖仓库内部实现 |
| `src/types/` | 仅 ambient 声明（如 `node-sqlite.d.ts`） | — | 业务类型、任何运行时值 |
| `src/shared/` | 跨层纯工具与常量 | 无（最低层） | 业务规则、I/O |
| `skills/` | agent 行为定义 | — | 被 TS import；被 CLI 运行时加载 |
| `docs/` | 人读文档，按「状态」分目录（见 §3.1） | — | 承载构建逻辑 |
| `tests/` | 仓库级不变量：架构规则、跨层契约、端到端 | 全部 | 重复单元测试（那些应 colocate） |
| `desktop-client/` | Electron 独立进程 | 仅 `packages/*` | 内联复制 `src/` 业务逻辑；import `src/` |

### 3.1 `docs/` 的状态语义（一目录一状态）

| 目录 | 语义 | 命名 |
| --- | --- | --- |
| `docs/architecture/` | **现状**：系统现在是什么样 | 双语 `name.md` + `name.zh.md` |
| `docs/architecture/blueprints/` | **提案**：建议采纳，尚未实现 | 中文单份，`.md` |
| `docs/adr/` | **已生效**：编号永久决策记录 | `NNNN-kebab-case.md` |
| `docs/guides/` | 参考：怎么用 | 双语 |
| `docs/product/` | 参考：要什么 | 双语 |
| `docs/research/` | 参考：调研与盘点 | `topic-YYYY-MM-DD.md` |
| `docs/_archive/` | 归档：不再是当前指引 | 保留不动 |

---

## 4. 测试布局（单一约定）

**规则：跟着被测文件走（colocated），例外只有一种。**

| 位置 | 装什么 | 现状 |
| --- | --- | --- |
| `src/**/*.test.ts` | 单元 / 组件测试，与源码同目录 | ✅ 115 个，保持不变 |
| `src/domain`、`src/application` 内部 | 纯函数与 reducer 测试 | ✅ 保持 |
| `packages/*/tests/` | **收归**为 colocated，上移到 `packages/*/src/` | ❌ 15 个待迁移 |
| `tests/` | 仓库级不变量：架构守卫、跨层契约、E2E、fixtures | ⚠️ 9 个，需收窄职责并命名区分 |
| `desktop-client/tests/` | Electron 进程边界测试 | 独立包，维持现状 |

例外理由：只有**不属于任一源文件**的测试（架构规则、契约、E2E）才放 `tests/`。

---

## 5. 相对现状的变更清单

按「成本 / 收益」排序。每项标注是否影响运行时行为。

### 5.1 统一 `work-item` 拼写 — 纯重命名

`src/domain/work-item/`（保留，单数，规范名）与 `src/application/work-items/` → `work-item/`。

同一领域概念在两层用了两种拼写，grep 无法定位全貌，跨层 import 易错。
依据：`AGENTS.md` 已声明「Work identity is a contract」。

### 5.2 塌陷同名嵌套

`src/views/board/board/` → 内容上提到 `src/views/board/`。调用方从
`views/board/board/BoardView` 变为 `views/board/BoardView`。无命名冲突。

### 5.3 测试布局归一

`packages/*/tests/` 15 个文件上移为 colocated；根 `tests/` 收窄为不变量测试，
文件名加前缀区分（`contract-*` / `e2e-*` / `architecture-*`）。

### 5.4 拆解 `src/types/`

`src/types/board.ts`（含业务函数 `getTaskBacklogId()` 与 deprecated 字段 `iid`）
→ 并入 `src/views/board/`（它本就是给看板用的 runtime 投影，该目录已有 `types.ts`）。
`src/types/` 仅保留 `node-sqlite.d.ts`。需同步 `AGENTS.md` 布局表。

### 5.5 `docs/` 归并

`docs/decisions/observability-2026-08-02.md`（标题实为 "AFK Observability Survey"）
→ `docs/research/observability-survey-2026-08-02.md`。删除 `docs/decisions/`。
决策类内容一律进 `docs/adr/`（编号）或 `docs/architecture/blueprints/`（提案）。

### 5.6 `modules/` → `runners/`

`src/application/modules/` 内是 `loop-runner` / `qa-runner` / `_registry` / `isolate` /
`project-resolver`——是执行器，不是「模块」。改用业务语言命名。

### 5.7 `packages/afk-application` 更名（可选，中等成本）

它装的是端口契约与只读投影，不是用例。`src/application/`（76 文件用例编排）与它
同名却无共同职责——架构守卫把两者都判为 `application` 层，等于两层并一层。
更名为 `packages/afk-contracts/` 可消除歧义。需同步：`package.json`、两处
`tsconfig`、`desktop-client/scripts/*`、`architecture-guard.mjs` 的 layers 定义。
**建议单独 commit。**

---

## 6. 执法缺口：声明与现实相反

`AGENTS.md` 写「`src/domain/` — Pure types, reducers, provider seams — **no I/O**」。
实测 `src/domain/` 有 **12 个文件** import node 内置模块，其中 **4 个**真的起进程：

| 文件 | I/O |
| --- | --- |
| `src/domain/agents/codex-app-server/transport.ts` | `spawn`、`net.createConnection` |
| `src/domain/agents/codex-runtime.ts` | `execFile` |
| `src/domain/backlog/claim.ts` | `fs/promises`、`os` |
| `src/domain/templates/loader.ts` | `fs`、`os`、`path` |

**为什么没被拦住**：`architecture-guard.mjs` 的 `nodeBuiltins` 黑名单只作用于
`packages/*/`（第 262 行）；`src/**` 只检查**相对导入**的层方向，而这 12 个文件
import 的是 `node:*`，直接绕过检查。

**这是本提案最重要的发现**：原则写在了文档里，却既没被代码遵守，也没被工具兜住。
目标布局要求全部 I/O 收敛到 `src/infrastructure/`。修复分两步：

1. **立即**：给 `architecture-guard.mjs` 增加规则——`src/domain/` 与 `src/application/`
   禁止 `nodeBuiltins`。让它先变红。
2. **随后**：按报错把 `claim.ts`、`loader.ts`、`transport.ts` 等迁到 `infrastructure/`，
   在 `domain/` 只留端口定义。

这一步会触及较深的 import 链，且当前工作区正处于同方向的重构中
（`src/application/providers.ts` 已删除），建议独立分支推进。

---

## 7. 未决决策点

以下三项需要人来定，我不代为选择：

1. **§5.7 是否更名 `afk-application`？** 消除同名歧义的收益 vs 触碰 5 处配置的代价。
2. **§6 的 I/O 迁移何时做？** 先只加守卫规则让 CI 变红（暴露全量欠债），还是一次性迁完？
3. **5 个 agent 配置目录是否合并？**
   `.claude/`、`.codex/`、`.opencode/`、`.claude-plugin/`、`.codegraph/`
   各 1–2 个文件却占 5 个一级目录。我的建议是**不合并**（各运行时期望自己的路径），
   改为在 `AGENTS.md` 增一节说明各自归属。你若倾向合并，请指定目标形态。

---

## 参考

社区目录组织共识，用于校准本提案：

- 一致性优先，选定一种就别混用 —— [algocademy](https://algocademy.com/blog/the-ultimate-guide-to-structuring-and-organizing-code-projects-for-maximum-efficiency/)、[coderlegion](https://coderlegion.com/7453/the-folder-structure-no-one-teaches-you-but-every-developer-needs)
- 单一清晰源码根 —— [xcodx](https://xcodx.io/blog/best-practices/folder-structure-best-practices)
- 按功能分组而非技术类型 —— [kamiljozwik](http://www.kamiljozwik.com/posts/features-folder)、[ZOOZ Engineering](https://engineering.zooz.com/@nimmikrishnab/react-folder-structure-clean-architecture-6b519cc94626)、[freecodingschool](https://freecodingschool.com/tutorials/react/folder-structure)
- 目录名说产品语言，不用 `utils` / `helpers` / `services` —— [upforcetech](https://www.upforcetech.com/structuring-a-repo-so-a-new-developer-can-find-things/)
- 保持浅层，3–4 层封顶 —— [truegeometry](https://www.truegeometry.com/api/exploreHTML?query=File%20and%20directory%20structure%20organization)
- 用工具强制边界（如 `eslint-plugin-boundaries`） —— 同 kamiljozwik；本仓已有等价的 `pnpm architecture:check`
