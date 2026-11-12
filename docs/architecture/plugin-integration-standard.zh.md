# 插件接入标准 v1

本文规定能力插件的接口、协议和生命周期。能力现状与配置示例见[插件架构](plugins.zh.md)，
命令入口见[执行架构](execution.zh.md#执行入口)。注册成功、协议测试通过与真实厂商端到端
可用是不同证据，不能互相替代。

## 1. 身份与权限边界

- Core 负责工作身份、状态机、资格、审计顺序、预算、租约和人工合并闸门；插件返回操作结果。
- 插件 ID、能力 ID、Provider 注册名分别独立；插件 ID 不得以 `afk.` 或 `afk-` 开头。
- `BacklogItem.id`、`Run.workItemId`、`runId`、`parentId`、`dependsOn`、`baseBacklogId` 不可互换。
- 插件为宿主进程内的可信代码；`trusted: true` 不构成进程隔离或发布者签名验证。
- 不提供自动合并、审批、提升权限或绕过策略的插件操作。

## 2. 包、Manifest 与工厂

安装包包含包描述、根 `plugin.json` 及可加载入口。入口必须在包内，禁止绝对路径、目录穿越
和符号链接逃逸。Manifest 示例：

```json
{
  "id": "context.project-note",
  "version": "1.0.0",
  "apiVersion": 1,
  "trusted": true,
  "provides": ["context.provider"],
  "requires": [],
  "conflicts": [],
  "configSchema": {
    "type": "object",
    "properties": {"note": {"type": "string", "minLength": 1}},
    "required": ["note"],
    "additionalProperties": false
  }
}
```

`id` 稳定且唯一，`version` 使用语义化版本，`apiVersion` 当前为 `1`；`provides/requires`
声明能力，`conflicts` 声明插件或能力冲突。安装入口元数据与运行时 Manifest 分开校验。
模块可导出插件对象，或接收 `{configuration, homeDir, workspaceRoot}` 的工厂。
配置只含可序列化值；transport、回调、执行器、客户端由工厂创建。

```ts
interface Plugin {
  readonly manifest: PluginManifest;
  activate(context: PluginSetupContext): void | Promise<void>;
  health?(): PluginHealth | Promise<PluginHealth>;
  diagnostics?(): readonly PluginDiagnostic[] | Promise<readonly PluginDiagnostic[]>;
}
```

`PluginSetupContext` 提供类型化 `register…Provider`、`registerCapability`、
`getProvider/getCredentialProvider`，以及 `registerLifecycle`、`registerSystemAction`、
模板/界面注册和 `onDispose`。注册名稳定、唯一；Manifest 声明本身不会构造 Provider 或挂载 UI。

## 3. 能力接口与调用协议

| 能力 / 接口 | 操作和结果契约 |
|---|---|
| `agent.provider` / `AgentProvider` | `createExecution`；声明会话、streaming、usage、resume 等能力及提示词上限，运行器拥有进程/会话生命周期。 |
| `sandbox.provider` / `SandboxProvider` | `createWorktree`、`create`；返回的 Sandbox 管理 Agent 启动、命令执行与销毁，明确工作区和隔离边界。 |
| `host.connection` / `HostConnectionPort` | `listHosts/resolve/exec`，可选 `upload`；命令使用 argv，远程非零退出仍返回原 `code/stdout/stderr`，连接/认证/超时单独分类。 |
| `tracker.issue` / `IssueTrackerPort` | 字符串 issue ID 的 CRUD、评论、关系、`health/doctor`；保留真实项目、ID、key 和 URL。 |
| `tracker.provider`、`backlog.provider` | 源码托管 issue/change request 与规范 backlog 身份；不把外部 issue key 当源码托管数字 ID。 |
| `verification.provider` / `VerificationProvider` | `verify` 返回 `passed`、时长和可选输出；目标工作区来自调用方。 |
| `notification.provider` / `NotificationProvider` | `notify` 返回 `delivered/channel/error?`；失败不得伪装为送达。 |
| `trigger.provider` / `TriggerProvider` | `register/unregister`；宿主管理 listener、timer 和 action 派发，见第 6 节。 |
| `context.provider` / `ContextSource` | `gather({scope,prompt,limit?})` 返回带 `origin` 的有界 fragment；只读取授权内容。 |
| `credential.provider` / `CredentialProvider` | `resolve({name,scope?})` 返回私有 `secret/expiresAt?`；不开放通用 CLI 输出。 |
| `artifact.provider` / `ArtifactSink` | `put({name,mediaType,bytes})` 返回 `{uri,name}`；写入前校验大小/路径，审计导出见第 7 节。 |
| `repository.provider` / `RepositoryProvider` | 必需 `snapshot`；可选 `prepare/checkout/publish/cleanup/withLifecycleLease`，见第 5 节。 |
| `policy.provider` / `PolicyCheckProvider` | `evaluate({action,context?})` 返回 `allowed/rule?/reason?`；required 闸门拒绝或异常阻止继续。 |
| Observability | EventStore `append/read`，EvidenceStore `put/get`，Tracer `startSpan/addEvent/endSpan?`，Metrics `record`。本地审计始终为权威。 |

通用能力 Provider 声明 `id` 与操作能力布尔表；Agent/Sandbox 使用各自的名称和能力集合。
可取消操作使用 `ProviderOperationOptions.signal`；未支持取消的接口必须明确边界。
Provider `health` 状态为 `ok/degraded/unavailable`，`doctor` 返回 `check/ok/detail?`；
插件级 `health` 状态为 `healthy/degraded/unhealthy/unknown`，与 Provider 检查结果区分。

公共调用 Envelope：

`context.provider/gather` 在 `scope/prompt/limit?` 外接受可选的 `applicability` 与 `target`；沿用共享上下文验证，版本、环境、项目、revision 和条件必须通过校验后原样交给 Provider。省略条件不放宽知识资产自身的适用性要求。
Envelope 字段必须为自身数据属性；Context 的上述顶层字段拒绝继承属性和 getter/setter，在联合协议解析前检查。合法的 null-prototype 数据对象仍可调用。

```json
{
  "capability": "verification.provider",
  "provider": "test-runner",
  "operation": "verify",
  "input": {"target": "workspace", "command": ["npm", "test"]}
}
```

能力、注册名和操作须在白名单内；输入及结果均校验专用 Schema。CLI 的输入文件仅包含
`input` 对象，位置参数组成 Envelope。Artifact 字节使用规范 base64，SDK 调用前解码。
Agent/Sandbox、任意插件方法及凭据解析不属于通用 dispatcher；可选操作仍须检查能力。
网络、进程、文件及输出须有边界；用户输入不得拼入 shell 字符串。

## 4. 激活、凭据和配置生命周期

`发现 → Manifest/配置校验 → 依赖排序 → 激活及注册 → 操作 → 逆序 dispose`。
激活失败回滚当前批次注册；外部资源、子进程和 timer 通过 `onDispose` 清理。
清理应幂等，一项失败不阻止其余清理；缺少健康检查时不得伪造健康。

内置 secret 字段接受 `{"env":"TOKEN"}` 或
`{"provider":"credential.enterprise","name":"deployment","scope":"read"}`，
`scope` 可省略，`provider` 为精确注册名。保存配置只校验引用形状，不认证、不访问网络。
构造时读取环境引用；激活时 await 凭据解析并校验实际值后注册消费者，失败不泄露原始错误。
同批具体凭据依赖排序，拒绝自环/互引环；缺失具名 Provider 延迟加载并给出诊断。
通用引用按激活取值，重新激活重取；Gmail 保留自身 OAuth 刷新。

管理守卫只检查静态 Manifest/配置及依赖，不执行插件；运行时检查可执行受信代码和凭据
解析。修改影响后续 Runtime/Worker，不热更新已有 Worker。活动或不可核实的 Worker
状态阻止安装/卸载，文件修改期间阻止 Worker 启动。Desktop 支持本地/npm 安装、启停、
卸载及最多 1 MiB 的 JSON 对象配置导入；内置插件不可卸载，卸载保留配置。

Google 面板经主进程完成客户端文件选择、浏览器授权、状态、取消和确认断开，凭据保存在
系统钥匙串，Renderer 只接收安全账号状态。成功登录配置 Google 凭据，仅缺失时添加 Gmail，
保留已有 Gmail 配置及禁用状态；后续配置失败保留已连接凭据，通知仍需显式集成。

## 5. 受管 issue 与仓库生命周期

外部 issue 导入指定的规范源码托管项目，默认 `hitl`。来源身份由 Provider、endpoint、
来源项目和 issue ID 形成，创建加锁且幂等。剥离外部伪造绑定后保存唯一来源绑定，返回
目标项目的规范工作项 ID；导入不隐式执行。状态同步须检查精确工作项与来源绑定，并提供
显式状态映射；仅变化时回写，拒绝组织父项和缺失映射。

仓库接口：

| 操作 | 请求 → 结果 |
|---|---|
| `snapshot` | `{url,ref?}` → `{commit,branch,dirty}` |
| `prepare` | `{repository:{url,ref?},runId}` → `{id,repository,runId,snapshot,path?}` |
| `checkout` | `{workspaceId}` → 同身份工作区，分支 `afk/<runId>` |
| `publish` | `{workspaceId}` → `{commit,branch,url?}`，必须匹配检查后的快照，不合并 |
| `cleanup` | `{workspaceId}` → `{removed}` |
| 组合 `run` | `{repository,runId,action,input}` → `{value,workspace,publication,cleanup}` |

`RepositoryLifecycleService.run` 要求四个 lifecycle 操作，按
`prepare → checkout → callback(workspace) → publish → cleanup` 执行，可由
`withLifecycleLease` 覆盖全过程。公开 `run` 仅派发已注册 action，传入
`{input,repositoryWorkspace,worktreePath}`；不自动替换工作项执行器。
本地 managed 仓库要求规范租约键和 checkout 所有权；远程/特殊 backend 显式声明
仓库/ref 白名单和支持的操作，默认仍仅 snapshot。

远程工作区协议以 `/workspaces/<repository>` 为资源根：GET `snapshot`；POST `prepare`；
句柄下 GET `sessions/<id>/snapshot` 及 POST `sessions/<id>/{checkout,publish,cleanup}`。
`<repository>` 是 `encodeURIComponent` 编码后的单一路径段，不是 lifecycle identifier：
可含空格和斜杠（如 `team/repo with space`），但拒绝 `.` / `..` 段、编码点段、 URL
形式及控制字符。lifecycle 的 `workspaceId` / `runId` 仍按 identifier 规则严格校验。
Bearer 只经 HTTPS。特殊 backend 使用 argv `[operation,"--json"]`，stdin 传 JSON 请求，
stdout 返回 JSON 结果；其仓库标识可以是本地绝对路径或经校验的 HTTPS URL，作为单个 argv
传入。两者都须校验句柄身份、运行/仓库对应关系及结果。

清理拒绝脏工作区、未发布提交、所有权缺失或变化的分支；本地另拒绝迁移路径及嵌套
worktree。失败/取消后以独立 15 秒 signal 清理，拒绝删除时保留现场；执行和清理同时
失败须同时报告。租约、幂等键均不授权删除未发布工作或自动合并。

## 6. Trigger 接收、重试与管理协议

普通 Runtime 不启动 timer/listener，只有专用监听运行时显式启用。Descriptor 为
`{id,kind,schedule?,payload?,input?}`；`schedule` 是正整数毫秒。条目选择注册 `action`，
派发参数依次选 `input`、事件 payload、descriptor payload、`{}`，不合并。

`listen --token-env <name> [--queue <path>]` 默认监听 loopback 8374，队列默认
`~/.afk/triggers/deliveries.sqlite`。POST `/triggers/<provider>` 接受最多 1 MiB body，
认证支持 bearer、GitLab token、原始 body 的 HMAC-SHA256；Webhook 自身签名不可被
bearer 绕过。payload 校验并持久化后返回 `202` 回执，不证明执行完成。

投递身份使用 Provider 名称及依次优先的 Idempotency-Key、GitHub delivery、GitLab event
UUID，缺失时用 body hash；同 ID 不同内容返回 `409`。单拥有者私有 SQLite 保存
`pending/processing/delivered/failed`，恢复中断投递；默认五次尝试、1000 ms 间隔，
10000 行/64 MiB payload，不自动淘汰，满时 `503`。body 超限 `413`、认证失败 `401`、
无效 payload `400`、未知 Provider/路由 `404`。

| 管理操作 | 认证 HTTP 协议 |
|---|---|
| `deliveries --offset <非负整数> --limit <1-100>` | GET `/deliveries?offset=…&limit=…`，返回回执、容量和 `offset/limit/nextOffset`，可查更早失败，不含正文 |
| `replay <delivery-id>` | POST `/deliveries/<id>/replay`，仅失败投递 |
| `prune-deliveries` | POST `/deliveries/prune`，只删除超过默认七天去重窗口的 delivered 行，绝不删除 pending/failed |

以上为 `plugin` 子命令，均要求 `--token-env`，接受 `--url`；只允许 HTTPS 或 loopback HTTP，
拒绝 URL 凭据/query/fragment 及重定向。SDK 暴露 `TriggerQueueOptions/TriggerDeliveryStatus`
和 `currentTriggerDeliveryId()`。队列配置可限定重试、行数、字节及 delivered 保留期。

至少一次派发时，未显式给 `executionId` 的 `work-item.execute` 使用
`SHA256(deliveryId + '\0' + canonical workItemId)`。仅实现前 journal 的 `requested/failed`
允许重试，不自动重复已启动实现；启动后中断必须走原生所有权及审计对账，不保证任意重试
续跑引擎或外部 action 恰好一次。关闭停止接收、等待在途操作并 dispose；pending 保留，
interval timer 不补跑停机时段。

## 7. Artifact 与审计证据协议

`integrations.evidence` 为 `{provider,timeoutMs?}`，超时须为 1..60000 整数。
根级 `integrations.evidence` 选择已启用、可写的 Artifact Provider 时，默认
Runtime 初始化持久化本地加密证据存储并启用该出口的 `captureEvents: true`；未配置此出口时不自动为它采集。
选择或初始化失败必须通过必需的初始化闸门阻止受管执行。本地 key 以互斥方式
初始化并复用已有 key，不能因重启或并发丢失解密能力。SDK 提供
`createLocalEncryptedEvidenceStore`、`createPluginRunObserver`、`setPluginAuditArtifacts`
和 `PluginRunObserverOptions`，调用方可显式选择可写 Artifact Provider 与本地证据接口。

QA、发布、失败、运行结束事件先生成有界脱敏摘要并存本地；源事件持久化后校验证据摘要，
拒绝 restricted 内容，再向选定 `ArtifactSink.put` 导出。文本内容脱敏，保留真实脱敏状态；
返回 URI 去掉 userinfo/query/fragment，不得把凭据带入事件、日志或错误。
`artifact.upload` 的 `effect.completed` 关联源事件/序号、本地 URI/hash、远端引用及成功/
失败原因；其回执不递归上传。上传异常/超时不替代本地审计，本地追加失败仍阻止操作。
既有 after-agent 报告 hook 与此独立。

SDK EvidenceStore 使用独立根配置，不复用 ArtifactSink 选择：

```json
{"evidenceStore":{"provider":"private","scopes":["github:org/repo"],"timeoutMs":2000,"maxBytes":65536}}
```

- `provider` 指向已启用、同时支持 `put/get` 的 `observe.evidence` 或 `observability.provider`；同名双注册必须是同一对象。
- `scopes` 为 1..32 个互异规范项目，不接受通配符或工作项 ID；`timeoutMs` 为 1..60000，默认 2000；`maxBytes` 为 1..1048576，默认 65536。未知配置字段拒绝。
- 默认关闭。仅为显式项目导出新事件的有界脱敏摘要；已有附件不从此出口导出。默认 Runtime 复用本地加密存储；选择或初始化失败安装 required 初始化闸门。
- 已接受的保存选择在运行期因注销、歧义或能力失效而不可用时，新旧 observer 均停止该出口并继续本地审计；显式提交的非法选择仍拒绝，不自动切换 Provider。
- 本地证据和源事件先持久化，再执行 SDK `put/get`；校验身份、分类、媒体类型、长度和 digest。未选择的 EvidenceStore 不收到此出口的字节。
- `effect.completed/evidence.mirror` 保存安全结果；回读内容不替换本地权威。失败、取消、超时保留本地事件和证据，不继续标记成功。
- 配置按 Runtime 初始化快照生效；不提供热重载、持久重试队列或已发送副本撤回。宿主等待有界，但不能强杀忽略 signal 的进程内可信插件。

Observability 仅镜像已本地持久化的事件，同一对象重复注册去重。每条记录使用独立 span，
运行/工作项身份放 trace 属性；metric 使用低基数属性，持久化延迟为 histogram。
导出受截止时间和取消约束；无外部健康或投递证据时不得宣称真实服务可用。

## 8. 经验交换、验证与采纳

经验按规范项目隔离，记录来源运行/工作项、稳定失败身份、证据、状态、有效期和复发次数。
结构化失败形成候选；建议文本修正不改变失败身份。`verify` 必须核对同项目完整本地审计、
独立 QA 启动和通过、新证据，以及成功结束或确认发布并抵达对应人工合并闸门。
后续失败取消资格；复发、撤销或过期退出召回，旧证明不能在复发后重放。
成功经验同样来自独立 QA/完成审计，只有实现成功不构成经验验证。

`export/import` 使用 version-1 JSON，上限 100 条/1 MiB，保留 origin、失败身份与有界
来源收据，不携带验证权威或采纳计数。显式指定目标项目，导入及跨项目 `copy` 均为候选；
重复导入保留身份，拒绝冲突或覆盖本地已验证/撤销历史。再次进入上下文前须目标项目独立
QA 和新证据。HTTP 知识库检索不隐含远程写回。

`metrics` 区分检索、显式采纳、去重复发；`adopt` 核对精确目标 run/work item 完整审计，
且要求同项目有效已验证经验，按运行/工作项去重，每条最多 64 个采纳收据。召回不等于
采纳，声明采纳不证明模型实际使用。Desktop 提供项目内列表/召回、验证和确认撤销；
交换及采纳由 CLI 提供。共享账本限 1000 条、逻辑数据/收据 8 MiB、单条 32 KiB、每条
256 来源，默认有效期 90 天；来源饱和仍撤回复发建议并禁止继续提升。

### 8.1 候选独立验证协议

- `learning.validate` 输入严格为 `{ scope, candidateId, expectedVersion, checkerId }`；不接受 `passed/report/command/target`。验证配置、授权和目标由宿主读取。
- `doctor()` 必须且只能包含一项 `{ check: "learning-validation-v1", ok: true, detail }`；`detail` 为 `{ scope, checkerId, providerId, version }` 的 JSON，身份必须与可信配置一致。
- `verify` 接收 `target` 内的 JSON envelope：`{ protocol: "learning-validation-v1", binding, candidate, evidence, assertions }`。这是专属协议；不能交给把 target 当目录的普通执行器。
- `binding` 绑定项目、候选及版本/摘要、证据摘要、真实目标及快照摘要、checker/配置/授权摘要和唯一 execution ID；报告必须原样返回该 binding。
- 每条 assertion 返回 `{ node, expected, actual, status, evidence }`；`actual` 必须独立观察，不能复制 expected；`status` 为 `observed/unknown/inferred`。缺失、未知、推断、断言失败或无匹配证据均不能晋级。
- fact 验证 subject/rule/authority；process 验证 entry/systems/preconditions、每步 action/stateChange、exceptions/completion。lesson 另遵守以下 QA 及领域检查；skill/tool 未有对应实现时明确 blocked。
- lesson 的可信 checker 配置必须显式设置 `allowLessonValidation: true`，并提供 `qa: { scope, workItemId, runId, targetRevision, root, auditDigest }`。`targetRevision` 为完整 Git revision，`auditDigest` 为受信审计原始字节摘要；客户端不可提供或覆盖这些字段。此许可仅允许验证，不能发布 lesson。
- lesson 先验证同项目、同工作项的独立 QA：原始证据身份、hash chain、系统权威事件、修复版本及完整成功周期必须匹配。状态顺序采用审计 sequence；不保证事件发生时间单调。
- lesson 的 `binding` 额外包含 `qa` 与 `qaEvidence`；逐项独立观察 trigger/rootCause/rootCauseStatus/attempts/fix/prevention、适用范围及 fixTargetRevision。QA 成功和 `passed: true` 均不能代替这些断言。oracle 快照 revision 与 QA Git revision 分别绑定。
- 截止时间覆盖开库、解析、执行和提交；最终获写锁后复核身份、授权、来源、目标和 deadline。取消、漂移和超时不得留下 validated 状态或验证收据。
- lesson 最终获写锁后同步重读 QA 审计摘要；追加、删除、替换或配置变化阻断提交。错误码增加 `qa_unconfigured/qa_not_independent/audit_unavailable/audit_changed/qa_unverified`；错误结果仅含安全分类，不携带审计正文或路径。

### 8.2 Lesson 发布、读取与撤回协议

- 验证许可与发布许可分别检查；目标授权必须显式包含 `lesson`，不能从 `fact/process` 推导。
- 沿用 `learning.knowledge.prepare/publish/reconcile`；调用方不提供验证收据、授权文件或 Wiki 执行参数。
- 发布核对当前候选、原始来源、独立 QA、语义断言收据、保存配置、目标授权及规则；读取已发布资产时执行相同资格检查。
- 发布准备、导航替换及 `applied/committed` 晋级在取得数据库写锁后同步复核依赖；守卫抛错或返回异步结果必须回滚，不得成功返回陈旧计划。
- 正文包含候选版本、验证执行及 QA 修复版本的引用；只向权限、项目、版本与适用条件匹配的任务提供。
- QA、来源、规则或授权失效立即禁止新消费；补查只将对应 lesson 置为冲突并安排撤回，同请求其他候选不因 QA 单独变化而失效。未配置知识发布时仍执行候选资格补查。
- 撤回复用持久恢复日志并保持幂等；权限不足或人工编辑返回阻断，保留现场，不能覆盖人工正文。

## 9. 生命周期闸门与最小验收

required init、before-agent、after-agent、before-publish 及逆序 cleanup 保留执行顺序和
失败策略。插件模板需通过宿主验证；专用 QA/冲突模板只接受一个 inline Agent 步骤。
不提供通用逐工具拦截 API；插件不能修改 Core 状态、放宽预算或关闭人工合并闸门。

- Manifest、配置、依赖/冲突、唯一注册名及可选操作声明正确；激活失败回滚，dispose 幂等。
- 信任边界校验输入/结果；取消、超时、资源及输出有界；缺失凭据/工具/协议有安全诊断。
- 原始认证响应、秘密及未授权内容不进入 Renderer、上下文、事件、Artifact 或普通结果。
- 错误区分输入、配置、认证、权限、缺失、不可用、超时、取消、远程失败及协议失败；保留可诊断分类，不伪造成功。
- 验证安装、配置、激活、操作、禁用/启用、卸载及失败路径；至少有实际本地 transport/进程集成检查。
- 租约/所有权、幂等/重放、清理拒绝、审计关联和经验验证边界具有可运行检查；真实服务验证单独记录，不用模拟 transport 代替。
