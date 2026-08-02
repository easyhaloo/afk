# AFK

**AFK = Away From Keyboard** — 自主开发工作流的 CLI + Skills 系统

基于 Claude AI agents 和 TypeScript 的跨平台 issue 跟踪自动化（GitLab/GitHub）。

## 架构图

![AFK 架构](assets/afk-architecture.jpg)

## 特性

- **跨平台** — GitLab 和 GitHub 统一 CLI（issues, MRs/PRs）
- **Skills 套件** — 18 个 Claude Code skills，涵盖完整开发流程
- **TUI 仪表板** — 交互式 issue 跟踪仪表板
- **后台自动化** — 基于 tmux 的工作流调度器
- **TDD 集成** — 内置测试驱动开发方法论

## 快速开始

```bash
git clone https://github.com/easyhaloo/afk.git
cd afk
npm install && npm run build
npm link
afk --version
```

详细步骤和配置见 [快速开始指南](docs/GETTING-STARTED.md)

## 安装 Claude Code 插件（可选）

AFK 提供完整的 Claude Code skill 套件，可作为插件集成到 Claude Code 中。

### 方式一：在 Claude Code 会话中安装（推荐）

在 Claude Code 交互式会话中直接使用 slash command：

```bash
/plugin install afk@afk
```

### 方式二：使用 CLI 安装

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

### 方式四：符号链接 skills

将 `skills/` 目录链接到全局 skills 目录（无需插件机制）：

```bash
mkdir -p ~/.claude/skills
ln -s /path/to/afk/skills/* ~/.claude/skills/
```

### 验证安装

在 Claude Code 中运行 `/afk-grill-me` 确认 skills 已加载。

## CLI 命令

```bash
# Issue 管理
afk issue get <id>
afk issue list --label "stage::ready-for-implement"
afk issue create "Title" --label "feature"
afk issue edit <id> --label "bug"
afk issue comment <id> "message"
afk issue link <src> <project>:<iid>     # 跨项目 link
afk issue run <iid> --project <repo>      # 跨项目一键工作流

# MR/PR 操作
afk mr create "feat: add login" --source feat/login --target main
afk mr merge <id> --delete-source-branch
afk mr approve <id>
afk mr close <id>
afk mr reopen <id>

# 工作流 & 自动化
afk board                             # 交互式 TUI 面板
afk kanban                            # Kanban 看板
afk workflow run --iid <id>           # Issue → MR 流水线
afk loop start                        # 持续集成循环
afk scheduler start --max-concurrent 3 # 后台调度器
afk qa run                            # QA 验证

# 基础设施
afk worktree create <iid>             # Git worktree 管理
afk tmux create-session               # Tmux session 管理
afk isolate up                        # DB 服务隔离

# 调试 & 上报
afk debug reproduce <cmd>             # Debug 循环
afk escalate create "title"           # 上报 GitLab issue

# 信号管理
afk signal goal-complete              # 工作流信号通信
```

完整命令参考：`afk --help`

## Skills（Claude Code）

| Skill | 用途 | 触发场景 |
|-------|------|---------|
| `/afk-grill-me` | 需求澄清 | 需求模糊或可能有遗漏 |
| `/afk-grill-me-context` | 有上下文的补充追问 | 已有草稿/文档需要验证补充 |
| `/afk-to-prd` | 生成 PRD | 需求对齐后合成 PRD |
| `/afk-to-issues` | 分解为 issues | PRD 审批后拆解为可执行 issues |
| `/afk-do` | 任务编排 | 明确的功能需求或任务描述 |
| `/afk-research` | 技术调研 | 需要了解现有实现再编码 |
| `/afk-prototype` | 方案验证 | 技术决策前需要验证方案 |
| `/afk-implement` | TDD 实现 | 清晰定义的实现目标 |
| `/afk-qa` | 独立验证 | MR/PR 准备合并前验证 |
| `/afk-debug` | 快速修复 | 具体可重现的失败场景 |
| `/afk-pipeline` | 阶段路由 | 不确定用哪个 skill 时导航 |
| `/afk-branch-migrate` | 跨分支迁移 | 在差异大的分支间摘取代码 |
| `/afk-hand-off` | 工作交接 | 需要转移任务给其他开发者 |
| `/afk-scheduler` | 后台调度 | 多 issues 依赖感知调度执行 |
| `/api-workflow` | API 测试 | 多步骤 API 链式调用与浏览器混合测试 |
| `/md-to-pdf` | Markdown 转 PDF | 导出含 Mermaid 图的文档为 PDF |
| `/reasoning-guard` | 推理路径看护 | 编码 agent 多轮推理退化 |
| `/reasoning-watchdog` | 自动推理监控 | 基于 hooks 的推理退化自动拦截 |

详见 [Skills 深度说明](docs/SKILLS.md)

## 架构

AFK 使用 **TrackerProvider** 接口抽象 GitLab 和 GitHub 差异：

```typescript
interface TrackerProvider {
  getIssue(id: number): Promise<TrackedIssue>;
  createMR(options: CreateMROptions): Promise<number>;
  mergeMR(id: number, options?: MergeMROptions): Promise<void>;
  // ... 更多操作
}
```

平台自动检测，无需切换命令。详见 [架构设计](docs/ARCHITECTURE.md) 和 [执行环境设计](docs/EXECUTION-DESIGN.md)

## 工作流

三种核心工作流模式：

1. **Issue → 实现 → MR 流水线** — 从 issue 发现到合并请求
2. **调度器工作流** — 后台依赖感知执行
3. **Skills 工作流** — TDD 方法论集成

详见 [工作流程文档](docs/WORKFLOWS.md)

## 开发

```bash
npm install
npm run build    # 构建 TypeScript
npm test         # 运行测试
npm link         # 全局安装
```

## 文档

- **[快速开始](docs/GETTING-STARTED.md)** — 5分钟上手 AFK
- **[架构设计](docs/ARCHITECTURE.md)** — 跨平台抽象层 + CLI 命令映射
- **[工作流程](docs/WORKFLOWS.md)** — Issue → MR 流水线、调度器、Skills 集成
- **[Skills 说明](docs/SKILLS.md)** — 核心 skills 的设计与使用

## 许可证

MIT
