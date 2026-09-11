# SSH 首次部署密码实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用系统安全存储保存 SSH Host 部署密码，并在首次部署公钥时自动填写密码。

**Architecture:** 凭据服务在主进程用 Electron `safeStorage` 加密密文文件；SSH service 负责 Host 校验和按 Host 读取凭据；PTY adapter 只在标准密码提示出现时消费一次性内存密码。renderer 只通过 typed IPC 管理凭据状态，不接触 Node/Electron 或明文持久化。

**Tech Stack:** Electron `safeStorage`、Node fs、node-pty、React、TypeScript、Vitest。

---

### Task 1：安全凭据服务与 IPC

**Files:**
- Create: `desktop-client/electron/services/ssh-credential-service.ts`
- Modify: `desktop-client/electron/ipc/register-handlers.ts`
- Modify: `desktop-client/electron/preload.ts`
- Modify: `desktop-client/shared/ipc-contract.ts`
- Test: `desktop-client/tests/electron/ssh-credential-service.test.ts`
- Test: `desktop-client/tests/electron/ssh-ipc-contract.test.ts`

- [ ] **Step 1：写失败测试**
  - 固定 `safeStorage.isEncryptionAvailable`, `encryptString`, `decryptString` 注入行为。
  - 覆盖保存、状态、读取、删除、Host 隔离、不可用和坏密文。
  - 覆盖 typed channel、sender guard、Host ID 和密码长度/NUL 校验。
- [ ] **Step 2：运行红灯测试**
  - `pnpm exec vitest run --config vitest.config.ts tests/electron/ssh-credential-service.test.ts tests/electron/ssh-ipc-contract.test.ts`
- [ ] **Step 3：实现最小代码**
  - 凭据文件只写 safeStorage 密文 JSON；原子写入，权限 `0600`。
  - API 仅暴露 `has/get/set/remove`，get 只被 service 部署流程调用。
- [ ] **Step 4：运行绿灯测试**
  - 聚焦测试、typecheck、diff-check。

### Task 2：PTY 密码提示注入

**Files:**
- Modify: `desktop-client/electron/adapters/ssh-pty-adapter.ts`
- Modify: `desktop-client/electron/services/ssh-service.ts`
- Test: `desktop-client/tests/electron/ssh-pty-adapter.test.ts`
- Test: `desktop-client/tests/electron/ssh-service.test.ts`

- [ ] **Step 1：写失败测试**
  - 部署会话收到 ANSI/分片 password prompt 时只自动写入一次。
  - 普通输出、非部署会话和第二次提示不自动写入。
  - exit/close 后不保留密码；service 读取凭据后只传给部署 PTY。
- [ ] **Step 2：运行红灯测试**
  - 聚焦 SSH service/PTY 测试，确认旧实现失败。
- [ ] **Step 3：实现最小代码**
  - password 只作为 deployKey 的可选短生命周期参数，不进入 spawn args/env/回调输出。
  - 检测 SSH 标准密码提示并写入 `password + "\\n"`，发送后清零引用。
- [ ] **Step 4：运行绿灯测试**
  - 聚焦测试、typecheck、diff-check。

### Task 3：SSH 页面密码管理

**Files:**
- Modify: `desktop-client/src/features/ssh/SshHostsPage.tsx`
- Modify: `desktop-client/src/features/ssh/ssh.css`
- Modify: `desktop-client/tests/ssh-page.test.ts`

- [ ] **Step 1：写失败测试**
  - 保存密码调用 typed IPC，页面只显示已保存状态。
  - 删除密码调用 typed IPC，密码输入框不回显旧值。
  - 空密码和未受信 Host 不允许保存/部署。
- [ ] **Step 2：运行红灯测试**
  - `pnpm exec vitest run --config vitest.config.ts tests/ssh-page.test.ts`
- [ ] **Step 3：实现最小代码**
  - 增加密码弹窗/内联区域、保存/删除按钮和状态提示。
  - 部署动作沿用现有 Host 状态和 session 逻辑。
- [ ] **Step 4：运行绿灯测试**
  - 页面及 SSH 相关测试、typecheck、diff-check。

### Task 4：审查与最终验证

- [ ] **Step 1：规格与安全审查**
  - 检查明文泄漏、文件权限、IPC 参数、Host 隔离、密码提示识别和生命周期。
- [ ] **Step 2：代码质量审查**
  - 检查异常清理、并发部署、重复 prompt、React 状态和测试可信度。
- [ ] **Step 3：最终验证**
  - `pnpm test`、`pnpm typecheck`、`pnpm build`、`git diff --check`。
  - 不自动连接远程主机。

