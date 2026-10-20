# AFK 过时文档清理计划

> 编制日期：2026-10-20
> 范围：`docs/`（执行前 40 篇在用 + 92 篇归档；执行后 38 篇在用 + 96 篇归档）、仓库根入口文档、`desktop-client/ARCHITECTURE.md`、`skills/`
> 判定基线：`main` @ `2b4a72b`（盘点时的代码状态）
> **执行基线：`refactor/afk-package-boundaries` @ `e167fc9`** —— 本计划在该分支上执行，文中所有路径与行号已重基到分支的 `packages/*` 布局
> 判定依据：源码实测 + CLI 注册表 + 架构守卫 + git 历史

> **重基说明**：盘点在 `main` 上完成（那时 `packages/` 尚为 3 个）。执行时发现 `refactor/afk-package-boundaries` 分支已把包边界拆为 5 个（新增 `afk-infrastructure`、`afk-execution`）并改写了 17 个文档的路径。这正是本计划 §4 预判的"路径类修正约 40% 会在分支合入后失效"。处置：**不在 `main` 上改路径，直接在分支上执行**，从而与分支自身的文档改动天然合流，且可以用分支已有的引用检查器把基线归零。文中 `src/...` 形式的老路径一律已替换为 `packages/...` 形式。

---

## 0. 结论

文档的**链接是健康的，内容是陈旧的**。`pnpm docs:check` 对 234 个文件报 0 断裂，但把在用文档里的反引号路径逐条按"文档目录 / 仓库根 / desktop-client 根 / desktop-client/src"四个基准解析到文件系统上，有 **116 个不同路径、135 处引用无法解析**。其中约 **48 个是明确的事实性漂移**（指向确实不存在的模块），其余多为裸相对文件名（如 `types.ts`、`main.tsx`）或运行时产物路径（`.afk-signal.json`、`report.json`）——它们同样不构成有效断言，且正好落在现有检查器的盲区里。现有检查器看不到其中任何一条，因为"反引号路径不是链接"。

同时存在两个必须先解决的**顺序约束**：

1. 仓库中有一条未合并分支 `refactor/afk-package-boundaries`（361 文件改动），它把 `packages/` 从 3 个拆成 5 个（新增 `afk-infrastructure`、`afk-execution`），**已经改写了 17 个文档的路径**并新增了引用基线机制。现在做的路径修正约 40% 会在该分支合入后立刻失效。
2. 主工作区还有一批未提交的在途改动（Desktop 工作流工作室、手工建工作项 PRD、新 CSS 与测试），与文档清理的改动面重叠。

**因此本计划分四阶段，阶段 0 是"等待 + 先做不冲突的归档"。**

工作量分级：P0 归档/重写 5 项、P1 事实修正 20 项、P2 结构治理 7 项。

---

## 1. 盘点基线

| 区域 | 规模 | 最近更新 | 判定 |
|---|---|---|---|
| `docs/`（在用） | 40 篇 md + 3 个非 md，644 KB | 2026-10-19 | 主要处置面 |
| `docs/_archive/` | 92 篇 md + 21 个产物，2.6 MB | — | 保留，需补索引 |
| 仓库根 | `README.md` `README_zh.md` `CLAUDE.md` `AGENTS.md` `AFK-ARCHITECTURE.md` `AFK-ARCHITECTURE.pdf` | 2026-10-17 | 2 个入口 + 1 孤儿 + 1 二进制产物 |
| `desktop-client/ARCHITECTURE.md` | 1 篇 | 2026-10-19（未提交） | 准确，在途更新中 |
| `skills/` | 22 个 skill + `README.md` + `SKILL-GUIDE.md` | — | 1 处 frontmatter 字段漂移 |

**关键结构事实（判定的地基）**

- CLI 命令面唯一真源是 `src/cli/command-registry.ts`（14 个命令组）。实测 `node dist/index.js --help` 与 `docs/architecture/overview.md` 的命令表**逐条吻合**。
- `afk board` 已被显式移除（`src/index.ts:26-30` 直接报错退出），`afk`（无参数）= TUI。
- 领域状态机、信号类型、模板清单、Provider 契约以 `src/domain/`、`packages/afk-infrastructure/src/schemas.ts`、`packages/afk-execution/src/domain/templates/builtin.ts`、`packages/afk-application/src/backlog/model.ts` 为准。
- 包边界正在迁移：main 3 个包，in-flight 分支 5 个包。

---

## 2. 五个结构性问题

### 2.1 检查器只测链接，测不到内容陈旧

`scripts/check-doc-links.mjs` 只解析 markdown 链接。文档里"某文件在某处"的断言（反引号包裹的路径）全部逃逸。分支上新增的源路径检查填补了部分盲区，但仍有三处缺口：

- 正则 `/`([^`\s]+\.(?:ts|tsx|mjs|js))`/` —— **不覆盖** `.cts` `.json` `.yml` `.css` `.html` `.md` `.sh`。**执行结论**：只补上无歧义的 `.cts` / `.mts`；其余扩展名经实测会引入 294 处误报（运行时产物、占位符、用户项目输出），详见 §5.1。
- `if (!raw.includes('/')) continue;` —— **裸文件名一律跳过**（`workflows.ts`、`types.ts`、`main.tsx`、`run-log-service.ts` 等，全部无法检查）。
- `scripts/doc-source-paths-baseline.json` 是 **50 条已知过时的白名单**。机制上，白名单会冻结这些引用不被修复。

分支上实测：48 个检查器可见的过期路径，41 个已白名单化，7 个已随蓝图改写修复。

> **本计划的书写约定**：文中所有**确实不存在**的路径一律不加反引号（如 src/lib/scheduler.ts）。这不是排版偏好——分支上的源路径检查会读取反引号包裹的源码路径并核验其存在性，给"已不存在的旧路径"加反引号会让本文件自身成为白名单外的新违规，反过来污染 `scripts/doc-source-paths-baseline.json`。凡是加反引号的，都是**当前真实存在**的路径。

### 2.2 两份文档描述的是"另一套代码库"

- `docs/decisions/observability-2026-08-02.md` —— 整篇基于 src/lib/core/io/logger.ts、src/lib/scheduler.ts、src/commands/*，讨论 `afk issue` / `afk worktree` / `afk scheduler status` 等**注册表里根本不存在的命令**。其核心结论"没有 append-only 审计日志"已被 ADR-0016 的 hash 链 JSONL 与 `afk observe` 推翻。
- `docs/superpowers/plans/2026-10-16-retro-feedback-loop.md` —— 规划了 src/domain/observability/retro-types.ts + src/application/retrospectives/* + src/infrastructure/observability/retro-*.ts 共 17 个文件，**一个都不存在**；实际实现全部内联在 `src/cli/commands/retro.ts` 单文件内。

### 2.3 蓝图状态标记失真

`docs/index.md:16` 把 `blueprints/` 描述为"蓝图与**未采纳**方案（草稿）"。实际上：

| 蓝图 | 标记 | 实际 |
|---|---|---|
| `afk-native-graph-engine-blueprint.md` | 建议进入 RFC | **已采纳并实现**为 `packages/afk-workflow-graph`（`ir/project/normalize/layout/routing/validate/receipt` 全部就位） |
| `archify-afk-integration-proposal.md` | 建议采纳，尚未实现 | **方向已被否决**，仅 IR 投影以 `packages/afk-execution/src/application/visualizations/archify-adapter.ts` 存活 |
| `core-layer-architecture_zh.md` | 目标结构 | "当前落地状态"准确，"目标结构"子树未实现（实际是扁平布局） |
| `target-directory-layout.md` | 提案，尚未采纳 | 有效提案，统计数字需刷新 |

### 2.4 入口文档缺环

`docs/index.md` 漏挂 5 个在用文件：`docs/adr/0020-*`、`docs/getting-started.md`（+.zh）、`docs/product/PRD-work-items-reverse-sort-2026-10-15.md`、`docs/product/PRD-manual-work-item-create-and-execution-2026-10-19.md`、`docs/superpowers/plans/2026-10-16-retro-feedback-loop.md`。ADR 表停在 0019。

`AFK-ARCHITECTURE.md`（38 KB）与 `AFK-ARCHITECTURE.pdf`（601 KB）被 git 跟踪，但**全仓零入链**，且 PDF 无生成脚本、`.gitignore` 无 `*.pdf` 规则。`AFK-ARCHITECTURE.md` 是 `docs/architecture/system-architecture-design.md`（48 KB）的中文精简重复。

### 2.5 一份 ADR 文件在出生时就是损坏的

`docs/adr/0018-evidence-classification-and-redaction.md:2`：

```
## S## S## S## S## S## S## S## S## S## S## S## S## S## S## S## S##pts## S## S# environment data, and
```

`## Status` / `Accepted` / `## Context` 三个标题整体丢失，句子在中间被截断。`git show` 确认首次提交 `e221822` 即为该形态。**决策本身是真的**（`EvidenceClassification` / `RedactionStatus` / `EvidenceRef` / `EvidenceStorePort` 全部已实现），但文档不可读。`AFK-ARCHITECTURE.md:561` 自己承认了这一点，至今未修。

---

## 3. 分级处置清单

### P0 — 归档 / 重写（5 项，先做，冲突最小）

| # | 对象 | 动作 | 依据 |
|---|---|---|---|
| P0-1 | `docs/adr/0018-evidence-classification-and-redaction.md` | **按已实现语义重写**（不归档——决策仍然有效） | 出生即损坏；`packages/afk-core/src/events.ts:16-41` 是语义真源 |
| P0-2 | `docs/decisions/observability-2026-08-02.md` | **归档**到 `docs/_archive/decisions/`（保留全文，标注"针对已不存在的 `src/lib/**` 代码库"） | 整篇基于外来布局；核心结论已被 ADR-0016 推翻 |
| P0-3 | `docs/superpowers/plans/2026-10-16-retro-feedback-loop.md` | **归档**到 `docs/_archive/superpowers/plans/2026-10-16-retro-feedback-loop.md`，与其余 60 份历史计划同址 | 功能已实现但形态与计划不同（单文件内联） |
| P0-4 | `docs/architecture/blueprints/archify-afk-integration-proposal.md` | **归档**到 `docs/_archive/blueprints/`，加一行"方向已被 native blueprint 否决" | 其提议的 `afk-archify://` 协议、IPC 名称、Archify 运行时依赖均不存在 |
| P0-5 | `docs/architecture/blueprints/afk-native-graph-engine-blueprint.md` | **归档**为"已采纳蓝图"，在 `docs/architecture/glossary.md` 留指针 | 已被 `packages/afk-workflow-graph` 完整实现 |

### P1 — 事实修正（20 项）

**A. 架构文档**

| # | 文件:行 | 现状断言 | 实际 |
|---|---|---|---|
| P1-1 | `architecture/execution.md:110` | 目录树为 `src/lib/{agents,sandbox,execution,sessions,branches,templates}/` | `src/lib/` 不存在；真实位置 `src/domain/agents/`、`src/infrastructure/sandbox/`、`src/domain/templates/` 等 |
| P1-2 | `architecture/execution.md:494,707` | `afk workflow run --iid 42 --agent claude-code ...` | 无 `workflow` 命令；真实入口 `afk run`（`src/cli/commands/run.ts:17-35`） |
| P1-3 | `architecture/execution.md:702` | "默认超时遵循 src/lib/constants.ts" | 文件不存在；超时是 `afk run --hard-timeout`（`run.ts:26`） |
| P1-4 | `architecture/execution.md:612` | 引用 `workflows.ts` 的阶段 | 该文件不存在；模板在 `packages/afk-execution/src/domain/templates/builtin.ts` |
| P1-5 | `architecture/execution.md:468-475` | 5 个内置模板 | `builtinTemplates()` 返回 **6** 个（多 `parallel-planner`、`planner-with-review`） |
| P1-6 | `architecture/execution.md:381` | handoff 文档写入 `<worktree>/.afk/runs/<run-id>/handoff/handoff-1.md` | 实际写入 `<worktree>/.afk/handoff/handoff-<backlogId>-<gen>.md`（`packages/afk-execution/src/application/workflows/handoff.ts:15-16`）。**后续**：§7 整段重写——原写的 `.afk/runs/` 树没有任何生产代码在写，见 §9 |
| P1-7 | `architecture/glossary.md:27` | 信号种类含 `ac_result` | 实际 union 为 `goal_complete \| handoff_ready \| timeout \| idle`（`packages/afk-infrastructure/src/schemas.ts:3-40`） |
| P1-8 | `architecture/glossary.md:40-46` | Packages 只列 `@afk/core`、`@afk/application` | 漏 `@afk/workflow-graph`（承载 `afk graph workflow`） |
| P1-9 | `architecture/observability.md:17,207` | `confirm-merge` 标为"未切换 / 下一阶段工作" | `afk reconcile`（`command-registry.ts:32`）与 `afk backlog confirm-merge` 均已上线并产出 `change.merge_verified` 事件 |
| P1-10 | `architecture/overview.md:20-21,28` + `.zh.md` | 自相矛盾："不负责创建或拆分任务"，但命令表列有 `afk backlog create <title>` | 收紧范围表述 |
| P1-11 | `architecture/blueprints/target-directory-layout.md:147-150,208` | 统计数字 115/15/9/12 | 现为 125/18/12/13；`§6` 指向守卫第 262 行，实为 45/327 行 |
| P1-12 | `architecture/blueprints/target-directory-layout.md:187` | 指向 `docs/research/observability-survey-2026-08-02.md` | 该路径不存在；实际在 `docs/decisions/observability-2026-08-02.md` |
| P1-13 | `architecture/blueprints/core-layer-architecture_zh.md:121-165` | 目标结构为多层子树 | 两个包实际都是扁平布局；desktop-client/electron/composition-root.ts、`src/cli/presentation/` 不存在 |
| P1-14 | `architecture/full-workflow-e2e-architecture.md` | 示例 fixture 路径 `execute-work-item.test.ts`、`loop-runner.test.ts`、`playwright.config.ts` 等 | 路径不解析，需改为真实位置或明确标注为示意 |

**B. 指南与上手**

| # | 文件:行 | 现状断言 | 实际 |
|---|---|---|---|
| P1-15 | `getting-started.md:32` | 配置文件在 `~/.config/afk/.env` | 无此路径；配置来自 `<projectRoot>/.afk/config.yml`（`packages/afk-execution/src/infrastructure/config/manager.ts:220`）+ 环境变量 |
| P1-16 | `getting-started.md:37` | `GITLAB_BASE_URL` | 代码读 `GITLAB_URL`（`manager.ts:110`） |
| P1-17 | `getting-started.md:41,50-57` | `GITLAB_BASE_URL` 之外的 `GITHUB_OWNER` / `GITHUB_REPO` / `git config afk.platform\|project\|owner\|repo` | **全部零命中**；实际只有 `GITHUB_TOKEN`、`GITHUB_REPOSITORY` |
| P1-18 | `getting-started.md:63,155` | `TRACKER_PLATFORM` | 仅出现在这两份文档里，代码中不存在 |
| P1-19 | `getting-started.md` | 未提 `AFK_STATE_DIR`、`AFK_TMUX_SESSION` | 二者都是真实读取的环境变量（`packages/afk-application/src/backlog/claim.ts:334`、`manager.ts:139`） |
| P1-20 | `guides/testing.md:11,51,55,60,96,205` | TUI 测试用 `ink-testing-library` | **不是依赖，仓库零使用**；10 个 `*.test.tsx` 用 `ink` 的 `renderToString` |
| P1-21 | `guides/testing.md:237` | "跑全部测试：`pnpm dlx vitest --run`" | 真实全量命令是 `pnpm test`（含 3 个包自己的 test） |
| P1-22 | `guides/testing.md:173,310` | PTY 示例 spawn `[distPath, 'board']` | `afk board` 已被显式拒绝（`src/index.ts:26-30`）；真实测试 spawn `[distPath]`（`tests/pty/notification.test.ts:112`） |
| P1-23 | `guides/testing.md:210-232` | 测试目录树 | 缺 `packages/*/tests/` 三个包与 `desktop-client/tests/`；`pnpm test:e2e:codex` 未记录 |
| P1-24 | `guides/workflows.md:370-374` | 信号 union 含 `ac_result` | 同 P1-7，且缺 `idle` |
| P1-25 | `guides/workflows.md:57` vs `:93-190` | 一处说调度器"已移除"，另一处完整描述 Scheduler Service / worker pool / DAG / 状态机 | 无 `afk scheduler` 命令、无调度器模块；**删除该章节** |
| P1-26 | `guides/workflows.md:407` | `--max-handoffs` 默认 3 | 实际 `Math.min(Math.ceil(goalBudget/1e6),20) \|\| 3`，`goalBudget` 默认 500000 → **1** |
| P1-27 | `guides/skills.md:274` | 分支名 `afk/issue-<iid>` | 只派生 `afk/backlog-<id>`（`packages/afk-application/src/backlog/model.ts:103`） |
| P1-28 | `guides/skills.md:799-813` | 共享 `references/` 树含 `task-type/{feature,refactor,bugfix}.md` | 无 `skills/references/`；每个 skill 自带 `references/`，无 `task-type/` 子目录 |
| P1-29 | `guides/skills.md` | 记录 18 个 skill | 实际 22 个；**漏记** `afk-ai-prd`、`afk-llm-dev-guide`、`jev-agent-guard`、`software-complexity-governance`（其中 `afk-ai-prd` 被两份新 PRD 引为校验器） |

**C. 索引、ADR、研究与 PRD**

| # | 对象 | 动作 |
|---|---|---|
| P1-30 | `docs/index.md` | 补挂 P0 归档后的 5 个漏项 + ADR-0020 行；修正 `blueprints/` 描述（不再是"未采纳"）；修正 `decisions/` 描述（当前写"observability harness 历史基线"，实际文件是外来代码库普查） |
| P1-31 | `docs/adr/README.md:4` | 链接含字面量 `...`：`https://github.com/anthropics/.../afk-to-prd/references/adr-process.md` → 改相对路径 `../../skills/afk-to-prd/references/adr-process.md`。链接检查器跳过 `https://`，永远抓不到 |
| P1-32 | `docs/adr/0001-*.md:26-27` | S2 标 Deferred，但 `electron/lib/async-mutex.ts` **已由紧接其后的 PR（`0e0c8de`）创建** → 标 Done |
| P1-33 | `docs/adr/0001-*.md:11` | S4 列 `json-snapshot-store`，该文件不存在（现为 `desktop-client/electron/adapters/json-kv-store.ts`），且重复点已从 4 处增至 10+ 处 → 重新枚举或关闭 S4 |
| P1-34 | `docs/adr/0020-*.md` | 状态 `proposed` **正确**（单数 `changeRequest?` 仍活，`changeRequests` 全仓 0 次），但行号引用漂移（`execute-work-item.ts:432`→`:474`；`BacklogDetailDrawer.tsx` 已不存在）→ 只修引用；同时该提案已挂起 3 周，需给出裁决 |
| P1-35 | `docs/research/RESEARCH.md` | desktop-client/electron/services/jumpserver-key-service.ts → 现为 `jumpserver-credential-service.ts`；另一处 `ssh-credential-service.ts` 缺前缀 |
| P1-36 | `docs/research/llm-app-design-methodology.json` | 与 `.md` 并存的产物，索引未收录 → 确认去留 |
| P1-37 | `docs/product/PRD.md:117,145` | src/core/events.ts → `packages/afk-core/src/events.ts`；`:66` `afk observe timeline --runId <id>` → 实际为位置参数 `afk observe timeline <runId>` |
| P1-38 | `docs/product/PRD-work-items-reverse-sort-2026-10-15.md` | 排序词汇与比较器已实现并有测试（`desktop-client/src/features/backlog/backlog-sort.ts:27-30`），但全局工作项页硬编码 `updatedAt` 倒序、无选择器（`WorkItemsPage.tsx:303-307`）→ 状态标 **PARTIAL** |
| P1-39 | `docs/product/PRD-manual-work-item-create-and-execution-2026-10-19.md` | 新建按钮存在，但 `main.tsx:432` 把 `onCreate` 接到 `setView("projectBacklog")`，正是 PRD §1.1 判定不足的旧页 → 状态标 **NOT IMPLEMENTED** |

### P2 — 结构治理（7 项）

| # | 对象 | 动作 |
|---|---|---|
| P2-1 | `AFK-ARCHITECTURE.md` + `AFK-ARCHITECTURE.pdf` | **已执行**：手册并非纯重复——它的 §7 十条架构决策（D-01…D-10）在 `system-architecture-design.md` 中并不存在。因此**迁入** `docs/architecture/architecture-handbook.md` 并挂进 `docs/index.md`；PDF 没有生成脚本、无法随正文重生成，**从仓库移除** |
| P2-2 | `tsconfig.tests.json` | **未跟踪但被 `package.json:11` 的 typecheck 引用** —— 干净克隆上 `pnpm typecheck` 直接失败。分支 `acd68f5` 已把它入库 → 合入分支即可 |
| P2-3 | src/cli/commands/board.ts | 工作区已删除未提交。`afk board` 的移除是有意的（`src/index.ts:26-30`）→ 提交该删除，避免"文档说 board 被删、代码里还在"的分裂 |
| P2-4 | `scripts/check-doc-links.mjs` | 扩检测面（**已执行，实测后收窄**）：① 正则补上无歧义的 `.cts` / `.mts`；② 裸文件名与 `.json/.yml/.css/.html/.md/.sh` 经实测会引入 294 处误报，改为在检查器注释中写明校准结论，而非扩大正则；③ `https://` 链接做一次人工白名单检查（已发现并修复 `docs/adr/README.md:4`） |
| P2-5 | `scripts/doc-source-paths-baseline.json` | **目标归零**。50 条白名单是"冻结过时"的机制；清零是本计划的硬验收指标 |
| P2-6 | `docs/_archive/` | **已执行**：新增 `README.md`，说明"归档 = 当时仓库的快照，不是当前指引"，并把 88 份历史计划与规格按 SSH／Backlog／TUI／执行运行时四组归类；`docs/index.md` 的归档说明同步修正 |
| P2-7 | `skills/SKILL-GUIDE.md:26-48` | **已执行**：补上 `disallowed-tools` 与 `disable-model-invocation`（各 14 处在用）并写明各自语义；`license`/`compatibility`/`metadata` 各仅 1 处在用，保留但标注"按需使用，不要当模板" |

---

## 4. 时序：与在途重构的关系

`refactor/afk-package-boundaries`（`e167fc9`，worktree 在 `.worktrees/afk-package-boundaries`）**已经改写了 17 个文档的路径**，并新增 `scripts/doc-source-paths-baseline.json` 与源路径检查。

| 类别 | 数量 | 说明 |
|---|---|---|
| 分支已修 | 路径类漂移 | `overview.md` / `execution.md` / `glossary.md` / `observability.md` / 4 份蓝图 / `PRD.md` / retro 计划的路径已指向 `packages/afk-*` |
| 分支**未**修 | 语义类漂移 | P1-2/P1-5/P1-7/P1-8/P1-9/P1-10/P1-11/P1-12/P1-13 全部存活 |
| 分支新增 | ADR-0021 + 基线检查 | 编号方案需与本计划协调（见 §5.3） |
| 主工作区 | 未提交改动 | Desktop 工作流工作室、共享日志组件、手工建工作项 PRD、新 CSS 与测试，与 P1 的 `design-system.md` / `overview.md` / `desktop-client/ARCHITECTURE.md` **改动面重叠** |

**执行顺序**

```
阶段 0  等 refactor/afk-package-boundaries 合入
        └─ 期间只做 P0 归档（P0-1 重写 ADR-0018、P0-2~P0-5 归档）—— 与分支无重叠
阶段 1  提交主工作区在途改动（Desktop + PRD + tsconfig.tests.json），冻结 P1 的目标状态
阶段 2  P1 事实修正（按 A → B → C 顺序，每批跑 pnpm docs:check）
阶段 3  P2 结构治理（检查器扩面 → 基线归零 → 根级孤儿处理）
阶段 4  收尾：docs/index.md 全量校对、双语镜像同步、归档索引补齐
```

---

## 5. 防复发机制

### 5.1 引用检查覆盖到"裸文件名"与非代码扩展名（实测后收窄）

原设想是取消 `if (!raw.includes('/')) continue;` 的跳过，并把正则扩展到 `.json .yml .css .html .md .sh`。**实施时实测了这两项，结论是它们都会把一个可用的检查变成噪声**：

- **裸文件名**：全仓 54 处裸文件名引用，按"全仓是否存在该 basename"判定后剩 19 处，逐条看有 5 类误报——`browser-session.ts` 与 `postToolHook.ts` 是 skill 要求**用户项目**生成的文件，`.spec.ts` 是后缀示例，`paths.ts` 与 `run-log-service.ts` 是文档声明的**待创建**文件，ADR-0001 与 PRD.md 里的前瞻引用并非错误。
- **非代码扩展名**：不可解析 294 处，其中 `.md` 164 处、`.json` 56 处、`.yml` 13 处，几乎全部是运行时产物（`.afk-signal.json`、`report.json`）、占位符（`NNNN-title-slug.md`）或用户项目输出（`CONTEXT.md`、`PRD.md`）。

**实际采取的改动**：

1. 正则补上 `.cts` 与 `.mts`——桌面端用 `preload.cts`，这两个扩展名无歧义。已用注入回归验证：指向不存在的 `.cts` 路径会让检查以退出码 1 失败并点名该路径。
2. 把上述测量结论写进 `scripts/check-doc-links.mjs` 的注释，说明"检查什么、不检查什么、为什么"——扩检测面不是改一次正则，而是要证明新报出的每一条都是真漂移。
3. 顺带修掉裸文件名盲区里**确属陈旧**的文档引用（ADR-0020 的失效行号与已删文件、蓝图里的 `preload.cts` 路径），这些由人工核对修正，不依赖自动检查。

这样检查保持在"零误报、零基线"的状态：每一条报出都是真的。

### 5.2 引用检查覆盖到 `https://` 人工白名单

`docs/adr/README.md:4` 的 `https://github.com/anthropics/.../afk-to-prd/references/adr-process.md` 含字面量 `...`，因 `check-doc-links.mjs` 跳过 `https://` 而永远不被发现，且它实际指向仓库内文件。规则：**指向仓库内文件的 URL 一律改相对路径**。

### 5.3 ADR 编号方案需现在裁决

- git 证据：`git log --all --diff-filter=D -- 'docs/adr/*'` 为空，`--diff-filter=A` 亦无 0002–0013 —— **这些编号从未被分配**。
- 时间线证明是"起步就从 14 开始"：0014–0020 建于 2026-08-03/05，0001 建于 2026-09-21。
- `docs/index.md:28` 说"Desktop 端 ADR 带 `desktop-` 前缀"指的是 0001 的**文件名前缀**，不是编号预留。
- ADR-0021 在未合并分支上，不是删除。

选项：**(a)** 保持现状，在 `docs/adr/README.md` 写明"编号自 0014 起，0002–0013 未分配"；**(b)** 重排 0014–0020 → 0002–0008（分支上的 0021 顺延为 0009），需同步 7 个源码文件里的 ADR 引用（`packages/afk-execution/src/infrastructure/sandbox/providers/streaming.ts:4`、`src/infrastructure/tmux/tmux.ts:16,94`、`packages/afk-execution/src/application/workflows/execute-work-item.ts:218`、`desktop-client/electron/adapters/resource-adapter.ts:109`、`desktop-client/electron/adapters/tmux-pty-adapter.ts:31`、`desktop-client/electron/services/execution-attach-service.ts:27`、`desktop-client/shared/execution-environment-contract.ts:5`）+ 3 份文档。

**建议 (a)**：成本低、不产生交叉引用风险；若选 (b) 必须与 `refactor/afk-package-boundaries` 同批进行。

### 5.4 把"计划文档"与"当前指引"分开

`docs/superpowers/plans/` 里的活跃计划与 `docs/_archive/superpowers/plans/` 的历史计划没有任何标记区分。规则建议：计划文档一律带日期前缀，**实现完成后 30 天内归档**；`docs/index.md` 的"归档"区明确写"归档 = 当时的仓库快照，不是当前指引"。

---

## 6. 验收标准

| # | 指标 | 当前 | 目标 |
|---|---|---|---|
| A1 | `scripts/doc-source-paths-baseline.json` 条目数 | 50 | **0** |
| A2 | 在用文档中无法解析的路径引用 | 116 个不同路径 / 135 处（其中 48 个为明确事实性漂移） | **0** |
| A3 | `pnpm docs:check` | 通过（0 断裂） | 通过，**且无基线豁免** |
| A4 | `docs/index.md` 覆盖在用文档 | 漏 5 个 | 100% |
| A5 | 干净克隆 `pnpm typecheck` | 失败（`tsconfig.tests.json` 未跟踪） | 通过 |
| A6 | 损坏文档 | ADR-0018 | 0 |
| A7 | 双语镜像结构对齐 | 7 对中 1 对有差异（代码注释行数，非缺陷） | 保持 |

---

## 7. 执行批次

| 批次 | 内容 | 文件数 | 前置 |
|---|---|---|---|
| B0 | P0 归档（4 份归档 + 1 份重写） | 5 | 无 |
| B1 | P1-A 架构文档事实修正（含 `.zh.md` 镜像） | 7 | 分支合入 |
| B2 | P1-B 指南与上手修正（含 `.zh.md` 镜像） | 12 | 分支合入 |
| B3 | P1-C 索引 / ADR / 研究 / PRD 修正 | 10 | 分支合入 |
| B4 | P2 结构治理（含检查器扩面 + 基线归零） | 7 | B1–B3 |
| B5 | 收尾：索引全量校对、归档索引、双语镜像 | — | B4 |

每个批次的收口动作：`pnpm docs:check` + `pnpm architecture:check` + `pnpm typecheck` 全绿，且 A1/A2 计数单调下降。

---

## 附录 A：逐文件判定表

### A.1 `docs/architecture/`

| 文件 | 判定 | 处置 |
|---|---|---|
| `system-architecture-design.md` | 准确 | 保留（有意不写实现细节） |
| `overview.md` / `.zh.md` | 准确 + 1 处自相矛盾 | P1-10 |
| `execution.md` / `.zh.md` | **过时** | P1-1 ~ P1-6 |
| `observability.md` | 部分过时 | P1-9 |
| `glossary.md` | 部分过时 | P1-7、P1-8 |
| `design-system.md` | 准确（在途更新中） | 保留；待主工作区改动提交后复核 |
| `full-workflow-e2e-architecture.md` | 准确 | P1-14（示例路径） |
| `blueprints/afk-native-graph-engine-blueprint.md` | **已采纳** | P0-5 归档 |
| `blueprints/archify-afk-integration-proposal.md` | **已被否决** | P0-4 归档 |
| `blueprints/core-layer-architecture_zh.md` | 部分过时 | P1-13 |
| `blueprints/target-directory-layout.md` | 有效提案 | P1-11、P1-12 |

### A.2 `docs/adr/`

| 文件 | 判定 | 处置 |
|---|---|---|
| `README.md` | 部分过时 | P1-31；补编号说明（§5.3） |
| `0001-desktop-deferred-and-declined-refactors.md` | 部分过时 | P1-32、P1-33 |
| `0014-interactive-and-batch-structured-output.md` | 准确 | 保留 |
| `0015-typed-workflow-runtime.md` | 准确 | 保留 |
| `0016-run-event-audit-spine.md` | 准确 | 保留 |
| `0017-capability-profiles-and-ports.md` | 准确 | 保留（可补一句 manifest 实际在 `src/plugin-sdk/profile.ts`，避免读者误定位） |
| `0018-evidence-classification-and-redaction.md` | **文件损坏** | P0-1 重写 |
| `0019-desktop-run-log-viewer-projection.md` | 准确（"in progress" 正确） | 保留；待 Desktop 接管验收后改状态 |
| `0020-backlog-item-drop-singular-change-request.md` | 状态正确，引用漂移 | P1-34 |

### A.3 `docs/guides/` + `docs/getting-started*`

| 文件 | 判定 | 处置 |
|---|---|---|
| `getting-started.md` / `.zh.md` | **过时** | P1-15 ~ P1-19 |
| `guides/workflows.md` / `.zh.md` | **过时** | P1-24 ~ P1-26 |
| `guides/skills.md` / `.zh.md` | 部分过时 | P1-27 ~ P1-29 |
| `guides/testing.md` / `.zh.md` | **过时** | P1-20 ~ P1-23 |

### A.4 `docs/product/`、`docs/research/`、`docs/decisions/`、`docs/superpowers/`

| 文件 | 判定 | 处置 |
|---|---|---|
| `product/PRD.md` | 部分过时（草稿态，路径漂移） | P1-37 |
| `product/PRD-retro-feedback-loop.md` | 准确（功能已实现） | 保留；补 2 处缺口说明（`retro.*` 事件未入 `packages/afk-core/src/events.ts`；无 proposal 生成命令） |
| `product/PRD-work-items-reverse-sort-2026-10-15.md` | **PARTIAL** | P1-38 |
| `product/PRD-manual-work-item-create-and-execution-2026-10-19.md` | **NOT IMPLEMENTED** | P1-39 |
| `research/RESEARCH.md` | 环境专属一次性材料 | P1-35；由 owner 决定保留或归档 |
| `research/dt-mdp-llm-research.md` | **已被超越**（"DT-MDP" 全仓零命中） | 归档候选 |
| `research/llm-app-design-methodology.md` | 准确 | 保留；P1-36 处理 `.json` 产物 |
| `decisions/observability-2026-08-02.md` | **外来代码库文档** | P0-2 归档 |
| `superpowers/plans/2026-10-16-retro-feedback-loop.md` | 已实现但形态不同 | P0-3 归档 |

### A.5 根级与桌面

| 文件 | 判定 | 处置 |
|---|---|---|
| `README.md` / `README_zh.md` | 命令示例全部准确；**安装步骤用 npm**，但仓库是 pnpm workspace 且依赖 `workspace:*` —— `npm install` 无法解析 | 改 `pnpm install && pnpm build && pnpm link`；`install.sh:183,188` 同问题 |
| `CLAUDE.md` | 准确 | 对齐 ADR-0019 行标题（现为 "Desktop execution and interactive tmux access"，ADR H1 为 "Shared Execution Views and Interactive Tmux Access"） |
| `AGENTS.md` | 准确但与 CLAUDE.md 重复 5/6 条硬规则 | 角色倒置：AGENTS.md 是规则文件，CLAUDE.md 自称入口点。二选一收敛 |
| `AFK-ARCHITECTURE.md` | 孤儿 + 与 `docs/architecture/system-architecture-design.md` 重复 | P2-1 |
| `AFK-ARCHITECTURE.pdf` | 601 KB 二进制产物，无生成脚本、未 gitignore、零入链 | P2-1 |
| `desktop-client/ARCHITECTURE.md` | 准确（未提交改动为纯新增） | 随主工作区改动一并提交后复核 |

---

## 附录 B：误报清单（不要动）

以下项在核查中被怀疑过时，验证后确认**准确**，不应纳入清理范围：

- `afk board` 在 `overview.md` 的命令表中**不存在**，这是正确的（已移除）——但 `README.md:100` 的 `afk`（无参数）= TUI 成立。
- `docs/architecture/overview.md:37` 的 `afk observe doctor` 存在（`src/cli/commands/observe.ts:90`）。
- `observability.md:16` 只列了 8 个 observe 子命令中的 7 个，是非穷尽摘要，非错误。
- `docs/guides/testing.md` 的 `pnpm test:e2e:pty` 与 node-pty opt-in 理由准确。
- `docs/guides/workflows.md` 的阈值 100000、`--max-total-tokens` 默认 500000、QA 合并条件、`afk/backlog-123` 分支名 —— 全部准确。
- `README.md` 的 15 条 CLI 示例、`22 Claude Code skills` —— 全部准确。
- `AFK-ARCHITECTURE.md §6.1` 的 7 状态机与 `BacklogState` 完全一致（`packages/afk-core/src/model.ts` 的 9 值 `WorkState` 是另一个类型，不构成矛盾）。
- ~~`docs/architecture/execution.md:381` 的 `.afk/runs` 目录是真实实现——**不要删 §7**~~ → **这条判定是错的，已撤回。** 写 `.afk/runs/` 的 `RunStateWriter` 只能从 `AgentExecutionService` 到达，而 `AgentExecutionService` 只能从它自己的测试到达：生产路径上从未有人写过那个目录。2026-10-20 该模块被删除（`refactor: the run state writer was not writing run state`），§7 随即被改写为真实的落盘布局。见 §9。
- `docs/guides/workflows.md` 与 `.zh.md` 的标题数差 2 —— 差异来自代码块内注释行数，不是结构漂移。
- SSH / xterm / PTY / kanban 功能均真实存在（`desktop-client/src/features/ssh/`、`desktop-client/src/features/terminal/`、`src/cli/commands/kanban.ts`）。
- `docs/index.md` 中 `blueprints/`、`research/`、`decisions/` 的目录行已覆盖其下文件，不算漏挂。

---

## 8. 执行结果

**执行基线**：`refactor/afk-package-boundaries` @ `e167fc9`（盘点时该分支自 `main` 领先 16 个
提交、落后 0 个，32 分钟前仍在活跃）。清理在一条从它派生的独立分支 `docs/overdue-cleanup` 上完成，
以免与该分支上并行的代码改动相互干扰。

执行期间该分支继续推进了两次代码提交（事件链校验、交接协调器接线），并改写了
`glossary.md`、`observability.md`、`workflows.md` 三份文档。清理分支最终 rebase 到该分支的
最新 HEAD，两处冲突按**代码事实**而非按提交先后解决：

| 冲突点 | 采用 | 依据 |
|---|---|---|
| handoff 文档路径 | `handoff-<backlogId>-<gen>.md` | `packages/afk-execution/src/application/workflows/handoff.ts:15` 的 `handoffDocPath()` |
| 终止式交接的信号 | `blocked` + `hitl`，不写 issue 评论 | 同文件 `:155-156`，交接不再发评论，改由审计脊柱的 `handoff.performed` 记录 |
| `--max-handoffs` 默认 | 10 | `src/cli/commands/run.ts:51` 配合 `goalBudget` 默认 10,000,000 |
| `--max-total-tokens` 默认 | 10,000,000 | `src/cli/commands/run.ts:53` |

**已完成**：

| 批次 | 内容 | 结果 |
|---|---|---|
| B0 | P0：重写 ADR-0018、归档 4 份文档 | 完成 |
| B1 | P1-A：架构文档 13 处事实修正（中英双份） | 完成 |
| B2 | P1-B：getting-started / workflows / skills / testing（中英双份） | 完成 |
| B3 | P1-C：索引重写、ADR 引用、研究与 PRD 状态 | 完成 |
| B4 | P2：检查器扩展 + 基线归零 | 完成 |
| B5 | P2：根级孤儿、归档索引、SKILL-GUIDE、CLAUDE/AGENTS 收敛 | 完成 |

**验收指标实测**：

| # | 指标 | 计划前 | 计划后 |
|---|---|---|---|
| A1 | `doc-source-paths-baseline.json` 条目数 | 50 | **0** |
| A2 | 检查器可见的过期路径 | 48 | **0** |
| A3 | `pnpm docs:check` | 通过（0 断裂） | 通过（0 断裂，0 基线豁免） |
| A4 | `docs/index.md` 覆盖在用文档 | 漏 5 个 | **100%** |
| A5 | `pnpm typecheck` | 干净克隆失败 | 通过 |
| A6 | 损坏文档 | ADR-0018 | **0** |
| A7 | 双语镜像结构对齐 | 5/5 对齐 | **7/7 对齐** |

**校验**：`pnpm docs:check`（234 文件 0 断裂）、`pnpm architecture:check`
（162 源文件 + 220 桌面端文件，0 隔离项）、`pnpm typecheck`（根 + 5 个包 + 测试树）、
`pnpm test`（根 609 项 + 包级 9 项，全部通过）。

## 9. 更正：`.afk/runs` 是一棵没人写的树

本计划最初把 `docs/architecture/execution.md` §7 的 `.afk/runs/` 目录列入**附录 B 误报清单**，
理由是「目录是真实实现（packages/afk-execution/src/application/sessions/run-state.ts:22）——
不要删 §7」。**这条判定是错的，已撤回。**

写那个目录的 `RunStateWriter` 只能从 `AgentExecutionService` 到达，而 `AgentExecutionService`
只能从它自己的测试到达：生产路径上从未有人创建过 `.afk/runs/`。该模块已随
`refactor: the run state writer was not writing run state`（`refactor/afk-package-boundaries`）
删除，§7 随即被改写为真实的落盘布局。

**教训**：把"文件存在"当成"文档没过期"，是这份检查最容易犯的错。文件存在只证明它没被删，
不证明有人在用它。把一个只被自己测试引用的模块当成"真实实现"，等于让检查为一份
**描述没人写的树的文档**背书。

### 9.1 真实的三处落盘

| 痕迹 | 位置 | 主人 |
|---|---|---|
| 审计脊柱（权威、只追加） | `~/.afk/events/<base64url(runId)>.jsonl` | `JsonlEventStore` |
| 运行时记录（进度/心跳/阶段投影） | `~/.afk/runtime/tasks/{active,archive}/<base64url(runId)>.json`，诊断在 `diagnostics/<base64url(runId)>/` | `TaskRuntimeStore` |
| 桌面执行工作区 | `~/.loop-workspace/<taskId>/{repositories,artifacts,runtime,logs,diagnostics}` | `execution-workspace-service` |

### 9.2 一并修正的引用

| 位置 | 原文 | 改后 |
|---|---|---|
| `docs/architecture/execution.md` §7 + `.zh.md` | `<worktree>/.afk/runs/<run-id>/{request.json,events.jsonl,result.json,output.log}` | 上表三处真实布局 |
| `desktop-client/ARCHITECTURE.md:137` | 「运行诊断遵循 `<worktree>/.afk/runs/<run-id>/events.jsonl`」+ 指向已删模块 | 指向运行时任务存储与 `TaskRuntimeReader` |
| `desktop-client/shared/ipc-contract.ts:7` | 「read from `.afk/runs/**/events.jsonl`」 | 保留事实，补注这是**遗留通道**——没有东西再写它，实际读到空；权威记录是 `RuntimeRunEvent` |
| `desktop-client/src/components/EmptyState.tsx:4` | 「选择包含 `.afk/runs` 的工作区后，记录会显示在这里」 | 「运行记录保存在运行时的任务存储中。选择工作区后，已有记录会显示在这里」 |

### 9.3 仍然存在、需要代码侧决定的两处

删除写端之后，两处**读端**仍在扫 `.afk/runs/`，因此实际读到空：

- `desktop-client/electron/services/workspace-service.ts:13` —— `readEvents()` 递归找
  `<root>/.afk/runs/**/events.jsonl`（快照里的 `events` 通道）。
- `desktop-client/electron/services/desktop-service.ts:382` —— `readWorkflowRuns()` 读
  `<root>/.afk/runs/<runId>/{request.json,result.json}`，结果进快照的 `workflowRuns`。

这两条读端是否删除、还是改指运行时任务存储，属于运行时重构的代码决策，不在文档清理
的范围内，故只登记不动。

**未做、留给 owner 决策**：

- ADR-0020 自 2026-09-29 起挂在 `proposed`，需要一次接受／拒绝裁决。
- ADR 编号 0002–0013 的空缺：本计划**建议不重排**（重排需同步 7 个源码文件里的引用），
  改为在 `docs/adr/README.md` 写明"编号自 0014 起"。
- `docs/research/RESEARCH.md` 是针对某个内部 JumpServer 实例的一次性调研，
  是保留为参考还是归档，由 owner 判断。
- `docs/research/dt-mdp-llm-research.md` 的 "DT-MDP" 在代码中零命中，是另一类孤儿材料。
