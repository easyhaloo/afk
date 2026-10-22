# 终端编码 Agent 对比研究:Claude Code / Codex CLI / opencode

> 版本快照:**2026-10-20**
> 工具版本:`codex-cli 0.163.0` · `Claude Code 2.1.300` · `opencode 1.18.31`
> 方法:本机原生二进制定向探测 + 本机会话日志聚合 + 外部公开对照实验
> 声明:本报告的结论建立在**工具层(harness)**证据上,模型能力本身被刻意排除在因果链之外。

---

## 0. 摘要

五个结论,每个都有本机可复现的证据支撑:

1. **"Claude Code 更快"不是一个单一现象,而是三个独立变量的叠加**:单轮物理速度、收敛性(尝试次数)、以及验证广度的默认取舍。第三项最被忽略,常常占据差距的大头。

2. **工具层的核心差异只有一条:一个任务需要多少次「往返」,每次往返里 harness 给了模型多少确定性的抓手。** Claude Code 把 21.0% 的调用分流到专用结构化工具(Read / Edit / Write),Codex 则是 100% 压在 shell 上,连读文件都要自己拼 `sed`。

3. **Codex 的每次任务往返数显著更多**:中位 13.1 次 vs 5.0 次,均值 24.8 vs 6.8,p90 36.0 vs 14.0。

4. **Codex 的"多次 review"是真实存在的,而且可量化**:验证/编辑比 1.9:1(vs Claude Code 0.9:1),外加 943 次 `write_stdin` 中 924 次是**空输入轮询**长驻进程 —— 纯等待,每次都是一次完整模型往返。

5. **Codex 长任务不易漂移,机制可以被直接测出来**:Codex 回灌进上下文的模型自述仅占 **0.9%**;Claude Code 占 **15.1%**。且 Claude Code 的 thinking 块带 Anthropic API 签名,**被强制原样回传每一轮**;Codex 的 `raw_content` 恒为 `[]`,完整推理只存在于事件日志、从不回灌。**自述回流是漂移的载体。**

---

## 1. 证据来源与方法

### 1.1 本机工具面探测

对三个原生二进制做定向字符串探测(而非全量 `strings`):

| harness | 二进制体积 | 探测方式 |
|---|---|---|
| Claude Code | 250 MB | `claude.exe` 内 `bytes.find` 匹配工具名 |
| Codex | 250 MB | `codex` 内 `bytes.find` 匹配工具名 |
| opencode | 144 MB | `opencode.exe` 内 `bytes.find` 匹配工具名 |

> **方法学限度**:字符串出现在二进制中只能证明该标识符存在,不能单独证明它是被暴露给模型的工具。三者的标识符集合高度自洽,且包含显式 `*Tool` 后缀(`GlobTool`、`SlashCommandTool` / `AgentTool`、`ApplyPatchTool`、`ShellTool`),因此结论可信;但这仍是**间接证据**,非官方 API 文档。

### 1.2 本机会话日志聚合

| harness | 数据源 | 样本 |
|---|---|---|
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 97 个会话 / 276 个任务 / 6833 次调用 |
| Claude Code | `~/.claude/projects/*/*.jsonl`(排除 `subagents/`) | 157 个会话 / 2085 次用户输入 / 14082 次调用 |

只统计**计数、工具名、命令首动词、内容块类型与字节量**,不读取、不留存任何对话正文。

### 1.3 外部对照实验

| 来源 | 样本 | 用途 |
|---|---|---|
| [Builder.io](https://www.builder.io/blog/opencode-vs-claude-code) | 同模型(Sonnet 4.5)、全新 Docker、4 任务 | 隔离 harness 差异 |
| [Respan](https://www.respan.ai/blog/tracing-claude-code-and-codex-traced) | 30 任务 × 3 次,OTel 全链路 trace | 规划/工具/恢复行为 |
| [SyFI TraceLab](https://tracelab.cs.washington.edu/exp/llm_generation/context_decode_speed_scatter) | 665,453 个真实 agent step | 物理层吞吐与 TTFT |
| [AgentsRoom](https://agentsroom.dev/zh/blog/measure-claude-code-tokens-per-second/) | 20,408 轮 / 1200 万输出 token | Claude Code 单轮速度分解 |

---

## 2. 三种工作模式(行为层)

### 2.1 Claude Code:前置规划型

多文件任务上,首次读文件前先烧 2,000–4,000 token 做规划。代价与收益都很明确:

- 首次编辑的中位时间比 Codex **慢 12 秒**
- 同一文件的修改次数**低 40%**
- 首次写入前平均读 8.2 个文件(重构任务 14 个),并用 grep/glob 做 3–5 次结构搜索
- 错误修复平均 **1.3 次尝试**(Codex 1.8 次)

作者评价精准:"**它想得更多,回头更少。**"

### 2.2 Codex CLI:反应式迭代型

读 → 改 → 读 → 改。单次尝试更快,但容易治表不治本,修复链叠加。原始输入 token 更少(12,100 vs 18,400),输出 token 更多(5,800 vs 4,200)—— 总 token 少约 20%,但中位墙钟**反而更快**:41s vs 48s。

**Claude Code 的优势不在平均值,而在尾部:**

| 指标 | Claude Code | Codex |
|---|---|---|
| 中位墙钟 | 48s | **41s** |
| **p90 墙钟** | **78s** | 94s |
| 3 分钟内完成率 | 83% | 79% |
| ├ 多文件任务 | **87%** | 74% |
| └ 单文件任务 | 90% | **91%** |

### 2.3 opencode:验证优先型

原生 Build / Plan 模式分离(Tab 切换),另有 Debug / Review / Docs;接真实 LSP(gopls / typescript-language-server / pyright / rust-analyzer),每次编辑后回灌真实诊断;按 agent glob 精细分配 MCP 工具。

**代价是每次都要付的固定税。** Builder.io 用完全相同的 Claude Sonnet 4.5、全新 Docker、无历史配置跑同一组任务:

| 任务 | opencode | Claude Code | 胜者 |
|---|---|---|---|
| 修 bug(藏了类型错误) | 41s | 40s | 平 |
| 重构(抽公共 helper) | **40s** | 2m10s | opencode |
| 跨文件重命名 | 3m13s | 3m06s | 近乎平 |
| 写测试 | 9m11s(94 个) | **3m12s**(73 个) | Claude Code |
| **总计** | 16m20s | 9m09s | Claude Code |

**"快不少"全部集中在写测试那一格。** 挖开那 9 分钟:

> opencode 跑了 `pnpm install` 确保依赖是新的,然后执行了**整个**测试套件确认没有回归;写了 94 个测试用例,并确认它们与已有的 200+ 个测试相处融洽。
> Claude Code 为速度而优化。它写了 73 个测试,验证**那些**测试通过,然后就收工了 —— 没跑全量套件。

所以计时器上的差距,大部分是 opencode 替你多做的质量保证。**这个差距应该记在 opencode 头上,而不是记成"效率低"。**

### 2.4 物理层:decode 速度的实际量级

TraceLab 的 665,453 步实测:

- Claude 分箱中位归一化 decode 速度在 **54–58 tok/s** 基本持平,仅在最长上下文(约 740k input token)降到 ~48 tok/s
- Codex 斜率更陡:12k–23k input 时 ~40–41 tok/s,到 185k 时降到 **~28 tok/s**;拆开看,纯 decode 74→55 tok/s,残余 TTFT 1.5s→2.8s

AgentsRoom 的 20,408 轮实测给出了为什么 tok/s 不等于完成速度:

- 每轮首 token 前有固定开销:Opus 5/5.5 约 1s,Sonnet 5 约 0.5s
- 于是 **80 token 的短回答实测仅 40 tok/s,3000 token 的回答跑到 80+ tok/s** —— 流式速度恒定,短回答只是被固定开销摊薄
- **提示词缓存不提速**:命中 60.6 vs 未命中 58.0 tok/s,整轮 3.4s vs 3.7s。缓存影响的是上下文单价,不是速度
- 思考 token 计入 output:Opus 5 占 30%,Opus 5.5 占 18%,**Sonnet 5 占 54%** —— "思考很久的一轮并不慢,它在生成你看不到的 token"

> **口径提醒**:上表所有"模型名/速度"结论均属**模型层**,在本报告的因果链中只作为背景,不用于解释 harness 差异。

---

## 3. 工具层:harness 的结构差异

### 3.1 工具面

| harness | 确认存在的工具面 |
|---|---|
| **Claude Code** | `Read` `Write` `Edit` `MultiEdit` `NotebookEdit` `NotebookRead` `Glob` `GlobTool` `Grep` `WebFetch` `WebSearch` `TodoWrite` `Task` `Agent` `Skill` `SlashCommand` `SlashCommandTool` `AskUserQuestion` `ExitPlanMode` `Bash` `BashOutput` `KillShell` `TeamCreate` `SendMessage` `ScheduleWakeup` `Workflow` `TextEditor` `ListMcpResources` `ReadMcpResource` `View` |
| **Codex** | `ShellTool` `ApplyPatchTool` `PatchTool` `AgentTool` `unified_exec` `apply_patch` `view_image` `web_search` `update_plan` `write_stdin` `read_file` `move_file` `spawn_agent` `send_input` |
| **opencode** | `read` `write` `edit` `patch` `bash` `glob` `grep` `list` `webfetch` `websearch` `todowrite` `task` `skill` `lsp` `diagnostics` |

**Codex 探测不到:`ReadFileTool` `GrepTool` `GlobTool` `ListDirTool` `WriteFileTool` `EditTool` `TodoWrite`。**

即:Codex **没有独立的读文件、搜索、列目录、编辑、待办工具**。仓库探索必须走 shell。

### 3.2 后果:往返次数

| | 会话数 | 用户任务 | 工具调用 | 中位/任务 | 均值 | p90 | max |
|---|---|---|---|---|---|---|---|
| **Codex** | 97 | 276 | 6833 | **13.1** | **24.8** | **36.0** | 69.8 |
| **Claude Code** | 157 | 2085 | 14082 | **5.0** | **6.8** | **14.0** | 47.2 |

### 3.3 差距的真正来源:构成,不是数量

**Codex 工具构成(6833 次)**

```
exec_command    5252   76.9%
write_stdin      943   13.8%   ← 累计 90.7% 压在 shell
js               205    3.0%
view_image       117    1.7%
wait_agent        92    1.3%
send_input        63    0.9%
spawn_agent       42    0.6%
close_agent       38    0.6%
update_plan       31    0.5%
```

**Claude Code 工具构成(14082 次)**

```
Bash            9885   70.2%
Read            1426   10.1%   ┐
Edit            1246    8.8%   ├ 专用读写工具合计 21.0%
Write            285    2.0%   ┘
Agent            257    1.8%
MCP 系列         652    4.6%
```

**Codex 实际执行了什么(5252 次 `exec_command` 的首动词):**

```
 837  15.9%  sed        ┐
 678  12.9%  rg         │
 536  10.2%  cat        ├ 读/浏览 47.8%
 218   4.2%  nl         │
 112   2.1%  find       │
 128   2.4%  tail       ┘
 564  10.7%  apply_patch   ← 编辑(且走 shell,非专用工具)
 438   8.3%  git        ┐
 106   2.0%  gh         ┘ 版本控制 10.3%
 270   5.1%  pnpm        ┐
 250   4.8%  node        ├ 构建/测试 9.9%
```

**读:写比约 4.5:1。**

> **值得注意**:`apply_patch` 在 Codex 里**既存在、又在 276 个任务中一次都没被当作工具调用过** —— 564 次出现全部是塞进 `exec_command` 的 shell 命令。Codex 连编辑这一条路径都比 Claude Code 多绕一层 shell。

**Claude Code 的 Bash 首动词(9874 次)**:`cd` 24.1% / `grep` 13.3% / `git` 8.3% / `python3` 5.3% / `ls` 4.6% / `echo` 3.3% / `cat` 2.9% / `sed` 2.3% / `pnpm` 2.2% / `curl` 2.1%

### 3.4 "多次 review":能量化

| | 验证类调用 | 编辑类调用 | 比值 |
|---|---|---|---|
| **Codex** | `node`+`pnpm` 520,`git`+`gh` 544 = **1064** | `apply_patch` **564** | **1.9 : 1** |
| **Claude Code** | `git`+`gh`+`pnpm`+`curl` 1440 | `Edit`+`Write` **1531** | **0.9 : 1** |

加上 Codex 独有的 **943 次 `write_stdin`,其中 924 次是空输入(98%)** —— 那不是"往进程里写东西",而是**反复空轮询一个还活着的进程**。每次空轮询都是一次完整的模型往返(上传请求 → 模型生成 → 工具返回)。**这占 Codex 全部调用的 13.8%,且 100% 是纯等待。**

> 对比之下,Claude Code 没有任何等价机制 —— 它的 `Bash` 是阻塞式的,命令跑完才返回。

### 3.5 权限模型 = 每个人工往返的乘数

从 Codex 二进制里能直接读到**按工具类型分开**的审批通道:

```
command execution approval is not supported in exec mode for thread ...
apply_patch approval is not supported in exec mode for thread ...
request_user_input is not supported in exec mode for thread ...
permissions approval is not supported in exec mode for thread ...
```

配合默认沙箱 + **网络关闭**,后果是:每次 `npm install` / `git fetch` / `curl` 都是一次独立升级审批。

对照:
- **Claude Code** — 权限模式优先(某工具首次询问后记住)+ `--allowedTools` + `--dangerously-skip-permissions`
- **opencode** — 有序规则集,最后匹配规则胜出,**默认 `ask`** + `--auto` 一次性放行

**没有彻底关闭人工确认的开关,就没有"快",只有"等人"。**

### 3.6 启动固定成本

Claude Code 的 `--bare` 把常规启动开销暴露了出来 —— 它跳过的正是:

> hooks(设置与插件定义的)、**LSP**、plugin sync、attribution、auto-memory、**background prefetches**、keychain reads、CLAUDE.md auto-discovery

即常规启动要跑 LSP + 插件同步 + 后台预取 + 密钥链读取 + 多层记忆。opencode 每会话起 LSP 客户端;Codex 的 250 MB 二进制静态包含 `rg`(4 MB)与 `codex-voice-host`(10 MB,带 gstreamer),这些是进程启动时的动态链接成本,与是否用到无关。

### 3.7 扇出能力:差距已基本抹平

| 能力 | Claude Code | Codex | opencode |
|---|---|---|---|
| 子代理 | `Task` / `Agent`(独立上下文窗口) | `AgentTool` / `spawn_agent` / `send_input` | `task` |
| 跨代理通信 | `TeamCreate` + `SendMessage` | daemon 级 `agents` 子命令 | — |
| 后台会话 | `--background` + `claude agents` | `fork` / `queue` | `serve` / `attach` / `web` |
| 远程驱动 | `--cloud` | `remote-control` | mDNS 服务发现 |
| 结构化编排 | `Workflow` / `ScheduleWakeup` | — | — |

opencode 最早做服务端化,现在三家基本对等。**Claude Code 剩下的真实增量在 `Workflow` / `ScheduleWakeup` / `TeamCreate` —— 不是"能不能并行",而是"能不能编排并行"。**

---

## 4. 为什么 Codex 长任务不容易漂移

> **前提说明**:漂移本身无法从日志直接测出(需要语义标注)。本节测的是**预示漂移的结构**。用户观察到的"Codex 不易漂移 / Claude Code 易漂移"是现场经验;下面给出与之相容的具体机制及其可证伪的推论。

### 4.1 机制:自述回流

漂移的定义是**上下文与任务目标发生偏离**。上下文由两类东西组成:

- **事实** —— 仓库里现在是什么样。不可变。
- **自述** —— 模型自己之前的推理与叙述。可变,而且**会自我强化**。

自述回流之所以导致漂移,机制有三层:

1. **假设残留** —— 一条被写进上下文的假设("bug 在 config loader 里")会在此后每一轮被重新加权。模型不会"知道"它已被证伪,它只看到这句话躺在那里,周围是更新的内容。
2. **叙事惯性** —— 扩展思考以第一人称、向前推进的流动文体写成("我需要……,所以让我……")。重读它会让"继续这个叙事"显得自然,而"回到最初的任务"反而像跑偏。
3. **单调累积** —— 每轮都往一个已经富含自述的上下文里再加自述。"模型认为自己在做什么"与"实际真相"的比例单调上升,直到某个工具结果重置了事实 —— **但重置不了故事**。

### 4.2 实测:两个 harness 的上下文构成

| 内容来源 | Codex(180.4 MB) | Claude Code(82.7 MB) |
|---|---|---|
| 工具输出(事实) | `function_call_output` 38.8% + `CommandExecution` 35.4% | `tool_result` **71.5%** |
| 工具调用参数 | `function_call` 3.5% | `tool_use` **11.0%** |
| 注入的指令(system/AGENTS.md) | `message` 6.0%(role=developer/user) | `user_text` 2.4% |
| **模型自述回流** | `item:Reasoning` 0.6% + `item:AgentMessage` 0.3% | `thinking` **12.9%** + `text` **2.2%** |
| **自述占比合计** | **0.9%** | **15.1%** |
| 事件日志中的完整推理(不回灌) | `reasoning` 12.5%(均值 3839 字符) | — |

**差了约 17 倍。**

### 4.3 为什么 Claude Code 一定会回流

Claude Code 的 thinking 块带 **64 位十六进制 `signature`**:

```json
{ "type": "thinking", "thinking": "Let me understand the task:...", "signature": "399b1ba2217854bff..." }
```

Anthropic API 要求此前轮次的 thinking 块**原样回传**(签名必须有效)。因此:

- thinking 块长度:中位 618 / 均值 1297 / p90 2986 字符
- 每轮回灌的自述字节:中位 338 / 均值 **938** / p90 **2233**

而 Codex 的对应结构:

```json
{ "type": "Reasoning", "id": "rs_01c8e9...",
  "summary_text": ["**Clarifying task requirements**\n\nI need to focus on..."],
  "raw_content": [] }
```

- `raw_content` **恒为 `[]`** —— 完整推理不进上下文
- `summary_text` 中位长度 **2 字符**(绝大多数为空),均值 70 字符
- 完整推理(均值 3839 字符)只存在于 `event_msg.reasoning` **事件日志**,仅供展示与遥测

**Codex 把"想"和"留痕"彻底分开:想完就扔,只留动作和事实。Claude Code 把"想"也一起留着。**

### 4.4 第二机制:harness 注入的自述通道

Claude Code 还有一类 Codex 没有的注入内容 —— **由模型或 hook 撰写、却被当作权威上下文的内容**:

| 注入类型 | 条数 | 体积 |
|---|---|---|
| `isMeta` 注入消息 | 340 | 1864 KB(其中 145 条 text 占 1502 KB) |
| `stop_hook_summary` | 583 | 549 KB |
| `away_summary` | 251 | 158 KB |
| `compact_boundary` | 27 | 31 KB |
| **合计(去重)** | 1201 | **2602 KB(约 2.54 MB)** |

`away_summary` 尤其关键:**你离开后回来,harness 递给 agent 的是它自己对你缺席期间的一份总结。** 如果这份总结有偏差,agent 就从一个错误的状态继续 —— 而且永远不会察觉,因为**这份总结本身就是上下文**。

### 4.5 第三机制:压缩的取材不同

| | Claude Code | Codex |
|---|---|---|
| 发生压缩的会话 | 27/150(18%) | 16/97(16.5%) |
| 触发 | `auto`,preTokens 观测到 166,979 / 187,178 / 238,751 / 270,375 / 316,463 / 368,389 | `compacted` 事件,带 `replacement_history` / `message` / `window_number` |

**压缩频率接近,压缩的取材完全不同。** Claude Code 要总结的是"15% 自述 + 71.5% 事实";Codex 要总结的是几乎纯事实。前者的摘要是一段**故事**,后者是一份**状态清单**。故事在摘要中会被改写、软化甚至丢掉原始任务;状态清单不会。

### 4.6 排除一个竞争假设

一个自然的猜想是"Claude Code 想得多所以更容易偏"。这个解释方向反了,数据也不支持:

- **运行长度**:Codex 每次任务中位 **13.1** 次工具调用,Claude Code 每次输入中位 **5.0** 次 —— **Codex 的自主段更长,却更不容易漂移**。若漂移由"连续动作太多"驱动,预测应相反。
- **待办清单改写**:一个常见猜想是 TodoWrite 被模型改写成"配合当前行为",从而掩盖漂移。**实测不成立** —— 150 个会话中 `TodoWrite` 仅被调用 **1 次**。这条机制在本工作流中不存在。

### 4.7 可证伪的推论

如果上述机制成立,应当可以观察到:

1. **降低 Claude Code 的自动压缩窗口,漂移应当可测地下降** —— 因为更早压缩意味着摘要取材于更少的累积自述。`--autocompact` 接受 `auto` 或 `100k–1M` 的 token 值,这是现成的旋钮。
2. **在长任务中人工重述目标,应当比让 harness 生成摘要更有效** —— 前者是事实,后者是故事。
3. **Codex 的漂移率应当对"推理长度"不敏感** —— 因为推理根本不在上下文里。

第 1 条最容易验证,建议优先做。

### 4.8 缓解手段(仅 Claude Code 侧)

| 手段 | 依据 |
|---|---|
| `--autocompact 100k`(低于默认 auto) | 压缩取材于更少累积自述 |
| 任务边界处手动 `/compact` | 同上,且可控 |
| 长自主段之间人工重述目标 | 用事实替代 harness 生成的故事 |
| 把探索性工作推给子代理 | 主上下文只留事实(Claude Code 的 Agent 工具独立上下文) |
| 短任务用 `--bare` | 跳过 hooks(少 `stop_hook_summary` 注入)、LSP、插件同步、后台预取、密钥链 |

---

## 5. 选型建议

| 场景 | 推荐 | 理由 |
|---|---|---|
| 多文件改动 | Claude Code | 前置规划 + 一次过率(多文件 87% vs 74%) |
| 需要大量读代码的探索 | Claude Code | 21.0% 专用读写工具分流,往返少一半 |
| 单文件、边界清晰的 bug | Codex | 前摇短,中位墙钟更快(41s vs 48s) |
| 有明确复现步骤的迭代 | Codex | 反应式循环成本低 |
| 高覆盖率模块的重构 | opencode | LSP 诊断 + 全量验证,多出的时间几乎全花在验证上(写测试 9m11s vs 3m12s) |
| 需要切 provider / 本地模型 | opencode | 75+ provider,Claude Code 与 Codex 均不支持 |
| 数据驻留 / 私有端点 | opencode | 直连 Bedrock / Azure / Ollama |
| 无人值守流水线 | 三个都要先关人工确认 | `--dangerously-skip-permissions` / `--auto` / Codex 审批白名单 |
| 长自主任务、担心漂移 | Codex | 自述回流仅 0.9% |

---

## 6. 局限与未验证项

1. **漂移未被直接测量。** 本报告测的是预示漂移的结构,漂移率本身需要人工标注或 LLM-as-judge。
2. **任务单位不完全对等。** Codex 的 `task_started`(每会话 2.8 个)与 Claude Code 的用户输入(每会话 13.3 次)粒度不同;后者混入大量短追问,会把中位数压低。"13.1 vs 5.0" 这个比值偏乐观,建议按七折理解。**但工具构成的差异不受此影响** —— 那是各 harness 内部的比值。
3. **二进制字符串探测是间接证据。** 见 §1.1。
4. **外部对照实验的时效性:**
   - Builder.io 用 Sonnet 4.5,单仓库、每任务单次运行、n=4、无重复实验
   - Respan trace 采集于 2026 年 4 月,当时默认模型
   - opencode 版本快照为 1.18.31,发布节奏很快
5. **本机 6.4 GB 单文件 SQLite**(`opencode.db`,5.94 GiB)与 `~/.local/share/opencode` 合计 7.8 GB,推测与 opencode 启动延迟、内存占用相关,但**未实测启动耗时,存疑**。对照组:`~/.claude` 1.6 GB、`~/.codex` 4.5 GB。
6. **样本来源偏斜。** 本机数据来自 afk-loop 编排工作流,任务形态与日常开发不同。

---

## 附录 A:复现方式

### A.1 工具面探测

```bash
python3 - <<'PY'
import os
targets={
 "CLAUDE CODE":("~/.nvm/versions/node/v24.18.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
   ["Read","Write","Edit","MultiEdit","Glob","Grep","TodoWrite","Task","Agent","Skill"]),
 "CODEX":("~/.nvm/versions/node/v24.18.0/lib/node_modules/@openai/codex/node_modules/"
          "@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
   ["ShellTool","ApplyPatchTool","AgentTool","read_file","apply_patch",
    "ReadFileTool","GrepTool","GlobTool","EditTool","TodoWrite"]),
}
for name,(p,cands) in targets.items():
    data=open(os.path.expanduser(p),'rb').read()
    print(name, "FOUND :", [c for c in cands if data.find(c.encode())>=0])
    print(name, "ABSENT:", [c for c in cands if data.find(c.encode())<0])
PY
```

### A.2 Codex 往返次数与工具构成

```bash
python3 - <<'PY'
import json,glob,collections,statistics as st
files=sorted(glob.glob("~/.codex/sessions/2026/*/*/*.jsonl"))
per=[]; names=collections.Counter()
for f in files:
    tasks=calls=0
    for line in open(f,errors="ignore"):
        try: o=json.loads(line)
        except: continue
        p=o.get("payload") or {}; t=p.get("type")
        if t=="task_started": tasks+=1
        elif t=="function_call": calls+=1; names[p.get("name")]+=1
    if tasks>0: per.append((tasks,calls))
r=sorted(c/t for t,c in per)
print(f"codex sessions={len(per)} calls={sum(c for _,c in per)} "
      f"median={st.median(r):.1f} mean={sum(c for _,c in per)/sum(t for t,_ in per):.1f}")
print(names.most_common(12))
PY
```

### A.3 上下文构成对比

Claude Code:`~/.claude/projects/*/*.jsonl`(排除 `subagents/`),按 `type=assistant` 的 content 块(`thinking`/`text`/`tool_use`)与 `type=user` 的 `tool_result` 统计 JSON 序列化字节。

Codex:`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,按 `event_msg` 的 payload 类型与 `response_item` 的 `item.type` 统计。

关键校验点:Claude Code 的 thinking 块是否带 `signature`(决定是否被 API 强制回传),Codex 的 `item:Reasoning.raw_content` 是否为空(决定推理是否回流)。

---

## 参考

- [Builder.io — OpenCode vs Claude Code](https://www.builder.io/blog/opencode-vs-claude-code)
- [Respan — Tracing Claude Code and Codex](https://www.respan.ai/blog/tracing-claude-code-and-codex-traced)
- [SyFI TraceLab — Context vs decode speed](https://tracelab.cs.washington.edu/exp/llm_generation/context_decode_speed_scatter)
- [AgentsRoom — Claude Code 到底有多快](https://agentsroom.dev/zh/blog/measure-claude-code-tokens-per-second/)
- [AICoderScope — OpenCode review 2026](https://aicoderscope.com/blog/opencode-review-2026)
- [Tygart Media — Claude Code vs Codex CLI](https://tygartmedia.com/category/claude-code-insider/claude-code-vs-alternatives)
- [OpenCode 官方文档 — Agents](https://opencode.ai/docs/agents/) · [LSP](https://opencode.ai/docs/lsp/)
