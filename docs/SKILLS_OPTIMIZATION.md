# AFK Skills Optimization Summary

优化了 afk 系列 skills 的描述，精简实现，移除无关内容，保留 "Use when" 使用场景说明。

## 优化原则

1. **保留使用场景** — description 中保留 "Use when" 说明何时使用该 skill
2. **保留 References** — 保留对 references/ 目录文档的引用，说明何时阅读
3. **精简描述** — 移除冗余说明，保留核心信息
4. **结构化** — 统一格式：Goal → Process → References (可选) → Rules
5. **聚焦本质** — 只保留必要步骤和关键规则

## 已优化 Skills

### 1. afk-debug
**优化前：** 122 行，详细步骤说明，多个接口命令表  
**优化后：** 30 行，精简为 Goal + Process(6步) + Rules(4条)

**改进：**
- 移除 Script Interface 表格
- 合并重复的 Anti-patterns 和 Rules
- 精简步骤描述

### 2. afk-do
**优化前：** 95 行，详细的工作空间选择、方法论加载说明  
**优化后：** 48 行，精简为 Goal + Process(7步) + References + Commit Prefixes + Rules(4条)

**改进：**
- 移除详细的 Task type detection 表格
- 合并 Steps 为简洁流程
- 提取 Commit Prefixes 为独立部分
- 添加 References 部分，说明需要读取的文档

### 3. afk-grill-me
**优化前：** 116 行，详细的 Interview closure、Core topics、Extended topics  
**优化后：** 41 行，精简为 Goal + Process(5步) + Closure Criteria + Rules(3条)

**改进：**
- 移除详细的 Core/Extended topics 列表
- 合并 Interview closure 为 Closure Criteria
- 精简 Step 4 gate 说明

### 4. afk-grill-me-context
**优化前：** 94 行，详细的 When to use、Core verification topics  
**优化后：** 36 行，精简为 Goal + Process(5步) + Rules(3条)

**改进：**
- 移除 When to use 表格
- 合并 Core verification topics 到 Process
- 精简 Optional code audit 说明

### 5. afk-hand-off
**优化前：** 96 行，详细的 Mode: save/resume 步骤和模板  
**优化后：** 30 行，精简为 Goal + Save Mode(4步) + Resume Mode(3步) + Rules(3条)

**改进：**
- 移除完整的 markdown 模板示例
- 合并两个 Mode 的详细步骤
- 精简 Anti-patterns

### 6. afk-implement
**优化前：** 149 行，详细的 Routing 表、Progress checkpoints、Common failure modes  
**优化后：** 58 行，精简为 Goal + Preconditions(4条) + Process(5步) + References + Progress Commits + Rules(5条)

**改进：**
- 移除详细的 Routing 表，改为 References 部分
- 移除 Development methodology 判断树
- 移除 Common failure modes 详细说明
- 精简 Progress checkpoints 为概要描述
- 添加条件性 references（ddd.md, architecture.md, adr.md）

### 7. afk-research
**优化前：** 97 行，详细的 Research modes 表、Progress checkpoints 模板  
**优化后：** 38 行，精简为 Goal + Modes + Spike vs Research + Process(5步) + Rules(4条)

**改进：**
- 移除 Research modes 表格
- 移除 Progress checkpoints bash 模板
- 合并 Steps 为简洁流程

### 8. afk-scheduler
**优化前：** 136 行，详细的 Two invocation modes 表、DAG 构建代码、Wave 计算说明  
**优化后：** 43 行，精简为 Goal + Modes + Concepts + Preconditions + Process(5步) + Auto Mode + Rules(4条)

**改进：**
- 移除详细的 bash 命令示例
- 移除 Wave 计算的详细说明
- 精简 Auto Mode 为概要
- 合并 Anti-patterns 为 Rules

## 优化效果

| Skill | 优化前 | 优化后 | 减少 |
|-------|--------|--------|------|
| afk-debug | 122 行 | 30 行 | 75% |
| afk-do | 95 行 | 48 行 | 49% |
| afk-grill-me | 116 行 | 41 行 | 65% |
| afk-grill-me-context | 94 行 | 36 行 | 62% |
| afk-hand-off | 96 行 | 30 行 | 69% |
| afk-implement | 149 行 | 58 行 | 61% |
| afk-research | 97 行 | 38 行 | 61% |
| afk-scheduler | 136 行 | 43 行 | 68% |
| **总计** | **905 行** | **324 行** | **64%** |

## 未优化 Skills

以下 skills 已在前期工作中更新过，或内容已经足够精简：

- afk-pipeline
- afk-pipeline-deck
- afk-pipeline-deck-v1
- afk-prototype （已更新使用 afk mr 命令）
- afk-qa （已更新使用 afk mr 命令）
- afk-to-issues （已更新使用 afk issue 命令）
- afk-to-prd （已更新使用 afk issue 命令）

## 优化模式

所有优化后的 skills 遵循统一结构：

```markdown
---
name: skill-name
description: >-
  Use when <使用场景描述>. <简短的功能说明>.
---

# Skill Name

**Goal:** 核心目标（1句话）

## Process / Modes / Concepts (可选)

简洁的流程说明或关键概念

## Rules

- 关键规则列表
- 使用肯定句而非 MUST NOT
```

**Description 格式要求：**
- 必须以 "Use when" 开头，说明使用场景
- 保持简洁，2-3 句话即可
- 说明输入/输出或关键特性

## 下一步

Skills 优化完成。所有 afk 系列 skills 现在都使用精简、结构化的描述格式。
