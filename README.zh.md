# AFK

**AFK = Away From Keyboard** — 面向工单工作项的自治开发执行平台。

AFK 连接工单平台、代码仓库与编码 Agent 运行时，将已经拆分的工作项推进到隔离实现、独立验证和人工控制的合并门禁。

[English](README.md)

## 整体架构

![AFK 中文系统架构图](assets/afk-architecture.zh.svg)

AFK 当前采用 pnpm workspace，提供两个产品入口：**CLI/TUI** 和 **AFK Control Desktop**。两个入口共享 Core、Application 和 Runtime 包。Runtime 组合工单/分支/变更 Provider、Agent Provider、Sandbox、工作流执行、QA 和本地证据存储。

架构图对应当前实际实现：

| 模块 | 职责 |
| --- | --- |
| `@afk/core` | 纯工作项与执行模型、事件、Reducer、策略和 Ports |
| `@afk/application` | 共享用例、Inventory、执行查询和观察契约 |
| `@afk/runtime` | 工作流编排、Provider 适配、Agent 执行、Sandbox、QA、会话和持久化 |
| `@afk/workflow-graph` | 工作流图 IR、投影、布局、路由和校验 |
| CLI / Desktop | 基于共享包的独立产品入口；Desktop 通过类型化 IPC 和独立 Runtime Worker 执行 |
| Skills | Agent 侧的研发工作手册与知识流程；Wiki Skill 使用独立 Python CLI |

AFK 消费已经拆分、具备验收标准和关系信息的工作项。需求规划与任务拆分属于上游流程，不属于执行引擎。工单平台是 backlog 状态的权威来源；本地 Inventory 和执行记录用于运行、审计与观察，不取代外部权威状态。

## 功能特性

- **跨平台工单与变更管理** — 通过稳定契约接入 GitHub 和 GitLab
- **CLI + TUI** — 命令行操作、交互式仪表盘、Kanban 和运行观察
- **桌面控制端** — Backlog、Work Items、执行历史、工作流视图和运行控制
- **多 Agent Runtime** — Claude Code、Codex、Cursor、OpenCode、Pi 和 GitHub Copilot 适配器
- **可组合执行环境** — Local、Docker、Podman Sandbox，结合 Git Worktree 和进程控制
- **独立 QA 与审计** — 独立验证、执行 Journal、追加式事件流和证据
- **Skills 套件** — 覆盖调研、PRD、实现、测试、QA 和工程治理的可复用工作流

## 快速开始

```bash
git clone https://github.com/easyhaloo/afk.git
cd afk
pnpm install
pnpm build
pnpm --dir apps/cli link --global
afk --version
```

详细设置请查看[快速入门指南](docs/getting-started.zh.md)。

## 安装 Claude Code 插件（可选）

AFK 提供完整的 Skill 套件，可作为 Claude Code 插件集成。

### 方式一：在 Claude Code 会话中（推荐）

```bash
/plugin install afk@afk
```

### 方式二：使用 CLI

```bash
# 添加 marketplace
claude plugin marketplace add easyhaloo/afk --scope user

# 安装插件
claude plugin install afk@afk
```

### 方式三：settings.json 配置

在 Claude Code 的 `settings.json`（全局或项目级 `.claude/settings.json`）中添加：

```json
{
  "extraKnownMarketplaces": {
    "afk": {
      "source": {
        "source": "github",
        "repo": "easyhaloo/afk"
      }
    }
  }
}
```

支持的 `source` 类型：
- `"github"` — 从 GitHub 仓库加载
- `"local"` — 从本地文件系统加载

### 方式四：软链接 Skills

将 `skills/` 目录链接到全局 skills 目录：

```bash
mkdir -p ~/.claude/skills
ln -s /path/to/afk/skills/* ~/.claude/skills/
```

### 验证安装

在 Claude Code 中运行 `/afk-grill-me` 确认 Skills 已加载。

## CLI 命令

```bash
# Backlog 管理
afk backlog show --id <id>
afk backlog list --state ready --mode afk
afk backlog create "标题" --description-file ./description.md --tag feature
afk backlog tag add --id <id> --tag bug
afk backlog tag remove --id <id> --tag bug

# 执行与自动化
afk                                  # 交互式 TUI 面板
afk kanban                           # 看板
afk execute --work-item-id github:owner/repo#123 --execution-manifest <path>
afk observe executions --work-item-id github:owner/repo#123 --json
afk run --backlog-id <id>            # 仅执行实现阶段
afk qa --backlog-id <id>             # 独立 QA
afk loop start --daemon --backlog-id <id> --work-item-id github:owner/repo#123 --execution-manifest <path>

# 基础设施与诊断
afk tmux create-session --name <name> --dir <path>
afk isolate up
afk debug reproduce <cmd>
afk signal goal-complete --summary "<summary>"
```

完整命令参考：`afk --help`。

## 执行模型

- **`afk run`** 执行实现阶段。成功后推送实现分支并将工作项推进到 `verification`；它本身不完成托管式 QA 和变更请求闭环。
- **`afk execute`** 执行托管工作项生命周期：Manifest 与可执行性校验、实现、独立 QA、创建或校验变更请求，并进入 `merge_ready` 人工门禁。
- **`afk loop`** 持续轮询且仅绑定一个 Manifest 工作项，每次尝试委托给 `executeWorkItem`。它不是面向全局队列的多工作项调度器。
- **最终合并由人控制。** AFK 准备并验证 PR/MR；只有在人工完成合并且审计对账通过后，工作项才进入 `done`。

完整生命周期、状态、证据和验证边界请查看[全流程执行与 E2E 架构](docs/architecture/full-workflow-e2e-architecture.md)。

## Skills（Claude Code）

| Skill | 用途 | 使用场景 |
|-------|------|---------|
| `/afk-grill-me` | 需求访谈 | 需求模糊或可能存在遗漏 |
| `/afk-grill-me-context` | 补充访谈 | 现有草稿/文档需要验证 |
| `/afk-to-prd` | 生成 PRD | 需求对齐后 |
| `/afk-to-issues` | 分解为 Issues | PRD 批准后 |
| `/afk-do` | 任务编排 | 清晰的功能或任务描述 |
| `/afk-research` | 技术调研 | 编码前需要理解现有实现 |
| `/afk-prototype` | 方案验证 | 承诺投入前验证技术方案 |
| `/afk-implement` | 实现工作流 | 清晰实现目标 |
| `/afk-testing` | 测试专家 | 测试设计、执行、失败诊断与有效性评估 |
| `/afk-change-driven-testing` | 变更驱动测试 | 为本次修改涉及的业务流程补充回归测试 |
| `/afk-qa` | 独立验证 | 合并前验证工作成果 |
| `/afk-diagnose` | 故障诊断 | 具体、可复现的故障 |
| `/afk-branch-migrate` | 跨分支迁移 | 在分歧分支间 cherry-pick |
| `/afk-hand-off` | 工作交接 | 转移任务或会话上下文 |
| `/afk-scheduler` | 调度辅助 | 协调多个 Issue 及其依赖 |
| `/afk-skill-craft` | Skill 创作 | 创建、诊断或重构 Skills |
| `/api-workflow` | API 测试 | 多步骤 API 链配合浏览器测试 |
| `/md-to-pdf` | Markdown 转 PDF | 导出带 Mermaid 图表的文档 |
| `/reasoning-guard` | 推理守卫 | 检测多轮推理降级 |
| `/reasoning-watchdog` | 推理监控 | 基于 Hooks 的推理降级拦截 |
| `/afk-llm-dev-guide` | LLM 应用指南 | LLM 架构与上下文工程 |
| `/jev-agent-guard` | Agent 检查点 | 为不同编码 Agent 安装检查点 |
| `/software-complexity-governance` | 复杂度治理 | 度量复杂度、耦合度与技术债 |
| `/wiki` | 知识管理 | 检索、读取、沉淀和检查项目知识 |

详细文档请查看 [Skills 指南](docs/guides/skills.zh.md)。

## 开发

```bash
pnpm install
pnpm build
pnpm test
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop build
pnpm --dir apps/desktop test
pnpm --dir apps/cli link --global
```

## 文档

- **[快速开始](docs/getting-started.zh.md)** — AFK 上手
- **[系统架构](docs/architecture/system-architecture-design.md)** — 系统边界、分层、控制平面、执行基座和信任模型
- **[Workspace 架构](docs/architecture/overview.zh.md)** — 包边界、依赖方向、路径和 Provider 契约
- **[执行环境](docs/architecture/execution.zh.md)** — Agent Provider、Sandbox Provider、会话和工作流模板
- **[全流程与 E2E](docs/architecture/full-workflow-e2e-architecture.md)** — 生命周期、QA、状态流转和证据
- **[工作流](docs/guides/workflows.zh.md)** — 工作流和 Skill 使用
- **[Skills 指南](docs/guides/skills.zh.md)** — Skills 设计与使用

## License

MIT
