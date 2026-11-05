# AFK 执行架构

本文描述的是**当前实现**，不是目标态或尚未落地的多 Agent 执行蓝图。完整状态与证据约定请参考[架构概览](overview.zh.md)及[全流程执行与 E2E 验证架构](full-workflow-e2e-architecture.md)。

## 系统边界

AFK 执行已经存在、且由上游完成拆分的 Provider-backed 工作项。AFK 本身不充当全局规划器，也不负责将需求拆成任务。外部 Issue Tracker 是 backlog 状态的权威来源；本地 manifest、执行日志、运行事件和证据用于支撑执行与审计。

## Workspace 包边界

| 包 / 应用 | 职责 |
|---|---|
| `@afk/core`（`packages/core`） | 纯领域模型、事件、reducer、策略和端口 |
| `@afk/application`（`packages/application`） | 共享用例、清单与执行查询 |
| `@afk/runtime`（`packages/runtime`） | Provider 集成、backlog 操作、工作流执行、Agent/Sandbox 适配器、Git、tmux 与持久化 |
| `@afk/workflow-graph`（`packages/workflow-graph`） | 纯工作流图表示、投影、布局、路由和校验 |
| CLI/TUI（`apps/cli`） | 命令行入口与终端交互界面 |
| Desktop（`apps/desktop`） | Electron main/preload 与 React renderer；通过校验后的 IPC 和独立 Runtime worker 执行受管工作项 |

应用通过声明的 package exports 使用共享包；共享包不得依赖应用。Desktop renderer 不得直接访问 Node Runtime，Node 能力必须经主进程提供。包边界与导入方向由架构检查约束。

## 执行入口

- `afk`：打开交互式 TUI。
- `afk run`：解析工作项后委托给实现 → 独立 QA → 发布的完整受管流程。现有运行时、超时、预算、扩展及显式执行模式参数继续生效；`--target-branch` 指工作分支，MR 目标由条目基线计划声明。
- `afk execute --work-item-id <id>`：执行受管生命周期，包括资格与 manifest 校验、实现、独立 QA、变更请求处理，以及由人控制的合并闸门。
- `afk loop start`：针对一个绑定 manifest 的工作项持续尝试，并委托给同一受管执行路径；它不是全局多工作项调度器。
- `afk qa`：对 `verification` 条目重试验证，存在受管 manifest 时自动使用，也可通过 `--execution-manifest <path>` 指定。
- `afk backlog baseline --id <prd>`：报告 PRD 积累切片的分支以及继承它的切片；`--branch <name>` 把分支写进 PRD 正文。
- `afk schedule --parent <规范身份>`：跨项目调度父项的可执行后代，重叠仓库集合串行，遵循依赖与人工合并闸门。`--max-concurrent`、`--load-limit`、`--poll-interval` 控制派发，`--watch` 等待外部状态变化，`--dry-run` 在不认领、不启动 Agent 的情况下预览批次，`--json` 输出最终报告；预览的后续批次以前序人工合并及 reconcile 完成为前提。SIGINT/SIGTERM 停止新派发并等待在途执行结束。
- `afk doctor [--workspace-root <path>] [--json]`：只读统计裸库、依赖池、受管工作区、仓库租约及保守估算的可回收空间；`afk observe doctor` 仍用于查看事件存储。
- `afk observe`：查看执行记录及其审计、证据投影。

完整命令面以 `apps/cli/src/command-registry.ts` 为准，不应从旧示例或历史计划推断当前支持的命令。

## 数据与工作区边界

- AFK 配置和系统数据位于 `~/.afk/`。
- 执行工作区位于 `~/.loop-workspace/`。
- 每个工作区的 manifest、启动回执、session、诊断运行和执行日志位于 `~/.afk/workspaces/` 下以工作区路径计算的哈希目录中。
- 仓库 checkout 位于规范执行工作区内；调用者的当前目录不会改变规范执行根目录。
- 新建的 manifest 绑定仓库 checkout 使用 linked worktree，每个远端共用 `~/.loop-workspace/repos/<host>/<project>/bare.git` 中的一份裸库。实现阶段与 QA 使用同一个存储，manifest 中的 checkout 路径保持不变；已有独立 clone 继续兼容。
- Preparer 对裸库创建、fetch、分支准备、发布和工作树移除复用文件系统 operation gate，按仓库串行操作共享 Git 元数据。活跃工作树各自保有独立目录和索引，Git 会拒绝让两个工作树同时检出同一个可写分支。
- 实现成功及 QA 借用结束后移除存储托管的工作树，包括失败后重试复用的工作树。失败时保留源码和诊断证据；存储托管的脏工作区重试会把已跟踪与未跟踪修改写入 `afk-recovery-*` Git stash，准备工作分支后重新应用，冲突时仍保留 stash。独立 clone 继续拒绝脏准备。裸库、本地分支与恢复 stash 不随工作树移除。
- Node 依赖池位于 `~/.loop-workspace/deps/<hash>/layout/`，哈希涵盖锁文件、所有 workspace package manifest、包管理配置与补丁、平台、架构及 Node ABI。受管阶段结束时收集已安装依赖，匹配阶段直接挂载。`node_modules` 保持真实目录，内部逐项软链，工作区包链接指向当前 checkout，pnpm 可变状态保留本地。外部链接或不支持的嵌套源码链接保留原安装，避免生成不可用缓存。Maven、Go 沿用原生全局缓存。
- checkout 引用依赖池时保留 pin；释放受管 checkout 时归还引用，默认超过 8 GiB 后按 LRU 淘汰无引用池。裸库继续缓存；已有独立 clone 不自动迁移。全局包管理器 store prune 由操作者在依赖池验收后显式执行。
- Agent 完成信号和 QA artifact manifest 是执行期协议文件，不是通用配置或生命周期状态存储。

以上是当前默认目录的职责摘要；具体路径解析以当前源码为准。数据权威边界见[架构概览：核心职责与边界](overview.zh.md#核心职责与边界)。

## 受管执行生命周期

受管执行会校验工作项及其 manifest，运行实现阶段，记录分支和运行证据，执行独立 QA，并准备或验证 Provider-backed 变更请求。单次执行成功不等于代码已经合并。最终合并由人控制；只有合并完成并经 reconcile 确认后，工作项才进入终态完成状态。

Provider backlog、Runtime 状态、run-event 审计轨迹和证据属于不同权威范围：

- Provider 状态是 backlog 与变更请求状态的权威来源。
- Runtime 状态记录执行尝试及其生命周期。
- append-only 运行事件支持审计和重放。
- Evidence 引用及分类支持 QA、诊断和脱敏策略。

## 失败与恢复

### 失败诊断

失败的 run 携带的是**结构化失败诊断**，而不是一句自由文本的 reason。诊断把过去挤在一个字符串里的四件事分开：

- `code` —— 稳定的机器可读失败码（`agent_idle_timeout`、`upstream_model_error`、`acceptance_criteria_failed`、`qa_environment_missing`、`workflow_setup` 等）。同一个 code 永远指同一种失败。
- `class` —— 失败**关于**什么：`work`（对工作的判决）、`agent`（agent 运行的事实）、`upstream`（外部依赖的事实，例如模型服务）、`environment`（机器的事实）、`infrastructure`（AFK 自身的流水线）。读者必须能不看散文就分辨「我们的代码有问题」「我们的 agent 不说话了」「上游模型服务过载」。
- `message` —— 一句人读的根本原因。它永远不是 provider 抓到的输出。
- `evidence` —— 支撑它的证据：探测项及其命令、期望与实际观测；命令及其退出码；agent 输出的截断尾部；超时预算、最后已知活动，以及把这次超时判定为超时的依据。

**第一次失败赢。** 失败只记录一次，落在一条链上。后来的失败不替换根因：它被追加，并指向它之前的那次失败。`run.finished`、被阻塞的 backlog 条目和 runtime 记录都携带根因，所以 run 失败的原因能活过之后到达的所有次生信息。

agent 自己报告的失败原因就是根因。provider 抓到的 stdout/stderr 是证据：它以截断尾部（4 KiB，最后 40 行）保留，其中的错误行会被提到根因里，于是 pre-commit 钩子的拒绝不会被 `pnpm` 日志的尾巴顶替。

超时是一等失败。静默超时、完成超时、硬超时各有自己的 code，并带上用尽的预算、最后已知活动与判定依据。

「重试一次尝试是否有意义」从诊断里读，而不是从被拍平的字符串里重新推导。agent 错误码词汇保持原样：`AGENT_TURN_FAILED`、`AGENT_GONE`、`AGENT_IDLE` 是 agent 运行的事实而不是对工作的判决，而超时是关于工作的事实。

环境断言是**环境声明**，永远不是测试结论。当 check 命令在本机跑不起来时，阻断理由会说明探测了哪个命令、期望什么、实际观测到什么，并归类为环境声明，读者因此能把它与「验收用例不通过」区分开。

审计流携带这份诊断：`failure.classified` 事件带 code、evidence 和前一次失败的快照，`run.finished` 在 `reason` 里带根因、在 `reasonCode` 里带 code。CLI 把根因从事件流里读回来：`afk log <runId>` 在本身没有 reason 的事件上显示 `Cause: …`，`afk observe executions --json` 列出每个失败执行的根因。

### goal condition 的长度预算

goal condition 有字符预算，而这个预算属于 **provider**，不属于 AFK。`AgentProvider` 声明它（`promptLimits.goalConditionMaxChars`）；Claude Code 声明它的 TUI 强制的 4000 字符。AFK 去问 provider，而不是自己猜一个数。

这个上限只适用于 **goal 通道** —— 即 `/goal` 命令之后的文本。作为普通消息送达的提示词（batch 模式会剥掉 `/goal`）没有 goal condition 上限，也不会被拿来比这个数。没有声明上限的 provider 按 AFK 已知的最严格上限来衡量：拒绝一个本可能被接受的 goal 只损失一条报错，而派发一个会被拒绝的 goal 损失的是整段 idle timeout。

**内容不走提示词。** backlog description —— 也就是 AC 清单 —— 被写进工作树的 `.afk/backlog-context.md`，goal 里保留模板自身的任务陈述、backlog 标题，以及一句让 agent 先读这个文件的指针。提示词长度因此与 description 长度解耦，而 AC 仍然逐字送达。`.afk/` 是 AFK 自己的运行期产物目录：这个文件不会进入变更请求，也不会让工作树看起来是脏的。QA 路径与实现路径都这样做。

提示词由**带标签的片段**拼装（任务陈述、标题、上下文指针、返工上下文、完成协议），因此当提示词过长时能指出是哪一片超了。

**派发前就能发现的问题，派发前就发现。** 最终提示词会在 agent 启动前与 provider 声明的上限比对。超限时 run 立刻以上面的结构化诊断失败：`prompt_budget_exceeded`、实际长度、上限、越界的那一片、以及建议动作 —— 而不是派发一个必然被静默拒绝的提示词，然后半小时后死于 idle timeout。见 [ADR-0026](../adr/0026-goal-condition-budget-and-worktree-context.md)。

### 执行基线与配置

条目的 `## Base Version` 段声明不可变的执行计划：

```markdown
## Base Version

- Base Ref: release
- Target Ref: production
- Source Ref: migration-source
```

`Target Ref` 缺省等于 `Base Ref`，可选的 `Source Ref` 作为迁移来源 fetch，不替代基线。manifest 在每仓持久化 `baseBranch`、`targetBranch`、`sourceBranch`；QA 对 base 验证、向 target 发布，正文与 manifest 不一致时在启动 Agent 前拒绝执行。工作分支和 `baseBacklogId` 关系与发布目标保持独立；不安全或冲突的声明直接失败。

缺少声明时，仓库本地 `.afk/project.yml` 优先于 `~/.afk/config.yml` 的 `repositories.<projectKey>` 覆盖，再依次使用 provider 仓库默认分支和全局 `defaultBaseRef`。旧 `trackerTargetBranch`、`targetBranch` 及环境变量别名继续作为全局缺省值。各仓创建独立计划，不改写缓存的全局配置。新 run 的显式 `--base-branch` 可以覆盖未声明的缺省值，但必须与正文声明或已有 manifest 一致。

```yaml
defaultBaseRef: main
repositories:
  group/api:
    baseRef: release
    targetRef: production
    sourceRef: migration-source
  group/web:
    baseRef: staging
```

### PRD 基线分支

一个 PRD 在自己的分支上积累切片。仓库的集成线是这条分支的切出点，不是切片的落点。每条切片都写在 PRD 的基线分支上并合入它，整个 PRD 完成后基线分支再整体合入集成线。因此一个仓库可以同时容纳多个 PRD，各有各的积累分支。

分支按 PRD 的 issue 编号命名，所以同一个 PRD 在它触及的每个仓库里都用同一个分支名：

```text
prd/<issue 编号>
```

需要不同名字的 PRD 在自己的正文里声明：

```markdown
## Baseline Branch

- Baseline Ref: prd/27
```

只有自身没有声明执行引用的切片才继承 PRD 的基线分支。显式的 `## Base Version` 声明永远优先——它是针对这一件事的表态。继承来的分支既是切片的起点，也是切片的合入目标：base 与 target 是同一条分支；功能性的 `Source Ref` 随工作走，与基线无关。

继承可以跨仓库。切片的 PRD 父项往往在另一个仓库，而两条分支在各自仓库里同名，所以继承只需要携带 PRD 的 issue 编号。

基线分支若尚不存在，在准备仓库时从远端默认分支切出——那是这项 PRD 工作的起点。手工声明的 base 分支则要求已经存在，缺失即报错，不新建分支。PRD 父项读不到时，在「这个答案决定工作跑在哪」的场合报错：悄悄用集成线会把切片放到基线模型明令禁止的位置。在「只回答已发布内容」的场合（变更请求合到了哪个分支）则忽略读不到的父项——一次临时读失败不该为一个已经存在的变更拦住人。

`afk backlog baseline --id <prd>` 报告 PRD 积累在哪个分支、哪些切片在继承它；`--branch <name>` 把分支写进 PRD 正文。`afk schedule` 的报告里也会给出基线分支。

### 仓库仲裁与调度

受管执行在实现与 QA 全程持有 manifest 所有仓库的租约；独立准备申请同样的租约，嵌套阶段借用外层租约。仓库键排序、去重后申请，失败时释放部分申请，并在条目认领前拒绝争用。心跳和代次 ID 复用 `FilesystemClaimLock`；过期代次不能续约，也不能释放后继租约。只有已过期且确认本机 owner 死亡的租约才能恢复，未知或远端 owner 继续受保护。

中断将条目转为 `blocked + hitl` 并失效认领；心跳失败或发现中断时停止所属 Agent，阻止发布。终结清理先关闭执行，再释放工作区资源；失败 QA 保留验证工作树。受管的本地 Claude tmux 会话在启动前登记仓库认领代次，并在 tmux 中保存相同的所有权标记；owner 死亡后的恢复必须核对标记才可停止孤儿会话。会话名被复用、归属不明或非 tmux transport 的情况保留现场，由操作者显式恢复。不会仅凭进程名称相似就终止进程。

代次校验保护 AFK 管理的生命周期操作。Agent 仍直接写文件；安全接管依赖于确认 owner 死亡及终止已登记资源，未知的外部写入者需要操作者恢复。

Scheduler 读取凭证可见的完整清单，拒绝依赖环，复用 provider 的可执行性规则。默认并发为 `min(仓库数, max(2, floor(可用核数 / 3)))`，至少为一；重叠的多仓 manifest 串行，无交集仓库并行。一分钟负载超过阈值时停止新派发。依赖只在 `done` 后解锁，`merge_ready` 等待人工合并与 reconcile；返工次数受 `maxQaReworkAttempts` 限制。调度不会自动接管未托管 issue，也不改写依赖标签。

### 恢复策略

当身份、manifest、claim 或验证证据缺失或无效时，执行必须 fail closed。恢复和 reconcile 应基于已有工作项身份及记录状态；reconcile 不能代替创建新的执行 manifest。若 Agent 无响应或验证无法运行，系统应保留证据并暴露可恢复状态，而不是将任务误判为完成。

验证分支是上一轮发布变更请求时用的那条分支。它还在时，验证会复用那个变更请求并刷新它的证据，而不是因为无法再建一条同名分支而失败——反正合入基线会把这条分支重写。实现分支刻意不同：已存在的分支可能存着没推送的工作，所以为它建工作树会被拒绝而不是复用。准备失败时会把共享锁还回去，下一轮才能触达真正的失败原因，而不是撞上「重复准备」。

## 相关文档

- [全流程执行与 E2E 验证架构](full-workflow-e2e-architecture.md)
- [可观测性与证据](observability.md)
- [架构决策记录](../adr/README.md)
