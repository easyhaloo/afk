# 文件改名改动清单（已执行）

**状态：** 已全部落地并通过验证。分支 `refactor/file-naming`，5 个 commit。
**规模：** 91 个文件重命名 + 1 个桶文件合并删除，73 个文件更新引用。
**验证：** build / typecheck（根 + Desktop）/ 全量测试 / `architecture:check` / `docs:check` 全部通过，测试数与基线逐包一致。

---

## 与原清单的差异（执行中发现并修正）

| 原清单 | 实际 | 原因 |
| --- | --- | --- |
| 88 个文件 | 91 改名 + 1 删除 | 补上 3 个原清单遗漏的同名测试文件：`board-types.test.ts`、`project-context.test.ts`、`project-resolver.test.ts`；另加 `AFK-ARCHITECTURE.pdf` 与其 md 同迁 |
| `board/board/index.ts` → `board/index.ts`（改名） | 同上，但为**合并后删除** | 目标文件已存在且导出 `Dashboard`，只能追加 `export { BoardView }` |
| `application/project-resolver.ts` → `application/project/project-resolver.ts` | `application/project/{context,resolver}.ts` | `project-context.ts` 与它构成同一能力域，拆成两层反而割裂；按蓝图「功能内聚」轴两者同归 `application/project/` |
| 批次 C 14 个 | 15 个 | 补 `board-types.test.ts` |

---

## 批次 A — 纯改名（零结构变化）

`80377a3` — 12 个重命名

| 旧路径 | 新路径 |
| --- | --- |
| `README_zh.md` | `README.zh.md` |
| `apps/cli/src/tui/app/state/initialState.ts` | `apps/cli/src/tui/app/state/initial-state.ts` |
| `apps/cli/src/tui/shared/Keyboard.test.ts` | `apps/cli/src/tui/shared/keyboard.test.ts` |
| `apps/cli/src/tui/shared/Keyboard.ts` | `apps/cli/src/tui/shared/keyboard.ts` |
| `apps/cli/src/tui/shared/Registry.test.ts` | `apps/cli/src/tui/shared/registry.test.ts` |
| `apps/cli/src/tui/shared/Registry.ts` | `apps/cli/src/tui/shared/registry.ts` |
| `apps/desktop/tests/backlog-page.test.ts` | `apps/desktop/tests/backlog-filter.test.ts` |
| `docs/architecture/blueprints/core-layer-architecture_zh.md` | `docs/architecture/blueprints/core-layer-architecture.zh.md` |
| `docs/research/RESEARCH.md` | `docs/research/jumpserver-public-key-upload-2026-09-21.md` |
| `tests/e2e/afk-e2e-parity.test.ts` | `tests/e2e/e2e-parity.test.ts` |
| `tests/fixtures/afk-desktop-exec-20261014022840.txt` | `tests/fixtures/desktop-exec-output.txt` |
| `tests/fixtures/afk-e2e-parity.ts` | `tests/fixtures/e2e-parity.ts` |

## 批次 B — 塌陷嵌套 / 上移测试

`96db476` — 36 个重命名 + 1 个删除

| 旧路径 | 新路径 |
| --- | --- |
| `apps/cli/src/tui/board/board/BoardCard.test.tsx` | `apps/cli/src/tui/board/BoardCard.test.tsx` |
| `apps/cli/src/tui/board/board/BoardCard.tsx` | `apps/cli/src/tui/board/BoardCard.tsx` |
| `apps/cli/src/tui/board/board/BoardLane.tsx` | `apps/cli/src/tui/board/BoardLane.tsx` |
| `apps/cli/src/tui/board/board/BoardView.test.tsx` | `apps/cli/src/tui/board/BoardView.test.tsx` |
| `apps/cli/src/tui/board/board/BoardView.tsx` | `apps/cli/src/tui/board/BoardView.tsx` |
| `apps/cli/src/tui/board/board/model.test.ts` | `apps/cli/src/tui/board/model.test.ts` |
| `apps/cli/src/tui/board/board/model.ts` | `apps/cli/src/tui/board/model.ts` |
| `packages/application/tests/backlog-mapping.test.ts` | `packages/application/src/backlog-mapping.test.ts` |
| `packages/application/tests/execution-query.test.ts` | `packages/application/src/execution-query.test.ts` |
| `packages/application/tests/execution.test.ts` | `packages/application/src/execution.test.ts` |
| `packages/application/tests/inventory.test.ts` | `packages/application/src/inventory.test.ts` |
| `packages/application/tests/observation.test.ts` | `packages/application/src/observation.test.ts` |
| `packages/application/tests/provider-inventory.test.ts` | `packages/application/src/provider-inventory.test.ts` |
| `packages/application/tests/runtime-health.test.ts` | `packages/application/src/runtime-health.test.ts` |
| `packages/application/tests/workflow-instance.test.ts` | `packages/application/src/workflow-instance.test.ts` |
| `packages/core/tests/execution-base-policy.test.ts` | `packages/core/src/execution-base-policy.test.ts` |
| `packages/core/tests/reducer.test.ts` | `packages/core/src/reducer.test.ts` |
| `packages/core/tests/work-item-project-key.test.ts` | `packages/core/src/work-item-project-key.test.ts` |
| `packages/runtime/src/application/modules/isolate.ts` | `packages/runtime/src/application/runners/isolate.ts` |
| `packages/runtime/src/application/loop/loop-config.ts` | `packages/runtime/src/application/runners/loop-config.ts` |
| `packages/runtime/src/application/modules/loop-runner.test.ts` | `packages/runtime/src/application/runners/loop-runner.test.ts` |
| `packages/runtime/src/application/modules/loop-runner.ts` | `packages/runtime/src/application/runners/loop-runner.ts` |
| `packages/runtime/src/application/modules/project-resolver.test.ts` | `packages/runtime/src/application/runners/project-resolver.test.ts` |
| `packages/runtime/src/application/modules/project-resolver.ts` | `packages/runtime/src/application/runners/project-resolver.ts` |
| `packages/runtime/src/application/modules/qa-runner.test.ts` | `packages/runtime/src/application/runners/qa-runner.test.ts` |
| `packages/runtime/src/application/modules/qa-runner.ts` | `packages/runtime/src/application/runners/qa-runner.ts` |
| `packages/runtime/src/application/modules/_registry.test.ts` | `packages/runtime/src/application/runners/registry.test.ts` |
| `packages/runtime/src/application/modules/_registry.ts` | `packages/runtime/src/application/runners/registry.ts` |
| `packages/workflow-graph/tests/archify.test.ts` | `packages/workflow-graph/src/archify.test.ts` |
| `packages/workflow-graph/tests/determinism.test.ts` | `packages/workflow-graph/src/determinism.test.ts` |
| `packages/workflow-graph/tests/ir.test.ts` | `packages/workflow-graph/src/ir.test.ts` |
| `packages/workflow-graph/tests/layout.test.ts` | `packages/workflow-graph/src/layout.test.ts` |
| `packages/workflow-graph/tests/normalize.test.ts` | `packages/workflow-graph/src/normalize.test.ts` |
| `packages/workflow-graph/tests/project.test.ts` | `packages/workflow-graph/src/project.test.ts` |
| `packages/workflow-graph/tests/routing.test.ts` | `packages/workflow-graph/src/routing.test.ts` |
| `packages/workflow-graph/tests/validate.test.ts` | `packages/workflow-graph/src/validate.test.ts` |
| `apps/cli/src/tui/board/board/index.ts` | （合并进 board/index.ts 后删除） |

## 批次 C — 目录重组

`28ff5a1` — 15 个重命名

| 旧路径 | 新路径 |
| --- | --- |
| `apps/cli/src/tui/board-types.test.ts` | `apps/cli/src/tui/board/task-types.test.ts` |
| `apps/cli/src/tui/board-types.ts` | `apps/cli/src/tui/board/task-types.ts` |
| `apps/desktop/electron/adapters/work-item-application-adapter.ts` | `apps/desktop/electron/work-items/application-adapter.ts` |
| `apps/desktop/electron/adapters/core-work-item-adapter.ts` | `apps/desktop/electron/work-items/core-adapter.ts` |
| `apps/desktop/electron/services/work-item-execution-manifest-store.ts` | `apps/desktop/electron/work-items/execution-manifest-store.ts` |
| `apps/desktop/electron/services/work-item-execution-query-service.ts` | `apps/desktop/electron/work-items/execution-query-service.ts` |
| `apps/desktop/electron/services/work-item-execution-service.ts` | `apps/desktop/electron/work-items/execution-service.ts` |
| `apps/desktop/electron/services/work-item-inventory-service.ts` | `apps/desktop/electron/work-items/inventory-service.ts` |
| `apps/desktop/electron/services/work-item-inventory-store.ts` | `apps/desktop/electron/work-items/inventory-store.ts` |
| `apps/desktop/electron/services/work-item-inventory-sync-service.ts` | `apps/desktop/electron/work-items/inventory-sync-service.ts` |
| `apps/desktop/electron/services/work-item-run-history-service.ts` | `apps/desktop/electron/work-items/run-history-service.ts` |
| `apps/desktop/electron/services/work-item-run-store.ts` | `apps/desktop/electron/work-items/run-store.ts` |
| `docs/architecture/observability/profiles/local-observe.yml` | `docs/architecture/observability-profiles/local-observe.yml` |
| `packages/runtime/src/application/work-items/inventory-backlog-provider.test.ts` | `packages/runtime/src/application/work-item/inventory-backlog-provider.test.ts` |
| `packages/runtime/src/application/work-items/inventory-backlog-provider.ts` | `packages/runtime/src/application/work-item/inventory-backlog-provider.ts` |

## 批次 D — 零散收敛

`3234849` — 24 个重命名

| 旧路径 | 新路径 |
| --- | --- |
| `apps/cli/src/tui/board/registry/loading.ts` | `apps/cli/src/tui/board/registry/loading-phase.ts` |
| `apps/cli/src/tui/shared/View.ts` | `apps/cli/src/tui/shared/view-types.ts` |
| `apps/desktop/ARCHITECTURE.md` | `apps/desktop/architecture.md` |
| `apps/desktop/TIMELINE_MOTION.md` | `apps/desktop/timeline-motion.md` |
| `AFK-ARCHITECTURE.md` | `docs/architecture/afk-architecture-handbook.md` |
| `AFK-ARCHITECTURE.pdf` | `docs/architecture/afk-architecture-handbook.pdf` |
| `docs/decisions/observability-2026-08-02.md` | `docs/research/observability-survey-2026-08-02.md` |
| `skills/api-workflow/templates/auth-artifacts.gitignore` | `skills/api-workflow/scaffold/auth-artifacts.gitignore` |
| `skills/api-workflow/templates/auth.env.example` | `skills/api-workflow/scaffold/auth.env.example` |
| `skills/api-workflow/templates/browser-auth-runbook.md` | `skills/api-workflow/scaffold/browser-auth-runbook.md` |
| `skills/api-workflow/templates/fixtures/api-context.ts` | `skills/api-workflow/scaffold/fixtures/api-context.ts` |
| `skills/api-workflow/templates/fixtures/browser-session.localhost-cdp.ts` | `skills/api-workflow/scaffold/fixtures/browser-session.localhost-cdp.ts` |
| `skills/api-workflow/templates/fixtures/browser-session.storage-state.ts` | `skills/api-workflow/scaffold/fixtures/browser-session.storage-state.ts` |
| `skills/api-workflow/templates/fixtures/test-data.ts` | `skills/api-workflow/scaffold/fixtures/test-data.ts` |
| `skills/api-workflow/templates/package.json` | `skills/api-workflow/scaffold/package.json` |
| `skills/api-workflow/templates/playwright.config.ts` | `skills/api-workflow/scaffold/playwright.config.ts` |
| `skills/api-workflow/templates/scenarios/index.ts` | `skills/api-workflow/scaffold/scenarios/index.ts` |
| `skills/api-workflow/templates/scenarios/order-flow.spec.ts` | `skills/api-workflow/scaffold/scenarios/order-flow.spec.ts` |
| `skills/api-workflow/templates/setup/auth-api.setup.ts` | `skills/api-workflow/scaffold/setup/auth-api.setup.ts` |
| `skills/api-workflow/templates/setup/auth-ui.setup.ts` | `skills/api-workflow/scaffold/setup/auth-ui.setup.ts` |
| `skills/api-workflow/templates/utils/auth.ts` | `skills/api-workflow/scaffold/utils/auth.ts` |
| `skills/api-workflow/templates/utils/cdp-endpoint.ts` | `skills/api-workflow/scaffold/utils/cdp-endpoint.ts` |
| `skills/api-workflow/templates/utils/poll-until.ts` | `skills/api-workflow/scaffold/utils/poll-until.ts` |
| `skills/api-workflow/templates/utils/require-env.ts` | `skills/api-workflow/scaffold/utils/require-env.ts` |

## 批次 E — 同名消歧

`bea6513` — 4 个重命名

| 旧路径 | 新路径 |
| --- | --- |
| `packages/runtime/src/application/project-context.test.ts` | `packages/runtime/src/application/project/context.test.ts` |
| `packages/runtime/src/application/project-context.ts` | `packages/runtime/src/application/project/context.ts` |
| `packages/runtime/src/application/project-resolver.test.ts` | `packages/runtime/src/application/project/resolver.test.ts` |
| `packages/runtime/src/application/project-resolver.ts` | `packages/runtime/src/application/project/resolver.ts` |

---

## 随改名一并调整的配置

| 文件 | 调整 |
| --- | --- |
| `packages/runtime/package.json` | exports 是白名单，`application/modules/loop-runner`、`qa-runner`、`application/loop/loop-config` 同步改为 `application/runners/*` |
| `packages/{core,application,workflow-graph}/vitest.config.ts` | 测试发现从 `tests/**/*.test.ts` 改为 `src/**/*.test.ts` |
| `packages/{core,application,workflow-graph}/tsconfig.json` | 新增 `exclude`，测试文件不进入发布的 `dist/` |
| `skills/api-workflow/scripts/validate.mjs`、`SKILL.md` | 17 处硬编码的 `templates/` 路径改为 `scaffold/` |

## 执行中发现并已修正的四个工程问题

1. **移动文件自身的相对 import 要重算**：文件上移一层后，它自己的 `../x` 指向变了，引擎必须按新目录重算，而不只是改指向它的引用。
2. **exports 白名单是路径解析的一部分**：`@afk/runtime/application/modules/loop-runner` 走的是 package exports，改目录后必须同步改白名单，否则别名解析直接断掉。
3. **markdown 链接的 `#fragment`**：`(path#anchor)` 的右括号不紧跟路径，按整串匹配会漏。
4. **`composite` 项目的 `tsbuildinfo` 残留**：删了 `dist/` 但 `tsconfig.tsbuildinfo` 还在，tsc 会判定"无需构建"而静默跳过输出。CI 是全新 checkout 所以碰不到，本地清理构建产物时要注意。

## 未纳入本次改动的两处新发现

执行后全仓扫描发现两处**同包跨层同名**，与本次处理的 `project-resolver` 属同类问题，但不在原清单内：

| 同名 | 位置 | 建议 |
| --- | --- | --- |
| `resource-registry.ts` | `application/runtime/` 与 `infrastructure/runtime/` | 上层是端口、下层是实现，上层可叫 `resource-registry-port.ts` |
| `tracker-adapter.ts` | `domain/backlog/` 与 `infrastructure/tracker/changes/` | 领域端口按六边形惯例可叫 `tracker-port.ts` |

## 建议追加的工具护栏

`scripts/architecture-guard.mjs` 增加一条规则：**同一包内不同目录出现同名 `.ts` 文件即报错**。本次 5 个批次里的 `project-resolver` / `isolate` 之所以能长期存在，正是因为没有工具能发现它们。
