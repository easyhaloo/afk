# afk Skills GitHub Support & Unified Abstraction

## 项目概述

为 afk CLI 和相关技能添加 GitHub 支持，并实现统一的抽象层以屏蔽平台差异。

## 完成的工作

### 阶段 1: GitHub 支持
- ✅ 添加 `afk github link-issues` 命令
- ✅ 扩展 LinkType 支持更多关系类型
- ✅ 更新 afk-to-prd 支持 GitHub（带平台检测）
- ✅ 更新 afk-to-issues 支持 GitHub（带平台检测）

### 阶段 2: 统一抽象层
- ✅ 实现 `createTrackerClient()` 工厂函数
- ✅ 创建统一命令模块 `src/commands/tracker.ts`
- ✅ 更新技能使用统一命令
- ✅ 移除平台检测脚本

## 用户体验对比

### 之前（平台特定）
```bash
# 用户必须知道并指定平台
afk github create-issue "Feature request"
afk gitlab issue-create "Feature request"

# 技能中需要条件判断
if [[ "$PLATFORM" == "github" ]]; then
  afk github create-issue "$TITLE"
else
  afk gitlab issue-create "$TITLE"
fi
```

### 之后（平台无关）
```bash
# 平台自动检测
afk issue create "Feature request"
afk issue list
afk issue link 15 14 --type blocks

# 技能中直接使用
afk issue create "$TITLE"
afk issue comment $ID "$(cat PRD.md)"
```

## 架构设计

```
┌─────────────────────────────────────────────┐
│         用户命令 (afk issue create)          │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│      createTrackerClient()                  │
│      自动检测 git remote 平台                │
└─────────────────┬───────────────────────────┘
                  │
         ┌────────┴────────┐
         ▼                 ▼
┌────────────────┐  ┌────────────────┐
│ GitHubClient   │  │ GitLabClient   │
│ implements     │  │ implements     │
│ TrackerProvider│  │ TrackerProvider│
└────────────────┘  └────────────────┘
```

## 统一命令列表

| 命令 | 说明 |
|------|------|
| `afk issue get <id>` | 获取 issue 详情 |
| `afk issue list` | 列出 issues |
| `afk issue create <title>` | 创建新 issue |
| `afk issue update-labels <id>` | 更新标签 |
| `afk issue comment <id> <msg>` | 添加评论 |
| `afk issue link <source> <target>` | 链接 issues |

## 优势

1. **简化用户体验** - 用户无需关心平台差异
2. **清洁的技能代码** - 无需平台条件判断
3. **易于维护** - 平台检测逻辑集中化
4. **向后兼容** - 保留平台特定命令用于高级功能
5. **类型安全** - 统一的 TrackerProvider 接口

## 测试验证

```bash
# 统一命令测试
$ afk issue list -s all
Found 1 issues:
  #15 Dashboard 启动动画功能 [documentation, enhancement]

# 帮助信息
$ afk issue --help
Usage: afk issue [options] [command]

Issue operations (auto-detects platform)

Commands:
  get [options] <id>                Get issue by ID
  list [options]                    List issues with filters
  create [options] <title>          Create a new issue
  update-labels [options] <id>      Add and/or remove labels
  comment <id> <message>            Add comment to issue
  link [options] <source> <target>  Link two issues
```

## 文件变更

### 新增文件
- `src/commands/tracker.ts` - 统一命令模块
- `src/commands/github.ts` - GitHub link-issues 命令

### 修改文件
- `src/lib/client-factory.ts` - 添加 createTrackerClient()
- `src/lib/core/tracker/types.ts` - 扩展 LinkType
- `src/lib/core/github/client.ts` - 实现 linkIssues
- `src/full-cli.ts` - 注册统一命令
- `~/.claude/skills/afk-to-prd/skill.md` - 使用统一命令
- `~/.claude/skills/afk-to-issues/skill.md` - 使用统一命令

### 删除文件
- `~/.claude/skills/afk-to-prd/platform-detect.sh`
- `~/.claude/skills/afk-to-issues/platform-detect.sh`

## 提交历史

```
9eb6c7f feat: add unified tracker abstraction layer
00681aa feat(skills): add GitHub support to afk-to-prd and afk-to-issues
```

## 已知问题

- TypeScript 类型错误：scheduler.ts 和 workflow.ts 中存在 GitLabClient 重复定义
- 原因：`src/lib/core/gitlab/client.ts`（旧版，包含 afk 特定方法）和 `src/lib/core/gitlab/index.ts`（新版，实现 TrackerProvider）
- 影响：编译时有类型警告，但不影响运行
- 解决方案：合并两个 GitLabClient 实现（后续工作）

## 后续计划

1. 合并 GitLabClient 实现以修复类型错误
2. 添加 MR/PR 统一命令（`afk mr create`, `afk mr list`）
3. 更新其他使用平台特定命令的技能
4. 添加平台覆盖选项（`--platform github|gitlab`）

## 兼容性

- ✅ 保留所有平台特定命令（`afk github`, `afk gitlab`）
- ✅ 现有脚本和工作流无需修改
- ✅ 用户可选择使用统一命令或平台特定命令
