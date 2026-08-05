# Embedding 模型可演化性

## 核心原则

**原始文本是第一公民，向量是派生缓存**。

```
text = 不可丢失的资产
vector = f(text, model) 的派生结果，可重刷
```

---

## 升级策略对比

| 策略 | 重刷成本 | 兼容性 | 一致性 |
|------|----------|--------|--------|
| 全量重刷 | 高 | 无需 | 完全一致 |
| 双轨并存 + 融合 | 低 | 兼容 | 需 RRF |
| 向量映射 | 低 | 兼容 | 有损 |

---

## 策略 A：双轨并存 + RRF 融合

```
1. 新模型上线，新向量写入 new_index
2. 查询时同时查 old_index + new_index
3. Reciprocal Rank Fusion 融合结果
4. 逐步将流量从旧切到新
5. 稳定后删除旧 index
```

```typescript
class HybridRetrieval {
  async search(query: string, options: { alpha?: number }) {
    const [oldResults, newResults] = await Promise.all([
      this.oldIndex.search(query),
      this.newIndex.search(query),
    ]);
    return this.rrf Fuse(oldResults, newResults, { k: 60, alpha: options.alpha });
  }
}
```

---

## 策略 B：向量映射（跨维度）

```
旧模型: text → vec_768
新模型: text → vec_1024

学习映射矩阵 M: vec_1024 ≈ M @ vec_768
```

```typescript
class EmbeddingProjector {
  // 使用锚点数据训练投影矩阵
  async trainProjectionPairs(pairs: { old: number[]; new: number[] }[]) {
    this.matrix = solveLeastSquares(
      pairs.map(p => p.old),
      pairs.map(p => p.new)
    );
  }

  project(vector: number[], from: string, to: string): number[] {
    if (from === to) return vector;
    return this.matrix[from][to].dot(vector);
  }
}
```

---

## 策略 C：Matryoshka 表示

```
模型原生输出嵌套维度：
  完整向量: 1024 维
  截断向量: 256 维
  最小向量: 64 维

新模型兼容旧维度：
  vec_64 (旧) ≈ truncate(vec_1024 (新))
```

---

## 维度不匹配处理

| 情况 | 方案 |
|------|------|
| 旧 < 新 | 零填充 + PCA 或 直接投影 |
| 旧 > 新 | PCA 降维 |
| 完全不同 | 双轨并存或重刷 |

---

## 迁移检查清单

- [ ] 新模型 Adapter 已注册
- [ ] 切换策略已确定（全刷 / 映射 / 双轨）
- [ ] 灰度方案已设计
- [ ] 监控已配置
- [ ] 回滚方案已准备
