# AFK Control Electron

独立于 AFK 根项目的 macOS Electron 客户端。主进程只向渲染器暴露经过验证的本地 API：AFK CLI 诊断、`.afk/runs` JSONL 事件、Docker/Podman 容器、tmux 会话，以及系统 OpenSSH 主机管理和内置 SSH 终端。

```bash
cd desktop-client
pnpm install
pnpm dev
pnpm start
pnpm package:mac
```

`pnpm start` 是幂等的开发服务入口：重复执行时会复用已运行的 `5174` 服务，不会创建重复的 Vite、watch 或 Electron 实例。Electron 主进程同时启用单实例锁，重复打开只会聚焦已有窗口。

默认工作区为开发环境中 Electron 客户端的父目录；也可以在界面内选择任意 AFK 工作区。客户端不会将渲染器提供的任意字符串直接交给 shell 执行。

## SSH 主机管理

SSH 主机位于一级导航“SSH 主机”中。客户端读取用户的 `~/.ssh/config`，AFK 新增或修改的主机写入 `~/.ssh/afk_hosts`，并只在主配置中维护一条 `Include ~/.ssh/afk_hosts`。系统主机默认只读，AFK 主机可以删除。

首次连接前，客户端扫描并展示主机的 SHA256 指纹；用户必须通过可信渠道核对后才可以信任。已知指纹发生变化时，连接、免密测试和公钥部署都会被阻止，不会自动覆盖 `known_hosts`。

“生成 AFK 密钥”会在内置终端中调用系统 `ssh-keygen` 创建 `~/.ssh/id_ed25519_afk`。公钥部署使用 SSH 终端完成，密码或密钥口令直接进入 OpenSSH；AFK 不保存私钥、密码、口令、终端输入或完整终端输出。远程主机的工作区和 Runtime 执行尚未在一期实现。
