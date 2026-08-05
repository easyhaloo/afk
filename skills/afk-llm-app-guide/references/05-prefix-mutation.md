# 前缀变更感知机制

## 核心问题

```
静态前缀中定义了某些内容（如：Skill列表、角色定义、能力边界）

后续运行时需要修改这些定义

如何在不改变前缀的情况下，让LLM感知到变更？
```

## 设计原则

```
1. 前缀定义"感知变更的机制"
   - 不是在前缀中写死内容
   - 而是在前缀中定义：当XXX时，如何感知变更

2. 变更通知在尾部追加
   - 不动前缀
   - 每轮追加变更标记

3. LLM通过前缀中的"感知指令"理解尾部变更
```

## 模式一：注册表模式

### 前缀定义

```
[Static Prefix]
  """
  Capability Registry:
  - skill_a: {name, description, tools: [T1, T2]}
  - skill_b: {name, description, tools: [T3]}
  
  Active skills are indicated in the [Active Skills] section.
  When a skill is not listed in Active Skills, it is inactive.
  """
```

### 尾部变更

```
[Dynamic Tail]
  [Active Skills]: skill_a=ON, skill_b=OFF

变更时（追加到尾部）：
  [Active Skills Update]: skill_b=OFF → ON
```

### 原理

```
前缀定义了"如何解读 Active Skills 字段"
变更时只改字段值，不改前缀定义
LLM通过前缀中的"感知指令"理解当前激活哪些skill
```

## 模式二：影子字段模式

### 前缀定义

```
[Static Prefix]
  """
 影子字段机制：
  所有动态状态通过影子字段传递。
  格式：__STATE__.field_name = value
  
  LLM应当始终使用最新的影子字段值，
  而忽略之前可能存在的任何同名字段。
  """
```

### 尾部变更

```
[Dynamic Tail]
  __STATE__.active_skills = ["skill_a", "skill_c"]
  __STATE__.context_mode = "analysis"

变更时（追加到尾部）：
  __STATE__.active_skills = ["skill_b", "skill_c"]
```

### 原理

```
前缀定义了"影子字段的读取规则"：
  - 永远读最新的
  - 忽略旧的
变更时只追加新值，不修改前缀
LLM自然读取最新的字段值
```

## 模式三：版本标记模式

### 前缀定义

```
[Static Prefix]
  """
  State Version: V{n}
  当前状态版本号。
  所有状态以最新版本为准。
  
  例如：
  V1: {skills: [A, C]}
  V2: {skills: [A, B, C]}  ← 以此为准
  """
```

### 尾部变更

```
[Dynamic Tail]
  State Version: V2
  V2 changes: 
    - skill_b: OFF → ON
    - mode: analysis → implementation

变更时（追加到尾部）：
  State Version: V3
  V3 changes:
    - skill_a: ON → OFF
```

### 原理

```
前缀定义了版本解析规则
变更时追加新版本标记
LLM始终使用最新版本的状态
```

## 模式四：Delta追加模式

### 前缀定义

```
[Static Prefix]
  """
  Delta Updates:
  所有变更以 delta 形式追加。
  格式：+field=value (添加/修改), -field (删除)
  
  最终状态 = 基础状态 + 所有deltas
  """
```

### 尾部变更

```
[Dynamic Tail]
  Delta Update:
    +skill_b.active=true
    -skill_c.mode=readonly

变更时（追加到尾部）：
  Delta Update:
    -skill_b.active
    +skill_c.mode=analysis
```

### 原理

```
前缀定义了delta解析规则
变更时只追加deltas
LLM计算最终状态
```

## 模式选择

| 模式 | 适用场景 | 复杂度 |
|------|---------|-------|
| 注册表 | 离散状态（开关/列表） | 低 |
| 影子字段 | 键值对配置 | 低 |
| 版本标记 | 需要历史追溯 | 中 |
| Delta | 需要diff可视化 | 高 |

## 通用设计原则

```
1. 在前缀中定义"解析规则"，不是"具体内容"
   - 规则是静态的，不变
   - 内容是动态的，通过尾部追加

2. 前缀中的规则应当清晰说明：
   - 动态字段的格式
   - 多值冲突时以哪个为准
   - 如何识别最新状态

3. 变更追加时：
   - 只追加，不修改已发送的内容
   - 格式与前缀中的规则一致
   - 包含足够的上下文让LLM理解变更
```

## 与Skill开关的关系

```
Skill开关只是这个模式的特例：

通用模式：
  前缀定义 skill 注册表 + 解析规则
  尾部追加 active_skills 状态

Skill变更：
  只改尾部状态，前缀不变
  LLM通过前缀中的规则理解当前激活哪些skill

优点：
  - 前缀稳定，Provider缓存命中
  - 支持任意数量skill的任意切换
  - 不需要重新定义skill列表
```

## 检查清单

```
□ 前缀中定义的是"解析规则"还是"具体内容"？
□ 变更追加格式与前缀规则一致？
□ LLM能否通过前缀规则理解变更？
□ 是否支持任意数量的状态切换？
□ 前缀稳定，Provider缓存能命中？
```
