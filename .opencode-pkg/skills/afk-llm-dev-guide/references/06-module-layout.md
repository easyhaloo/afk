# 模块化编码结构

## 设计原则

```
1. 层与层之间通过接口通信
   - 业务层不知道编排层用什么框架
   - 基础设施层可替换

2. Prompt必须外部化
   - 不能拼接字符串
   - 模板化，变量替换

3. Skill必须有schema
   - 接口契约清晰才能安全组合

4. Context构建必须可追踪
   - 每次请求能回答"为什么上下文里包含这些"

5. LLM调用必须可观测
   - 输入输出token、延迟、工具调用序列
```

## 目录结构

```
llm-app/
├── llm/
│   ├── client.ts          # 模型调用抽象
│   ├── config.ts          # model/temperature/top_p配置
│   └── types.ts           # CompletionResult, ToolCall等

├── prompts/
│   ├── system/           # System prompt模板
│   │   ├── base.md
│   │   └── role.md
│   ├── task/             # 任务级prompt片段
│   │   └── extract.yaml
│   └── output/           # 输出schema
│       └── json-schema.ts

├── skills/
│   ├── registry.ts      # Skill注册与发现
│   ├── schemas/          # Skill接口契约
│   │   ├── skill_a.ts
│   │   └── skill_b.ts
│   └── middleware.ts     # Skill注入中间件

├── orchestration/
│   ├── agent.ts         # Agent循环
│   ├── workflow.ts       # Workflow定义
│   ├── router.ts        # Router模式
│   ├── handoff.ts       # Handoff状态机
│   └── hitl/
│       ├── checkpoint.ts # HITL checkpoint
│       ├── policy.ts     # 介入策略
│       └── middleware.ts # HITL中间件

├── context/
│   ├── builder.ts       # 上下文组装
│   ├── trimmer.ts        # 截断/压缩策略
│   ├── store.ts          # 外部存储
│   ├── reminder.ts       # System Reminder
│   └── references/
│       ├── tool_store.ts
│       └── subagent_store.ts

├── observability/
│   ├── trace.ts         # Trace采集
│   ├── audit.ts         # 审计日志
│   └── metrics.ts       # 指标采集

└── test/
    ├── unit/
    ├── integration/
    └── e2e/
```

## 模块边界

### llm/ — 模型抽象

```
职责：
  - 统一模型调用接口
  - 与具体模型解耦
  - 支持多Provider（Anthropic/OpenAI/本地模型）

边界：
  - 不关心业务逻辑
  - 只负责模型输入输出

interface LLMClient {
  complete(prompt: Prompt, options: Options): Promise<Response>
  stream(prompt: Prompt, options: Options): AsyncIterable<Response>
}
```

### prompts/ — 提示词与业务逻辑分离

```
职责：
  - 所有prompt模板外部化
  - 输出schema定义
  - 不包含运行时变量（变量通过参数传入）

边界：
  - 不包含任何业务判断
  - 纯文本/结构定义
```

### skills/ — Skill定义

```
职责：
  - Skill注册与发现
  - Skill接口契约（schema）
  - Skill与工具的映射

边界：
  - Skill定义与业务逻辑解耦
  - Skill可独立版本化
```

### orchestration/ — 编排逻辑

```
职责：
  - Agent循环
  - Workflow定义
  - HITL checkpoint
  - Router/Handoff模式

边界：
  - 不包含基础设施细节
  - 只关心流程控制
```

### context/ — 上下文管理

```
职责：
  - 上下文组装
  - 截断/压缩
  - 外部存储
  - System Reminder

边界：
  - 不关心模型调用
  - 只负责数据组织
```

### observability/ — 可观测性

```
职责：
  - Trace采集
  - Audit日志
  - Metrics指标

边界：
  - 不影响主流程
  - 旁路收集
```

## 版本化策略

```
Prompt版本：
  - prompt文件 + 变量替换
  - 不可直接在代码中拼接

Skill版本：
  - registry按version路由
  - 支持A/B切换

Model版本：
  - 配置层抽象
  - model名称可外部化
```

## 向后兼容策略

```
技能降级：
  新Skill不可用时，回退到旧Skill

模型降级：
  新模型故障时，切回旧模型（同接口）

上下文截断：
  token超限时，按优先级裁剪
```

## 检查清单

```
□ 模型调用是否抽象到client层？
□ Prompt是否全部外部化？
□ Skill是否有schema契约？
□ Context构建是否可追踪？
□ LLM调用是否完整可观测？
□ 各层边界是否清晰？
□ 版本化策略是否明确？
□ 向后兼容策略是否定义？
```
