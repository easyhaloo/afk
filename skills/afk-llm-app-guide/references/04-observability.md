# 可观测性设计

## Trace / Audit / Metrics 三层体系

```
Trace    → 研发调试 / 性能分析 / 链路追踪
Audit    → 合规要求 / 安全审计 / 问题溯源
Metrics  → 业务指标 / 容量规划 / 告警监控
```

## Trace 体系

### 核心Trace事件

```
event: "llm_call"
  - trace_id, session_id, agent_id
  - model
  - input_tokens, output_tokens
  - cache_hit: boolean
  - cache_hit_prefix_tokens: number
  - latency_ms
  - stop_reason: "tool_use" | "end_turn" | "max_tokens" | ...

event: "tool_call"
  - tool_name
  - tool_call_id
  - parameters (sanitized)
  - result_summary（不是完整原始结果）
  - stored_ref: "stored://xxx"
  - latency_ms

event: "tool_result_retrieved"
  - stored_ref
  - original_size_bytes
  - retrieved_for_reason

event: "context_compress"
  - tokens_before
  - tokens_after
  - compressed_messages_count
  - method: "summary" | "discard" | "structured"

event: "system_reminder_add"
  - type: "new_skill" | "skill_change" | "attention"
  - content_preview
  - target_skill

event: "hitl_checkpoint"
  - checkpoint_id
  - decision_point: "tool_approval" | "continue" | "escalate"
  - options_given
  - decision: "approved" | "rejected" | "modified"
  - human_input (脱敏)
  - reasoning
```

### Subagent Trace

```
event: "subagent_spawn"
  - subagent_id
  - task_description
  - isolation_context_size

event: "subagent_complete"
  - subagent_id
  - conclusion_summary
  - stored_context_ref
  - artifacts
```

### Trace 存储结构

```
┌─────────────────────────────────────────────────────────┐
│  TRACE STORE                                             │
│                                                         │
│  tr_abc123:                                             │
│    session_id: "sess_xyz"                             │
│    agent_id: "parent"                                  │
│    events: [                                             │
│      {ts, event: "llm_call", ...},                     │
│      {ts, event: "tool_call", ...},                    │
│      {ts, event: "tool_result_retrieved", ...},         │
│      {ts, event: "context_compress", ...},             │
│      ...                                                │
│    ]                                                     │
│    final_state: {                                       │
│      tokens_in_context,                                 │
│      active_skills,                                     │
│      tools_in_context                                   │
│    }                                                     │
└─────────────────────────────────────────────────────────┘
```

### Trace 原则：存摘要，不存完整原始结果

```
Tool执行结果：
  - 原始结果 → Tool Result Store（外部存储）
  - Trace只存：summary + stored_ref

需要完整结果 → 通过stored_ref查Store
Trace本身不存完整原始结果
```

## Audit 体系

### 合规审计事件

```
event: "hitl_checkpoint"
  - audit_id, timestamp
  - session_id, user_id
  - checkpoint_id
  - decision_point
  - tool (脱敏)
  - parameters (脱敏)
  - presented_to
  - decision
  - reasoning (如果提供)

event: "high_risk_tool"
  - tool_name
  - parameters (脱敏)
  - hitl_triggered: boolean
  - override_by

event: "skill_state_change"
  - skill_name
  - old_state, new_state
  - changed_by: "user" | "system" | "agent"
  - reason

event: "sensitive_data_access"
  - data_type: "pii" | "credential" | "business_secret"
  - tool_name
  - accessed_at
  - user_notified

event: "context_window_exceeded"
  - tokens_at_limit
  - action_taken: "compress" | "truncate" | "session_end"
```

### Audit 日志格式

```json
{
  "audit_id": "aud_001",
  "timestamp": "2026-08-05T10:30:00.000Z",
  "session_id": "sess_xyz",
  "user_id": "user_123",
  "event_type": "hitl_checkpoint",
  "data": {
    "checkpoint_id": "cp_001",
    "tool": "write_file",
    "parameters": {"path": "app/prod.py"},
    "presented_to": "user_123",
    "decision": "rejected",
    "reasoning": "用户选择取消"
  },
  "metadata": {
    "source": "parent_agent",
    "trace_ref": "tr_abc123"
  }
}
```

## Metrics 体系

### 指标类型

```
CACHE METRICS:
  cache_hit_rate = cache_hits / total_requests
  cache_savings_tokens_avg = cache_hit_prefix_tokens / cache_hits
  cache_miss_reason_distribution

CONTEXT METRICS:
  context_tokens_current
  context_tokens_peak
  context_tokens_avg
  compressions_count
  compressions_savings_avg

TOOL METRICS:
  tool_call_rate = tool_calls / llm_calls
  tool_latency_p50 / p95 / p99
  tool_error_rate = errors / total_tool_calls
  tool_usage_by_name

HITL METRICS:
  hitl_trigger_rate = hitl_triggers / tool_calls
  hitl_override_rate = human_overrides / hitl_triggers
  hitl_response_time_avg
  hitl_by_risk_level

AGENT METRICS:
  subagent_spawn_rate
  subagent_completion_rate
  subagent_error_rate

SESSION METRICS:
  session_duration_avg
  session_token_total_avg
  session_error_rate
```

### 指标采集时机

```
每次LLM调用后：
  → 记录 input/output_tokens, cache_hit
  → 累计到 metrics

每次Tool执行后：
  → 记录 latency, success/failure
  → 累计到 metrics

每次Context压缩后：
  → 记录 tokens_before/after, method
  → 累计到 metrics

每次HITL checkpoint后：
  → 记录 trigger/decision/response_time
  → 累计到 metrics
```

## 与外部系统集成

```
OpenTelemetry:
  - Trace导出到 Jaeger/Zipkin
  - 跨服务追踪

Prometheus/Grafana:
  - Metrics导出
  - 设置告警规则

SIEM:
  - Audit导出到 Splunk/Elasticsearch
  - 合规留存
```

## 检查清单

```
TRACE：
□ 每个LLM调用可追溯？（input/output/model/token）
□ Tool调用有summary+ref？（不是完整原始结果）
□ Context压缩有记录？（before/after/method）
□ Subagent可孤立追踪？（spawn→complete→conclusion）

AUDIT：
□ HITL决策完整记录？（checkpoint/options/decision）
□ 高风险操作有审计日志？
□ Skill状态变更可追溯？
□ 敏感数据访问有记录？

METRICS：
□ Cache命中率可量化？
□ Token使用量可追踪？
□ Tool延迟分布可查？
□ HITL干预率可统计？

INTEGRATION：
□ 支持OpenTelemetry导出？
□ 支持Prometheus/Grafana集成？
□ Audit支持SIEM导出？
```
