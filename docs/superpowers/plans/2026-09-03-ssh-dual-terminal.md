# SSH 双终端模式实施计划

> 在当前未提交的 xterm 工作区继续实施，不 reset、clean、提交或覆盖已有改动。

**目标：** 保留内置 xterm，并增加经过 Host 信任校验的 macOS 外部终端启动能力。

## Task 1：外部终端纯适配器

**文件：**
- Create: `desktop-client/electron/adapters/external-terminal-adapter.ts`
- Create: `desktop-client/tests/electron/external-terminal-adapter.test.ts`

步骤：
1. 先写失败测试，固定 iTerm2 检测、Terminal 回退、固定 AppleScript、argv 安全传参、非 macOS和失败行为。
2. 实现注入式 adapter；只允许 `execFile` 参数数组，不使用 shell。
3. 运行聚焦测试和 typecheck。

## Task 2：service 与 typed IPC

**文件：**
- Modify: `desktop-client/electron/services/ssh-service.ts`
- Modify: `desktop-client/electron/ipc/register-handlers.ts`
- Modify: `desktop-client/electron/preload.ts`
- Modify: `desktop-client/shared/ipc-contract.ts`
- Modify/Create focused tests under `desktop-client/tests/electron/`

步骤：
1. 先写失败测试，要求外部启动复用 Host 查找、指纹扫描和 known_hosts 校验。
2. 为 service 注入 external terminal adapter，实现 `openExternal(hostId)`。
3. 增加固定 channel、preload API、sender guard 和 hostId 校验测试。
4. 运行聚焦测试和 typecheck。

## Task 3：双模式 UI

**文件：**
- Modify: `desktop-client/src/features/ssh/SshHostsPage.tsx`
- Modify: `desktop-client/src/features/ssh/ssh.css`
- Modify: `desktop-client/tests/ssh-page.test.ts`

步骤：
1. 先写失败测试，固定“内置终端/外部终端”两个动作。
2. 内置动作沿用 `ssh.connect` 和 `onSession`。
3. 外部动作调用 `ssh.openExternal`，不调用 `onSession`，显示实际终端名称。
4. busy 状态分别标识两种连接，保持现有错误提示和键盘可访问性。

## Task 4：审查与验证

1. 规格审查：安全参数、信任门禁、双模式语义、无 renderer shell 能力。
2. 代码质量审查：AppleScript 转义、fallback 边界、错误泄漏、React 状态和测试可信度。
3. 修复 P1/P2 后重新审查。
4. 运行 `pnpm test`、`pnpm typecheck`、`pnpm build`、`git diff --check`。
5. 重启 `pnpm dev:raw`，仅验证页面加载和按钮存在，不自动连接远程 Host。

