# Prompt 模板抽象

## 核心原则

**Prompt 是配置，不是代码**。模板与模型解耦，业务代码不感知具体模型。

---

## 模板格式

```markdown
# prompts/rag-qa.md

---
name: rag-qa
version: 2
owner: team-search
changelog: |
  - v2: add precision hint for numerical queries
  - v1: initial
---

## Role

You are a precise QA assistant. Answer based ONLY on the provided context.

## Context

{{context}}

## Question

{{question}}

## Examples

### Example 1
Q: What is the melting point of gold?
A: Based on the context, the melting point of gold is 1064°C.

### Example 2
Q: {{question}}
A:

## Output Format

```json
{
  "answer": "<answer text>",
  "confidence": "<high|medium|low>",
  "cited_chunks": ["<chunk_id>"]
}
```
```

**注意**：模板不写 `model`、`temperature`、`max_tokens`。这些是运行时参数，由 Gateway 层决定。

---

## 接口定义

```typescript
interface PromptTemplate {
  name: string;
  version: string;
  role?: string;           // 角色定义
  userTemplate: string;     // {{variable}} 占位符
  examples?: Example[];
}

interface PromptRegistry {
  // 解析模板 + 填充变量
  resolve(name: string, vars: Record<string, string>): Promise<string>;

  // 流量策略
  resolveWithStrategy(name: string, vars: Record<string, string>, options: {
    strategy?: "rollout" | "experiment";
    experimentId?: string;
  }): Promise<string>;

  listVersions(name: string): string[];
  getMeta(name: string, version?: string): PromptMetadata;
}
```

---

## 版本化与灰度

```typescript
const promptRegistry = {
  "rag-qa": {
    versions: ["v1", "v2"],
    default: "v2",

    // 流量 rollout
    rollout: { v2: 0.1, v1: 0.9 },

    // A/B 实验
    experiments: {
      "rag-qa-precision": { v2: 0.5, v1: 0.5 },
    },
  },
};
```

**关键**：
- 模板是纯文本，不含模型参数
- 同一模板可绑定不同模型，模板可跨模型复用
- Gateway 层负责模型路由、temperature、max_tokens
