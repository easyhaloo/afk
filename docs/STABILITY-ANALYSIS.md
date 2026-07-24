# AFK 流程稳定性分析报告

## 执行概要

| 维度 | 评分 | 说明 |
|------|------|------|
| **错误处理** | 🟡 7/10 | 基本覆盖，但仍有改进空间 |
| **容错能力** | 🟡 6/10 | 部分场景未处理 |
| **可恢复性** | 🟢 8/10 | 有清理和重试机制 |
| **数据持久化** | 🟢 9/10 | GitLab 作为 SSOT |
| **监控能力** | 🟡 7/10 | 有日志，缺少告警 |
| **整体稳定性** | 🟡 7.4/10 | 中等偏上，需改进 |

---

## 1. 单点故障分析 (SPOF)

### 1.1 外部依赖

#### ❌ **GitLab API (Critical SPOF)**
```
当前状态: 单点依赖，无降级方案
风险: GitLab API 故障 → 整个流程停止
影响: 无法获取 issue、无法更新状态、无法发送 comment
```

**问题：**
- 所有状态管理依赖 GitLab
- glab CLI 故障会导致流程中断
- 网络问题会导致超时

**缓解措施（当前）：**
- ✅ gitlab-safe.sh 分级错误处理
- ✅ glab_critical/important/optional 三级容错
- ✅ 日志记录所有 API 调用
- ❌ **缺少离线模式或本地缓存**

**建议改进：**
```bash
# 1. 添加本地状态缓存
mkdir -p ~/.claude/cache/afk/
echo "$issue_iid:stage::afk-in-progress" >> ~/.claude/cache/afk/state.cache

# 2. 定期同步到 GitLab
sync_state_to_gitlab() {
  while IFS=: read -r iid state; do
    glab_optional issue update "$iid" --label "$state" 2>/dev/null || {
      # 失败后保持在缓存，下次重试
      echo "$iid:$state" >> ~/.claude/cache/afk/state.pending
    }
  done < ~/.claude/cache/afk/state.cache
}

# 3. 启动时恢复未同步状态
restore_pending_state() {
  [[ -f ~/.claude/cache/afk/state.pending ]] && sync_state_to_gitlab
}
```

#### ⚠️ **Tmux (Important Dependency)**
```
当前状态: Session 管理依赖 tmux
风险: Tmux 崩溃 → 正在运行的 session 丢失
影响: 需要重启 session，可能丢失部分进度
```

**问题：**
- Tmux server 重启会清空所有 sessions
- 无法恢复崩溃的 pane 状态
- 依赖 tmux capture-pane 获取输出

**缓解措施（当前）：**
- ✅ Cleanup trap 机制
- ✅ Session snapshots 上传到 GitLab
- ❌ **缺少 tmux session 持久化**

**建议改进：**
```bash
# 使用 tmux-resurrect 持久化 sessions
# 或者定期保存 session 状态
save_tmux_session() {
  local session=$1 window=$2
  tmux capture-pane -t "${session}:${window}" -p -S -5000 \
    > ~/.claude/cache/afk/session-${session}-${window}.snapshot
}

# 每 5 分钟自动保存
while true; do
  save_tmux_session "$session" "$window"
  sleep 300
done &
```

#### ⚠️ **Git Worktree**
```
当前状态: 每个 issue 使用独立 worktree
风险: 磁盘空间耗尽 → 无法创建新 worktree
影响: 新 issues 无法启动
```

**问题：**
- 旧 worktrees 可能未清理（cleanup 失败时）
- 无磁盘空间监控
- 无自动清理策略

**缓解措施（当前）：**
- ✅ cleanup-worktrees.sh 批量清理工具
- ❌ **缺少自动清理机制**

**建议改进：**
```bash
# 1. 启动前检查磁盘空间
check_disk_space() {
  local worktree_dir=".claude/worktrees"
  local available=$(df -P "$worktree_dir" | awk 'NR==2 {print $4}')
  local required=$((1024 * 1024))  # 1GB
  
  if (( available < required )); then
    log_error "Insufficient disk space: ${available}KB available, ${required}KB required"
    # 自动清理旧 worktrees
    cleanup-worktrees.sh clean --stale --days 7 --dry-run=false
    return 1
  fi
}

# 2. Scheduler 定期清理
# 在 scheduler.sh 中添加
cleanup_old_worktrees() {
  log_info "Cleaning up old worktrees..."
  "${SCRIPT_DIR}/cleanup-worktrees.sh" clean --stale --days 3
}

# 每小时清理一次
(while true; do
  cleanup_old_worktrees
  sleep 3600
done) &
```

### 1.2 内部组件

#### ❌ **Scheduler 单实例**
```
当前状态: 只支持单个 scheduler 实例
风险: Scheduler 崩溃 → 停止自动触发
影响: 新 issues 无法自动处理
```

**问题：**
- 无健康检查
- 无自动重启
- 无多实例支持（可能重复触发）

**建议改进：**
```bash
# 1. 添加 PID 文件和锁机制
LOCK_FILE="/tmp/afk-scheduler.lock"

acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local pid=$(cat "$LOCK_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      log_error "Another scheduler is running (PID: $pid)"
      exit 1
    else
      log_warn "Stale lock file found, removing..."
      rm -f "$LOCK_FILE"
    fi
  fi
  echo $$ > "$LOCK_FILE"
  trap "rm -f $LOCK_FILE" EXIT
}

# 2. 添加健康检查端点
start_health_check() {
  local port=8765
  while true; do
    echo "OK" | nc -l "$port" 2>/dev/null || true
  done &
}

# 3. Systemd watchdog
# 在 systemd service 中添加
[Service]
WatchdogSec=60
Restart=always
RestartSec=10
```

---

## 2. 故障场景分析

### 2.1 网络故障

#### 场景 A: GitLab API 暂时不可达
```
触发: 网络抖动、GitLab 维护
影响: API 调用失败
当前处理: glab_optional/important 容忍失败，glab_critical 中断流程
```

**问题：**
- glab_critical 失败会立即中断
- 无重试机制
- 无指数退避

**改进建议：**
```bash
# 在 gitlab-safe.sh 中添加重试逻辑
glab_critical_with_retry() {
  local max_retries=3
  local retry_delay=5
  local attempt=0
  
  while (( attempt < max_retries )); do
    if glab_critical "$@"; then
      return 0
    fi
    
    attempt=$((attempt + 1))
    if (( attempt < max_retries )); then
      log_warn "glab_critical failed, retry ${attempt}/${max_retries} in ${retry_delay}s..."
      sleep "$retry_delay"
      retry_delay=$((retry_delay * 2))  # 指数退避
    fi
  done
  
  log_error "glab_critical failed after ${max_retries} retries"
  return 1
}
```

#### 场景 B: GitLab API rate limit
```
触发: 短时间内大量 API 调用
影响: 429 Too Many Requests
当前处理: 失败，无特殊处理
```

**改进建议：**
```bash
# 添加 rate limit 检测和退避
handle_rate_limit() {
  local response=$1
  if echo "$response" | grep -q "429"; then
    local retry_after=$(echo "$response" | grep -i "retry-after" | cut -d: -f2)
    retry_after=${retry_after:-60}
    log_warn "Rate limited, waiting ${retry_after}s..."
    sleep "$retry_after"
    return 1
  fi
  return 0
}
```

### 2.2 Agent 异常

#### 场景 C: Claude 卡住（无响应）
```
触发: Agent 死循环、等待用户输入、bug
影响: Session 永久挂起
当前处理: 30 分钟 idle timeout + probe
```

**问题：**
- Idle timeout 太长（30 分钟）
- Probe 可能无效（agent 不回复）
- 无强制 kill 机制

**改进建议：**
```bash
# 在 claude-agent.sh 中添加硬超时
HARD_TIMEOUT=${AFK_HARD_TIMEOUT:-3600}  # 1 小时硬超时

(
  sleep "$HARD_TIMEOUT"
  if tmux has-session -t "${session}:${window}" 2>/dev/null; then
    log_error "Hard timeout reached (${HARD_TIMEOUT}s), force killing session"
    
    # 保存现场
    tmux capture-pane -t "${session}:${window}" -p -S -1000 \
      > "${LOG_DIR}/timeout-${issue_iid}-$(date +%s).log"
    
    # 强制 kill
    tmux kill-window -t "${session}:${window}" 2>/dev/null
    
    # 标记为 timeout
    glab_important issue update "$issue_iid" --label "mode::timeout"
    glab_important issue note "$issue_iid" --message "⏱️ **Hard timeout** reached (${HARD_TIMEOUT}s). Session force killed."
  fi
) &
TIMEOUT_PID=$!

# 正常完成时取消硬超时
cleanup_timeout() {
  kill "$TIMEOUT_PID" 2>/dev/null || true
}
trap cleanup_timeout EXIT
```

#### 场景 D: Agent 回复格式错误
```
触发: Agent 没有回复 GOAL_COMPLETE / AC_RESULT: PASS
影响: 流程卡在等待信号
当前处理: 180s timeout → UNKNOWN
```

**问题：**
- 依赖 agent 遵守协议
- 无格式验证
- 无提示修正机制

**改进建议：**
```bash
# 检测到超时后，自动提示 agent
if (( elapsed >= wait )); then
  log_warn "Signal timeout, prompting agent..."
  tmux send-keys -t "${session}:${window}" -- "/resume"
  tmux send-keys -t "${session}:${window}" C-m; sleep 0.5
  tmux send-keys -t "${session}:${window}" -- "请明确回复 AC 检查结果："
  tmux send-keys -t "${session}:${window}" C-m
  tmux send-keys -t "${session}:${window}" -- "- 全部通过: AC_RESULT: PASS"
  tmux send-keys -t "${session}:${window}" C-m
  tmux send-keys -t "${session}:${window}" -- "- 有失败: AC_RESULT: FAIL"
  tmux send-keys -t "${session}:${window}" C-m
  
  # 再等 60s
  wait=60
  # ... 继续循环
fi
```

### 2.3 资源耗尽

#### 场景 E: 内存耗尽
```
触发: 多个并发 sessions，每个占用大量内存
影响: OOM killer 杀死进程
当前处理: 无
```

**改进建议：**
```bash
# 在 scheduler.sh 中添加内存检查
check_memory() {
  local available_mb=$(free -m | awk 'NR==2 {print $7}')
  local required_mb=2048  # 每个 session 至少 2GB
  
  if (( available_mb < required_mb )); then
    log_warn "Low memory: ${available_mb}MB available, ${required_mb}MB required"
    return 1
  fi
  return 0
}

# 触发新 session 前检查
if ! check_memory; then
  log_warn "Insufficient memory, waiting for resources..."
  sleep "$POLL_INTERVAL"
  continue
fi
```

#### 场景 F: 文件描述符耗尽
```
触发: 大量 tmux sessions + git worktrees
影响: 无法打开新文件
当前处理: 无
```

**改进建议：**
```bash
# 检查文件描述符
check_fd_limit() {
  local current=$(lsof -p $$ 2>/dev/null | wc -l)
  local limit=$(ulimit -n)
  local usage_percent=$((current * 100 / limit))
  
  if (( usage_percent > 80 )); then
    log_warn "High FD usage: ${current}/${limit} (${usage_percent}%)"
    return 1
  fi
  return 0
}
```

### 2.4 数据一致性

#### 场景 G: GitLab label 与实际状态不一致
```
触发: glab_optional 失败后未更新 label
影响: Scheduler 看到错误的状态
当前处理: 无同步机制
```

**问题：**
- glab_optional 失败静默
- 无状态校验
- 无定期同步

**改进建议：**
```bash
# 添加状态校验函数
verify_issue_state() {
  local iid=$1
  local expected_stage=$2
  
  local actual_stage=$(glab_query issue view "$iid" --output json 2>/dev/null | \
    jq -r '.labels[] | select(startswith("stage::"))' | head -1)
  
  if [[ "$actual_stage" != "$expected_stage" ]]; then
    log_error "State mismatch for issue #${iid}: expected ${expected_stage}, got ${actual_stage}"
    # 尝试修复
    glab_critical issue update "$iid" --label "$expected_stage" --unlabel "$actual_stage"
  fi
}

# 关键节点验证
verify_issue_state "$issue_iid" "stage::afk-in-progress"
```

---

## 3. 恢复能力分析

### 3.1 当前恢复机制

#### ✅ **Cleanup Trap**
```bash
# cleanup.sh
trap 'cleanup_on_exit $?' EXIT ERR INT TERM
```
- ✅ 捕获异常退出
- ✅ 自动清理资源
- ✅ 更新 GitLab 状态
- ⚠️ **但 trap 可能被绕过（kill -9）**

#### ✅ **Retry 机制**
```bash
# AC 失败自动重试（最多 3 次）
if (( retry_count <= max_retries )); then
  # 重新注入 /goal
fi
```
- ✅ 自动重试
- ✅ 递增 retry-count label
- ⚠️ **但无指数退避，可能重复相同错误**

#### ⚠️ **Handoff 机制**
```bash
# Context 超限时 handoff
if [[ "$context_tokens" -ge "${AFK_CONTEXT_THRESHOLD}" ]]; then
  trigger_handoff ...
fi
```
- ✅ 保存进度到 GitLab
- ✅ 新 session 可恢复
- ⚠️ **但依赖 agent 正确回复 HANDOFF_READY**

### 3.2 缺失的恢复机制

#### ❌ **Scheduler 自动重启**
- 当前: 崩溃后不会自动重启
- 建议: 使用 systemd/launchd 的 Restart=always

#### ❌ **Worktree 状态恢复**
- 当前: 崩溃的 worktree 标记 CRASHED，需手动处理
- 建议: 自动检测 CRASHED worktrees 并重试或清理

#### ❌ **部分完成的 MR**
- 当前: MR 创建失败后无重试
- 建议: 定期检查 stage::done 但无 MR 的 issues，补创建 MR

---

## 4. 监控和可观测性

### 4.1 当前监控

#### ✅ **日志记录**
```
~/.claude/logs/afk/
├── scheduler-YYYYMMDD.log       # Scheduler 主日志
├── issue-<iid>.log               # 每个 issue 的详细日志
├── gitlab-api.log                # GitLab API 调用日志
└── archive/                      # 归档日志
```
- ✅ 完整记录
- ✅ 按日期/issue 分类
- ⚠️ **但无自动告警**

#### ✅ **GitLab Audit Trail**
- ✅ 所有事件记录到 comments
- ✅ Labels 跟踪状态
- ✅ Session snapshots
- ⚠️ **但无指标统计**

### 4.2 缺失的监控

#### ❌ **实时告警**
建议添加：
```bash
# 关键错误告警
alert_on_error() {
  local severity=$1
  local message=$2
  
  case "$severity" in
    critical)
      # 发送紧急通知（邮件/Slack/钉钉）
      curl -X POST https://hooks.slack.com/... \
        -d "{\"text\": \"🚨 AFK CRITICAL: ${message}\"}"
      ;;
    warning)
      # 记录到专门的告警日志
      echo "[$(date)] WARNING: ${message}" >> "$LOG_DIR/alerts.log"
      ;;
  esac
}

# 使用
if ! glab_critical issue update "$iid" --label "stage::done"; then
  alert_on_error "critical" "Failed to update issue #${iid} to stage::done"
fi
```

#### ❌ **性能指标**
建议添加：
```bash
# 记录关键指标
record_metric() {
  local metric=$1
  local value=$2
  local timestamp=$(date +%s)
  
  echo "${timestamp},${metric},${value}" >> ~/.claude/metrics/afk.csv
}

# 使用
record_metric "issue_duration" "$total_elapsed"
record_metric "retry_count" "$retry_count"
record_metric "ac_pass_rate" "$((pass_count * 100 / total_count))"
```

#### ❌ **健康检查端点**
建议添加：
```bash
# HTTP 健康检查端点
start_health_endpoint() {
  local port=8765
  
  while true; do
    {
      echo -e "HTTP/1.1 200 OK\r"
      echo -e "Content-Type: application/json\r"
      echo -e "\r"
      jq -n \
        --arg status "healthy" \
        --arg active "$(get_active_sessions)" \
        --arg ready "$(get_ready_issues | wc -l)" \
        '{status: $status, active_sessions: $active, ready_issues: $ready}'
    } | nc -l "$port" 2>/dev/null || true
  done &
}
```

---

## 5. 优先级改进建议

### P0 - 立即修复（影响稳定性）

1. **添加 GitLab API 重试机制** ⏱️ 2h
   - 指数退避重试
   - Rate limit 检测
   - 本地状态缓存

2. **添加硬超时机制** ⏱️ 1h
   - 防止 session 永久挂起
   - 保存现场日志
   - 强制 kill + 标记

3. **Scheduler 锁机制** ⏱️ 1h
   - PID 文件
   - 防止重复运行
   - Stale lock 清理

### P1 - 重要改进（提升可靠性）

4. **磁盘空间检查** ⏱️ 2h
   - 启动前检查
   - 自动清理旧 worktrees
   - 定期清理策略

5. **状态一致性校验** ⏱️ 3h
   - 关键节点验证
   - 自动修复不一致
   - 定期全量同步

6. **Agent 格式提示** ⏱️ 2h
   - 超时后自动提示
   - 格式验证
   - 二次机会

### P2 - 优化改进（提升体验）

7. **实时告警** ⏱️ 4h
   - Slack/邮件集成
   - 告警级别分级
   - 告警日志

8. **性能指标** ⏱️ 3h
   - CSV 格式记录
   - 关键指标统计
   - 趋势分析

9. **健康检查端点** ⏱️ 2h
   - HTTP API
   - Prometheus 指标
   - Grafana 集成

---

## 6. 稳定性评分详细

| 组件 | 稳定性 | 关键问题 | 建议 |
|------|--------|----------|------|
| Scheduler | 🟡 7/10 | 单实例、无锁 | 添加 PID 锁 + 自动重启 |
| Agent Launch | 🟢 8/10 | 依赖 tmux | Tmux session 持久化 |
| Goal Complete | 🟡 7/10 | 信号依赖 | 添加格式提示 + 硬超时 |
| AC Check | 🟡 6/10 | 信号依赖 | 添加格式提示 + 备用检测 |
| Retry | 🟢 8/10 | 无指数退避 | 添加退避策略 |
| Cleanup | 🟢 8/10 | trap 可被绕过 | 添加定期巡检 |
| GitLab API | 🟡 6/10 | 单点依赖 | 添加重试 + 本地缓存 |
| Handoff | 🟡 7/10 | 信号依赖 | 添加超时保护 |
| Worktree | 🟢 8/10 | 磁盘空间 | 添加空间检查 + 自动清理 |
| Logging | 🟢 9/10 | 无告警 | 添加实时告警 |

---

## 7. 结论

### 当前状态
- ✅ **基础稳定性良好**: 有错误处理、cleanup、retry
- ⚠️ **中等可靠性**: 依赖外部服务，部分场景未覆盖
- ❌ **缺少监控告警**: 无实时告警、无指标统计

### 关键风险
1. **GitLab API 单点依赖** - 最大风险，需要重试和缓存
2. **Agent 协议依赖** - 依赖明确信号，需要提示和超时
3. **资源耗尽风险** - 需要检查和清理机制

### 改进路径
1. **Phase 1 (P0)**: 修复关键稳定性问题（~4h）
2. **Phase 2 (P1)**: 提升可靠性（~7h）
3. **Phase 3 (P2)**: 优化监控体验（~9h）

**预期提升**: 7.4/10 → 8.5/10 (Phase 1+2 完成后)
