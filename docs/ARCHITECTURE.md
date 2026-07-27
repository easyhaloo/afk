# AFK 架构设计文档

> 基于源码深度分析 - v0.1.0

## 系统概览

AFK (Automated Feature Kitchen) 是一个**信号驱动的自动化工作流系统**，通过跨平台抽象层统一 GitLab 和 GitHub 的 Issue/MR 管理，结合 tmux 会话隔离、git worktree 并行开发、BullMQ 任务调度，实现从 Issue 到 MR 的全自动化闭环。

**核心价值：**
- 跨平台抽象：GitLab ↔ GitHub 零迁移成本
- 信号驱动：Agent 通过 `.afk-signal.json` 文件与系统通信
- 会话隔离：每个 Issue 在独立 tmux 会话 + worktree 中执行
- 可观测性：完整的状态追踪、超时保护、上下文切换

**解决的问题：**
1. 平台锁定：不同 tracker 系统 API 差异导致迁移成本高
2. 并行开发：多个 Issue 同时开发时的分支/上下文隔离
3. 超时控制：长时间运行任务的硬超时与优雅降级
4. 状态同步：Agent 执行状态与 Issue tracker 的双向同步

---

## 核心架构

### 1. 跨平台抽象层 (TrackerProvider)

#### 1.1 设计理念

**单一接口，多平台实现**：通过 `TrackerProvider` 接口定义平台无关操作，由 `GitLabClient` 和 `GitHubClient` 分别实现。

**源码位置：**
- 接口定义：`src/lib/core/tracker/types.ts`
- GitLab 实现：`src/lib/core/gitlab/index.ts`
- GitHub 实现：`src/lib/core/github/client.ts`
- 工厂函数：`src/lib/client-factory.ts`

#### 1.2 TrackerProvider 接口

```typescript
export interface TrackerProvider {
  readonly platform: Platform;           // 'gitlab' | 'github'
  readonly projectId: string | number;   // 项目标识

  // ========== Issue 操作 ==========
  getIssue(id: number): Promise<TrackedIssue>;
  listIssues(options?: ListOptions): Promise<TrackedIssue[]>;
  createIssue(options: CreateIssueOptions): Promise<number>;
  updateIssue(id: number, updates: UpdateIssueOptions): Promise<void>;
  addLabel(id: number, label: string): Promise<void>;
  removeLabel(id: number, label: string): Promise<void>;
  addComment(id: number, body: string): Promise<void>;
  linkIssues(sourceId: number, targetId: number, type: LinkType): Promise<void>;

  // ========== MR/PR 操作 ==========
  getMR(id: number): Promise<TrackedMR>;
  listMRs(options?: ListMROptions): Promise<TrackedMR[]>;
  createMR(options: CreateMROptions): Promise<number>;
  mergeMR(id: number, options?: MergeMROptions): Promise<void>;
  approveMR(id: number, options?: ApproveMROptions): Promise<void>;
  closeMR(id: number, options?: CloseMROptions): Promise<void>;
  reopenMR(id: number): Promise<void>;

  // ========== 业务工具方法 ==========
  parseAC(description: string): AcceptanceCriteria | null;
  getRetryCount(issue: TrackedIssue): number;
  detectTargetBranch(issueId: number, explicit?: string): Promise<string>;
  uploadArtifacts(worktreePath: string): Promise<string>;
}
```

#### 1.3 统一类型定义

**TrackedIssue：跨平台 Issue 抽象**

```typescript
export interface TrackedIssue {
  id: number;              // iid (GitLab) / number (GitHub)
  platform: Platform;
  title: string;
  description: string;     // description (GitLab) / body (GitHub)
  labels: string[];
  state: 'opened' | 'closed' | 'merged';
  url: string;             // web_url (GitLab) / html_url (GitHub)
  projectId: string;       // 'group/project' (GitLab) / 'owner/repo' (GitHub)
}
```

**TrackedMR：跨平台 MR/PR 抽象**

```typescript
export interface TrackedMR {
  id: number;
  platform: Platform;
  title: string;
  state: 'opened' | 'merged' | 'closed';
  sourceBranch: string;    // source_branch (GitLab) / head.ref (GitHub)
  targetBranch: string;    // target_branch (GitLab) / base.ref (GitHub)
  url: string;
  projectId: string;
  pipeline?: { status: string };  // GitLab only
}
```

#### 1.4 平台特定实现差异

| 特性 | GitLab | GitHub | AFK 处理方式 |
|------|--------|--------|-------------|
| **ID 类型** | `iid` (项目内) | `number` (仓库内) | 统一为 `id: number` |
| **创建 MR 时添加标签** | API 直接支持 `labels` 参数 | 需要额外调用 `issues.addLabels()` | GitHubClient 内部自动处理 |
| **合并时删除分支** | `removeSourceBranch: true` | 需单独调用 `git.deleteRef()` | 封装在 `mergeMR()` 方法中 |
| **Issue 关联** | 原生 `Issues.link()` API | 通过评论添加 `#123` 引用 | GitHubClient 降级为评论实现 |
| **认证方式** | Token / glab CLI | Token / gh CLI | 优先环境变量，降级到 CLI |


#### 1.5 工厂模式与平台检测

**createTrackerClient() 工厂函数** (`src/lib/client-factory.ts`)

```typescript
export async function createTrackerClient(): Promise<TrackerProvider> {
  const { platform } = await detectProject();

  if (platform === 'github') {
    return await createGitHubClient();
  } else {
    return await createGitLabClient();
  }
}
```

**平台检测逻辑** (`src/lib/core/tracker/detect.ts`)

1. 检查环境变量 `TRACKER_PLATFORM`
2. 解析 git remote URL：
   - `github.com` → GitHub
   - `gitlab.com` 或自托管 GitLab → GitLab
3. 检查配置文件：
   - `.gitlab-ci.yml` → GitLab
   - `.github/workflows/` → GitHub
4. 默认降级到 GitLab

**认证方式优先级：**

GitLab:
```bash
GITLAB_TOKEN → glab CLI (getGlabToken()) → Error
GITLAB_PROJECT_ID → git remote 检测 (detectGitLabProject()) → Error
```

GitHub:
```bash
GITHUB_TOKEN / GH_TOKEN → gh auth token → Error
GITHUB_REPOSITORY → git remote 检测 (detectGitHubRepo()) → Error
```

---

### 2. 核心模块关系

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLI 入口层                                │
│  src/commands/tracker.ts  - afk issue/mr 命令                   │
│  src/commands/implement.ts - afk implement <iid> 自动化流程     │
│  src/commands/scheduler.ts - afk scheduler start/stop/status    │
└────────────────────────────┬────────────────────────────────────┘
                             │
                ┌────────────┴────────────┐
                │   createTrackerClient() │
                │   (client-factory.ts)   │
                └────────────┬────────────┘
                             │
        ┌────────────────────┴────────────────────┐
        ↓                                         ↓
┌───────────────────┐                    ┌───────────────────┐
│  GitLabClient     │                    │  GitHubClient     │
│  (TrackerProvider)│                    │  (TrackerProvider)│
└────────┬──────────┘                    └────────┬──────────┘
         │                                        │
         ↓                                        ↓
┌─────────────────────────────────────────────────────────────────┐
│                      WorkflowRunner                              │
│  src/lib/workflows.ts                                           │
│  - 协调 TmuxClient, WorktreeManager, Signal I/O                 │
│  - 实现 launch → wait signal → autoWrapup 流程                  │
└────────────┬────────────────────────────────────────────────────┘
             │
    ┌────────┼────────┬──────────────┐
    ↓        ↓        ↓              ↓
┌─────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐
│ Tmux    │ │ Worktree │ │ Signal   │ │ Scheduler  │
│ Client  │ │ Manager  │ │ I/O      │ │ (BullMQ)   │
└─────────┘ └──────────┘ └──────────┘ └────────────┘
```

**模块职责：**

| 模块 | 文件路径 | 职责 |
|------|---------|------|
| **TrackerProvider** | `src/lib/core/tracker/types.ts` | 定义跨平台操作接口 |
| **GitLabClient** | `src/lib/core/gitlab/index.ts` | GitLab API 封装 |
| **GitHubClient** | `src/lib/core/github/client.ts` | GitHub API 封装 |
| **WorkflowRunner** | `src/lib/workflows.ts` | 信号驱动的工作流编排 |
| **TmuxClient** | `src/lib/core/tmux/tmux.ts` | tmux 会话管理、信号等待 |
| **WorktreeManager** | `src/lib/core/git/worktree.ts` | git worktree 生命周期管理 |
| **Signal I/O** | `src/lib/core/io/signal.ts` | `.afk-signal.json` 读写 |
| **Scheduler** | `src/lib/scheduler.ts` | BullMQ 任务队列与调度 |

---

### 3. 信号驱动机制 (Signal-Driven Workflow)

#### 3.1 信号协议设计

**为什么需要信号？**

Agent 在 tmux 会话中运行，与调度系统隔离。信号文件提供：
1. **异步通信**：Agent 完成阶段性工作后通知系统
2. **状态持久化**：进程崩溃后可恢复状态
3. **类型安全**：通过 Zod schema 验证信号格式

**信号类型定义** (`src/lib/schemas.ts`)

```typescript
export type Signal =
  | GoalCompleteSignal    // Agent 完成目标
  | ACResultSignal        // AC 验收结果
  | TimeoutSignal         // 硬超时触发
  | ContextHighSignal     // 上下文接近上限
  | IdleSignal            // Agent 空闲
  | HandoffReadySignal;   // 上下文切换准备完成

export interface GoalCompleteSignal {
  type: 'goal_complete';
  timestamp: string;
  summary: string;
  sha?: string;         // 完成时的 commit SHA
}

export interface ACResultSignal {
  type: 'ac_result';
  timestamp: string;
  result: 'PASS' | 'FAIL';
  summary: string;
  details?: string[];
}

export interface ContextHighSignal {
  type: 'context_high';
  timestamp: string;
  tokens: number;       // 当前上下文 token 数
  summary: string;
}
```

#### 3.2 信号 I/O 实现

**写信号** (`src/lib/core/io/signal.ts`)

```typescript
export async function writeSignal(signal: Signal, dir: string): Promise<void> {
  const signalPath = join(dir, '.afk-signal.json');
  
  // 原子写入：先写临时文件，再 rename
  const tempPath = `${signalPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(signal, null, 2), 'utf-8');
  await fs.rename(tempPath, signalPath);
}
```

**读信号** (带 Zod 验证)

```typescript
export async function readSignal(dir: string): Promise<Signal | null> {
  const signalPath = join(dir, '.afk-signal.json');
  
  try {
    const content = await fs.readFile(signalPath, 'utf-8');
    const data = JSON.parse(content);
    return SignalSchema.parse(data);  // Zod 验证
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
```


#### 3.3 信号等待策略

**TmuxClient.waitForAnySignal()** - 多信号类型等待

```typescript
async waitForAnySignal(
  session: string,
  window: string,
  signalTypes: Signal['type'][],
  worktreeDir: string,
  timeout: number = 300000
): Promise<Signal | null> {
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    const signal = await readSignal(worktreeDir);
    if (signal && signalTypes.includes(signal.type)) {
      return signal;
    }
    await this.sleep(2000);  // 2s 轮询间隔
  }
  
  return null;  // 超时返回 null
}
```

**兼容性：支持 legacy 文本标记**

系统同时支持旧版文本标记 (`GOAL_COMPLETE`) 和新版 JSON 信号：

```typescript
// 在 tmux pane 内容中检测文本标记
const content = await this.capturePane(session, window);
if (content.includes('GOAL_COMPLETE')) {
  return { type: 'goal_complete', timestamp: new Date().toISOString() };
}
```

---

### 4. WorkflowRunner 工作流引擎

#### 4.1 完整工作流

**源码位置：** `src/lib/workflows.ts`

```
WorkflowRunner.run()
  │
  ├─ Step 1: 获取 Issue 和 AC
  │    └─ gitlab.getIssue(iid)
  │    └─ gitlab.parseAC(description)
  │
  ├─ Step 2: 创建 worktree
  │    └─ worktree.create(iid, baseBranch)
  │    └─ worktree.updateStatus(iid, 'active')
  │
  ├─ Step 3: 启动 tmux 会话
  │    └─ tmux.createSession(session, wt.path, 'claude')
  │    └─ tmux.waitForPrompt(session, 'main', 30s)
  │    └─ tmux.sendGoal(session, 'main', goalText)
  │
  ├─ Step 4: 启动 watchdog (硬超时保护)
  │    └─ startWatchdog(session, hardTimeoutMs, iid)
  │
  ├─ Step 5: 发布启动评论
  │    └─ gitlab.createLaunchComment(iid, {...})
  │    └─ gitlab.addLabel(iid, `session::${session}`)
  │
  ├─ Step 6: 等待信号
  │    └─ tmux.waitForAnySignal(['goal_complete', 'timeout', 'context_high'])
  │
  └─ Step 7: 处理结果
       ├─ goal_complete → autoWrapup()
       │    ├─ pushBranch(worktreePath)
       │    ├─ tmux.sendResumeWithAC(session, acItems)
       │    ├─ waitForSignal('ac_result')
       │    └─ if PASS: createMR() → gitlab.addLabel('stage::qa')
       │    └─ if FAIL: handleACFail() → retry or escalate
       │
       ├─ timeout → handleTimeout()
       │    ├─ tmux.capturePane() → 保存日志
       │    ├─ gitlab.addComment('timeout event')
       │    └─ gitlab.addLabel('mode::timeout')
       │
       └─ context_high → handleHandoff()
            ├─ tmux.sendKeys('/resume 总结进度')
            ├─ waitForSignal('handoff_ready')
            ├─ gitlab.addComment('handoff event + snapshot')
            └─ gitlab.addLabel('handoff::active')
```

#### 4.2 关键方法实现

**autoWrapup() - AC 验收与 MR 创建**

```typescript
private async autoWrapup(
  iid: number,
  worktreePath: string,
  session: string,
  targetBranch: string,
  maxRetries: number,
  sha?: string
): Promise<{ success: boolean; url?: string }> {
  // 1. 推送分支到 origin
  await this.pushBranch(worktreePath);

  // 2. 向 Agent 发送 AC 检查指令
  const issue = await this.gitlab.getIssue(iid);
  const ac = this.gitlab.parseAC(issue.description);
  if (ac) {
    await this.tmux.sendResumeWithAC(session, 'main', ac.items);
  }

  // 3. 等待 AC 结果信号
  const acSignal = await this.tmux.waitForSignal(
    session, 'main', 'ac_result', worktreePath, TIMEOUTS.AC_SIGNAL_TIMEOUT
  );

  // 4. AC 失败 → 重试或升级
  if (!acSignal || acSignal.result !== 'PASS') {
    return this.handleACFail(iid, worktreePath, session, targetBranch, maxRetries);
  }

  // 5. AC 通过 → 创建 MR
  const mrUrl = await this.createMR(iid, worktreePath, targetBranch);
  
  // 6. 查询 MR 状态和 pipeline (GitLab only)
  const mrId = this.extractMRIdFromUrl(mrUrl);
  if (mrId) {
    const mr = await this.gitlab.getMR(mrId);
    console.log(`✓ MR status: ${mr.state}, pipeline: ${mr.pipeline?.status || 'N/A'}`);
  }

  // 7. 更新 Issue 标签
  await this.gitlab.addLabel(iid, 'stage::qa');
  await this.gitlab.removeLabel(iid, 'stage::afk-in-progress');

  return { success: true, url: mrUrl };
}
```

**handleACFail() - 重试机制**

```typescript
private async handleACFail(
  iid: number,
  worktreePath: string,
  session: string,
  targetBranch: string,
  maxRetries: number
): Promise<{ success: boolean; url?: string }> {
  const retryCount = await this.gitlab.incrementRetryCount(iid);

  if (retryCount > maxRetries) {
    await this.gitlab.addLabel(iid, 'mode::hitl');
    await this.gitlab.addComment(iid, 
      `❌ AC check failed after ${maxRetries} retries. Escalating to human review.`
    );
    await this.worktree.updateStatus(iid, 'failed');
    return { success: false };
  }

  // 重新启动新 session (Agent 可见之前的 commits + Next: trailer)
  console.log(`AC failed, retry ${retryCount}/${maxRetries}. Re-launching...`);
  await this.tmux.killSession(session);

  const newSession = `${session}-retry-${retryCount}`;
  return this.run({ iid, session: newSession, targetBranch, maxRetries });
}
```

**startWatchdog() - 硬超时保护**

```typescript
private startWatchdog(session: string, hardTimeoutMs: number, iid: number): void {
  // 使用 setsid 启动完全独立的进程
  spawn('setsid', [
    'bash', '-c',
    `sleep ${hardTimeoutMs / 1000} && ` +
    `tmux kill-session -t "${session}" 2>/dev/null || true; ` +
    `echo "WATCHDOG:${iid}:${session}:${hardTimeoutMs}" >> "${this.logDir}/watchdog.log"`,
  ], {
    stdio: 'ignore',
    detached: true,
    cwd: process.cwd(),
  }).unref();  // 不阻塞父进程退出
}
```


---

### 5. WorktreeManager - Git Worktree 管理

#### 5.1 设计目标

**问题：** 多个 Issue 同时开发时，频繁切换分支会导致：
- 未提交变更冲突
- 上下文丢失
- 构建状态污染

**解决方案：** 为每个 Issue 创建独立 git worktree，实现物理隔离。

**源码位置：** `src/lib/core/git/worktree.ts`

#### 5.2 Worktree 生命周期

```typescript
export interface Worktree {
  iid: number;              // Issue ID
  path: string;             // 物理路径 (e.g., /tmp/afk-worktrees/issue-123)
  branch: string;           // 分支名 (e.g., afk-issue-123)
  sessionId?: string;       // 关联的 tmux session
  createdAt: Date;
  status: WorktreeStatus;   // 'active' | 'completed' | 'failed'
  markerStatus?: MarkerStatus;  // 'crashed' | 'success' (from .afk/ markers)
}
```

**创建 Worktree**

```typescript
async create(iid: number, baseBranch: string, baseDir?: string): Promise<Worktree> {
  const branch = `afk-issue-${iid}`;
  const worktreeDir = baseDir || '/tmp/afk-worktrees';
  const path = join(worktreeDir, `issue-${iid}`);
  
  await fs.mkdir(worktreeDir, { recursive: true });
  
  // git worktree add -b afk-issue-123 /tmp/afk-worktrees/issue-123 main
  await this.git.raw(['worktree', 'add', '-b', branch, path, baseBranch]);
  
  const worktree: Worktree = {
    iid,
    path,
    branch,
    createdAt: new Date(),
    status: 'active'
  };
  
  await this.saveWorktree(worktree);
  return worktree;
}
```

**状态追踪**

Worktree 状态持久化到 `.afk/worktrees.json`：

```typescript
export interface WorktreeState {
  worktrees: Record<number, Worktree>;
}

private async saveState(state: WorktreeState): Promise<void> {
  const dir = join(this.stateFilePath, '..');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    this.stateFilePath,
    JSON.stringify(state, null, 2),
    'utf-8'
  );
  this._stateCache = null;
}
```

#### 5.3 清理策略

**自动清理条件：**
- Marker 状态为 `crashed` 或 `success`
- 无活跃 tmux session
- 超过 7 天未活动 (stale)

```typescript
async clean(options: CleanOptions = {}): Promise<{ deleted: number; skipped: number }> {
  const { markerStatus, olderThanDays, stale = false, dryRun = false } = options;
  const worktrees = await this.list();

  // 1. 检查是否有活跃 session
  const activeIids = new Set<number>();
  for (const wt of worktrees) {
    if (await this.hasActiveSession(wt)) {
      activeIids.add(wt.iid);
    }
  }

  // 2. 计算最后活动时间
  const ageMap = new Map<number, number>();
  if (stale || olderThanDays) {
    for (const wt of worktrees) {
      const lastActivity = await this.lastActivityAt(wt);
      ageMap.set(wt.iid, Date.now() - lastActivity.getTime());
    }
  }

  // 3. 清理符合条件的 worktree
  let deleted = 0, skipped = 0;
  for (const wt of worktrees) {
    if (activeIids.has(wt.iid)) { skipped++; continue; }
    
    // 检查 marker 状态过滤
    if (markerStatus && wt.markerStatus !== markerStatus) {
      skipped++;
      continue;
    }
    
    // 检查 stale 过滤 (7天)
    if (stale) {
      const ms = ageMap.get(wt.iid) ?? 0;
      if (ms < 7 * 86400 * 1000) { skipped++; continue; }
    }
    
    if (dryRun) {
      console.log(`  would remove: #${wt.iid} [${wt.markerStatus || wt.status}]`);
      deleted++;
    } else {
      await this.cleanup(wt.iid, true);
      deleted++;
    }
  }
  
  return { deleted, skipped };
}
```

---

### 6. TmuxClient - 会话管理与信号等待

#### 6.1 核心职责

**源码位置：** `src/lib/core/tmux/tmux.ts`

1. **会话管理**：创建、检测、销毁 tmux session
2. **命令发送**：向 session 发送 `/goal`, `/resume` 等指令
3. **内容捕获**：读取 tmux pane 输出用于状态检测
4. **信号等待**：轮询 `.afk-signal.json` 文件和 pane 内容

#### 6.2 关键方法

**创建 Session 并发送 Goal**

```typescript
async createSession(name: string, dir: string, command: string = 'claude'): Promise<TmuxSession> {
  const window = 'main';
  await this.exec([
    'new-session',
    '-d',              // detached (后台运行)
    '-s', name,        // session name
    '-n', window,      // window name
    '-c', dir,         // working directory
    command,           // 启动命令 (默认 'claude')
  ]);
  return { name, window, dir };
}

async sendGoal(session: string, window: string, goalText: string): Promise<void> {
  // 1. 等待 claude prompt (❯) 出现
  const hasPrompt = await this.waitForPrompt(session, window);
  if (!hasPrompt) throw new Error('Timeout waiting for claude prompt');

  // 2. 发送 /goal 命令
  await this.exec(['send-keys', '-t', `${session}:${window}`, '--', '/goal']);
  await this.exec(['send-keys', '-t', `${session}:${window}`, 'Space']);
  await this.sleep(300);

  // 3. 逐行发送 goal 内容
  const lines = goalText.split('\n');
  for (const line of lines) {
    await this.exec(['send-keys', '-t', `${session}:${window}`, '--', line]);
    await this.exec(['send-keys', '-t', `${session}:${window}`, 'C-m']);
    await this.sleep(100);
  }
}
```

**等待 Prompt**

```typescript
async waitForPrompt(session: string, window: string, timeout: number = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const content = await this.capturePane(session, window, { lines: 5, history: 5 });
    if (content.includes('❯')) return true;  // 检测 claude prompt
    await this.sleep(1000);
  }
  return false;
}
```

**捕获 Pane 内容**

```typescript
async capturePane(session: string, window: string, options: TmuxCaptureOptions = {}): Promise<string> {
  const { lines = 50, history = 100 } = options;
  const target = `${session}:${window}`;
  
  try {
    const output = await this.exec([
      'capture-pane',
      '-t', target,
      '-p',                    // print to stdout
      '-S', `-${history}`,     // 从倒数第 N 行开始
    ]);
    
    const allLines = output.split('\n');
    return allLines.slice(-lines).join('\n');  // 返回最后 N 行
  } catch {
    return '(capture failed)';
  }
}
```

**发送 AC 检查指令**

```typescript
async sendResumeWithAC(session: string, window: string, acItems: string[]): Promise<void> {
  await this.sendKeys(session, window, '/resume');
  await this.sleep(300);
  
  // 发送 AC 检查指令
  await this.sendKeys(session, window, '请运行以下验收条件（AC）检查，完成后创建信号文件：');
  await this.sendKeys(session, window, 'cat > .afk-signal.json <<EOF');
  await this.sendKeys(session, window, 
    `{"type":"ac_result","result":"PASS或FAIL","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","summary":"<检查总结>"}`
  );
  await this.sendKeys(session, window, 'EOF');
  await this.sendKeys(session, window, '（或直接回复：AC_RESULT: PASS 或 AC_RESULT: FAIL）');
  
  // 发送 AC 条目
  for (const item of acItems) {
    await this.sendKeys(session, window, item);
    await this.sleep(100);
  }
}
```


---

### 7. Scheduler - BullMQ 任务调度

#### 7.1 设计理念

**问题：** 多个 Issue 同时触发时，需要：
- 并发控制（避免资源耗尽）
- 优先级调度
- 失败重试
- 状态持久化

**解决方案：** 基于 BullMQ + Redis 实现分布式任务队列。

**源码位置：** `src/lib/scheduler.ts`

#### 7.2 架构组件

```typescript
export interface TaskData {
  iid: number;           // Issue ID
  priority: number;      // 优先级 (1-10, 越大越高)
  baseBranch: string;    // 目标分支
  createdAt: Date;
  retries: number;       // 已重试次数
}

export class Scheduler {
  private queue: Queue<TaskData>;
  private worker: Worker<TaskData> | null = null;
  private redis: Redis;
  private gitlab: GitLabClient;
  private maxConcurrent: number;  // 最大并发数
}
```

#### 7.3 启动调度器

```typescript
async start(): Promise<void> {
  console.log(`🚀 Starting scheduler (max concurrent: ${this.maxConcurrent})...`);

  this.startTime = Date.now();

  // 创建 BullMQ Worker
  this.worker = new Worker<TaskData>(
    'afk-tasks',
    async (job: Job<TaskData>) => {
      return this.processTask(job);
    },
    {
      connection: this.redis,
      concurrency: this.maxConcurrent,  // 并发控制
    }
  );

  // Worker 事件监听
  this.worker.on('completed', (job) => {
    console.log(`✅ Task ${job.id} completed (issue #${job.data.iid})`);
  });

  this.worker.on('failed', (job, err) => {
    console.error(`❌ Task ${job?.id} failed (issue #${job?.data.iid}):`, err.message);
  });

  this.worker.on('active', (job) => {
    console.log(`▶️  Task ${job.id} started (issue #${job.data.iid})`);
  });

  console.log('✅ Scheduler started');
  console.log('   Listening for tasks...');
}
```

#### 7.4 入队任务

```typescript
async enqueue(iid: number, priority: number = 5, baseBranch: string = 'main'): Promise<string> {
  const job = await this.queue.add(
    `issue-${iid}`,
    {
      iid,
      priority,
      baseBranch,
      createdAt: new Date(),
      retries: 0,
    },
    {
      priority,                  // BullMQ 优先级
      attempts: 3,               // 最大重试次数
      backoff: {
        type: 'exponential',     // 指数退避
        delay: TIMEOUTS.JOB_RETRY_DELAY,  // 初始延迟 5000ms
      },
    }
  );

  console.log(`📥 Enqueued task for issue #${iid} (priority: ${priority})`);
  return job.id || '';
}
```

#### 7.5 任务处理

```typescript
private async processTask(job: Job<TaskData>): Promise<void> {
  const { iid, baseBranch } = job.data;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing issue #${iid}`);
  console.log(`${'='.repeat(60)}\n`);

  const runner = new WorkflowRunner(this.gitlab);

  try {
    // 运行完整 signal-driven workflow
    const result = await runner.run({
      iid,
      session: `afk-${iid}`,
      targetBranch: baseBranch,
      baseBranch,
    });

    if (!result.success) {
      throw new Error('Workflow did not complete');
    }

    // 更新标签
    await this.gitlab.removeLabel(iid, 'stage::ready-for-implement');
    await this.gitlab.removeLabel(iid, 'stage::afk-in-progress');
    await this.gitlab.addLabel(iid, 'stage::qa');

  } catch (error) {
    // 更新重试计数
    job.data.retries++;
    await job.updateData(job.data);
    throw error;  // 重新抛出触发 BullMQ 重试
  }
}
```

#### 7.6 轮询 GitLab

**自动发现 ready-for-implement 的 Issue**

```typescript
async pollGitLab(
  labels: string[] = ['stage::ready-for-implement'],
  excludeLabels: string[] = []
): Promise<number> {
  console.log('🔍 Polling GitLab for ready issues...');

  const issues = await this.gitlab.listIssues({
    labels,
    state: 'opened',
  });

  let enqueued = 0;
  let skipped = 0;

  for (const issue of issues) {
    // 1. 跳过排除标签的 Issue
    if (excludeLabels.some(l => issue.labels.includes(l))) {
      skipped++;
      continue;
    }

    // 2. 检查是否已入队 (O(1) 查询)
    const job = await this.queue.getJob(`issue-${issue.id}`);
    if (job) continue;

    // 3. 检查前置条件
    const check = await checkIssuePreconditions(this.gitlab, issue.id);
    if (!check.ok) {
      console.log(`   #${issue.id}: skipped (${check.reason})`);
      skipped++;
      continue;
    }

    // 4. 计算优先级并入队
    const priority = this.calculatePriority(issue.labels);
    await this.enqueue(issue.id, priority);
    enqueued++;
  }

  console.log(`   Found ${issues.length} ready issues: ${enqueued} enqueued, ${skipped} skipped`);
  return enqueued;
}

private calculatePriority(labels: string[]): number {
  if (labels.includes('priority::high')) return 10;
  if (labels.includes('priority::medium')) return 5;
  if (labels.includes('priority::low')) return 1;
  return 5; // default
}
```

---

### 8. CLI 命令系统

#### 8.1 Lazy-Loader 机制

**问题：** 加载所有命令依赖会拖慢 CLI 启动速度。

**解决方案：** 命令注册时不加载实际模块，执行时动态 import。

**源码位置：** `src/index.ts`

```typescript
import { Command } from 'commander';

const program = new Command();

program
  .name('afk')
  .description('Unified CLI for AFK workflow')
  .version('0.1.0');

// Lazy-load tracker commands
const trackerCommand = program
  .command('issue')
  .description('Issue operations (auto-detects platform)');

trackerCommand
  .command('get')
  .argument('<id>', 'Issue ID')
  .action(async (id: string) => {
    const { registerTrackerCommands } = await import('./commands/tracker.js');
    // 实际执行逻辑在动态导入的模块中
  });

program.parse();
```

#### 8.2 核心命令

| 命令 | 文件 | 说明 |
|------|-----|------|
| `afk issue <cmd>` | `src/commands/tracker.ts` | Issue CRUD 操作 |
| `afk mr <cmd>` | `src/commands/tracker.ts` | MR/PR 操作 |
| `afk implement <iid>` | `src/commands/implement.ts` | 单次执行 workflow |
| `afk scheduler start` | `src/commands/scheduler.ts` | 启动调度器 |
| `afk scheduler status` | `src/commands/scheduler.ts` | 查看队列状态 |
| `afk worktree list` | `src/commands/worktree.ts` | 列出所有 worktree |
| `afk worktree clean` | `src/commands/worktree.ts` | 清理 worktree |

#### 8.3 平台自动检测示例

```typescript
// src/commands/tracker.ts
issue
  .command('get')
  .description('Get issue by ID')
  .argument('<id>', 'Issue ID')
  .option('--json', 'Output as JSON')
  .action(async (id: string, options) => {
    try {
      // 自动检测平台并创建 client
      const client = await createTrackerClient();
      
      const issue = await client.getIssue(parseInt(id));

      if (options.json) {
        console.log(JSON.stringify(issue, null, 2));
      } else {
        console.log(chalk.bold(`#${issue.id}: ${issue.title}`));
        console.log(chalk.gray(`Platform: ${issue.platform}`));
        console.log(chalk.gray(`State: ${issue.state}`));
        console.log(chalk.gray(`Labels: ${issue.labels.join(', ')}`));
        console.log(chalk.gray(`URL: ${issue.url}`));
        console.log();
        console.log(chalk.dim(issue.description));
      }
    } catch (error) {
      handleCommandError(error);
    }
  });
```


---

## 技术栈

### 依赖库

| 库 | 版本 | 用途 |
|----|------|------|
| **@gitbeaker/node** | ^35.8.0 | GitLab API 客户端 |
| **@octokit/rest** | ^22.0.1 | GitHub API 客户端 |
| **bullmq** | ^5.1.0 | Redis 任务队列 |
| **ioredis** | ^5.3.2 | Redis 客户端 |
| **simple-git** | ^3.22.0 | Git 命令封装 |
| **commander** | ^12.0.0 | CLI 框架 |
| **chalk** | ^5.3.0 | 终端颜色 |
| **zod** | ^3.22.4 | 运行时类型验证 |
| **ink** | ^7.1.1 | React-based TUI 框架 |
| **express** | ^4.18.2 | Dashboard HTTP 服务 |

### 外部工具依赖

| 工具 | 用途 | 检测逻辑 |
|------|-----|---------|
| **tmux** | 会话隔离 | `TmuxClient.isAvailable()` |
| **git** | Worktree 管理 | simple-git 调用 |
| **glab** | GitLab CLI 认证 | `getGlabToken()` |
| **gh** | GitHub CLI 认证 | `execSync('gh auth token')` |
| **redis-server** | 任务队列 | BullMQ 连接检查 |

### 环境要求

```bash
# 必需
Node.js >= 18
git >= 2.25 (支持 worktree)
tmux >= 3.0

# 可选 (用于 Scheduler)
redis-server >= 6.0

# 可选 (用于认证)
glab CLI (GitLab)
gh CLI (GitHub)
```

---

## 数据流

### 完整执行流程

```
┌──────────────────────────────────────────────────────────────┐
│ 1. CLI / Scheduler 触发                                       │
│    afk implement <iid>  或  scheduler.enqueue(iid)           │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         ↓
┌──────────────────────────────────────────────────────────────┐
│ 2. WorkflowRunner.run(iid, session, targetBranch)            │
│                                                               │
│    ├─ createTrackerClient() → GitLabClient / GitHubClient   │
│    ├─ tracker.getIssue(iid)                                  │
│    ├─ tracker.parseAC(description)                           │
│    └─ worktree.create(iid, baseBranch)                       │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         ↓
┌──────────────────────────────────────────────────────────────┐
│ 3. Tmux Session 启动                                          │
│    tmux.createSession(session, wt.path, 'claude')            │
│    tmux.sendGoal(session, goalText)                          │
│                                                               │
│    同时启动 watchdog (detached process):                      │
│    sleep ${timeout} && tmux kill-session -t ${session}       │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         ↓
┌──────────────────────────────────────────────────────────────┐
│ 4. Agent 执行 (在 tmux session 内)                            │
│                                                               │
│    Agent 工作循环:                                            │
│    ├─ 读取 AC → 实现功能 → 提交 commits                      │
│    ├─ 完成后写入信号: writeSignal({                          │
│    │    type: 'goal_complete',                               │
│    │    timestamp: '...',                                    │
│    │    sha: 'abc123',                                       │
│    │    summary: 'Implemented feature X'                     │
│    │  })                                                     │
│    └─ 或检测到 context_high → writeSignal({type: ...})      │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         ↓
┌──────────────────────────────────────────────────────────────┐
│ 5. WorkflowRunner 轮询信号                                    │
│    tmux.waitForAnySignal(['goal_complete', 'timeout', ...])  │
│                                                               │
│    每 2 秒:                                                   │
│    ├─ signal = readSignal(wt.path)                           │
│    ├─ if signal.type in expected_types: return signal        │
│    └─ else: continue polling                                 │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         ↓
┌──────────────────────────────────────────────────────────────┐
│ 6. 信号处理分支                                               │
│                                                               │
│ ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐ │
│ │ goal_complete   │  │ timeout         │  │ context_high  │ │
│ └────────┬────────┘  └────────┬────────┘  └───────┬───────┘ │
│          │                    │                    │         │
│          ↓                    ↓                    ↓         │
│   autoWrapup()         handleTimeout()      handleHandoff() │
└──────────┬──────────────────────────────────────────────────┘
           │
           ↓
┌──────────────────────────────────────────────────────────────┐
│ 7. autoWrapup 流程                                            │
│                                                               │
│    ├─ pushBranch(wt.path)                                    │
│    ├─ tmux.sendResumeWithAC(session, acItems)                │
│    ├─ tmux.waitForSignal('ac_result')                        │
│    │                                                          │
│    ├─ if ac_result.result === 'PASS':                        │
│    │    ├─ createMR(iid, wt.path, targetBranch)              │
│    │    ├─ tracker.addLabel(iid, 'stage::qa')                │
│    │    └─ return { success: true, url: mrUrl }              │
│    │                                                          │
│    └─ if ac_result.result === 'FAIL':                        │
│         ├─ tracker.incrementRetryCount(iid)                  │
│         ├─ if retryCount > maxRetries:                       │
│         │    └─ tracker.addLabel(iid, 'mode::hitl')          │
│         └─ else:                                             │
│              └─ run() again with new session                 │
└──────────────────────────────────────────────────────────────┘
```

### 信号流向

```
Agent (tmux session)                WorkflowRunner              TrackerProvider
      │                                   │                            │
      │ 1. writeSignal({                  │                            │
      │      type: 'goal_complete'        │                            │
      │    })                             │                            │
      ├──────────────────────────────────>│                            │
      │                                   │                            │
      │                                   │ 2. readSignal()            │
      │                                   │    (polling every 2s)      │
      │                                   │                            │
      │                                   │ 3. pushBranch()            │
      │                                   │    ├─ git push origin ...  │
      │                                   │                            │
      │                                   │ 4. createMR()              │
      │                                   ├───────────────────────────>│
      │                                   │                            │
      │                                   │ 5. addLabel('stage::qa')   │
      │                                   ├───────────────────────────>│
      │                                   │                            │
      │ 6. tmux session killed            │                            │
      │    (workflow completed)           │                            │
      │                                   │                            │
```

---

## 扩展点

### 1. 添加新平台支持 (例如 Bitbucket)

**步骤：**

1. **定义平台类型**

```typescript
// src/lib/core/tracker/types.ts
export type Platform = 'gitlab' | 'github' | 'bitbucket';
```

2. **实现 TrackerProvider**

```typescript
// src/lib/core/bitbucket/client.ts
import { Bitbucket } from 'bitbucket';
import type { TrackerProvider, TrackedIssue, TrackedMR } from '../tracker/types';

export class BitbucketClient implements TrackerProvider {
  readonly platform: 'bitbucket' = 'bitbucket';
  readonly projectId: string;
  private client: Bitbucket;

  constructor(config: { workspace: string; repo: string; token: string }) {
    this.projectId = `${config.workspace}/${config.repo}`;
    this.client = new Bitbucket({
      auth: { token: config.token },
    });
  }

  async getIssue(id: number): Promise<TrackedIssue> {
    const issue = await this.client.repositories.getIssue({
      workspace: this.workspace,
      repo_slug: this.repo,
      issue_id: id,
    });
    
    return {
      id: issue.data.id,
      platform: 'bitbucket',
      title: issue.data.title,
      description: issue.data.content?.raw || '',
      labels: issue.data.labels?.map(l => l.name) || [],
      state: issue.data.state === 'open' ? 'opened' : 'closed',
      url: issue.data.links.html.href,
      projectId: this.projectId,
    };
  }

  // ... 实现其他接口方法
}
```

3. **更新平台检测**

```typescript
// src/lib/core/tracker/detect.ts
export async function detectProject(): Promise<{ platform: Platform; projectId?: string }> {
  const remoteUrl = await getRemoteUrl();
  
  if (remoteUrl.includes('github.com')) return { platform: 'github' };
  if (remoteUrl.includes('bitbucket.org')) return { platform: 'bitbucket' };
  if (remoteUrl.includes('gitlab.com')) return { platform: 'gitlab' };
  
  // ...
}
```

4. **注册到工厂**

```typescript
// src/lib/client-factory.ts
export async function createTrackerClient(): Promise<TrackerProvider> {
  const { platform } = await detectProject();

  switch (platform) {
    case 'github':
      return await createGitHubClient();
    case 'bitbucket':
      return await createBitbucketClient();
    case 'gitlab':
    default:
      return await createGitLabClient();
  }
}
```


### 2. 添加新信号类型

**场景：** 需要 Agent 在某个阶段通知系统进行特殊处理。

**步骤：**

1. **定义信号类型**

```typescript
// src/lib/schemas.ts
export interface CustomSignal {
  type: 'custom_event';
  timestamp: string;
  payload: {
    key: string;
    value: any;
  };
}

export type Signal =
  | GoalCompleteSignal
  | ACResultSignal
  | TimeoutSignal
  | ContextHighSignal
  | CustomSignal;  // 新增

export const SignalSchema = z.discriminatedUnion('type', [
  GoalCompleteSignalSchema,
  ACResultSignalSchema,
  TimeoutSignalSchema,
  ContextHighSignalSchema,
  CustomSignalSchema,  // 新增
]);
```

2. **在 WorkflowRunner 中处理**

```typescript
// src/lib/workflows.ts
async run(options: RunnerOptions): Promise<{ success: boolean; url?: string }> {
  // ...
  
  const signal = await this.tmux.waitForAnySignal(
    session,
    'main',
    ['goal_complete', 'timeout', 'context_high', 'custom_event'],  // 添加新信号
    wt.path,
    completionTimeoutMs
  );

  switch (signal.type) {
    case 'goal_complete':
      return this.autoWrapup(...);
    
    case 'custom_event':
      return this.handleCustomEvent(signal as CustomSignal);  // 新增处理器
    
    // ...
  }
}

private async handleCustomEvent(signal: CustomSignal): Promise<{ success: boolean }> {
  // 自定义处理逻辑
  console.log('Custom event received:', signal.payload);
  // ...
}
```

3. **更新 Agent skill 指令**

在 `~/.claude/skills/afk-*.md` 中添加信号创建指令。

---

### 3. 自定义 Workflow 步骤

**场景：** 在 AC 检查前需要运行自定义验证脚本。

**步骤：**

1. **扩展 WorkflowRunner**

```typescript
// src/lib/workflows.ts
export interface RunnerOptions {
  iid: number;
  session: string;
  targetBranch: string;
  baseBranch?: string;
  maxRetries?: number;
  hardTimeoutMs?: number;
  completionTimeoutMs?: number;
  customValidation?: (worktreePath: string) => Promise<boolean>;  // 新增钩子
}

private async autoWrapup(...): Promise<{ success: boolean; url?: string }> {
  await this.pushBranch(worktreePath);

  // 运行自定义验证
  if (options.customValidation) {
    const isValid = await options.customValidation(worktreePath);
    if (!isValid) {
      await this.gitlab.addComment(iid, '❌ Custom validation failed');
      return { success: false };
    }
  }

  // 继续 AC 检查
  const issue = await this.gitlab.getIssue(iid);
  // ...
}
```

2. **在命令中使用**

```typescript
// src/commands/implement.ts
const result = await runner.run({
  iid,
  session: `afk-${iid}`,
  targetBranch,
  customValidation: async (worktreePath) => {
    // 运行自定义脚本
    const { execSync } = await import('child_process');
    try {
      execSync('./scripts/validate.sh', { cwd: worktreePath });
      return true;
    } catch {
      return false;
    }
  },
});
```

---

## 配置

### 环境变量

**GitLab 配置：**

```bash
# 必需
GITLAB_TOKEN=glpat-xxxxxxxxxxxxx          # GitLab Personal Access Token
GITLAB_PROJECT_ID=group/project           # 项目路径或数字 ID

# 可选
GITLAB_URL=https://gitlab.company.com     # 自托管实例 URL (默认: https://gitlab.com)
AFK_TARGET_BRANCH=main                    # 默认目标分支 (默认: main)
```

**GitHub 配置：**

```bash
# 必需
GITHUB_TOKEN=ghp_xxxxxxxxxxxxx            # GitHub Personal Access Token
GITHUB_REPOSITORY=owner/repo              # 仓库完整路径

# 可选 (使用 GH_TOKEN 也可)
GH_TOKEN=ghp_xxxxxxxxxxxxx
```

**平台覆盖：**

```bash
TRACKER_PLATFORM=gitlab    # 强制使用指定平台 (gitlab | github)
```

**Scheduler 配置：**

```bash
REDIS_HOST=localhost       # Redis 服务器地址
REDIS_PORT=6379            # Redis 端口
AFK_MAX_CONCURRENT=3       # 最大并发任务数
```

**Timeout 配置：**

```bash
AFK_HARD_TIMEOUT=3600000           # 硬超时 (ms, 默认 60min)
AFK_COMPLETION_TIMEOUT=300000      # 完成超时 (ms, 默认 5min)
AFK_AC_SIGNAL_TIMEOUT=120000       # AC 信号超时 (ms, 默认 2min)
```

### 状态文件

AFK 维护以下状态文件：

| 文件路径 | 内容 | 用途 |
|---------|------|------|
| `.afk/worktrees.json` | Worktree 状态 | 追踪所有 worktree 的生命周期 |
| `<worktree>/.afk-signal.json` | 当前信号 | Agent 与系统通信 |
| `<worktree>/.afk/CRASHED` | 空标记文件 | 标记 session 异常退出 |
| `<worktree>/.afk/SUCCESS` | 空标记文件 | 标记 workflow 成功完成 |
| `~/.claude/logs/afk/timeout-*.log` | Timeout 日志 | 超时时的 session 快照 |
| `~/.claude/logs/afk/watchdog.log` | Watchdog 日志 | Watchdog 触发记录 |

---

## 常见问题

### 1. 平台检测失败

**症状：** `Error: Could not detect platform`

**原因：**
- Git remote URL 格式不标准
- 不在 git 仓库中
- 未配置环境变量

**解决：**
```bash
# 方法 1: 显式指定平台
export TRACKER_PLATFORM=gitlab  # 或 github

# 方法 2: 检查 git remote
git remote -v
# 确保 URL 包含 gitlab.com 或 github.com

# 方法 3: 手动配置
export GITLAB_PROJECT_ID=your-group/your-project
# 或
export GITHUB_REPOSITORY=owner/repo
```

### 2. Worktree 清理失败

**症状：** `Error: Worktree has uncommitted changes`

**原因：** Worktree 中有未提交的修改

**解决：**
```bash
# 查看 worktree 状态
afk worktree list

# 强制清理
afk worktree clean --force

# 或手动进入 worktree 处理
cd /tmp/afk-worktrees/issue-123
git status
git add . && git commit -m "WIP"
```

### 3. Tmux Session 孤儿进程

**症状：** Session 存在但 worktree 已删除

**解决：**
```bash
# 列出所有 tmux session
tmux list-sessions

# 手动清理特定 session
tmux kill-session -t afk-123

# 或使用 AFK 清理
afk worktree prune
```

### 4. Redis 连接失败

**症状：** `Error: connect ECONNREFUSED 127.0.0.1:6379`

**原因：** Redis 未启动

**解决：**
```bash
# macOS
brew services start redis

# Linux
sudo systemctl start redis-server

# 检查连接
redis-cli ping
# 应返回: PONG
```

### 5. 认证失败

**症状：** `Error: GITLAB_TOKEN required` 或 `Error: GITHUB_TOKEN required`

**原因：** 未配置 Token 或 CLI 未认证

**解决：**

GitLab:
```bash
# 方法 1: 环境变量
export GITLAB_TOKEN=glpat-xxxxxxxxxxxxx

# 方法 2: glab CLI
glab auth login
```

GitHub:
```bash
# 方法 1: 环境变量
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxx

# 方法 2: gh CLI
gh auth login
```

---

## 性能优化

### 1. Worktree 位置

默认 `/tmp/afk-worktrees` 可能在重启后丢失。生产环境建议：

```bash
# 创建持久化目录
mkdir -p ~/.cache/afk/worktrees

# 配置环境变量
export AFK_WORKTREE_DIR=~/.cache/afk/worktrees
```

### 2. Redis 持久化

生产环境启用 Redis AOF 持久化：

```bash
# redis.conf
appendonly yes
appendfsync everysec
```

### 3. 并发控制

根据机器资源调整：

```bash
# 低配机器 (2核4G)
export AFK_MAX_CONCURRENT=1

# 中等机器 (4核8G)
export AFK_MAX_CONCURRENT=3

# 高配机器 (8核16G+)
export AFK_MAX_CONCURRENT=5
```

### 4. Timeout 调优

根据任务复杂度调整：

```bash
# 简单任务 (API 集成、文档更新)
export AFK_HARD_TIMEOUT=1800000  # 30min

# 复杂任务 (新功能、重构)
export AFK_HARD_TIMEOUT=7200000  # 120min
```

---

## 安全考虑

### 1. Token 管理

- **不要** 将 Token 提交到 Git
- 使用 `.env` 文件或 Secret Manager
- 定期轮换 Token
- 最小权限原则 (只授予必需的 scope)

**GitLab Token Scopes:**
```
api              # 完整 API 访问
write_repository # Push 代码
```

**GitHub Token Scopes:**
```
repo             # 完整仓库访问
workflow         # GitHub Actions (如需 CI 集成)
```

### 2. Worktree 隔离

- Worktree 路径应在用户目录下，避免权限问题
- 定期清理 stale worktree (>7 天未活动)
- 避免在 worktree 中存储敏感数据

### 3. Redis 访问控制

生产环境启用 Redis 认证：

```bash
# redis.conf
requirepass your-strong-password

# 环境变量
export REDIS_PASSWORD=your-strong-password
```

---

## 测试

### 单元测试

```bash
npm test
```

### 集成测试

```bash
# 启动 Redis
redis-server &

# 测试平台检测
afk issue list

# 测试 worktree 创建
afk implement 123 --dry-run

# 测试调度器
afk scheduler start &
afk scheduler status
afk scheduler stop
```

---

## 贡献指南

### 目录结构

```
src/
├── commands/          # CLI 命令入口
│   ├── tracker.ts
│   ├── implement.ts
│   └── scheduler.ts
├── lib/
│   ├── core/         # 核心模块
│   │   ├── tracker/  # 跨平台抽象
│   │   ├── gitlab/   # GitLab 实现
│   │   ├── github/   # GitHub 实现
│   │   ├── tmux/     # Tmux 封装
│   │   ├── git/      # Git worktree
│   │   └── io/       # 信号 I/O
│   ├── workflows.ts  # 工作流引擎
│   ├── scheduler.ts  # 任务调度
│   └── client-factory.ts
└── index.ts          # CLI 入口
```

### 提交规范

使用 Conventional Commits：

```bash
feat(tracker): add Bitbucket support
fix(workflows): handle timeout signal correctly
refactor(scheduler): extract priority calculation
docs(architecture): update signal protocol
```

### 添加新功能

1. 在 `src/lib/core/` 添加核心逻辑
2. 在 `src/commands/` 添加 CLI 命令
3. 更新类型定义 (`src/lib/core/tracker/types.ts`)
4. 添加单元测试
5. 更新文档

---

## 参考资料

### API 文档

- [GitLab API](https://docs.gitlab.com/ee/api/)
- [GitHub REST API](https://docs.github.com/en/rest)
- [BullMQ](https://docs.bullmq.io/)
- [simple-git](https://github.com/steveukx/git-js)

### 相关项目

- [glab](https://github.com/profclems/glab) - GitLab CLI
- [gh](https://github.com/cli/cli) - GitHub CLI
- [tmux](https://github.com/tmux/tmux) - Terminal multiplexer

---

## 版本历史

### v0.1.0 (2024-01)

**首次发布：**
- 跨平台抽象层 (GitLab + GitHub)
- 信号驱动工作流
- Worktree 管理
- BullMQ 调度器
- CLI 命令系统

**已知限制：**
- 仅支持单机部署
- Redis 未启用集群模式
- Dashboard 功能未完成

---

## License

MIT

