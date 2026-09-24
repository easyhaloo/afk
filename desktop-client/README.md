# AFK Control Electron

独立于 AFK 根项目的 macOS Electron 客户端。主进程只向渲染器暴露经过验证的本地 API：AFK CLI 诊断、`.afk/runs` JSONL 事件、Docker/Podman 容器、tmux 会话，以及系统 OpenSSH 主机管理和内置 SSH 终端。

```bash
cd desktop-client
pnpm install
pnpm dev
pnpm start
pnpm package:mac
```

`pnpm dev` 会在前台运行 Vite、主进程 watch 和 Electron，终端退出时同步停止整套开发进程。`pnpm start` 是后台幂等入口：重复执行时会复用已运行的 `5174` 服务，不会创建重复的 Vite、watch 或 Electron 实例。Electron 主进程同时启用单实例锁，重复打开只会聚焦已有窗口。

默认工作区为开发环境中 Electron 客户端的父目录；也可以在界面内选择任意 AFK 工作区。客户端不会将渲染器提供的任意字符串直接交给 shell 执行。

## SSH 主机管理

SSH 主机位于一级导航“SSH 主机”中。客户端读取用户的 `~/.ssh/config`，AFK 新增或修改的主机写入 `~/.ssh/afk_hosts`，并只在主配置中维护一条 `Include ~/.ssh/afk_hosts`。系统主机默认只读，AFK 主机可以删除。

首次连接前，客户端扫描并展示主机的 SHA256 指纹；用户必须通过可信渠道核对后才可以信任。已知指纹发生变化时，连接、免密测试和公钥部署都会被阻止，不会自动覆盖 `known_hosts`。

“生成 AFK 密钥”会在内置终端中调用系统 `ssh-keygen` 创建 `~/.ssh/id_ed25519_afk`。公钥部署使用 SSH 终端完成，密码或密钥口令直接进入 OpenSSH；AFK 不保存私钥、密码、口令、终端输入或完整终端输出。主机详情中的“快速上传”使用系统文件选择器，通过参数化 `scp` 上传到主机配置的远程工作目录，未配置时使用远程主目录。Runtime 执行尚未在一期实现。

## 全局工作项本地模型

全局工作项列表在 Electron 主进程中维护一份本地快照，存放于 `app.getPath("userData")/work-item-inventory.json`。页面优先读取已校验的本地快照；无快照时才等待 GitHub/GitLab 远程 inventory。快照超过 5 分钟后，页面先返回旧数据，再由后台异步同步；应用启动时也会启动一次同步，并每 5 分钟执行一次。快照写入采用临时文件替换，远程失败或快照损坏不会阻断页面加载，手动刷新仍会强制访问远程数据源。

工作项执行可从关联资源中选择代码仓库，并分别指定 Base 分支；单次启动在 `~/.loop-workspace/<工作项 ID>/` 下创建一份 manifest 和一个 AFK 运行。运行记录保存在任务空间的 `.afk/work-item-runs.json`，列表会合并本地历史；打开运行记录时，活跃运行会定时刷新。开发环境优先使用仓库根目录 `dist/index.js`（先运行 `pnpm build`）；打包客户端需要在 PATH 中安装支持 `afk run --execution-manifest` 的 CLI，或通过绝对路径 `AFK_DESKTOP_CLI` 指定它。不兼容的 CLI 会在启动前报错，而不会静默忽略多仓库配置。
