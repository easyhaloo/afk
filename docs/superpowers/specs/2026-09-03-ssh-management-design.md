# AFK SSH 管理设计

日期：2026-09-03

状态：已确认设计，待实现计划

## 1. 背景与目标

AFK 当前体系缺少统一的 SSH 主机管理能力。用户需要在系统终端中手工维护主机、密钥、公钥部署和首次连接信任，随后才能进入远程机器执行操作。

本设计为 AFK Desktop 增加 macOS 首期 SSH 管理能力，使用户能够：

- 查看现有 SSH 主机并区分系统配置与 AFK 管理配置。
- 在 AFK 中添加主机并写入 AFK 专属 SSH Include 文件。
- 通过系统 OpenSSH 生成、加载和部署共用的 Ed25519 公钥。
- 查看并人工确认主机 SHA256 指纹。
- 在 AFK 内置终端中进行免密测试和交互式 SSH 登录。

本期不实现远程任务执行；远程 Runtime 作为二期扩展，复用本期主机和信任模型。

## 2. 已确认决策

### 2.1 范围

- 一期包含连接管理、免密配置、连接测试和内置终端登录。
- 二期将 SSH 主机接入 AFK Runtime，使任务、Agent 和 Workflow 可以选择远程执行目标。
- 一期只支持 macOS；接口和模块边界按跨平台扩展设计。
- 二期首个远程 Runtime 版本使用远程已有工作区，不自动上传或同步本地代码。

### 2.2 凭据策略

采用系统 SSH 优先策略：

- 复用 `~/.ssh/config`、由 `SSH_AUTH_SOCK` 指向的 `ssh-agent`、macOS 钥匙串和 `known_hosts`。
- AFK 不读取、复制、持久化或打印私钥、私钥口令、远程密码和完整公钥内容。
- AFK 默认使用 `~/.ssh/id_ed25519_afk` 作为共用 Ed25519 密钥路径；单台主机可选择已有密钥路径。
- 密钥生成、加载和首次公钥部署由系统 OpenSSH 命令完成，口令输入发生在受控内置终端中。

### 2.3 配置来源

- 系统 SSH 配置来自用户的 `~/.ssh/config` 及其可解析的 Include。
- AFK 管理的配置写入 `~/.ssh/afk_hosts`。
- AFK 只在 `~/.ssh/config` 中维护一条指向 `~/.ssh/afk_hosts` 的 Include，不重写用户的其他配置。
- `~/.ssh/config` 和 `~/.ssh/afk_hosts` 写入前备份，写入使用临时文件加原子替换，并校验 Unix 权限。
- 系统 Host 默认只读；AFK Host 可编辑和删除。

### 2.4 入口与终端

- SSH 主机作为 AFK Desktop 的一级导航，与 Agent、容器等能力并列。
- SSH 会话在 AFK 现有内置终端面板中打开。
- 正式登录和交互式部署使用独立 PTY 启动 `/usr/bin/ssh` 等系统命令，不经过未经验证的 Shell 字符串拼接。

### 2.5 主机身份

- 首次连接使用 `ssh-keyscan` 获取候选主机公钥，并使用 `ssh-keygen -lf - -E sha256` 计算指纹。
- 用户必须通过可信渠道人工核对后，才能信任并写入 `known_hosts`。
- 指纹变化时阻断测试、公钥部署和连接；不提供静默覆盖。
- 清除旧指纹、重新扫描和再次信任均需要用户明确操作。

## 3. 架构

### 3.1 Desktop 分层

遵循 AFK Desktop 的 Electron 架构约束：

- `electron/main.ts` 只负责启动 Electron、组装依赖和注册模块。
- `electron/services/ssh-service.ts` 负责编排 SSH 用例和状态聚合，不直接承载所有 I/O。
- `electron/adapters/` 提供独立适配器：
  - OpenSSH 命令适配器：封装 `ssh`、`ssh-keygen`、`ssh-keyscan`、`ssh-add` 和可用时的 `ssh-copy-id`。
  - SSH 配置适配器：读取、归一化和安全更新配置文件及 Include。
  - `known_hosts` 适配器：查询、添加和移除主机密钥记录。
  - PTY 适配器：管理交互式进程的输入、输出、退出和终止。
- `electron/ipc/` 暴露固定白名单：查询主机、添加/编辑/删除 AFK 主机、扫描指纹、确认信任、生成密钥、部署公钥、测试连接、打开会话和关闭会话。
- `electron/security/` 负责发送方校验、参数校验和路径约束。
- `shared/` 定义跨进程 DTO 与错误类型，不依赖 Electron、Node、React、DOM、YAML 或文件系统。
- `src/` 仅负责 React 展示和用户交互，通过 preload 暴露的类型化 API 调用主进程。

### 3.2 数据流

```text
React SSH 页面
    │ typed preload API
    ▼
IPC handlers ── sender/origin + argument validation
    │
    ▼
SSH service ── use-case orchestration and state derivation
    │
    ├── OpenSSH adapter ── ssh / ssh-keygen / ssh-keyscan / ssh-add
    ├── config adapter ── ~/.ssh/config + ~/.ssh/afk_hosts
    ├── known-hosts adapter ── ~/.ssh/known_hosts
    └── PTY adapter ── interactive terminal session
```

所有外部命令使用参数数组和受限环境启动。服务层不得把用户输入拼成 Shell 命令，也不得把命令原始输出直接写入持久化日志。

## 4. 数据模型

### 4.1 主机 DTO

```ts
interface SshHost {
  id: string;
  alias: string;
  hostname: string;
  port: number;
  user?: string;
  identityFile?: string;
  proxyJump?: string;
  source: "system" | "managed";
  configPath: string;
  status:
    | "ready"
    | "untrusted"
    | "key-missing"
    | "unreachable"
    | "auth-required"
    | "identity-changed"
    | "invalid";
  remoteWorkspace?: string;
}
```

`id` 是稳定引用，不直接依赖显示名称。主机的最终连接参数以 OpenSSH 的 `ssh -G <alias>` 结果为准，AFK 不自行完整模拟 OpenSSH 的配置合并语义。

### 4.2 诊断与审计

诊断 DTO 包含稳定的诊断代码、严重级别、用户可读消息、来源路径和可选的安全建议；不包含密码、口令、私钥、公钥正文、终端输入或未经脱敏的命令输出。

审计事件只保存：操作类型、主机稳定 ID、来源、开始/结束时间、结果代码和必要的错误分类。SSH 原始输出只在内存中用于当前操作，不进入日志文件或本地配置。

### 4.3 配置归属

- `~/.ssh/config`：用户配置，只读解析，仅维护 AFK Include。
- `~/.ssh/afk_hosts`：AFK 管理的 Host 块和 AFK 可编辑字段。
- `~/.ssh/known_hosts`：系统主机密钥数据库，使用标准工具和原子文件操作更新。
- `~/.ssh/id_ed25519_afk`：系统 SSH 私钥；AFK 只检查路径、存在性、权限和派生指纹。
- AFK 本地存储：标签、分组、稳定 ID、远程工作区、最近测试结果和脱敏审计事件。

通配符 Host、`Match` 块和不能形成明确连接目标的配置块不作为普通主机展示，只参与 OpenSSH 最终解析并生成诊断。同名 Host 遵循 OpenSSH 的首个参数生效规则；如果 AFK Host 被更早配置覆盖，则标记为配置冲突并禁止误导性编辑。

## 5. 核心流程

### 5.1 添加主机

1. 用户输入别名、地址、端口、用户名，可选已有 `IdentityFile`、`ProxyJump`、标签和分组。
2. 主进程校验别名、地址、端口、路径和跳板机引用。
3. 通过 `ssh -G` 检查最终配置是否可解析且目标明确。
4. 原子写入 `~/.ssh/afk_hosts`；首次建立 Include 时备份并安全更新 `~/.ssh/config`。
5. 重新解析全部主机；如果实际结果被其他配置覆盖，回滚本次变更并返回冲突诊断。

### 5.2 确认主机身份

1. 通过 `ssh-keyscan -T <timeout> -p <port> <hostname>` 获取候选公钥。
2. 通过 `ssh-keygen -lf - -E sha256` 展示算法、位数和 SHA256 指纹。
3. 用户在 AFK 中确认“信任此指纹”。
4. 主进程再次扫描，并仅在二次扫描结果与用户确认值一致时更新 `known_hosts`。
5. 后续连接由 OpenSSH 校验；已知指纹变化时返回 `identity-changed`，阻断所有远程操作。

### 5.3 生成和部署密钥

1. 检查默认路径 `~/.ssh/id_ed25519_afk`；不存在时在内置 PTY 中运行 `ssh-keygen -t ed25519 -f ...`。
2. 用户直接在 PTY 中输入密钥口令；AFK 不读取、转发或记录口令。
3. 使用 `ssh-add --apple-use-keychain` 加载密钥，失败时展示脱敏诊断。
4. 优先调用系统 `ssh-copy-id`；不可用时在 PTY 中执行等价的 OpenSSH 公钥部署流程。
5. 远程流程创建 `~/.ssh`、校验权限，并按整行匹配避免重复追加公钥。
6. 部署完成后执行 `ssh -o BatchMode=yes ... true`，确认真正实现免密登录。

### 5.4 测试和连接

- 免密测试使用 `BatchMode=yes` 和有限的连接超时，不能等待密码输入。
- 正式登录使用 `/usr/bin/ssh <alias>` 的 PTY 会话，参数以数组传递。
- 记录主机 ID、开始/结束时间、退出码和脱敏错误分类。
- 不记录终端输入、完整终端输出、密码提示响应或私钥口令。
- 关闭终端面板时先发送正常终止信号，超时后才结束进程，并把会话状态回传 UI。

## 6. 界面设计

SSH 主机作为一级导航页面，包含：

- 搜索、来源筛选、状态筛选、刷新和“添加主机”。
- 主机列表：别名、连接目标、来源、身份信任状态、免密状态和最近测试结果。
- 行级主操作“连接”；测试、部署公钥、编辑和删除放入操作菜单。
- 详情面板：最终解析配置、主机指纹、密钥路径摘要、跳板机、远程工作区和诊断记录。
- 系统主机隐藏编辑和删除；仍可测试、确认指纹、部署公钥和连接。
- 私钥路径默认使用 `~` 缩写，不展示私钥内容或口令。

主机状态按安全优先级由诊断结果推导，而不是通过匹配 UI 文本推导：

1. `invalid`：配置无效或存在无法安全处理的冲突。
2. `identity-changed`：已知指纹变化。
3. `untrusted`：尚未确认指纹。
4. `key-missing`：指定密钥不存在或权限错误。
5. `auth-required`：网络可达但免密测试失败。
6. `unreachable`：DNS、网络、端口或跳板机不可达。
7. `ready`：配置有效、指纹可信且批处理连接成功。

## 7. 二期远程 Runtime

二期在资源注册表中增加 `ssh-host` 执行目标：

- Workflow 节点引用 `hostId`，不复制用户名、地址和密钥参数。
- 每个远程执行目标必须配置绝对 `remoteWorkspace`。
- 启动前依次执行配置解析、指纹校验、免密探测和远程目录验证。
- 通过 `ssh <alias> -- <runner> ...` 执行远程命令，所有参数结构化编码，不拼接不可信 Shell 字符串。
- 首版不上传代码、不自动拉取 Git、不转发本机 SSH Agent、不挂载本地密钥。
- Timeline 事件继续沿用现有模型，并增加主机 ID、远程目录和连接阶段。
- 连接中断时任务明确失败，不自动迁移到本地或其他主机。

## 8. 测试与验收

### 8.1 单元和服务测试

- 配置归一化、主机过滤、参数校验、状态推导和错误脱敏纯函数测试。
- 使用临时 HOME 和伪 OpenSSH 适配器验证 Include 管理、备份、原子写入、权限和回滚。
- 验证通配符、`Match`、重复 Host 和配置覆盖产生诊断而非运行时崩溃。
- 验证公钥部署幂等，不会重复追加同一公钥。

### 8.2 IPC、PTY 和集成测试

- IPC 测试验证发送方、参数白名单、路径约束和错误序列化。
- PTY 测试验证连接生命周期、输入转发、退出码和终止流程；确认输入不会进入日志。
- 使用隔离的临时 `sshd` 验证指纹确认、指纹变化阻断、公钥部署和免密测试。
- Desktop 独立执行 `typecheck`、`test` 和 `build`。

### 8.3 一期验收标准

在空白 macOS 用户 SSH 环境中，用户可以从 SSH 一级导航完成：添加主机、扫描并核对指纹、生成共用 Ed25519 密钥、部署公钥、执行免密测试和在内置终端登录。整个流程不把远程密码、密钥口令、私钥内容或终端敏感输入持久化到 AFK。

## 9. 非目标与后续拆分

一期明确不包含：

- Windows 或 Linux 专属 SSH/钥匙串实现。
- AFK 自建密码库或私钥托管。
- 自动接受主机指纹。
- 本地代码同步、远程 Git Worktree 或远程文件浏览器。
- SSH Agent 转发和自动凭据迁移。
- 远程 Runtime 的调度、故障转移和跨主机迁移。

二期远程 Runtime 应单独形成实现计划，并以本设计定义的 `SshHost`、信任状态和 IPC/服务边界为前置依赖。
