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
electron/preload.ts               fixed contextBridge whitelist
shared/                           Node/Electron-free IPC DTOs and channel constants
src/features/                     renderer feature components and pure graph functions
tests/                            desktop package unit tests
```

The main process is assembled in `electron/main.ts`; it must not own business
logic. Renderer features consume `shared/ipc-contract.ts` and the preload API,
while all filesystem, process, YAML, and SQLite operations stay behind main
process services and adapters. Workflow graph normalization and layout are
pure functions so malformed dependencies and cycles can produce diagnostics
without crashing React.

| API | 主进程操作 | 输入约束 |
| --- | --- | --- |
| `snapshot(workspace)` | 读取 `.afk/runs/**/events.jsonl`，诊断 `afk --version`，列出 Docker / Podman / tmux | 工作区必须是存在的目录。 |
| `chooseWorkspace()` | 使用 macOS 原生目录选择器 | 用户主动触发。 |
| `tmuxPane(session)` | 捕获指定 tmux 窗格的最后 160 行 | 会话名必须符合受限字符集，且存在于当前 tmux 会话列表。 |
| `tmuxSend(session, line)` | 对指定会话执行 `tmux send-keys` | 前端需勾选确认；会话名、空字节与 4,000 字符上限均在主进程验证。 |
| `ssh.list()` | 读取系统 Host 与 AFK Include 主机，执行 `ssh -G` 和指纹诊断 | 只返回非敏感 DTO；通配符和无法形成目标的 Host 仅生成诊断。 |
| `ssh.add(input)` | 原子写入 `~/.ssh/afk_hosts`，必要时维护 Include | 别名、端口、路径和跳板机引用在主进程校验。 |
| `ssh.trust(request)` | 二次扫描并写入 `~/.ssh/known_hosts` | 候选指纹与二次扫描不一致时拒绝写入。 |
| `ssh.test(hostId)` | 以 `BatchMode=yes` 执行免密测试 | 未信任或指纹变化时阻断；不等待密码。 |
| `ssh.connect(hostId)` | 通过 PTY 启动 `/usr/bin/ssh <alias>` | 只接受已验证的 Host ID；输入和输出不写入日志。 |
| `ssh.generateKey()` / `ssh.deployKey(hostId)` | 通过 PTY 调用 `ssh-keygen` 或结构化 OpenSSH 部署命令 | 私钥口令和远程密码由终端直接处理，AFK 不持久化。 |

运行诊断遵循 AFK 的实际状态目录：`<worktree>/.afk/runs/<run-id>/events.jsonl`。该路径、增量事件流与诊断属性在 AFK 源码的 `src/application/sessions/run-state.ts` 中定义；桌面客户端不把这类诊断文件作为控制平面。

本项目最初验证过 Tauri 的命令与 Shell 权限模型；根据用户要求已改为 Electron，Tauri 不再是运行时依赖。保留的官方参考链接：

1. https://v2.tauri.app/develop/calling-rust/
2. https://v2.tauri.app/plugin/shell/
3. https://v2.tauri.app/distribute/macos-application-bundle/
