# 可观测性优先 Harness：实施与运行指南

## 1. 当前里程碑

本分支实现的是 **Harness 基础层与 observe-mode 迁移桥接**，而不是一次性替换 AFK 的全部编排。核心原则是：运行事实先被追加到可验证事件流，现有 `WorkflowRunner` 与 `QARunner` 在显式启用时双写这些事实；默认模式保持 legacy 行为，不改变现有命令或外部副作用。

| 能力 | 当前状态 | 说明 |
| --- | --- | --- |
| 纯领域 `WorkItem` / `Run` / `RunEvent` / reducer | 已实现 | `src/core/` 无文件、网络、GitHub、Pino 或 Commander 依赖。 |
| 显式执行基线策略 | 已实现 | `parent`、`dependsOn` 与 `baseWorkItemId` 在 core 模型中职责分离。现有 backlog 语义修复仍须独立合并。 |
| JSONL 事件存储 | 已实现 | 单 run 顺序、hash chain、fsync 追加、重启校验与读取。初期只保证单 workspace 进程内序列化。 |
| 本地加密 EvidenceStore | 已实现 | AES-256-GCM、内容哈希、文本 secret redaction；尚未在 legacy runner 中自动捕获正文。 |
| Workflow / QA 双写 | 已实现 | `AFK_HARNESS_MODE=observe` 时记录 claim、workspace、step、failure、PR/MR 与 merge/human-gate 事实。 |
| RunCoordinator | 已实现为 shadow foundation | 已有 command → decision → effect audit 解释器；尚未接管 legacy runner 的 effect 执行。 |
| Trusted profile / capability manifest | 已实现 | 可解析能力、拒绝缺失与冲突；当前为仓库内可信组合，不下载远程插件。 |
| 查询 CLI | 已实现 | `observe runs|timeline|verify|replay|explain|doctor`。 |
| OTLP、跨进程 fencing、投影替换、confirm-merge | 未切换 | 下一阶段工作，保持为明确的生产门禁。 |

## 2. 启用 observe 模式

先构建当前分支，然后以显式环境变量启用双写。默认 `legacy` 模式不会创建事件存储，也不会改变既有的 workflow/QA 路径。

```bash
node scripts/build.mjs
export AFK_HARNESS_MODE=observe
export AFK_EVENT_STORE_DIR="$HOME/.afk/events"
export AFK_PROFILE=local-observe
node dist/index.js run --backlog-id 123 --execution-mode batch
```

`WorkflowRunner` 与 `QARunner` 会继续使用既有 provider、runtime JSON、Pino 与 tracker 状态机；同时在 `AFK_EVENT_STORE_DIR` 追加每个 run 的 JSONL 审计流。由于本阶段是 dual-write，事件存储失败只会被记录为错误，**不会**阻断 legacy 流程。Coordinator 接管后会将对外写入和自动合并改为 fail-closed。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AFK_HARNESS_MODE` | `legacy` | `observe` 启用双写；`shadow` 与 `coordinator` 为后续切换预留。 |
| `AFK_EVENT_STORE_DIR` | `~/.afk/events` | JSONL audit stream 根目录。 |
| `AFK_PROFILE` | `legacy-compat` | 写入 `ObservationContext.profileId` 的可复现运行组合标识。 |

## 3. 审计、重放与诊断

所有查询都是只读的，不会申请 backlog、启动 agent、创建 worktree 或修改远程 tracker。

```bash
# 检查当前模式和本地事件目录
node dist/index.js observe doctor --json

# 发现本地事件目录中的 run ID
node dist/index.js observe runs --json

# 查看事件时序与 hash-chain 校验结论
node dist/index.js observe timeline <run-id> --json
node dist/index.js observe verify <run-id> --json

# 从事件流重放 aggregate state；不会执行 effect
node dist/index.js observe replay <run-id> --json

# 直接回答“为何运行、失败、终止或等待人工”
node dist/index.js observe explain <run-id>
```

一次可解释的 run 至少拥有 `run.requested`、`run.started`、执行/QA step 边界、失败分类或变更单事实，以及 `run.finished` 或 `human_gate.opened`。事件名称低基数，动态值写入 data；Pino 日志使用同一 `trace_id`、`run_id`、`work_item_id`、`profile_id`、attempt 和 lease epoch 字段。

## 4. Evidence 与数据治理

`LocalEncryptedEvidenceStore` 对正文按哈希寻址并以 AES-256-GCM 加密。用于创建 store 的密钥必须来自受控 secret provider，而非命令行参数、日志或 profile 文件。文本 evidence 在加密前会尝试去除常见 GitHub token、API key、AWS access key、Bearer token 和 `token=/secret=/password=` 赋值；它不是通用 DLP 引擎，生产化前仍须接入组织的 secret scanner、访问控制与保留策略。

> 事件只记录 metadata、hash 和 `EvidenceRef`。prompt、命令全文、环境变量、cookie、token、私有代码和高基数路径不应进入 metric label、OTLP attribute 或普通日志。

## 5. 已验证行为

以下测试覆盖本里程碑：领域 reducer、执行基线、JSONL hash chain、加密与脱敏证据、RunObserver、legacy/observe bridge、RunCoordinator、profile 解析、时间线重放，以及既有 QA/loop 回归。构建后已实际执行 `observe doctor --json`。

全量 Vitest 在隔离基线和本分支仍保留既有的 PTY/dashboard/worktree-diagnostics 环境失败；本分支全量运行结果为 **84 个文件通过、1 个跳过、3 个文件失败（10 个失败用例）**，所有新增 Harness 测试通过。详细基线与失败分类见 `docs/superpowers/specs/2026-08-23-observability-harness-baseline.md`。

## 6. 下一阶段的强制门禁

下一阶段不得直接把 `AFK_HARNESS_MODE=coordinator` 用于生产。必须先完成以下门禁：

1. 以 `RunCoordinator` 替换 Workflow、Loop、QA 之间的直接状态编排，并将 runtime JSON/TUI 转为 event projections。
2. 将 JSONL store 接入 LeasePort/fencing，覆盖多 worker、崩溃重启、重复回调和 event append 故障注入。
3. 接入 OTLP traces、logs 与 metrics；将 `afk.observability.coverage_ratio`、event append latency、run stale、lease expiry、approval aging 设为 SLO。
4. 实现受控 `confirm-merge`：先经 ChangePort 验证外部 PR/MR 已合并且目标正确，再追加 `HumanGateSatisfied` 与 terminal `done` event。
5. 将 `parent` / `dependsOn` / `baseBacklogId` 的现有 backlog 修复以独立 PR 合并，并让 Workflow/QA 统一调用 core `ExecutionBasePolicy`。
6. 执行隔离 GitHub/GitLab 真实 E2E：Issue → claim → agent → QA → PR/MR → human merge → dependency unlock → timeline → dry-run replay。

在以上门禁完成前，observe 模式的事件流可用于诊断、对账和 golden trace 比较，但不能成为自动合并、状态恢复或外部副作用授权的唯一依据。
