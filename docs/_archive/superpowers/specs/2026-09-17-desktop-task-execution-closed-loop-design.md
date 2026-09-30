# AFK Desktop 单任务执行闭环设计

**日期：** 2026-09-17  
**状态：** 已确认并实现  
**范围：** AFK Desktop、Provider Backlog 执行控制、运行状态管理、自定义工作流选择  

## 1. 背景

AFK 的任务产生与任务执行属于两个独立流程：

- 任务产生流程负责需求澄清、PRD、任务拆解以及 Provider Backlog 创建。
- 任务执行流程从一个已经存在的 Provider Backlog 开始，负责实现、验证、重做、合并和终态管理。

AFK Desktop 只关注第二部分。它不是需求管理器、PRD 编辑器或任务拆解工具，而是 Provider Backlog 的本地执行控制面。

当前桌面端已经具备 Backlog 列表、单项启动、运行投影和工作流模板编辑能力，但启动入口调用的是单阶段 `afk run`。`afk run` 在实现完成后停在 `verification`，不会继续调用独立 QA，因此不能形成完整闭环。

仓库中的 `afk loop` 已经具备实现、QA、重做和合并协调能力。最小可行方案不是在 Electron 中重新实现调度器，而是让桌面端启动一个只处理指定 Backlog 的受限 Loop。

## 2. 设计目标

### 2.1 核心目标

1. 用户在桌面端选择一个 `ready/rework + afk` Backlog 后，可以启动单任务闭环。
2. 单任务闭环覆盖实现、独立 QA、QA 重做、子任务自动合并和根任务人工合并门禁。
3. 桌面端能够准确展示 Provider 状态、运行时状态和本地进程状态，而不混淆三者。
4. 用户可以安全停止运行、处理孤儿运行、修复后重试以及确认根任务合并。
5. 自定义工作流可以作为单次任务的实现模板使用，但不能绕过独立 QA 和合并策略。
6. 删除不再需要的 `afk-pipeline` Skill 及其文档引用。

### 2.2 成功标准

一次桌面启动的任务最终必须进入以下明确终态之一：

- `done`：闭环完成。
- `merge_ready + hitl`：根任务 QA 已通过，等待用户确认合并。
- `blocked + hitl`：自动执行停止，需要人工处理。

任务不得因桌面重启、子进程退出或心跳中断而永久停留在无法解释的 `in_progress`。

## 3. 非目标

本设计不包含：

- 需求澄清、PRD 生成或任务拆解。
- Provider Backlog 批量导入。
- 全局自动领取所有 `ready` 任务。
- 在 Electron 主进程中嵌入 `LoopRunner`。
- 新增长期运行的本地 RPC daemon。
- 任意 Provider 状态修改界面。
- 工作流模板版本系统、模板快照或模板内容 hash。
- 允许模板执行任意 shell 系统动作。
- 自动绕过根任务的人工合并门禁。

## 4. 总体原则

### 4.1 Provider Backlog 是业务状态真源

Provider Backlog 持有：

- Backlog ID；
- `ready/rework/in_progress/verification/merge_ready/done/blocked` 状态；
- `afk/hitl` 执行模式；
- 父子关系与依赖关系；
- Provider 变更请求关联。

桌面端不能根据本地 PID 推导 Backlog 已经 `done`，也不能因本地运行记录缺失而直接修改 Provider 状态。

### 4.2 Runtime Record 是执行状态真源

`~/.afk/runtime/tasks` 中的 runtime record 持有：

- `runId`；
- 当前阶段；
- 运行状态；
- 心跳时间；
- Agent、分支、worktree 和诊断路径。

桌面端使用 runtime record 判断任务是正在运行还是已经 stale，但 stale 本身不会自动修改 Provider 状态。

### 4.3 Desktop Run Store 只记录进程启动信息

工作区中的 `.afk/backlog-runs.json` 只记录：

- 桌面启动记录 ID；
- Backlog ID；
- PID；
- 启动时间；
- 模板名；
- 子进程退出结果。

该文件不是生命周期状态真源。

### 4.4 Electron 只负责控制，不负责执行引擎

Electron 主进程负责：

- 参数验证；
- 启动和停止受限 CLI 子进程；
- 读取 Provider、runtime 和本地启动记录；
- 将明确的用户意图转发给 AFK CLI。

实现、QA、Git、Provider 变更和状态迁移继续由 AFK 核心处理。

## 5. 方案选择

采用桌面监督 CLI 子进程方案：

```text
AFK Desktop
    │
    ├── 查询：afk backlog list/show
    ├── 启动：afk loop --backlog-id <id> --max-iterations 1
    ├── 模板：--template <name>
    ├── 中断：意图型 backlog 操作
    ├── 重试：意图型 backlog 操作 + 新 scoped loop
    └── 合并：意图型 confirm-merge 操作
```

不采用以下方案：

- Electron 内嵌 `LoopRunner`：会形成两套运行生命周期，并扩大 Electron 主进程职责。
- 新增 daemon/RPC：单任务执行不需要额外常驻基础设施。

## 6. 单任务闭环

### 6.1 主状态流

```text
ready/rework + afk
        │ 开始执行
        ▼
scoped loop
        │
        ▼
in_progress
        │ 实现完成
        ▼
verification
        │
        ├── QA FAIL ──> rework + afk ──> scoped loop 继续处理
        │
        └── QA PASS
              │
              ├── 子任务 ──> 自动合并 ──> done
              │
              └── 根任务 ──> merge_ready + hitl
                                      │ 用户确认合并
                                      ▼
                                     done
```

### 6.2 失败流

以下情况统一进入 `blocked + hitl`：

- 工作流设置或模板校验失败；
- Agent 执行异常；
- 超时；
- claim 心跳失败；
- Git 或 Provider 操作失败；
- 用户停止运行；
- stale 运行经用户确认恢复；
- 合并状态不确定。

自动执行不得在状态不确定时静默重试。

## 7. Scoped Loop 启动

### 7.1 命令

桌面端不再使用：

```bash
afk run --backlog-id <id>
```

改为：

```bash
afk loop \
  --backlog-id <id> \
  --max-iterations 1 \
  --template <template-name>
```

`--backlog-id` 将 Loop 限制到一个 Backlog。`--max-iterations 1` 表示该 Backlog 一次成功到达 QA 终态后退出，而不是成为长期全局调度器。

QA 产生 `rework + afk` 时不计为成功完成，Loop 继续轮询同一个 Backlog，直到成功或进入人工终态。

### 7.2 前置校验

桌面端启动前读取最新 Backlog，并验证：

- 状态为 `ready` 或 `rework`；
- 执行模式为 `afk`；
- 没有同一 Backlog 的有效本地运行进程；
- 没有心跳仍然有效的 active runtime；
- 模板存在且可被 AFK CLI 加载。

最终 claim 和可运行性判断仍由 `BacklogProvider` 完成。桌面前置校验只用于快速反馈，不能替代原子 claim。

### 7.3 进程模式

桌面端继续以 detached 子进程启动 AFK CLI，并记录 PID。关闭桌面窗口不会主动终止正在运行的 scoped loop。

子进程退出只更新本地启动记录；Provider 状态和 runtime 状态仍由核心执行链决定。

## 8. 自定义工作流集成

### 8.1 模板来源

继续复用现有 TemplateLoader 规则：

1. 显式模板文件路径；
2. 项目 `.afk/workflows/<name>.yml`；
3. 用户 `~/.afk/workflows/<name>.yml`；
4. 内置模板。

桌面端继续发现并展示：

- builtin；
- project；
- managed 项目模板。

### 8.2 模板绑定

采用两级选择：

- `.afk/config.yml.template` 是工作区默认模板；
- 启动任务时可选择本次执行模板。

单次选择通过 `afk loop --template <name>` 传递，不修改工作区默认模板。

运行记录保存本次模板名，便于桌面展示和后续重试。

### 8.3 最小核心改动

`afk loop` 新增 `--template <name>` 参数，并将该值传入每次 `WorkflowRunner.run()`。

不新增模板快照、模板 hash 或版本存储。TemplateLoader 在一次 WorkflowRunner 执行开始时加载模板；运行中的步骤不会持续重新读取模板。

### 8.4 自定义模板职责

自定义模板只负责实现工作树中的执行计划，例如：

```text
分析 → 实现 → 测试 → 审查 → 修复
```

模板完成后，继续复用现有 WorkflowRunner 收尾逻辑：

```text
push implementation branch → verification → QARunner
```

因此不要求桌面为每个自定义模板自动生成隐藏的 `publish-change` 或 `queue-qa` 节点，也不允许模板自行标记 `done`。

### 8.5 “QA 节点”命名

桌面画布中当前可添加的 `qa` 模板节点，本质上仍是实现工作流里的 reviewer Agent，不是最终的独立 `QARunner`。

UI 将其显示名称调整为“审查 Agent”，避免与闭环 QA 阶段混淆。底层模板 role 可以继续使用 `reviewer`，无需新增节点类型。

### 8.6 重试时的模板选择

- 普通 QA rework：继续使用该 scoped loop 启动时选择的模板。
- 用户停止或 stale 恢复后的新运行：默认选中上一次模板，但允许用户改选。

不保证模板内容跨多次独立运行完全不变。需要严格审计模板版本时再增加快照能力，本阶段不实现。

## 9. 停止并转人工

### 9.1 用户行为

运行中的 Backlog 提供“停止并转人工”操作，不提供暂停/继续。

### 9.2 停止流程

1. 桌面向本地 scoped loop PID 发送 `SIGTERM`。
2. 等待有限时间让 Loop 执行已有清理逻辑。
3. 超时后发送 `SIGKILL`。
4. 重新读取 Provider Backlog 和 runtime。
5. 如果任务已经进入 `done`、`merge_ready`、`blocked` 或 `rework`，保持现状。
6. 如果任务仍处于 `in_progress` 或 `verification`，调用意图型 interrupt 操作，将其转为 `blocked + hitl`，原因记录为用户停止。

该流程必须幂等，以处理任务在停止期间刚好完成的竞态。

## 10. Stale 运行恢复

### 10.1 判定

满足以下条件时显示 stale：

- runtime 状态仍为 running；
- 心跳超过现有五分钟 freshness threshold；
- 本地记录的 PID 不存在或已退出。

### 10.2 处理策略

stale 只产生诊断，不自动重跑。

用户点击“标记阻塞并恢复”后：

1. 再次确认没有存活的本地进程；
2. 再次读取 runtime，防止心跳已经恢复；
3. 将仍处于 `in_progress/verification` 的 Backlog 转为 `blocked + hitl`；
4. 保留 runtime 和诊断文件；
5. 展示“修复后重试”入口。

## 11. 修复后重试

### 11.1 前置条件

仅允许：

- Provider 状态为 `blocked`；
- 执行模式为 `hitl`；
- 没有有效运行进程；
- 没有新鲜 active runtime。

### 11.2 Rework 记录

现有 Rework Record 只支持 `source: qa`。为了让停止和 stale 恢复保留结构化原因，将 source 最小扩展为：

```ts
type ReworkSource = "qa" | "operator";
```

operator rework 记录包含：

- 用户提供或系统生成的恢复说明；
- 空的 `failedCriteria`；
- 空的 `requiredChecks`。

创建记录后将 Backlog 转为 `rework + afk`，再启动新的 scoped loop。

不增加新的 Recovery 数据模型。

## 12. 根任务确认合并

### 12.1 显示条件

仅在以下条件全部满足时显示“确认合并”：

- Backlog 没有 `parentId`；
- 状态为 `merge_ready`；
- 执行模式为 `hitl`；
- 存在关联的 Provider 变更请求。

### 12.2 合并流程

确认操作必须通过 AFK 核心的意图型服务执行：

1. 重新读取 Backlog；
2. 查找该 Backlog 的关联变更请求；
3. 验证变更请求未关闭、未合并且处于可合并状态；
4. 验证目标分支与当前工作区配置一致；
5. 调用 `ChangeProvider.merge()`；
6. 确认 Provider 已报告合并；
7. 将 Backlog 转为 `done`。

任一步失败都保持 `merge_ready + hitl` 或转为 `blocked + hitl`，不得只修改标签假装合并成功。

### 12.3 命令表面

新增意图明确的命令：

```bash
afk backlog confirm-merge --id <id>
```

不新增通用 `set-state` 命令。

## 13. Intent-specific 状态操作

除 `confirm-merge` 外，桌面需要以下受限操作：

```bash
afk backlog interrupt --id <id> --reason <text>
afk backlog retry --id <id> --reason <text>
```

这些命令不是任意状态编辑器：

- `interrupt` 只接受 `in_progress/verification`，输出 `blocked + hitl`。
- `retry` 只接受 `blocked + hitl`，创建 operator rework 并输出 `rework + afk`。
- `confirm-merge` 只接受根任务的 `merge_ready + hitl`。

每个命令都应提供 JSON 输出，供 Desktop 使用统一错误协议。

## 14. Desktop IPC

在现有 typed preload 白名单中增加最小接口：

```ts
backlog: {
  start(workspace, input): Promise<BacklogRunSummary>;
  stop(workspace, backlogId): Promise<BacklogRuntimeSummary>;
  recover(workspace, backlogId): Promise<BacklogRuntimeSummary>;
  retry(workspace, input): Promise<BacklogRunSummary>;
  confirmMerge(workspace, backlogId): Promise<BacklogRuntimeSummary>;
}
```

其中：

- `start` 和 `retry` 启动 scoped loop；
- `stop` 负责本地进程停止和 interrupt；
- `recover` 只处理 stale；
- `confirmMerge` 调用核心合并门禁。

所有 IPC handler 必须：

- 校验 sender origin；
- 校验 workspace；
- 严格解析参数；
- 不接受任意命令、任意状态或任意文件路径。

## 15. Desktop UI

### 15.1 Backlog 卡片主操作

| Backlog/Runtime 状态 | 主操作 |
| --- | --- |
| `ready/rework + afk` | 开始执行 |
| scoped loop 正在运行 | 查看运行 |
| `in_progress/verification` 且进程存活 | 停止并转人工 |
| runtime stale | 标记阻塞并恢复 |
| `blocked + hitl` | 修复后重试 |
| 根任务 `merge_ready + hitl` | 确认合并 |
| `done` | 查看结果 |

卡片不同时展示多个同等级主按钮。其他操作放入详情抽屉。

### 15.2 启动确认

点击“开始执行”后显示轻量确认区域，包含：

- Backlog ID 和标题；
- 当前模板选择；
- 模板来源和步骤摘要；
- 默认 Agent；
- 启动按钮。

无需新增多步向导。

### 15.3 详情抽屉

详情抽屉展示三组信息：

1. **Provider 状态**：state、mode、依赖、变更请求。
2. **执行状态**：phase、progress、heartbeat、Agent、branch、worktree。
3. **本地进程**：PID、启动时间、退出状态和模板名。

三组信息不得合并成一个模糊的“运行中”状态。

### 15.4 工作流页面

工作流页面继续负责：

- 查看内置和项目模板；
- 编辑桌面管理的项目模板；
- 设置工作区默认模板。

工作流页面不创建 Backlog，不启动全局调度，也不展示需求阶段导航。

自定义 `qa` 节点在 UI 中显示为“审查 Agent”。

## 16. 删除 `afk-pipeline`

删除：

```text
skills/afk-pipeline/
```

同步清理：

- `README.md`；
- `README_zh.md`；
- `skills/README.md`；
- `docs/SKILLS.md`；
- `docs/SKILLS_zh.md`；
- 插件打包或 Skill 注册清单中的引用。

不删除其他需求或拆解 Skills。它们仍可独立使用，但不属于 Desktop 执行闭环。

## 17. 错误处理

### 17.1 启动失败

- CLI 不存在：不创建运行记录，返回明确安装错误。
- Backlog 不可运行：显示最新 Provider 状态。
- 模板不存在或无效：不启动进程。
- spawn 失败：运行记录标记 failed，不修改 Backlog。
- claim 失败：scoped loop 正常退出，桌面刷新 Provider 状态。

### 17.2 退出码不等于业务终态

子进程退出码只能说明本地命令是否成功退出，不能单独决定 Backlog 状态。退出后桌面必须重新查询 Provider 和 runtime。

### 17.3 桌面重启

桌面启动后读取 `.afk/backlog-runs.json`：

- PID 存活：继续显示运行中；
- PID 不存活：标记本地进程记录已退出；
- Provider/runtime 决定实际业务状态；
- stale 条件满足时提供恢复操作。

## 18. 安全边界

- Renderer 不直接执行 CLI、Git 或文件操作。
- Preload 只暴露固定 typed API。
- Electron main 不拼接 shell 字符串，只使用参数数组启动进程。
- 模板 ID 必须满足现有 kebab-case 规则。
- 模板仍由核心 Zod Schema 校验。
- System action 保持固定白名单，不支持模板内任意命令。
- 合并、interrupt 和 retry 都在执行前重新读取 Provider 状态。
- 根任务人工门禁不得由自定义模板覆盖。

## 19. 测试策略

### 19.1 核心测试

- Loop `--template` 参数透传。
- Scoped Loop 只处理指定 Backlog。
- QA rework 后继续处理同一 Backlog。
- operator rework 的序列化和解析。
- interrupt 合法和非法状态。
- retry 合法和非法状态。
- confirm-merge 的根任务、目标分支和 Provider 结果校验。
- 所有意图型命令的幂等性。

### 19.2 Desktop main-process 测试

- 启动参数必须包含 `loop`、`--backlog-id`、`--max-iterations 1` 和模板覆盖。
- 已有运行时拒绝重复启动。
- stop 的 SIGTERM、超时和 SIGKILL 路径。
- stale 恢复前重新检查 PID 和 heartbeat。
- IPC 参数和 sender 校验。
- 本地启动记录不会覆盖 Provider/runtime 状态。

### 19.3 Renderer 测试

- 不同状态只显示对应主操作。
- 启动确认可以选择模板。
- stale、blocked、merge_ready 和 done 展示正确。
- 工作流中的 QA 节点显示为“审查 Agent”。
- 键盘、焦点和 aria-label 保持可访问。

### 19.4 端到端测试

使用 fake AFK CLI 验证桌面 argv 和状态刷新。真实 Provider E2E 单独验证：

```text
ready → in_progress → verification → done
```

以及根任务：

```text
ready → in_progress → verification → merge_ready → confirm merge → done
```

## 20. 实施顺序

1. 删除 `afk-pipeline` 和文档引用。
2. 为 Loop 增加 `--template` 透传。
3. 将 Desktop 启动命令切换为 scoped loop。
4. 扩展运行记录中的模板和进程退出信息。
5. 实现 interrupt、operator rework retry 和 confirm-merge。
6. 增加 Desktop stop/recover/retry/confirmMerge IPC。
7. 调整 Backlog 操作和详情状态展示。
8. 将自定义 QA 节点文案改为“审查 Agent”。
9. 补齐核心、Electron、Renderer 和 E2E 测试。

## 21. 验收标准

1. `afk-pipeline` 不再出现在仓库 Skill、文档或发布清单中。
2. Desktop 点击开始后启动受限 `afk loop`，而不是 `afk run`。
3. 单任务可以自动经过实现和独立 QA。
4. QA FAIL 生成 rework，并由同一 scoped loop 继续处理。
5. 子任务 QA 通过后自动合并并进入 `done`。
6. 根任务 QA 通过后进入 `merge_ready + hitl`，只能由桌面确认合并后进入 `done`。
7. 用户可以停止任务并安全转入 `blocked + hitl`。
8. stale 运行不会自动重跑，用户可以显式恢复。
9. blocked 任务可以创建 operator rework 并重新启动。
10. 自定义模板可以由单次执行选择并传给 scoped loop。
11. 自定义工作流不能绕过最终 QARunner 和合并门禁。
12. Desktop 重启后能够重新组合 Provider、runtime 和本地 PID 状态。
13. 所有新增 IPC 和 CLI 操作具备严格参数校验和聚焦测试。

## 22. 明确决策

- Desktop 只负责执行和状态管理。
- 任务产生是独立流程。
- 不需要 `afk-pipeline`。
- 每次桌面执行只处理一个 Backlog。
- 使用受限 `afk loop`，不嵌入 Electron。
- 根任务保留人工合并门禁。
- stale 采用 fail-closed，不自动重跑。
- 支持“停止并转人工”，不支持暂停/继续。
- 自定义模板采用默认模板加单次覆盖。
- 本阶段不实现模板快照、hash 或版本系统。
- 不新增通用状态编辑命令。
