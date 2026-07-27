# 文档重组计划

## 目标
重新组织 docs/ 目录，使文档职责清晰、语言一致、易于导航。

## 当前问题

### 1. 语言一致性
- **WORKFLOWS.md**: 标题中文，正文英文，需统一为中文
- **QUICK-START.md**: 全英文，定位模糊（490行不够"Quick"）

### 2. 文档职责需要明确

**现状：**
- **ARCHITECTURE.md** ✓ 跨平台抽象层设计
- **WORKFLOWS.md** ✓ 三种工作流程（但语言混乱）
- **SKILLS.md** ✗ 当前内容：设计原则 + 8个skills概览
- **QUICK-START.md** ✗ 490行的"快速开始"实际是完整手册

**SKILLS.md 应该是：**
记录已有 skills 的详细说明：
- 每个 skill 的作用
- 触发场景
- 工作流程
- 设计决策（为什么这么设计）
- 与其他 skills 的协作关系

### 3. 缺失内容
- SKILLS.md 缺少对实际 skills 实现的深入说明
- 没有解释 skills 之间的调用关系（afk-do → afk-implement）
- 没有说明设计决策背后的原因

## 重组方案（推荐）

```
docs/
├── ARCHITECTURE.md      (保持) - 跨平台抽象层架构设计
├── WORKFLOWS.md         (中文化) - 三种工作流程详解
├── SKILLS.md            (重写) - Skills 深度说明文档
└── GETTING-STARTED.md   (新建) - 快速开始（100行左右）
```

## 各文档重组内容

### 1. WORKFLOWS.md - 全文中文化
**当前问题：** 标题中文，正文英文混杂  
**修改：** 翻译所有英文章节为中文

### 2. SKILLS.md - 重写为深度说明
**当前内容：** 设计原则 + 简单概览  
**新结构：**
```markdown
# Skills 深度说明

## 概述
Skills 系统的设计理念和整体架构

## Skills 调用关系
afk-do → afk-implement → afk-research
        → afk-qa
        → afk-prototype

## 核心 Skills 详解

### afk-do
**作用：** 需求分析与任务编排
**触发场景：** 用户提供功能需求
**工作流程：** 
1. 解析需求
2. 分解子任务
3. 依次调用 afk-implement
**设计决策：**
- 为什么需要任务编排？
- 为什么使用 TaskCreate 而非其他方式？
**与其他 skills 协作：**
- 调用 afk-research 获取上下文
- 调用 afk-implement 执行实现
- 调用 afk-qa 验证质量

### afk-implement
**作用：** 执行单个实现任务
**触发场景：** afk-do 分配的子任务
**工作流程：** TDD 循环
**设计决策：**
- 为什么强制 TDD？
- 为什么使用 Signal 机制？
**前置条件检查：** 
- AC 存在
- Base label 存在
**进度提交策略：** wip commits

[... 其他 skills 类似结构]

## Skills 设计原则
- 单一职责
- 明确触发条件
- 流程可验证
- 方法论集成（TDD, DDD）

## References 体系
说明 references/ 目录的作用和组织
```

### 3. GETTING-STARTED.md - 新建精简快速开始
**内容：** 
- 安装（10行）
- 配置（15行）
- 第一个命令（30行）
- 常见使用场景（30行）
- 下一步链接（10行）

### 4. ARCHITECTURE.md - 补充命令映射
**新增章节：** CLI 命令映射表（从 SKILLS.md 迁移过来）

### 方案 B: 分层结构

```
docs/
├── README.md          (新增) - 文档导航
├── architecture/
│   └── CROSS-PLATFORM.md - 跨平台设计
├── workflows/
│   ├── ISSUE-PIPELINE.md - Issue → MR 流程
│   ├── SCHEDULER.md      - 调度器
│   └── SKILLS.md         - Skills 工作流
├── guides/
│   ├── GETTING-STARTED.md - 快速开始
│   └── CLI-REFERENCE.md   - CLI 完整参考
└── references/
    └── SKILLS-DESIGN.md - Skills 设计规范
```

**优点：** 更细粒度，易于维护
**缺点：** 目录层级增加，查找成本上升

## 推荐方案：A

理由：
1. 保持扁平结构，易于浏览
2. 职责清晰，每个文档聚焦单一主题
3. 快速开始文档精简到实际可以"快速"完成的内容
4. 语言统一为中文（核心文档）

## 执行步骤

1. **WORKFLOWS.md 中文化**
   - 翻译所有英文章节
   - 保持代码示例和命令原样

2. **重写 GETTING-STARTED.md**
   - 精简到核心流程（安装、配置、第一个命令）
   - 移除详细 API 参考
   - 添加"下一步"链接到其他文档

3. **调整 SKILLS.md**
   - 移除"跨平台抽象"章节
   - 在简介中添加链接：参见 ARCHITECTURE.md

4. **补充 ARCHITECTURE.md**
   - 添加"CLI 命令映射"章节
   - 展示 GitLab/GitHub 命令对比表

5. **删除 QUICK-START.md**

## 最终文档地图

```
README.md
  ├─ 项目介绍
  └─ → docs/GETTING-STARTED.md (5分钟入门)

docs/GETTING-STARTED.md
  ├─ 安装
  ├─ 配置
  ├─ 第一个命令
  └─ → ARCHITECTURE.md, WORKFLOWS.md, SKILLS.md

docs/ARCHITECTURE.md
  ├─ 跨平台抽象层
  ├─ CLI 命令映射表 (新增)
  └─ 扩展点

docs/WORKFLOWS.md
  ├─ Issue → MR 流程
  ├─ 调度器
  └─ Skills 集成

docs/SKILLS.md
  ├─ 设计原则
  ├─ 8 个核心 Skills
  └─ References 目录
```
