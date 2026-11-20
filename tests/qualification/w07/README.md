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

2026-11-20 使用 `9951888e` 构建的 macOS arm64 CLI 0.2.174，仓库外安装后通过模板套件 15/15（18.16 秒）。新增三个 `required` Hook 失败用例。开发与合并冲突修复在启动 Agent 和创建 MR 前退出。成功复盘在处理证据前退出，未创建提炼请求，原始事件文件逐字节保持一致。三次失败均返回退出码 1，事件链校验通过，终态为 `failed`。场景用本地脚本 Agent、回环 Tracker 和临时 Git 仓库。

2026-11-20 同一 CLI 安装包通过双向租约竞争。源码构建的 Desktop 通过 2/2。本地 macOS arm64 打包版 Desktop 0.1.0（产品源码 `e3af46bd`）解压至仓库外后同样通过 2/2。CLI 持有租约时，Desktop 工作器退出 1，Desktop 持久化 `failed`，竞争方没有执行日志或 Agent 启动记录，也没有发起 MR。Desktop 持有租约时，CLI 报告冲突。Desktop 失败后，CLI 显式重试，保全用户设置并推进到 `merge_ready`。测试核对 Electron `app.isPackaged` 和 ASAR 内的渲染页面。ZIP 为本地未签名产物，SHA-256 为 `14df162e2e356815dd7cd4b16592ec10e139dab9146e352e0e6da5051d3d2249`。另设 `AFK_E2E_DESKTOP_EXECUTABLE` 指向解压后的可执行文件即可复跑。

同一 Desktop ZIP 通过 `playwright test learning-settings --grep packaged` 的 2/2 项。验证设置界面驱动本地 Wiki 发布、来源失效后的撤回，以及回环项目标识脱敏。该套件使用固定候选与本地 Tracker。

以下命令复现最初的 0.2.162 验收，在 `c220e380` 的独立工作树根目录运行。原环境为 Node 24.18.0、pnpm 12.5.1，需 Git、Python 3、`rg`、可启动 Electron 的桌面会话及已缓存的依赖和 Electron 二进制。两个套件均使用同一个仓库外安装入口。临时目录中的日志和 Playwright JSON 附件含本机标识，仅在本地查阅。

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
