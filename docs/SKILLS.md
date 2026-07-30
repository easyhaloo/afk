# Skills 深度说明

本文档详细说明 AFK Skills 系统的设计理念、各个 skill 的作用、触发场景、工作流程及设计决策。

## Skills 系统概述

Skills 是 Claude Code 的可复用工作流模板，每个 skill 封装了特定场景下的最佳实践。AFK Skills 专注于自动化软件开发流程，从需求分析到代码实现、测试验证。

### 设计理念

1. **单一职责** — 每个 skill 解决一类问题，避免功能重叠
2. **明确触发** — description 以 "Use when" 开头，清晰定义适用场景
3. **流程可验证** — 通过 Signal 机制和 AC 检查确保完成质量
4. **方法论集成** — 内置 TDD、DDD 等软件工程最佳实践

### Skills 调用关系

```
用户请求
    ↓
/afk-grill-me ────→ 需求澄清 ────→ CONTEXT.md
    ↓
/afk-do ──────────→ 任务分析
    │
    ├──→ /afk-research ──→ 调研现有实现
    │
    ├──→ /afk-prototype ─→ 技术方案验证
    │
    ├──→ /afk-implement ─→ TDD 实现
    │         ↓
    │    完成后触发
    │         ↓
    └──→ /afk-qa ────────→ 验证 & 合并
```

## 核心 Skills 详解

### 1. afk-grill-me

**作用：** 通过多轮提问澄清需求，建立共识

**触发场景：**
- 用户提出的功能/Epic 描述模糊
- 需求存在多种解读可能
- 缺少验收标准或约束条件

**工作流程：**
1. **识别主题** — 明确讨论的功能/Epic
2. **多轮访谈** — 使用 AskUserQuestion 收集信息：
   - Audience — 谁会使用？
   - Success Criteria — 如何判断完成？
   - Non-goals — 什么不做？
   - Constraints — 性能、安全、合规、预算限制
3. **起草总结** — 展示 CONTEXT.md（尚未保存）
4. **用户确认** — 批准 / 修订 / 深入追问 / 添加开放问题
5. **保存文档** — 写入 `/tmp/grill-me-context-<timestamp>.md`

**设计决策：**

**为什么需要独立的澄清 skill？**
- 避免在实现阶段发现需求理解偏差，返工成本高
- 强制在编码前对齐期望，减少"做了但不是我想要的"情况
- 产出可追溯的需求文档（CONTEXT.md）

**为什么使用 AskUserQuestion？**
- 结构化提问比自由对话更高效
- 用户可以一次回答多个问题
- 确保关键维度（Audience, Success, Non-goals）不遗漏

**为什么输出到 /tmp/ 而非仓库？**
- grill-me 阶段可能产生多个迭代版本
- 避免污染 git 历史
- 最终版本由用户决定是否提交到仓库

**闭包条件：**
- 每个章节至少有 1 个可证伪的答案
- 2 轮访谈无新增信息时，草拟文档并将未决事项标记为 Open Questions
- 存在冲突时，在 Open Questions 中逐字记录

**与其他 skills 协作：**
- **输出** → CONTEXT.md → **afk-prototype** 使用作为前置条件
- **输出** → 澄清的需求 → **afk-do** 分解为任务

---

### 2. afk-do

**作用：** 分析用户请求，选择合适方法论，编排任务执行

**触发场景：**
- 用户提供明确编码任务（如 "add login", "fix bug"）
- 需要在当前会话完成特定功能

**工作流程：**
1. **工作空间** — 当前分支（默认）或新建 worktree
2. **加载方法论** — 读取 references/README.md、任务类型文档、hard-checks.md
3. **识别类型** — Feature / Refactor / Hotfix / Spike / Research
4. **制定计划** — 确定修改文件、验收标准、受影响测试
5. **执行** — 遵循方法论，在检查点提交
6. **验证** — 运行测试、编译、lint
7. **完成** — 呈现结果

**设计决策：**

**为什么需要任务编排层？**
- 用户描述通常是目标（"add login"），需要分解为可执行步骤
- 不同类型任务有不同流程：feature 需要 TDD，hotfix 强调速度，refactor 要求行为不变
- 统一入口，避免用户学习多个 skills

**为什么动态加载方法论文档？**
- 方法论可能演进，避免 skill 代码硬编码流程
- references/ 文档是单一事实来源（Single Source of Truth）
- 支持项目自定义方法论（覆盖默认 references/）

**为什么区分任务类型？**
不同类型的风险点和流程不同：
- **Feature** — TDD 红绿重构循环，优先正确性
- **Refactor** — 先固定测试，再改结构，行为不变
- **Hotfix** — 跳过复杂流程，优先速度，事后补测试
- **Spike** — 时间盒验证，代码可丢弃
- **Research** — 只调研不实现，输出 RESEARCH.md

**Commit 前缀约定：**
```
feat:    — 新功能/API/UI
fix:     — Bug 修复
refactor: — 结构调整，行为不变
hotfix:  — 生产补丁
spike:   — 可行性探索
wip:     — 进行中检查点
```

**与其他 skills 协作：**
- **调用** → **afk-research** — 当需要了解现有实现模式
- **调用** → **afk-implement** — 实际执行每个子任务
- **调用** → **afk-prototype** — 技术风险高时，先验证方案
- **前置** ← **afk-grill-me** — 需求明确后再分解任务

---

### 3. afk-implement

**作用：** 执行单个明确定义的实现任务，遵循 TDD 流程

**触发场景：**
- afk-do 分配的子任务
- 用户直接指定清晰的实现目标（较少见）

**工作流程：**
1. **前置检查** — 验证 AC 存在、base label 存在、无阻塞依赖
2. **TDD 循环** — 红（写失败测试）→ 绿（最小实现）→ 重构（优化代码）
3. **进度提交** — 每个完整循环提交一次（wip: 前缀）
4. **最终验证** — 完整测试套件 + hard-checks.md 检查
5. **Signal 完成** — 写入 `.afk-signal.json`

**设计决策：**

**为什么强制 TDD？**
- 测试先行确保需求理解正确
- 防止过度设计（只写满足测试的代码）
- 重构时有安全网（测试不变，代码优化）
- 产出的测试覆盖率高，维护性好

**为什么使用 Signal 机制？**
- Scheduler 需要知道任务完成状态（成功/失败/阻塞）
- 跨 tmux session 通信（CLI 轮询 .afk-signal.json）
- 支持异步工作流（Scheduler 不阻塞等待）

**为什么需要前置条件检查？**
- AC 不存在 → 无法验证完成标准
- 缺少 base label → 不知道目标分支（prd/<N> 还是 main）
- 有阻塞依赖 → 可能依赖未完成功能，实现会失败

**进度提交策略：**
```
wip: add user model (red)       — 测试失败
wip: implement user model (green) — 测试通过
wip: extract validation logic    — 重构
feat(auth): add user model      — 最终提交
```

**References 条件加载：**
根据任务类型加载不同文档：
- DDD 任务 → references/ddd.md
- 架构变更 → references/architecture.md
- 设计决策 → references/adr.md

**与其他 skills 协作：**
- **被调用** ← **afk-do** — 作为执行引擎
- **输出** → Signal → **afk-qa** — 触发验证流程
- **输入** ← **afk-research** — 参考调研结果实现

---

### 4. afk-research

**作用：** 调研现有代码、系统或技术方案，输出调研报告

**触发场景：**
- 需要了解现有实现模式再编码
- 评估新技术方案的可行性
- 不确定系统架构的某部分如何工作

**工作流程：**
1. **确定范围** — 明确：要知道什么、不需要知道什么、关键文件
2. **执行调研** — HITL 模式：展示发现，询问继续/转向。AFK 模式：阅读、提交进度
3. **综合总结** — 撰写 RESEARCH.md：背景、发现、影响、待解问题
4. **用户审查** — 确认发现是否满足需求
5. **保存文档** — 写入磁盘，可选发布到 issue（stage::research 标签）

**设计决策：**

**为什么区分 Spike vs Research？**
- **Spike** — 回答"能不能做"（yes/no + 证据），时间盒限制，输出可能是一次性代码
- **Research** — 回答"怎么做的"（组件、关系、疑问），输出是文档，代码不变

**为什么支持 HITL 和 AFK 两种模式？**
- **HITL（Human-in-the-Loop）** — 范围未知时，每个发现后问用户是否继续/调整方向
- **AFK（Away From Keyboard）** — 范围明确时，自主完成，只在检查点提交进度

**为什么禁止产品决策？**
- Research 只汇报事实（"现有实现使用 Redis"），不做建议（"我们应该用 Redis"）
- 决策权在人，避免 AI 越权

**为什么不超出范围？**
- 调研容易发散（"顺便看看 X"），时间失控
- 明确边界确保在预算内完成

**与其他 skills 协作：**
- **被调用** ← **afk-do** — 当任务需要理解现有代码
- **输出** → RESEARCH.md → **afk-implement** — 参考实现模式
- **并行** ↔ **afk-prototype** — Research 了解系统，Prototype 验证方案

---

### 5. afk-qa

**作用：** 独立验证自主构建输出，检查 AC，决定是否合并到 prd/<N>

**触发场景：**
- MR/PR 标记为 `stage::qa`
- 目标分支是 `prd/<N>`（非 main）
- 关联 issue 包含 machine-checkable AC

**工作流程：**
1. **读取 MR/PR + AC** — 获取关联 issue 的验收标准
2. **独立运行检查** — 重新执行每条 AC 命令，不信任实现者自报
3. **记录结果** — 每条 AC：pass/fail + 证据（命令输出/响应片段）
4. **合并决策** — 全部通过：批准并合并到 prd/<N>；任何失败：不合并，恢复构建
5. **冲突处理** — 检测到冲突：尝试 rebase，语义冲突则升级为 HITL
6. **检查最后一个** — 如果这是 PRD 中最后一个 MR，通知可以进行最终人工 gate

**设计决策：**

**为什么需要独立验证？**
- 自我报告偏差（Self-report bias）：实现者的检查清单是假设，不能替代独立重跑
- 防止"看起来合理"就通过，每条 AC 需要证据

**为什么有两个合并 gate？**
```
afk/issue-<iid> ──→ prd/<N> ──→ main
                  ↑          ↑
                AFK gate   Human gate
```
- **AFK gate（prd/<N>）** — 机器可验证的 AC，自动化合并
- **Human gate（main）** — 整体业务逻辑、用户体验，人工审查

**为什么不能直接合并到 main？**
- main 分支是生产代码，必须人工审查
- prd/<N> 是集成分支，积累一个 PRD 的所有 issues
- 分离自动化验证（AC）和人工审查（业务逻辑）

**合并顺序 gate：**
MR/PR 描述包含 `## Merge Order` 列出所有 `blocked_by` issues：
- 所有阻塞已合并 → 继续
- 任何阻塞未合并 → 不合并，留在 stage::qa

**Flaky 检查处理：**
- 重试无代码变更但失败 → 标记为 flaky，继续（不能静默重试到绿）
- 非功能 AC（"P95 < 200ms"）但无工具 → 失败，不能通过

**与其他 skills 协作：**
- **被触发** ← **afk-implement** — Signal 完成后触发
- **输入** ← MR/PR + AC — 验证目标
- **输出** → 合并到 prd/<N> 或恢复构建
- **升级** → HITL — 遇到语义冲突或复杂失败

---

### 6. afk-prototype

**作用：** 时间盒验证技术方案，证明最危险的部分可行

**触发场景：**
- 需求明确但技术风险高
- 不确定某个技术栈/库能否满足需求
- 需要端到端验证架构可行性

**工作流程：**
1. **前置检查** — 确认 CONTEXT.md 存在（需求已对齐）
2. **创建 spike 分支** — `git checkout -b spike/<slug>`
3. **最小化实现** — 只实现通过所有层的最薄片段，跳过边界情况、错误处理、测试
4. **创建草稿 MR/PR** — `afk mr create "Spike: ..." --draft`
5. **报告发现** — 什么可行、什么意外、对 PRD 的影响
6. **用户决策** — 何时 spike 已回答开放问题

**设计决策：**

**为什么需要 Prototype skill？**
- 技术风险高时，直接实现可能浪费时间（方案不可行需要重来）
- Spike 快速验证（几小时），比完整实现（几天）成本低
- 产出具体证据（代码 + 发现），而非猜测

**Spike vs 完整实现：**
| 维度 | Spike | 完整实现 |
|------|-------|---------|
| 目标 | 证明可行 | 交付功能 |
| 测试 | 最小验证 | 完整覆盖 |
| 错误处理 | 跳过 | 完整 |
| 代码质量 | 可丢弃 | 生产级 |
| 时间 | 时间盒 | 按需 |

**为什么默认删除 spike 分支？**
- Spike 代码质量低，不适合作为实现基础
- 保留会诱惑"直接基于 spike 改"，导致技术债
- 只有 PRD 需要引用具体代码行时才保留

**时间盒与停止信号：**
- 默认预算：一个工作会话（几小时）
- 停止信号：最危险的未知有了具体答案（可行/不可行/需要 X），立即停止

**重复劳动检查：**
- 分支前检查现有 `spike/*` 分支或草稿 MR/PR
- 避免重复验证相同问题

**与其他 skills 协作：**
- **前置** ← **afk-grill-me** — 需要 CONTEXT.md
- **并行** ↔ **afk-research** — Prototype 验证方案，Research 理解系统
- **输出** → 发现报告 → **afk-do** — 影响任务分解和实现策略

---

### 7. afk-debug

**作用：** 快速诊断和修复特定、可重现的故障

**触发场景：**
- 提供了具体的错误信息、堆栈跟踪或失败步骤
- 问题可重现
- 需要快速修复而非大范围调研

**工作流程：**
1. **重现问题** — 运行用户提供的失败步骤
2. **定位根因** — 检查日志、堆栈、相关代码
3. **验证假设** — 修改并测试，确认修复有效
4. **回归测试** — 确保修复不破坏其他功能
5. **提交修复** — fix: 前缀，清晰描述问题和解决方案
6. **文档化** — 复杂 bug 记录到 ADR 或注释

**设计决策：**

**为什么独立于 afk-do？**
- Debug 是响应式（已有问题），afk-do 是建设性（添加功能）
- Debug 流程优化为快速诊断，跳过计划阶段
- Debug 允许跳过测试先行（紧急修复），事后补测试

**为什么强调"可重现"？**
- 不可重现的问题难以验证修复有效性
- 偶现问题通常需要更深入调研，不适合快速 debug 流程

**为什么需要回归测试？**
- 修复可能引入新问题（副作用）
- 确保修复是局部的，不影响系统其他部分

**与其他 skills 协作：**
- **独立** — 通常不调用其他 skills
- **升级** → **afk-research** — 如果问题涉及不熟悉的系统部分
- **升级** → **afk-do** — 如果修复需要重构或架构变更

---

### 8. afk-hand-off

**作用：** 安全交接当前工作状态给其他开发者

**触发场景：**
- 需要暂停当前任务，由他人继续
- 工作未完成但需要上下文传递
- 团队协作需要清晰的状态快照

**工作流程：**
1. **记录状态** — 当前分支、已完成内容、进行中工作
2. **列出下一步** — 待办事项、已知问题、决策点
3. **标记依赖** — 阻塞因素、需要的信息/权限
4. **生成文档** — HANDOFF.md 包含所有上下文
5. **提交到分支** — 确保接手者能获取最新状态

**设计决策：**

**为什么需要 hand-off skill？**
- 口头交接容易遗漏细节
- 异步协作（时区差异）需要文档化
- 新人接手需要完整上下文，减少理解成本

**为什么输出 HANDOFF.md 而非 issue comment？**
- 文档与代码在同一分支，上下文关联紧密
- 避免 issue 中大段技术细节（issue 面向产品）
- 方便接手者本地查看，无需联网

**为什么记录决策点？**
- 接手者可能面临相同决策
- 解释"为什么这样做"而非只说"做了什么"
- 避免重复已否决的方案

**与其他 skills 协作：**
- **后续** → **afk-do** — 接手者用 afk-do 继续任务
- **输出** → HANDOFF.md → 团队成员

---

### 9. api-workflow

**作用：** 将自然语言业务场景转换为可执行的 Playwright API 测试文件

**触发场景：**
- 用户描述多步骤 API 流程（如"登录 → 创建订单 → 验证状态"）
- 需要 API + 浏览器混合测试
- 需要验证 webhooks、异步任务、错误处理

**工作流程：**
1. **解析** — 理解用户场景，识别 API 步骤和数据流
2. **生成** — 在 `tests/api-workflow/scenarios/` 创建测试文件
3. **确认** — 展示生成的文件结构
4. **执行** — 运行 `pnpm playwright test`

**生成结构：**
```
tests/api-workflow/
├── scenarios/           # 业务流测试
├── fixtures/           # 可复用 fixture
├── utils/             # 工具函数
└── playwright.config.ts
```

**模板复用：**
- `templates/` — TypeScript 代码模板，可直接使用
- `references/` — 模式概念描述，让 AI 理解模式含义

**与其他 skills 协作：**
- **前置** → 任意需要 API 验证的场景
- **输出** → 可执行的测试文件

---

## Skills 设计原则总结

### 1. 单一职责
每个 skill 解决一类问题，避免功能重叠：
- **afk-grill-me** — 澄清需求
- **afk-research** — 调研理解
- **afk-prototype** — 验证方案
- **afk-implement** — TDD 实现
- **afk-qa** — 独立验证

### 2. 明确触发条件
`description` 以 "Use when" 开头，Claude 根据场景自动选择：
```yaml
description: "Use when existing code needs to be understood before committing to a plan"
```

### 3. 流程可验证
通过机制确保完成质量：
- **Signal 文件** — `.afk-signal.json` 标记完成状态
- **AC 检查** — afk-qa 独立验证每条验收标准
- **Gate 机制** — 关键决策点需要用户确认

### 4. 方法论集成
内置最佳实践，减少认知负担：
- **TDD** — afk-implement 强制红绿重构循环
- **DDD** — references/ddd.md 指导领域建模
- **Time-boxing** — afk-prototype 限制 spike 时间

### 5. 跨平台兼容
使用统一命令，自动适配 GitLab/GitHub：
```bash
afk mr create "Title"  # 自动检测平台
afk issue get 123      # GitLab iid 或 GitHub number
```

参见：[ARCHITECTURE.md](ARCHITECTURE.md) 了解跨平台抽象层设计

## References 体系

Skills 引用的方法论文档位于 `references/` 目录：

```
references/
├── README.md              # 任务类型检测指南
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

**为什么使用 references/ 而非硬编码流程？**
1. **可演进** — 方法论改进时，更新文档即可，无需修改 skill 代码
2. **可定制** — 项目可以覆盖默认 references/，定制工作流
3. **单一事实来源** — 避免 skill 代码和文档不一致

## 下一步

- **架构设计** → [ARCHITECTURE.md](ARCHITECTURE.md) — 跨平台抽象层
- **工作流程** → [WORKFLOWS.md](WORKFLOWS.md) — Issue → MR 流水线、调度器
- **快速开始** → [GETTING-STARTED.md](GETTING-STARTED.md) — 5 分钟上手
