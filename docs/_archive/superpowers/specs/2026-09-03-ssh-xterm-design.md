# AFK SSH xterm 终端设计

## 目标

将桌面端 SSH 会话从普通 `<pre>` 输出与逐键 `keydown` 转发，迁移为 xterm.js 终端内核，使以下行为符合真实终端预期：

- 正确解析 ANSI、CSI、OSC、光标移动、清行和颜色序列，不再显示 `[K`、`]0;...` 等控制序列残片。
- 支持中文输入法、组合字符、候选词确认和一次性多字符输入。
- 支持粘贴多行文本、终端文本选择和平台习惯的复制快捷键。
- 根据面板尺寸同步 PTY 的行列数，减少远端换行和全屏程序布局异常。
- 保留现有 OpenSSH、node-pty、known_hosts、IPC sender 校验和剪贴板安全边界。

## 非目标

- 不在本次实现 SSH 文件传输、SFTP、端口转发配置或会话持久化。
- 不记录终端输入、密码、私钥口令或剪贴板内容。
- 不替换 tmux 只读面板；xterm.js 仅用于 `mode === "ssh"` 的交互会话。
- 不自行实现 ANSI 解析器或输入法组合算法。

## 根因

当前 `TerminalSheet` 使用普通 `<pre>` 显示 node-pty 的原始输出。远端 Shell 在退格和重绘命令行时会返回 `ESC[K` 等控制序列，浏览器不会像终端模拟器一样执行这些序列，因此用户看到 `[K`。同时当前代码直接把 `keydown.event.key` 转发给 PTY，绕过浏览器输入法的 composition 生命周期，只适合简单单键输入。

## 方案选择

采用 `@xterm/xterm` 作为终端内核，并使用 `@xterm/addon-fit` 根据容器尺寸计算 `cols` 与 `rows`。不采用简单正则过滤 ANSI，因为正则无法正确维护光标、清屏、颜色、OSC 和全屏 TUI 状态；也不采用额外命令输入框，因为它无法覆盖密码提示、Shell 编辑和交互程序。

## 组件结构

### `TerminalSheet`

继续负责桌面浮层、标题、关闭按钮、tmux 只读模式和错误提示。SSH 模式不再渲染 `<pre>` 或手工处理 `keydown`、`paste`，而是挂载独立的 `SshTerminalView`。

### `SshTerminalView`

新增专用 React 组件，职责限定为：

1. 创建和销毁 xterm `Terminal`、`FitAddon`、事件订阅与 `ResizeObserver`。
2. 将 PTY 输出写入 xterm，不把原始输出作为 HTML 注入 DOM。
3. 通过 xterm `onData` 把文本、控制键、粘贴和 IME 确认结果发送给现有 `onSshInput`。
4. 在 fit 后把去重的 `{ cols, rows }` 发送给现有 `window.afkDesktop.ssh.resize`。
5. 使用 xterm selection API 和现有 `copyText` IPC 完成显式复制，不读取系统剪贴板。

组件放在 `desktop-client/src/features/terminal/SshTerminalView.tsx`，避免继续扩张 `TerminalSheet.tsx`。

## 输出数据流

现有 App 层继续按 session id 收集 SSH 输出，确保 xterm 组件挂载前到达的早期 banner 不丢失。`SshTerminalView` 保存上次已写入的字符串：

- 新值以前值为前缀时，只向 xterm 写入新增后缀。
- session id 改变或新值不再以前值为前缀时，重置 xterm 后写入完整值。
- 会话退出说明继续由现有 App 状态追加，作为普通终端输出写入。

增量计算抽取为无 DOM、无 Electron 依赖的纯函数并添加测试，防止重复输出。

## 输入与组合输入

xterm 内部的隐藏 textarea 接管键盘、`beforeinput`、composition 和 paste 事件。AFK 不再根据 `event.key.length` 手工拼接字符。中文输入法输入期间不向远端发送未确认的候选内容；composition 确认后由 xterm `onData` 一次发送完整文本。

输入仍经过现有 SSH IPC 和 node-pty 限制：不允许 NUL，单次数据最大 8,000 字符。超过限制的异常不得导致渲染器崩溃，只显示简短错误状态。

## 复制与控制键

通过 xterm 的 custom key event handler 区分复制与远端控制键：

- macOS：有选区时 `Command+C` 调用 `copyText`；`Ctrl+C` 始终交给 xterm，发送 ETX 中断远端程序。
- Windows/Linux：有选区时 `Ctrl+C` 或 `Ctrl+Shift+C` 调用 `copyText`；无选区的 `Ctrl+C` 发送 ETX。
- `Command+V` 与 `Ctrl+Shift+V` 由 xterm 的 textarea paste 流程处理，不通过 AFK 读取剪贴板。
- 复制仅允许 xterm 当前选区，最多 64 KiB UTF-8；失败时显示“复制失败，请缩小选区或重试”，不回显内容。

原有基于 DOM `Selection` 的 helper 在 xterm 接管后删除，避免两套选区模型并存。

## 尺寸同步

`ResizeObserver` 监听 xterm 容器，调用 `FitAddon.fit()`。当 xterm 报告的新行列数与上次不同且 session 仍处于打开状态时，通过已有 `ssh.resize` IPC 同步 node-pty。初次挂载也执行一次 fit；卸载后断开 observer 和所有 disposable。

尺寸错误只更新局部提示，不关闭 SSH 会话。IPC 继续复用主进程的 session id、行列范围和 sender 校验。

## 样式与可访问性

- 引入 xterm 官方 CSS，并在 AFK 样式中只控制容器高度、背景、内边距和焦点边框。
- xterm 容器具有明确的 `aria-label`，终端提示说明“点击后输入，选中文本后使用系统复制快捷键”。
- 保留深色终端外观，与当前终端面板配色协调，不重新设计整套 UI。
- 支持面板宽度变化；小窗口下终端宽度跟随现有浮层约束。

## 安全边界

- xterm 只解释终端控制序列，不使用 `dangerouslySetInnerHTML`。
- React 仍不导入 Node、Electron、文件系统或 `node-pty`。
- preload 继续暴露固定 typed whitelist；剪贴板写入和 SSH 输入、尺寸调整仍经受信 IPC。
- 不开放剪贴板读取，不记录输入，不把终端内容写入磁盘。
- OSC 链接或其他可点击扩展不在本次启用，避免远端输出自动触发外部导航。

## 测试策略

1. 为输出增量纯函数编写红灯测试：追加输出、无变化、session 重置和非前缀替换。
2. 为 xterm 键盘决策纯函数编写红灯测试：macOS 与非 macOS 的复制、粘贴和 `Ctrl+C` 语义。
3. 使用注入式最小 terminal 接口测试 controller 生命周期：`onData` 转发、输出只写增量、resize 去重、dispose 清理。
4. 保留并调整剪贴板服务边界测试。
5. 运行完整 Vitest、renderer/main typecheck、生产构建和 `git diff --check`。
6. 重启 Electron 开发服务，手动验收远端 banner、退格清行、中文输入法、粘贴、复制、`Ctrl+C` 和窗口缩放；不执行破坏性远端命令。

## 验收标准

- 登录 banner 中不再出现 `ESC[K`、`]0;...`、`?2004h` 等控制序列残片。
- 输入 `ls -a`、退格修改命令时，屏幕只显示正确的当前命令行。
- 中文输入法可以先组合候选，再一次性提交中文文本。
- 可以一次粘贴多个字符或多行文本，远端收到的顺序正确。
- 文本选择与复制在 macOS 和 Windows/Linux 上遵循上述快捷键规则。
- `Ctrl+C` 在无复制意图时仍能中断远端前台命令。
- 调整面板宽度后，远端终端行列数同步且换行正常。
- 关闭和重新打开会话不会残留事件监听、重复输出或复用旧 session 内容。
