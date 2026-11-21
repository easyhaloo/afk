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

同一安装版复跑模板套件 15/15（19.55 秒）。可选 Hook 失败之后，三个受管运行仍推进到各自预期状态。`observe verify` 与 `observe replay --json` 分别核对序列和重放状态。开发到序号 22 的人工合并门 `merge:1`，冲突修复与成功复盘预览分别到序号 8、7 的 `succeeded`，均与原运行视图一致。

2026-11-20 同一 CLI 安装包通过双向租约竞争。源码构建的 Desktop 通过 2/2。本地 macOS arm64 打包版 Desktop 0.1.0（产品源码 `e3af46bd`）解压至仓库外后同样通过 2/2。CLI 持有租约时，Desktop 工作器退出 1，Desktop 持久化 `failed`，竞争方没有执行日志或 Agent 启动记录，也没有发起 MR。Desktop 持有租约时，CLI 报告冲突。Desktop 失败后，CLI 显式重试，保全用户设置并推进到 `merge_ready`。测试核对 Electron `app.isPackaged` 和 ASAR 内的渲染页面。ZIP 为本地未签名产物，SHA-256 为 `14df162e2e356815dd7cd4b16592ec10e139dab9146e352e0e6da5051d3d2249`。另设 `AFK_E2E_DESKTOP_EXECUTABLE` 指向解压后的可执行文件即可复跑。

同一 Desktop ZIP 通过 `playwright test learning-settings --grep packaged` 的 2/2 项。验证设置界面驱动本地 Wiki 发布、来源失效后的撤回，以及回环项目标识脱敏。该套件使用固定候选与本地 Tracker。

2026-11-21，使用 Release CLI 运行 `44782222425` 构建的 macOS arm64 CLI `0.2.181` 复跑同一模板套件。归档 SHA-256 为 `8f94971f3cc0730aa5c7b62267b0feab7e1be688e8014830ecf962f952342df2`。首次安装在仓库内，测试配置拒绝该路径。将同一归档安装到仓库外后，套件 **15/15** 通过（20.83 秒），覆盖三个模板的必需 Hook 阻断、可选 Hook 留痕及审计回放。场景使用本地脚本 Agent、回环 Tracker 和临时 Git 仓库。

同日使用 Release CLI 运行 `44790689971` 的 macOS arm64 CLI `0.2.182` 归档。归档对应提交 `bb78d3a1`，SHA-256 为 `a28ec58e8a96babc5e8977d2c12f9e253ef9bad5c365f6172fe23ac50e8854de`，与随附的校验文件一致。仓库外安装后，模板套件 **15/15** 和工作区回收套件 **2/2** 通过。模板套件沿用上述执行环境。回收套件验证过期未关闭的执行占用仍受保护，以及占用释放后工作区和 Git worktree 登记可被回收。

2026-11-21，使用 `9c0ae768` 构建的 macOS arm64 CLI `0.2.183` 本地归档，SHA-256 为 `b29654b7cb76febc8abf4630128ea025ae4ba09c82f4fcf4f9a150e582631f4e`。经官方安装脚本校验后安装到仓库外，用 Node `24.18.0` 运行 Release CLI 的七个仓库验收套件及 `tests/e2e/workflow-templates.test.ts`，共 **35/35** 项通过。场景涵盖受管仓库、挂载及命令型工作区、发布门禁、审计回放、工作区回收、三种工作流模板与 Hooks。沿用临时 Git、回环 Tracker 和脚本 Agent。`tests/qualification/w10/local-artifact-audit.mjs` 的两项检查通过，已落盘的测试报告和 Evidence Bundle 均与各自回执摘要匹配。四平台仅验证运行 `44805570111` 使用同产品版本的提交 `732786ed`，以 `44790689971` 归档为回滚基线。

从 `44805570111` 下载提交 `732786ed` 的 macOS arm64 CLI `0.2.183` 归档，SHA-256 为 `67ce63c06d24276709e7af4faa8dab01d87cc239c2bc441caa4947b8eff07f69`。校验并在仓库外安装后，同样的八套 E2E 通过 **35/35** 项，本地测试报告和 Evidence Bundle 两项审计通过。

`44805570111` 第二次尝试补完 Linux x64，四个平台均通过离线安装、基于 `0.2.182` 的升级回滚和安装版验收。四份归档已核对 SHA-256、CLI 版本及平台元数据。Linux x64 归档的 SHA-256 为 `7f77b74a356241017d1068603f6f79bb28f93daa659675ebf66d2a187fd2f8f8`。仅验证模式跳过发布。

### macOS arm64 Desktop 安装验收

2026-11-21，使用提交 `25c39da0` 构建未签名的 Desktop `0.1.0`。DMG 通过完整性校验，以只读方式挂载，通过 `ditto` 将应用复制到仓库外的隔离目录后卸载。ZIP 完整性通过，打包应用的 `app.asar` 与 DMG 安装副本一致。

| 产物 | SHA-256 |
| --- | --- |
| DMG | `fd36383965649ec35e3138319884d3b0543477725a781b0edac3777078df4647` |
| ZIP | `c013f258c579fe63985980bbe3070a775027542c08b4e4e7e1dee3545d6cdef6` |
| `app.asar` | `7bdedd2f5ddd8223cf4ed62bf712b71c7cda20c391d43d9c262db11152d5f477` |

DMG 安装版与仓库外安装的 CLI `0.2.183` 通过 **4/4** 项 Electron E2E（48.6 秒）。覆盖设置界面验证、Wiki 内容发布与来源失效后的撤回、项目 IP 脱敏，以及 CLI 和 Desktop 分别先持有仓库租约的两个竞争场景。用例使用固定候选、本地脚本 Agent 和回环 Tracker。签名和公证仍待验收。

复跑时将 `AFK_E2E_DESKTOP_EXECUTABLE` 和 `AFK_E2E_CLI_ENTRY` 分别指向仓库外安装的 Desktop 可执行文件和 CLI 入口。

```sh
pnpm --dir apps/desktop exec playwright test --config=playwright.config.ts work-item-single-claim learning-settings --grep 'holds the repository lease|\(packaged\)'
```

2026-11-21，同一 DMG 安装副本与 `732786ed` 的 CLI `0.2.183` 归档通过真实 Claude 候选用例 **1/1**（41.9 秒）。Playwright 将合成审批审计提交到隔离账本，直接调用仓库外安装的 Runtime。真实 Claude Code `2.1.326` 产生一条事实候选。打包 Desktop 的设置页使用独立校验器检验主题、规则和证据定位符，经预览与确认发布到隔离 Wiki。测试核对安装版 CLI 的召回结果、来源失效后的排除及设置页撤回。Desktop 启动提炼 Worker 另行验收。回环 Tracker 提供隔离项目。关闭真实模型开关后，设置页套件其余七项全部通过（37.3 秒）。

保留上面的两个安装入口变量。使用已登录的 Claude Code 复跑真实候选用例。

```sh
AFK_E2E_DESKTOP_LIVE_LEARNING=1 pnpm --dir apps/desktop exec playwright test --config=playwright.config.ts learning-settings --grep 'live Claude candidate'
```

2026-11-21，提交 `dbc360be` 的 macOS arm64 Desktop 使用仓库外的未签名打包应用，与同提交的 CLI `0.2.184` 仓库外安装版一起通过学习设置套件 **7/7** 项非模型用例（40.1 秒）。源码构建通过 **6/6** 项非模型用例（29.2 秒）。打包版内的两个场景由 CLI 提交纠正，设置页读取任务后仍为待处理，跨项目调用被拒绝。点击「运行一次提炼」后，设置页显示受阻并允许重试，CLI 独立读回 `budget_exhausted` 和零次尝试，原候选保持不变。真实 Claude、跨端提炼竞争和应用退出时回收的安装版用例待验。

| 产物 | SHA-256 |
| --- | --- |
| CLI `0.2.184` macOS arm64 归档 | `822d40de5c95a13eedb3fd0060a838a3835f6ffea5490dd81693edab8379b99b` |
| Desktop `app.asar` | `c4e741a95a05f8f4b79ee8f9132e17b6e73fff379c47c509c5454babd02f08ab` |

### 历史 QA 工作区归属

通过失败运行 `7cbb0b81-8a53-4725-99a1-c801feff7a61` 的审计定位到它的隔离测试目录。恢复账本中四条分配有三条已关闭，唯一保留的分配 `e920ddad-2c4e-4c5d-aabb-e26a470b4d43` 仍为 `owned`。按工作区和仓库身份复算占用键后，确认三条执行占用均归属已归档为 `blocked` 的 `qa-1-1795185498504-runtime`。

| 资源 | 执行占用 ID |
| --- | --- |
| 工单工作区 | `76e1f14e-15bc-4ca3-a86b-78ba98e75008` |
| 测试仓库 `api` | `fb5b494d-8841-44ee-a9f5-75ab0cf60269` |
| 测试仓库 `web` | `1570ac34-4349-4820-a463-753bd4be7420` |

QA 返回 `MISSING_RESULT` 后，清理因本地未发布提交被拒绝。账本记录的安全提交为 `20f6e3e778f298e56315dfab76962966a5e54763`，当前工作树为 `5b02b87746ccbd0ab0f0b26f0befd495dca597d6`，此提交仅由本地 QA 分支持有。工作树无修改、未跟踪或忽略文件。Git bundle 的 SHA-256 校验全部通过，独立恢复记录对应当前提交。账本仍保留该分配及其执行占用，本次只读核对释放 0 字节。

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
