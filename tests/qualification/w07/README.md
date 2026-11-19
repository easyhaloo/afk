# W07 安装版模板与 CLI/Desktop 竞争验收

2026-11-20 在 macOS arm64 上从 `c220e380fef3eff1119e15817ca388702d9f8d83` 打包 CLI 0.2.162，经校验和安装到仓库外。三模板套件 12/12 通过，同一工作项的跨端竞争与恢复 1/1 通过。模板入口、可选 Hook 回执、跨端恢复回归分别来自 `75844465`、`f6174b1b`、`684fca52`。[脱敏结构化回执](installed-162.receipt.json)

| 产品入口 | 观察到的结果 |
| --- | --- |
| `afk run --template issue-implementation` | 本地 Git 变更通过实现验收和 QA。两次可选 Hook 失败均留下回执，创建一个模拟 MR 后停在人工合并门。 |
| `afk qa --mode batch` | QA 触发 `merge-conflict-resolution`，解决真实文件冲突并核验双亲提交。一次可选 Hook 失败后 QA 仍通过。验证失败对照中，开发和修复两条路径均在创建 MR 前退出。 |
| `afk experience review --kind success` / `repair` | 两种复盘均将精确的预验证候选版本推进至 `prepared`。成功复盘另有一次可选 Hook 失败回执。零预算对照返回 `budget_exhausted`，原始运行记录逐字节保持一致。 |
| Desktop `workItems.start` 与 `afk execute --work-item-id` | Desktop 已启动一个 Agent 时，CLI 因仓库租约退出，竞争方执行日志不存在。Desktop 的 Agent 退出 1 后持久化为 `failed`。带用户设置的脏检出阻断重试且保留原字节。移存该文件并显式重试后，CLI 启动三个 Agent 进程，持久化到 `merge_ready`，仅创建一个模拟 MR。 |

三个带 Hook 的运行都通过 `afk observe verify`。回执记录各自的序列和末端哈希，哈希标识本次原始事件链；复跑时按里程碑、计数和终态比对。竞争用例从同一源码构建 Electron，经预加载 IPC 进入主进程。两组用例使用本地脚本 Agent、回环 Tracker 和临时 Git 仓库。修复覆盖合并冲突，知识整理覆盖预览，竞争覆盖 Desktop 先持有租约。真实模型、生产 Wiki 发布、反向竞争及发行版桌面安装包在本次范围之外。

## 复跑

2026-11-20 使用 `f52bedb6` 构建的 macOS arm64 CLI 0.2.165 再次运行同一组用例。工作流模板 12/12 通过（18.05 秒），源码构建的 Desktop 与仓库外安装的 CLI 竞争、失败恢复 1/1 通过（21.3 秒）。[同一安装包的 SHA-256 和安装记录](../w05/reconcile-bags/README.md)

在上述提交的独立工作树根目录运行。原环境为 Node 24.18.0、pnpm 12.5.1，需 Git、Python 3、`rg`、可启动 Electron 的桌面会话及已缓存的依赖和 Electron 二进制。两个套件均使用同一个仓库外安装入口。临时目录中的日志和 Playwright JSON 附件含本机标识，仅在本地查阅。

```sh
set -eu
umask 077
out=$(mktemp -d "${TMPDIR:-/tmp}/w07-qualification.XXXXXXXX")
pnpm install --offline --frozen-lockfile
pnpm release:cli
archive="$PWD/release/cli/afk-darwin-arm64.tar.gz"
AFK_HOME="$out/profile" bash release/cli/install.sh --version 0.2.162 --skip-completion \
  --prefix "$out/bin" --archive "$archive" --checksum "$archive.sha256"
export AFK_E2E_CLI_ENTRY="$(readlink "$out/bin/afk")"
test "$(node "$AFK_E2E_CLI_ENTRY" --version)" = 0.2.162
pnpm exec vitest run tests/e2e/workflow-templates.test.ts --no-file-parallelism \
  --reporter=verbose > "$out/templates.log" 2>&1
PLAYWRIGHT_JSON_OUTPUT_NAME="$out/claims.json" pnpm --filter afk-control-electron \
  exec playwright test work-item-single-claim --reporter=list,json
printf 'Local receipts: %s\n' "$out"
```
