# W10 逐实现验收矩阵 · 2026-11-19

`matrix.tsv` 沿用 11 月 13 日交付审计的 55 个行名和顺序。`implementation_src` 和 `wiring` 定位实现与产品调用路径。`contract_suite` 指向契约测试，`fixture_or_local` 说明测试实际驱动的对象。`audit_cases` 对应历史安装版用例，`config_inputs` 是当时的配置字段提示。`independent_or_account` 记录可观察的效果或待验对象，`gap_next` 给出逐行补验步骤。

| 证据等级 | 行数 | 判定依据 |
| --- | ---: | --- |
| `account` | 4 | 有真实账户侧操作或用户收件记录，范围见该行 |
| `service` | 12 | 有独立工具进程、引擎、接收服务或远端主机的回执，含[知识库](knowledge-base-meili.md)和[OAuth 客户端授权](oauth/README.md) |
| `native` | 12 | 产品实际驱动本机进程、Git、时钟、事件文件或[隔离钥匙串](system-keychain.md)，可核对效果 |
| `local` | 10 | 本地实现的文件、规则、映射或检索断言通过 |
| `partial` | 1 | 有关联的真实操作，仍缺本行目标入口的直接回执 |
| `fixture` | 16 | 证据止于替身、合成输入或模拟服务，目标集成待验 |

隔离工作树基线为 `29a25e0b5f1a5c1e5a6536d073f3c2544c116f39`。`packages/runtime/src/application/plugins/configured.ts` 中 `configuredPluginManifests()` 返回 52 个配置 ID。扣除另一专题的 `learning.distiller` 后，W10 有 50 行各用一个 ID，两行 OTLP 共用 `observability.otlp`，三行是内建日志、事件及 Evidence 路由。共享的清单发现、依赖安装、doctor、启停、取消、卸载和升级恢复按各自收据判定。原审计 `commonLifecycle` 记录了安装失败与版本回滚的适用范围。

## 核对行清单与历史用例

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
