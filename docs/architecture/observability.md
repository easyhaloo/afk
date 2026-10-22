# 可观测性优先 Harness：实施与运行指南

## 1. 当前里程碑

运行事实追加到可验证事件流。`WorkflowRunner` 的 observer 由调用方显式注入，写入失败会阻止继续执行；不再使用 `AFK_HARNESS_MODE` 或默认无审计的运行模式。QA、Loop 与其他状态编排尚未全部由 `RunCoordinator` 接管，不能将“审计强制写入”理解为完整事件驱动执行已经完成。

| 能力 | 当前状态 | 说明 |
| --- | --- | --- |
| 纯领域 `WorkItem` / `Run` / `RunEvent` / reducer | 已实现 | `packages/core/` 无 Node.js、网络、GitHub、Pino 或 Commander 依赖。 |
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
pnpm build
export AFK_EVENT_STORE_DIR="$HOME/.afk/events"
export AFK_PROFILE=local
node apps/cli/dist/index.js run --backlog-id 123 --execution-mode batch
```

`WorkflowRunner` 在 `AFK_EVENT_STORE_DIR` 追加 JSONL 审计事件；不能持久化事件时抛出 `AuditPersistenceError`，不会静默跳过审计。

Provider Backlog owns business identity and lifecycle. `BacklogItem.id` is
recorded as `Run.workItemId` and runtime/event `backlogId`; `runId` identifies
only one attempt. Runtime heartbeat freshness is diagnostic: `stale` never
changes the Provider Backlog state. Desktop launch records in
the execution workspace's `.afk/work-item-runs.json` are Worker launch receipts,
not execution or business-state evidence.

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AFK_EVENT_STORE_DIR` | `~/.afk/events` | JSONL audit stream 根目录。 |
| `AFK_PROFILE` | `local` | 写入 `ObservationContext.profileId` 的可复现运行组合标识。 |

## 3. 审计、重放与诊断

所有查询都是只读的，不会申请 backlog、启动 agent、创建 worktree 或修改远程 tracker。

```bash
# 检查本地事件目录
node apps/cli/dist/index.js observe doctor --json

# 发现本地事件目录中的 run ID
node apps/cli/dist/index.js observe runs --json

# 查看事件时序与 hash-chain 校验结论
node apps/cli/dist/index.js observe timeline <run-id> --json
node apps/cli/dist/index.js observe verify <run-id> --json

# 从事件流重放 aggregate state；不会执行 effect
node apps/cli/dist/index.js observe replay <run-id> --json

# 直接回答“为何运行、失败、终止或等待人工”
node apps/cli/dist/index.js observe explain <run-id>
```

一次可解释的 run 至少拥有 `run.requested`、`run.started`、执行/QA step 边界、失败分类或变更单事实，以及 `run.finished` 或 `human_gate.opened`。事件名称低基数，动态值写入 data。

`packages/runtime/src/infrastructure/io/logger.ts` 导出
`withLogContext({ runId, workItemId }, asyncFn)` 与 `getLogContext()`。
前者用 AsyncLocalStorage 隔离异步作用域，Pino mixin 为作用域内的
`logger` / `fileLogger` JSON 行添加 `runId`、`workItemId`；后者返回当前上下文，
作用域外为 `undefined`。独立 QA 接入时应优先复用已有上下文中的 managed
`runId`，避免替换管理闭环的主运行身份。并行作用域互不串线，嵌套调用结束或抛错后
恢复父作用域。现有脱敏与按日轮转保持不变；调用方负责在运行入口接入该作用域。

## 4. Evidence 与数据治理

`LocalEncryptedEvidenceStore` 对正文按哈希寻址并以 AES-256-GCM 加密。用于创建 store 的密钥必须来自受控 secret provider，而非命令行参数、日志或 profile 文件。文本 evidence 在加密前会尝试去除常见 GitHub token、API key、AWS access key、Bearer token 和 `token=/secret=/password=` 赋值；它不是通用 DLP 引擎，生产化前仍须接入组织的 secret scanner、访问控制与保留策略。

> 事件只记录 metadata、hash 和 `EvidenceRef`。prompt、命令全文、环境变量、cookie、token、私有代码和高基数路径不应进入 metric label、OTLP attribute 或普通日志。

JSONL 事件历史默认全部保留，构造、追加和查询均不自动清理。
`JsonlEventStore.prune({ retentionMs, exclusiveAccess: true })` 是显式维护 API，
返回已删除的 run ID；缺少保留时长或独占访问确认时返回空数组。
`retentionMs` 必须是非负安全整数，截止时间为 store 的当前时间减去该时长。
没有新增 CLI 命令或自动保留策略。

清理仅针对完整 hash chain、run ID 与 sequence 验证通过，且 core replay
确认末尾为成功、失败或取消的 `run.finished` 的事件流。终止事件与流中所有
事件的 `occurredAt` 必须严格早于截止时间；恰在截止时间上的事件保留。
判断不使用文件 mtime 或写入时的 `observedAt`。活跃、`awaiting_human`、空流、
损坏、未知 schema/type、无效时间及终止后仍追加事件的流均保留。

prune 复用该 store 的 run mutation 队列；检查期间排入的新追加会使该流跳过删除。
最终队列检查与同步 unlink 之间没有进程内异步让出。`exclusiveAccess: true`
是调用方对维护期间没有其他 store 实例或进程写入该目录的确认，**不是文件锁或
跨进程原子保证**；无法确认独占访问时应省略该参数并保留历史。
清理只删除对应 run 的 JSONL 文件，不修改独立预算账本或 execution-query index
缓存；查询层可以从剩余事件流重建 index。

## 5. 已验证行为

测试覆盖领域 reducer、执行基线、JSONL hash chain、加密与脱敏证据、强制注入的 RunObserver、RunCoordinator、profile 解析、时间线重放，以及 QA/Loop 回归。历史基线与当时的失败分类见 `docs/_archive/superpowers/specs/2026-08-23-observability-harness-baseline.md`；该历史结果不代表当前测试状态。

## 6. Agent Telemetry SSOT Boundary

Agent-layer telemetry (token usage, cost, tool calls) is owned by the harness
itself. AFK only reads what the harness already recorded; it never re-derives
or estimates from intermediate events.

| Layer | Owner | AFK reads |
|---|---|---|
| Agent usage and tool calls | Harness (Claude Code / Codex) | `agent.session_recorded` event |
| Domain execution (run.requested, workspace.prepared, change.published, human_gate, commit sha) | AFK | Event log (write) |

The `agent.session_recorded` event is emitted when an execution result is
assembled, with `sessionId` and optional `usage: { inputTokens, outputTokens,
totalTokens }`. For `local` sandbox: transcript is read from
`~/.claude/projects/<slug>/<sessionId>.jsonl` (Claude Code) or
`~/.codex/sessions/*/*/*/rollout-*-<thread_id>.jsonl` (Codex). For `docker` /
`podman` sandboxes: `HOME` is not forwarded into the container and harness
directories are not mounted — local transcript telemetry is unavailable
(distinct from zero tokens). Native stream telemetry can still be returned
by the execution; reading it does not require host logs.

`agent.session_recorded` and `ExecutionResult` also accept optional
`tools: AgentToolCallSummary[]` (type exported by `@afk/core`). Each call contains
only `id`, `name`, `result` (`succeeded`, `failed`, `unknown`, `in_progress`),
and optional `exitCode`, `startedAt`, `completedAt`, `durationMs`. Commands,
arguments, output bodies, error messages, file paths and search queries are
excluded. Timestamps and durations come from native fields; missing values
are not filled using AFK's clock or text parsing.

The pure domain API in `packages/runtime/src/domain/agents/tool-telemetry.ts` exports
`extractClaudeToolEvents(lines)`, `extractCodexToolEvents(lines)` and
`collectAgentToolEvent(provider, event, tools)`; the collector merges parsed
native events into a caller-owned map keyed by tool call/item ID. The two
JSONL extractors return `AgentToolCallSummary[] | undefined` and skip malformed
lines. Claude reads native assistant `tool_use` and user `tool_result` blocks;
repeated assistant entries for one tool ID count once. Missing results remain
`unknown`; `tool_result.is_error` supplies the native result (omitted means
false under Claude's protocol).

Codex reads exec `item.started`/`item.completed` and app-server
`item/started`/`item/completed` with the same parser, mapping snake_case and
camelCase fields. Recognized tools are commands, MCP calls, file changes,
web searches, dynamic tools and agent collaboration tools. Commands require
a real `exit_code`/`exitCode` to report success; nonzero codes report failure
even if item status says completed. Other results use native status or dynamic
tool `success`, never output text. A started-only item stays `in_progress`;
a completed item without result evidence stays `unknown`. Replayed starts
cannot overwrite a completed result. MCP names use `server.tool`.

`StreamingAgentExecution.handleLine` and
`CodexAppServerExecution.consumeNotifications` collect the metadata as native
events arrive, before normalization discards tool fields. Every result branch
returns collected `tools`, including failure, abort and timeout. This does not
add a raw-output buffer and does not depend on the bounded `captureOutput`
tail. With no recognized calls, `tools` remains absent.

`packages/runtime/src/infrastructure/observability/agent-telemetry.ts` re-exports the provider extractors
and provides `readAgentTools(options: ReadTelemetryOptions):
Promise<AgentToolCallSummary[] | undefined>`, independently of the existing
`readAgentTelemetry` token API. Its `collectAgentTelemetry(execution, result,
sandboxKind)` entry point owns provider selection, native session identity and
transcript fallback for both WorkflowRunner and QARunner. It selects readers
from `execution.metadata.provider`, including per-step provider overrides;
unsupported providers do not fall back to Claude readers. The runners retain
ownership of event persistence and budget accounting. Native `result.usage`
and `result.tools` take precedence independently, including explicit zero usage
and empty tool lists. Container executions retain native telemetry but never
resolve host transcripts. For local executions, use Claude's existing `telemetryPath`, Codex's
`findCodexRollout(threadId)` path, or OpenCode's provider-native storage/database
session identified by `threadId`. A missing file, container sandbox or rollout
without native item events returns `undefined`. Codex rollouts can contain
only `response_item` function calls and output bodies, without native item
lifecycle or typed result/exit-code evidence. The current parser leaves tools
absent for those records; it does not guess success, failure or an exit code
from `function_call_output` text. If raw CLI JSONL is already available,
`extractCodexToolEvents(lines)` can parse native item events from it, but a
truncated capture tail cannot establish complete session coverage.

The focused fixtures exercise deduplication, exit codes, missing results,
malformed lines, transport collection and metadata-only output. Runner
integration tests verify transcript fallback and `agent.session_recorded`
JSONL persistence. These checks do not establish coverage for every live
harness version; protocol changes still require native-session checks.

Execution projections and the desktop execution-history IPC expose optional
`usage: { inputTokens, outputTokens, totalTokens }` from verified
`agent.session_recorded` events. They sum the peak valid cumulative usage per session
within one run; repeated or replayed older cumulative records do not count a
session twice or reduce its peak.
Only recorded usage contributes to the sum, so it may be partial when some
sessions have no telemetry. Missing usage stays absent; an explicitly recorded
zero stays zero. The run-center inspector displays the three token counts or
“未采集”, independently of execution status. No cost, duration, or transcript
content is inferred or exposed. The optional execution-query index is versioned
and rebuilt from event streams when its schema or cached usage is invalid.

## 7. 下一阶段的强制门禁

将 `RunCoordinator` 作为全部运行副作用的唯一授权来源之前，必须先完成以下门禁：

1. 以 `RunCoordinator` 替换 Workflow、Loop、QA 之间的直接状态编排，并将 runtime JSON/TUI 转为 event projections。
2. 将 JSONL store 接入 LeasePort/fencing，覆盖多 worker、崩溃重启、重复回调和 event append 故障注入。
3. 接入 OTLP traces、logs 与 metrics；将 `afk.observability.coverage_ratio`、event append latency、run stale、lease expiry、approval aging 设为 SLO。
4. 实现受控 `confirm-merge`：先经 ChangePort 验证外部 PR/MR 已合并且目标正确，再追加 `HumanGateSatisfied` 与 terminal `done` event。
5. 持续让 Workflow/QA 通过 core `ExecutionBasePolicy` 使用 `baseBacklogId`，不得用 `parentId` 或 `dependsOn` 推断 Git 基线。
6. 执行隔离 GitHub/GitLab 真实 E2E：Issue → claim → agent → QA → PR/MR → human merge → dependency unlock → timeline → dry-run replay。

在以上门禁完成前，事件流可用于诊断、对账和 golden trace 比较，但不能成为自动合并、状态恢复或外部副作用授权的唯一依据。

## 8. 日志落盘约定

所有 AFK 日志都写在同一个根目录下，默认 `~/.afk/logs`。路径由 `packages/runtime/src/infrastructure/io/log-paths.ts` 统一给出，其它模块不得自行拼接日志目录。

| 位置 | 内容 | 保留策略 |
| --- | --- | --- |
| `~/.afk/logs/afk-YYYY-MM-DD.log` | 按天轮转的 pino JSONL 日志；TTY 下 stderr 另有彩色版本 | 7 天，打开新文件时清理 |
| `~/.afk/logs/watchdog.log` | watchdog 触发记录 | 7 天 |
| `~/.afk/logs/timeout/timeout-<iid>-<timestamp>.log` | workflow 超时时捕获的 tmux pane | 7 天 |
| `~/.afk/logs/qa/timeout-<backlogId>-<timestamp>.log` | QA 超时时捕获的 Agent 输出 | 7 天 |

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AFK_LOG_DIR` | `~/.afk/logs` | 日志根目录；上表所有子路径随之整体迁移。 |
| `LOG_LEVEL` | `info` | pino 日志级别，启动时读取。 |

历史遗留：watchdog 与 QA 的超时快照曾经写在 `~/.claude/logs/afk/`（Claude Code 的家目录），是统一日志改造时的遗漏，现已并入上述根目录。`tests/contract/log-paths.test.ts` 守卫该约定，禁止再出现第二个日志根目录。
