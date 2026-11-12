# AFK Control Electron 架构

AFK Control Electron 使用 Electron 的 **主进程 + context-isolated preload + React 渲染器** 三层结构。渲染器没有 Node.js 能力，所有本地访问通过 `window.afkDesktop` 的固定方法完成。

## Source Organization

```text
electron/main.ts                 Electron lifecycle/bootstrap only
electron/window/                  BrowserWindow and navigation policy
electron/ipc/                     typed ipcMain registration
electron/services/                workspace, runtime, appearance, snapshot/workflow, SSH services
electron/adapters/                execFile, tmux/container/resource, OpenSSH, known_hosts, PTY adapters; the JumpServer CLI adapter is shared from `@afk/runtime`
electron/workflow/                schema-aware config parsing and validation
electron/security/                sender-origin and navigation guards
electron/preload.cts              fixed contextBridge whitelist (CJS: sandboxed preloads must be)
shared/                           Node/Electron-free IPC DTOs and channel constants
src/features/                     renderer feature components and pure graph functions
tests/                            desktop package unit tests
```

## Application Boundary

Desktop lives in `apps/desktop`, alongside `apps/cli`. Both use the shared
Core, Application and Runtime workspace packages; neither application imports
another workspace's source through relative paths. The renderer never imports
Runtime. See [workspace organization](../../docs/architecture/overview.md#system-structure).

Backlog management uses `electron/services/runtime-backlog-service.ts` to call
`@afk/runtime/backlog`, preserving workspace-scoped list caching and IPC DTO
validation. Graph generation calls Runtime directly. Managed work-item execution
uses `electron/adapters/execution-worker-adapter.ts` to launch the bundled
`electron/worker/execution-worker.ts` as a detached Node process. That worker
calls `@afk/runtime/execution`, the same execution implementation used by CLI.
The packaged application includes the worker. Desktop never looks up or calls
the AFK CLI, and execution has no command override or fallback. Stop, recovery
and merge confirmation use `electron/services/backlog-control-service.ts` and
shared Runtime. Execution workspaces start under `~/.loop-workspace/` in both
applications. Launch receipts come from
`~/.afk/workspaces/<workspace-hash>/work-item-runs.json`; configuration and
Electron user data live in `~/.afk/config.yml` and `~/.afk/desktop/`.

Learning governance uses `shared/learning-contract.ts` and
`electron/services/learning-service.ts` through fixed `learning:*` IPC channels.
Main derives visible projects from the work-item inventory and dispatches the
existing learning system actions through a PluginService-owned runtime for each
complete operation, including candidate preflight, mutation and postflight. Each
runtime is disposed before its operation lease is released. Installation,
removal, configuration and enablement changes cannot overlap these operations.
The renderer receives bounded metadata and version-bound results, without
credentials, raw evidence, database access or a generic system-action bridge.
These calls share Runtime's candidate ledger and do not start a distillation
Worker or a model session when listing candidates and jobs.
Publication and reconciliation receipts remain visible when a subsequent list
refresh fails; stale lists and prepared keys become unavailable. Reconciliation
results are independent of the bounded candidate display page. Source withdrawal
retains historical commit metadata while showing its current recovery status.

The work-item inventory service has one required application dependency in
`apps/desktop/electron/work-items/application-adapter.ts`:

- `createWorkItemInventoryService` cannot be constructed without an
  application adapter;
- the Main-process provider adapter invokes `@afk/application/provider-inventory`
  through a credential-scoped catalog port; the existing GitHub/GitLab SDK is
  bundled into `dist-electron/provider-inventory.cjs` for in-process use, with
  no `afk backlog inventory` subprocess;
- the service owns caching, persistence, freshness, and provider projection;
- Electron Main composes the adapter and the service once, while IPC and the
  renderer consume only the resulting application DTO.

Execution history uses a separate direct Application path:

- Electron Main injects `electron/adapters/run-event-query-adapter.ts`, a read-only
  verified JSONL `RunEventQueryPort` over `~/.afk/events`.
- `apps/desktop/electron/work-items/execution-query-service.ts` invokes
  `@afk/application.queryExecutionHistory`; no CLI subprocess or legacy projection
  is used for the history view. Main source is plain ESM and imports the use cases
  directly — there is no runtime CommonJS interop shim.
- The renderer's `src/features/run-center/use-execution-history.ts` owns execution
  list polling, pagination, and run lookup for the run center and work-item history.
  Refreshes merge by run identity and audit sequence, preserving loaded historical
  attempts and pagination progress. Scope changes and newer lookups invalidate stale
  responses. Navigation also cancels pending lookups without clearing loaded
  attempts; `useExecutionDetail` remains responsible for each attempt's detail.
- Execution summaries carry optional token `usage` projected by Application
  from verified `agent.session_recorded` events. The shared contract validates
  the three non-negative integer counts; the run-center inspector displays
  recorded counts or `未采集`, preserving explicit zero and execution status.
- `scripts/build-main.mjs` bundles main and the execution worker together
  with `@afk/*` into self-contained files for development and packaging, because
  pnpm workspace deps are symlinks that electron-builder does not follow into the
  asar. `electron` and `node-pty` stay external.
- `dist-electron/provider-inventory.cjs` remains a genuine bundle: it inlines the
  GitHub/GitLab SDKs and is loaded through `createRequire`.

The main process is assembled in `electron/main.ts`; it must not own business
logic. Renderer features consume `shared/ipc-contract.ts` and the preload API,
while all filesystem, process, YAML, and SQLite operations stay behind main
process services and adapters. Workflow graph normalization and layout are
pure functions so malformed dependencies and cycles can produce diagnostics
without crashing React.

Workflow definition saving and discovery belong to
`electron/services/desktop-service.ts`. After saving, the renderer uses the
fresh main-process snapshot rather than reconstructing roles, providers or
dependencies. Unsaved drafts never enter the template library. Empty managed
workflows are rejected before either configuration or template files are
written; clearing the final node leaves an empty draft and preserves the last
saved definition. Selecting a built-in template retains the managed canvas
layout, returned as `WorkflowTemplateSummary.canvasNodes` when rediscovered,
so the managed definition can be reopened and selected again.

## Plugin Settings and Runtime Ownership

Settings provides local-directory/npm plugin installation, enable/disable,
removal, and configuration replacement from a local JSON object file up to
1 MiB. Main owns file selection, confirmation and calls to the shared
`PluginManager`; validated IPC carries only operation inputs, metadata and safe
diagnostics. The renderer receives neither saved configuration values nor raw
plugin errors. Builtins can be disabled, not removed; removal retains settings.
A configuration-only entry must be installed before it can be re-enabled.

The manager's mutation guard reads static builtin/installed manifests, checks
entry metadata and applicable configuration, and protects required capability
availability. It does not import or execute installed plugins, call factories,
activate providers, run health checks or resolve credentials. It also protects
exact configured credential names. External registration names remain opaque;
changes to potential credential owners are conservatively refused while an
enabled configured consumer references an external name. Disable that consumer
before modifying its provider. The guard does not prove activation, authorization
or health, and unconfigured plugins do not block unrelated setup or repair.

Settings caches its initial Runtime inspection until Desktop restarts. Refresh
rereads install/configuration state; the inspection is not a live Worker view.
Unlike the static guard, inspection constructs a Runtime and invokes diagnostics,
so trusted plugins and configured credential resolution may execute. Each new
Worker constructs its own Runtime from saved configuration; enable/disable and
configuration changes affect future construction, not existing Workers. Install
and remove refuse while tracked Workers or live starting/running Worker records
exist, and fail closed when that state cannot be verified. File mutations also
block new Worker launches.

Builtin secret fields accept `{env: "TOKEN"}` or
`{provider: "credential.enterprise", name: "deployment", scope?: "read"}`.
Configuration validation checks reference shape without credential resolution,
authentication or network calls; environment references are checked and captured
during construction. Activation awaits credential resolution once per referenced
field, validates the result (including webhook URLs), and then registers the
consumer. Configured builtins sort specific credential dependencies and reject
self/cyclic references; the shared loader also waits for exact named providers
from installed plugins. Missing/cyclic dependencies fail without activation;
actual credential resolution failures are not retried.
Values injected through these generic references are not automatically
refreshed; Gmail retains its own OAuth refresh behavior. Secret values and raw
authentication errors must not enter renderer DTOs or diagnostics.

Plugin Settings does not mount `surface.desktop` or install external provider
tools. Google sign-in selects a Desktop OAuth client JSON in Main and calls
the shared `GoogleOAuthCredentialProvider` with Electron `shell.openExternal`.
The provider owns PKCE, the automatic localhost callback, account detection and
keychain storage. Fixed IPC methods expose account status, login, cancellation
and logout, never client files, tokens or raw provider errors. Cancellation,
renderer navigation/crash/destruction and application exit abort pending login;
explicit cancellation waits for the provider's callback cleanup.
After login, Main calls the shared `configureGoogleAccountPlugins` SDK helper
to populate Google credential/Gmail defaults while preserving existing Gmail
settings and disabled preferences. Configuration failures retain the connected
account and produce a safe, explicit partial-success error; the renderer
refreshes account status without logging out.

Settings also lists and recalls project-scoped experiences through
`@afk/runtime/execution`. Project options come from the existing work-item
inventory; Main rechecks membership and record scope on each operation. Recall
uses the store's verified/unexpired filtering. Verification first validates the
recorded run through `verifyExperienceRun`, then calls `ExperienceStore.verify`
for independent-run/new-evidence enforcement with an explicit corrected action.
Revoke retains the original evidence. The renderer receives an explicit DTO,
and never supplies database paths or claims an audit verification result. See
the paired [plugin architecture](../../docs/architecture/plugins.md) /
[中文说明](../../docs/architecture/plugins.zh.md) for configuration and lifecycle
boundaries.

## End-to-End Testing

Google account E2E tests inject an expired connected account and a cancellable
simulated consent operation at the provider boundary; Main service, IPC, preload
and renderer remain real, and automated runs never read the user's keychain or
authorize against Google. This is separate from manually verified live token
refresh. Experience E2E uses real isolated SQLite records and intact hash-chained
audit runs to exercise project scope, recall, independent verification and revoke.

Run `pnpm --dir apps/desktop exec playwright test --config=playwright.config.ts`
from the repository root. Set `AFK_E2E_PORT` to a free port when the development
server is already running; the suite never reuses another Vite server.
Playwright's global setup builds production main/preload, Worker and provider
bundles, then a separate E2E bundle with typed Runtime fixtures. The test-only
Electron entry installs an in-process provider snapshot fixture at the catalog
boundary. Application queries, inventory caching, IPC, preload and renderer
remain live. The production runtime smoke loads the actual production main and
Worker. JumpServer subprocesses use fixture binaries through PATH. Tests isolate
HOME, workspaces and Electron user data, including the JSONL audit streams;
they do not require real provider credentials or an AFK CLI executable.

Workflow coverage lives in `workflow.spec.ts` and `workflow-crud.spec.ts`.
The CRUD suite edits managed steps through the UI, checks the saved YAML after
reload, and exercises project template discovery, updates and removal through
their supported filesystem source. It also loads seven graph structures from
`.yml` and `.yaml` files and checks node geometry and dependencies at wide and
narrow viewport sizes. Successful screenshots and graph definitions can be kept
outside the generated test directory:

```bash
AFK_E2E_PORT=5291 AFK_UI_EVIDENCE_DIR="$HOME/afk-workflow-evidence" \
  pnpm --dir apps/desktop exec playwright test --config=playwright.config.ts \
  workflow.spec.ts workflow-crud.spec.ts --output="$HOME/afk-workflow-evidence/results"
```

Screenshots are also attached to the Playwright results when no evidence
directory is specified. Keep generated evidence outside the source tree.

| API | 主进程操作 | 输入约束 |
| --- | --- | --- |
| `snapshot(workspace)` | 读取 `~/.afk/workspaces/<workspace-hash>/runs/**/events.jsonl`，报告内置 Runtime，列出 Docker / Podman / tmux | 工作区必须是存在的目录。 |
| `chooseWorkspace()` | 使用 macOS 原生目录选择器 | 用户主动触发。 |
| `tmuxPane(session)` | 捕获指定 tmux 窗格的最后 160 行 | 会话名必须符合受限字符集，且存在于当前 tmux 会话列表。 |
| `tmuxSend(session, line)` | 对指定会话执行 `tmux send-keys` | 前端需勾选确认；会话名、空字节与 4,000 字符上限均在主进程验证。 |
| `ssh.list()` | 读取系统 `~/.ssh/config` Host 与 AFK `userData/ssh-hosts.yml` 主机，并分别执行解析和指纹诊断 | 只返回非敏感 DTO；系统通配符和无法形成目标的 Host 仅生成诊断，托管主机不依赖 OpenSSH alias。 |
| `ssh.add(input)` | 原子写入 Electron `userData/ssh-hosts.yml`，不修改 OpenSSH 配置 | AFK 显示名称可使用中文；地址、端口、路径和跳板机引用在主进程校验；连接时使用结构化参数。 |
| `ssh.trust(request)` | 二次扫描并写入 `~/.ssh/known_hosts` | 候选指纹与二次扫描不一致时拒绝写入；JumpServer 资产由跳板机认证，没有可固定的主机指纹，直接拒绝。 |
| `ssh.test(hostId)` | 以 `BatchMode=yes` 执行免密测试；JumpServer 资产改用 `jms exec <asset>@<server> true` | 未信任或指纹变化时阻断；不等待密码。 |
| `ssh.upload(hostId)` | 使用原生文件选择器选择文件，并通过参数化 `scp` 上传到远程工作目录；JumpServer 资产改用 `jms sftp` | 仅允许可信且可连接主机；本地文件、远程目录和所有命令参数在主进程校验，不拼接 shell 命令。 |
| `ssh.connect(hostId)` | 通过 PTY 启动 `/usr/bin/ssh` 并传入托管主机的真实地址参数；JumpServer 资产启动 `jms login <asset>@<server>` | 托管主机不依赖 OpenSSH `Host` alias；系统配置主机保留原有 alias 兼容路径；JumpServer 的 Koko 端口只接受密码/MFA，不能作为 `ssh -J` 跳板（见 [ADR-0029](../../docs/adr/0029-jumpserver-assets-through-jms.md)）；输入和输出不写入日志。 |
| `ssh.generateKey()` / `ssh.deployKey(hostId)` | 通过 PTY 调用 `ssh-keygen` 或结构化 OpenSSH 部署命令 | 私钥口令和远程密码由终端直接处理，AFK 不持久化。 |

运行诊断遵循 AFK 的实际状态目录：`~/.afk/workspaces/<workspace-hash>/runs/<run-id>/events.jsonl`。该路径、增量事件流与诊断属性在 AFK 源码的 `packages/runtime/src/application/sessions/run-state.ts` 中定义；桌面客户端不把这类诊断文件作为控制平面。

本项目最初验证过 Tauri 的命令与 Shell 权限模型；根据用户要求已改为 Electron，Tauri 不再是运行时依赖。保留的官方参考链接：

1. https://v2.tauri.app/develop/calling-rust/
2. https://v2.tauri.app/plugin/shell/
3. https://v2.tauri.app/distribute/macos-application-bundle/
