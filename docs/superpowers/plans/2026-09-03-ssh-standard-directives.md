# SSH Standard Directives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 停止把标准 OpenSSH 指令误报为“未识别配置项”，同时对关闭主机指纹保护的配置提供明确安全提醒。

**Architecture:** SSH 配置适配器只提取 AFK 使用的字段，其他结构合法指令交给本机 `ssh -G` 验证。适配器额外识别两类高风险指令并生成结构化诊断；渲染层只增加对应诊断类型的友好文案，不改变现有分组组件。

**Tech Stack:** TypeScript、Electron main-process adapter、React、Vitest、系统 OpenSSH。

---

### Task 1: Remove false unknown-directive diagnostics

**Files:**
- Modify: `desktop-client/electron/adapters/ssh-config-adapter.ts:31-58`
- Test: `desktop-client/tests/electron/ssh-config-adapter.test.ts`

- [ ] **Step 1: Write the failing adapter test**

Add a test configuration containing standard directives that AFK does not model:

```ts
const { home } = await createHome(`Host demo
  HostName demo.example.test
  ServerAliveInterval 60
  ServerAliveCountMax 3
  ForwardAgent yes
  ControlMaster auto
`);
const adapter = createSshConfigAdapter({
  home,
  exec: async () => ({ ok: true, stdout: "", stderr: "" }),
});
const result = await adapter.listHosts();
expect(result.diagnostics).not.toEqual(expect.arrayContaining([
  expect.objectContaining({ code: "ssh.unknown-directive" }),
]));
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run --config vitest.config.ts tests/electron/ssh-config-adapter.test.ts`

Expected: FAIL because the adapter currently emits one `ssh.unknown-directive` per unmodelled directive.

- [ ] **Step 3: Remove the unknown-directive branch**

Keep parsing `hostname`, `port`, `user`, `identityfile`, `proxyjump`, and `include`. For any other syntactically valid `Key Value` line, do not emit a diagnostic. Continue emitting `ssh.malformed-directive` for non-comment lines that do not match the directive syntax.

- [ ] **Step 4: Preserve OpenSSH validation behavior**

Add a focused test where the injected `exec("ssh", ["-G", "demo"])` returns `{ ok: false, stderr: "Bad configuration option" }` and assert one `ssh.resolve-failed` diagnostic is returned for `demo`. This proves ignored directives are still validated by the system OpenSSH implementation.

- [ ] **Step 5: Run the focused tests**

Run: `pnpm vitest run --config vitest.config.ts tests/electron/ssh-config-adapter.test.ts`

Expected: all adapter tests pass.

### Task 2: Add explicit host-key safety diagnostics

**Files:**
- Modify: `desktop-client/electron/adapters/ssh-config-adapter.ts:20-58`
- Test: `desktop-client/tests/electron/ssh-config-adapter.test.ts`

- [ ] **Step 1: Write failing tests for dangerous values**

Add table-driven cases for case-insensitive directive names and values:

```ts
it.each(["no", "off", "NO", "OFF"])("warns when StrictHostKeyChecking is %s", async (value) => {
  // Host demo + StrictHostKeyChecking value
  // assert ssh.host-key-checking-disabled, warning, hostAlias demo, ~/.ssh/config
});
```

Add cases for `UserKnownHostsFile none`, `/dev/null`, and multiple paths containing `/dev/null`. Assert normal values such as `~/.ssh/known_hosts` do not generate the safety diagnostic.

- [ ] **Step 2: Run tests and verify they fail**

Run: `pnpm vitest run --config vitest.config.ts tests/electron/ssh-config-adapter.test.ts`

Expected: FAIL because explicit safety diagnostics do not exist.

- [ ] **Step 3: Implement small directive safety helpers**

Add focused pure helpers inside the adapter module:

```ts
function isHostKeyCheckingDisabled(value: string) {
  return ["no", "off"].includes(value.trim().toLowerCase());
}

function isKnownHostsDisabled(value: string) {
  const files = value.trim().toLowerCase().split(/\s+/);
  return files.includes("none") || files.includes("/dev/null");
}
```

When parsing these directives, emit:

```ts
{
  code: "ssh.host-key-checking-disabled",
  severity: "warning",
  message: `Host ${current.alias} 已关闭 SSH 主机密钥严格校验`,
  path: configPath,
  hostAlias: current.alias,
}
```

and:

```ts
{
  code: "ssh.known-hosts-disabled",
  severity: "warning",
  message: `Host ${current.alias} 已禁用用户 known_hosts 文件`,
  path: configPath,
  hostAlias: current.alias,
}
```

Do not change connection blocking behavior or rewrite configuration files.

- [ ] **Step 4: Run adapter tests**

Run: `pnpm vitest run --config vitest.config.ts tests/electron/ssh-config-adapter.test.ts`

Expected: all tests pass, standard keepalive directives remain silent, and dangerous values produce explicit warnings.

### Task 3: Update renderer labels and regression tests

**Files:**
- Modify: `desktop-client/src/features/ssh/SshHostsPage.tsx:10-18`
- Modify: `desktop-client/tests/ssh-page.test.ts`
- Modify: `desktop-client/tests/ssh-diagnostics.test.ts`

- [ ] **Step 1: Export a diagnostic label helper and write failing tests**

Replace direct map access with a small exported function:

```ts
export function sshDiagnosticTypeLabel(code: string) {
  return diagnosticTypeLabels[code] || "配置诊断";
}
```

Before implementing the new labels, add assertions:

```ts
expect(sshDiagnosticTypeLabel("ssh.host-key-checking-disabled")).toBe("主机密钥校验已关闭");
expect(sshDiagnosticTypeLabel("ssh.known-hosts-disabled")).toBe("known_hosts 已禁用");
```

- [ ] **Step 2: Run the focused renderer tests and verify they fail**

Run: `pnpm vitest run --config vitest.config.ts tests/ssh-page.test.ts tests/ssh-diagnostics.test.ts`

Expected: FAIL because the safety labels are not mapped yet.

- [ ] **Step 3: Add the safety labels and remove the obsolete unknown label**

Map the two new safety codes to the exact labels above. Remove `ssh.unknown-directive` from `diagnosticTypeLabels`. Keep malformed, non-concrete, and fallback labels unchanged. Use `sshDiagnosticTypeLabel` in `SshDiagnostics`.

- [ ] **Step 4: Update aggregation fixtures**

Replace `ssh.unknown-directive` fixtures in `tests/ssh-diagnostics.test.ts` with `ssh.host-key-checking-disabled` or another supported host-specific diagnostic. Preserve all grouping assertions: normalized message, count, path/severity/code isolation, sorted aliases, and no-host behavior.

- [ ] **Step 5: Run focused tests**

Run: `pnpm vitest run --config vitest.config.ts tests/ssh-page.test.ts tests/ssh-diagnostics.test.ts`

Expected: all focused renderer tests pass.

### Task 4: Full verification and Electron smoke test

**Files:**
- No source changes expected.

- [ ] **Step 1: Run the complete desktop test suite**

Run: `pnpm test`

Expected: all tests pass with no `ssh.unknown-directive` assertions remaining.

- [ ] **Step 2: Run TypeScript checks**

Run: `pnpm typecheck`

Expected: renderer, shared DTO, and Electron main-process checks pass.

- [ ] **Step 3: Build the desktop package**

Run: `pnpm build`

Expected: Electron main and Vite renderer production builds complete successfully.

- [ ] **Step 4: Verify the actual aliyun diagnostics**

Start or refresh the Electron development app, open `SSH 主机`, and verify:

- `ServerAliveInterval` and `ServerAliveCountMax` do not appear as diagnostics;
- `aliyun` appears only under the two explicit host-key safety groups caused by `StrictHostKeyChecking no` and `UserKnownHostsFile /dev/null`;
- expanding each group shows `aliyun` and `~/.ssh/config`;
- the page contains no “未识别配置项” text.

- [ ] **Step 5: Check the final diff**

Run: `git diff --check`

Expected: no whitespace errors.

