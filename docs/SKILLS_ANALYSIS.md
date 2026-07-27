# afk Skills Platform-Specific Command Analysis

## Executive Summary

分析了所有 15 个 afk skills，识别出使用平台特定命令的 skills 并完成更新。

## 已完成更新

### 1. ✅ afk-to-prd
- **更新内容：** 使用统一命令 `afk issue create/comment/update-labels`
- **状态：** 已完成并提交 (commit 940f7a9)

### 2. ✅ afk-to-issues
- **更新内容：** 使用统一命令 `afk issue create/link/update-labels`
- **状态：** 已完成并提交 (commit 940f7a9)

### 3. ✅ afk-scheduler
- **更新内容：** 
  - 替换 `glab issue list` 为 `afk issue list --json`
  - 更新字段名 `iid` → `id` (统一接口使用 id)
  - 更新前置条件说明，支持 GitHub/GitLab
  - 更新反模式说明，使用平台无关术语
- **状态：** 已完成更新 (2024-07-27)

## 待实现 MR 统一命令后更新

### 4. ⚠️ afk-qa
- **使用的命令：** `glab mr merge <mr-iid> --delete-source-branch` (Line 78)
- **状态：** 等待 `afk mr merge` 命令实现
- **优先级：** 中

### 5. ⚠️ afk-prototype  
- **使用的命令：** `glab mr create --target-branch <target_branch> --draft --yes` (Line 42)
- **状态：** 等待 `afk mr create` 命令实现
- **优先级：** 中

## 无需更新

以下 skills 不使用平台特定命令：
- afk-implement
- afk-do
- afk-debug
- afk-pipeline
- afk-hand-off
- afk-grill-me
- afk-grill-me-context
- afk-pipeline-deck
- afk-pipeline-deck-v1
- afk-research (仅在说明文本中提及)

## 技术细节

### afk-scheduler 更新对比

**Before:**
```bash
glab issue list --label "mode::afk" --state opened --output json | \
  jq '.[] | {iid, title, labels}'
```

**After:**
```bash
afk issue list --label mode::afk --state opened --json | \
  jq '.[] | {id, title, labels}'
```

### 字段映射变化

| 旧字段 (GitLab) | 新字段 (统一接口) | 说明 |
|----------------|------------------|------|
| `iid` | `id` | Issue ID |
| `state: "opened"` | `state: "opened"` | 保持一致 |
| `web_url` | `url` | URL 字段 |

## 下一步计划

### Phase 1: MR 统一命令实现
需要在 `src/commands/tracker.ts` 中添加：
```typescript
// afk mr 命令组
const mr = program
  .command('mr')
  .description('MR/PR operations (auto-detects platform)');

mr.command('create') // 创建 MR/PR
mr.command('list')   // 列出 MR/PR  
mr.command('merge')  // 合并 MR/PR
mr.command('get')    // 获取 MR/PR 详情
```

### Phase 2: TrackerProvider 接口扩展
需要在 `src/lib/core/tracker/types.ts` 中添加：
```typescript
interface TrackerProvider {
  // 已有
  getMR(id: number): Promise<TrackedMR>;
  listMRs(options?: ListMROptions): Promise<TrackedMR[]>;
  
  // 需要添加
  createMR(options: CreateMROptions): Promise<number>;
  mergeMR(id: number, options?: MergeMROptions): Promise<void>;
}
```

### Phase 3: 完成剩余 skills 更新
- 更新 afk-qa 使用 `afk mr merge`
- 更新 afk-prototype 使用 `afk mr create`

## 文件位置

- Skills 目录: `~/.claude/skills/afk-*/`
- 统一命令实现: `src/commands/tracker.ts`
- 客户端工厂: `src/lib/client-factory.ts`
- 类型定义: `src/lib/core/tracker/types.ts`

## 测试验证

已验证统一命令在当前项目中正常工作：
```bash
$ afk issue list -s all
Found 1 issues:
  #15 Dashboard 启动动画功能 [documentation, enhancement]
```

## 更新时间线

- 2024-07-27: 完成 afk-to-prd, afk-to-issues 更新
- 2024-07-27: 完成 afk-scheduler 更新
- 待定: afk-qa, afk-prototype (等待 MR 命令实现)
