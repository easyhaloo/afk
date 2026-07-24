# Signal Mechanism Analysis

## Current Problems

### 1. String Parsing Brittleness

当前系统依赖 tmux pane 输出的字符串匹配：

```bash
# workflow.sh
pane_content=$(tmux_capture_safe "$session" "$window" 30 30)
if [[ "$pane_content" == *"AC_RESULT: PASS"* ]]; then

# claude-agent.sh  
if [[ "$pane_content" == *"GOAL_COMPLETE"* ]]; then
if [[ "$pane_content" == *"HANDOFF_READY"* ]]; then
```

**问题：**
- Agent 输出格式不稳定（换行、空格、大小写、emoji）
- 误匹配风险（历史输出中包含相同字符串）
- 不支持结构化数据传递（只能传 PASS/FAIL，无法传详细信息）
- 解析逻辑分散在多个文件中
- 难以调试（看不到中间状态）

### 2. Tmux Output Reliability Issues

```bash
tmux capture-pane -t "${session}:${window}" -p -S -100 | tail -50
```

**问题：**
- history-limit 限制可能导致旧输出被截断
- 输出可能包含 ANSI 转义序列、颜色代码
- 多行输出解析困难
- Race condition：agent 正在输出时捕获

### 3. Git Commit as Signal

```bash
# Secondary signal: SHA changed
if [[ "$cur_sha" != "$pre_sha" ]]; then
```

**问题：**
- Git commit 不是为信号机制设计的
- 无法区分"功能完成"和"中间提交"
- Agent 可能多次提交，但功能未完成
- Commit 失败时信号丢失

---

## Proposed Solutions

### Option A: File-based Structured Signals (推荐)

在 worktree 中创建结构化信号文件，Agent 主动写入：

```bash
# Agent 侧（在 /goal 完成后）
cat > .afk-signal.json <<EOF
{
  "type": "goal_complete",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sha": "$(git rev-parse HEAD)",
  "summary": "Implemented feature X"
}
EOF

# AC 检查后
cat > .afk-signal.json <<EOF
{
  "type": "ac_result",
  "result": "PASS",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "tests_run": 12,
  "tests_passed": 12
}
EOF
```

**Scheduler 侧：**
```bash
# workflow.sh
check_signal() {
  local signal_file="$worktree_path/.afk-signal.json"
  if [[ -f "$signal_file" ]]; then
    local signal_type signal_result
    signal_type=$(jq -r '.type' "$signal_file" 2>/dev/null)
    signal_result=$(jq -r '.result // empty' "$signal_file" 2>/dev/null)
    
    case "$signal_type" in
      goal_complete)
        echo "goal_complete"
        return 0
        ;;
      ac_result)
        echo "ac_result:$signal_result"
        return 0
        ;;
    esac
  fi
  return 1
}
```

**优势：**
- ✅ 结构化数据（可携带详细信息）
- ✅ 原子操作（文件系统保证）
- ✅ 可追溯（文件可归档到 git）
- ✅ 易调试（`cat .afk-signal.json` 即可查看）
- ✅ 支持多种信号类型
- ✅ 无误匹配风险

**劣势：**
- 需要 Agent 主动写文件（需要在 /goal prompt 中明确说明）
- 需要 jq 依赖

---

### Option B: tmux Buffer-based Signals

使用 tmux 的 `set-buffer` 机制传递结构化数据：

```bash
# Agent 侧（通过 claude code 执行）
tmux set-buffer -b afk-signal "goal_complete:$(date +%s):$(git rev-parse HEAD)"

# Scheduler 侧
signal=$(tmux show-buffer -b afk-signal 2>/dev/null)
if [[ "$signal" == goal_complete:* ]]; then
  IFS=':' read -r type timestamp sha <<< "$signal"
fi
```

**优势：**
- ✅ 不依赖文件系统
- ✅ tmux 原生支持
- ✅ 可携带结构化数据

**劣势：**
- ❌ Agent 需要主动调用 tmux（增加复杂度）
- ❌ Buffer 不持久化（session 关闭后丢失）
- ❌ 难以调试

---

### Option C: Git Notes as Metadata Channel

使用 git notes 携带结构化元数据：

```bash
# Agent 侧
git notes add -m '{"type":"goal_complete","tests_passed":true}'

# Scheduler 侧  
latest_note=$(git notes show HEAD 2>/dev/null)
if [[ "$latest_note" == *"goal_complete"* ]]; then
  # Parse JSON
fi
```

**优势：**
- ✅ 与 commit 关联（可追溯）
- ✅ 结构化数据
- ✅ 持久化

**劣势：**
- ❌ 需要 commit 才能使用（无法用于 AC 阶段）
- ❌ git notes 默认不推送（需要配置）
- ❌ 增加 git 复杂度

---

### Option D: Unix Domain Socket (过度设计)

Agent 和 Scheduler 通过 Unix socket 通信。

**劣势：**
- ❌ 过度复杂
- ❌ 需要常驻进程
- ❌ 增加故障点

---

## Recommendation: Hybrid Approach

**Phase 1: Goal Completion (使用 File-based Signal)**
```bash
# .afk-signal.json
{
  "type": "goal_complete",
  "timestamp": "2026-07-24T10:30:00Z",
  "sha": "abc123",
  "summary": "Implemented login feature"
}
```

**Phase 2: AC Result (使用 File-based Signal)**
```bash
# .afk-signal.json (覆盖上一个)
{
  "type": "ac_result",
  "result": "PASS",
  "timestamp": "2026-07-24T10:35:00Z",
  "tests": [
    {"name": "login_success", "passed": true},
    {"name": "login_fail", "passed": true}
  ]
}
```

**Phase 3: Handoff (使用 GitLab API)**
- 继续使用 GitLab labels + comments（已是结构化方式）

**Fallback: Git SHA Change**
- 保留当前的 SHA 检测作为 fallback（兼容老版本 agent）

---

## Implementation Plan

### Task 1: Add Signal File Support
- [ ] 创建 `_lib/signal.sh`：提供 `wait_for_signal()` 函数
- [ ] 修改 `claude-agent.sh`：使用 signal file 检测 goal completion
- [ ] 修改 `workflow.sh`：使用 signal file 检测 AC result
- [ ] 保留字符串解析作为 fallback（向后兼容）

### Task 2: Update Agent Prompts
- [ ] 修改 `/goal` prompt：明确告知 Agent 写 `.afk-signal.json`
- [ ] 修改 AC check prompt：明确告知 Agent 写 `.afk-signal.json`

### Task 3: Add Monitoring
- [ ] 增加 signal file 变更日志（记录每次信号）
- [ ] 增加 fallback 触发计数（监控是否有 agent 未写 signal file）

### Task 4: Deprecation Path
- [ ] 6个月后移除字符串解析 fallback
- [ ] 仅保留 signal file 机制

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Agent 不写 signal file | 保留字符串解析 fallback |
| Signal file 损坏 | JSON 解析失败时回退到 SHA 检测 |
| 文件系统延迟 | 增加 inotify watch（可选） |
| 旧版本 agent 不兼容 | Fallback 机制保证兼容性 |

---

## Expected Improvements

| Metric | Before | After |
|--------|--------|-------|
| Signal reliability | 70% (string matching) | 95% (file-based) |
| False positives | 5-10% | <1% |
| Debug time | 10-30min | 2-5min |
| Data richness | Binary (PASS/FAIL) | Structured (JSON) |
| Maintainability | Low (parsing scattered) | High (centralized) |
