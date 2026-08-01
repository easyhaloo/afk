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
GITLAB_PROJECT_ID=12345
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

### Issue 操作

```bash
# 查看 issue 详情
afk issue get 123

# 列出 issues
afk issue list --label "stage::ready-for-implement"

# 创建 issue
afk issue create "Add user login" --label "feature"

# 添加评论
afk issue comment 123 "Working on this"
```

### MR/PR 操作

```bash
# 创建 MR/PR
afk mr create "feat: add login" --source feat/login --target main

# 查看 MR/PR
afk mr get 456

# 合并 MR/PR
afk mr merge 456 --delete-source-branch

# 批准 MR/PR
afk mr approve 456
```

### 完整工作流示例

从 issue 到合并的完整流程：

```bash
# 1. 发现待实现的 issue
afk issue list --label "stage::ready-for-implement"

# 2. 启动工作流（创建 worktree + tmux session）
afk workflow run --iid 123 --base-branch main

# 3. 在 tmux session 中，Claude 会自动执行 /afk-implement
# 监控进度（可选）
tmux attach -t afk-issue-123

# 4. 工作流完成后自动创建 MR/PR 并清理 worktree
```

## 自动化调度

让 AFK 自动处理所有就绪的 issues：

```bash
# 启动调度器
afk scheduler start --max-concurrent 3 --poll-interval 60

# 调度器会自动：
# - 每 60 秒轮询新的 ready issues
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
