# 可观测性优先 Harness：实施与运行指南

## 1. 当前里程碑

运行事实追加到可验证事件流。`WorkflowRunner` 的 observer 由调用方显式注入，写入失败会阻止继续执行；不再使用 `AFK_HARNESS_MODE` 或默认无审计的运行模式。QA、Loop 与其他状态编排尚未全部由 `RunCoordinator` 接管，不能将“审计强制写入”理解为完整事件驱动执行已经完成。

| 能力 | 当前状态 | 说明 |
| --- | --- | --- |
| 纯领域 `WorkItem` / `Run` / `RunEvent` / reducer | 已实现 | `packages/afk-core/` 无 Node.js、网络、GitHub、Pino 或 Commander 依赖。 |
| 显式执行基线策略 | 已实现 | `parentId`、`dependsOn` 与 `baseBacklogId/baseWorkItemId` 在 Backlog 与 core 投影中职责分离。 |
| JSONL 事件存储 | 已实现 | 单 run 顺序、hash chain、fsync 追加、重启校验与读取。初期只保证单 workspace 进程内序列化。 |
| 本地加密 EvidenceStore | 已实现 | AES-256-GCM、内容哈希、文本 secret redaction；尚未自动捕获正文。 |
| Workflow 审计 | 已实现 | 显式注入 `RunObserver`；审计写入失败 fail-closed。 |
| RunCoordinator | 已实现基础能力 | 已有 command → decision → effect audit 解释器；尚未接管所有 runner 的 effect 执行。 |
| Trusted profile / capability manifest | 已实现 | 可解析能力、拒绝缺失与冲突；当前为仓库内可信组合，不下载远程插件。 |
| 查询 CLI | 已实现 | `observe runs|timeline|verify|replay|explain|doctor`。 |
| OTLP、跨进程 fencing、投影替换、confirm-merge | 未切换 | 下一阶段工作，保持为明确的生产门禁。 |

## 2. 审计配置

运行入口负责组装 `RunObserver` 与 JSONL `EventStore`。可以指定审计目录和 profile；无需启用模式开关。

```bash
node scripts/build.mjs
export AFK_EVENT_STORE_DIR="$HOME/.afk/events"
export AFK_PROFILE=local
node dist/index.js run --backlog-id 123 --execution-mode batch
```

`WorkflowRunner` 在 `AFK_EVENT_STORE_DIR` 追加 JSONL 审计事件；不能持久化事件时抛出 `AuditPersistenceError`，不会静默跳过审计。

Provider Backlog owns business identity and lifecycle. `BacklogItem.id` is
recorded as `Run.workItemId` and runtime/event `backlogId`; `runId` identifies
only one attempt. Runtime heartbeat freshness is diagnostic: `stale` never
changes the Provider Backlog state. Desktop launch records in
`.afk/backlog-runs.json` are not execution or business-state evidence.

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AFK_EVENT_STORE_DIR` | `~/.afk/events` | JSONL audit stream 根目录。 |
| `AFK_PROFILE` | `local` | 写入 `ObservationContext.profileId` 的可复现运行组合标识。 |

## 3. 审计、重放与诊断

所有查询都是只读的，不会申请 backlog、启动 agent、创建 worktree 或修改远程 tracker。

```bash
# 检查本地事件目录
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

测试覆盖领域 reducer、执行基线、JSONL hash chain、加密与脱敏证据、强制注入的 RunObserver、RunCoordinator、profile 解析、时间线重放，以及 QA/Loop 回归。历史基线与当时的失败分类见 `docs/_archive/superpowers/specs/2026-08-23-observability-harness-baseline.md`；该历史结果不代表当前测试状态。

## 6. 下一阶段的强制门禁

将 `RunCoordinator` 作为全部运行副作用的唯一授权来源之前，必须先完成以下门禁：

1. 以 `RunCoordinator` 替换 Workflow、Loop、QA 之间的直接状态编排，并将 runtime JSON/TUI 转为 event projections。
2. 将 JSONL store 接入 LeasePort/fencing，覆盖多 worker、崩溃重启、重复回调和 event append 故障注入。
3. 接入 OTLP traces、logs 与 metrics；将 `afk.observability.coverage_ratio`、event append latency、run stale、lease expiry、approval aging 设为 SLO。
4. 实现受控 `confirm-merge`：先经 ChangePort 验证外部 PR/MR 已合并且目标正确，再追加 `HumanGateSatisfied` 与 terminal `done` event。
5. 持续让 Workflow/QA 通过 core `ExecutionBasePolicy` 使用 `baseBacklogId`，不得用 `parentId` 或 `dependsOn` 推断 Git 基线。
6. 执行隔离 GitHub/GitLab 真实 E2E：Issue → claim → agent → QA → PR/MR → human merge → dependency unlock → timeline → dry-run replay。

在以上门禁完成前，事件流可用于诊断、对账和 golden trace 比较，但不能成为自动合并、状态恢复或外部副作用授权的唯一依据。
