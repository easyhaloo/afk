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

### 2.1 外部工具声明与诊断

Manifest 可选 `externalTools`，最多64项，`id` 唯一。每项定义：

```json
{
  "id": "node",
  "command": "node",
  "location": "host",
  "version": {"args": ["--version"], "minimum": "22.16.0"},
  "source": {"url": "https://nodejs.org/"},
  "optional": false
}
```

- `command` 是单个程序名，只接受字母、数字、点、下划线和连字符；不接受路径、参数或shell片段。
- `location` 为 `host/backend`；可选 `platforms/architectures` 限制目标位置的平台与架构。
- `version` 可省略；提供时 `args` 为1–16个无控制字符的参数，`minimum` 为稳定三段数字版本。
- `source.url` 必须为无凭据、query和fragment的HTTPS URL；它是获取说明，不证明发布者、内容完整性或安装权限。
- 桌面依赖按实际或显式配置的平台选择，探测不得向通知程序发送测试消息。`sendmail`不执行版本或投递探测；绝对路径绑定不得继承PATH程序的诊断资格。
- `listExternalTools(manifest)` 只校验并返回声明。`diagnoseExternalTools(manifest, options?)` 默认返回 `unknown/not-requested`。
- 版本探测要求 `probe: true` 及可信调用方提供的精确 `command/args/location` 白名单。自定义宿主执行器声明 `executorLifecycle: trusted-cooperative`；backend执行器声明 `lifecycle: trusted-cooperative`，缺失backend不回退宿主。
- 结果状态为 `available/missing/unsupported/outdated/unknown`；返回受限版本与固定原因，不返回原始输出或异常。
- 整个清单共享默认3秒、最大5秒执行期限；另有固定1秒清理收口预算。默认宿主执行器等待原生close及临时目录清理；未确认时返回 `unknown` 并保留 `cleanup: unconfirmed`。协作Promise结束不等于真实backend物理关闭。

CLI/manager默认静态接线不导入入口或解析secret；`list --loaded`与`doctor --loaded`显式激活插件，`doctor --probe`仅执行内置白名单探测且不能与`--loaded`合用。自定义程序绑定只作静态投影；backend探测执行器尚未接线，不回退宿主。按需安装另行验收，来源URL不授予安装权限。

## 3. 能力接口与调用协议

| 能力 / 接口 | 操作和结果契约 |
|---|---|
| `agent.provider` / `AgentProvider` | `createExecution`；声明会话、streaming、usage、resume 等能力及提示词上限，运行器拥有进程/会话生命周期。 |
| `sandbox.provider` / `SandboxProvider` | `createWorktree`、`create`；返回的 Sandbox 管理 Agent 启动、命令执行与销毁，明确工作区和隔离边界。 |
| `host.connection` / `HostConnectionPort` | `listHosts/resolve/exec`，可选 `upload`；命令使用 argv，远程非零退出仍返回原 `code/stdout/stderr`，连接/认证/超时单独分类。 |
| `tracker.issue` / `IssueTrackerPort` | 字符串 issue ID 的 CRUD、评论、关系、`health/doctor`；保留真实项目、ID、key 和 URL。 |
| `tracker.provider`、`backlog.provider` | 源码托管 issue/change request 与规范 backlog 身份；不把外部 issue key 当源码托管数字 ID。 |
| `verification.provider` / `VerificationProvider` | `verify` 返回 `passed`、时长、可选输出及执行观察；普通命令的 `target` 为工作目录，可选 `input` 经 stdin 传入。 |
| `notification.provider` / `NotificationProvider` | `notify` 返回 `delivered/channel/error?`；失败不得伪装为送达。 |
| `trigger.provider` / `TriggerProvider` | `register/unregister`；宿主管理 listener、timer 和 action 派发，见第 6 节。 |
| `context.provider` / `ContextSource` | `gather({scope,prompt,limit?})` 返回带 `origin` 的有界 fragment；只读取授权内容。 |
| `credential.provider` / `CredentialProvider` | `resolve({name,scope?}, {signal?,deadlineAt?}?)` 返回私有 `secret/expiresAt?/revoked?`；不开放通用 CLI 输出。 |
| `artifact.provider` / `ArtifactSink` | `put({name,mediaType,bytes})` 返回 `{uri,name}`；写入前校验大小/路径，审计导出见第 7 节。 |
| `repository.provider` / `RepositoryProvider` | 必需 `snapshot`；可选 `prepare/checkout/publish/cleanup/withLifecycleLease`，见第 5 节。 |
| `policy.provider` / `PolicyCheckProvider` | `evaluate({action,context?})` 返回 `allowed/rule?/reason?`；required 闸门拒绝或异常阻止继续。 |
| Observability | EventStore `append/read`，EvidenceStore `put/get`，Tracer `startSpan/addEvent/endSpan?`，Metrics `record`。本地审计始终为权威。 |

通用能力 Provider 声明 `id` 与操作能力布尔表；Agent/Sandbox 使用各自的名称和能力集合。

命令验证可选请求 `executionId`；`input` 上限为 UTF-8 256 KiB。
默认原生 runner 在直属子进程 close 后返回可选 `execution`：
`{ protocol: "verification-execution-v1", executionId, command, cwd, inputDigest, exitCode, stdout, stderr, closed: true }`。
`inputDigest` 是 stdin 原始 UTF-8 字节的 SHA256；argv、规范 cwd、退出码及流由宿主记录。
注入 runner 不授予原生观察；取消、信号终止、超时或绝对期限后的成功不授予成功观察。
公共调用保留结构化收据，普通调用结果保持兼容。此收据不代替领域检查、执行授权、目标版本或工作区归属证明。
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

### 3.1 Agent会话与远端执行

- 显式恢复通过`resume: SessionSnapshot`传入，后继`generation`必须恰好等于快照加一且为安全整数；继续提示通过`ResumeOptions.prompt?`传递。
- 原生checkpoint绑定provider、native session和worktree。快照必须来自该执行并通过完整性校验；逻辑session名不代替厂商原生session身份。
- 支持远端Provider启动的宿主可实现`startProviderExecution(provider, options)`。宿主选择已注册且被允许的Provider；客户端argv不授予远端任意执行权限。缺省继续使用`startAgent`。
- 远端启动接受缺省runtime或严格的Codex exec配置，并保留provider/profile/auth/startupTimeoutMs；analysis、app-server、endpoint、authTokenEnv及跨Provider配置明确拒绝。所选远端能力不得转为本机app-server执行。
- `agent.wait`可返回服务端执行的metadata；客户端校验Provider后消费。逻辑`result.sessionId`不生成原生`threadId`，旧响应缺少metadata时保留未知；远端执行的遥测不回读客户端本机转录。
- 服务端权威失败结果已撤销原生身份时，同时撤销保存的快照；客户端丢弃晚到的旧快照响应，阻止其回填身份或恢复。新执行建立独立的会话状态。
- `agent.wait.sessionInvalidated?`明确传递撤销事实，与`failed/aborted/timed_out`状态分开；取消或deadline归一化不丢失该事实。声明撤销却同时返回completed的响应无效。
- checkpoint的`worktreePath`绑定宿主来源；跨命名空间时另用`workspacePath?`绑定唯一实际cwd。容器含子仓或custom工作目录时必须返回实际cwd，启动、命令构造及恢复保持两种路径的绑定。
- `sandbox.create`返回`{id,worktreePath?,workspacePath?}`；宿主路径取服务端canonical host，native cwd优先取`workspacePath`，再取返回的`worktreePath`，最后兼容请求host。Provider启动仍绑定host，命令使用native cwd。
- capture保持host严格匹配；native cwd只接受所绑定原值或去掉尾斜杠后的值，根目录保持`/`，不改写checkpoint。相对路径、dot段、外来目录或反斜杠不能通过此兼容规则。
- 客户端`parseLine`不证明远端原生身份。远端恢复只接受同Sandbox捕获的原样快照；服务器再次校验绑定，停止旧执行成功后才创建后继。
- `interrupt`、完成事件和`context_high`不等于实际停止；清理失败保留占用并允许显式重试。`kill`确认后才释放占用，旧deadline失败不能污染已停止、terminal或superseded状态。
- 运行器管理的普通本地后代与不可信代码隔离分别声明。当前进程族停止实测范围为macOS默认继承环境的普通后代，不扩大为跨平台或恶意逃逸隔离保证。

受限分析的启动管道出错时，沿既有进程身份核验和停止路径处理；失败状态不能由后续零退出改写，原生非零退出码保留。启动诊断、实际guard执行和真实模型结果分别验收。

## 4. 激活、凭据和配置生命周期

`发现 → Manifest/配置校验 → 依赖排序 → 激活及注册 → 操作 → 逆序 dispose`。
激活失败回滚当前批次注册；外部资源、子进程和 timer 通过 `onDispose` 清理。
清理应幂等，一项失败不阻止其余清理；缺少健康检查时不得伪造健康。

`registerLifecycle` 的 optional 模块与扩展在 `before-agent/after-agent/before-publish`
失败时，经现有 observation recorder 写入 `effect.completed`：
`effectKind=workflow.lifecycle.<phase>`、`outcome=failed`、
`summary=optional_lifecycle_hook_failed`；`idempotencyKey` 为
`JSON.stringify([runId,"lifecycle",phase,"module",name])` 或
`JSON.stringify([runId,"lifecycle",phase,"extension",registrationIndex])`。
不记录原始异常或堆栈；写入成功才继续，审计失败上抛。取消在失败审计前检查；
init、required、fatal 仍阻断，cleanup 保留逆序及严格聚合合同。
无 recorder 的直接调用保持兼容；learning 用途须显式声明，Hook 覆盖计划而非逐工具。

升级须确认新版本激活；失败先完成该实例的资源清理，再恢复上一可用版本及配置。
清理未确认时保留占用和待恢复状态。同一插件 ID 的不同激活实例分别持有清理责任，
旧实例完成清理不得改变新实例状态。取消后的迟到成功不得变成有效操作结果。

内置 secret 字段接受 `{"env":"TOKEN"}` 或
`{"provider":"credential.enterprise","name":"deployment","scope":"read"}`，
`scope` 可省略，`provider` 为精确注册名。保存配置只校验引用形状，不认证、不访问网络。
构造时读取环境引用。OTLP headers、ReportPlatform token、飞书/Slack webhook、OAuth clientSecret、OIDC assertion/exchange subjectToken、企业凭据 values 的具名引用按操作解析，接受带时区 ISO `expiresAt`；激活及静态检查不解析。
OTLP 仅在实际结束 span 或导出 metric 时解析 header，span/event 捕获保持被动；解析和传输共用调用方与配置超时中较早的绝对期限。
HTTP `sandbox.remote-container.token`、`repository.remote-workspace.token` 和 `context.knowledge-base.token` 的具名引用同样按操作解析，接受上述 `expiresAt`；激活时只绑定精确具名 Provider，不读取凭据值。
知识库 Bearer 认证要求 HTTPS，每次 `gather` 重新解析；匿名请求仍可使用 HTTP(S)。操作 `deadlineAt` 覆盖凭据解析和 HTTP，配置 `timeoutMs` 仅限制 HTTP，包含响应体读取。
两个远端 bearer 字段在每次实际 HTTP 请求前重新解析，包括容器主动 health、Repository snapshot 和 publish/cleanup 前的生命周期预检 snapshot；容器 health 成功不证明执行已就绪。
容器 CLI 传输没有 bearer token 字段；容器 HTTP 传输接受 HTTP(S)，Repository bearer 认证要求 HTTPS，匿名 Repository 请求可用 HTTP。
这些消费者拒绝过期、撤权及销毁后晚到的凭据，传递 `signal/deadlineAt`，失败不泄露原始错误。企业凭据转发保留引用和上游中较早的有效期；激活时只查找上游以绑定生命周期，不调用其解析器。
同批具体凭据依赖排序，拒绝自环/互引环；缺失具名 Provider 延迟加载并给出诊断。
`notification.gmail` 固定依赖 `credential.google-oauth`；激活时使用该注册实例，缺失、禁用或不兼容时不注册通知能力，不创建私有认证实例。启用 Gmail 时禁止停用其凭据依赖；静态检查和激活不解析账号、不刷新令牌或发信。

通知副作用在发送前持久化`effect.started`；其`idempotencyKey`采用`notification:<编码后的Provider注册名>:<执行UUID>`，完成写入失败时仍可归属。完成摘要采用`capability-notification-v1`，绑定Provider、执行身份、阶段、delivered和channel摘要，不保存正文、原始channel、凭据或底层错误。完成审计期间取消须保留已持久化的发送事实，另记`notification.cancellation`并安全失败；不得重发或继续下游。写入失败同样上抛；这些收据不授予崩溃下副作用恰好一次或最终收件箱送达资格。
其余具名引用按激活取值，重新激活重取；Gmail 保留自身 OAuth 刷新。销毁不撤回已发送请求，不宣称强制终止未配合的解析器。

OIDC 激活绑定 assertion 与可选 subjectToken 的精确上游所属插件。每次 resolve 的发现、
输入准备、交换及响应体读取共用调用方与配置超时中较早的绝对期限（默认 15 秒，最大
300 秒），输入有效期可缩短后续期限。输入过期、撤权或操作取消/销毁时拒绝晚到结果；
签发 token 的有效期仍只按响应计算。直接字符串与原回调兼容，assertion/subject 回调可
分别增加第三/第二个可选操作参数，并返回 `CredentialValue`。OIDC 环境输入遵循现有
`defineOperation`：纯环境配置在构造时捕获；混合具名引用时，每次激活的依赖准备重新
解析整份配置并再次捕获环境值；每次 resolve 不重读环境。重激活创建新 Provider，
不会复活旧引用或旧操作。HTTPS、精确 issuer、endpoint pin、RFC 7523/8693 约束保留。

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
| `checkout` | `{workspaceId,branch?,ref?}` → 同身份工作区；`branch` 为目标分支，缺省 `afk/<runId>`；`ref` 为来源分支，缺省使用 prepare revision |
| `publish` | `{workspaceId}` → `{commit,branch,url?}`，必须匹配检查后的快照，不合并 |
| `cleanup` | `{workspaceId}` → `{removed}` |
| `listRecoveryAllocations` | `{}` → `[{allocation:{id,repository,runId},phase}]`；须声明 `recovery` |
| `recoverAllocation` | `{allocationId:<uuid>}` → `{removed}`；须声明 `recovery` |
| 组合 `run` | `{repository,runId,checkout?:{branch?,ref?},action,input}` → `{value,workspace,publication,cleanup}` |

Repository 回调明确传递的 `authorizedWorkspace: undefined` 表示缺失本地检出授权；公开 Verification dispatcher 必须在调用 Provider 前拒绝，不能回退启动目录。独立直接调用省略此授权字段时保留启动目录语义；不依赖本地路径的其他 Repository action 不受影响。

Git 分支 Provider 可实现 `preparePush(branchName, worktreePath): Promise<string>`，返回准备后的 HEAD。宿主在实现/QA Agent 启动前调用；允许此时同步远端。`push(branchName, worktreePath)` 只推送，不再 fetch、快进或合并。审查后远端前进或分叉而被拒绝时，必须保留已审查的本地 HEAD，不创建发布请求，重新准备并验证。自定义 Provider 未实现 `preparePush` 时仍须保证自身发布不引入未经验证的 revision。

`RepositoryLifecycleService.run` 要求四个 lifecycle 操作，按
`prepare → checkout → callback(workspace) → publish → cleanup` 执行，可由
`withLifecycleLease` 覆盖全过程。公开 `run` 仅派发已注册 action，传入
`{input,repositoryWorkspace,worktreePath}`；不自动替换工作项执行器。
本地 managed 仓库要求规范租约键和 checkout 所有权；远程/特殊 backend 显式声明
仓库/ref 白名单和支持的操作，默认仍仅 snapshot。

prepare 绑定配置基线；checkout 单独校验目标与来源分支，拒绝将配置基线作为目标。受管实现使用工作分支及可选 sourceBranch；QA 从实现分支建立独立 QA 分支。本地来源仅从配置 remote 获取，解析为固定 commit 后切换；无显式来源时不得改变 prepare revision。已有目标分支仅在 revision 相同时复用，否则拒绝，不重置或覆盖。publish 绑定本次实际检出分支；成功 checkout 后更新未修改工作区的安全清理基线。公开 publish/cleanup 不接受 checkout 字段。

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

恢复操作使用已保存的分配身份，禁止客户端提供 path、force 或新所有权。查询输出不包含
私有路径、Git marker、PID 或配置摘要；Provider 错误使用安全公开分类。仅声明能力并提供
对应方法的 Provider 可调用；底层仍须验证原配置、所有权、活动进程/租约、修改和发布状态。

受管分配在创建工作区前持久登记意图；正常 snapshot、checkout、publish、cleanup、分配失败
补偿及恢复操作均在已有租约内绑定当前所有者和租约代次，再执行可变操作。活动或未知租约
不允许接管。存储私密检查须处理合法 SQLite 创建与 sidecar 关闭窗口，同时拒绝符号链接、
非所有者、过宽权限及不受支持的硬链接；不得通过修改全局 umask 或吞掉检查失败解决竞态。
带 Git marker 的工作区删除前持久保存已核验的目录与 Git 管理登记身份；空 reservation 使用
独立的删除完成协议。删除后、记录结清前中断，须重新核验原配置、所有权、租约、目录及该
资源类型的完成凭据，Git 工作区另在原 Store 锁内核验实际登记。路径不存在不构成删除成功
证明。移动、替换、外来或身份不明的资源保留记录；失败交接可重试，重复成功恢复保持幂等，
不通过 force 删除或新增租约命名空间绕过保护。

## 6. Trigger 接收、重试与管理协议

普通 Runtime 不启动 timer/listener，只有专用监听运行时显式启用。Descriptor 为
`{id,kind,schedule?,payload?,input?}`；`schedule` 是正整数毫秒。条目选择注册 `action`，
派发参数依次选 `input`、事件 payload、descriptor payload、`{}`，不合并。

定时器激活前必须取得所选队列的唯一所有权。每个已观察到的 tick 具有
`{id,scheduledAt}`，身份由激活 UUID 和递增序号组成；action、input 和 tick 先持久化再派发。
重试或重启沿用保存内容，配置变化不重写旧投递；容量或写入失败显式诊断，不回退直接执行。

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

listener 关闭和 Runtime dispose 各有五秒等待边界。超时不证明 action 已停止；
在途 action 未结算时保留队列所有权，后继消费者不得接管，pending 留待后续恢复。

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
事件、Trace、Metrics 导出继承父运行取消信号；取消阻止排队调用并停止等待在途
调用，计入 `dropped`。在途调用耗尽共享期限计入 `timed_out`；晚到结果不改写结论。
Provider 必须响应 signal；宿主停止等待不表示远端已执行的副作用得到撤销。
Artifact 审计桥逐次合并配置取消与运行取消，作用于采集和上传；已有本地证据及
源事件继续保留，采集失败与实际上传回执分别记账，并发运行不得共享取消控制器。

每条源记录至多追加一条本地 `observability.delivery` 摘要；固定维度计数有界，
摘要不再导出、采集证据或触发学习。capture 的 failed/timed_out/cancelled 与实际 SDK
投递分别记账；未生成 capture 计划不得虚构 SDK 调用或 mirror 回执。终态元数据不重开业务状态。

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
且要求同项目有效已验证经验，按运行/工作项去重，每条最多 64 个采纳收据。JSON 保留
`retrievals`、`adoptions`、`recurrences`，新增
`receipt: { binding: 'verified-version', experienceId, scope, source, version: 2, verificationDigest, contextDigest, contextStatus: 'recorded' | 'unavailable', acknowledgedAt, publication? }`；
新收据持久保存 `source: { runId, workItemId }`。发布 lesson 同时保存
`publication: { key, candidateId, validatedVersion, candidateDigest, evidenceDigest, validatorVersion, targetRef }`，
普通经验省略。重放校验保存的任务及当前发布绑定，缺失、篡改或外来绑定拒绝。
旧 version-1 收据按原格式重放，不补写未保存字段或重复计数。验证摘要绑定规范化的
已验证内容、验证证据与必需适用条件；上下文摘要在 `recorded` 时绑定规范化的实际目标上下文，
缺失时绑定规范化的 `{}` 并标记 `unavailable`，不虚构目标，均为 SHA-256。`contextStatus` 为增量字段。
相同来源、版本与上下文重放返回原收据/时间且只计一次；验证/版本或目标上下文变化报冲突，
绝不重标收据，损坏绑定拒绝。历史 `metric`/`metric` 收据仅返回
`{ binding: 'legacy-unbound', experienceId, scope, source }`，不虚构摘要/时间、不增计数或升级。
可信 QA 目标快照在尚未完成 QA 的进行中运行也可记录实际上下文；新增及重放均绑定实际
上下文，并始终对实际上下文检查兼容性，同一上下文在 QA 前后结果一致；未存储
applicability 的普通经验也不能绕过已知 productVersions 的兼容性检查。仅存储了
applicability 或 publication 绑定的经验额外要求可信成功 QA/完成审计、干净目标及精确 QA revision 的
已验证适用资格，且已验证上下文须匹配实际上下文；同时提供的两者不匹配时拒绝。
未存储 applicability 及 publication 绑定的普通经验仍可针对完整进行中运行确认，包括上下文不可用时，但须通过
实际上下文兼容性检查。采纳运行哈希排除于失败来源之外，
同一目标后续独立失败仍可计复发，采纳本身不使独立 QA 失去资格。采纳仅为显式确认，
不是观测到使用/结果；发布版本绑定遵守以下 Lesson 协议。Desktop 提供项目内列表/
召回、验证和确认撤销；交换及采纳由 CLI 提供。共享账本限 1000 条、逻辑数据/收据
8 MiB（收据按实际存储文本字节数计入）、单条 32 KiB、每条
256 来源，默认有效期 90 天；来源饱和仍撤回复发建议并禁止继续提升。

### 8.1 候选独立验证协议

- 纯学习模板必须声明 `purpose: learning`；步骤必须为 `kind: system`，动作必须为已注册的 `learning.*`，DTO 写入 `input`。禁止 Agent 步骤、分支与 Provider 默认值，以及步骤的 role/prompt/completion/provider/executionMode/branch 字段。
- 公开 Runner 在领取工作项及 Hook 前加载、校验和编译模板，固定本次学习计划；直接传递 DTO 与 `authorizedWorkspace/signal`，步骤 `timeoutMs` 合作取消。学习运行 ID 必须与输入声明的来源运行 ID 不同；学习入口不领取来源任务、不创建实现资源、不提交/推送或排队 QA。
- 学习 Hook 必须显式声明 `purposes: ['learning']`，共享 Hook 可同时声明 `execution`；省略时仅普通执行。沿用 init/before/after，已启动动作结束后逆序 cleanup 一次；清理失败及必要审计失败阻止成功。从首条审计起记录学习 purpose，effect 事件记录步骤，cleanup 后记录终态；禁止递归收集学习事件。
- 学习动作接受严格 DTO，或一层 `{ iid, worktreePath, branch, targetBranch, step, input }` 工作流上下文。`iid` 为正整数，路径及分支字段非空，`step/input` 必须为自有属性，系统步骤的 action 必须匹配调用动作。业务 DTO 放入 `input`，空输入显式为 `{}`；拒绝未知字段及递归解包。上下文不授予验证、执行或发布权限；其他插件动作仍接收完整上下文。
- 预检与动作派发共用一层上下文解包规则和来源身份 schema，包含去除首尾空白；来源运行身份在首条审计前检查。编译拒绝重复步骤 ID。必要审计失败阻止待启动兄弟动作，已启动动作结束后才清理；终态审计失败保留先前 Hook 与清理错误。
- `learning.capture` 返回当前来源快照的 `requestKeys`，无变化重放保留相同 key；普通收集不接纳新的失败来源，历史快照不进入本次结果。
- `learning.request` 严格接收 `{ scope, requestKey }`，返回准确请求、处理收据及其绑定候选；缺失或收据成员不一致必须拒绝。
- `learning.worker.once` 严格接收 `{}` 或 `{ scope, requestKey }`；定向执行不消费其他请求，已处理重放不重复调用模型。
- `learning.retrospective` 严格接收 `{ scope, runId, kind: "process" | "lesson" | "skill" | "tool", checkerId, workItemId?, repair?: true }`。`workItemId` 为规范工作项身份；指定后，首次补查及 Worker 重查都必须核对来源归属，匹配前不得收集请求或处理候选，已保存请求也必须匹配该身份。产品复盘入口始终提供该字段。补查必须得到唯一当前请求并匹配来源运行；仅处理该收据内指定类型候选。process/lesson 使用实际验证后的版本准备知识发布，已验证重放复核当前资格及 checker；来源、处理、验证或准备阻断必须使步骤失败。该动作不自动发布，不开放生产 fact。
- skill/tool 复盘需要保存的 `validation` 配置，不需要 `knowledge`；既有 checker 和授权闸门仍适用。开始验证前须预先检查准确处理收据内所有同 kind 候选：`validated` 明确抛出 `learning_proposal_revalidation_required`，其他非 `candidate` 状态抛出 `learning_candidate_not_preparable`。成功返回 `{ scope, runId, requestKey, processing, validated }`，其中每条精确收据为 `{ status: "validated", candidateId, candidateVersion, validatedVersion, executionId, receiptDigest }`；不返回 `prepared`，不准备知识发布，不证明发布或安装完成。真实生产仍受 skill 解释器及 tool 权限拒绝实验未实现的阻断约束。
- 部分验证失败合同：本次调用已有 skill/tool 验证成功后中断，`LearningReviewIncompleteError` 仅输出严格安全 DTO `{ status: 'incomplete', scope, runId, requestKey, validated, interruptedCandidateId, reason: 'validation_blocked' | 'validation_failed' | 'cancelled' }`；`validated` 仅含本次调用返回的精确成功收据，不合成历史收据。CLI review 须在自身拥有的 Runtime 的 `dispose` 尝试结束后仅打印该安全 JSON，即使 dispose 失败仍保留安全 JSON，最终仍以非零退出；Runner 保持失败/取消，partial incomplete 后不再派发后续 system actions（包括 `when: { step: 'review', equals: 'failed' }` 恢复条件），不执行 after-success Hook。中断候选自身可能已在取消前提交验证，须查询权威状态，不宣称回滚。含先前 `validated` 候选的混合状态重入仍以 `learning_proposal_revalidation_required` 拒绝，不续验，不代表技能安装或发布完成。
- 产品 `experience review` 的 `--kind success|repair|skill|tool` 默认 `success`；success/repair 分别选择 `success-review-preview`（process）或 `repair-review-preview`（lesson），skill/tool 分别选择 `skill-optimization-validation` / `tool-optimization-validation`（对应候选类型）学习工作流。修复动作必须提供 `repair: true`、`kind: "lesson"`、规范 `scope/workItemId`、失败 `runId` 及保存的 `checkerId`；必须匹配 checker 中同项目、同工作项的失败身份后，才从其可信根显式采集失败来源，请求持久保存 `reason: "failed"`。普通收集不因此接纳新的失败来源。
- 复盘及定向 Worker 的来源补查不得执行发布恢复；无来源运行的纠正/导入请求不得回退为全局扫描。调用方取消或插件释放后停止后续阶段，已完成记录可保留，不宣称事务回滚。
- 预览重试的读取或验证失败必须直接返回错误，不因此将已有发布置为冲突或执行撤回；显式发布及核对仍须检查当前来源、授权和验证收据，并负责恢复或撤回。
- 来源允许根仅由宿主可信配置提供，收集、验证、准备、发布、读取和恢复必须一致；请求 DTO、模型输出与 transcript 位置均不能授予或扩大读取根。
- `learning.validate` 输入严格为 `{ scope, candidateId, expectedVersion, checkerId }`；不接受 `passed/report/command/target`。验证配置、授权和目标由宿主读取。
- `doctor()` 必须且只能包含一项 `{ check: "learning-validation-v1", ok: true, detail }`；`detail` 为 `{ scope, checkerId, providerId, version }` 的 JSON，身份必须与可信配置一致。
- `verify` 接收 `target` 内的 JSON envelope：`{ protocol: "learning-validation-v1", binding, candidate, evidence, assertions }`。这是专属协议；不能交给把 target 当目录的普通执行器。
- `binding` 绑定项目、候选及版本/摘要、证据摘要、真实目标及快照摘要、checker/配置/授权摘要和唯一 execution ID；报告必须原样返回该 binding。
- 每条 assertion 返回 `{ node, expected, actual, status, evidence }`；`actual` 必须独立观察，不能复制 expected；`status` 为 `observed/unknown/inferred`。缺失、未知、推断、断言失败或无匹配证据均不能晋级。
- fact 验证 subject/rule/authority。process 验证 entry/systems/preconditions、完整步骤数、每步 action/stateChange 和 exceptions/completion。检查器从独立流程来源读取总步数，以十进制字符串返回 `process.stepCount`。缺少该观察的旧回执需重新验证后才能用于发布或召回。lesson 另遵守以下 QA 及领域检查。skill/tool 未有对应实现时明确 blocked。
- 流程检查器还要从独立业务规则读取三个字符串数组 `process.applicability.preconditions`、`process.applicability.exclusions`、`process.applicability.invalidationConditions`。空集合返回 `[]`。缺失或不匹配会阻断验证。旧流程回执须补齐观测并重新验证后才能发布或召回。
- lesson 的可信 checker 配置必须显式设置 `allowLessonValidation: true`，并提供 `qa: { scope, workItemId, runId, targetRevision, root, auditDigest }`。`targetRevision` 为完整 Git revision，`auditDigest` 为受信审计原始字节摘要；客户端不可提供或覆盖这些字段。此许可仅允许验证，不能发布 lesson。
- 修复复盘还必须保存 `qa.repair: { failure, fix }`，每项为 `{ runId, root, auditDigest }`；QA 保留独立的 `runId/root/auditDigest/targetRevision`。失败、实现修复及 QA 的运行 ID 必须两两不同，所选来源必须等于保存的 failure。验证核对三份审计的身份、摘要和完整链，确认失败终态、实现修复在 QA 目标版本成功完成，以及同版本独立 QA；收据的 `repair/repairEvidence` 绑定失败与修复事件，重放与发布继续复核。复盘仅准备预览，正式发布仍须既有 checker 闸门及显式 lesson 目标授权。
- lesson 先验证同项目、同工作项的独立 QA：原始证据身份、hash chain、系统权威事件、修复版本及完整成功周期必须匹配。状态顺序采用审计 sequence；不保证事件发生时间单调。
- lesson 的 `binding` 额外包含 `qa` 与 `qaEvidence`；逐项独立观察 trigger/rootCause/rootCauseStatus/attempts/fix/prevention、适用范围及 fixTargetRevision。QA 成功和 `passed: true` 均不能代替这些断言。oracle 快照 revision 与 QA Git revision 分别绑定。
- 截止时间覆盖开库、解析、执行和提交；最终获写锁后复核身份、授权、来源、目标和 deadline。取消、漂移和超时不得留下 validated 状态或验证收据。
- lesson 最终获写锁后同步重读 QA 审计摘要；追加、删除、替换或配置变化阻断提交。错误码增加 `qa_unconfigured/qa_not_independent/audit_unavailable/audit_changed/qa_unverified`；错误结果仅含安全分类，不携带审计正文或路径。

当前修复复盘的模型输出与语义检查仍使用合成数据；不构成真实模型/服务或完整产品 E2E 验收。

### 8.2 知识与经验发布、读取及撤回协议

- 完整 `fact/process` 的准备、发布、已提交重放及读取共用当前资格检查：严格验证收据与候选/证据绑定、保存配置与checker版本、独立验证授权、目标快照、完整原始来源及受管审计链。来源字节、oracle、配置或授权漂移即拒绝；普通命令执行成功不能替代领域断言。
- 完整 `fact/process` 即使发布到 `inbox` 也必须通过上述检查。经授权的 `proposal/partial` 草稿可进入收件箱，不授验证资格，不进入Context。
- 当前资格失效停止新消费，仍允许按持久日志撤回；已撤回资产不能因配置或来源恢复而复活。以下 `lesson` 的独立QA与经验投影要求另外适用。

- 验证许可与发布许可分别检查；目标授权必须显式包含 `lesson`，不能从 `fact/process` 推导。
- 沿用 `learning.knowledge.prepare/publish/reconcile`；调用方不提供验证收据、授权文件或 Wiki 执行参数。
- 发布核对当前候选、原始来源、独立 QA、语义断言收据、保存配置、目标授权及规则；读取已发布资产时执行相同资格检查。
- 发布准备、导航替换及 `applied/committed` 晋级在取得数据库写锁后同步复核依赖；守卫抛错或返回异步结果必须回滚，不得成功返回陈旧计划。
- 正文包含候选版本、验证执行及 QA 修复版本的引用；只向权限、项目、版本与适用条件匹配的任务提供。
- QA、来源、规则或授权失效立即禁止新消费；补查只将对应 lesson 置为冲突并安排撤回，同请求其他候选不因 QA 单独变化而失效。未配置知识发布时仍执行候选资格补查。
- 撤回复用持久恢复日志并保持幂等；权限不足或人工编辑返回阻断，保留现场，不能覆盖人工正文。
- 已提交 lesson 幂等投影至经验库，绑定实际提交发布 key（含 successor）、候选 ID/摘要、验证版本、证据摘要、验证器版本及目标引用；重试保留经验 ID、有效期、计数、采纳收据及撤销状态。
- 召回、上下文注入及采纳（含旧收据重放）先核对当前来源、QA、保存配置、授权、内容及适用条件。消费者 revision 不必等于来源 QA revision；命名 productVersions/runtimeVersions 尚无兼容证明时拒绝。
- 消费使用可信 home 下唯一且启用的内置 learning.distiller 配置；外层停用阻断消费，内层 config.enabled:false 仅关闭自动学习。自定义经验文件未提供可信 home/knowledge 时不得回退用户默认配置。
- 投影失败保留 committed 发布收据，返回 experienceProjection.blocked；reconcile 返回 experience_projection_blocked 并可修复投影。提交后取消保留原取消原因，后续核对恢复投影。
- Desktop 在发布或核对后的候选读取异常时保留已校验收据，返回 `candidateRefresh: "unavailable"`；界面清除旧候选和发布预览，提示显式核对。畸形响应、候选身份/版本错误及最终项目撤权仍拒绝，读取失败不表示当前状态已核对。
- publication 绑定不随 version-1 export 输出；copy 及普通 verify 不转移或授予发布资格。

### 8.3 技能 / 工具提案实验基础

`learning.validate` 已识别 skill/tool 的保存配置并执行生产预检；完整行为语义尚未支持，
缺少必要实验时返回 `insufficient_coverage`，不能授予验证或发布资格。旧 callback
collector 不具备完整语义资格。保存配置及新增实验遵守以下合同：

- 配置 `version: 2`，checker 的 `mode: repository-asset`；包含 scope、checkerId、version、
  kind、repository、asset、inventory、sandbox、semantic、executionAuthorizationFile 及可选 evidence。
  仅选择匹配 scope/checkerId/kind 的条目；v1 知识配置保留原行为，不执行未选中的资产 checker。
- 执行许可为独立私密文件，`version: 1`、`purpose: proposal-validation-execution`。
  绑定 checker 摘要和版本、项目、资产、精确仓库 commit、catalog 摘要、固定镜像、adapter 及宿主 revision；
  还须绑定候选的 `candidateId`、`candidateVersion`、`candidateDigest` 和 `evidenceDigest`。
  `candidateDigest` 是已保存候选 proposal 的规范 JSON SHA-256。即使检查项和目标相同，
  许可也不能转借给其他候选、修订或证据；不匹配在证据重建和 Repository 选择前拒绝。
  配置及独立执行授权摘要须包含 `callInput`，变更实际调用输入即改变绑定。
  撤销或任何绑定变化均阻断。Wiki 发布许可不能替代执行许可。当前许可仅接受空 dependencies、
  空 permissions、`sideEffects: none`，并限制 timeoutMs/maxOutputBytes，不隐式授权安装或外部副作用。
  当前宿主 revision 为 `proposal-validation-runtime-v5`。旧宿主执行许可须独立重新授权，
  不自动改写或沿用。adapter 与语义协议仍为 v1，不能用协议版本相同推导宿主兼容。
- 超时与取消实验从宿主独立观察到容器运行时开始计时。`afterMs` 可等于实际执行上限。
  触发后用独立的 5 秒窗口核验终止，整个验证仍受总预算和外部取消约束。
- catalog 的 skills/cli/script/plugin 四类搜索须来自授权根下的真实有界扫描与已登记来源，
  不接受自报搜索结果。首次读源文件前核对已打开 FD 的预期 inode/设备、归属、权限和链接数；
  读取后及使用前复核目录、文件、内容和 manifest 绑定。
- 原/新版本每次执行先持久登记 operation、候选版本、证据、check、配置、workspace/run、
  镜像和冻结输入身份；登记失败不得继续执行。登记不代表已清理，也不能替代完整行为资格。
- 配置、许可、来源和候选在异步等待后及写锁内重验；预检也受取消和总预算约束，
  晚到结果不得继续分配资源或晋级。提交守卫必须同步返回 void，非 void 或抛错均回滚。

实验使用 `proposal-semantic-v1`：

- 工具保存配置提供 `{ protocol, adapter, kind, input, assertions, control?, callInput?, recovery?, permissionDenial? }`，拒绝未知字段。
  当前 adapter 为 `node-json-argv-v1`；kind/input 必须与候选对应 `ProposalCheck` 完全一致，
  `input` 继续精确绑定场景身份。输入绑定已通过本地定向验证，不授原生场景资格。
  宿主固定调用本次冻结资产，不使用 shell 展开。
- cancellation/timeout/permission-denied 使用 `callInput: string`，最长2048字符且不允许 NUL。它是实际 argv
  第三项（`argv[2]`），必须为受限 JSON、通过候选 `tool.inputSchema`，并拒绝绝对路径参数。
  缺失时保持 unsupported，不回退为场景 `input`。normal/refusal 禁止使用 `callInput`
  替换既有输入，继续投递原始 `input` 字节；refusal 的畸形 JSON 输入合同保留。
- assertion 为 `{ id, source, path?, expected }`；id 唯一。source 为
  `stdout-json/stderr-json/stdout/stderr/exit-code/control`。宿主从实际结果计算
  `actual/status/passed`；JSON 数组 path 仅允许规范且在范围内的整数索引。
- normal 必须包含 exit0 和输出断言；refusal 必须包含指定非零退出和拒绝输出断言。
  malformed JSON 可作为拒绝实验输入。候选声明的 expected 不充当独立 oracle。
- cancellation/timeout 的 control 为 `{ kind, afterMs }`，afterMs 为正整数且短于
  硬执行期限。宿主必须观察 running，触发真实控制，确认同 operation/container 的
  SIGKILL、attach/inspect 均为137及成功清理；外部取消和硬预算耗尽仍为失败。
  此证据仅证明强制终止，不证明优雅取消或业务恢复。
- 宿主 control 结果显式区分 `outcome: triggered / not-triggered`。控制前已确认的自然退出
  使用 `not-triggered / reason: early-exit`，trigger、signal、triggeredMs 为 null；仅实际
  观察到 running 才保存 runningObservedMs，否则为 null。最终 inspect 的身份、退出状态和
  退出码须与 attach 一致，成功清理后才能交付。early-exit 的语义结果始终失败，即使退出码
  是137或输出自称取消；它允许 baseline 比较继续，不能授予 proposed 控制资格。
- 收据绑定 experimentDigest、输入摘要、实际 argv、类型化断言和宿主控制事实；
  `inputDigest` 仍绑定场景 `input`，`deliveredInputDigest` 按实际投递字节计算，
  cancellation/timeout/permission-denied 使用原始 `callInput` 字节，不重新序列化 JSON。
  生产执行与二次验证均从相同绑定重建一致 argv，并重新计算、比较摘要，
  不仅核对收据 hash、passed 或 assertions 数量。
- `permission-denied` 仅适用于 `node-json-argv-v1` 工具实验。配置
  `permissionDenial: { contractRevision: "readonly-workspace-openat-v1", operation: "openat-write", target, errno: "EROFS" }`。
  `target` 必须精确指向冻结清单中的 `/workspace` 下的文件。保存配置和独立执行许可须绑定同一个
  `sandbox.permissionObserverImageId`，格式为 `sha256:` 加 64 位小写十六进制。
  缺少受支持的实验配置时，生产预检在选择仓库和分配执行资源前阻断。
- 验收重验观察器镜像、冻结输入、精确目标、operation/container 与 cgroup 观察收据。
  缺失或不匹配的收据拒绝验收。匹配收据须至少观察到一次被内核以 `EROFS` 拒绝的目标写入，
  且保存的退出及输出断言均通过。观察计数为零时实验失败。该资格限于此写入操作和目标。
- skill 解释器仅支持明确登记的有限合同。合同外的实验保持 unsupported。
  recovery 仅接受下述显式有界合同；旧 recovery 配置及要求完整副作用历史的实验仍不支持。
  baseline 的认证提前退出不阻止继续 proposed 比较；未知控制结果、
  kill 已开始后的失败、基础设施错误和清理失败仍然阻断。
  混用旧 callback 的基础测试通过，不代表全部语义合格或允许生产发布。
- 有界恢复观察器已接入上述保存配置、执行和最终验收；保存配置及独立执行许可的
  sandbox 均须绑定 `scratchHelper: { path, digest }`，path 为规范绝对路径，digest 为 SHA-256。
  宿主通过既有 capture API 获取并持有 helper，重验文件内容、设备/inode、大小、模式、
  归属、链接数及修改时间；JSON 副本或仅有摘要不继承 helper 身份。未配置可选字段时不补默认值，
  保持旧配置摘要。
- `recovery` 为 `{ contractRevision, resources, callInput, requireEffectHistory, assertions, returnAssertions }`；
  contractRevision 固定为 `bounded-recovery-return-state-v1`，resources 为1至4个 `{ id, path }`，
  path 为受限相对路径。assertions 为 `{ fault, recovered, replayed }`，各为同序的
  `{ id, path, bytes }` 数组；bytes 为规范 base64 或 null，单资源最多16 KiB。
  fault 必须有非空资源且与 recovered 不同，recovered 与 replayed 必须相同。
  根 callInput 与 recovery.callInput 分别绑定故障/恢复实际输入，须不同、通过工具输入 schema
  和参数路径检查；根退出断言为0，表示观察器完成，不是业务 fault 成功。保存的
  `returnAssertions` 按 `fault/recovery/replay` 指定 `{ exitCode, signal: null, stdoutHex, stderrHex }`；
  fault 退出码为1..255，另两阶段为0。hex 必须为小写偶数字节，三阶段合计受输出预算约束。
  断言在异步执行前固定；恢复和重放允许返回不同输出，但最终资源必须相同。
- 恢复候选以 `node <相对资产路径> <callInput>` 交给固定观察器 wrapper。每次调用保存
  实际生效的 timeoutMs/maxOutputBytes；期限取候选、授权及剩余总预算的最小值并向下取整，
  不得在保存合同后再次隐式收紧。operation 身份及策略检查后的 container 身份分别登记；
  缺失、重复或不一致均拒绝。最终验收重算 wrapper argv、helper-aware context、输入/资产摘要、
  三阶段字节及外层输出；各阶段独立解码 UTF-8 后连接，不跨阶段拼接原始字节。
  可信执行 context 仅在进程内保留，不写入持久报告；报告只保存显式收据。
  最终语义证据重验异常返回 invalid_receipt，不得归类为存储失败；取消或超时已发生时保留对应分类。
- helper wire 保留 `linux-native-scratch-recovery-v1`，宿主片段使用
  `linux-native-scratch-recovery-v2`、`bounded-recovery-return-state-v1` 和配置合同摘要；
  每阶段保留原始 stdout/stderr hex。重验须使用独立保存的配置、可信 captured helper
  及 operation/container 身份，重算阶段、边界、原始字节、摘要与资格；不得从收据反推可信配置。
- 片段最多授予 `qualified-bounded-returns-and-state`，不证明完整副作用历史、业务正确性、
  exactly-once 或恢复内部路径。`historyCoverage` 始终为 `not-observed`；要求 effect history
  仍为 `unsupported-effect-history`，无返回断言仍为 `unsupported-replay-behavior`，旧收据不自动升级。
  片段重验不代替外围隔离、清理及观察来源证明，也不授予工具候选生产发布资格。
- 受管 prepare 无法安全回收分配时保留自有资源，并抛出携带不可变 allocation 身份、
  原始失败及清理失败的专用错误。调用者不得以同时取消覆盖该错误；公开结果使用
  安全分类，不输出私有恢复路径。全局取消后的持久恢复仍须单独实现及验收。

## 9. 生命周期闸门与最小验收

required init、before-agent、after-agent、before-publish 及逆序 cleanup 保留执行顺序和
失败策略。插件模板需通过宿主验证；专用 QA/冲突模板只接受一个 inline Agent 步骤。
不提供通用逐工具拦截 API；插件不能修改 Core 状态、放宽预算或关闭人工合并闸门。

模板的 `when.step` 建立顺序依赖，缺少引用结果时条件不成立（含 `notEquals`）。
条件匹配仅允许恢复该引用步骤，其他 `dependsOn` 必须成功完成；失败、中止、超时或
跳过的其他依赖仍阻断 Agent 和系统步骤。条件自引用及包含条件边的依赖环必须拒绝。

根配置 `integrations.verifications` 显式选择已注册验证 Provider，默认空、最多 32 项。
条目为 `{ provider, command?, timeoutMs? }`，禁止未知字段、客户端 `target` 和 `passed`；
命令使用无 shell 展开的有效 argv，期限为正整数。宿主在 required init 检查 Provider，
在 after-agent 和每次 before-publish 中先执行策略、再验证，并绑定实际 worktree。
失败阻断该阶段的后续副作用；命令期限由 Provider 执行，学习资产仍需类型专属验证。
保存策略或验证选择时，宿主必须确认所需门禁模块实际加载；禁用、缺失或替换该模块
不得静默跳过已配置检查，必须在初始化时阻断。

- Manifest、配置、依赖/冲突、唯一注册名及可选操作声明正确；激活失败回滚，dispose 幂等。
- 信任边界校验输入/结果；取消、超时、资源及输出有界；缺失凭据/工具/协议有安全诊断。
- 原始认证响应、秘密及未授权内容不进入 Renderer、上下文、事件、Artifact 或普通结果。
- 错误区分输入、配置、认证、权限、缺失、不可用、超时、取消、远程失败及协议失败；保留可诊断分类，不伪造成功。
- 验证安装、配置、激活、操作、禁用/启用、卸载及失败路径；至少有实际本地 transport/进程集成检查。
- 租约/所有权、幂等/重放、清理拒绝、审计关联和经验验证边界具有可运行检查；真实服务验证单独记录，不用模拟 transport 代替。
