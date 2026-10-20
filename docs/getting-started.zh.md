# 快速开始

5 分钟上手 AFK CLI。

## 安装

```bash
# 克隆项目
git clone https://github.com/easyhaloo/afk.git
cd afk

# 安装依赖
pnpm install

# 构建
pnpm build

# 全局安装
pnpm link
```

本仓库是 pnpm workspace：根包通过 `workspace:*` 协议依赖 `@afk/core`、
`@afk/application` 与 `@afk/workflow-graph`，`npm install` 无法解析该协议，
请使用 pnpm。

验证安装：
```bash
afk --version
afk --help
```

## 配置

AFK 从环境变量读取凭据，从项目根目录的 YAML 文件读取项目设置。
既没有全局配置文件，也没有 `git config afk.*` 这样的配置键。

### GitLab

```bash
export GITLAB_TOKEN=glpat-xxxxxxxxxxxxx
export GITLAB_URL=https://gitlab.company.com   # 可选，默认 https://gitlab.com
```

当 `GITLAB_TOKEN` 缺失时，AFK 回退读取 `glab` CLI 存放在
`~/.config/glab-cli/config.yml` 的 token。

### GitHub

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxx   # 也接受 GH_TOKEN
export GITHUB_REPOSITORY=your-org/your-repo
```

仓库默认从 git remote 探测；只有 remote 不可达时才需要 `GITHUB_REPOSITORY`。

### 项目设置

按项目的设置写在项目根目录的 `.afk/config.yml`：

```yaml
agentDefault: claude-code
tmuxSession: afk
maxQaReworkAttempts: 3
template: issue-implementation
```

每一项都有环境变量覆盖，且项目文件优先于环境变量。最常用的几项：

| 配置项 | 环境变量 | 默认值 |
|---|---|---|
| `agentDefault` | `AFK_AGENT_DEFAULT` | `claude-code` |
| `tmuxSession` | `AFK_TMUX_SESSION` | `afk` |
| `maxQaReworkAttempts` | `AFK_MAX_QA_REWORK_ATTEMPTS` | `3` |
| `workflowHardTimeout` | `AFK_WORKFLOW_HARD_TIMEOUT` | 7200000 毫秒 |
| `qaTimeout` | `AFK_QA_TIMEOUT` | 1800000 毫秒 |
| `contextThreshold` | `AFK_CONTEXT_THRESHOLD` | 100000 |
| `goalBudget` | `AFK_GOAL_BUDGET` | 10000000 |
| `maxRetries` | `AFK_MAX_RETRIES` | 2 |
| `maxSelfIterations` | `AFK_MAX_SELF_ITERATIONS` | 3 |
| `template` | —（仅项目文件） | `issue-implementation` |

另有两个变量决定 AFK 自身状态的存放位置：

| 变量 | 含义 |
|---|---|
| `AFK_STATE_DIR` | 持久化的租约与认领状态（默认 `~/.afk/state`） |
| `AFK_EVENT_STORE_DIR` | 只追加的运行审计事件（默认 `~/.afk/events`） |

### 平台自动检测

AFK 从 git remote 判定平台与项目：

1. 读取当前仓库的 `remote.origin.url`。
2. `github.com` 远端选择 GitHub，其他主机选择 GitLab。
3. 项目即去掉主机名与 `.git` 后缀后的远端路径。

也可以对任意 `afk backlog` 命令加 `--platform github` 或 `--platform gitlab`
显式选择 provider。

## 基本使用

### Backlog 操作

```bash
# 查看 Backlog 详情
afk backlog show --id 123

# 列出可执行 Backlog
afk backlog list --state ready --mode afk

# 创建 Backlog
afk backlog create "Add user login" --description-file ./description.md --tag feature

# 使用相同业务 ID 执行和验证
afk run --backlog-id 123
afk qa --backlog-id 123
```

### Provider 选择

AFK 默认从当前仓库探测 Provider；需要时可显式选择：

```bash
afk backlog list --platform github
afk backlog show --id 42 --platform gitlab
```

Provider 分配规范 Backlog ID；变更单创建与合并由类型化工作流步骤完成，不再提供独立 MR 公共命令。

### 完整工作流示例

从 Backlog 到合并的完整流程：

```bash
# 1. 发现待实现 Backlog
afk backlog list --state ready --mode afk

# 2. 使用稳定业务 ID 执行
afk run --backlog-id 123

# 3. 分别观察 Backlog 生命周期与 runtime 状态
afk

# 4. 必要时独立运行 QA
afk qa --backlog-id 123
```

## 自动化调度

使用轮询守护进程执行绑定 manifest 的工作项：

```bash
afk loop start --daemon --backlog-id <id> \
  --work-item-id github:owner/repo#123 \
  --execution-manifest /absolute/path/to/manifest.json \
  --poll-interval 60
```

Loop 只接受一个 Backlog ID 与匹配的执行 manifest，并复用 `afk execute`
的 `executeWorkItem` 用例；不再运行旧的实现/QA 双队列或无 manifest 的全量调度。

## 下一步

- **架构设计** → [overview.md](architecture/overview.md) — 了解跨平台抽象层
- **工作流详解** → [workflows.md](guides/workflows.md) — 深入理解三种工作流
- **Skills 系统** → [skills.md](guides/skills.md) — 学习 afk skills 的设计和使用
- **文档地图** → [index.md](index.md) — 仓库中每一份文档及其用途

## 常见问题

### 命令找不到

```bash
# 重新链接
cd /path/to/afk
pnpm link

# 或直接运行
node /path/to/afk/dist/index.js --help
```

### 平台检测错误

AFK 无法从 git remote 读出项目。确认仓库存在 `origin` 远端，或显式指定
provider：

```bash
afk backlog list --platform gitlab
afk backlog list --platform github
```

### API 权限错误

确保 token 有足够权限：
- **GitLab**: api, read_api, write_repository
- **GitHub**: repo, workflow

## 需要帮助？

- 查看完整文档：`docs/`
- 查看命令帮助：`afk <command> --help`
- 提交 Issue：https://github.com/easyhaloo/afk/issues
