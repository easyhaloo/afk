# SSH 双终端模式设计

**日期：** 2026-09-03

## 目标

在现有 SSH 管理中同时提供两种连接方式：

1. **内置终端**：继续使用已经集成的 xterm.js，在 AFK 内完成交互。
2. **外部终端**：由 AFK 校验 Host 和主机指纹后，自动打开 macOS 终端应用并执行同一个 OpenSSH Host 别名。

内置终端仍是默认主操作；外部终端用于需要完整本地终端环境、用户 shell 配置或独立窗口的场景。

## 用户交互

- Host 详情区保留“连接”主按钮，文案调整为“内置终端”。
- 相邻增加次级按钮“外部终端”。
- 点击“内置终端”沿用当前 xterm 会话，不改变行为。
- 点击“外部终端”后，AFK 完成与内置连接相同的 Host 查找、指纹扫描和 known_hosts 信任校验；校验通过后打开外部终端并将其置前。
- 首版 macOS 自动选择策略：优先使用已安装的 iTerm2；未安装时回退系统 Terminal.app。返回实际打开的终端名称，用于显示简短成功提示。
- 外部终端进程完全独立于 AFK；AFK 不采集其输入输出，也不显示为内置 SSH session。

## 主进程架构

- 新增 `electron/adapters/external-terminal-adapter.ts`，只负责检测终端应用和使用固定 AppleScript 模板启动 SSH。
- `ssh-service.ts` 新增 `openExternal(hostId)`：查找 Host、扫描指纹、校验 known_hosts，然后把服务端解析出的 Host alias 交给 adapter。
- `register-handlers.ts` 新增 typed IPC handler；继续执行 sender origin 和 `hostId` 校验。
- `preload.ts` 只暴露固定的 `ssh.openExternal(hostId)` 方法。
- renderer 不拼接 shell 命令、不传终端应用名称、不接触 Node/Electron API。

## 命令与安全边界

- SSH 目标始终使用主进程从已解析配置获得的具体 Host alias，不接受 renderer 传入 hostname、用户名、端口、命令或任意参数。
- adapter 使用 `execFile`/参数数组调用 `/usr/bin/osascript`，禁止 `shell: true`。
- AppleScript 程序为固定常量，Host alias 通过 `argv` 输入，并在 AppleScript 内使用 `quoted form of` 生成 shell 参数，避免命令注入。
- 实际命令固定为 `/usr/bin/ssh -- <alias>`，不允许附加远程命令。
- 外部连接复用现有 known_hosts 信任门禁；未信任、指纹变化或不可达时不启动终端。
- 不把私钥、密码、终端内容写入日志或持久化存储。

## 平台与失败行为

- 当前 desktop 包仅构建 macOS，因此首版只实现 macOS Terminal.app 与 iTerm2。
- 非 macOS 调用返回明确的“不支持当前平台”错误，不回退到 shell 拼接。
- iTerm2 检测或启动失败时，仅在“未安装”情况下回退 Terminal.app；实际启动失败直接报告，避免重复打开两个窗口。
- UI 错误提示使用稳定中文消息，不展示脚本内容、命令参数或底层 stderr。

## 测试

- adapter：iTerm2 已安装、未安装回退 Terminal、参数传递、启动失败、非 macOS。
- service：Host 不存在、未信任阻止启动、受信 Host 仅把 alias 交给 adapter、成功返回终端类型。
- IPC/preload contract：固定 channel、sender guard、hostId 校验。
- renderer：两个按钮语义独立；外部连接不创建内置 session；busy/error/notice 状态正确。
- 最终运行全量测试、typecheck、build、`git diff --check`，重启 Electron；不自动发起真实远程连接。

## 验收标准

- 用户可明确选择“内置终端”或“外部终端”。
- 内置 xterm 行为和已完成的 ANSI、IME、复制、resize 能力不回退。
- 外部终端成功打开独立窗口并执行 `ssh <Host alias>`，窗口自动置前。
- 外部启动前仍执行指纹与 known_hosts 安全校验。
- 任意 renderer 输入都不能变成额外 shell 参数或远程命令。

