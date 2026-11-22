# W10 agent.codex 本机资格验收

本次使用 AFK 0.2.148、codex-cli 0.169.0 和 macOS arm64。验收入口为安装包的 `prepareAgentRuntime`、`WorkflowRunner` 和 `QARunner.process`。内建 Codex provider 启动 PATH 上的真实 `codex`。工单状态、分支及变更请求由本地适配器承接。QA 读取已提交产物的独立 Git worktree。每个场景使用新的临时主目录、线程目录和项目。

## 复跑

从仓库根目录执行。设置 `RELEASE` 为含 `release.json` 和 `node_modules/@afk/runtime` 的已安装目录。运行环境需要 Git、Python 3.11+、Node 22+ 和已配置的 Codex Responses API provider。启动器支持该 provider 的 `env_key` 或 `experimental_bearer_token`。认证值只通过进程环境传递。场景使用真实模型配额。

```sh
umask 077
out=$(mktemp -d)
for scenario in exec app-server qa failure cancel; do
  python3 tests/qualification/w10/agent-codex.py "$RELEASE" "$out/$scenario.json" "$scenario" || exit 1
done
```

每次使用新的收据文件名。Python 的退出状态和 JSON 的 `passed` 共同反映该用例断言。负向用例通过表示预定边界被观测到。保留失败收据后可单独复跑。原始模型输出及线程内容随临时目录删除。

| 用例 | 验收依据 |
| --- | --- |
| `exec`、`app-server` | 宿主独立计算随机输入之和，核对 `total.txt`、产品成功、`verification`、原生线程 ID 和正数用量。产品总用量必须等于对应线程最后一次有效的原生累计用量。 |
| `qa` | 先经 `app-server` 实现，再由 `QARunner` 启动第二个 Codex 线程。核对两个不同的线程、QA 成功、同工单持久事件 `qa.passed` 和 `merge_ready`。发布适配器只在进程内返回本地变更标识。 |
| `failure` | readiness 成功后撤去子进程的测试认证，检查有会话标识、产品报告 `agent_process_failed`、工单 `blocked`、无产物、未入 QA，并记录实际运行终态。该分类仅能定位至 agent 进程。 |
| `cancel` | 原生任务创建 `started` 后才发 abort，核对拒绝原因、终态事件、`blocked` 和未入 QA。任务计划在 12 秒后创建 `late`，产品退出后再观察 13 秒。 |

首次探测的配置目录与用量采集路径不同，后续已统一至临时 `HOME/.codex`。一次 `exec` 生成文件后工单仍被阻塞，另一次成功执行的产品和原生用量不同。`cancel` 实测运行终态为 `failed`，分类为 `workflow_crash`。收据中的 `passed` 仅覆盖上表断言。

0.2.150 的 macOS arm64 安装包已在新临时项目重跑 `exec`。工单进入 `verification`，计算结果正确，同一原生线程和产品均记录 70,560 tokens。

0.2.151 的安装回归从工单的持久审计读取事件，并校验审计链。`cancel` 要求恰好一个 `cancelled` 终态、`user_cancelled` 原因码和调用方原因原文。`failure` 要求恰好一个 `failed` 终态并保留 `agent_process_failed` 根因。两个场景都要求工单进入 `blocked` 且无 `qa.started`。正常 `qa` 场景继续验证独立原生线程、`qa.passed` 和 `merge_ready`。
父工作树以 macOS arm64 安装包 `0.2.152` 重跑了 `cancel`、`failure` 和 `qa`。取消后只有一个 `cancelled/user_cancelled` 终态，原因为调用方传入的消息，随后 13 秒未出现延迟写入。撤去认证时终态为 `failed/agent_process_failed`。两个工单均停在 `blocked`。正常任务由独立 Codex 会话记录 `qa.passed`，工单进入 `merge_ready`。

`0.2.156` 安装包与 codex-cli `0.169.0` 再次通过上述三个场景的持久审计校验。`cancel` 观察 13 秒无延迟写入，`failure` 保留 `agent_process_failed`，两个工单各有一条终态并进入 `blocked`。`qa` 匹配独立的原生线程并进入 `merge_ready`。会话恢复前后的身份和预算另行验收。

### 0.2.156 的 Codex 恢复边界

沿用上述隔离启动器，`release` 指向含 `release.json` 的安装目录，收据路径须为新文件。

```sh
python3 tests/qualification/w10/agent-codex.py "$release" "$evidence/resume.json" resume
```

| 检查 | macOS arm64、Codex CLI 0.169.0 的实测 |
| --- | --- |
| 首轮身份与预算 | 正常 `WorkflowRunner` 通过 app-server 完成算术任务。持久审计的会话 ID 匹配原生线程文件，同一 ID 在工单预算表中记录 70,534 tokens，与原生累计用量相等。 |
| 工作流恢复门控 | 对实际 provider 调用运行器的 `attemptNativeResume`，直接返回 `undefined`。快照存储和启动回调都未调用。显式恢复守卫提示 Codex 不支持恢复，建议使用 Markdown 交接。`--session` 是运行器会话名。 |
| 同工单重入 | 复用运行器会话名，将上限设为首轮实际用量。第二次运行产生独立审计，终态 `failed/budget_exhausted`，工单 `blocked`，新增原生线程数为零，预算仍为 70,534。 |
| 显式恢复请求 | 使用首轮真实线程 ID 构造合成快照。exec 拒绝 `createExecution({resume})`。相同工作目录下的 app-server 接受相同快照并完成一轮，原生元数据确认线程 ID 已变。该线程的产品和原生用量均为 17,103。直接调用 provider 位于工作流预算记账之外。执行对象的 `resume()` 也明确拒绝。 |

`resume` 用例要求未声明恢复能力的 provider 在启动前拒绝显式请求。0.2.156 在最后一项以 `passed:false`、退出码 1 记录缺口。正常工作流通过能力门控，表现为跳过原生恢复。显式 `createExecution({resume})` 仅用于复现底层调用者遇到的不一致。实测覆盖的是首轮、恢复请求及预算重入，原生续跑后的用量增量仍待产品支持后验证。

`0.2.157` 已在源码外安装验证。本地和远程沙箱的 exec、app-server 四种组合均在分派前拒绝显式快照。真实账户重跑时首轮触发 `agent_completion_timeout`，停在预算重入和恢复断言之前。

### 0.2.163 本地原生恢复与预算验收

工作树安装依赖后，用真实 `codex` 和临时 HOME 运行。收据文件应使用新名称。

```sh
pnpm --filter afk... build
mkdir -p .afk
python3 tests/qualification/w10/agent-codex-resume-loopback.py .afk/resume-proof.json
```

驱动从本树的构建产物进入 `WorkflowRunner`。模型响应由回环 HTTP 服务提供，工单、分支和变更 provider 使用本地 fixture。Codex app-server、原生线程持久化、恢复协议、审计和预算存储均实际运行，不需要账户凭据。首次用量达到交接阈值后，下一代重新启动 app-server 并恢复同一线程。验收核对两条审计的增量为 12、17，原生文件与预算表均累计 29，一次交接后工单进入 `verification`。以 29 为上限再次进入该工单时，必须记录 `budget_exhausted`、进入 `blocked`、预算保持 29，且新增线程数为零。

2026-11-20 在集成提交 `e7c9115a`（CLI 0.2.166）复跑。Codex CLI 0.169.0 使用一个原生线程完成两轮，增量分别为 12、17，预算表累计 29。再次进入同一工单时返回 `budget_exhausted`，新增线程数为零。三个相关文件的测试共 104 项通过。

同一提交的 macOS arm64 归档 SHA-256 为 `02bb3dd673d3aca95699b4bbfc4984180b76a355ed4ca62ff2a67a5babafe678`。仓库外安装验证了 23 个命令入口。安装版工作流模板 12 项通过，源码 Desktop 与安装版 CLI 竞争和恢复 1 项通过。`tests/qualification/cli-upgrade.sh` 验证了 0.2.165 升级到 0.2.166、错误校验和拒绝、回滚至原版本和插件配置字节一致。

### 0.2.174 安装版真实账户恢复

2026-11-20，使用校验通过的 macOS arm64 安装包（SHA-256 `6b16bc0ff253f18cb68fce2614cbf5d3f2f9f1a0fb5d68e5799520828aee3475`）与 Codex CLI 0.169.0 复跑 `agent-codex.py` 的 `resume` 用例，通过 1/1。安装版运行器完成合成算术工单，预算表与原生线程均为 70,795 tokens。以该用量为上限重新进入同一工单时，工作流返回 `budget_exhausted`，新增线程为零，账本数值一致。

同一次验收独立调用本地 app-server 执行对象恢复其快照，两轮保持同一原生线程。产品记录的两轮增量为 17,157 和 17,212 tokens，与原生记录的累计 34,369 tokens 一致。

### 0.2.176 安装版真实账户自动交接

2026-11-20 通过仓库外安装的 macOS arm64 CLI 与 Codex CLI 0.169.0 执行 `workflow-handoff`。合成工单的第一轮创建随机标记并跨过上下文门槛，续跑后验证标记并进入 `verification`。安装版审计记录两段用量 53,070 和 73,986，唯一新增的原生线程与工单账本均累计 127,056 tokens，账本记录一次交接。同工单以该用量为上限重入，审计返回 `budget_exhausted`，原生记录的文件列表和内容均保持一致。Tracker、Git 和任务输入均为隔离测试数据。

首次只依赖对话历史的探测在同一原生线程记录两段用量，但工单停在 `blocked`。改用可独立核对的文件标记后通过。源码构建的回环对照也通过。真实交互模式的取消与清理仍单独验收。

```sh
python3 -B tests/qualification/w10/agent-codex.py "$RELEASE" "$out/workflow-handoff.json" workflow-handoff
```

[安装版验收回执](agent-codex-workflow-handoff.receipt.json)

### 0.2.177 安装版真实账户交互取消

2026-11-20，macOS arm64 安装版通过真实 Codex CLI 0.169.0 执行合成工单。用例确认任务已经写入启动标记后才取消。持久审计链有效，恰好有一个 `cancelled/user_cancelled` 终态，原因与调用方一致。工单停在 `blocked`，未进入 QA。取消后的 13 秒内没有迟到写入。运行创建的 tmux 会话已消失，旁路会话仍在，活跃资源记录归零。

0.2.176 对照在取消后仍写出迟到标记。0.2.177 首轮在 240 秒的启动器时限内未完成，带阶段标记的复跑退出 0。回归另检查了脱离 pane 进程组但仍在其进程树中的子进程，以及共享窗口和同名前缀会话的保留。已重新归属的进程与清理异常的可见性需单独验收。

```sh
python3 -B tests/qualification/w10/agent-codex.py "$RELEASE" "$out/interactive-cancel.json" interactive-cancel
```

[交互取消验收回执](agent-codex-interactive-cancel.receipt.json)

### 0.2.178 清理失败与重试

2026-11-20，在 QA 入口注入主沙箱和冲突处理沙箱的关闭失败。两种情况下运行均报告失败，保留工作树和租约。关闭恢复后重试，分支清理执行一次，租约释放。主沙箱场景还检查工作区在重试前保持占用，随后完成清理。取消、会话接入、QA 与仓库生命周期的四个套件共 209 项通过。

macOS arm64 安装包在源码目录外启动并通过 23 个命令入口检查。安装包 SHA-256 为 `76c2cd5b483e25332d1a21b3adc9ed1dc9aa7baf9ebe2960d709f01cb5ecea6a`。打包时 CLI 与 Runtime 源码及测试补丁的 SHA-256 为 `9442c9f199190bfc98b3f04474c500d4692954bd6f18e13e52dcdb5a8b08d0c4`。该安装包通过真实 Codex 账户交互取消复验。工单进入 `blocked`，13 秒内未出现迟到写入，活跃资源归零，无关 tmux 会话仍在。[0.2.178 回执](agent-codex-interactive-cancel-178.receipt.json)

### 0.2.179 已脱离 pane 的进程清理

2026-11-20，原生 tmux 测试在 0.2.178 复现父进程已退出、pane 已退出时的迟到写入。0.2.179 为 LocalSandbox 分配独立进程标记，正常清理与过期租约恢复均使用该标记。七个套件共 166 项通过，覆盖重新归属进程、共享窗口、同名替代会话，以及进程检查失败时保留资源记录以便重试。

macOS arm64 安装包在源码目录外通过 23 个命令入口检查和真实 Codex 账户交互取消复验。合成工单仅记录一个 `cancelled/user_cancelled` 终态，进入 `blocked`，13 秒内未出现迟到写入，活跃资源归零，无关 tmux 会话仍在。复验使用上文同一命令，`RELEASE` 指向校验后解包的 `afk` 目录。进程重新归属与替代会话由上述原生 tmux 测试覆盖。[0.2.179 回执](agent-codex-interactive-cancel-179.receipt.json)
