# LLM Gateway 抽象

## 问题

直接调用 `openai.chat.completions.create()`，业务代码和 SDK 紧耦合。

---

## 架构

```
┌──────────────────────────────────────┐
│  Application Layer                   │
│  LLMRequest { model, messages }     │
│              ↓                       │
│  ┌──────────────────────────────┐   │
│  │  LLMGateway                  │   │
│  │  模型路由 | 熔断 | 成本统计   │   │
│  └──────────────────────────────┘   │
│              ↓                       │
│  ┌────────────────────────────────┐  │
│  │  ModelAdapter                  │  │
│  │  OpenAI | Anthropic | Local   │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

---

## 接口定义

```typescript
interface LLMRequest {
  model: string;
  messages: Message[];
  temperature?: number;
  max_tokens?: number;
}

interface LLMResponse {
  content: string;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

interface ModelAdapter {
  name(): string;
  supports(model: string): boolean;
  invoke(request: LLMRequest): Promise<LLMResponse>;
}

interface LLMGateway {
  invoke(request: LLMRequest): Promise<LLMResponse>;
  registerAdapter(adapter: ModelAdapter): void;
  setRouter(router: (req: LLMRequest) => string): void;
  setFallback(fallback: (req: LLMRequest, err: Error) => LLMRequest): void;
}
```

---

## 业务代码

```typescript
// 业务层只认识 LLMRequest / LLMResponse
const response = await llmGateway.invoke({
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ],
});
```

**关键**：业务不耦合 SDK，不知道具体是哪个模型在响应。
