# 快速开始

5 分钟上手 AFK CLI。

## 安装

```bash
# 克隆项目
git clone https://github.com/easyhaloo/afk.git
cd afk

# 安装依赖
npm install

# 构建
npm run build

# 全局安装
npm link
```

验证安装：
```bash
afk --version
afk --help
```

## 配置

### GitLab 项目

创建配置文件 `~/.config/afk/.env`：

```bash
# GitLab 配置
GITLAB_TOKEN=glpat-xxxxxxxxxxxxx
GITLAB_BASE_URL=https://gitlab.company.com/api/v4  # 可选，默认 gitlab.com

# 或使用 git config（推荐）
cd /path/to/your/project
git config afk.platform gitlab
git config afk.project "mygroup/myproject"
```

### GitHub 项目

```bash
# GitHub 配置
GITHUB_TOKEN=ghp_xxxxxxxxxxxxx
GITHUB_OWNER=your-org
GITHUB_REPO=your-repo

# 或使用 git config
cd /path/to/your/project
git config afk.platform github
git config afk.owner "your-org"
git config afk.repo "your-repo"
```

### 平台自动检测

AFK 会自动检测平台：
1. 检查 `TRACKER_PLATFORM` 环境变量
2. 分析 git remote URL
3. 检查项目配置文件（.gitlab-ci.yml 或 .github/workflows/）

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

让 AFK 自动处理所有可执行 Backlog：

```bash
# 启动实现 → QA → 合并循环
afk loop --max-concurrent 3 --poll-interval 60

# 调度器会自动：
# - 每 60 秒轮询 ready/rework Backlog
# - 最多同时处理 3 个 issues
# - 验证前置条件（AC、base label、无阻塞）
# - 创建 worktree 和 tmux session
# - 监控完成并创建 MR/PR
```

## 下一步

- **架构设计** → [ARCHITECTURE.md](docs/ARCHITECTURE.md) — 了解跨平台抽象层
- **工作流详解** → [WORKFLOWS.md](docs/WORKFLOWS.md) — 深入理解三种工作流
- **Skills 系统** → [SKILLS.md](docs/SKILLS.md) — 学习 afk skills 的设计和使用

## 常见问题

### 命令找不到

```bash
# 重新链接
cd /path/to/afk
npm link

# 或直接运行
node /path/to/afk/dist/index.js --help
```

### 平台检测错误

```bash
# 手动指定平台
export TRACKER_PLATFORM=gitlab  # 或 github

# 或在 git config 中设置
git config afk.platform gitlab
```

### API 权限错误

确保 token 有足够权限：
- **GitLab**: api, read_api, write_repository
- **GitHub**: repo, workflow

## 需要帮助？

- 查看完整文档：`docs/`
- 查看命令帮助：`afk <command> --help`
- 提交 Issue：https://github.com/easyhaloo/afk/issues
