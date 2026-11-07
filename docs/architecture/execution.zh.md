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
- `afk execute --work-item-id <id>`：执行受管生命周期，包括资格与 manifest 校验、实现、独立 QA、变更请求处理，以及由人控制的合并闸门。`--agent <name>`、`--sandbox <name>` 和 `--execution-mode <batch|interactive>` 显式选择本次运行的 Provider 和模式；模板仍可为单个步骤单独选择 Provider。
- `afk experience list --scope <platform:projectKey> [--status <candidate|verified|revoked>] [--limit <0..100>] [--json]`：查看项目经验；`recall --scope <scope> --query <text> [--json]` 只返回相关、已验证且未过期的经验。
- `afk experience record --scope <scope> --trigger <text> --root-cause <text> --action <text> --run-id <id> --work-item-id <id> --evidence <refs...>`：保存候选经验。`verify <id> --scope <scope> --run-id <id> --action <text> --evidence <refs...> [--root <事件存储>] [--root-cause <text>]` 要求同项目、审计完整、独立 QA 通过，随后成功结束或已确认发布并抵达对应人工合并闸门。`revoke <id> --scope <scope>` 撤销经验，后续检索不再提供它。
- `afk loop start`：针对一个绑定 manifest 的工作项持续尝试，并委托给同一受管执行路径；它不是全局多工作项调度器。
- `afk qa`：对 `verification` 条目重试验证，存在受管 manifest 时自动使用，也可通过 `--execution-manifest <path>` 指定。
- `afk plugin install <source>`：在暂存目录安装可信本地目录或 npm package spec，校验 `plugin.json` 的 manifest/entry，记录入口摘要并启用；普通升级失败保留旧安装，禁用 npm lifecycle scripts，包需要自带构建后的入口。
- `afk plugin configure <id> --file <path> [--builtin] [--action <name>]`：保存 JSON 配置对象；已安装插件按 manifest schema 校验，`--builtin` 校验并构造已知的配置化 Provider。`--action` 写入插件条目的顶层 trigger action，省略时保留已有 action。
- `afk plugin auth login google --client <path>`：将浏览器 OAuth 和 loopback 回调委托给 `GoogleOAuthCredentialProvider`，读取 Google Desktop app 客户端 JSON，无需输入邮箱。SIGINT/SIGTERM 取消认证并关闭回调服务器。登录成功后以 `{}` 配置 builtin `credential.google-oauth`，仅在缺失时以 `{}` 添加 builtin `notification.gmail`，保留已有 Gmail 配置；默认收件人为授权账号自身，登录不发送邮件。见 [Gmail OAuth 配置](plugins.zh.md#gmail-oauth)。
- `afk plugin auth status google`：仅输出本地 Keychain 记录状态（`connected`，以及可选的 `email`、`expiresAt`），不需要客户端文件，不输出令牌，不检查 Google 会话或令牌有效性。
- `afk plugin auth logout google`：Google 撤销授权成功后才删除 Keychain 记录，撤销失败保留记录供重试；不需要客户端文件，保留插件配置和启用状态；SIGINT/SIGTERM 取消操作。这三个认证命令的 Provider 仅接受 `google`。凭据使用 macOS/Linux Keychain；Windows 不支持，也不会将令牌保存到文件。
- `afk plugin enable <id>` / `afk plugin disable <id>`：修改下次构造 Runtime 时的启用状态，不热更新正在执行的 Worker。
- `afk plugin remove <id>`：禁用并删除已安装包，保留配置。
- `afk plugin invoke <capability> <provider> <operation> --input <path> [--json]`：派发 43 项显式白名单操作之一，校验 JSON 输入和输出；无论是否带 `--json` 都输出 JSON。验证/策略/投递否定结果或远程非零 code 使 exit status 为 `1`；不开放凭据读取或 merge。CLI 验证输入必须显式提供 `target`。
- `afk plugin listen --token-env <name> [--host <address>] [--port <number>]`：激活配置 trigger，保持认证 HTTP 宿主和 Runtime 常驻，SIGINT/SIGTERM 后关闭并 dispose；默认 `127.0.0.1:8374`，环境 token 必需且至少 16 字符、无 CR/LF。启动拒绝 error diagnostic，未注册的 action 会 dispose 对应 trigger；普通 Runtime 构造不启动 timer。见[能力插件架构](plugins.zh.md)。
- `afk plugin serve-container --repository <path> --workspace-root <path> --sandbox <provider> --agent <providers...> --token-env <name> [--host <address>] [--port <number>] [--allow-remote]`：显式通过共享 registry 提供 remote-container sandbox/agent 操作；五个未加方括号的 flag 全部必需，workspace root 必须已存在并限定执行 worktree，Agent 使用显式白名单，环境 token 至少 32 bytes。默认 `127.0.0.1:8375`，非 loopback 绑定/客户端需 `--allow-remote`；SIGINT/SIGTERM 后关闭服务并 dispose Runtime。后端组合与信任边界见[能力插件架构](plugins.zh.md)。
- `afk plugin list [--json]`：列出已加载插件、声明能力与已注册 Provider 名称，不等于列出磁盘上的全部安装包。
- `afk plugin doctor [--plugin <id>] [--json]`：检查 health 与 diagnostics，包括加载/配置错误；不健康 Provider 或 error 诊断返回失败，可选插件加载失败不阻止 Core 命令处理。API v1、Provider 矩阵及组合根/操作派发接入状态见[能力插件架构](plugins.zh.md)。
- `afk backlog baseline --id <prd>`：报告 PRD 积累切片的分支以及继承它的切片；`--branch <name>` 把分支写进 PRD 正文。
- `afk backlog rework revise --id <backlog> --record <r2> --summary "<事实陈述>"`：把一条 open 返工记录修订成当前事实；记录保留自己的 id 与证据，只有陈述被替换，修订轨迹留在记录里。
- `afk schedule --parent <规范身份>`：跨项目调度父项的可执行后代，重叠仓库集合串行，遵循依赖与人工合并闸门。`--max-concurrent`、`--load-limit`、`--poll-interval` 控制派发；poll 间隔即重评估节奏——有执行在跑时仍会按间隔重新看一眼，一旦有空出的槽位和可派发的条目就立刻补派。`--watch` 让调度持续运行直到被停止，等待外部状态变化；`--dry-run` 在不认领、不启动 Agent 的情况下预览批次，`--json` 输出最终报告。报告里每条等待项都会写明卡住它的约束——依赖未就绪、容量已满、仓库租约被占、系统过载、等待人工、或重试预算耗尽。预览的后续批次以前序人工合并及 reconcile 完成为前提。清单读失败不会让调度退出：它会退避重试，并说明「调度器还活着，但看不到工作项」。SIGINT/SIGTERM 停止新派发并等待在途执行结束。
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

### 返工轮次的预算

QA 失败会把条目打回返工，`maxQaReworkAttempts` 限制的是**在没人介入之前** AFK 最多还能再试几次。这个预算属于一个**返工轮次**（cycle）—— 一轮「改完再验」—— 而不属于条目的一生。

轮次只由人工介入打开，其它任何东西都打不开。`afk backlog retry` 会创建一条 operator 返工记录：操作者已经回答了结束上一轮的那次失败，并声明有什么变了，因此下一轮以完整预算开始。QA 失败和合并冲突都不打开轮次 —— 它们是当前这一轮里的又一次尝试，花费的是这一轮的预算，所以同一轮的自动重试共享同一份预算。

每条返工记录都带上它所属的轮次和它在轮次内花费的尝试次数（`cycle`、`attempt`），句柄是 `r<cycle>-<attempt>`。新记录的尝试次数只从**当前这一轮**的记录推导；更早轮次的记录仍留在 issue 里作为可审计的历史，但不再花费后续轮次的预算。轮次概念出现之前写入的记录按第 1 轮读取并保留它自己的尝试次数，因此已经花光预算的条目在操作者打开下一轮之前仍然处于超限状态。

当一轮的预算耗尽时，条目被阻塞，原因里写明这是第几轮、这一轮用了几次：`QA rework attempt limit reached (cycle 2, 3/3 attempts used): …`。见 [ADR-0028](../adr/0028-rework-attempt-budget-per-cycle.md)。

### 返工记录可以修订

返工记录陈述的是「这一轮失败时哪里不对」，而它会被下一轮 agent 当作这一轮的上下文读回来。事实会过期：它等的依赖已经产出、它抱怨的分支已经动过。AFK 能创建记录、也能用下一轮把它 supersede 掉，但**不能修订**它 —— 于是被冻结的陈述会被当成当前事实读。

`afk backlog rework revise --id <backlog> --record <r2> --summary "<事实陈述>" [--reason "<为什么修订>"]` 修订一条 open 记录。修订是**原地写入**的：记录保留自己的 id、轮次、尝试次数和评论，所以告诉 agent 的是同一轮；而修订不会花费当前轮次的返工预算 —— 开一条新世代的记录才会。

只修订陈述。记录携带的证据（失败的验收标准、必须跑的检查）是验证当时真正观察到的东西，修订既不改写它也不让它消失：修订说的是「今天这仍然成立」，不是「这从来没成立过」。

修订是**事实，不是指令**。记录会被 agent 读，所以把分支写成 push 目的地（`发布到 prd/27`、`把 prd/27 合进当前分支`）、带上会移动分支的 git 命令、或带上会合并和重跑的命令的修订，在到达 provider 之前就被拒绝。修订在记录里留下自己的轨迹（什么时候写的、谁写的、改之前是什么），所以修订从来不是静默覆盖。见 [ADR-0035](../adr/0035-rework-records-are-revisable.md)。

### 调度器按「它需要的范围」判完整

调度器读的是整个平台，而且必须读整个平台：一条 PRD 的切片就住在工作要碰的那些仓里。凭据能碰到的项目远多于任何一条 PRD —— 驱动 PRD #27 的那台机器上能看见 46 个 GitLab 项目，而这条 PRD 的切片住在其中 7 个里。

调度器里有两个范围，过去被当成同一个：调度**要判断**的是父 PRD 的子树和子树等待的东西；**读取**覆盖的是凭据能碰到的每个项目。完整性判定用的是平台级那个 ——「一条诊断都没有」—— 于是四十六个项目里有一个读不到，整个平台就「不完整」，调度器退避、什么都不派发，而且看起来活得很好。

现在，范围就是这次判断依赖的东西：父 PRD、它的（传递的）子项、以及这些子项（传递地）等待的东西。它由 AFK 自己写下的那些关系推导出来，而且跨仓。

**读不到的依赖仍然指着自己的项目。** work item 的规范身份带着它的项目键，所以一个等待某个读不到的仓的切片，仍然告诉 AFK 是哪个仓重要。即便那个仓的条目一个都没读到，它仍然在范围内。没有这条规则，数据里的空洞就会被当成「那里本来就没有东西」的证据，于是切片会建立在一个并不存在的世界视图上被派发。

- **范围外**：项目被点名 —— 日志里、状态里、最终报告里都有 —— 而调度继续。失败只是它所关于的那个东西的失败。
- **范围内**：依赖那个读不到项目的切片在等待，原因是 `visibility_unknown`，而树里的其余部分照常派发。一个坏掉的仓不会让整条 PRD 瘫痪；它只瘫痪需要它的那些切片。
- **项目清单读取失败**一律算在范围内：AFK 连候选项目都没枚举出来，就无法证明任何项目在范围之外。
- **不可重试的失败**（`retryable: false` —— 比如仓被删了）会被升级，而不是无限重试：日志以 error 级别说「需要人介入」，受影响的切片以 `awaiting_human` 等待。调度器不把这件事写回 provider；升级是一次可见的报告。连接被掐断是暂时失败，就按暂时失败读：一次网络抖动不会被丢给人。

父 PRD 是范围的锚。持有它的仓读不到时，调度器对这条 PRD 一无所知，所以这次读取对这条调度来说**失败了**：它退避重试，而不是死掉。**项目清单**读不到也是同一个答案 —— 父项是未知，不是缺失。父项缺失、同时没有任何项目失败，是另一个答案 —— 这条 PRD 不存在 —— 它被当成错误报出来。

保证没有削弱：AFK 不会在自己看不见状态的工作上排期。变的是完整性被衡量的那个范围。见 [ADR-0036](../adr/0036-schedule-scope.md)。

### 发布边界

agent 拿到的仓库里有好几个分支，AFK 会告诉它该在哪个分支上干活。但这从来不够，因为同一条指令里还写着变更请求要合入的那个分支—— 把「发布到 `prd/27`」读成「push 到 `prd/27`」的 agent，会用自己的提交把 PRD 基线往前推。变更请求因此没有东西可合，GitLab 判定它无法合并，AFK 的回应却是把条目打回返工 —— 而返工会再推一次基线。

**目标分支属于 AFK 的变更请求。** agent 只拥有**工作分支**，别的一概没有：它在那里提交、也只在那里 push。**基线分支**、**目标分支**和**功能源分支**只读，不 push。

这条规则写在每个 agent 都会读到的地方 —— completion protocol，两种传输方式、每个阶段都读 —— 并且在 `Execution repositories:` 段里带着分支名再说一遍，这样 agent 不必去推断四个名字里哪个能动。两段文字都来自 `packages/runtime/src/domain/branches/publish-boundary.ts` 的 `describePublishBoundary()`。

规则在事后也会被执行，因为指令不是机制。`ChangeMergeState` 在 `mergeable`、`conflict`、`unknown` 之外多出第四个取值：

- `mergeable` —— 变更请求可以落地。
- `conflict` —— 内容冲突：目标分支改了同样的行。
- `baseline_advanced` —— 目标分支已经带着这次变更，所以没有东西可合。基线动了，内容并没有冲突。
- `unknown` —— 平台还没给出结论，或者给出的原因不是冲突。

GitLab 把「真冲突」和「没有东西可合」都报成 `cannot_be_merged`；区分它们的是 diff —— diff 为空意味着两个分支的 merge base 就是源分支的头提交。GitHub 把同样的情形报成 `mergeable_state: behind`。

`decideMergeVerdict()` 把结论转成动作，三个答案的差别是刻意的：

| 结论 | 动作 | 原因 |
|---|---|---|
| `mergeable` | 接受 | 交给人合并 |
| `conflict` | 返工 | 内容不一致，再来一轮能修好 |
| `baseline_advanced` | **上报** | 活儿已经在基线里了，再来一轮只会再推一次基线 |

被上报的条目会被阻塞并置为 `executionMode=hitl`，失败码是 `baseline_advanced`。它绝不会被打回返工 —— 返工的答案就是造成这一切的那次 push。见 [ADR-0031](../adr/0031-publish-boundary.md)。

### provider 与它的运行时

AFK 跑一个 agent 需要两件事：**用哪个** agent，和**怎么**跑。第二件就是*运行时* —— 对 Codex 来说是模型 provider、profile、传输方式和端点。

这两件事原本走两条互不相干的通道，而工作流的步骤可以只改第一件。请求跑 Claude Code、步骤跑 Codex 时，步骤继承的是 Claude Code 的运行时 —— 也就是根本没有运行时 —— 于是所有 Codex 专属设置被静默丢弃。Codex 不会报错：它读自己的宿主配置，连到了宿主的默认 provider 上。agent 照常启动、照常连上，却在第一轮就因为一个没人选过的端点而失败。

**provider 与跑它的运行时是一个决定。** 工作流引擎在**每个步骤**上绑定运行时，位置就在步骤的 provider 已知之后，通过 `packages/runtime/src/domain/agents/runtime-binding.ts` 的 `resolveRuntimeForProvider()` 完成：

- Codex 的运行时只会被 Codex 复用；
- 非 Codex 的 provider 解析出「没有运行时」，与此前完全一致；
- 请求里没有 Codex 运行时、而步骤要跑 Codex 时，从 AFK 的配置里解析出一个，于是运维配的 `agents.codex.*` 真正生效。

在运行期解析出来的运行时，会在 agent 启动前先做一次探测，这样模型不可达时给出的是探测自己的诊断，而不是来自错误端点的传输错误。探测要花一次真实的模型往返，所以每个 provider 每次运行只探一次。见 [ADR-0032](../adr/0032-provider-and-runtime-are-one-decision.md)。

验证分支也是同样的绑定方式。QA 复核 agent 的 provider 与运行时是一起解析出来的：自己解析 provider 的复核 agent 会一并解析属于它的运行时；调用方已经探过的运行时直接复用 —— 复核 agent 不会对同一个运行时探测第二次。

### agent TUI 里的模态框

AFK 驱动的是它并不拥有的交互式 TUI，而那个 TUI 会弹自己的模态框。Codex 会问「这个目录可不可信」—— 而 AFK 的验证步骤跑在**工作树**里，那个路径永远不在 Codex 的信任列表里，所以每个新工作树都会弹一次。

模态框会抢走键盘：提交 goal 的 Enter 被它吃掉，而「信任这个文件夹」这个问题答完后 Codex 还会重启，于是 goal 回到输入框里，**没有路径能到达 agent**。AFK 本来就会发现输入框里还留着 goal 并再按一次 Enter；现在这个预算从「按几次」改成「一段时间」（30 秒），因为它必须覆盖那次重启。

AFK 会说出自己正在回答的是哪个模态框并记进日志，于是「goal 已发出」与「goal 从未到达」之间的空档在运行日志里看得见，而不只是藏在 tmux 的滚动缓冲里。见 [ADR-0033](../adr/0033-agent-tui-modals.md)。

AFK 到达时**已经弹着**的模态框同样会被回答。模态框遮住了输入框，placeholder 就不见了，输入框于是永远看起来「还没准备好」；AFK 那时会把整个超时等完，然后把 goal **打进模态框里**，跟模态框一起丢掉。现在 AFK 会在面板里认出模态框，按 Enter 回答它，然后等输入框回来。

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

Scheduler 读取凭证可见的完整清单，拒绝依赖环，复用 provider 的可执行性规则。默认并发为 `min(仓库数, max(2, floor(可用核数 / 3)))`，至少为一；重叠的多仓 manifest 串行，无交集仓库并行。一分钟负载超过阈值时停止新派发。依赖只在 `done` 后解锁，`merge_ready` 等待人工合并与 reconcile；返工次数按返工轮次受 `maxQaReworkAttempts` 限制，因此一次人工重试会给条目一份新的预算。调度不会自动接管未托管 issue，也不改写依赖标签。

派发循环由两件事唤醒：有执行结束，以及 poll 间隔到期。定时器正是空闲容量还能被用上的原因——容量 4、只有 1 条在跑时，另外 3 个槽位必须在对应条目变得可派发时就补上，而不是等在跑那条结束；空着的槽位就是浪费的运力，浪费的运力就是晚交付的 PRD。循环一旦有理由重新评估就立刻取消该定时器，它不会吊住进程。不带 `--watch` 时调度是一次性的：当前这一波能派的全派完就结束；带 `--watch` 时它一直运行到被停止，因为帮助文本承诺它会持续等待依赖合并与人工重试。等待报告会给每条没被派发的条目写明真正卡住它的约束，操作者因此能一眼分清「容量满了」和「依赖没就绪」，而不是两者都只看到一句「等待」。

暂时失败不等于永久失败。清单读失败不会让调度退出：它记下失败次数，等一段退避——从一个 poll 间隔起步，逐次翻倍，上限五分钟——然后重试；计数器会被第一次成功的读取清零。失败从不静默：运行日志里带着诊断、失败次数和下一次尝试的间隔，命令行也会说清「调度器还活着，但看不到工作项」。一个活着但失明的调度器，不能长得像一个没事可做的调度器。见 [ADR-0034](../adr/0034-transient-failure-is-not-permanent-failure.md)。

### 恢复策略

当身份、manifest、claim 或验证证据缺失或无效时，执行必须 fail closed。恢复和 reconcile 应基于已有工作项身份及记录状态；reconcile 不能代替创建新的执行 manifest。若 Agent 无响应或验证无法运行，系统应保留证据并暴露可恢复状态，而不是将任务误判为完成。

验证分支是上一轮发布变更请求时用的那条分支。它还在时，验证会复用那个变更请求并刷新它的证据，而不是因为无法再建一条同名分支而失败——反正合入基线会把这条分支重写。实现分支刻意不同：已存在的分支可能存着没推送的工作，所以为它建工作树会被拒绝而不是复用。准备失败时会把共享锁还回去，下一轮才能触达真正的失败原因，而不是撞上「重复准备」。

**工作树上的占用权属于取走它的那次尝试。** 那道防止两次并发尝试共用同一条可写分支的锁，在尝试结束时释放——无论这次尝试是删掉了工作树，还是把它当作失败证据留下。验证失败会保留工作树，这是关于文件的决定，不是关于占用权的决定：活得比尝试更久的占用权，会让同一进程里该条目之后的每一次验证都被以「重复准备」拒绝，而不是暴露真正失败的原因。接管残留工作树的过程是确定的——路径上无论站着什么（这条分支的登记、别的分支的登记、或上一轮留下的文件），都会在重新检出该分支之前被释放。某个路径是不是工作树，由仓库自己回答（`git worktree list --porcelain`），路径比较时把软链接解析掉，因为那才是 Git 记录下来的形态：本地化 Git 会用母语说「不是一个工作区」，而 AFK 不解析 Git 的句子。见 [ADR-0029](../adr/0029-worktree-claim-lifetime.md)。

**AFK 自己的工作树对用户仓库不可见。** 工作树就放在检出目录里，Git 会把它们当成用户的未提交改动、并当成子模块指针暂存进去——变更请求里就带上了谁也克隆不下来的子模块。检出目录本地的忽略文件让它们退出仓库的视野；发布变更的那个提交会把它们取消暂存，若上一轮已经把它们跟踪了则从索引里移除——用取消暂存而不是在 add 的 pathspec 里点名，因为 Git 拒绝添加被忽略的路径，而这条规则恰恰把那个路径变成了被忽略的；准备阶段读状态时也把它们滤掉，和对 `.afk/` 的处理一致。见 [ADR-0030](../adr/0030-afk-worktrees-are-invisible.md)。

## 相关文档

- [全流程执行与 E2E 验证架构](full-workflow-e2e-architecture.md)
- [可观测性与证据](observability.md)
- [架构决策记录](../adr/README.md)
