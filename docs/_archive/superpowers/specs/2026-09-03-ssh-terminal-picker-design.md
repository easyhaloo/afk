# SSH Terminal Picker Design

## Goal

将 SSH 主机详情中的“内置终端”和“外部终端”合并为一个终端选择器，支持内置终端、iTerm2、Warp、Ghostty、cmux 与 Terminal.app。

## Interaction

- 主机详情保留一个终端下拉框和一个“连接”按钮。
- 默认选择“内置终端”；用户在页面内切换选择，不再由系统自动优先 iTerm2。
- 连接前继续要求主机状态为 `ready`，沿用现有指纹信任和忙碌状态校验。
- 成功后显示实际选择的终端名称；失败时显示主进程返回的明确错误。

## Architecture

- `shared/ssh-contract.ts` 定义无运行时依赖的终端 ID 联合类型。
- preload 与 IPC handler 接受终端 ID；handler 在边界校验白名单。
- SSH service 保留内置 PTY 连接与外部终端连接的分流逻辑。
- external-terminal adapter 为每个外部终端定义 bundle ID、启动命令和安全的 SSH alias 传递方式；不做自动回退。
- 外部终端未安装或启动失败时返回可操作错误。

## Supported Terminals

| ID | Label | Launch strategy |
| --- | --- | --- |
| `builtin` | 内置终端 | Existing PTY session |
| `iterm2` | iTerm2 | AppleScript new window |
| `warp` | Warp | AppleScript activation and command entry |
| `ghostty` | Ghostty | `open -na Ghostty.app --args -e /usr/bin/ssh -- <alias>` |
| `cmux` | cmux | cmux CLI `new-workspace --command <ssh command>` |
| `terminal` | Terminal.app | AppleScript `do script` |

## Safety

- Terminal IDs are validated against a fixed union at the IPC boundary.
- SSH aliases remain separate argv values or are shell-quoted before being passed to terminal command runners.
- Application detection is explicit for the selected terminal; no selected terminal silently changes to another application.

## Acceptance Criteria

- The SSH details view exposes one terminal selector and one connection action.
- Every listed terminal maps to a deterministic adapter invocation.
- Built-in terminal behavior remains unchanged.
- Selecting any unavailable external terminal returns a clear error and does not create an internal session.
- IPC, adapter, service, and renderer tests cover the selector and all supported terminal IDs.
