# Context Budget 抽象

## 问题

不同 LLM 的 context window 不同（4K / 128K / 1M），业务代码写死常量会导致：
- 换模型后溢出
- 无法充分利用大 window

---

## 接口设计

```typescript
interface ContextBudget {
  maxTokens: number;       // 模型上限
  reserved: number;        // 输出 buffer
  available(): number;    // 可用输入量

  fit(items: ContextItem[]): ContextAssembly;
  // 返回：哪些能塞入、如何截断
}

interface ContextAssembly {
  included: ContextItem[];
  truncated: ContextItem[];
  overflowSignal?: OverflowSignal;
}
```

---

## 截断策略

| 策略 | 适用场景 |
|------|----------|
| head | 最新内容重要（聊天） |
| tail | 开头是任务定义，后面是数据 |
| semantic | 语义相似度优先 |
| smart | 结合两种，优先保留关键信息 |

---

## 使用方式

```typescript
const budget = contextBudgetManager.getBudget();

// 业务层不写死常量
const assembly = budget.fit(chunks);
const prompt = assembly.included.map(c => c.text).join("\n");
```

**关键**：业务层只问「我的内容能否被完整处理」，不写死 window 常量。
