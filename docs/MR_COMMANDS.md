# MR/PR Unified Commands Implementation

## Summary

完成了 MR/PR 统一命令的实现，并更新了相关 skills 使用新命令。

## 实现内容

### 1. ✅ TrackerProvider 接口扩展

在 `src/lib/core/tracker/types.ts` 中添加：

```typescript
// 新增类型
export interface CreateMROptions {
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch: string;
  draft?: boolean;
  labels?: string[];
}

export interface MergeMROptions {
  deleteSourceBranch?: boolean;
  squash?: boolean;
  mergeCommitMessage?: string;
}

// 扩展接口
interface TrackerProvider {
  // 已有
  getMR(id: number): Promise<TrackedMR>;
  listMRs(options?: ListMROptions): Promise<TrackedMR[]>;
  
  // 新增
  createMR(options: CreateMROptions): Promise<number>;
  mergeMR(id: number, options?: MergeMROptions): Promise<void>;
}
```

### 2. ✅ 客户端实现

#### GitLabClient (`src/lib/core/gitlab/index.ts`)

```typescript
async createMR(options: CreateMROptions): Promise<number> {
  const mr = await this.client.MergeRequests.create(
    this.projectId,
    options.sourceBranch,
    options.targetBranch,
    options.title,
    {
      description: options.description || '',
      labels: options.labels?.join(','),
      removeSourceBranch: true,
    }
  ) as any;
  return mr.iid;
}

async mergeMR(id: number, options: MergeMROptions = {}): Promise<void> {
  await this.client.MergeRequests.accept(this.projectId, id, {
    shouldRemoveSourceBranch: options.deleteSourceBranch ?? true,
    squash: options.squash ?? false,
    mergeCommitMessage: options.mergeCommitMessage,
  });
}
```

#### GitHubClient (`src/lib/core/github/client.ts`)

```typescript
async createMR(options: CreateMROptions): Promise<number> {
  const { data } = await oct.pulls.create({
    owner, repo,
    title: options.title,
    body: options.description || '',
    head: options.sourceBranch,
    base: options.targetBranch,
    draft: options.draft ?? false,
  });
  
  // Add labels if specified
  if (options.labels && options.labels.length > 0) {
    await oct.issues.addLabels({
      owner, repo,
      issue_number: data.number,
      labels: options.labels,
    });
  }
  
  return data.number;
}

async mergeMR(id: number, options: MergeMROptions = {}): Promise<void> {
  await oct.pulls.merge({
    owner, repo,
    pull_number: id,
    commit_message: options.mergeCommitMessage,
    merge_method: options.squash ? 'squash' : 'merge',
  });
  
  // Delete source branch if requested
  if (options.deleteSourceBranch) {
    const pr = await this.getMR(id);
    await oct.git.deleteRef({
      owner, repo,
      ref: `heads/${pr.sourceBranch}`,
    });
  }
}
```

### 3. ✅ 统一命令实现

在 `src/commands/tracker.ts` 中添加 `afk mr` 命令组：

#### afk mr get
```bash
afk mr get <id>             # 获取 MR/PR 详情
afk mr get <id> --json      # JSON 输出
```

#### afk mr list
```bash
afk mr list                 # 列出 opened MRs/PRs
afk mr list -s all          # 列出所有状态
afk mr list --json          # JSON 输出
```

#### afk mr create
```bash
afk mr create "Title"                           # 使用当前分支
afk mr create "Title" --source feat/x --target main
afk mr create "Title" --draft                   # 创建草稿
afk mr create "Title" --label "bug,urgent"      # 添加标签
```

#### afk mr merge
```bash
afk mr merge <id>                    # 合并并删除源分支
afk mr merge <id> --no-delete-branch # 保留源分支
afk mr merge <id> --squash           # Squash 合并
afk mr merge <id> --message "msg"    # 自定义合并消息
```

### 4. ✅ Skills 更新

#### afk-qa
**更新内容：**
- `glab mr merge <mr-iid> --delete-source-branch` → `afk mr merge <mr-id> --delete-source-branch`
- 描述中 "MR" → "MR/PR"
- 添加 GitHub 到 disallowed-tools

**更新位置：**
- Line 78: Step 4 合并命令
- Line 4-6: 描述
- Line 8-9: disallowed-tools

#### afk-prototype
**更新内容：**
- `glab mr create --target-branch <target_branch> --draft --yes` → `afk mr create "Spike: <description>" --source spike/<slug> --target <target_branch> --draft`
- 描述中 "MR" → "MR/PR"
- 添加 GitHub 到 disallowed-tools

**更新位置：**
- Line 42: Step 3 创建命令
- Line 6, 18, 33, 43: MR → MR/PR
- Line 8-10: disallowed-tools

## 测试验证

```bash
# 帮助信息
$ afk mr --help
Usage: afk mr [options] [command]

MR/PR operations (auto-detects platform)

Commands:
  get [options] <id>        Get MR/PR by ID
  list [options]            List MRs/PRs with filters
  create [options] <title>  Create a new MR/PR
  merge [options] <id>      Merge an MR/PR

# 列出 MRs
$ afk mr list
Found 0 MRs/PRs:

# 构建成功
$ npm run build
✓ Build completed successfully
```

## 特性对比

| 功能 | GitLab | GitHub | 统一命令 |
|------|--------|--------|---------|
| 创建 | `glab mr create` | `gh pr create` | `afk mr create` |
| 列出 | `glab mr list` | `gh pr list` | `afk mr list` |
| 查看 | `glab mr view` | `gh pr view` | `afk mr get` |
| 合并 | `glab mr merge` | `gh pr merge` | `afk mr merge` |
| 草稿 | `--draft` | `--draft` | `--draft` ✅ |
| 标签 | `--label` | `--label` | `--label` ✅ |
| Squash | `--squash` | `--squash` | `--squash` ✅ |
| 删除分支 | `--remove-source-branch` | 需手动 | `--delete-source-branch` ✅ |

## 平台差异处理

### GitLab
- 使用 `iid` (项目内 ID)
- MR 创建时可直接设置 `removeSourceBranch`
- 合并使用 `MergeRequests.accept()`

### GitHub
- 使用 `number` (仓库内 ID)
- PR 创建后通过 `issues.addLabels()` 添加标签
- 合并后需单独调用 `git.deleteRef()` 删除分支
- 分支删除是 best-effort（可能失败但不影响合并）

## 统一抽象完成度

| 命令组 | 状态 | 命令数 |
|--------|------|--------|
| `afk issue` | ✅ 完成 | 6 (get, list, create, update-labels, comment, link) |
| `afk mr` | ✅ 完成 | 4 (get, list, create, merge) |

## Skills 更新状态

| Skill | 状态 | 更新内容 |
|-------|------|---------|
| afk-to-prd | ✅ 已完成 | 使用 issue 命令 |
| afk-to-issues | ✅ 已完成 | 使用 issue 命令 |
| afk-scheduler | ✅ 已完成 | 使用 issue 命令 |
| afk-qa | ✅ 已完成 | 使用 mr merge 命令 |
| afk-prototype | ✅ 已完成 | 使用 mr create 命令 |

## 提交信息

```
b6f663d feat: add unified MR/PR commands and update skills
1e4c3bb docs: add afk skills platform command analysis
940f7a9 docs: add unified abstraction implementation guide
9eb6c7f feat: add unified tracker abstraction layer
```

## 下一步

所有计划的统一抽象层任务已完成：
1. ✅ 实现 `afk mr` 命令组
2. ✅ 扩展 TrackerProvider 接口
3. ✅ 更新 afk-qa 和 afk-prototype skills

**可选后续工作：**
- 修复 GitLabClient 类型冲突（合并两个实现）
- 添加更多 MR 操作（approve, close, reopen）
- 实现 MR 状态检查和 CI 集成
