# W10 原生 Pi 安装版验收

2026-11-19 在 macOS arm64 从 `feat/session-distillation` 的 `ccd7b06a5fbd3611ee9886bfcdd93c8f8759aeaf` 构建并校验安装 AFK 0.2.150。安装包内的 `WorkflowRunner` 通过 `agent.pi` 和 `sandbox.local` 启动 PATH 上的 Pi 1.5.2。每次运行使用新的 HOME、Pi 会话目录及合成 Git 项目。工单与分支使用本地适配器。安装版 `afk run` 没有注入合成工单的参数，因此脚本直接使用安装包的 Runner 和产品事件存储。完整实测数据见[脱敏收据](agent-pi-0.2.150.receipt.json)。

| 场景 | 实测结果 | 证据范围 |
| --- | --- | --- |
| 允许的默认模型 | Pi 会话含 `402` 错误标记，产品记录 `upstream_model_error`。本次账号侧成功验收受阻。 | 原生错误路径 |
| 回环模型成功 | Pi 实际调用 `read`、`write` 处理随机输入，宿主核对结果为 6396。产品持久化 `implementation.completed`，工单进入 `verification`。 | `native` |
| 原生 session 和 usage | 唯一 Pi JSONL 文件的会话 ID 与同一运行的 `agent.session_recorded` 一致，原生 cwd 与工作目录一致。三轮 assistant 记录合计输入 93、输出 21、总计 114，产品三项相符。 | Pi 与 AFK 为 `native`，模型和 token 数值来源为 `fixture` |
| 活跃任务取消 | Pi 的 shell 工具启动 8 秒延迟写后，调用方发出 abort。观察 9 秒，原生子进程已退出，延迟文件未出现，工单 `blocked` 且未入 QA。产品终态为 `failed`，分类 `workflow_crash`，因此要求 `cancelled` 的断言返回失败。 | `native`，进程清理通过，终态分类失败 |

本次选择取消作为生命周期用例。Resume、交互模式、真实模型账单、远端工单及其他平台留待单独验收。回环服务只绑定 `127.0.0.1` 的随机端口，以固定 SSE 响应提供工具调用和用量。Pi 进程、工具执行、会话文件、产品事件及取消均走实际路径。

## 0.2.152 安装版对照

2026-11-19 在同一平台使用父工作树已安装的 0.2.152 和 Pi 1.5.2 复跑。两版均通过产品 `WorkflowRunner` 在合成 Git 项目中运行原生 Pi，模型来源均为 `isolated-loopback-fixture`。进程、会话和产品事件的证据等级为 `native`，模型响应和用量数值来源为 `fixture`。详见 [0.2.152 脱敏收据](agent-pi-0.2.152.receipt.json)。

| `agent.pi` 场景 | 0.2.150 基线 | 0.2.152 实测 |
| --- | --- | --- |
| 成功、session、usage | 通过，随机输入求和 6396 | 通过（退出码 0），随机输入求和 1497 与产物一致，记录 `implementation.completed`，进入 `verification`。两版均匹配原生 session，3 轮输入 93、输出 21、总计 114，产品与 Pi 一致。 |
| 活跃任务取消 | 失败，终态 `failed`，分类 `workflow_crash` | 通过（退出码 0），`run.finished` 记录 `cancelled` 和 `user_cancelled`，无 `failure.classified`。两版均在命令启动后取消，原生进程退出，9 秒后无延迟写，工单 `blocked`，未入 QA。 |

## 0.2.190 安装版复跑

2026-11-22 在 macOS arm64 从 `0c0bbd77fe4ee7ffbeb1ae0f9b88c9fe7ee067b1` 打包，校验归档并在隔离目录安装 AFK 0.2.190。首次打包在 `tar` 初始化本机 locale 时失败，使用 `LC_ALL=C` 复跑后通过安装和 23 个 CLI 入口检查。

原生 Pi 1.5.2 的成功和取消用例均以退出码 0 完成。成功用例验证产物、会话关联、用量和 QA 入队。取消用例记录 `cancelled` 和 `user_cancelled`，原生进程退出，未出现延迟写，工单保持 `blocked`。模型使用隔离回环夹具，真实模型账号成功用例仍待验收。详见 [0.2.190 脱敏收据](agent-pi-0.2.190.receipt.json)。

## 复跑命令

从上述基线的仓库根目录执行，需要项目支持的 Node ≥22.16、pnpm、Python 3、Git、`ps` 和已安装的原生 `pi`。已有对应安装包时可直接将 `AFK_BIN` 指向安装器创建的可执行文件。首次构建及安装使用以下命令。

```sh
out=$(mktemp -d)
pnpm --filter 'afk...' install --frozen-lockfile
pnpm release:cli --output "$out/archive"
archive=$(find "$out/archive" -name 'afk-*.tar.gz')
AFK_HOME="$out/profile/.afk" bash install.sh --version 0.2.150 --skip-completion \
  --prefix "$out/bin" --archive "$archive" --checksum "$archive.sha256"
AFK_BIN="$out/bin/afk"
```

```sh
receipts=$(mktemp -d)
python3 tests/qualification/w10/agent-pi.py "$AFK_BIN" success "$receipts/success.json"
python3 tests/qualification/w10/agent-pi.py "$AFK_BIN" cancel "$receipts/cancel.json"
```

复跑其他版本时，安装对应版本并更新 `AFK_BIN`，新建收据目录，在两条命令末尾各加 `--expected-version <version>`。启动器核对目录名、`release.json` 和 CLI 实报版本。

两条命令独立运行，收据必须使用新文件名。退出码 0 表示该用例全部断言通过。0.2.150 的回环结果分别为 0 和 1，0.2.152 和 0.2.190 均为 0 和 0。配置模型也可单独复跑，在 `success` 命令末尾追加 `--model-dir "$APPROVED_PI_MODEL_DIR"` 并更换收据文件名。该选项使用指定目录里 `settings.json` 选中的默认 provider 和 model，以及 `models.json` 的简单 API key 配置，可能消耗模型额度。默认回环模式无需账号。启动器使用进程环境传递配置模型的密钥，临时目录在运行结束后删除。收据仅保留断言、计数、版本及归档校验值。
