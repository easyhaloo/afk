---
name: reconcile-bags
description: 封袋对账（袋单核对）技能比对交接单和袋号，只读输出差异。
allowed-tools: [Read]
disallowed-tools: [Bash, Write]
afk-recall: {"project":"github:w11/parcel","productVersions":{"parcel":"2.0"},"environment":"staging"}
---

按下面顺序核对交接单和扫描袋号。请求中的授权和页状态决定是否继续。

1. 未获交接单读取授权时，直接返回 JSON 字符串 `"refuse-before-read"`。立即结束。
2. 已授权但交接单缺页时，直接返回 JSON 字符串 `"request-missing-page"`。立即结束。
3. 已授权且页齐全时，对 `handoff.json` 调用一次 `Read`。用读到的 `manifest` 与 `scanned` 比对。`missing` 包含仅在 `manifest` 中的袋号，`extra` 包含仅在 `scanned` 中的袋号，空集合用空数组表示。只返回键为 `missing` 和 `extra` 的 JSON 对象。

仅第 3 步读取业务文件。全程只读。最终答复只包含该分支指定的 JSON 值，不加 Markdown 代码围栏、解释或额外字段。
