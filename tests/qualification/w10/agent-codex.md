# W10 agent.codex 本机资格验收

本次使用 AFK 0.2.148、codex-cli 0.169.0 和 macOS arm64。验收入口为安装包的 `prepareAgentRuntime`、`WorkflowRunner` 和 `QARunner.process`。内建 Codex provider 启动 PATH 上的真实 `codex`。工单状态、分支及变更请求由本地适配器承接。QA 读取已提交产物的独立 Git worktree。每个场景使用新的临时主目录、线程目录和项目。

## 复跑

从仓库根目录执行。设置 `RELEASE` 为含 `release.json` 和 `node_modules/@afk/runtime` 的已安装目录。运行环境需要 Git、Python 3.11+、Node 22+ 和已配置的 Codex Responses API provider。启动器支持该 provider 的 `env_key` 或 `experimental_bearer_token`。认证值只通过进程环境传递。场景使用真实模型配额。

```sh
umask 077
out=$(mktemp -d)
for scenario in exec app-server qa failure cancel; do
  python3 tests/qualification/w10/agent-codex.py "$RELEASE" "$out/$scenario.json" "$scenario" || exit 1
done
```

每次使用新的收据文件名。Python 的退出状态和 JSON 的 `passed` 共同反映该用例断言。负向用例通过表示预定边界被观测到。保留失败收据后可单独复跑。原始模型输出及线程内容随临时目录删除。

| 用例 | 验收依据 |
| --- | --- |
| `exec`、`app-server` | 宿主独立计算随机输入之和，核对 `total.txt`、产品成功、`verification`、原生线程 ID 和正数用量。产品总用量必须等于对应线程最后一次有效的原生累计用量。 |
| `qa` | 先经 `app-server` 实现，再由 `QARunner` 启动第二个 Codex 线程。核对两个不同的线程、QA 成功、同工单持久事件 `qa.passed` 和 `merge_ready`。发布适配器只在进程内返回本地变更标识。 |
| `failure` | readiness 成功后撤去子进程的测试认证，检查有会话标识、产品报告 `agent_process_failed`、工单 `blocked`、无产物、未入 QA，并记录实际运行终态。该分类仅能定位至 agent 进程。 |
| `cancel` | 原生任务创建 `started` 后才发 abort，核对拒绝原因、终态事件、`blocked` 和未入 QA。任务计划在 12 秒后创建 `late`，产品退出后再观察 13 秒。 |

首次探测的配置目录与用量采集路径不同，后续已统一至临时 `HOME/.codex`。一次 `exec` 生成文件后工单仍被阻塞，另一次成功执行的产品和原生用量不同。`cancel` 实测运行终态为 `failed`，分类为 `workflow_crash`。收据中的 `passed` 仅覆盖上表断言。

0.2.150 的 macOS arm64 安装包已在新临时项目重跑 `exec`。工单进入 `verification`，计算结果正确，同一原生线程和产品均记录 70,560 tokens。

0.2.151 的安装回归从工单的持久审计读取事件，并校验审计链。`cancel` 要求恰好一个 `cancelled` 终态、`user_cancelled` 原因码和调用方原因原文。`failure` 要求恰好一个 `failed` 终态并保留 `agent_process_failed` 根因。两个场景都要求工单进入 `blocked` 且无 `qa.started`。正常 `qa` 场景继续验证独立原生线程、`qa.passed` 和 `merge_ready`。
父工作树以 macOS arm64 安装包 `0.2.152` 重跑了 `cancel`、`failure` 和 `qa`。取消后只有一个 `cancelled/user_cancelled` 终态，原因为调用方传入的消息，随后 13 秒未出现延迟写入。撤去认证时终态为 `failed/agent_process_failed`。两个工单均停在 `blocked`。正常任务由独立 Codex 会话记录 `qa.passed`，工单进入 `merge_ready`。
