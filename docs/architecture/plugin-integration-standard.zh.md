# 插件接入标准 v1

本文用于指导 AI 或开发者实现可被宿主发现、安装、配置、激活和调用的能力插件。

## 1. 设计约束

- Core 负责身份、状态机、执行顺序、重试、取消、审计、租约和人工合并闸门。
- 插件只实现一个或多个 Provider，不修改 Core 规则。
- CLI、Desktop、Worker 和自动化触发器只调用统一 Provider，不直接实现第三方连接逻辑。
- 插件 ID、能力 ID、Provider 名称分别独立。
- 插件 ID 不得以 `afk.` 或 `afk-` 开头。
- 插件运行在宿主进程内，属于可信代码；插件协议不提供进程级安全隔离。

## 2. 实现路径

按以下顺序实现：

1. 选择能力类别，确定插件 ID、Provider 名称和支持的操作。
2. 定义 Manifest、配置 Schema、依赖和冲突声明。
3. 实现 Provider 接口和输入输出校验。
4. 在工厂中读取配置，创建 transport、客户端和资源。
5. 在 `activate` 阶段向宿主注册 Provider。
6. 对外部资源、定时器、监听器和子进程注册销毁函数。
7. 接入健康检查、诊断、取消、超时和错误分类。
8. 编写单元测试、协议测试、失败路径测试和最小集成测试。
9. 验证安装、配置、激活、调用、禁用、重新启用和卸载。

## 3. 标准包和 Manifest

插件包必须包含：

- 标准包描述文件。
- 根目录的 `plugin.json`。
- 编译后的入口模块，默认入口为 `dist/index.js`。

`plugin.json`：

```json
{
  "id": "context.project-note",
  "version": "1.0.0",
  "apiVersion": 1,
  "trusted": true,
  "provides": ["context.provider"],
  "requires": [],
  "conflicts": [],
  "entry": "dist/index.js",
  "configSchema": {
    "type": "object",
    "properties": {
      "note": { "type": "string", "minLength": 1 }
    },
    "required": ["note"],
    "additionalProperties": false
  }
}
```

字段规则：

| 字段 | 规则 |
|---|---|
| `id` | 稳定、全局唯一、领域化命名，例如 `host.ssh`、`tracker.linear`。 |
| `version` | 语义化版本。 |
| `apiVersion` | 当前固定为 `1`。 |
| `trusted` | 必须明确声明；表示宿主信任其进程内执行。 |
| `provides` | 只能声明标准能力或已注册扩展能力。 |
| `requires` | 声明所需能力，不声明具体实现细节。 |
| `conflicts` | 声明不能共存的插件 ID 或能力 ID。 |
| `configSchema` | 描述插件配置对象，禁止隐式接收未知字段。 |
| `entry` | 包内相对入口，禁止绝对路径和目录穿越。 |

公共类型：

```ts
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface PluginManifest {
  id: string;
  version: string;
  apiVersion: 1;
  trusted: boolean;
  provides: readonly string[];
  requires?: readonly string[];
  conflicts?: readonly string[];
  configSchema?: JsonValue;
}

interface PluginHealth {
  status: "healthy" | "degraded" | "unhealthy" | "unknown";
  message?: string;
}

interface PluginDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
}
```

入口模块可以导出插件对象，也可以导出工厂：

```ts
export default function createPlugin(context: PluginFactoryContext): Plugin;
```

工厂上下文：

```ts
interface PluginFactoryContext {
  configuration: JsonValue;
  homeDir: string;
  workspaceRoot: string;
}
```

配置只承载可序列化数据。函数、transport、命令执行器、客户端和密钥读取逻辑必须由工厂创建。

## 4. 标准插件接口

```ts
interface Plugin {
  manifest: PluginManifest;
  activate(context: PluginSetupContext): void | Promise<void>;
  health?(options?: OperationOptions): Promise<PluginHealth>;
  diagnostics?(options?: OperationOptions): Promise<readonly PluginDiagnostic[]>;
}
```

```ts
interface PluginSetupContext {
  registerAgentProvider(name: string, provider: AgentProvider): void;
  registerSandboxProvider(name: string, provider: SandboxProvider): void;
  registerTrackerProvider(name: string, provider: TrackerProvider): void;
  registerIssueTrackerProvider(name: string, provider: IssueTrackerProvider): void;
  registerBacklogProvider(name: string, provider: BacklogProvider): void;
  registerHostProvider(name: string, provider: HostProvider): void;
  registerVerificationProvider(name: string, provider: VerificationProvider): void;
  registerNotificationProvider(name: string, provider: NotificationProvider): void;
  registerTriggerProvider(name: string, provider: TriggerProvider): void;
  registerContextProvider(name: string, provider: ContextProvider): void;
  registerCredentialProvider(name: string, provider: CredentialProvider): void;
  registerArtifactProvider(name: string, provider: ArtifactProvider): void;
  registerRepositoryProvider(name: string, provider: RepositoryProvider): void;
  registerPolicyProvider(name: string, provider: PolicyProvider): void;
  onDispose(dispose: () => void | Promise<void>): void;
  getProvider<T>(capability: string, name: string): T | undefined;
  getCredentialProvider(name: string): CredentialProvider | undefined;
}
```

Provider 必须满足以下通用约束：

```ts
interface Provider {
  id: string;
  capabilities: Readonly<Record<string, boolean>>;
  health?(options?: OperationOptions): Promise<PluginHealth>;
  doctor?(options?: OperationOptions): Promise<readonly PluginDiagnostic[]>;
}

interface OperationOptions {
  signal?: AbortSignal;
}
```

- 所有外部操作必须支持取消或明确说明不支持。
- 所有网络、进程和文件操作必须有超时、输出大小或资源大小上限。
- 输入必须在信任边界校验，输出必须在返回前校验。
- 不得把 Token、密码、私钥或完整认证响应写入日志、错误信息或普通返回值。
- Provider 不得通过 shell 字符串拼接用户输入。

## 5. 能力接口

### Agent

```ts
interface AgentProvider extends Provider {
  run(input: AgentRequest, options?: OperationOptions): Promise<AgentResult>;
}
```

要求：支持工作区、提示词、超时、取消、输出收集和结果分类；不得改变 Core 的工作项状态。

### Sandbox

```ts
interface SandboxProvider extends Provider {
  create(input: SandboxRequest, options?: OperationOptions): Promise<SandboxSession>;
  destroy(session: SandboxSession, options?: OperationOptions): Promise<void>;
}
```

要求：声明工作区边界、资源限制、网络策略和可用 Agent；销毁必须幂等。

### Host

```ts
interface HostProvider extends Provider {
  listHosts(options?: OperationOptions): Promise<readonly HostRecord[]>;
  resolve(host: string, options?: OperationOptions): Promise<HostRecord>;
  exec(host: string, argv: readonly string[], options?: OperationOptions): Promise<HostExecResult>;
  upload?(host: string, source: string, destination: string, options?: OperationOptions): Promise<void>;
}
```

远程命令使用 argv 数组传递。远程命令非零退出返回 `HostExecResult`；连接、认证、超时、协议和工具缺失返回分类错误。

### Tracker

```ts
interface IssueTrackerProvider extends Provider {
  list(input: IssueListRequest, options?: OperationOptions): Promise<readonly Issue[]>;
  get(input: IssueIdRequest, options?: OperationOptions): Promise<Issue>;
  create(input: IssueCreateRequest, options?: OperationOptions): Promise<Issue>;
  update(input: IssueUpdateRequest, options?: OperationOptions): Promise<Issue>;
  comment(input: IssueCommentRequest, options?: OperationOptions): Promise<Comment>;
  link(input: IssueLinkRequest, options?: OperationOptions): Promise<IssueLink>;
}
```

只有声明并实现对应操作时才注册为可用 Provider。不得伪造外部平台 ID、URL 或状态。

### Verification

```ts
interface VerificationProvider extends Provider {
  verify(input: VerificationRequest, options?: OperationOptions): Promise<VerificationResult>;
}
```

必须返回 `passed`、执行时长和可选输出。目标工作区由调用方传入，Provider 不得自行切换工作区。

### Notification

```ts
interface NotificationProvider extends Provider {
  notify(input: NotificationMessage, options?: OperationOptions): Promise<NotificationReceipt>;
}
```

必须返回是否投递、目标渠道和安全错误信息。重复投递策略由调用方决定。

### Trigger

```ts
interface TriggerProvider extends Provider {
  register(input: TriggerDescriptor, options?: OperationOptions): Promise<void>;
  unregister(id: string, options?: OperationOptions): Promise<void>;
}
```

Trigger Provider 负责接收和登记事件，不得隐式启动常驻服务。监听器、定时器和事件分发由宿主生命周期管理。

### Context / Memory

```ts
interface ContextProvider extends Provider {
  gather(input: ContextQuery, options?: OperationOptions): Promise<readonly ContextFragment[]>;
}
```

必须返回来源标识；内容应有大小上限。不得把未授权文件、凭据或秘密内容加入上下文。

### Credential / Auth

```ts
interface CredentialProvider extends Provider {
  resolve(input: CredentialReference, options?: OperationOptions): Promise<Credential>;
}
```

Credential 只供 Provider 或 SDK 内部使用，不作为通用插件操作直接输出。优先返回短期凭据，并提供过期时间。

### Artifact / Report

```ts
interface ArtifactProvider extends Provider {
  put(input: ArtifactInput, options?: OperationOptions): Promise<ArtifactReference>;
}
```

写入前校验大小、路径和媒体类型；返回引用、名称和摘要，不返回不必要的原始内容。

### Repository / Workspace

```ts
interface RepositoryProvider extends Provider {
  snapshot(input: RepositoryReference, options?: OperationOptions): Promise<RepositorySnapshot>;
}
```

必须明确声明读、写、clone、push 等能力。未实现的操作不得注册或伪装成功。

### Security / Policy

```ts
interface PolicyProvider extends Provider {
  evaluate(input: PolicyRequest, options?: OperationOptions): Promise<PolicyDecision>;
}
```

拒绝、评估失败或结果不完整时，受管执行默认阻止发布。策略结果必须包含规则标识和原因。

## 6. 生命周期

```text
发现
  ↓
读取 Manifest
  ↓
校验 ID / 版本 / 能力 / 依赖 / 冲突 / 配置
  ↓
加载入口或调用工厂
  ↓
按依赖顺序激活
  ↓
注册 Provider、Action、Trigger 和清理函数
  ↓
健康检查与诊断
  ↓
执行调用
  ↓
停用 Trigger / 等待异步操作
  ↓
逆序 dispose
```

激活规则：

- 激活按依赖拓扑排序执行。
- 任一插件激活失败，当前激活批次整体回滚。
- 已完成注册的 Provider 必须撤销。
- 被其他已激活插件依赖的 Provider 不得单独卸载。
- 健康检查无实现时返回 `unknown`，不得伪造 `healthy`。

运行规则：

- 普通 CLI、Desktop 和 Worker 默认不启动定时器或监听器。
- 只有专用监听运行时显式启用 Trigger。
- 关闭时先停止接收新事件，再等待已接受任务完成，最后销毁 Provider。
- 清理失败记录诊断，但继续清理其他资源。

## 7. 错误协议

错误至少包含：

```ts
interface PluginError {
  code: string;
  message: string;
  retryable?: boolean;
  cause?: unknown;
}
```

标准错误类别：

- `invalid-input`：输入不符合协议。
- `configuration-invalid`：插件配置无效。
- `dependency-missing`：依赖能力不可用。
- `authentication-required`：需要认证或凭据已失效。
- `permission-denied`：权限不足。
- `not-found`：目标资源不存在。
- `unavailable`：外部服务或工具不可用。
- `timeout`：超过调用时限。
- `cancelled`：调用方取消。
- `remote-failed`：远程目标执行失败。
- `protocol-invalid`：外部响应不符合协议。
- `internal-error`：插件内部错误。

错误消息必须可供用户理解，不得包含秘密、完整响应、命令凭据或内部绝对路径。

## 8. 配置与凭据

- 配置是 JSON 可序列化对象，必须通过 Manifest Schema 校验。
- 未声明字段默认拒绝。
- Secret 使用 Credential Provider、系统 Keychain、环境变量或 OAuth/OIDC 机制获取。
- 不把 Secret 写入插件配置、工作流事件、普通日志或 Artifact。
- Provider 自己解析其配置，宿主不猜测第三方字段含义。
- 配置变更在下一次 Runtime 构造时生效；运行中的 Worker 不热更新。

## 9. 生命周期接入点

插件可以声明以下扩展点：

- `before-agent`：Agent 执行前。
- `after-agent`：Agent 执行后。
- `before-publish`：创建或更新发布对象前。
- `cleanup`：执行结束后的资源清理。
- `workflow.action`：受白名单约束的系统动作。
- `surface.cli`、`surface.tui`、`surface.desktop`：界面注册信息。

策略、验证和上下文属于受管执行的一部分；插件只能返回结果，最终是否继续由 Core 和工作流状态机决定。

## 10. 调用协议

公共调用使用统一 Envelope：

```json
{
  "capability": "verification.provider",
  "provider": "test-runner",
  "operation": "verify",
  "input": {
    "target": "workspace",
    "command": ["npm", "test"]
  }
}
```

调用要求：

- `capability`、`provider`、`operation` 必须来自已注册白名单。
- `input` 必须通过操作专用 Schema 校验。
- 输出必须通过对应结果 Schema 校验。
- Credential Provider 不开放通用公开调用。
- 不开放自动合并、审批和绕过策略的操作。

## 11. 最小验收清单

- [ ] Manifest 可解析，ID 不带 `afk` 前缀。
- [ ] 能力、依赖、冲突和配置 Schema 校验通过。
- [ ] Provider 注册名稳定且唯一。
- [ ] 输入、输出、错误和取消行为有测试。
- [ ] 网络、进程、文件、响应和输出均有边界。
- [ ] 凭据不进入日志、事件、Artifact 和普通返回值。
- [ ] `health`、`doctor` 和缺失依赖诊断可用。
- [ ] 激活失败可回滚，dispose 幂等。
- [ ] 能完成安装、配置、激活、调用、禁用、启用和卸载。
- [ ] 至少有一个真实本地 transport 或进程级集成测试。
- [ ] 没有伪造外部资源状态或成功结果。
