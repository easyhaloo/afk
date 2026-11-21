# W10 安装版浏览器发布门禁

在仓库根目录运行。需要支持直接导入 `.ts` 的 Node（实测 24.18）、Git、已安装 AFK 的启动器、本地 Playwright test 包目录和可执行的 Chromium。验收读取安装包的 `release.json`，并使用同一安装包的证据读取器核验 `afk observe` 返回的证据摘要。

```sh
node tests/qualification/w10/browser-publish.mjs \
  "$AFK_LAUNCHER" "$PLAYWRIGHT_TEST_DIR" "$CHROMIUM_EXECUTABLE" > browser-publish-run.json
```

两次 `afk run --template issue-implementation` 各使用独立临时用户目录。仓库的多仓夹具提供合成 agent、回环 GitLab tracker 和两个通过 Git HTTP 访问的裸仓。临时 Git 钩子在合成 agent 提交 `shared.txt` 时加入候选页面。两组 HTML 相同，CSS 的 `display` 分别为 `none` 和 `block`。仓库内已有的浏览器用例在离线上下文点击按钮，读取文字、可见性和宽度。探针核对工作副本与 HEAD 的文件摘要，并检查 Chromium 进程正常退出。

脚本从初始化推送结束后开始计数。隐藏页须在 `before-publish` 返回失败，两个远端仅保留初始 `main`，Git 接收请求和 MR 创建请求均为零。修复页须通过门禁并进入人工合并状态。脚本从每个裸仓读回实现与 QA 分支，对照 `before-publish` 的提交和页面 blob。每条验证均检查产品执行回执 `closed`、退出码及审计完整性。

标准输出只在两组断言全部通过后写入脱敏 JSON。回执中的提交和证据摘要随运行变化。临时账号配置、原始事件、加密证据与截图随临时目录清理。

2026 年 11 月 20 日从 `8939b763` 构建的 macOS arm64 CLI 0.2.173 通过两组浏览器检查。隐藏页产生零次推送和零次 MR 请求，修复页产生四次推送请求和一次 MR 请求，停在人工合并门。安装包 SHA-256 为 `3b02351e8ae78ab22ec02a9d3ed1304afa8a405e0b3103838142d4b089c8a0d4`。同一安装包也通过仓库验证与策略发布门禁的全部八个用例。
