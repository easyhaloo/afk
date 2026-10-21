# AFK Control Electron 架构

AFK Control Electron 使用 Electron 的 **主进程 + context-isolated preload + React 渲染器** 三层结构。渲染器没有 Node.js 能力，所有本地访问通过 `window.afkDesktop` 的固定方法完成。

## Source Organization

```text
electron/main.ts                 Electron lifecycle/bootstrap only
electron/window/                  BrowserWindow and navigation policy
electron/ipc/                     typed ipcMain registration
electron/services/                workspace, runtime, appearance, snapshot/workflow, SSH services
electron/adapters/                execFile, tmux/container/resource, OpenSSH, known_hosts, PTY adapters
electron/workflow/                schema-aware config parsing and validation
electron/security/                sender-origin and navigation guards
electron/preload.ts               fixed contextBridge whitelist (CJS: sandboxed preloads must be)
shared/                           Node/Electron-free IPC DTOs, channel constants and the snapshot schema
src/features/                     renderer feature components and pure graph functions
tests/                            desktop package unit tests
```

## Application Boundary

The work-item inventory service has one required application dependency in
`electron/adapters/work-item-application-adapter.ts`:

- `createWorkItemInventoryService` cannot be constructed without an
  application adapter;
- the Main-process provider adapter invokes `@afk/application/provider-inventory`
  through a credential-scoped catalog port; the existing GitHub/GitLab SDK is
  bundled into `dist-electron/provider-inventory.cjs` for in-process use, with
  no `afk backlog inventory` subprocess;
- the service owns caching, persistence, freshness, and provider projection;
- Electron Main composes the adapter and the service once, while IPC and the
  renderer consume only the resulting application DTO.

The client does not spawn an AFK CLI process at all. `electron/composition-root.ts`
assembles the provider ports, and the services call the same
`@afk/application` and `@afk/execution` use cases the CLI calls: the backlog
read and control commands, the work item execution, the workflow graph
generation and the runtime version. The desktop therefore depends on
`@afk/application`, `@afk/core`, `@afk/infrastructure`, `@afk/execution` and
`@afk/workflow-graph`, and the architecture guard rejects any import that
reaches the root package's `src/` tree.

The execution runtime's own capabilities are reached through the ports the
application package declares. `electron/composition-root.ts` is the only file
that names an implementation: it builds the configuration port
(`ConfigurationPort`) and the resource registry port (`ResourceRegistryPort`)
and exports them as `desktopRuntimePorts`. A service states what it needs —
`createDesktopService({ configuration, resourceAdapter })` reads the runner's
configuration through the port and the registered resources through the
adapter built on the registry port — and `electron/ipc/ipc-services.ts`
assembles the services and the adapter once, so a channel never reaches for an
implementation itself. The desktop therefore does not inherit the runtime's
file layout, its constructor arguments or its failure modes: another entry
point may wire the same ports to another implementation without the desktop's
services knowing.

Execution history uses a separate direct Application path:

- Electron Main injects `electron/adapters/run-event-query-adapter.ts`, a read-only
  verified JSONL `RunEventQueryPort` over `~/.afk/events`.
- `electron/services/work-item-execution-query-service.ts` invokes
  `@afk/application.queryExecutionHistory`; no CLI subprocess or legacy projection
  is used for the history view. Main source is plain ESM and imports the use cases
  directly — there is no runtime CommonJS interop shim.
- The renderer's execution history lives in a shared query cache.
  `src/features/run-center/execution-query-cache.ts` holds one entry per query key
  — one in-flight request, one poll timer, many subscribers — and
  `src/features/run-center/execution-queries.ts` binds it to the domain: the key
  factories, the merge rule, and the invalidation seam.
  `use-execution-history.ts` and `use-execution-detail.ts` are thin readers of that
  cache, so the run centre and the work-item history ask for the same execution
  history once and poll it once, instead of each keeping its own state.
  Refreshes merge by run identity and audit sequence, preserving loaded historical
  attempts and pagination progress. Scope changes and newer lookups invalidate stale
  responses. Navigation also cancels pending lookups without clearing loaded
  attempts; `useExecutionDetail` remains responsible for each attempt's detail.
  Starting a run invalidates the history keys, so a run started in one surface
  reaches the other without waiting for the next poll.
- Execution summaries carry optional token `usage` projected by Application
  from verified `agent.session_recorded` events. The shared contract validates
  the three non-negative integer counts; the run-center inspector displays
  recorded counts or `未采集`, preserving explicit zero and execution status.
- The work-item run record (`.afk/work-item-runs.json`) names the process
  that runs the work item. The desktop runs it in its own process, so the
  record carries the desktop's own pid, and `work-item-run-history-service.ts`
  judges a running record by the liveness of that process — which is what the
  work-item list reconcile asks on every read. A record without an owning
  process is a leftover from a desktop that is gone: it is failed rather than
  left running for ever, so the work item is not blocked by a run nobody is
  doing.
- **Development vs packaging differ on purpose.** In development
  `dist-electron/electron/main.js` is transpiled per file and resolves the
  workspace packages through symlinks. `scripts/build-main.mjs` then bundles
  main together with `@afk/*` into a self-contained file for packaging, because
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

The renderer's workflow graph is the one place the renderer loads a workspace
package at runtime, so it loads it through a renderer-safe entry:
`@afk/workflow-graph/step-graph`. That entry computes the facts — the level
each step runs at, the order, the missing dependencies, the cycle question —
and the canvas reports them in its own words (`semantic/missing-dependency`,
`semantic/cycle`, the track bands, the positions). The canvas feeds the
resolver's edge set: a step waits for its `dependsOn` steps *and* for the
step its `when` clause names, so the canvas cannot draw a level the template
resolver would not run. The entry must stay free of node builtins; the graph
package's test proves that on the built artifact.

Workflow definition saving and discovery belong to
`electron/services/desktop-service.ts`. After saving, the renderer uses the
fresh main-process snapshot rather than reconstructing roles, providers or
dependencies. Unsaved drafts never enter the template library. Empty managed
workflows are rejected before either configuration or template files are
written; clearing the final node leaves an empty draft and preserves the last
saved definition. Selecting a built-in template retains the managed canvas
layout, returned as `WorkflowTemplateSummary.canvasNodes` when rediscovered,
so the managed definition can be reopened and selected again.

## End-to-End Testing

Run `pnpm --dir desktop-client exec playwright test --config=playwright.config.ts`
from the repository root. Set `AFK_E2E_PORT` to a free port when the development
server is already running; the suite never reuses another Vite server.
Playwright's global setup builds the current main/preload and provider bundle.
The test-only Electron entry installs an in-process provider snapshot fixture
at the external catalog boundary, then starts the real main process. Application
queries, inventory caching, IPC, preload, and renderer remain live. JumpServer
subprocesses use the fixture binaries through explicit configuration and PATH;
they do not require or use real provider credentials. The AFK CLI itself is not
part of the test setup: the client runs the shared packages in process. Tests
isolate HOME, workspaces, and Electron user data, including the JSONL audit
streams.

| API | 主进程操作 | 输入约束 |
| --- | --- | --- |
| `snapshot(workspace)` | 读取 `.afk/runs/**/events.jsonl`，诊断 `afk --version`，列出 Docker / Podman / tmux | 工作区必须是存在的目录。 |
| `chooseWorkspace()` | 使用 macOS 原生目录选择器 | 用户主动触发。 |
| `tmuxPane(session)` | 捕获指定 tmux 窗格的最后 160 行 | 会话名必须符合受限字符集，且存在于当前 tmux 会话列表。 |
| `tmuxSend(session, line)` | 对指定会话执行 `tmux send-keys` | 前端需勾选确认；会话名、空字节与 4,000 字符上限均在主进程验证。 |
| `ssh.list()` | 读取系统 `~/.ssh/config` Host 与 AFK `userData/ssh-hosts.yml` 主机，并分别执行解析和指纹诊断 | 只返回非敏感 DTO；系统通配符和无法形成目标的 Host 仅生成诊断，托管主机不依赖 OpenSSH alias。 |
| `ssh.add(input)` | 原子写入 Electron `userData/ssh-hosts.yml`，不修改 OpenSSH 配置 | AFK 显示名称可使用中文；地址、端口、路径和跳板机引用在主进程校验；连接时使用结构化参数。 |
| `ssh.trust(request)` | 二次扫描并写入 `~/.ssh/known_hosts` | 候选指纹与二次扫描不一致时拒绝写入。 |
| `ssh.test(hostId)` | 以 `BatchMode=yes` 执行免密测试 | 未信任或指纹变化时阻断；不等待密码。 |
| `ssh.upload(hostId)` | 使用原生文件选择器选择文件，并通过参数化 `scp` 上传到远程工作目录 | 仅允许可信且可连接主机；本地文件、远程目录和所有命令参数在主进程校验，不拼接 shell 命令。 |
| `ssh.connect(hostId)` | 通过 PTY 启动 `/usr/bin/ssh` 并传入托管主机的真实地址参数 | 托管主机不依赖 OpenSSH `Host` alias；系统配置主机保留原有 alias 兼容路径；输入和输出不写入日志。 |
| `ssh.generateKey()` / `ssh.deployKey(hostId)` | 通过 PTY 调用 `ssh-keygen` 或结构化 OpenSSH 部署命令 | 私钥口令和远程密码由终端直接处理，AFK 不持久化。 |

运行诊断读取 AFK 的运行时任务存储：记录在 `~/.afk/runtime/tasks/{active,archive}/<base64url(runId)>.json`，诊断产物在 `~/.afk/runtime/tasks/diagnostics/<base64url(runId)>/`。读取经 `TaskRuntimeReader`（`@afk/execution/application/runtime/task-runtime`），桶结构、文件名、校验与身份规则都由运行时拥有，桌面端不重复实现；桌面客户端不把这些诊断文件当作控制平面。

本项目最初验证过 Tauri 的命令与 Shell 权限模型；根据用户要求已改为 Electron，Tauri 不再是运行时依赖。保留的官方参考链接：

1. https://v2.tauri.app/develop/calling-rust/
2. https://v2.tauri.app/plugin/shell/
3. https://v2.tauri.app/distribute/macos-application-bundle/
