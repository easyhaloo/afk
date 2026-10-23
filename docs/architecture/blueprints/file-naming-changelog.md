# 文件改名改动清单

**生成方式：** 对 1102 个受版本控制文件全量扫描后逐条实测校验，非人工估算。
**校验结果：** 源文件缺失 0、目标路径被占用 0、新路径两两重复 0、新路径撞已有目录 1（`apps/cli/src/tui/board/index.ts`，为**有意的桶文件合并**）。
**引用统计口径：** 按 import specifier 的 basename 精确匹配（不含 `some-model.js` 这类前缀命中）；桶文件 `index.ts` 按父目录路径统计；`.test.ts` 是测试入口，除被其它测试引用外无外部引用。
**执行方式：** 每批次一个 commit；`git mv` 后由脚本批量改 import，再跑 `pnpm typecheck && pnpm test`。

---

## 批次 A — 纯改名（零结构变化）

共 12 个文件。

| # | 旧路径 | 新路径 | 理由 | 需改引用 |
| --- | --- | --- | --- | --- |
| 1 | `apps/cli/src/tui/shared/Keyboard.ts` | `apps/cli/src/tui/shared/keyboard.ts` | class 文件误用组件命名 | 3 |
| 2 | `apps/cli/src/tui/shared/Keyboard.test.ts` | `apps/cli/src/tui/shared/keyboard.test.ts` | — | 3 |
| 3 | `apps/cli/src/tui/shared/Registry.ts` | `apps/cli/src/tui/shared/registry.ts` | class 文件误用组件命名 | 1 |
| 4 | `apps/cli/src/tui/shared/Registry.test.ts` | `apps/cli/src/tui/shared/registry.test.ts` | — | 1 |
| 5 | `apps/cli/src/tui/app/state/initialState.ts` | `apps/cli/src/tui/app/state/initial-state.ts` | camelCase 孤例 | 3 |
| 6 | `apps/desktop/tests/backlog-page.test.ts` | `apps/desktop/tests/backlog-filter.test.ts` | 实际测 backlog-filter | 0 |
| 7 | `README_zh.md` | `README.zh.md` | 对齐 .zh.md 约定 | 0 |
| 8 | `docs/architecture/blueprints/core-layer-architecture_zh.md` | `docs/architecture/blueprints/core-layer-architecture.zh.md` | — | 0 |
| 9 | `docs/research/RESEARCH.md` | `docs/research/jumpserver-public-key-upload-2026-09-21.md` | 实为 JumpServer 调研 | 0 |
| 10 | `tests/e2e/afk-e2e-parity.test.ts` | `tests/e2e/e2e-parity.test.ts` | afk- 前缀仓内冗余 | 0 |
| 11 | `tests/fixtures/afk-e2e-parity.ts` | `tests/fixtures/e2e-parity.ts` | — | 1 |
| 12 | `tests/fixtures/afk-desktop-exec-20261014022840.txt` | `tests/fixtures/desktop-exec-output.txt` | 固定 fixture 不带时间戳 | 0 |

## 批次 B — 塌陷嵌套 / 上移测试

共 37 个文件。

| # | 旧路径 | 新路径 | 理由 | 需改引用 |
| --- | --- | --- | --- | --- |
| 1 | `apps/cli/src/tui/board/board/BoardCard.tsx` | `apps/cli/src/tui/board/BoardCard.tsx` | 塌陷同名嵌套 | 2 |
| 2 | `apps/cli/src/tui/board/board/BoardCard.test.tsx` | `apps/cli/src/tui/board/BoardCard.test.tsx` | — | 1 |
| 3 | `apps/cli/src/tui/board/board/BoardLane.tsx` | `apps/cli/src/tui/board/BoardLane.tsx` | — | 1 |
| 4 | `apps/cli/src/tui/board/board/BoardView.tsx` | `apps/cli/src/tui/board/BoardView.tsx` | — | 3 |
| 5 | `apps/cli/src/tui/board/board/BoardView.test.tsx` | `apps/cli/src/tui/board/BoardView.test.tsx` | — | 2 |
| 6 | `apps/cli/src/tui/board/board/model.ts` | `apps/cli/src/tui/board/model.ts` | — | 9 |
| 7 | `apps/cli/src/tui/board/board/model.test.ts` | `apps/cli/src/tui/board/model.test.ts` | — | 8 |
| 8 | `apps/cli/src/tui/board/board/index.ts` | `apps/cli/src/tui/board/index.ts` | 合并：追加 export { BoardView } | 2 |
| 9 | `packages/runtime/src/application/modules/_registry.ts` | `packages/runtime/src/application/runners/registry.ts` | 去掉下划线私有前缀 | 2 |
| 10 | `packages/runtime/src/application/modules/_registry.test.ts` | `packages/runtime/src/application/runners/registry.test.ts` | 去掉下划线私有前缀 | 1 |
| 11 | `packages/runtime/src/application/modules/isolate.ts` | `packages/runtime/src/application/runners/isolate.ts` | 执行器不是模块 | 17 |
| 12 | `packages/runtime/src/application/modules/loop-runner.ts` | `packages/runtime/src/application/runners/loop-runner.ts` | — | 4 |
| 13 | `packages/runtime/src/application/modules/loop-runner.test.ts` | `packages/runtime/src/application/runners/loop-runner.test.ts` | — | 3 |
| 14 | `packages/runtime/src/application/modules/project-resolver.ts` | `packages/runtime/src/application/runners/project-resolver.ts` | — | 8 |
| 15 | `packages/runtime/src/application/modules/project-resolver.test.ts` | `packages/runtime/src/application/runners/project-resolver.test.ts` | — | 8 |
| 16 | `packages/runtime/src/application/modules/qa-runner.ts` | `packages/runtime/src/application/runners/qa-runner.ts` | — | 6 |
| 17 | `packages/runtime/src/application/modules/qa-runner.test.ts` | `packages/runtime/src/application/runners/qa-runner.test.ts` | — | 5 |
| 18 | `packages/runtime/src/application/loop/loop-config.ts` | `packages/runtime/src/application/runners/loop-config.ts` | loop 概念并入 runners/ | 3 |
| 19 | `packages/core/tests/execution-base-policy.test.ts` | `packages/core/src/execution-base-policy.test.ts` | 测试 colocate | 1 |
| 20 | `packages/core/tests/reducer.test.ts` | `packages/core/src/reducer.test.ts` | 测试 colocate | 1 |
| 21 | `packages/core/tests/work-item-project-key.test.ts` | `packages/core/src/work-item-project-key.test.ts` | 测试 colocate | 1 |
| 22 | `packages/application/tests/backlog-mapping.test.ts` | `packages/application/src/backlog-mapping.test.ts` | 测试 colocate | 1 |
| 23 | `packages/application/tests/execution-query.test.ts` | `packages/application/src/execution-query.test.ts` | 测试 colocate | 2 |
| 24 | `packages/application/tests/execution.test.ts` | `packages/application/src/execution.test.ts` | 测试 colocate | 16 |
| 25 | `packages/application/tests/inventory.test.ts` | `packages/application/src/inventory.test.ts` | 测试 colocate | 14 |
| 26 | `packages/application/tests/observation.test.ts` | `packages/application/src/observation.test.ts` | 测试 colocate | 1 |
| 27 | `packages/application/tests/provider-inventory.test.ts` | `packages/application/src/provider-inventory.test.ts` | 测试 colocate | 2 |
| 28 | `packages/application/tests/runtime-health.test.ts` | `packages/application/src/runtime-health.test.ts` | 测试 colocate | 1 |
| 29 | `packages/application/tests/workflow-instance.test.ts` | `packages/application/src/workflow-instance.test.ts` | 测试 colocate | 1 |
| 30 | `packages/workflow-graph/tests/archify.test.ts` | `packages/workflow-graph/src/archify.test.ts` | 测试 colocate | 7 |
| 31 | `packages/workflow-graph/tests/determinism.test.ts` | `packages/workflow-graph/src/determinism.test.ts` | 测试 colocate | 0 |
| 32 | `packages/workflow-graph/tests/ir.test.ts` | `packages/workflow-graph/src/ir.test.ts` | 测试 colocate | 8 |
| 33 | `packages/workflow-graph/tests/layout.test.ts` | `packages/workflow-graph/src/layout.test.ts` | 测试 colocate | 6 |
| 34 | `packages/workflow-graph/tests/normalize.test.ts` | `packages/workflow-graph/src/normalize.test.ts` | 测试 colocate | 4 |
| 35 | `packages/workflow-graph/tests/project.test.ts` | `packages/workflow-graph/src/project.test.ts` | 测试 colocate | 29 |
| 36 | `packages/workflow-graph/tests/routing.test.ts` | `packages/workflow-graph/src/routing.test.ts` | 测试 colocate | 2 |
| 37 | `packages/workflow-graph/tests/validate.test.ts` | `packages/workflow-graph/src/validate.test.ts` | 测试 colocate | 5 |

## 批次 C — 目录重组

共 14 个文件。

| # | 旧路径 | 新路径 | 理由 | 需改引用 |
| --- | --- | --- | --- | --- |
| 1 | `packages/runtime/src/application/work-items/inventory-backlog-provider.ts` | `packages/runtime/src/application/work-item/inventory-backlog-provider.ts` | work-item 单复数统一 | 1 |
| 2 | `packages/runtime/src/application/work-items/inventory-backlog-provider.test.ts` | `packages/runtime/src/application/work-item/inventory-backlog-provider.test.ts` | — | 0 |
| 3 | `apps/cli/src/tui/board-types.ts` | `apps/cli/src/tui/board/task-types.ts` | 并入 board/，避开已有 types.ts | 17 |
| 4 | `docs/architecture/observability/profiles/local-observe.yml` | `docs/architecture/observability-profiles/local-observe.yml` | 消除文件/目录同名 | 1 |
| 5 | `apps/desktop/electron/adapters/core-work-item-adapter.ts` | `apps/desktop/electron/work-items/core-adapter.ts` | work-item- 前缀由目录名承担 | 1 |
| 6 | `apps/desktop/electron/adapters/work-item-application-adapter.ts` | `apps/desktop/electron/work-items/application-adapter.ts` | work-item- 前缀由目录名承担 | 4 |
| 7 | `apps/desktop/electron/services/work-item-execution-manifest-store.ts` | `apps/desktop/electron/work-items/execution-manifest-store.ts` | work-item- 前缀由目录名承担 | 4 |
| 8 | `apps/desktop/electron/services/work-item-execution-query-service.ts` | `apps/desktop/electron/work-items/execution-query-service.ts` | work-item- 前缀由目录名承担 | 5 |
| 9 | `apps/desktop/electron/services/work-item-execution-service.ts` | `apps/desktop/electron/work-items/execution-service.ts` | work-item- 前缀由目录名承担 | 3 |
| 10 | `apps/desktop/electron/services/work-item-inventory-service.ts` | `apps/desktop/electron/work-items/inventory-service.ts` | work-item- 前缀由目录名承担 | 3 |
| 11 | `apps/desktop/electron/services/work-item-inventory-store.ts` | `apps/desktop/electron/work-items/inventory-store.ts` | work-item- 前缀由目录名承担 | 3 |
| 12 | `apps/desktop/electron/services/work-item-inventory-sync-service.ts` | `apps/desktop/electron/work-items/inventory-sync-service.ts` | work-item- 前缀由目录名承担 | 2 |
| 13 | `apps/desktop/electron/services/work-item-run-history-service.ts` | `apps/desktop/electron/work-items/run-history-service.ts` | work-item- 前缀由目录名承担 | 2 |
| 14 | `apps/desktop/electron/services/work-item-run-store.ts` | `apps/desktop/electron/work-items/run-store.ts` | work-item- 前缀由目录名承担 | 7 |

## 批次 D — 零散收敛

共 23 个文件。

| # | 旧路径 | 新路径 | 理由 | 需改引用 |
| --- | --- | --- | --- | --- |
| 1 | `apps/cli/src/tui/shared/View.ts` | `apps/cli/src/tui/shared/view-types.ts` | 纯再导出桶 | 0 |
| 2 | `apps/cli/src/tui/board/registry/loading.ts` | `apps/cli/src/tui/board/registry/loading-phase.ts` | 与 loading-init 区分 | 2 |
| 3 | `docs/decisions/observability-2026-08-02.md` | `docs/research/observability-survey-2026-08-02.md` | 删 docs/decisions/ | 0 |
| 4 | `AFK-ARCHITECTURE.md` | `docs/architecture/afk-architecture-handbook.md` | 根目录只留 4 个文件 | 0 |
| 5 | `apps/desktop/ARCHITECTURE.md` | `apps/desktop/architecture.md` | — | 0 |
| 6 | `apps/desktop/TIMELINE_MOTION.md` | `apps/desktop/timeline-motion.md` | — | 0 |
| 7 | `skills/api-workflow/templates/auth-artifacts.gitignore` | `skills/api-workflow/scaffold/auth-artifacts.gitignore` | 实为完整项目脚手架 | 1 |
| 8 | `skills/api-workflow/templates/auth.env.example` | `skills/api-workflow/scaffold/auth.env.example` | 实为完整项目脚手架 | 1 |
| 9 | `skills/api-workflow/templates/browser-auth-runbook.md` | `skills/api-workflow/scaffold/browser-auth-runbook.md` | 实为完整项目脚手架 | 0 |
| 10 | `skills/api-workflow/templates/fixtures/api-context.ts` | `skills/api-workflow/scaffold/fixtures/api-context.ts` | 实为完整项目脚手架 | 1 |
| 11 | `skills/api-workflow/templates/fixtures/browser-session.localhost-cdp.ts` | `skills/api-workflow/scaffold/fixtures/browser-session.localhost-cdp.ts` | 实为完整项目脚手架 | 0 |
| 12 | `skills/api-workflow/templates/fixtures/browser-session.storage-state.ts` | `skills/api-workflow/scaffold/fixtures/browser-session.storage-state.ts` | 实为完整项目脚手架 | 0 |
| 13 | `skills/api-workflow/templates/fixtures/test-data.ts` | `skills/api-workflow/scaffold/fixtures/test-data.ts` | 实为完整项目脚手架 | 3 |
| 14 | `skills/api-workflow/templates/package.json` | `skills/api-workflow/scaffold/package.json` | 实为完整项目脚手架 | 0 |
| 15 | `skills/api-workflow/templates/playwright.config.ts` | `skills/api-workflow/scaffold/playwright.config.ts` | 实为完整项目脚手架 | 0 |
| 16 | `skills/api-workflow/templates/scenarios/index.ts` | `skills/api-workflow/scaffold/scenarios/index.ts` | 实为完整项目脚手架 | 0 |
| 17 | `skills/api-workflow/templates/scenarios/order-flow.spec.ts` | `skills/api-workflow/scaffold/scenarios/order-flow.spec.ts` | 实为完整项目脚手架 | 1 |
| 18 | `skills/api-workflow/templates/setup/auth-api.setup.ts` | `skills/api-workflow/scaffold/setup/auth-api.setup.ts` | 实为完整项目脚手架 | 0 |
| 19 | `skills/api-workflow/templates/setup/auth-ui.setup.ts` | `skills/api-workflow/scaffold/setup/auth-ui.setup.ts` | 实为完整项目脚手架 | 0 |
| 20 | `skills/api-workflow/templates/utils/auth.ts` | `skills/api-workflow/scaffold/utils/auth.ts` | 实为完整项目脚手架 | 13 |
| 21 | `skills/api-workflow/templates/utils/cdp-endpoint.ts` | `skills/api-workflow/scaffold/utils/cdp-endpoint.ts` | 实为完整项目脚手架 | 1 |
| 22 | `skills/api-workflow/templates/utils/poll-until.ts` | `skills/api-workflow/scaffold/utils/poll-until.ts` | 实为完整项目脚手架 | 2 |
| 23 | `skills/api-workflow/templates/utils/require-env.ts` | `skills/api-workflow/scaffold/utils/require-env.ts` | 实为完整项目脚手架 | 6 |

## 批次 E — 同名消歧（需先读懂语义）

共 2 个文件。

| # | 旧路径 | 新路径 | 理由 | 需改引用 |
| --- | --- | --- | --- | --- |
| 1 | `packages/runtime/src/application/project-resolver.ts` | `packages/runtime/src/application/project/project-resolver.ts` | 与 runners/ 同名消歧 | 9 |
| 2 | `packages/runtime/src/application/isolate.ts` | _原地保留_ | 实现体 IsolateManager；modules/isolate.ts 只是注册壳 | 1 |

---

**合计 88 个文件改名，需同步更新 292 处 import 引用，分布在 66 个文件上。**

## 执行顺序与前置

```
批次 A  → 批次 B  → 批次 C  → 批次 D  → 批次 E
```

- **A → B 无耦合**，可并行。
- **B → C 有依赖**：`application/work-items/` → `work-item/` 改名后，C 批次的 desktop `work-items/` 目录命名才不与之混淆。
- **C → D 无耦合。**
- **E 最后做**：需先读懂 `application/isolate.ts`（实现体 `IsolateManager`）与 `application/runners/isolate.ts`（生命周期注册壳）的语义差别。

## 批次 C 的两个非机械点

1. **`apps/cli/src/tui/board/board/index.ts` → `apps/cli/src/tui/board/index.ts`** 不是覆盖，是**合并**：目标文件已存在且导出 `Dashboard`，需追加 `export { BoardView } from './BoardView.js';`。
2. **`packages/runtime/src/application/isolate.ts` 原地保留**。它是能力实现（导出 `IsolateManager`），被 `apps/cli/src/commands/isolate.ts` 以 `@afk/runtime/application/isolate` 引入；`modules/isolate.ts` 只是调用它的生命周期注册壳。改名后为 `runners/isolate.ts`，职责清楚且不再同名。

## 批次 C 的收益前提

desktop 12 个 `work-item-*` 文件移入 `electron/work-items/` 后，前缀由目录名承担。**此时再去后缀会撞名**（`inventory-service.ts` 与 `inventory-store.ts`），故本次**不去后缀**——保留反而能区分「服务」与「存储」两个不同角色。若要进一步去后缀，需先按角色再分子目录（如 `work-items/service/`、`work-items/store/`），属独立批次。

## 建议追加的工具护栏

`scripts/architecture-guard.mjs` 增加一条规则：**同一包内不同目录出现同名 `.ts` 文件即报错**。成本极低，可挡住 `project-resolver.ts` / `isolate.ts` 这类「同名不同物」复发，也是其余各项的兜底。
