# W10 逐实现验收矩阵 · 2026-11-19

`matrix.tsv` 沿用 11 月 13 日交付审计的 55 个行名和顺序。`implementation_src` 和 `wiring` 定位实现与产品调用路径。`contract_suite` 指向契约测试，`fixture_or_local` 说明测试实际驱动的对象。`audit_cases` 对应历史安装版用例，`config_inputs` 是当时的配置字段提示。`independent_or_account` 记录可观察的效果或待验对象，`gap_next` 给出逐行补验步骤。

| 证据等级 | 行数 | 判定依据 |
| --- | ---: | --- |
| `account` | 4 | 有真实账户侧操作或用户收件记录，范围见该行 |
| `service` | 6 | 有独立工具进程、引擎、接收服务或远端主机的回执 |
| `native` | 8 | 产品实际驱动本机进程、Git、时钟或事件文件，可核对效果 |
| `local` | 10 | 本地实现的文件、规则、映射或检索断言通过 |
| `partial` | 2 | 有关联的真实操作，仍缺本行目标入口的直接回执 |
| `fixture` | 25 | 证据止于替身、合成输入或模拟服务，目标集成待验 |

隔离工作树基线为 `29a25e0b5f1a5c1e5a6536d073f3c2544c116f39`。`packages/runtime/src/application/plugins/configured.ts` 中 `configuredPluginManifests()` 返回 52 个配置 ID。扣除另一专题的 `learning.distiller` 后，W10 有 50 行各用一个 ID，两行 OTLP 共用 `observability.otlp`，三行是内建日志、事件及 Evidence 路由。共享的清单发现、依赖安装、doctor、启停、取消、卸载和升级恢复按各自收据判定。原审计 `commonLifecycle` 记录了安装失败与版本回滚的适用范围。

## 核对行清单与历史用例

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
| [G] | `docs/architecture/plugins.zh.md` 的 Gmail OAuth 手工记录 | 2026-11-07 浏览器授权后 CLI 发信、Gmail API 接受、用户确认收到 |
| [T] | `docs/guides/testing.zh.md` 的“插件矩阵与源码覆盖率” | 11-09 安装版 0.2.44 复验刷新、scope、身份与 discovery HTTP 200，发信次数为零。另有真实 Claude、Docker、认证 HTTP/Docker/Claude 和 SSH 的范围 |
| [W] | `docs/superpowers/plans/2026-11-08-runtime-learning-and-validation.zh.md` 的“已安装 CLI”、`plugin-matrix-wiki-claude-20261108-2` 和“真实经验” | GitLab MR !198、人工门、SSH 和已安装 `context.experience` gather |
| [GH] | `docs/architecture/full-workflow-e2e-architecture.md` 的“GitHub 侧的附件 release” | 附件 HTTP 状态及字节，issue 操作待验 |
| [S] | `../../w11-skill01-consumer/plugin-architecture/.codex/validation/skill-01/REPORT.md` 及同目录 `consumer-4/{workflow,session,scored}.json` | OpenCode 独立进程、历史 edition 2、宿主评分。新候选有单独的门禁记录 |
| [P] | `$O/docs/superpowers/plans/2026-11-09-session-distillation.zh.md` 的“安装版与真实复用” | #704 的误差由 4 mm 降至 0 mm，因受测与发布提交不同，产品拒绝显式采纳 |
| [R] | `$O/.codex/validation/request-lifecycle-20261118/release-142.saPyl47d/{installed.log,batch-gate-rerun.log}` | 0.2.142 的 6 + 2 项覆盖真 Git、回环 Git HTTP、替身 Agent、双仓门禁和挂载工作区。见 `$O/tests/e2e/repository-{managed-local,managed-remote,verification-hook,verification-batch}.test.ts` |
| [RC] | `$O/.codex/validation/remote-container-installed-20261118/attempt-zzvkne/events.ndjson` 的 `verdict` | 安装服务通过回环调用真实 Docker，最终 PASS，跨物理机部署待验 |
| [O] | [P] 同文“W10 真实本地 OTLP Collector” | 0.2.118 的 `collector-smoke-14750` 由官方 Collector 0.164.0 解码 span、Sum、Histogram，受管任务标记为 `not_claimed` |
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
