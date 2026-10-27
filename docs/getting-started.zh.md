# 快速开始

5 分钟上手 AFK CLI。

## 安装

安装 Node.js 22.16 或以上版本，确保 `node` 和 `tar` 位于 `PATH`。
预编译包支持 macOS、使用 glibc 的 Linux，均覆盖 x64 与 arm64。
安装器下载包含生产依赖的发布包，校验 SHA-256 和启动状态，再切换执行入口。
安装过程不安装依赖、不构建源码、不运行测试套件，无需 pnpm、git 或编译器。
运行具体命令时，仍需准备该命令依赖的 Git 等工具。

首次发布 `cli-v*` Release 后，可直接下载独立安装器：

```bash
curl -fsSL https://github.com/easyhaloo/afk/releases/latest/download/install.sh -o /tmp/afk-install.sh
bash /tmp/afk-install.sh
```

已有源码仓库也可以直接运行 `./install.sh`，同样下载发布包，不构建当前源码。
常用参数：

```bash
bash /tmp/afk-install.sh --version 0.1.0 --skip-completion
bash /tmp/afk-install.sh --prefix "$HOME/bin"
bash /tmp/afk-install.sh --archive ./afk-darwin-arm64.tar.gz --checksum ./afk-darwin-arm64.tar.gz.sha256
```

`~/.local/bin/afk` 指向
`~/.afk/cli/versions/<版本>-<平台>-<架构>-<sha256>/` 内的执行入口。
再次安装时原子替换软链接；下载、校验或启动失败时保留原版本，历史版本继续保留在磁盘上。
替换非托管文件时，需要显式使用 `--force`，不会替换目录。
默认安装路径无需提权。`--system` 使用 `/usr/local/bin`，要求当前用户已具备写入权限。
补全配置可通过 `--skip-completion` 关闭；若安装器提示，将执行目录加入 shell 的 `PATH`。

AFK 配置与系统数据继续存放在 `~/.afk/`，工作项执行目录继续使用 `~/.loop-workspace/`。

验证安装：
```bash
afk --version
afk --help
```

### 构建并发布 CLI

维护者使用 pnpm（CI 固定 12.5.1）在目标平台构建，用户安装构建后的产物：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm rebuild esbuild
pnpm release:cli
```

本机使用 pnpm 12.5.1 也可以直接执行。打包脚本在 deploy 前后保留源码 workspace
的依赖元数据，避免污染本地依赖状态。

`release/cli/` 会生成 `install.sh`、`afk-<平台>-<架构>.tar.gz` 及对应的 `.sha256` 文件。
打包脚本构建 CLI 与 workspace 依赖，通过
`pnpm deploy --legacy --prod --ignore-scripts --config.hoist=false --config.force=false`
收集生产依赖，随后在源码目录之外、
禁用构建工具的环境中执行离线安装验证，并通过 `--help` 检查命令注册表中的全部入口。

将 `apps/cli/package.json` 与 CLI 输出的版本同步后，合并到 `main`。
[CLI 发布工作流](../.github/workflows/release-cli.yml) 会检测新的 CLI 版本，自动创建匹配的
标签（例如 `cli-v0.1.0`），在四个目标平台分别构建、验证，全部通过后上传 GitHub Release。
已经存在对应版本和 Release 时会跳过，因此普通提交不会重复发布同一包。
也可以手动推送匹配的 `cli-v` 标签。CLI 标签使用 `cli-v` 前缀，插件版本单独管理。
工作流将 CLI Release 标记为 `latest`，发布插件时应保留该指向；指定版本安装使用 `--version`。
当前不提供 Windows 和 musl/Alpine 发布包。

## 配置

### Provider 凭据

AFK 从环境变量或 provider 自己的 CLI 读取凭据：

```bash
# GitHub：GITHUB_TOKEN / GH_TOKEN，或 `gh auth login`
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxx

# GitLab：GITLAB_TOKEN 加可选的 GITLAB_URL，或 `glab auth login`
export GITLAB_TOKEN=glpat_xxxxxxxxxxxxx
export GITLAB_URL=https://gitlab.company.com   # 可选，默认 gitlab.com
```

### Tracker 目标

所有面向 provider 的命令都需要知道要访问哪个 provider 项目。AFK 按以下
顺序解析该目标：

1. 命令行参数 `--project` / `--platform`
2. 本地 tracker 索引，按 issue id 命中——AFK 上次处理该 issue 时写下的关联
3. 本地 tracker 索引，按当前目录命中
4. 环境变量 `AFK_TRACKER_PROJECT` / `AFK_TRACKER_PLATFORM`
5. 当前 git 仓库的 `origin` remote

git remote 是可选的，因此 `afk backlog show` 这类只读命令在知道目标后
可以在任意目录下执行：

```bash
export AFK_TRACKER_PROJECT=my-org/my-repo
export AFK_TRACKER_PLATFORM=github   # 可选，由项目名推断
afk backlog show --id 123
```

平台仍无法确定时，数字项目名（`202`）或三段及以上路径（`group/sub/project`）
判定为 GitLab；`owner/repo` 形态判定为 GitHub，除非只配置了 GitLab 凭据。

### 本地 tracker 索引

AFK 把接触过的 provider 项目记在跨工作区共享的本地索引
`~/.afk/tracker-projects.json` 中。每次 backlog 列表、
issue 查询、inventory 和执行都会写入它看到的内容：provider 项目、访问时
所在的仓库、以及涉及的 issue。

正是这个索引让"裸 issue id"在任何目录下都够用：

```bash
afk backlog show --id 229
```

多仓库场景下关联关系由 AFK 自己建立：站在某个仓库里就选中它的项目，
给出 issue id 就选中它所属的项目，不需要给每个仓库单独配置。索引只是本地
缓存——provider 状态始终以 provider 为准。

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

在 git 仓库之外执行时，显式给出项目名：

```bash
afk backlog show --id 42 --project my-org/my-repo --platform github
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

- **架构设计** → [overview.md](docs/architecture/overview.md) — 了解跨平台抽象层
- **工作流详解** → [workflows.md](docs/guides/workflows.md) — 深入理解三种工作流
- **Skills 系统** → [skills.md](docs/guides/skills.md) — 学习 afk skills 的设计和使用

## 常见问题

### 命令找不到

```bash
# 将安装目录加入 PATH（自定义 prefix 时改成对应目录）
export PATH="$HOME/.local/bin:$PATH"
afk --version
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
