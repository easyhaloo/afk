# AFK Control Electron

独立于 AFK 根项目的 macOS Electron 客户端。主进程只向渲染器暴露经过验证的本地 API：AFK CLI 诊断、`.afk/runs` JSONL 事件、Docker/Podman 容器、tmux 会话与一行确认后的 tmux 输入。

```bash
cd desktop-client
pnpm install
pnpm dev
pnpm package:mac
```

默认工作区为开发环境中 Electron 客户端的父目录；也可以在界面内选择任意 AFK 工作区。客户端不会将渲染器提供的任意字符串直接交给 shell 执行。
