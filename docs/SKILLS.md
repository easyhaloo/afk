# Skills 设计

本文档记录 afk skills 的结构设计与核心原则。

## 设计原则

1. **明确触发场景** — description 以 "Use when" 开头，清晰定义何时使用
2. **保留方法论引用** — References 部分链接 TDD、检查清单等文档
3. **简化结构** — 移除冗余说明，保持精炼
4. **清晰流程** — 分步骤说明，避免冗长注释

## Skill 结构

### 标准格式

```yaml
---
name: skill-name
description: "Use when <触发场景>"
disallowed-tools: [...]
---

# Goal
简短目标说明

# Process
1. 第一步
2. 第二步
...

# References (可选)
- 相关文档链接

# Rules
- 关键规则
```

### 核心 Skills

#### 1. afk-debug
**用途：** 快速诊断和修复特定故障  
**触发：** 提供具体可重现的失败场景  
**结构：** Goal → Process(6步) → Rules(4条)

#### 2. afk-do
**用途：** 分析需求并逐任务实现  
**触发：** 明确的功能需求或任务描述  
**结构：** Goal → Process(7步) → References → Commit Prefixes → Rules  
**关键引用：** references/README.md, references/task-type/*, references/hard-checks.md

#### 3. afk-implement
**用途：** 执行单个明确定义的实现任务  
**触发：** 清晰定义的实现目标（通常由 afk-do 调用）  
**结构：** Goal → Preconditions → Process → References(条件) → Progress Commits → Rules  
**条件引用：** references/ddd.md, references/architecture.md, references/adr.md（按任务类型）

#### 4. afk-research
**用途：** 调研现有代码实现模式  
**触发：** 需要了解现有实现再编码  
**结构：** Goal → Process(5步) → Rules(3条)

#### 5. afk-qa
**用途：** 验证分支达到合并就绪状态  
**触发：** 分支功能开发完成，准备 MR  
**结构：** Goal → Process(4步) → Rules(4条)  
**跨平台：** 使用 `afk mr merge` 而非平台特定命令

#### 6. afk-prototype
**用途：** 快速验证技术方案可行性  
**触发：** 技术决策前需要验证方案  
**结构：** Goal → Process(4步) → Rules(4条)  
**跨平台：** 使用 `afk mr create --draft` 创建草稿 MR/PR

#### 7. afk-grill-me
**用途：** 通过提问挖掘隐含需求  
**触发：** 需求模糊或可能有遗漏  
**结构：** Goal → Process(4步) → Rules(3条)

#### 8. afk-hand-off
**用途：** 安全交接当前工作状态  
**触发：** 需要转移任务给其他开发者  
**结构：** Goal → Process(4步) → Rules(3条)

## 跨平台抽象

Skills 使用统一命令，自动适配 GitLab/GitHub：

| 操作 | 统一命令 | 替代平台命令 |
|------|---------|-------------|
| Issue 查询 | `afk issue get <id>` | `glab issue view` / `gh issue view` |
| Issue 列表 | `afk issue list` | `glab issue list` / `gh issue list` |
| MR/PR 创建 | `afk mr create` | `glab mr create` / `gh pr create` |
| MR/PR 合并 | `afk mr merge` | `glab mr merge` / `gh pr merge` |
| MR/PR 批准 | `afk mr approve` | `glab mr approve` / `gh pr review --approve` |

参见：[ARCHITECTURE.md](ARCHITECTURE.md) 了解抽象层设计

## References 目录

Skills 引用的方法论文档：

```
references/
├── README.md              # 参考文档索引
├── tdd-feature.md         # TDD 开发流程
├── hard-checks.md         # 强制检查清单
├── ddd.md                 # DDD 设计指南
├── architecture.md        # 架构决策模板
├── adr.md                 # ADR 写作指南
└── task-type/
    ├── feature.md         # 功能开发任务
    ├── refactor.md        # 重构任务
    └── bugfix.md          # Bug 修复任务
```

