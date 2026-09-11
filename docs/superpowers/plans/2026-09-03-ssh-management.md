# SSH Host Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 AFK Desktop 中实现 macOS SSH 主机管理、系统 SSH 配置复用、主机指纹确认、公钥部署、免密测试和内置 SSH 终端。

**Architecture:** 主进程通过小型 service 编排独立的 OpenSSH、配置文件、known_hosts 和 PTY 适配器；renderer 只通过 preload 的固定类型化白名单访问 DTO。AFK 只写 `~/.ssh/afk_hosts` 和必要的 Include，不读取或持久化私钥、密码、口令和终端敏感输入。

**Tech Stack:** Electron 35、TypeScript、React 19、Vitest、OpenSSH、`node-pty`、现有 AFK Desktop IPC 和 CSS 体系。

---

## 当前代码边界

- `desktop-client/electron/main.ts` 已是 Electron 启动和模块组装入口，不在其中加入 SSH 业务。
- `desktop-client/electron/ipc/register-handlers.ts` 注册现有 workspace、snapshot、appearance、workflow 和 tmux IPC。
- `desktop-client/electron/adapters/process-executor.ts` 已提供参数数组形式的 `exec`，但当前超时和输出模型不足以承载交互 PTY；SSH 适配器需要依赖注入可替换的命令执行接口。
- `desktop-client/electron/services/workspace-service.ts` 和 `desktop-service.ts` 负责工作区与快照，不把 SSH 状态塞入项目快照。
- `desktop-client/src/main.tsx` 目前集中管理一级导航和 view union；SSH 页面应拆成 `src/features/ssh/`，主组件只增加路由状态、数据加载和动作回调。
- 当前 `main` 有未提交改动；实现必须在新 worktree 中进行，不能重置或覆盖当前工作区。

## 文件清单

创建：

- `desktop-client/shared/ssh-contract.ts`
- `desktop-client/electron/adapters/ssh-command-adapter.ts`
- `desktop-client/electron/adapters/ssh-config-adapter.ts`
- `desktop-client/electron/adapters/known-hosts-adapter.ts`
- `desktop-client/electron/adapters/ssh-pty-adapter.ts`
- `desktop-client/electron/services/ssh-service.ts`
- `desktop-client/electron/security/ssh-validation.ts`
- `desktop-client/src/features/ssh/SshHostsPage.tsx`
- `desktop-client/src/features/ssh/ssh.css`
- `desktop-client/tests/shared/ssh-contract.test.ts`
- `desktop-client/tests/electron/ssh-validation.test.ts`
- `desktop-client/tests/electron/ssh-config-adapter.test.ts`
- `desktop-client/tests/electron/ssh-service.test.ts`

修改：

- `desktop-client/shared/ipc-contract.ts`
- `desktop-client/electron/preload.ts`
- `desktop-client/electron/ipc/register-handlers.ts`
- `desktop-client/src/main.tsx`
- `desktop-client/src/control.css`
- `desktop-client/package.json`
- `desktop-client/pnpm-lock.yaml`

不修改：

- 根目录 CLI Runtime、容器执行器和现有项目 `.afk/config.yml`。
- `desktop-client/dist/`、`dist-electron/`、`release/` 和截图输出。

## Task 1: 建立隔离 worktree 和共享 SSH 契约

**Files:**
- Create: `docs/superpowers/plans/2026-09-03-ssh-management.md`
- Create: `desktop-client/shared/ssh-contract.ts`
- Modify: `desktop-client/shared/ipc-contract.ts`
- Test: `desktop-client/tests/shared/ssh-contract.test.ts`

- [ ] **Step 1: 创建隔离分支**

运行：

```bash
git worktree add .worktrees/ssh-management -b codex/ssh-management
```

预期：在 `/Users/shenggangshu/llm/afk/.worktrees/ssh-management` 创建干净 worktree，分支为 `codex/ssh-management`。

- [ ] **Step 2: 写失败测试**

在 `desktop-client/tests/shared/ssh-contract.test.ts` 覆盖：默认状态、来源、指纹 DTO 和 IPC 请求的可序列化形状；测试使用如下断言：

```ts
import { describe, expect, it } from "vitest";
import { sshHostStatusPriority, type SshHost } from "../../shared/ssh-contract";

describe("SSH shared contract", () => {
  it("keeps the safety ordering from invalid to ready", () => {
    expect(sshHostStatusPriority("invalid")).toBeLessThan(sshHostStatusPriority("ready"));
    expect(sshHostStatusPriority("identity-changed")).toBeLessThan(sshHostStatusPriority("untrusted"));
  });

  it("represents a managed host without secret material", () => {
    const host: SshHost = {
      id: "managed:build-box",
      alias: "build-box",
      hostname: "build.example.test",
      port: 22,
      user: "deploy",
      identityFile: "~/.ssh/id_ed25519_afk",
      source: "managed",
      configPath: "~/.ssh/afk_hosts",
      status: "untrusted",
    };
    expect(host).not.toHaveProperty("privateKey");
    expect(host).not.toHaveProperty("password");
  });
});
```

- [ ] **Step 3: 实现共享类型**

在 `ssh-contract.ts` 定义 `SshHostSource`、`SshHostStatus`、`SshHost`、`SshFingerprint`、`SshDiagnostic`、`SshOperationResult`、`SshSession` 和 `sshHostStatusPriority`；禁止添加密码、私钥和终端原始输入字段。将 SSH API 方法和 IPC channel 加入 `ipc-contract.ts`，方法只接收结构化参数。

- [ ] **Step 4: 运行测试**

运行：`pnpm --dir desktop-client test -- tests/shared/ssh-contract.test.ts`

预期：共享契约测试通过。

- [ ] **Step 5: 提交**

运行：`git add desktop-client/shared desktop-client/tests/shared && git commit -m "feat(desktop): add SSH shared contract"`

## Task 2: 实现输入校验和 SSH 配置适配器

**Files:**
- Create: `desktop-client/electron/security/ssh-validation.ts`
- Create: `desktop-client/electron/adapters/ssh-config-adapter.ts`
- Test: `desktop-client/tests/electron/ssh-validation.test.ts`
- Test: `desktop-client/tests/electron/ssh-config-adapter.test.ts`

- [ ] **Step 1: 写校验失败测试**

测试别名只允许 `[A-Za-z0-9_.-]`，主机地址不能包含 NUL，端口必须为 1–65535，`IdentityFile` 只能位于用户 SSH 目录或使用 `~` 形式，远程工作区二期字段必须是绝对路径。

- [ ] **Step 2: 实现纯校验函数**

导出 `validateSshHostInput(input: unknown)`、`validateSshHostId(id: unknown)`、`validateSshSessionId(id: unknown)` 和 `assertAllowedSshPath(value: string, home: string)`；失败时抛出稳定错误代码，不把原始输入拼接进错误消息。

- [ ] **Step 3: 写配置读写失败测试**

在临时 HOME 中验证：读取 `~/.ssh/config` 的具体 Host、忽略 `Host *`、保留系统 Host 为只读来源、写入 `~/.ssh/afk_hosts`、仅插入一条 Include、重复添加不产生第二条 Include、备份和原子回滚、文件权限为 `0600`、重复 Host 产生诊断而不是崩溃。

- [ ] **Step 4: 实现配置适配器**

导出 `createSshConfigAdapter(options)`，依赖 `fs`、`home` 和 `exec` 可注入。实现：

```ts
type SshConfigAdapter = {
  listHosts(): Promise<{ hosts: SshHost[]; diagnostics: SshDiagnostic[] }>;
  upsertManagedHost(input: ManagedSshHostInput): Promise<SshHost>;
  removeManagedHost(id: string): Promise<void>;
  ensureInclude(): Promise<void>;
};
```

使用保守的逐行 SSH 配置解析，只把具体 `Host` 块归一化；最终配置字段通过 `ssh -G` 交给命令适配器解析。写入采用同目录临时文件、`rename` 原子替换、备份后回滚；不得格式化用户非 AFK 内容。

- [ ] **Step 5: 运行定向测试**

运行：`pnpm --dir desktop-client test -- tests/electron/ssh-validation.test.ts tests/electron/ssh-config-adapter.test.ts`

预期：校验、Include、权限、备份、回滚和复杂配置诊断测试全部通过。

- [ ] **Step 6: 提交**

运行：`git add desktop-client/electron/security desktop-client/electron/adapters/ssh-config-adapter.ts desktop-client/tests/electron/ssh-*test.ts && git commit -m "feat(desktop): manage AFK SSH config"`

## Task 3: 实现 OpenSSH 和 known_hosts 适配器

**Files:**
- Create: `desktop-client/electron/adapters/ssh-command-adapter.ts`
- Create: `desktop-client/electron/adapters/known-hosts-adapter.ts`
- Modify: `desktop-client/electron/adapters/process-executor.ts`
- Test: `desktop-client/tests/electron/ssh-service.test.ts`

- [ ] **Step 1: 写命令适配器失败测试**

使用假的 `execFile` 记录命令和参数，验证所有调用均为参数数组：`ssh -G`、`ssh-keyscan`、`ssh-keygen -lf - -E sha256`、`ssh-add --apple-use-keychain` 和 `ssh -o BatchMode=yes ... true`；验证敏感 stdout/stderr 不进入返回的审计对象。

- [ ] **Step 2: 实现命令适配器**

导出 `createSshCommandAdapter({ execFile })`，方法包含 `resolve(alias)`、`scanFingerprint(host)`、`loadIdentity(identityFile)`、`testBatch(alias)` 和 `deployPublicKey(host, publicKeyPath)`。命令使用固定可执行文件路径或经受控 PATH 解析的路径，超时和最大输出由调用方指定；错误归一化为代码与短分类。

- [ ] **Step 3: 实现 known_hosts 适配器**

导出 `createKnownHostsAdapter({ home, exec })`，提供 `find(hostname, port)`、`trust(candidate)`、`remove(hostname, port)`。信任操作前二次扫描并比较候选算法、主机和指纹；不匹配就拒绝写入。删除操作要求调用方先完成显式确认。

- [ ] **Step 4: 运行定向测试**

运行：`pnpm --dir desktop-client test -- tests/electron/ssh-service.test.ts`

预期：命令参数、超时、敏感信息脱敏和 known_hosts 二次确认测试通过。

- [ ] **Step 5: 提交**

运行：`git add desktop-client/electron/adapters/process-executor.ts desktop-client/electron/adapters/ssh-command-adapter.ts desktop-client/electron/adapters/known-hosts-adapter.ts desktop-client/tests/electron/ssh-service.test.ts && git commit -m "feat(desktop): add OpenSSH adapters"`

## Task 4: 实现 SSH service 和 IPC/preload 白名单

**Files:**
- Create: `desktop-client/electron/services/ssh-service.ts`
- Modify: `desktop-client/electron/ipc/register-handlers.ts`
- Modify: `desktop-client/electron/preload.ts`
- Modify: `desktop-client/shared/ipc-contract.ts`
- Test: `desktop-client/tests/electron/ssh-service.test.ts`

- [ ] **Step 1: 写 service 测试**

覆盖 `listHosts()` 聚合系统与 AFK Host、指纹变化优先阻断、`testHost()` 只允许 trusted 主机、`trustFingerprint()` 二次扫描、`deployKey()` 先检查信任再部署、`connect()` 返回 session ID 和 `closeSession()` 生命周期。

- [ ] **Step 2: 实现 service**

导出 `createSshService(dependencies)`，依赖配置、命令、known_hosts、PTY 和审计 writer。`deriveHostStatus()` 使用共享状态优先级，不从命令文本推导 UI 状态；审计 writer 只接收 `{ operation, hostId, resultCode, startedAt, finishedAt }`。

- [ ] **Step 3: 加入安全 IPC handler**

在 `register-handlers.ts` 注册 `ssh:list`、`ssh:trust`、`ssh:generate-key`、`ssh:deploy-key`、`ssh:test`、`ssh:connect`、`ssh:input`、`ssh:resize`、`ssh:close`；每个 handler 首行调用 `assertTrustedSender(event)`，随后调用纯校验函数，禁止接收任意 command、shell 字符串或私钥内容。

- [ ] **Step 4: 扩展 preload 固定 API**

在 `preload.ts` 本地定义与共享 channel 一致的字符串常量，并只暴露 `window.afkDesktop.ssh` 固定方法；连接输出通过 `ssh:data` 和 `ssh:exit` 事件监听器返回，移除监听器返回清理函数。

- [ ] **Step 5: 运行 typecheck 和测试**

运行：`pnpm --dir desktop-client typecheck && pnpm --dir desktop-client test`

预期：Electron、renderer 和 shared 类型检查通过，所有既有测试与 SSH 测试通过。

- [ ] **Step 6: 提交**

运行：`git add desktop-client/electron/services/ssh-service.ts desktop-client/electron/ipc/register-handlers.ts desktop-client/electron/preload.ts desktop-client/shared/ipc-contract.ts desktop-client/tests/electron/ssh-service.test.ts && git commit -m "feat(desktop): expose SSH management IPC"`

## Task 5: 加入 AFK 一级导航和 SSH 主机页面

**Files:**
- Create: `desktop-client/src/features/ssh/SshHostsPage.tsx`
- Create: `desktop-client/src/features/ssh/ssh.css`
- Modify: `desktop-client/src/main.tsx`
- Modify: `desktop-client/src/control.css`

- [ ] **Step 1: 写 renderer 类型和状态测试**

为页面提供最小可测试的 `filterSshHosts(hosts, query, source, status)` 纯函数测试，验证搜索、来源筛选和状态筛选组合不改变输入数组。

- [ ] **Step 2: 实现主机页面**

页面包含搜索、来源/状态筛选、刷新、添加主机、主机列表和详情面板。系统主机不渲染编辑/删除按钮；`identity-changed`、`untrusted` 和 `auth-required` 状态分别显示阻断、待确认和需要部署密钥的操作提示。

- [ ] **Step 3: 接入一级导航**

把 `View` 增加为 `"ssh"`，在导航中加入 `SSH 主机` 与 `Terminal` 图标；在 workspace 分支渲染 `SshHostsPage`，页面动作全部调用 `window.afkDesktop.ssh`，不得导入 Node/Electron。

- [ ] **Step 4: 添加样式和无障碍文本**

复用现有 CSS 变量、panel、button 和 status 样式；添加列表空状态、错误 banner、焦点态、键盘可操作按钮和 `aria-label`。不把私钥内容或密码放到 DOM。

- [ ] **Step 5: 运行 renderer 验证**

运行：`pnpm --dir desktop-client typecheck && pnpm --dir desktop-client test`

预期：renderer 类型检查、页面纯函数和全量测试通过。

- [ ] **Step 6: 提交**

运行：`git add desktop-client/src/features/ssh desktop-client/src/main.tsx desktop-client/src/control.css && git commit -m "feat(desktop): add SSH hosts page"`

## Task 6: 实现 node-pty 内置 SSH 终端

**Files:**
- Create: `desktop-client/electron/adapters/ssh-pty-adapter.ts`
- Modify: `desktop-client/package.json`
- Modify: `desktop-client/pnpm-lock.yaml`
- Modify: `desktop-client/src/features/terminal/TerminalSheet.tsx`
- Modify: `desktop-client/src/main.tsx`
- Test: `desktop-client/tests/electron/ssh-service.test.ts`

- [ ] **Step 1: 添加依赖**

运行：`pnpm --dir desktop-client add node-pty`

预期：只更新 desktop package 的依赖和 lockfile，不修改根目录依赖。

- [ ] **Step 2: 写 PTY 生命周期测试**

用假的 PTY 工厂验证 `connect()` 创建 `/usr/bin/ssh`、转发 data、转发 exit、处理 input/resize、正常 close 和超时终止；断言审计 writer 从未收到 input/data 内容。

- [ ] **Step 3: 实现 PTY 适配器**

导出 `createSshPtyAdapter({ spawn, onEvent })`；仅接受已验证的 Host alias 和结构化 resize 参数，固定启动参数为 `ssh <alias>`，不接受任意远程命令。session map 只存在内存，窗口关闭时释放。

- [ ] **Step 4: 将 TerminalSheet 扩展为 SSH 模式**

保留现有 tmux 接管模式，新增 `mode: "tmux" | "ssh"`、SSH session 标题、只读终端输出、键盘输入和 resize 监听。SSH 模式不显示 tmux 的“确认发送到此会话”复选框，敏感输入不写入 React state 之外的持久化介质。

- [ ] **Step 5: 运行测试和构建**

运行：`pnpm --dir desktop-client test && pnpm --dir desktop-client build`

预期：PTY 测试、既有 tmux 测试、Electron typecheck、renderer build 全部通过。

- [ ] **Step 6: 提交**

运行：`git add desktop-client/package.json desktop-client/pnpm-lock.yaml desktop-client/electron/adapters/ssh-pty-adapter.ts desktop-client/src/features/terminal/TerminalSheet.tsx desktop-client/src/main.tsx desktop-client/tests/electron/ssh-service.test.ts && git commit -m "feat(desktop): add embedded SSH terminal"`

## Task 7: 集成验证和交付检查

**Files:**
- Modify: `desktop-client/README.md`
- Modify: `desktop-client/ARCHITECTURE.md`

- [ ] **Step 1: 更新文档**

记录 macOS 前置条件、OpenSSH 文件归属、如何添加主机、如何人工核对指纹、如何部署共用 Ed25519 公钥，以及 AFK 不保存哪些敏感信息。明确一期不支持远程 Runtime。

- [ ] **Step 2: 执行独立检查**

运行：`pnpm --dir desktop-client typecheck && pnpm --dir desktop-client test && pnpm --dir desktop-client build`

预期：三个命令均以退出码 0 结束。

- [ ] **Step 3: 执行静态安全检查**

运行：

```bash
rg -n "privateKey|password|passphrase|terminalInput|exec\(.*ssh|shell: true" desktop-client/electron desktop-client/shared desktop-client/src || true
```

预期：不存在持久化私钥/密码字段、Shell 拼接 SSH 调用或 `shell: true`；允许安全文档和测试中的负向断言出现字段名。

- [ ] **Step 4: 检查工作区变更**

运行：`git diff --check && git status --short`

预期：无 whitespace 错误；只包含 SSH 功能文件和计划内文档，不包含 `dist/`、`dist-electron/`、`release/` 或测试截图。

- [ ] **Step 5: 生成交付摘要**

报告实现文件、测试命令及结果、未实现的二期 Runtime 边界；不提交用户的 SSH 配置、known_hosts、私钥、公钥或任何本机凭据。
