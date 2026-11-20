# W10 逐实现验收矩阵 · 2026-11-20

`matrix.tsv` 沿用 11 月 13 日交付审计的 55 个行名和顺序。`implementation_src` 和 `wiring` 定位实现与产品调用路径。`contract_suite` 指向契约测试，`fixture_or_local` 说明测试实际驱动的对象。`audit_cases` 对应历史安装版用例，`config_inputs` 是当时的配置字段提示。`independent_or_account` 记录可观察的效果或待验对象，`gap_next` 给出逐行补验步骤。

| 证据等级 | 行数 | 判定依据 |
| --- | ---: | --- |
| `account` | 6 | 有真实账户侧操作或用户收件记录，含 GitHub 工单查询和 [Codex 开发与独立 QA](agent-codex.md) |
| `service` | 20 | 有独立工具进程、引擎、接收服务或远端主机的回执，含[JumpServer](jumpserver.receipt.json)、[Pi 本地推理](pi-local-inference.receipt.json)、[Podman](podman-native.md)、[知识库](knowledge-base-meili.md)、[OAuth 客户端授权](oauth/README.md)、[OIDC 令牌交换](oidc-keycloak.md)、[Grafana 报告读回](report-platform.md)、[Kubernetes Exec](kubernetes-exec.receipt.json)及[共享挂载工作区](mounted-workspace.receipt.json) |
| `native` | 14 | 产品实际驱动本机进程、Git、时钟、事件文件或[隔离钥匙串](system-keychain.md)，可核对效果 |
| `local` | 9 | 本地实现的文件、规则、映射或检索断言通过 |
| `partial` | 0 | 有关联的真实操作，仍缺本行目标入口的直接回执 |
| `fixture` | 6 | 证据止于替身、合成输入或模拟服务，目标集成待验 |

隔离工作树基线为 `29a25e0b5f1a5c1e5a6536d073f3c2544c116f39`。`packages/runtime/src/application/plugins/configured.ts` 中 `configuredPluginManifests()` 返回 52 个配置 ID。扣除另一专题的 `learning.distiller` 后，W10 有 50 行各用一个 ID，两行 OTLP 共用 `observability.otlp`，三行是内建日志、事件及 Evidence 路由。共享的清单发现、依赖安装、doctor、启停、取消、卸载和升级恢复按各自收据判定。原审计 `commonLifecycle` 记录了安装失败与版本回滚的适用范围。

## 核对行清单与历史用例

2026-11-20 在真实 tmux 3.6a 上复现安装版 CLI 0.2.174 返回 `aborted` 后前台子进程仍在运行。tmux `-CC` 无法在 Node 管道中启动，报 `tcgetattr failed`。切换至 `-C` 后，仓库外安装的 macOS arm64 CLI 0.2.175 通过同一 PTY 断言。前台 Python 进程捕获 Ctrl-C，产物登记的 pane ID 与 tmux 一致，关闭后自有会话消失，活动资源归零，同一隔离服务器中的未登记会话仍存在。测试载荷为有界 Python 进程。归档 SHA-256 为 `e8df48c0a75817522627fe425984985c41125897b4a0384769d38e1e85058868`。

macOS arm64 仓库外安装版 `0.2.174` 每 4 秒触发一次验证命令。三种重启场景均通过。分别在交付为 `pending` 时以 `SIGTERM` 或 `SIGKILL` 停止监听器，以及在阻塞动作处于 `processing` 时以 `SIGKILL` 停止监听器。第二个监听器在首个监听器持有队列时被拒绝。停机 8 秒后，新监听器用原交付 ID 重试成功，再等待一个周期接收新事件。停机期间的两个周期跳过，每次队列共两条交付，成功动作各产生一次写入。执行中断发生在写入前，动作随 stdin 关闭而退出。使用 `python3 -B tests/qualification/w10/schedule-restart.py <安装版CLI绝对路径>` 复跑，另加 `--force` 或 `--in-flight` 测试两种强制终止场景。[安装版回执](schedule-restart.receipt.json)

同一安装包以 `--after-effect` 复跑，在观察到外部文件已写入且交付仍为 `processing` 时强杀监听器。重启后原交付 ID 在第二次尝试变为 `delivered`，同一动作已写入两次。下一次正常触发再写入一次，最终两个交付 ID 对应三次写入。该结果核实队列的至少一次派发语义。外部动作若要求只生效一次，需要由接收方用稳定键实现幂等。[安装版回执](schedule-restart.receipt.json) · [队列协议](../../../docs/architecture/plugins.md)

以 `--idempotent` 复跑时，通过 CLI 安装本地动作插件。插件通过 SDK 的 `currentTriggerDeliveryId()` 取交付 ID，并以原子目录创建作为本地副作用。目录可读、交付仍为 `processing` 时强杀监听器。重启后原交付在第二次尝试变为 `delivered`，目录仍只有一个。新触发正常创建第二个目录，两目录名分别匹配两个交付 ID。该场景验证本地接收端去重跨进程重启生效。[安装版回执](schedule-restart.receipt.json)

同一安装包的本地审计重放通过 3 项。两项双仓门禁用例通过 `observe verify` 校验事件链，用 `observe replay --json` 重放，并和原运行视图核对工单、序列及状态。拒绝用例停在 `failed`，两个远端保持原引用。放行用例读回两个远端公布的提交，重放停在 `awaiting_human` 的 `merge:2`，与末事件一致。第三项独立检查核对失败事件绑定的验证证据。场景使用真实 Git 仓库、回环 Tracker 和脚本 Agent。将 `AFK_E2E_CLI_ENTRY` 指向仓库外安装的 `dist/index.js` 后，可运行 `pnpm exec vitest run tests/e2e/repository-verification-{batch,replay}.test.ts` 复验。同一安装包也复验了开发等待人工合并、冲突修复成功及成功复盘预览三个状态。参见 [W07 三套模板](../w07/README.md)。

macOS arm64 仓库外安装版 `0.2.174` 通过 Local Sandbox 启动 OpenCode `2.2.7` 独立进程和私有 server，推理由回环 Ollama 的 Qwen3.5-2B 执行。两个批处理用例的会话 ID、最终结构化输出、正常退出和累计用量均与 OpenCode 原生导出一致。读文件用例返回正确答案 `41`，实际读取两次，未满足一次读取的断言。直接作答用例尝试了被拒绝的 `skill` 调用，答案也未满足固定模板。取消用例在生成出现增量后中断，CLI 和 server 在 Sandbox 关闭前退出，旧句柄返回 `404 SANDBOX_MISSING`。严格批处理为 0/2，取消为 1/1。[复跑脚本](opencode-local-inference.py) · [安装包与结果回执](opencode-local-inference.receipt.json)

安装版 0.2.170 在 macOS arm64 上驱动原生 Copilot CLI 和本地 Ollama。首次在 90 秒内未观察到取消前的文本增量。第二次回答 `16 + 22 = 38`，原生会话、输入 13,326 和输出 49 token 均与 AFK 匹配。下一段生成出现文本增量后，AFK 中断执行，进程在 Sandbox 关闭前退出。账号托管推理及完整工单待验。[两版安装包回执](copilot-local-inference.receipt.json)

仓库外安装的 0.2.169 复验了两种 `jms` 的发现结果。SSH 型客户端列出 16 个资产，安装版 `afk host exec --provider jumpserver` 在唯一匹配的 Wiki 资产上运行 `echo`，返回本次随机标记及退出码 0。OpenAPI 型客户端的资产发现返回退出码 1。[安装版回执](jumpserver.receipt.json)

2026-11-20，安装版 0.2.168 通过 `afk host ls --provider jumpserver --json` 列出 16 个资产，各记录均含别名且 provider 为 `jumpserver`。本次仅对该进程调整 `PATH`，选择支持 `config list` 和 `ls` 的 SSH 型 `jms` 0.2.0。默认 `PATH` 中优先选中的 OpenAPI 型 `jms` 0.1.8 拒绝 `config` 命令。遇到该情况，0.2.168 曾返回成功的空列表，0.2.169 返回退出码 1 并提示所需的 CLI 命令。

安装版 0.2.168 通过 `afk run` 在两个共享挂载仓库完成实施、验收检查和 QA，停在人工合并门。另一工单在实施发布后遇到一次 HTTP 409，随后 `afk qa` 使用新租约完成独立 QA。两组均从裸仓读回输出，并核对租约与工作树清理。该场景使用回环 HTTPS、合成 Tracker 和脚本 Agent。跨主机挂载和真实模型 QA 待验。[双仓工单回执](mounted-work-item.receipt.json)

2026-11-20，Cursor CLI `2026.07.09-a3815c0` 的 `cursor-agent status --format json` 返回 `authenticated`。安装版 0.2.162 在空白项目经本地 Sandbox 调用 Cursor 后收到 `NON_ZERO_EXIT`（退出码 1）。在同一目录直接运行原生批处理也收到 `Authentication required`。重新执行 `cursor-agent login` 后，需用实际批处理回包验证账号可用。Pi 1.5.2 的 `pi auth check --provider anthropic --no-refresh` 返回 `not_ready`。使用 Anthropic 时可通过 `pi auth login anthropic` 配置。

安装版 0.2.168 经 Local Sandbox、Pi 1.5.2 和临时 Ollama 服务运行 Qwen3.5-2B。Pi 正确回答随机算术题，AFK 会话 ID 与 Pi 原生记录一致，输入 513、输出 80、合计 593 token，工具调用为零。加 `--cancel` 可复验流式输出中的取消。同版本 macOS arm64 CI 发行包复验时，Pi 在关闭 Sandbox 前退出，关闭后原句柄返回 `404 SANDBOX_MISSING`。云端 `wiscode-aiproxy` 的独立请求曾返回 HTTP 402。[复跑脚本](pi-local-inference.py) · [推理回执](pi-local-inference.receipt.json) · [取消回执](pi-local-cancel.receipt.json) · [云端回执](agent-pi.receipt.json)

2026-11-20，安装版 0.2.162 通过 `plugin invoke repository.provider special-git-backend run` 驱动独立 Git 命令后端。首次执行因动作查询失败而清理工作树，裸仓库只有 `main`。同一 runId 重试后，裸仓库的 `review` 指向 `9e3aabe46203670a9a56bf61b08e2ac61ce91e92`，读回 `parcel.txt` 的内容为 `ready for review`。基线 `main` 仍指向 `d7e85a8f44cb3bb06a302f3b8c970e37176adeea`，临时工作树已移除。运行 `python3 tests/qualification/w10/special-git-backend.py <安装版 CLI 可执行文件>` 可在独立临时仓库复验。

基于 `e7c9115a` 的仓库外安装包 0.2.167 另经 `afk run` 自动路由至该后端。首次 checkout 失败后，工作树和租约均已释放，两个裸仓库只含 `main`。经 `afk backlog retry` 恢复同一工作项，实施与 QA 分别在两个仓库创建受管工作树。四条发布引用均读回预期文件，两个 `main` 仍指向各自原提交。工作流停在 `awaiting_human` 的 `merge:2`。本次使用独立命令进程和单机回环 Git，Tracker 与 Agent 使用合成夹具。复验时将 `AFK_E2E_CLI_ENTRY` 指向仓库外同版本安装的 `dist/index.js`，运行 `pnpm exec vitest run tests/e2e/repository-managed-command.test.ts`。[安装包摘要与裸仓库读回收据](special-git-workflow.receipt.json)

2026-11-19，安装版 0.2.158 经 `plugin configure` 启用 OTLP，受管工作项在 `not_claimed` 结束。隔离的 Jaeger 2.23.0 内存后端按服务名和 `run_id` 查回一条匹配 trace，span 包含预期的工单 ID。写入前和随机运行 ID 的查询均为空，本地审计链通过（序号 4）。运行 ID 为 `8583cc99-467e-4b73-86ab-ecbe4e994341`。复现命令为 `python3 tests/qualification/w10/jaeger-query.py <安装目录> <jaeger可执行文件>`。此次使用的官方 Darwin arm64 压缩包 SHA-256 为 `ed4f00636e5a909cf8ce3fcdaf26a1ea7977163fe29da8fb5031b37a6a9682c4`。远端部署鉴权、丢弃计数和时间序列指标查询另行验收。

在上述命令末尾追加 Prometheus 可执行文件，即可验证同一运行的指标。Jaeger 将 OTLP 指标转发至启用了增量转累计的 Prometheus 3.5.0。运行 `09581dbd-608a-4bb5-acae-52ed2aca88c6` 的开始请求与结束事件分别产生一次计数和一次耗时采样，按服务名查回 8 个时间序列样本。随机运行 ID 和不存在的服务都返回空结果，AFK 审计中的 trace 与 metrics 投递失败数均为零。该 Prometheus Darwin arm64 压缩包 SHA-256 为 `c17bc2c992f0b5515eebe2b4ccd626214f8e309a0fe6ec40ed13c42ec13d05fb`。

带 Prometheus 的命令还会在正常运行后停止测试 Collector，再执行一次受管任务。运行 `b20cfd94-14d5-41f6-ab05-b4bb8e7e29cc` 的本地审计链有效，`run.requested` 和 `run.finished` 各关联一份失败回执。每份回执记录两次指标投递失败和一次追踪投递失败。独立运行的 Prometheus 查询结果与停机前一致。

另一次对照将 AFK 的 OTLP 地址直接指向 Prometheus 3.5.0。Prometheus 存入指标并返回 HTTP 200 空响应，AFK 要求接收端返回 OTLP JSON 确认。运行 `bf8fd597-8d9c-480b-bbca-5744c8d8fe8d` 的审计因此记录四次指标投递失败。部署时可使用本节验证过的 Collector 转发配置。

Linux 桌面通知的安装验收通过 Docker 将 `notify-send` 的参数原样送入隔离的 X11 桌面。运行器确认 Dunst 显示一条通知、窗口处于可见状态、历史记录中的标题、正文和紧急程度正确。停止该桌面后，CLI 返回失败回执。macOS 和 Windows 的原生展示仍待验收。

```sh
docker build -t w10-notifier-qual:local - <<'DOCKER'
FROM node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
RUN apk add --no-cache dunst xvfb dbus libnotify font-dejavu xwininfo
DOCKER
python3 tests/qualification/w10/desktop-notify.py release/cli/afk-darwin-arm64.tar.gz w10-notifier-qual:local
```

从仓库根运行。相邻工作树保存原审计，单独应用补丁时也可省略 `W10_AUDIT_DIR`，仅核对本树的源码、契约路径和配置清单。

```sh
O=../../observability-runtime/plugin-architecture
A="$O/.codex/validation/provider-delivery-audit-20261113"
V=../verification/w10
W10_AUDIT_DIR="$A" node_modules/.bin/tsx tests/qualification/w10/check.mjs
jq '.installedPassedCases.I108 | {suite,fullName,status,resultPath}' "$A/evidence-index.json"
```

`audit_cases` 的 I/N/S 加数字均为 `installedPassedCases` 键，`resultPath` 相对原验证工作树。`—` 表示原审计未列该行的安装用例。脚本逐行核对 case ID、索引状态及 `provider-matrix.json` 的 SHA-256。11 月 13 日的 Repository 接线结论由后续 [R] 更新。

| 引用 | 相对定位 | 核对内容 |
| --- | --- | --- |
| [OIDC] | [脚本说明](oidc-keycloak.md) · [脱敏回执](oidc-keycloak.receipt.json) | 0.2.159 经 Keycloak 交换凭据后上传报告。显式撤销后，报告服务在令牌到期前 15 秒返回 401，随后新交换成功。另有禁用目标客户端以及自然到期的独立用例。 |
| [PUT] | `python3 tests/qualification/w10/object-storage.py release/cli` | macOS Apache WebDAV 返回 201，重启后 GET 和磁盘 SHA-256 一致，覆盖返回 403 后原内容完整 |
| [SMTP] | `email-loopback.py`、`email-receipt.json` | 0.2.148 经 BusyBox sendmail 将测试邮件交给回环 SMTP；收端逐字节核对换行、点转义和信封地址 |
| [ISSUE] | `issue-event.md`、`issue-event.receipt.json` | 本地 Gitea 直送三个签名事件；仅打开事件执行一次，重复投递复用原收据 |
| [G] | `docs/architecture/plugins.zh.md` 的 Gmail OAuth 手工记录 | 2026-11-07 浏览器授权后 CLI 发信、Gmail API 接受、用户确认收到 |
| [T] | `docs/guides/testing.zh.md` 的“插件矩阵与源码覆盖率” | 11-09 安装版 0.2.44 复验刷新、scope、身份与 discovery HTTP 200，发信次数为零。另有真实 Claude、Docker、认证 HTTP/Docker/Claude 和 SSH 的范围 |
| [W] | `docs/superpowers/plans/2026-11-08-runtime-learning-and-validation.zh.md` 的“已安装 CLI”、`plugin-matrix-wiki-claude-20261108-2` 和“真实经验” | GitLab MR !198、人工门、SSH 和已安装 `context.experience` gather |
| [GH] | `docs/architecture/full-workflow-e2e-architecture.md` 的“GitHub 侧的附件 release” | 附件 HTTP 状态及字节，issue 操作待验 |
| [S] | `../../w11-skill01-consumer/plugin-architecture/.codex/validation/skill-01/REPORT.md` 及同目录 `consumer-4/{workflow,session,scored}.json` | OpenCode 独立进程、历史 edition 2、宿主评分。新候选有单独的门禁记录 |
| [P] | `$O/docs/superpowers/plans/2026-11-09-session-distillation.zh.md` 的“安装版与真实复用” | #704 的误差由 4 mm 降至 0 mm，因受测与发布提交不同，产品拒绝显式采纳 |
| [R] | `$O/.codex/validation/request-lifecycle-20261118/release-142.saPyl47d/{installed.log,batch-gate-rerun.log}` | 0.2.142 的 6 + 2 项覆盖真 Git、回环 Git HTTP、替身 Agent、双仓门禁和挂载工作区。见 `$O/tests/e2e/repository-{managed-local,managed-remote,verification-hook,verification-batch}.test.ts` |
| [RC] | `$O/.codex/validation/remote-container-installed-20261118/attempt-zzvkne/events.ndjson` 的 `verdict` | 安装服务通过回环调用真实 Docker，最终 PASS，跨物理机部署待验 |
| [O] | [P] 同文“W10 真实本地 OTLP Collector” | 0.2.118 的 `collector-smoke-14750` 由官方 Collector 0.164.0 解码 span、Sum、Histogram，受管任务标记为 `not_claimed` |
| [ES] | `sh tests/qualification/w10/evidence-store.sh "$(command -v afk)"` | macOS arm64 安装版 0.2.147 经独立 SQLite 进程写入并读取证据。单独的只读连接核对 115 字节和 SHA-256。范围外项目保留三个本地事件，向后端传输零字节。 |
| [E] | [P] 同文“W10 Evidence 安装版验收”，以及 `$O/.codex/validation/installed-learning-0.2.126.UJkt32/installed-observe-routing-validation.log` | 选择路由、回读、保全本地数据，后端为测试 Provider |
| [U] | `../verification/runtime-suite.log` | 本表引用 `logger.test.ts` 的 9 项及 `knowledge-base-configuration.test.ts` 的 16 项 |

## 本轮两项实测

2026-11-19，Node 24.18.0。**[D]** 通过本机 Unix socket 连接 Docker 28.3.2，使用预存 Alpine。真实容器写 `/workspace/from-container.txt`，宿主读回 `hello`，1 项通过，27 项未选。**[J]** 本树 CLI 0.2.141 和 Git 2.53.0 检查两个真实临时仓库的别名、分支、提交及脏状态，1 项通过，100 项未选。

从已有依赖及构建产物的工作树根复跑。使用新临时目录和仅含所需变量的环境，先核对镜像 ID，再执行容器用例。

```sh
(
  set -eu
  root=$(pwd -P)
  scratch=$(mktemp -d)
  mkdir -p "$scratch/home" "$scratch/docker" "$scratch/tmp"
  isolated() { env -i PATH="$PATH" HOME="$scratch/home" TMPDIR="$scratch/tmp" DOCKER_CONFIG="$scratch/docker" DOCKER_HOST=unix:///var/run/docker.sock "$@"; }
  isolated node apps/cli/dist/index.js plugin invoke --help
  isolated git --version
  isolated "$root/node_modules/.bin/vitest" run tests/e2e/plugin-local-matrix.test.ts -t 'multi-repository resolves aliases and paths across two repositories'
  isolated docker image inspect --help >/dev/null
  test "$(isolated docker image inspect --format '{{.Id}}' alpine:3.20)" = sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
  cd packages/runtime
  isolated env AFK_DOCKER_E2E=1 "$root/node_modules/.bin/vitest" run src/infrastructure/sandbox/container/container.test.ts -t 'a file written inside /workspace is visible on the host worktree'
)
```

| 原始回执或输入 | SHA-256 |
| --- | --- |
| [D] `$V/docker.log` | `3bcc0bc69c85a1c45a7406ce6631cc2c12fb1ec311ad0b755d7f829c30f7c42c` |
| [J] `$V/git-final.log` | `89554fa2b730a2203b9a8db0a9fbe1fa3cc1874d0c4b7b691aba415d83163350` |
| [J] 本树 `apps/cli/dist/index.js` | `0e93c41b8f53ebb7c3ac5a48fcaa67a715f8378a20f053931b7a5143c748ce4c` |

## [TS] 安装版静态扫描补验

2026 年 11 月 20 日，macOS arm64 安装版 0.2.173 通过仓库发布门禁的全部 10 个用例。新增的两个 `static-scan` 用例在同一双仓工作流中调用真实 TypeScript 5.9.3。TS2322 用例确认编译器退出码为 2、审计回执完整、推送和 MR 请求均为零。修正用例确认两个远端收到正确的提交内容，工作项进入人工合并门。

在独立配置中，用 0.2.142 发行版的 `plugin configure` 保存 TypeScript 5.9.3 的 `tsc --project tsconfig.json --pretty false` 命令。两次 `plugin invoke verification.provider static-scan verify` 使用相同输入，唯一字段为合成项目目录 `target`。每次调用前后 Git 工作树均干净。修正前后只改动 `parcel.ts` 的赋值。

| 测试提交 | 产品回执 | CLI 退出码 |
| --- | --- | ---: |
| `907784bfd24f1b887648e7feeb977e7f69a739c0` | `passed=false`，`parcel.ts(1,14)` 报 TS2322 | 1 |
| `e090c30a36413934cd4dbc13177ed26577ff4004` | `passed=true`，诊断为空 | 0 |

原始回执位于 `$V/static-scan.iqFC4Y/`，含 `tools.txt`、`{rejected,accepted}.{json,exit,revision}` 和可复查两次提交的 `project/`。从本树根运行下列命令可生成独立的新回执。

```sh
bash tests/qualification/w10/static-scan.sh "$O/.codex/validation/request-lifecycle-20261118/release-142.saPyl47d/profile/bin/afk" "$V"
```

## [BR] 安装版浏览器渲染检查

在独立配置中，AFK 0.2.142 通过 `plugin configure verification.browser-check` 保存检查命令。两次 `plugin invoke verification.provider browser-check verify` 的输入均为同一个 `target`。Playwright 1.62.1 启动 Chromium 159.0.8154.6，在离线上下文中打开本地合成页面并点击按钮。两次 DOM 的文字均变为 `Parcel ready`。两个提交只改动 CSS 的 `display` 值。

| 测试提交 | 状态元素渲染结果 | 产品回执 | CLI 退出码 |
| --- | --- | --- | ---: |
| `7581c99b6bfdb198a5c26b24812ccf22c615ba3d` | 隐藏，宽 0 px | `passed=false` | 1 |
| `6fa340db336323349102edb43a4127526b5fe1f2` | 可见，宽 1264 px | `passed=true` | 0 |

`$V/browser-check.kd4Dtz/` 保存 `tools.txt`、合成 Git 项目和 `hidden`、`visible` 两组记录。每组的 `.json` 是产品返回值，`.render.json` 和 `.png` 是浏览器观测和截图，`.revision` 和 `.exit` 是受测提交和 CLI 退出码。复跑命令在每次执行时创建新的配置与证据目录。

```sh
browser="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell"
bash tests/qualification/w10/browser-check.sh "$O/.codex/validation/request-lifecycle-20261118/release-142.saPyl47d/profile/bin/afk" "$browser" "$V"
```

## [GP] 裸仓接收真实推送

Git 2.39.5 向自建裸仓推送。验收脚本安装的 `post-receive` 钩子读取 Git 交给它的 `before after ref`，生成事件 ID，用一次性 HMAC 密钥向回环上的 AFK 0.2.142 `plugin listen` 投递。两次推送均先用错误签名得到 401，再用正确签名得到 202。原样重投得到同一 delivery ID 和 `duplicate=true`。

| 接收端 ref 更新 | 队列回执 | 本地动作 |
| --- | --- | --- |
| 新建 `preview`，指向 `def5585` | `delivered`，1 次处理 | 分支过滤后 0 次 |
| `main` 从 `5928e59` 快进至 `def5585` | `delivered`，1 次处理 | `capability.invoke` 经 `test-runner` 在裸仓读取 `refs/heads/main`，记录 1 次 `def5585` |

`$V/git-push.cTC65J/` 保存 Git 钩子输入与 HTTP 回执 `post-receive.ndjson`、产品 CLI 导出的 `{preview,main}-deliveries.json`、动作记录 `actions.txt`、完整提交号 `verified.json` 和裸仓 `parcel.git`。本轮覆盖本地 Git 接收和产品消费。托管平台原生投递、平台项目身份、跨服务重试及 Issue 生命周期待验。

```sh
receipts=$(mktemp -d)
node tests/qualification/w10/git-push.mjs "$(command -v afk)" "$receipts"
git --git-dir="$(find "$receipts" -type d -name parcel.git)" show-ref --heads
```
