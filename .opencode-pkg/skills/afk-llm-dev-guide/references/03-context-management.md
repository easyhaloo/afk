# 上下文治理工程

## 上下文组件分类

```
固定不变（整个Session）：
  - System Prompt
  - Output Format定义
  - 安全边界/角色定义

阶段性稳定（多轮共享）：
  - Skill Schema（技能接口契约）
  - User Profile（用户画像）
  - 已确认的事实集合

实时变化（每步都变）：
  - 用户当前输入
  - RAG检索结果
  - 工具执行结果

累积增长（需要管理）：
  - 对话历史
  - 推理过程
  - 中间结论
```

## Provider 视角的 Prompt 结构

```
┌─────────────────────────────────────────────────────────┐
│  STATIC PREFIX（启动时固化，Provider缓存）                 │
│  [System + Skills Definitions + Base Tools]            │
│  → 连续序列稳定，最大化Provider缓存命中                  │
├─────────────────────────────────────────────────────────┤
│  DYNAMIC TAIL（尾部追加，不参与缓存）                     │
│  [当前Skill状态标记]                                  │
│  [System Reminder]                                    │
│  [User Current Input]                                 │
└─────────────────────────────────────────────────────────┘
```

## 四大机制

### 1. System Reminder 机制

**原则：永远在尾部追加，不动前缀**

```
触发场景：
  - 新增Skill → 尾部追加规则和说明
  - Skill状态变更 → 尾部追加ON/OFF通知
  - 需要关注某些信息 → 尾部追加提醒

示例：
  """
  [System Reminder]
  New Skill activated: Skill_X
  Key rules: [...]
  Required for this session.
  """
```

### 2. Tool 外部存储 + 引用机制

```
执行流程：
  1. Tool执行 → 结果存入 Tool Result Store
     key = hash(tool_call_id)
     value = {original, summary, created_at}
  
  2. messages追加引用（不是原始结果）
     {
       role: "tool",
       tool_call_id: "call_xyz",
       reference: "stored://a1b2c3",
       summary: "3 files found",
       stored: true
     }

LLM需要原始结果时：
  → 调用 read_stored_result(ref)
  → 从Store查询，注入context
```

### 3. Subagent 上下文隔离

```
Parent spawns Subagent：
  → Subagent有独立上下文（isolated context store）
  → Subagent执行自己的loop
  → 原始结果存Subagent Context Store

Subagent完成：
  → 只返回轻量结论给Parent
  → Parent context不膨胀

结论格式：
  {
    subagent_id,
    conclusion: "auth module uses JWT",
    artifacts: ["auth.py"],
    stored_context: "subagent://001"
  }
```

### 4. 尾部约束原则

```
禁止的操作：
  ❌ 在中间压缩历史消息
  ❌ 在中间插入新内容
  ❌ 修改已发送的前缀

允许的操作：
  ✅ 向尾部追加新消息
  ✅ 截断最老的head（丢弃）
  ✅ 压缩后作为新消息追加到尾部
```

## 压缩策略

### 触发条件

```
- Token总量超过阈值（80%窗口）
- Frozen占比过低（<30%）
- 某区域单独过大（RAG结果 > 2000 tokens）
```

### 压缩手段

| 手段 | 适用场景 | 信息损失 |
|------|---------|---------|
| LLM自我摘要 | 历史对话压缩 | 低 |
| 结构化提取 | tool result | 中 |
| 直接丢弃 | 低价值tool result | 高 |

### 压缩操作影响

```
压缩前：
  [Prefix: 2000 tokens] [History: 1500 tokens] [Current: 50]
  Provider缓存：前缀命中

压缩后：
  [Prefix: 2000 tokens] [压缩摘要: 200 tokens] [Current: 50]
  Provider缓存：仍然命中（前缀完全没变）

结论：压缩只改变Dynamic区域，不影响Provider缓存命中率
```

## Tool Result Store 设计

```
┌─────────────────────────────────────────┐
│  TOOL RESULT STORE (KV)                    │
│                                             │
│  stored://abc123                            │
│    original: "ls output: 5 files..."        │
│    summary: "5 files in directory"         │
│    created_at: timestamp                    │
│    size: 2048 bytes                       │
│                                             │
│  stored://def456                            │
│    original: "grep: 12 matches..."        │
│    summary: "12 matches found"             │
│    created_at: timestamp                    │
│    size: 512 bytes                        │
└─────────────────────────────────────────┘
```

## Subagent Context Store 设计

```
┌─────────────────────────────────────────┐
│  SUBAGENT CONTEXT STORE                    │
│                                             │
│  subagent://001                            │
│    messages: [full conversation]        │
│    conclusions: {...}                        │
│    artifacts: [file paths]                │
│    created_at: timestamp                    │
│                                             │
│  subagent://002                            │
│    ...                                     │
└─────────────────────────────────────────┘
```

## 完整工作流示例

```
Turn 1:
  User: "implement auth module"
  
  Parent sends:
    [Prefix] + [Tail: Skill states] + [User Input]
  
  LLM calls tools:
    write_file → stored://tool_001
    glob → stored://tool_002
  
  Tool Result Store:
    tool_001: {original, summary: "auth.py written"}
    tool_002: {original, summary: "3 existing auth files"}
  
  messages追加:
    [tool_001 ref + summary]
    [tool_002 ref + summary]

Turn 2:
  User: "why did tests fail?"
  
  Parent sends:
    [Prefix] + [Tail] + [Turn1 refs + summaries] + [User Input]
  
  LLM needs original test output:
    → calls read_stored_result(ref)
    → original injected into context
```

## 检查清单

```
□ 遵循尾部约束原则？
□ Tool结果存Store，messages只存ref+summary？
□ Subagent隔离，parent只收结论？
□ System Reminder尾部追加？
□ 压缩触发条件明确？
□ 压缩后Provider缓存仍然命中？
□ 原始结果可通过引用恢复？
```
