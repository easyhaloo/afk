# ADR-0021 — Backlog 关系的承载方式与记录可读性

- **Status:** accepted
- **Date:** 2026-11-03
- **Decision Drivers:** 记录可读性、provider 标签的能力边界、关系既要机器可读又要可点击

## Context

AFK 把 backlog 工作项写进 provider（GitHub / GitLab）的 issue。issue 的标签栏既是读者最先看到的地方，也是 AFK 自己的机器通道 —— 跨仓图谱、调度与去重都靠它。

一次真实使用（把一份已批准的 PRD 落成 issue）暴露了六个问题：

1. **`--project` 有三套互不兼容的写法。** 裸项目路径 `group/subgroup/project`、manifest 用的规范键 `gitlab:group/sub/project`、以及带实例主机名的形式，各自在不同入口被要求。给错一种，报的是 404 或一句看不懂的 "work item project key is invalid"。
2. **manifest 表达不了 PRD 锚点。** manifest schema 没有角色字段，`kind::prd` 只能另起一条命令创建，"一份 manifest 就是一份完整计划"的契约被打破。
3. **链接段被追加两次。** `renderBacklogDescription` 只判断有没有链接可写，不判断正文里是不是已经有 `## Backlog Links` 段，于是同一个名字的段落出现两份，其中一份还留着调用方没替换掉的占位符。
4. **幂等标记暴露在读者面前。** `idempotency::<64 位十六进制>` 是一个机器标记，却以 provider 标签的形式出现在每个人的标签栏里。
5. **同仓关系写成完整规范身份。** `parent::gitlab:host/group/project#31` 六十多个字符，在标签栏里占满一行；而短式 `parent::31` 本来就能表达同一件事。
6. **标签跳不过去。** GitLab 的标签芯片是**过滤器**，点它只会跳到标签页。读者能跟着走的关系有两条：正文里的链接，和 provider 原生的 issue 链接 —— 而 AFK 只给依赖边写了原生链接，父边漏了。

第 5、6 条的解法看着是"用原生链接取代标签"，但在本实例上实测下来不可行：

| 前提 | 实测结果 |
| --- | --- |
| links API 能判断"谁是谁的父" | ✗ 响应里**没有方向字段**。一对 issue 只存一条链接，从任一端查询都得到对方 |
| links API 能区分父边与依赖边 | ✗ 本实例 GitLab 13.12.12 的 `set_link_type` 是 EE-only 空实现，**`blocks` 被存成 `relates_to`**。实测 #30 的 9 条跨项目依赖边全部返回 `link_type: relates_to` |

可用的部分确认了：跨项目关系**能**从一端枚举（#30 的 links 返回了 5 个不同 `project_id` 的 issue），原生链接**能**写、**能**在 UI 里点击。

即便如此，要用链接取代标签，方向与边类型仍只能从**正文**解析（AFK 独占的 `## Backlog Links` 段），而正文是人可编辑的 —— 机器真相对可编辑内容的可靠性低于标签。GitHub 侧没有可枚举的原生链接（AFK 写评论），标签在那边还必须保留。

## Decision

标签是**机器通道**（住在子项上，天然带方向，provider 端可服务端过滤），原生链接是**人读通道**（可点击）。两条通道各司其职。

1. **`--project` 归一。** 新增 `parseProjectArgument`（`packages/runtime/src/domain/work-item/identity.ts`），把规范键与裸路径归一成 provider 需要的 `(platform, projectId, host)`；裸路径仍交给 provider 自己判断，行为不变。
2. **manifest 可表达角色。** schema 增加 `kind: z.enum(['prd']).optional()` 并透传；锚点与它的实施条目由一条 manifest 建完。锚点永远不自治（`kind: prd` 配 `executionMode: afk` 会被拒）。
3. **链接段写进已有的段。** 正文已含 `## Backlog Links` 时，AFK 的条目写进那一段而不是再开一段；AFK 负责的条目被替换（指向旧位置的过期条目比缺失的条目更糟），作者自己写的条目保留。
4. **幂等标记进正文。** 重试标记是记录正文里的一条注释（`<!-- afk:idempotency:<sha256> -->`），provider 渲染 Markdown 时不显示。重试查找改为列出项目里的 issue、在正文中比对标记；GitHub 侧 `listIssues` 同时改为分页取全部（此前只取第一页，本身就是一处会静默截断的缺陷）。存量记录仍带旧标签，查找同时认旧标签，因此不会被孤立。
5. **同仓关系写短式。** 目标与记录在同一项目就写 issue 号，跨仓库才写规范身份。`planRelationLabelDelta` 原本按"标签值 == 规范身份"直接比对，短式下该比对不再成立，改为**先解码成身份再比对**。被触碰的边归一成当前形式，没被触碰的保持原样 —— 存量是渐进迁移而不是一次性重写。
6. **父边双写。** 父边除了标签，还写一条 provider 原生 `relates_to` 链接（跨项目带目标项目）；GitHub 上是点名父项的评论。关系因此出现在 issue 的 "Related issues" 里，点得动。

跨仓图谱两种标签形式都查，并按各自项目解码校验：短式在另一个项目里指的是那个项目的编号，不会串味。投影失败的记录被跳过而不是让整次查询失败 —— 扫多个仓库时，一条读不懂的记录不该让其他记录消失。

## Consequences

**正向**：

- 关系既机器可读又可点击；标签栏里只剩读得懂的东西
- 一条记录的关系标签从六十余字符降到个位数
- 幂等重试从"扫标签"变成"读正文"，不再有 64 位十六进制出现在读者面前
- manifest 一条命令建完锚点与其子项，中间失败不留半套记录
- `--project` 的三种写法等价，调用方不必剥前缀

**代价**：

- 标签形态变了（`parent::N` 取代 `parent::gitlab:host/path#N`）。存量记录两种形式并存，图谱两种都读；被编辑过的边归一成新形式
- 幂等查找要列出项目的 issue 并读正文，比按标签过滤重。GitHub 侧为此补了分页
- 跨仓图谱多一条路径：标签查 + 解码校验
- 目录结构变化：实现级细节从 `docs/architecture/overview.md` 移到本 ADR，符合"PRD 文档不存放在 `docs/` 中"的约定
- `planRelationLabelDelta` 的比较语义变了（解码后比对），依赖它的每处都要跟着理解

**撤销方案**：

- 标签形态可回滚到规范身份：codec 与图谱两侧改回，存量记录不受影响（新旧两种都读）
- 幂等标记可回滚到标签：唯一代价是读者面前又出现一串十六进制
- 父边的原生链接可停写：标签与正文链接都还在，关系不会消失，只是要回到正文里找

## 验证

```
pnpm build                全部工作区包通过
pnpm typecheck            全部通过
pnpm test                 exit 0（runtime 1258 / cli 354 / root 126）
pnpm architecture:check   310 files, 0 violations
pnpm docs:check           292 files, 0 broken
```

## 相关

- `packages/runtime/src/domain/backlog/metadata-codec.ts` —— 标签的解析、比对与序列化
- `packages/runtime/src/domain/backlog/idempotency.ts` —— 重试标记的生成与读回
- `packages/runtime/src/infrastructure/provider/backlog-graph.ts` —— 跨仓图谱的双形态查找与解码校验
- `packages/runtime/src/domain/backlog/tracker-provider.ts` —— 依赖边与父边的原生链接写入
