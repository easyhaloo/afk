# AFK 架构设计

## 概述

AFK 实现了跨平台 issue tracker 抽象层，提供 GitLab 和 GitHub 统一命令接口，切换平台无需修改代码。

## 核心设计模式

### TrackerProvider 接口

定义平台无关操作的核心抽象：

```typescript
interface TrackerProvider {
  // Issue 操作
  getIssue(id: number): Promise<TrackedIssue>;
  listIssues(options?: ListIssueOptions): Promise<TrackedIssue[]>;
  createIssue(options: CreateIssueOptions): Promise<number>;
  updateIssueLabels(id: number, labels: string[]): Promise<void>;
  addIssueComment(id: number, body: string): Promise<void>;
  
  // MR/PR 操作
  getMR(id: number): Promise<TrackedMR>;
  listMRs(options?: ListMROptions): Promise<TrackedMR[]>;
  createMR(options: CreateMROptions): Promise<number>;
  mergeMR(id: number, options?: MergeMROptions): Promise<void>;
  approveMR(id: number): Promise<void>;
  closeMR(id: number): Promise<void>;
  reopenMR(id: number): Promise<void>;
}
```

### 客户端工厂模式

平台检测与客户端创建：

```typescript
// src/lib/client-factory.ts
export function createTrackerClient(): TrackerProvider {
  const platform = detectPlatform();
  
  switch (platform) {
    case 'gitlab':
      return new GitLabClient(config);
    case 'github':
      return new GitHubClient(config);
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
```

平台检测逻辑 (`src/lib/core/tracker/detect.ts`)：
1. 检查 `TRACKER_PLATFORM` 环境变量
2. 检查 git remote URL 模式：
   - `gitlab.com` 或自定义 GitLab 实例 → GitLab
   - `github.com` → GitHub
3. 检查平台特定配置文件：
   - `.gitlab-ci.yml` → GitLab
   - `.github/workflows/` → GitHub
4. 降级到 GitLab（历史默认）

## 架构图

```
┌─────────────────────────────────────────────────┐
│           CLI 命令 (src/commands/)               │
│                                                  │
│  afk issue get <id>                             │
│  afk mr create "Title"                          │
└────────────────────┬────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────┐
│      createTrackerClient() 工厂                 │
│      (src/lib/client-factory.ts)                │
│                                                  │
│  检测: GitLab 或 GitHub                         │
└────────────────────┬────────────────────────────┘
                     │
          ┌──────────┴──────────┐
          ↓                     ↓
┌──────────────────┐   ┌──────────────────┐
│  GitLabClient    │   │  GitHubClient    │
│  (gitlab/index)  │   │  (github/client) │
│                  │   │                  │
│ 实现             │   │ 实现             │
│ TrackerProvider  │   │ TrackerProvider  │
└────────┬─────────┘   └────────┬─────────┘
         │                      │
         ↓                      ↓
┌──────────────────┐   ┌──────────────────┐
│  @gitbeaker/rest │   │  @octokit/rest   │
│  (GitLab API)    │   │  (GitHub API)    │
└──────────────────┘   └──────────────────┘
```

## 平台特定实现

### GitLabClient

位置: `src/lib/core/gitlab/index.ts`

**关键特性：**
- 使用 `iid`（项目内 issue ID）
- 直接通过 API 操作标签
- MR 批准是独立操作
- 内置 `removeSourceBranch` 选项

**示例：**
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
  );
  return mr.iid;
}
```

### GitHubClient

位置: `src/lib/core/github/client.ts`

**关键特性：**
- 使用 `number`（仓库内 issue/PR 编号）
- 标签需通过单独的 `issues.addLabels()` 调用
- PR 批准通过 review API
- 分支删除需单独的 `git.deleteRef()` 调用

**示例：**
```typescript
async createMR(options: CreateMROptions): Promise<number> {
  // 创建 PR
  const { data } = await this.octokit.pulls.create({
    owner: this.owner,
    repo: this.repo,
    title: options.title,
    head: options.sourceBranch,
    base: options.targetBranch,
    draft: options.draft ?? false,
  });
  
  // 单独添加标签
  if (options.labels?.length) {
    await this.octokit.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: data.number,
      labels: options.labels,
    });
  }
  
  return data.number;
}
```

## 扩展点

### 添加新平台

1. **创建客户端类**实现 `TrackerProvider`：
   ```typescript
   // src/lib/core/newplatform/client.ts
   export class NewPlatformClient implements TrackerProvider {
     async getIssue(id: number): Promise<TrackedIssue> { ... }
     async createMR(options: CreateMROptions): Promise<number> { ... }
     // ... 实现所有接口方法
   }
   ```

2. **更新平台检测**：
   ```typescript
   // src/lib/core/tracker/detect.ts
   export function detectPlatform(): Platform {
     if (remoteUrl.includes('newplatform.com')) return 'newplatform';
     // ...
   }
   ```

3. **在工厂中注册**：
   ```typescript
   // src/lib/client-factory.ts
   case 'newplatform':
     return new NewPlatformClient(config);
   ```

### 添加新操作

1. **扩展接口**：
   ```typescript
   // src/lib/core/tracker/types.ts
   interface TrackerProvider {
     // ... 现有方法
     newOperation(params: NewOpParams): Promise<Result>;
   }
   ```

2. **在两个客户端中实现**：
   - `GitLabClient.newOperation()`
   - `GitHubClient.newOperation()`

3. **添加 CLI 命令**：
   ```typescript
   // src/commands/tracker.ts 或新文件
   program
     .command('new-op')
     .action(async () => {
       const client = createTrackerClient();
       await client.newOperation(params);
     });
   ```

## 模块结构

```
src/
├── commands/              # CLI 命令定义
│   ├── tracker.ts        # afk issue/mr 命令
│   ├── dashboard.ts      # 仪表板 UI
│   ├── scheduler.ts      # 后台调度器
│   └── ...
├── lib/
│   ├── client-factory.ts # 工厂函数
│   ├── core/
│   │   ├── tracker/
│   │   │   ├── types.ts    # TrackerProvider 接口
│   │   │   ├── detect.ts   # 平台检测
│   │   │   └── index.ts    # 重导出
│   │   ├── gitlab/
│   │   │   ├── index.ts    # GitLabClient
│   │   │   └── client.ts   # 实现
│   │   └── github/
│   │       ├── index.ts    # GitHubClient
│   │       └── client.ts   # 实现
│   └── ...
└── index.ts              # CLI 入口点
```

## 配置

通过环境变量配置平台：

**GitLab:**
```bash
GITLAB_TOKEN=glpat-xxxxx
GITLAB_PROJECT_ID=12345
GITLAB_BASE_URL=https://gitlab.company.com/api/v4  # 可选
```

**GitHub:**
```bash
GITHUB_TOKEN=ghp_xxxxx
GITHUB_OWNER=org-name
GITHUB_REPO=repo-name
```

**平台覆盖:**
```bash
TRACKER_PLATFORM=gitlab  # 或 'github'
```

## 类型映射

统一类型抽象平台差异：

```typescript
// src/lib/core/tracker/types.ts
export interface TrackedIssue {
  id: number;           // iid (GitLab) 或 number (GitHub)
  title: string;
  description: string;  // description (GitLab) 或 body (GitHub)
  state: 'opened' | 'closed';
  labels: string[];
  webUrl: string;       // web_url (GitLab) 或 html_url (GitHub)
  author: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TrackedMR {
  id: number;
  title: string;
  description: string;
  state: 'opened' | 'closed' | 'merged';
  sourceBranch: string;  // source_branch (GitLab) 或 head.ref (GitHub)
  targetBranch: string;  // target_branch (GitLab) 或 base.ref (GitHub)
  webUrl: string;
  author: string;
  createdAt: Date;
  mergedAt?: Date;
}
```

## CLI 命令映射

AFK 提供统一的命令接口，自动适配 GitLab 和 GitHub：

### Issue 操作

| 操作 | AFK 命令 | GitLab | GitHub |
|------|---------|--------|--------|
| 查看详情 | `afk issue get <id>` | `glab issue view <iid>` | `gh issue view <number>` |
| 列出 issues | `afk issue list` | `glab issue list` | `gh issue list` |
| 创建 issue | `afk issue create "title"` | `glab issue create` | `gh issue create` |
| 更新标签 | `afk issue update-labels <id> label1,label2` | `glab issue update --labels` | `gh issue edit --add-label` |
| 添加评论 | `afk issue comment <id> "text"` | `glab issue note` | `gh issue comment` |
| 关联 issues | `afk issue link <id1> <id2>` | `glab issue link` | API 调用 |

### MR/PR 操作

| 操作 | AFK 命令 | GitLab | GitHub |
|------|---------|--------|--------|
| 查看详情 | `afk mr get <id>` | `glab mr view <iid>` | `gh pr view <number>` |
| 列出 MRs/PRs | `afk mr list` | `glab mr list` | `gh pr list` |
| 创建 MR/PR | `afk mr create "title"` | `glab mr create` | `gh pr create` |
| 合并 | `afk mr merge <id>` | `glab mr merge <iid>` | `gh pr merge <number>` |
| 批准 | `afk mr approve <id>` | `glab mr approve <iid>` | `gh pr review --approve <number>` |
| 关闭 | `afk mr close <id>` | `glab mr close <iid>` | `gh pr close <number>` |
| 重新打开 | `afk mr reopen <id>` | `glab mr reopen <iid>` | `gh pr reopen <number>` |

### 命令选项对比

**创建 MR/PR：**
```bash
# AFK（统一）
afk mr create "feat: add login" \
  --source feat/login \
  --target main \
  --draft \
  --label "feature,priority::high"

# GitLab
glab mr create \
  --source-branch feat/login \
  --target-branch main \
  --draft \
  --label "feature,priority::high"

# GitHub
gh pr create \
  --head feat/login \
  --base main \
  --draft \
  --label "feature" \
  --label "priority::high"
```

**合并选项：**
```bash
# AFK（统一）
afk mr merge 123 \
  --delete-source-branch \
  --squash \
  --message "Custom merge message"

# GitLab
glab mr merge 123 \
  --remove-source-branch \
  --squash \
  --squash-message "Custom merge message"

# GitHub
gh pr merge 123 \
  --squash \
  --delete-branch \
  --body "Custom merge message"
```

### 平台差异处理

**ID 语义：**
- **GitLab**: 使用 `iid`（项目内 ID，从 1 开始）
- **GitHub**: 使用 `number`（仓库内 ID，从 1 开始）
- **AFK**: 统一使用 `id`，自动映射到对应平台的 ID 类型

**标签操作：**
- **GitLab**: 单次 API 调用设置所有标签（逗号分隔）
- **GitHub**: 需要单独调用 `issues.addLabels()` 为 PR 添加标签
- **AFK**: 自动处理平台差异，统一为 `--label "label1,label2"` 格式

**分支删除：**
- **GitLab**: MR 创建时可设置 `removeSourceBranch: true`，合并时自动删除
- **GitHub**: 需要合并后单独调用 `git.deleteRef()` 删除分支
- **AFK**: `--delete-source-branch` 选项在两个平台都有效

**草稿状态：**
- **GitLab**: MR 创建时设置 `--draft` 标志
- **GitHub**: PR 创建时设置 `--draft` 标志
- **AFK**: 统一使用 `--draft` 选项

## 优势

1. **单一命令集**：用户只需学习一套命令，适用任何平台
2. **平台可移植性**：项目可在 GitLab ↔ GitHub 间迁移，无需更改工作流
3. **Skills 可复用性**：afk-* skills 在任何平台上都可工作
4. **可测试性**：Mock TrackerProvider 用于单元测试
5. **面向未来**：易于添加 Bitbucket、Azure DevOps 等

## 已知限制

1. **功能对等性**：部分平台特定功能可能没有等价物
2. **ID 语义**：GitLab iid vs GitHub number 在混合环境中可能造成混淆
3. **批准工作流**：GitHub PR reviews vs GitLab MR approvals 复杂度不同
4. **CI 集成**：平台特定 CI 系统需单独处理
