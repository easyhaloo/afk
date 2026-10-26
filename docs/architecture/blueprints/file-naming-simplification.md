# 文件命名简化清单

**作者：** Mavis
**状态：** 提案。命名部分已由分支 `refactor/file-naming` 落地（见[改动清单](file-naming-changelog.md)）；本文的目录结构部分仍未采纳。
**落地状态（2026-10-23，分支 `refactor/file-naming`）：**

| 本文条目 | 状态 |
| --- | --- |
| §1.1 `work-item` 拼写统一 | ✅ 已落地（`application/work-items/` → `application/work-item/`） |
| §1.2 `board/board/` 同名嵌套 | ✅ 已落地（内容上提一层，两个桶合并） |
| §1.3 `backlog-page.test.ts` 同基名 | ✅ 已落地（改名为 `backlog-filter.test.ts`） |
| §1.4 `board-types.ts` 与 `board/types.ts` | ✅ 已落地（并入 `board/task-types.ts`） |
| §1.5 `observability.md` 与 `observability/` 同名 | ✅ 已落地（目录改名 `observability-profiles/`） |
| §1.6 `packages/application` 更名 | ⏸ 未做（成本高，建议单独 commit） |
| §1.7 `project-resolver` / `isolate` 同名 | ✅ 已落地（`application/project/{context,resolver}.ts`；`isolate.ts` 原地保留） |
| §2.1 `packages/*/tests/` 上移 colocated | ✅ 已落地（19 个文件，含 3 个原清单遗漏项） |
| §2.2 `modules/` → `runners/` | ✅ 已落地（10 个文件，含 `loop-config.ts` 并入） |
| §2.3 desktop `work-item-*` 归组 | ✅ 已落地（12 个文件移入 `electron/work-items/`） |
| §3.1 `-service`/`-adapter`/`-store` 去后缀 | ⏸ 主动不做（会撞名；且后缀能区分「服务」与「存储」两个角色） |
| §5.2 架构守卫补「同名文件」规则 | ⏸ 待做（建议下一步） |

**关系：** 与 [目标目录布局](target-directory-layout.md) 同源。那份是旧提案、且以已废弃的根 `src/` 方案为骨架；本文只做命名收敛，落到当前 `apps/` + `packages/` 布局。
**依据：** 全仓 1102 个受版本控制的文件（排除 `dist/`、`dist-electron/`、`release/`），逐目录实测。

---

## 0. 先立规矩：三条单一约定

现状其实**已经**有三条隐含约定，且绝大多数文件遵守。问题不是缺规矩，是**少数文件破例**导致约定不可信。

| # | 约定 | 当前覆盖率 | 破例 |
| --- | --- | --- | --- |
| R1 | React 组件文件用 `PascalCase`，普通模块用 `kebab-case` | 12 个目录实测成立 | 3 处（§4.1） |
| R2 | 测试与被测文件同名同目录，`foo.test.ts` | 绝大多数 | `packages/*/tests/` 19 个（§3.2） |
| R3 | 双语文档用 `name.md` + `name.zh.md` | 8 对成立 | 2 处（§4.2） |

**不要引入第四种。** 收敛这三条即可，不需要新体系。

---

## 1. P0 — 命名歧义：同名不同物 / 物不同名

这些会直接误导 grep 和 code review，优先级最高。

### 1.1 `project-resolver.ts` 有两份不同实现

```
packages/runtime/src/application/project-resolver.ts          ← ProjectResolver 接口 + spawn 实现
packages/runtime/src/application/modules/project-resolver.ts   ← ProjectResolverModule，worktree 前置解析
```

同名、同领域、不同职责。`grep project-resolver` 会同时命中两个毫不相干的东西。

**建议：** 前者移到 `packages/runtime/src/application/project/`（或与 `backlog-work-item.ts` 合并进 `application/work-item/`），后者按 §2.2 随 `modules/` 一起改名。

### 1.2 `isolate.ts` 有两份

```
packages/runtime/src/application/isolate.ts
packages/runtime/src/application/modules/isolate.ts
```

同上，处理方式一致。

### 1.3 `backlog-page.test.ts` 与 `backlog-page.test.tsx` 同基名

`apps/desktop/tests/` 下同时存在两者。测试名不区分扩展名时无法判断该看哪个。

**建议：** 保留组件测试（`.tsx`），把另一个改成能表达意图的名字（如 `backlog-page-cache.test.ts`）。

### 1.4 `board-types.ts` 与 `board/types.ts` 并存

```
apps/cli/src/tui/board-types.ts   ← 业务函数 getTaskBacklogId() + Task 接口 + deprecated iid
apps/cli/src/tui/board/types.ts   ← View / DetailView / Notification 类型
```

两个 "types"，语义不同。`board-types.ts` 是给看板用的 runtime 投影，落在 `tui/` 根下没有归属。

**建议：** 并入 `apps/cli/src/tui/board/`。

### 1.5 `docs/architecture/observability.md` 与 `docs/architecture/observability/` 同名

一个文件、一个目录同名。部分链接检查器和编辑器会解析到错误的那个。

**建议：** 目录改名 `observability/profiles/` → `observability-config/profiles/`，或把文件并入目录。

### 1.6 `work-item` 单复数不一致

```
packages/runtime/src/domain/work-item/          ← 单数（规范名）
packages/runtime/src/application/work-items/     ← 复数
apps/desktop/src/features/work-items/            ← 复数
```

同一领域概念两种拼写，跨层 grep 定位不全。

**建议：** 统一单数 `work-item`。`application/work-items/` 内只有 `inventory-backlog-provider.ts` 一个文件，直接改名目录成本极低。

### 1.7 `packages/application` 与 `packages/runtime/src/application/` 同名不同职责

前者装端口契约与只读投影，后者装用例编排；架构守卫把两者都判为 `application` 层，等于两层并一层。

**建议：** 前者更名 `packages/contracts/`。**成本较高**（package.json、tsconfig、desktop scripts、架构守卫 layers 四处），单独一个 commit，不要和纯重命名混在一起。

---

## 2. P1 — 目录冗余与嵌套塌陷

### 2.1 `apps/cli/src/tui/board/board/` 同名嵌套

```
apps/cli/src/tui/board/board/{BoardCard,BoardLane,BoardView,model,index}.{ts,tsx}
```

`board` 里的 `board`。内容上提一层到 `apps/cli/src/tui/board/` 即可，**无命名冲突**（`board/` 下现有 `cache.ts`、`types.ts`、`footer-helpers.ts` 等，与 `BoardCard` 等不冲突）。

### 2.2 `packages/runtime/src/application/modules/` → `runners/`

目录里是 `loop-runner` / `qa-runner` / `_registry` / `isolate` / `project-resolver`——都是**执行器**，不是「模块」。改用业务语言。

附带两个问题：
- `_registry.ts` 的下划线前缀是私有约定，与全仓 kebab-case 冲突 → `registry.ts`。
- `application/loop/loop-config.ts` 与 `modules/loop-runner.ts` 把 loop 概念劈成两处 → 合并到 `runners/` 下。

### 2.3 `packages/*/tests/` 19 个文件未 colocate

```
packages/core/tests/             3
packages/application/tests/      8
packages/workflow-graph/tests/   8
```

按 R2 上移到 `packages/*/src/`。注意 `packages/workflow-graph/src/` 与 `packages/workflow-graph/tests/` 的目录名和包名 `workflow-graph` 三者语义重复，但测试与源码同名同结构（如 `src/ir.ts` ↔ `tests/ir.test.ts`），上移是纯机械操作。

### 2.4 desktop 的 12 个 `work-item-*` 文件散在两处

```
electron/adapters/{core-work-item-adapter,work-item-application-adapter}.ts
electron/services/work-item-{execution-manifest-store,execution-query-service,
  execution-service,inventory-service,inventory-store,inventory-sync-service,
  run-history-service,run-store}.ts
```

`work-item` 前缀在每个文件里重复 3 次，且横跨 adapters/ 与 services/ 两个目录。

**建议：** 建 `electron/work-items/` 子目录，前缀自然消失：
```
electron/work-items/execution-manifest-store.ts
electron/work-items/inventory-service.ts
electron/work-items/inventory-store.ts
...
```
目录名承担语义后，`work-item-` 前缀全部可删。这同时解决 §3.1 的后缀冗余。

---

## 3. P2 — 后缀与目录语义重复

### 3.1 `-service` / `-adapter` / `-store` 后缀（desktop 37 个文件）

```
electron/services/  21 个   （appearance-service, backlog-control-service, ...）
electron/adapters/  16 个   （ssh-command-adapter, known-hosts-adapter, ...）
```

目录名已经说了是 service / adapter，文件名再说一遍。

**⚠️ 不能直接去后缀——会撞名：**

| 去后缀后 | 撞车 |
| --- | --- |
| `services/work-item-inventory.ts` | `work-item-inventory-service.ts` + `work-item-inventory-store.ts` |
| `adapters/jumpserver.ts` | `adapters/jumpserver-store.ts` |

所以顺序必须是：**先按 §2.4 分子目录，再去后缀**。单独去后缀不可行。

### 3.2 `apps/desktop/shared/` 命名不齐

```
*-contract.ts  5 个   backlog-contract, execution-contract, execution-environment-contract, ipc-contract, ssh-contract
无后缀          3 个   tmux-session, validation, work-item-run-validation
```

同一个目录两套约定。要么全部加 `-contract`，要么全部去掉。`validation.ts` 和 `work-item-run-validation.ts` 也和 `*-contract` 语义重叠。

### 3.3 `apps/cli/src/tui/board/registry/` 里 `loading.ts` 与 `loading-init.ts`

两个名字读不出差别。建议 `loading.ts` → `loading-phase.ts`，`loading-init.ts` → `loading-init.ts` 保留。

### 3.4 `apps/cli/src/tui/shared/View.ts` 是纯再导出桶

```ts
export type { View, ViewContext } from './types.js';
```

它只是 `types.ts` 的再导出，却占了 PascalCase 组件名。建议删除（调用方直接引 `types.js`）或改名 `view-types.ts`。

---

## 4. P3 — 风格一致性破例

### 4.1 非组件却用 PascalCase（3 处）

| 文件 | 实际导出 | 建议 |
| --- | --- | --- |
| `apps/cli/src/tui/shared/Keyboard.ts` | `class KeyboardDispatcher` | `keyboard.ts` |
| `apps/cli/src/tui/shared/Registry.ts` | `class ViewRegistry` | `registry.ts` |
| `apps/cli/src/tui/shared/View.ts` | 纯 re-export | 删除或 `view-types.ts` |

> `useData.ts` / `useNavigation.ts` / `useLoadingPhase.ts` 的 camelCase **保留**——React hook 命名惯例，与 R1 不冲突。

### 4.2 camelCase 孤例（1 处）

`apps/cli/src/tui/app/state/initialState.ts` 导出的是类型（`ViewType` / `DetailMode` / `NotificationType`），不是 hook → `initial-state.ts`。

### 4.3 双语后缀不一致（2 处）

| 现状 | 建议 |
| --- | --- |
| `README_zh.md` | `README.zh.md`（对齐全仓 8 对 `.zh.md`） |
| `docs/architecture/blueprints/core-layer-architecture_zh.md` | `core-layer-architecture.zh.md` |

### 4.4 SCREAMING_CASE 孤例

```
docs/research/RESEARCH.md
AFK-ARCHITECTURE.md
AFK-ARCHITECTURE.pdf
apps/desktop/ARCHITECTURE.md
apps/desktop/TIMELINE_MOTION.md
```

`PRD.md`、`SKILL.md`、`SKILL-GUIDE.md`、`README.md` 等是有意的固定名（工具约定），保留。`RESEARCH.md` 与 `AFK-ARCHITECTURE.*` 不是。

### 4.5 根目录 `AFK-ARCHITECTURE.md` + `.pdf` 与 `docs/architecture/overview.md` 重叠

`AFK-ARCHITECTURE.md` 714 行，`docs/architecture/overview.md` 338 行，两者都是架构说明。根目录还多带一份 PDF 制品。

**建议：** `AFK-ARCHITECTURE.md` 移入 `docs/architecture/`（或 `docs/architecture/blueprints/`），PDF 与 `.md` 分离归档。根目录只留 `README.md`、`AGENTS.md`、`CLAUDE.md`、`LICENSE`。

---

## 5. P4 — 文档与制品

### 5.1 `docs/decisions/` 单文件残留

```
docs/decisions/observability-2026-08-02.md
```

目录里只有 1 个文件，标题实为 "AFK Observability Survey"，属调研不属决策。建议 → `docs/research/observability-survey-2026-08-02.md`（同时满足调研目录 `topic-YYYY-MM-DD.md` 约定），删掉 `docs/decisions/`。

### 5.2 `skills/afk-do/references/` 与 `skills/afk-implement/references/` 内容重复

实测 11 个同名文件里 **8 个字节级完全相同**：

```
adr.md  architecture.md  ddd.md  hotfix.md  research.md  spike.md
tdd-feature.md  tdd-refactor.md
```

仅 `README.md` / `hard-checks.md` / `hard-checks-recovery.md` 有差异。

**建议：** 抽到 `skills/_shared/references/`（或 `skills/afk-common/references/`），两个 skill 各自引用。这是**内容去重**，不只是命名，但根因是命名重复导致的拷贝。

### 5.3 `skills/api-workflow/templates/` 名不副实

该目录实为一份完整 Playwright 项目脚手架（`package.json`、`playwright.config.ts`、`scenarios/`、`setup/`、`utils/`、`fixtures/`）。叫 `templates` 会让人以为是文档片段。建议 → `skills/api-workflow/scaffold/`。

### 5.4 `skills/jev-agent-guard/` 内部重复概念

`scripts/jev.mjs` / `scripts/jev-client.mjs` / `references/jev-client.md`——同名不同形态，建议 `scripts/jev.mjs` → `scripts/cli.mjs`。

---

## 6. P5 — 测试与 fixtures 命名

### 6.1 三段式测试后缀有 3 种语义

```
tracker-provider-factory.gitlab.test.ts        ← 平台维度
fetcher.gitlab.test.ts                          ← 平台维度
workflow-engine.observation.test.ts             ← 观察维度
multi-repository-preparer.integration.test.ts   ← 运行模式维度
task-runtime.integration.test.ts                ← 运行模式维度
work-item-execution-service.integration.test.ts ← 运行模式维度
```

`.integration.test.ts` 表示「跑真实依赖而非 mock」，是有价值的区分，保留。但 `.gitlab` / `.observation` 混在同一约定里没有说明。建议约定为：

```
foo.test.ts                  单元
foo.integration.test.ts      集成（真实依赖）
foo.<维度>.test.ts           其余维度，且必须写进本节
```

### 6.2 `tests/` 下的 `afk-` 前缀在仓内冗余

```
tests/e2e/afk-e2e-parity.test.ts
tests/fixtures/afk-e2e-parity.ts
tests/fixtures/afk-desktop-exec-20261014022840.txt
```

仓内路径已含 `afk`，前缀无信息量 → `tests/e2e/e2e-parity.test.ts`、`tests/fixtures/e2e-parity.ts`。

### 6.3 `tests/fixtures/afk-desktop-exec-20261014022840.txt` 带时间戳

固定 fixture 不该带生成时刻，名字会随每次重新生成而变。→ `tests/fixtures/desktop-exec-output.txt`。

---

## 7. 建议的落地顺序

| 批次 | 内容 | 风险 | 说明 |
| --- | --- | --- | --- |
| **A** | §1.3 §4.1 §4.2 §4.3 §4.4 §6.2 §6.3 | 低 | 纯改名，单文件级，机械可改 |
| **B** | §2.1 §2.2 §2.3 | 低 | 塌陷嵌套 / 上移测试，需同步 import |
| **C** | §1.4 §1.5 §1.6 §2.4 §3.1 | 中 | 目录重组 + 去后缀，必须按 §2.4 先行的顺序 |
| **D** | §3.2 §3.3 §3.4 §4.5 §5.1 §5.3 §5.4 §6.1 | 低 | 零散收敛 |
| **E** | §1.1 §1.2 | 中 | 同名消歧，需先读懂两份实现的意图 |
| **F** | §1.7 | 高 | `packages/application` → `packages/contracts`，单独 commit |
| **G** | §5.2 | 高 | skills 内容去重，跨 skill 契约变更 |

**A/B 批次可以立刻做**：纯重命名 + import 更新，架构守卫与测试能兜住。

---

## 8. 一条必须先立的工具护栏

§1.1 / §1.2 这类"同名不同物"能长期存在，说明**没有工具能发现它们**。`pnpm architecture:check` 检查层方向与 legacy 隔离，管不到命名。

建议在 `scripts/architecture-guard.mjs` 增一条规则：**同一包内不同目录出现同名 `.ts` 文件即报错**。这条规则成本极低，能立刻挡住 §1.1 / §1.2 / §1.3 复发，也是本清单其余项的兜底。

> 蓝图 §6 已记录过同类教训：原则写进文档、代码没遵守、工具也没兜住 → 声明与现实相反。命名同理：**约定必须由工具强制**，否则下一个新文件会继续破例。

---

## 附：本次扫描的实测口径

- 文件总数 1102（`git ls-files`，排除 `dist/`、`dist-electron/`、`release/`）
- 扩展名分布：`ts` 633、`md` 237、`tsx` 79、`mjs` 35、`json` 28、`html` 18、`png` 16、`css` 15
- 命名风格逐目录统计：PascalCase 与其它风格并存的目录 12 个（其中 9 个是「组件 Pascal + 模块 kebab」的正常形态）
- 同名不同目录文件：逐目录 basename 去重比对得出
- skills 内容重复：`diff` 逐文件比对得出，非推测
