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

2026-11-22，从仓库外安装 macOS arm64 CLI 0.2.189，通过 `plugin configure context.retrieval --builtin --file` 导入三份真实 Markdown 摘录。相同输入在 0.2.188 被配置校验拒绝。修复后通过 `plugin invoke context.provider context.retrieval gather --input <文件> --json` 查询工作项关系、PRD 基线和中文桌面设计，分别命中预期首条来源，分数为 2、3、2，正文与输入逐字一致（去除首尾空白）。未命中查询返回 `[]`。同一安装版通过 17 项上下文与记忆回归。归档 SHA-256 为 `889fd413a8fe55f8e73fa7cfb1a15ea01e50d1017bec802c8cd7b643728e6bdf`，语料 SHA-256 为 `7576d829b54de19576d98942c96c0a810890541990c2eede780c12715ac814d7`。

2026-11-21，使用 macOS arm64 的 `0.2.182` 安装包分别从真实 GitHub 和 GitLab 账户执行 `tracker.provider getIssue`。独立的 `gh` 和 `glab` 查询与 AFK 返回的编号、标题、状态和 URL 一致。GitLab 回环服务在写标签前返回一次 HTTP 409。另一个 CLI 进程重试成功，服务端共应用一次写入，读回确认目标标签及原有无关标签。真实服务上的写回恢复仍待验。Cursor 原生只读批处理和 AFK 的本地 Sandbox 入口均返回 `Authentication required`，没有产出原生会话事件。[Tracker 回执](tracker-182.receipt.json)

2026-11-20 在真实 tmux 3.6a 上复现安装版 CLI 0.2.174 返回 `aborted` 后前台子进程仍在运行。tmux `-CC` 无法在 Node 管道中启动，报 `tcgetattr failed`。切换至 `-C` 后，仓库外安装的 macOS arm64 CLI 0.2.175 通过同一 PTY 断言。前台 Python 进程捕获 Ctrl-C，产物登记的 pane ID 与 tmux 一致，关闭后自有会话消失，活动资源归零，同一隔离服务器中的未登记会话仍存在。测试载荷为有界 Python 进程。归档 SHA-256 为 `e8df48c0a75817522627fe425984985c41125897b4a0384769d38e1e85058868`。

同日使用 `bash tests/qualification/cli-upgrade.sh <0.2.174 归档目录> 0.2.174 <0.2.175 归档目录> 0.2.175` 完成 macOS arm64、Node 24.18.0 离线验收，退出码为 0。错误校验和被拒绝，原可执行链接保持有效。正常升级后，重装 0.2.174 恢复原链接和版本。各阶段的 `plugins.yml` 字节及 `plugin list --json` 结果一致，其中 OTLP 插件处于启用状态。0.2.174 归档 SHA-256 为 `6b16bc0ff253f18cb68fce2614cbf5d3f2f9f1a0fb5d68e5799520828aee3475`。

四平台复跑时，在 `Release CLI` 工作流指定 `verify_only=true` 和 `rollback_from_run=<上一版归档的运行 ID>`。每种平台使用对应的上一版归档与本次构建的归档，执行同一个升级、错误校验和拒绝、回滚脚本。可用基线需保留四份归档产物。`0.2.174` 的基线为 [44672582771](https://github.com/easyhaloo/afk/actions/runs/44672582771)。

同一 0.2.175 安装版通过 33 项 E2E。`AFK_E2E_CLI_ENTRY` 指向安装后的 `afk`，以 `--no-file-parallelism` 运行 `tests/e2e/repository-managed-{local,remote,command}.test.ts`、`tests/e2e/repository-verification-{hook,batch,replay}.test.ts` 和 `tests/e2e/workflow-templates.test.ts`。测试使用实际 Git 工作树、回环 Tracker 和脚本 Agent。`node tests/qualification/w10/local-artifact-audit.mjs <安装版CLI绝对路径>` 另通过两项，核对本地测试报告和证据包的导出字节、摘要及审计事件。

`0.2.175` 同一归档复跑 `schedule-restart.py` 的默认、`--force`、`--in-flight`、`--after-effect`、`--idempotent` 五个场景，全部退出 0。原交付均在第二次尝试成功，每次启动第二个监听器均被拒绝。`--after-effect` 的两个交付产生三次写入。`--idempotent` 使用原交付 ID 去重，两个交付各生效一次。接收端为隔离的本地文件系统。

同一归档的 W11 本地召回检查通过 30/30。设置 `AFK_E2E_CLI_ENTRY` 指向安装版，`AFK_E2E_OPENCODE_ENTRY` 指向本机 OpenCode 2.2.7，并运行 `pnpm exec vitest run --no-file-parallelism tests/e2e/w11/installed-{fact,lesson,skill,tool}.test.ts`。事实、流程、修复经验和工具经安装版 CLI 或 Runtime 验证，技能经离线 OpenCode 提示词适配器验证。五类各覆盖六条冻结用例。四个测试文件合计 31 项通过，包含一项工具授权检查。其余 9 项跳过。真实模型和正式业务收益测试仍使用独立的验收记录。

2026-11-21，使用 [W07 同一 macOS arm64 0.2.183 本地归档](../w07/README.md)、Node 24.18.0 和 OpenCode 2.2.7 复跑该套件。30 条冻结召回断言及 1 条工具授权检查均通过，9 条需单独启用的用例跳过。技能仍使用离线提示适配器，技能或工具的新候选晋级需单独验收。

提交 `732786ed` 的 [W07 macOS arm64 CI 归档](../w07/README.md) 复跑同一召回套件，4 个文件共通过 31 项，跳过 9 项，耗时 92.85 秒。30 条冻结断言和 1 条工具授权检查的适用范围与上次一致。

2026-11-21，提交 `84a4b188` 的 macOS arm64 安装版 `0.2.188` 通过 30 条冻结召回断言和 3 项对照检查。技能使用离线 OpenCode 2.2.7 提示词适配器。`local-artifact-audit.mjs` 通过测试报告和证据包两项独立读回。[同提交的四平台安装包验证通过，发布步骤跳过。](https://github.com/easyhaloo/afk/actions/runs/44898012725)

使用带暂存回收补丁的 `install.sh` 从 `0.2.187` 升级至 `0.2.188`。在安装器收到 `SIGKILL` 后，旧版仍可运行。重试成功安装 `0.2.188`，回收中断暂存目录中 24,052,952 字节的常规文件，并保留仍在使用的暂存目录及旧格式目录。

同提交的 Linux x64 CI 覆盖率为行和语句 90.23%、函数 87.01%、分支 88.83%。五个源码包均通过各自的基线门槛。`source-coverage` 中 `report.json` 的 SHA-256 为 `205aca4a3585b41242c72b3eca8f501873501569c6a2c9d36ec6b967013ed2a5`。[CI Verification 44898016119](https://github.com/easyhaloo/afk/actions/runs/44898016119)

仓库外安装的 macOS arm64 CLI `0.2.188` 通过 205 项端到端测试。工作区诊断 2 项、插件执行及生命周期 71 项、HTTP 插件 29 项、本地插件 103 项。飞书、Slack、Linear 和 Jira 使用回环 HTTP 服务，真实账户验收仍待进行。以 `AFK_E2E_CLI_ENTRY` 指向安装版的 `dist/index.js`，运行 `pnpm exec vitest run tests/e2e/workspace-doctor-installed.test.ts tests/e2e/plugin-{execution,http,local}-matrix.test.ts` 可复验。运行日志的 SHA-256 为 `da17bcfc4cb68c6c52118ca5b0fc04d61848b78267df3badaac4935b47538fb9`。

以 `84a4b188` 为基线的 macOS arm64 工作区使用 Node `24.18.0` 和 V8 运行全量测试。首次运行有 9,154 项通过、136 项跳过，知识撤回用例超时，退出码为 1。该用例在 V8 下单独复跑通过。首次运行测得行和语句覆盖率 90.64%、函数 87.17%、分支 88.18%，总体和五个源码包均达到基线门槛。

使用本地未签名的 macOS 桌面包和安装版 CLI `0.2.188` 补验 CI 中跳过的六项。真实 Claude Code `2.1.326` 从桌面设置发起提炼，完成独立校验、发布和撤回。取消和退出均释放执行权，CLI 的 `once` 和 `watch` 占用请求时桌面拒绝重复启动。另一个 CLI 测试验证了 `watch` 信号退出后释放队列并可在重启后继续处理。打包版同时通过两项知识发布与撤回测试。签名和公证仍待验收。

2026-11-21，同一 `0.2.183` 归档经真实 Claude Code `2.1.326` 通过两项受限提炼测试。合成审批样本记录了拒绝自审和独立审批通过的实际断言。一次模型调用得到一个候选，重放没有发起新调用。提示注入、Hook 和 MCP 的三个写入哨兵均未出现。追加 QA 失败事件后，候选进入冲突状态。测试证据来自增加审批断言和阶段诊断后的测试文件。

同一归档以真实 Claude 从独立的合成包裹策略回执生成业务事实 `fact-01`。独立校验器核对规则，CLI 将 `seal-cutoff` 第 2 版发布到隔离 Wiki，知识提供器通过冻结问句召回该发布。随后 OpenCode `2.2.7` 在新受管工单 `github:w11/parcel#43` 中给出正确规则、产品版本 `2.0` 和同一发布出处。测试核对了生产与消费的运行 ID 和原生会话 ID 各不相同。发布回执键为 `91b09ecd2db168eda1b37abc86184d4185c6b8f6ccb483cfed86f2ae06c08ade`。

三个独立 OpenCode 工单补验了 `fact-02` 至 `fact-04`。改写问句召回相同发布，其他项目和旧产品版本均返回空答案，导出的原生会话未包含规则、发布键或 Wiki 来源。两个隔离副本改用正确项目和版本查询后，均可召回该发布。同一发布的四项受管消费测试全部通过。

同提交的 [CI 44804807080](https://github.com/easyhaloo/afk/actions/runs/44804807080) 通过，`source-coverage` 中 `report.json` 的 SHA-256 为 `1e8775c463c28847af3869a54728b5df5902332c6ef2c6ed6937bb62368b0512`。源码覆盖率为行及语句 90.19%、函数 86.99%、分支 88.83%，已通过各包基线。五个包的行覆盖率分别为 Core 97.75%、Application 97.68%、Workflow Graph 99.00%、Runtime 92.89%、CLI 71.49%。覆盖率采集范围为 Vitest worker。Desktop 单独通过类型检查、构建、测试及 107 项 Electron E2E。

macOS arm64 仓库外安装版 `0.2.174` 每 4 秒触发一次验证命令。三种重启场景均通过。分别在交付为 `pending` 时以 `SIGTERM` 或 `SIGKILL` 停止监听器，以及在阻塞动作处于 `processing` 时以 `SIGKILL` 停止监听器。第二个监听器在首个监听器持有队列时被拒绝。停机 8 秒后，新监听器用原交付 ID 重试成功，再等待一个周期接收新事件。停机期间的两个周期跳过，每次队列共两条交付，成功动作各产生一次写入。执行中断发生在写入前，动作随 stdin 关闭而退出。使用 `python3 -B tests/qualification/w10/schedule-restart.py <安装版CLI绝对路径>` 复跑，另加 `--force` 或 `--in-flight` 测试两种强制终止场景。[安装版回执](schedule-restart.receipt.json)

同一安装包以 `--after-effect` 复跑，在观察到外部文件已写入且交付仍为 `processing` 时强杀监听器。重启后原交付 ID 在第二次尝试变为 `delivered`，同一动作已写入两次。下一次正常触发再写入一次，最终两个交付 ID 对应三次写入。该结果核实队列的至少一次派发语义。外部动作若要求只生效一次，需要由接收方用稳定键实现幂等。[安装版回执](schedule-restart.receipt.json) · [队列协议](../../../docs/architecture/plugins.md)

以 `--idempotent` 复跑时，通过 CLI 安装本地动作插件。插件通过 SDK 的 `currentTriggerDeliveryId()` 取交付 ID，并以原子目录创建作为本地副作用。目录可读、交付仍为 `processing` 时强杀监听器。重启后原交付在第二次尝试变为 `delivered`，目录仍只有一个。新触发正常创建第二个目录，两目录名分别匹配两个交付 ID。该场景验证本地接收端去重跨进程重启生效。[安装版回执](schedule-restart.receipt.json)

`0.2.176` 的 macOS arm64 安装包再次通过五个定时恢复场景。新增 `--http-receiver` 场景让动作通过 `Idempotency-Key` 请求头把交付 ID 发送到独立运行的回环 HTTP 接收端。接收端提交第一个副作用后强制停止监听器，当时队列状态为 `processing`。监听器重启后，接收端共收到原 ID 两次、新 ID 一次，两个 ID 各产生一次副作用。目标部署和跨主机链路待验。[HTTP 接收回执](schedule-http-receiver.receipt.json)

同一安装包通过 `--http-receiver-restart`。监听器强制终止后，独立接收进程也以 `SIGKILL` 退出，新进程在原端口使用同一持久目录接收重投。原交付 ID 共到达两次，副作用目录的 inode 和修改时间保持一致。新交付 ID 到达一次并创建新目录。`--http-receiver` 和 `--idempotent` 对照均通过。这次验证覆盖同主机进程故障恢复。[接收端重启回执](schedule-http-receiver-restart.receipt.json)

同一安装包经 Docker 发布端口向 Linux VM 内的接收进程投递。`python3 -B schedule-restart.py <安装版CLI绝对路径> --docker-http-receiver-restart afk-sandbox-base:node22` 复用同一接收逻辑和持久目录，在旧交付已提交副作用且队列仍为 `processing` 时强杀监听器及第一个容器，再在原端口启动不同容器。旧 ID 收到两次且原目录 inode、修改时间保持一致，新 ID 到达一次并创建新目录。两个容器均以退出码 137 停止并移除，同机 `--http-receiver-restart` 对照通过。验证覆盖 macOS 宿主到 Linux VM，独立物理主机和目标部署长时运行待验。[Linux VM 接收端回执](schedule-linux-vm-receiver-restart.receipt.json)

2026-11-21，从 Release CLI 运行 `44769511915` 下载 `da2a8fba` 的 macOS arm64 `0.2.180` 安装包。用 `--http-receiver-restart --ticks-after-restart 48` 强制重启同机监听器和独立 HTTP 接收进程。原交付在第二次尝试成功且副作用只生效一次。48 条新交付各生效一次，首末相隔 188.045 秒。[定时恢复回执](schedule-http-receiver-soak.receipt.json)的 SHA-256 为 `f31f46ea1100c1e9b00eebd586301e007d401e37f627e2f6709177d2ef8d3184`。同包通过 6 个仓库 E2E 文件的 18 项及本地报告和证据包审计，测试源码包含本次静态扫描负载调整。目标部署的跨主机长跑仍待完成。

同一 `0.2.180` 安装包使用 `--docker-http-receiver-restart afk-sandbox-base:node22 --ticks-after-restart 64` 复跑。强制重启监听器及 Linux VM 接收容器后，原交付累计收到两次且副作用生效一次。随后 64 条新交付各生效一次，首末相隔 252.044 秒。总计 66 次 HTTP 请求、65 次副作用，两次接收用的容器均已移除。[Linux VM 连续投递回执](schedule-linux-vm-receiver-soak.receipt.json)的 SHA-256 为 `3c31b547a6d2f78c9decb250c77d50fcfefab23c3753d0469d48abe3aa347dc8`。独立物理主机和目标部署长时运行待验。

2026-11-21，从 Release CLI 运行 `44773404254` 安装提交 `2231a1cb` 的 macOS x64 `0.2.180` 包，SHA-256 为 `fa55a78a5a15d66f397fc4c525366e9fc3a6847be874cd0ca692bd7ca2aa3f09`。在 Apple Silicon 上用 Rosetta 和经校验的 Node `v24.18.0`（`process.arch` 为 `x64`）运行 `--http-receiver-restart --ticks-after-restart 48`。强制重启监听器和独立回环 HTTP 接收进程后，旧交付第二次尝试成功，原副作用保持不变。随后 48 次新交付各生效一次，首末相隔 188.036 秒。总计 50 次 HTTP 请求、49 次副作用。[x64 回执](schedule-darwin-x64-receiver-soak.receipt.json)的 SHA-256 为 `45cb59089c14fae239ebd7702d600719e283cf37427c13273053c40da2de64c0`。独立 Intel 主机及目标部署的长时间运行待验收。

2026-11-21，从 Release CLI 运行 `44773404254` 安装提交 `2231a1cb` 的 Linux arm64 `0.2.180` 包，SHA-256 为 `87a52ec171f350182525c51413c4c1732aca0a924c7d85a514ce36705e579746`。CLI 与独立 HTTP 接收进程均运行在禁用外网的 Docker Desktop Linux VM 容器中，镜像为 `sha256:eb5d9c60d047664130b3c88bb9d3ff77cf809b4a524ee05aa3ac898940332d39`，Node 为 `v22.23.4`。用 `--http-receiver-restart --ticks-after-restart 48` 强制重启监听器和接收进程。原交付在第二次尝试成功，原副作用保持不变。随后 48 次新交付各生效一次，首末相隔 188.114 秒。共 50 次 HTTP 请求、49 次副作用。[Linux arm64 回执](schedule-linux-arm64-receiver-soak.receipt.json)的 SHA-256 为 `64848f6391d5e7a0c897140dd808063945cd28c016f87b764cc18ddb8ccd33f6`。独立主机和目标部署仍待验收。

2026-11-21，使用运行 `44782222425` 的 `f751e430` macOS arm64 `0.2.181` 归档，在 Node `v24.18.0` 下对独立回环接收进程复验同一场景。监听器与接收端均以 SIGKILL 停止后重启，原交付第二次尝试成功，48 条新交付各生效一次，首末相隔 188.019 秒。独立接收端共记录 50 次请求和 49 次副作用。[macOS arm64 回执](schedule-darwin-arm64-181.receipt.json)

2026-11-21，使用 Release CLI `44790689971` 的 `bb78d3a1` Linux x64 `0.2.182` 归档，在隔离的 Docker Desktop Linux VM `linux/amd64` 容器中使用 Node `v22.23.5` 和 Python `3.11.2` 复验。监听器和独立 HTTP 接收进程均以 SIGKILL 停止后重启。接收端收到原交付 ID 两次，原副作用保持不变。48 条新交付各生效一次，首末相隔 188.138 秒。共 50 次 HTTP 请求、49 次副作用。独立主机间的持续投递待验收。[Linux x64 回执](schedule-linux-x64-182.receipt.json)

macOS arm64 安装版 `0.2.176` 经 Docker Desktop Linux VM 中的 Nginx 向 OpenTelemetry Collector 发送 OTLP/HTTP。授权场景收到两次 trace 和四次 metric 的 HTTP 200，Collector 解码了对应工单的 span、事件计数和耗时直方图。错误凭据使同样数量的请求返回 401，Collector 中没有该会话的数据。AFK 审计链保持有效，失败数与入口记录一致，两个场景的超时与丢弃数均为零。

暂停隔离的 Collector 后，`run.requested` 和 `run.finished` 各有一次在途指标操作耗尽共享 5 秒时限。每条事件另有一次指标操作与两次追踪操作在启动前被丢弃。Nginx 只看到两次指标 POST，均记为客户端关闭连接（499）。解除暂停后，新工单的两次 trace 和四次 metric POST 均返回 200，审计计数恢复至正常值。四个场景的本地审计链均有效，两次独立复跑结果一致。目标远端的授权检索和实际负载仍待验。[复跑脚本](otlp-ingress.py) · [入口、超时与恢复回执](otlp-ingress.receipt.json)

2026-11-21，使用 Release CLI `44790689971` 的 macOS arm64 `0.2.182` 安装包（提交 `bb78d3a1`、归档 SHA-256 `a28ec58e8a96babc5e8977d2c12f9e253ef9bad5c365f6172fe23ac50e8854de`）复验四个场景。首次探针在 Nginx 就绪前收到 `RemoteDisconnected`。就绪探针纳入有界重试后，授权和恢复各记录 2 次 trace、4 次 metric 成功，拒绝场景有 6 次 401 且 Collector 未收到该运行的数据，暂停场景有 2 次客户端断开。另一次复跑在首次就绪查询注入同样的断连，第二次查询成功，四个场景通过。两份回执保存在本地验收目录，SHA-256 分别为 `e017f3ceaad6db31a071a668c2b9a272dc43730eab0b66a8fd640fdc051eb5f2` 和 `4814ce9997a904ef2cf553741f5ba63fa941d0b2c7dbf177b81b7f3906533015`。目标远端读回仍待验收。

同一安装包的本地审计重放通过 3 项。两项双仓门禁用例通过 `observe verify` 校验事件链，用 `observe replay --json` 重放，并和原运行视图核对工单、序列及状态。拒绝用例停在 `failed`，两个远端保持原引用。放行用例读回两个远端公布的提交，重放停在 `awaiting_human` 的 `merge:2`，与末事件一致。第三项独立检查核对失败事件绑定的验证证据。场景使用真实 Git 仓库、回环 Tracker 和脚本 Agent。将 `AFK_E2E_CLI_ENTRY` 指向仓库外安装的 `dist/index.js` 后，可运行 `pnpm exec vitest run tests/e2e/repository-verification-{batch,replay}.test.ts` 复验。同一安装包也复验了开发等待人工合并、冲突修复成功及成功复盘预览三个状态。参见 [W07 三套模板](../w07/README.md)。

macOS arm64 仓库外安装版 `0.2.174` 通过 Local Sandbox 启动 OpenCode `2.2.7` 独立进程和私有 server，推理由回环 Ollama 的 Qwen3.5-2B 执行。两个批处理用例的会话 ID、最终结构化输出、正常退出和累计用量均与 OpenCode 原生导出一致。读文件用例返回正确答案 `41`，实际读取两次，未满足一次读取的断言。直接作答用例尝试了被拒绝的 `skill` 调用，答案也未满足固定模板。取消用例在生成出现增量后中断，CLI 和 server 在 Sandbox 关闭前退出，旧句柄返回 `404 SANDBOX_MISSING`。严格批处理为 0/2，取消为 1/1。[复跑脚本](opencode-local-inference.py) · [安装包与结果回执](opencode-local-inference.receipt.json)

macOS arm64 仓库外安装版 `0.2.176` 使用 OpenCode `2.2.7` 与隔离回环 Ollama 的 `qwen3.5:4b`，严格批处理通过 2/2。`--template` 显式禁用模型工具，`--read` 观察到恰好一次成功读取。两项均返回 `41`，原生会话、退出状态及累计用量与 AFK 记录一致。[批处理回执](opencode-batch-176.receipt.json)

同宿主安装版 `0.2.180` 经真实 OpenCode、本地模型、真实双仓 Git 和回环 GitLab Tracker 运行 `issue-implementation`。实施与只读验证使用独立会话配置。首次独立 QA 的原生回复多出一个 JSON 右花括号，严格解析返回 `MISSING_RESULT` 并保留含未发布提交的 QA 工作树。批处理提示加入显式的 JSON 闭合检查后，使用同一驱动和模型复跑，实施、需求核验、独立 QA 均通过，三条会话 ID 与含缓存的用量匹配原生记录。CLI 退出 0，两个工作分支读回预期字节，两个 `main` 保持原提交，审计链有效，运行停在 `awaiting_human` 的 `merge:2`，工作树及 claim 均归零。目标 GitLab 账户和其他宿主待验。[双仓回执](opencode-managed-180.receipt.json)

安装版 0.2.170 在 macOS arm64 上驱动原生 Copilot CLI 和本地 Ollama。首次在 90 秒内未观察到取消前的文本增量。第二次回答 `16 + 22 = 38`，原生会话、输入 13,326 和输出 49 token 均与 AFK 匹配。下一段生成出现文本增量后，AFK 中断执行，进程在 Sandbox 关闭前退出。账号托管推理及完整工单待验。[两版安装包回执](copilot-local-inference.receipt.json)

仓库外安装的 0.2.169 复验了两种 `jms` 的发现结果。SSH 型客户端列出 16 个资产，安装版 `afk host exec --provider jumpserver` 在唯一匹配的 Wiki 资产上运行 `echo`，返回本次随机标记及退出码 0。OpenAPI 型客户端的资产发现返回退出码 1。[安装版回执](jumpserver.receipt.json)

2026-11-20，安装版 0.2.168 通过 `afk host ls --provider jumpserver --json` 列出 16 个资产，各记录均含别名且 provider 为 `jumpserver`。本次仅对该进程调整 `PATH`，选择支持 `config list` 和 `ls` 的 SSH 型 `jms` 0.2.0。默认 `PATH` 中优先选中的 OpenAPI 型 `jms` 0.1.8 拒绝 `config` 命令。遇到该情况，0.2.168 曾返回成功的空列表，0.2.169 返回退出码 1 并提示所需的 CLI 命令。

安装版 0.2.168 通过 `afk run` 在两个共享挂载仓库完成实施、验收检查和 QA，停在人工合并门。另一工单在实施发布后遇到一次 HTTP 409，随后 `afk qa` 使用新租约完成独立 QA。两组均从裸仓读回输出，并核对租约与工作树清理。该场景使用回环 HTTPS、合成 Tracker 和脚本 Agent。跨主机挂载和真实模型 QA 待验。[双仓工单回执](mounted-work-item.receipt.json)

2026-11-20，Cursor CLI `2026.07.09-a3815c0` 的 `cursor-agent status --format json` 返回 `authenticated`。在空白 Git 仓库，安装版 0.2.162 和 0.2.180 均经本地 Sandbox 收到 `NON_ZERO_EXIT`（退出码 1）。0.2.180 复验成功关闭 Sandbox。直接运行原生只读批处理同样以退出码 1 返回 `Authentication required`。`cursor-agent login` 完成后，仍需核对安装版的实际回包和原生会话。[Cursor 复验回执](agent-cursor-180-auth.receipt.json)

2026-11-21，安装版 0.2.188 通过 `verification.provider test-runner verify` 查询 Cursor 原生模型目录。状态命令仍返回 `authenticated`，`cursor-agent models` 返回 `Authentication required`（退出码 1）。未取得模型目录，且未发起模型推理。脱敏回执的 SHA-256 为 `e985cdafd1c687b9b2c1a9e20042dfd20a35603fbc9e562b619f2fda017b7a62`。

Pi 1.5.2 的 `pi auth check --provider anthropic --no-refresh` 返回 `not_ready`。使用 Anthropic 时可通过 `pi auth login anthropic` 配置。

安装版 0.2.168 经 Local Sandbox、Pi 1.5.2 和临时 Ollama 服务运行 Qwen3.5-2B。Pi 正确回答随机算术题，AFK 会话 ID 与 Pi 原生记录一致，输入 513、输出 80、合计 593 token，工具调用为零。加 `--cancel` 可复验流式输出中的取消。同版本 macOS arm64 CI 发行包复验时，Pi 在关闭 Sandbox 前退出，关闭后原句柄返回 `404 SANDBOX_MISSING`。云端 `wiscode-aiproxy` 的独立请求曾返回 HTTP 402。[复跑脚本](pi-local-inference.py) · [推理回执](pi-local-inference.receipt.json) · [取消回执](pi-local-cancel.receipt.json) · [云端回执](agent-pi.receipt.json)

2026-11-20，安装版 0.2.162 通过 `plugin invoke repository.provider special-git-backend run` 驱动独立 Git 命令后端。首次执行因动作查询失败而清理工作树，裸仓库只有 `main`。同一 runId 重试后，裸仓库的 `review` 指向 `9e3aabe46203670a9a56bf61b08e2ac61ce91e92`，读回 `parcel.txt` 的内容为 `ready for review`。基线 `main` 仍指向 `d7e85a8f44cb3bb06a302f3b8c970e37176adeea`，临时工作树已移除。运行 `python3 tests/qualification/w10/special-git-backend.py <安装版 CLI 可执行文件>` 可在独立临时仓库复验。

基于 `e7c9115a` 的仓库外安装包 0.2.167 另经 `afk run` 自动路由至该后端。首次 checkout 失败后，工作树和租约均已释放，两个裸仓库只含 `main`。经 `afk backlog retry` 恢复同一工作项，实施与 QA 分别在两个仓库创建受管工作树。四条发布引用均读回预期文件，两个 `main` 仍指向各自原提交。工作流停在 `awaiting_human` 的 `merge:2`。本次使用独立命令进程和单机回环 Git，Tracker 与 Agent 使用合成夹具。复验时将 `AFK_E2E_CLI_ENTRY` 指向仓库外同版本安装的 `dist/index.js`，运行 `pnpm exec vitest run tests/e2e/repository-managed-command.test.ts`。[安装包摘要与裸仓库读回收据](special-git-workflow.receipt.json)

2026-11-19，安装版 0.2.158 经 `plugin configure` 启用 OTLP，受管工作项在 `not_claimed` 结束。隔离的 Jaeger 2.23.0 内存后端按服务名和 `run_id` 查回一条匹配 trace，span 包含预期的工单 ID。写入前和随机运行 ID 的查询均为空，本地审计链通过（序号 4）。运行 ID 为 `8583cc99-467e-4b73-86ab-ecbe4e994341`。复现命令为 `python3 tests/qualification/w10/jaeger-query.py <安装目录> <jaeger可执行文件>`。此次使用的官方 Darwin arm64 压缩包 SHA-256 为 `ed4f00636e5a909cf8ce3fcdaf26a1ea7977163fe29da8fb5031b37a6a9682c4`。远端部署鉴权、丢弃计数和时间序列指标查询另行验收。

在上述命令末尾追加 Prometheus 可执行文件，即可验证同一运行的指标。Jaeger 将 OTLP 指标转发至启用了增量转累计的 Prometheus 3.5.0。运行 `09581dbd-608a-4bb5-acae-52ed2aca88c6` 的开始请求与结束事件分别产生一次计数和一次耗时采样，按服务名查回 8 个时间序列样本。随机运行 ID 和不存在的服务都返回空结果，AFK 审计中的 trace 与 metrics 投递失败数均为零。该 Prometheus Darwin arm64 压缩包 SHA-256 为 `c17bc2c992f0b5515eebe2b4ccd626214f8e309a0fe6ec40ed13c42ec13d05fb`。

带 Prometheus 的命令还会在正常运行后停止测试 Collector，再执行一次受管任务。运行 `b20cfd94-14d5-41f6-ab05-b4bb8e7e29cc` 的本地审计链有效，`run.requested` 和 `run.finished` 各关联一份失败回执。每份回执记录两次指标投递失败和一次追踪投递失败。独立运行的 Prometheus 查询结果与停机前一致。

另一次对照将 AFK 的 OTLP 地址直接指向 Prometheus 3.5.0。Prometheus 存入指标并返回 HTTP 200 空响应，AFK 要求接收端返回 OTLP JSON 确认。运行 `bf8fd597-8d9c-480b-bbca-5744c8d8fe8d` 的审计因此记录四次指标投递失败。部署时可使用本节验证过的 Collector 转发配置。

Linux 桌面通知的安装验收通过 Docker 将 `notify-send` 的参数原样送入隔离的 X11 桌面。运行器确认 Dunst 显示一条通知、窗口处于可见状态、历史记录中的标题、正文和紧急程度正确。停止该桌面后，CLI 返回失败回执。

2026-11-21，在 macOS 15.2 arm64 上使用本地打包的 CLI `0.2.181` 和隔离配置运行 `plugin invoke notification.provider notification.desktop notify --input message.json --json`。真实 `/usr/bin/osascript` 仅执行一次，退出码为 0，标准错误为空。CLI 退出 0 并返回 `delivered: true`。macOS 横幅或通知中心条目以及 Windows 的原生展示仍待验收。[macOS 调用回执](desktop-notify-darwin.receipt.json)

同日使用 Release CLI `44790689971` 的 macOS arm64 `0.2.182` 安装包复验。CLI 返回 `delivered: true`。主显示器右上角的 14 帧均未匹配本次随机标题与正文，采样结束后检查到桌面锁定。解锁后的展示验收仍开放。[macOS 展示采样回执](desktop-notify-darwin-182.receipt.json)

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

用 `uv run --no-project --with boto3==1.44.7 -- python tests/qualification/w10/object-storage-presigned.py <MinIO 可执行文件> <安装包内 artifacts.js 路径> --cli <安装后的 afk>` 复跑预签名上传。脚本使用 CLI 配置环境引用并发起 PUT，独立读回对象。省略 `--cli` 可单独验证 Runtime URL resolver。

| 引用 | 相对定位 | 核对内容 |
| --- | --- | --- |
| [OIDC] | [脚本说明](oidc-keycloak.md) · [脱敏回执](oidc-keycloak.receipt.json) | 0.2.159 经 Keycloak 交换凭据后上传报告。显式撤销后，报告服务在令牌到期前 15 秒返回 401，随后新交换成功。另有禁用目标客户端以及自然到期的独立用例。 |
| [PUT] | `python3 tests/qualification/w10/object-storage.py release/cli` · [MinIO 脚本](object-storage-presigned.py) · [Runtime 回执](object-storage-presigned.receipt.json) · [CLI 回执](object-storage-presigned-cli.receipt.json) | Apache WebDAV 正常上传在重启后可读，拒绝覆盖后原内容完整。MinIO 上 0.2.180 Runtime 及 0.2.181 本地安装 CLI 均验证有效签名可上传，8 秒后返回 403。CLI 路径还核对输出和本地记录均无签名，独立读回 4,099 字节且摘要一致。 |
| [SMTP] | `email-loopback.py`、`email-receipt.json` | 0.2.148 经 BusyBox sendmail 将测试邮件交给回环 SMTP；收端逐字节核对换行、点转义和信封地址 |
| [ISSUE] | `issue-event.md`、`issue-event.receipt.json` | 本地 Gitea 直送三个签名事件；仅打开事件执行一次，重复投递复用原收据 |
| [G] | `docs/architecture/plugins.zh.md` 的 Gmail OAuth 手工记录 | 2026-11-07 浏览器授权后 CLI 发信、Gmail API 接受、用户确认收到 |
| [T] | `docs/guides/testing.zh.md` 的“插件矩阵与源码覆盖率” | 11-09 安装版 0.2.44 复验刷新、scope、身份与 discovery HTTP 200，发信次数为零。另有真实 Claude、Docker、认证 HTTP/Docker/Claude 和 SSH 的范围 |
| [W] | `docs/superpowers/plans/2026-11-08-runtime-learning-and-validation.zh.md` 的“已安装 CLI”、`plugin-matrix-wiki-claude-20261108-2` 和“真实经验” | GitLab MR !198、人工门、SSH 和已安装 `context.experience` gather |
| [WH] | [Webhook 0.2.190 本机安装版](#webhook-02190-本机安装版) | 动作执行中的并发去重和载荷冲突、正常重启持久化、新 ID 正对照 |
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

## Webhook 0.2.190 本机安装版

2026-11-22，macOS arm64 与 Node 24.18.0 上的离线安装版通过 `plugin configure`、`plugin listen --host 127.0.0.1 --port 0 --queue <队列路径>` 和 `plugin deliveries` 验证真实的 SQLite 队列。首次动作进程仍在运行时，两个本机发送进程重投同一 `Idempotency-Key`，均返回 `202`、同一交付 ID、`duplicate=true`、`processing` 和 `attempts=1`。同一键携带不同的已签名载荷时返回 `409`。正常重启后读回原 `delivered` 记录，重投仍为 `attempts=1`。相同载荷换新键后产生另一条 `delivered` 记录。动作日志和父进程 PID 对应两个监听器，每个监听器各启动一次动作，并以 `0` 退出。

独立核对使用现有报告、脚本、回执、发行包及监听器和队列源码。证据等级为 `native`。分别待验托管发送方所用的原生交付 ID 与重投、实际服务的动作写回与读回，以及异常中止后的副作用恢复。本机动作由 `verification.test-runner` 执行 Python 进程。

将 `W10_EVIDENCE_DIR` 设为保留 `TEST-REPORT.md`、`replay.py` 和 `receipt.json` 的目录，`W10_RELEASE_DIR` 设为包含 `install.sh`、`afk-darwin-arm64.tar.gz` 及其 `.sha256` 文件的离线发行目录，`W10_NODE_BIN` 设为 Node 24.18.0 可执行文件的路径。归档 SHA-256 为 `81e09097fec807a315cdac7fd430beb4593673e5c30b95ee18207a988d95105a`，回执 SHA-256 为 `e4af2d20c959c0842f8349383e3bc10894308b1ee1ab9819483842b829b906b2`。

```sh
python3 "${W10_EVIDENCE_DIR:?}/replay.py" "${W10_RELEASE_DIR:?}" "${W10_NODE_BIN:?}"
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
