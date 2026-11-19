# W10 原生 Cursor 安装版验收

2026-11-19 在 macOS arm64 测试了 AFK 0.2.156 和 PATH 中的 `cursor-agent 2026.07.09-a3815c0`。安装目录、`release.json` 与 `afk --version` 相符。验收代码基于 `feat/session-distillation` 的 `f6174b1b`。[脱敏收据](agent-cursor.receipt.json)

| 检查项 | 实测结果 |
| --- | --- |
| 宿主认证 | CLI 支持 `status --format json`，退出 0，`isAuthenticated=true`。 |
| 原生 batch 对照 | 在临时目录通过 stdin 发送算术题，`cursor-agent --print --output-format stream-json` 返回 `Authentication required`，退出 1。 |
| 安装版 AFK | `WorkflowRunner → agent.cursor → sandbox.local` 在合成 Git 项目中启动一次原生 CLI。argv 与原生对照一致，工作目录匹配。原生进程退出 1，工单进入 `blocked`。 |
| 会话、输入与输出 | 两条路径均未观察到 `init` 或 `result`。能证实调用方发送了输入，模型接收输入、计算结果以及原生会话与 AFK 事件匹配仍待验。 |

两次调用均使用 Cursor CLI 的默认模型选择。认证错误发生在产生可核对的模型结果之前。证据等级为原生进程和失败路径 `native`，成功用例 `passed=false`。

## 复跑

需要 Node 22.16 以上、Git、PATH 中的 `cursor-agent` 和已安装的 AFK 0.2.156。`AFK_BIN` 指向该版本的安装器链接或版本目录的 `dist/index.js`。从本工作树运行以下命令。

```sh
out=$(mktemp -d)
node tests/qualification/w10/agent-cursor.mjs "$AFK_BIN" "$out/receipt.json"
```

脚本只用 `status` 检查现有身份，读取布尔值。已认证时会发起两次独立的合成任务，可能消耗账户额度。原生对照和 AFK 各用一个新目录。`afk run` 的工单来自配置的 provider，验收改从同一安装包加载 `WorkflowRunner`，注入合成工单与本地分支适配器。脚本观察真实子进程的输出和关闭事件，只保存白名单字段。原始输出、身份信息及会话 ID 均不写入收据。

退出 0 要求两次均返回正确的随机和、原生会话相符且进程退出 0，AFK 还须持久化同一会话并进入 `verification`。退出 1 时查看收据中的阶段和诊断标记。本次退出 1。
