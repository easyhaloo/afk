# AFK Control Electron 架构

AFK Control Electron 使用 Electron 的 **主进程 + context-isolated preload + React 渲染器** 三层结构。渲染器没有 Node.js 能力，所有本地访问通过 `window.afkDesktop` 的固定方法完成。

| API | 主进程操作 | 输入约束 |
| --- | --- | --- |
| `snapshot(workspace)` | 读取 `.afk/runs/**/events.jsonl`，诊断 `afk --version`，列出 Docker / Podman / tmux | 工作区必须是存在的目录。 |
| `chooseWorkspace()` | 使用 macOS 原生目录选择器 | 用户主动触发。 |
| `tmuxPane(session)` | 捕获指定 tmux 窗格的最后 160 行 | 会话名必须符合受限字符集，且存在于当前 tmux 会话列表。 |
| `tmuxSend(session, line)` | 对指定会话执行 `tmux send-keys` | 前端需勾选确认；会话名、空字节与 4,000 字符上限均在主进程验证。 |

运行诊断遵循 AFK 的实际状态目录：`<worktree>/.afk/runs/<run-id>/events.jsonl`。该路径、增量事件流与诊断属性在 AFK 源码的 `src/application/sessions/run-state.ts` 中定义；桌面客户端不把这类诊断文件作为控制平面。

本项目最初验证过 Tauri 的命令与 Shell 权限模型；根据用户要求已改为 Electron，Tauri 不再是运行时依赖。保留的官方参考链接：

1. https://v2.tauri.app/develop/calling-rust/
2. https://v2.tauri.app/plugin/shell/
3. https://v2.tauri.app/distribute/macos-application-bundle/
