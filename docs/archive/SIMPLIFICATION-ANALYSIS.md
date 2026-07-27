# AFK 系统简化分析

## 当前复杂度

| 指标 | 数值 |
|------|------|
| 总脚本数 | 15 个 |
| 总代码行数 | 3,217 行 |
| 核心脚本 | 7 个 (1,784 行) |
| 库文件 | 8 个 (1,433 行) |

## 复杂度来源分析

### 1. **功能重复/冗余** 🔴

#### 问题 A: GitLab 操作分散
```
gitlab-safe.sh (210 行) - API 包装层
gitlab.sh (163 行) - 业务逻辑层
gitlab.sh (287 行，核心) - 另一个 GitLab 脚本？
```
**分析**: 有 3 个 GitLab 相关文件，可能有重复

#### 问题 B: Agent 脚本多个
```
claude-agent.sh (551 行)
codex-agent.sh (86 行)
agent-common.sh (93 行)
```
**分析**: codex-agent 是否必需？可能合并

#### 问题 C: 清理逻辑分散
```
cleanup.sh (187 行) - 运行时清理
cleanup-worktrees.sh (341 行) - 批量清理
```
**分析**: 528 行清理代码，可能简化

### 2. **过度设计** 🟡

#### 问题 D: Audit 系统
```
audit.sh (165 行) - Trace ID 管理
```
**功能**:
- Trace ID 生成
- Trace ID 读取
- Trace ID 标签管理

**质疑**: 
- Trace ID 真的必需吗？
- Issue IID 已经是唯一标识
- Session ID 也能跟踪

**简化方案**: 移除 Trace ID，直接用 Issue IID + Session ID

#### 问题 E: Workflow 文件太大
```
workflow.sh (459 行) - AC 检查、Handoff、Progress
```
**分析**: 单文件承担太多职责

#### 问题 F: Preconditions 独立文件
```
preconditions.sh (62 行)
```
**质疑**: 只有 62 行，是否需要独立文件？

### 3. **真正必需的核心** 🟢

#### 核心流程（不可简化）
```
claude-agent.sh (551 行) - 主流程，必需
workflow.sh (459 行) - AC/Handoff，必需
gitlab-safe.sh (210 行) - API 容错，必需（刚加的 P0）
tmux.sh (111 行) - Tmux 封装，必需
```
**小计**: 1,331 行（核心中的核心）

#### 可选但有用
```
scheduler.sh (328 行) - 自动调度，可选
cleanup-worktrees.sh (341 行) - 维护工具，可选
```

## 简化建议

### 方案 A: 激进简化（-40% 代码量）

#### 1. 移除 Trace ID 系统 ❌ 165 行
```bash
# 直接用 Issue IID + Session ID
TRACKING_ID="${issue_iid}:${session}:${window}"

# GitLab comment 中包含
Session: afk-sess123:w1
Issue: #42
```

#### 2. 合并 GitLab 脚本 ❌ 287 行
```bash
# 只保留 gitlab-safe.sh
# 将 gitlab.sh 的业务逻辑内联到调用处
# 删除冗余的第三个 gitlab.sh
```

#### 3. 内联 Preconditions ❌ 62 行
```bash
# 直接在 claude-agent.sh 中检查
# 或在 SKILL.md 中让 agent 检查
```

#### 4. 简化 Cleanup ❌ 200 行
```bash
# 合并 cleanup.sh 和 cleanup-worktrees.sh
# 只保留必需的清理逻辑
# 移除过于详细的诊断信息
```

#### 5. 移除 Codex Agent ❌ 86 行
```bash
# 如果不使用 Codex，直接删除
```

**预期**: 3,217 → 1,917 行 (-40%)

### 方案 B: 温和简化（-20% 代码量）

#### 1. 简化 Audit ❌ 80 行
- 保留基本 Trace ID
- 移除复杂的标签同步逻辑
- 简化函数接口

#### 2. 合并重复的 GitLab 脚本 ❌ 150 行
- 检查是否有第三个 gitlab.sh
- 移除重复代码

#### 3. 内联小文件 ❌ 100 行
- preconditions.sh → 内联
- agent-common.sh → 内联
- git.sh → 内联

#### 4. 简化日志 ❌ 50 行
- 减少冗余日志
- 合并相似日志函数

**预期**: 3,217 → 2,537 行 (-21%)

### 方案 C: 保守优化（-10% 代码量）

#### 1. 移除未使用的功能
- 检查 dbfork.sh 是否使用
- 检查 codex-agent.sh 是否使用

#### 2. 合并重复代码
- 提取公共函数
- 移除 copy-paste 代码

#### 3. 简化注释
- 移除过于冗长的注释
- 保留关键注释

**预期**: 3,217 → 2,895 行 (-10%)

## 具体简化点

### 🔴 高优先级（影响大，风险小）

#### 1. 检查并删除未使用的脚本
```bash
# 检查是否使用
grep -r "dbfork" afk-implement/ --exclude-dir=.git
grep -r "codex-agent" afk-implement/ --exclude-dir=.git

# 如果未使用，直接删除
```

#### 2. 移除 Trace ID 系统
```bash
# audit.sh 整个文件可删除
# Issue IID 已经足够跟踪

# 简化为：
# - Issue: #42
# - Session: afk-sess123:w1
# - 唯一标识: 42:afk-sess123:w1
```

#### 3. 内联 preconditions.sh
```bash
# 62 行，直接放到 claude-agent.sh 开头
check_preconditions() {
  # AC 存在
  # base:: label 存在
  # 无 blocker
}
```

### 🟡 中优先级（需要重构）

#### 4. 合并 cleanup 逻辑
```bash
# 当前：
# cleanup.sh - 运行时清理（trap）
# cleanup-worktrees.sh - 批量清理工具

# 简化后：
# cleanup.sh - 包含所有清理逻辑
#   - cleanup_on_exit() - trap 调用
#   - cleanup_batch() - 批量清理
```

#### 5. 拆分 workflow.sh
```bash
# 当前：459 行单文件
# 简化后：保持单文件，但简化每个函数
# - auto_wrapup: 200 行 → 150 行
# - trigger_handoff: 100 行 → 60 行
```

### 🟢 低优先级（锦上添花）

#### 6. 简化日志格式
```bash
# 当前：大量重复的日志代码
# 简化：统一日志函数

log_event() {
  local event=$1; shift
  echo "[$(date)] [$event] $*" | tee -a "$LOG_FILE"
}
```

## 推荐方案

### 🎯 两阶段简化

#### Phase 1: 快速清理（1-2 小时）
1. 删除未使用脚本（dbfork.sh, codex-agent.sh?）
2. 移除 Trace ID 系统（audit.sh）
3. 内联小文件（preconditions.sh, agent-common.sh）

**预期**: -400 行，-12%

#### Phase 2: 深度重构（4-6 小时）
4. 合并 GitLab 脚本
5. 合并 cleanup 逻辑
6. 简化 workflow.sh

**预期**: -600 行，-19%

**总计**: 3,217 → 2,217 行 (-31%)

## 权衡分析

### 简化的好处
- ✅ 代码更易维护
- ✅ 新人更容易理解
- ✅ Bug 更少（代码少）
- ✅ 测试更容易

### 简化的风险
- ⚠️ 可能破坏现有功能
- ⚠️ 需要充分测试
- ⚠️ 失去一些可扩展性

### 建议
**从 Phase 1 开始**：删除明确未使用的部分，风险最小，收益最大。

要我开始 Phase 1 的快速清理吗？
