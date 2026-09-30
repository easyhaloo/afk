# SSH 标准指令诊断优化设计

## 背景

AFK 当前只建模 `HostName`、`Port`、`User`、`IdentityFile`、`ProxyJump` 和 `Include`。解析器会把其他语法合法的指令统一标记为 `ssh.unknown-directive`，导致 `ServerAliveInterval`、`ServerAliveCountMax` 等标准 OpenSSH 配置被错误展示为警告。

AFK 不应维护一份容易过期的 OpenSSH 指令白名单。系统安装的 OpenSSH 才是当前环境中判断配置是否合法的权威实现。

## 目标

- 标准且能被本机 OpenSSH 正常解析的指令不产生“未识别配置项”提示。
- AFK 继续只提取自身功能需要的字段，不扩展为完整 SSH 配置解析器。
- 保留真正的语法错误和 `ssh -G` 解析失败诊断。
- 对明确削弱主机指纹保护的标准配置保留安全提醒。
- 安全提醒显示具体指令名称和风险，不使用模糊的“未识别配置项”。

## 解析策略

### OpenSSH 作为配置权威

解析器遇到结构合法的 `Key Value` 指令时：

1. 如果是 AFK 使用的字段，则提取首个有效值；
2. 如果是其他字段，则默认静默保留给 OpenSSH 处理；
3. 不再生成 `ssh.unknown-directive`；
4. 每个具体 Host 仍通过 `ssh -G <alias>` 验证，失败时生成 `ssh.resolve-failed`。

无法匹配 `Key Value` 结构的非注释行继续生成 `ssh.malformed-directive`。

### 高风险标准配置

AFK 额外识别以下会削弱主机指纹保护的配置：

- `StrictHostKeyChecking no`
- `StrictHostKeyChecking off`
- `UserKnownHostsFile none`
- `UserKnownHostsFile /dev/null`

命中后生成结构化安全诊断，携带 Host 别名、配置路径和具体指令：

- `ssh.host-key-checking-disabled`
- `ssh.known-hosts-disabled`

这类诊断属于安全提醒，而不是“非法配置”。`ServerAliveInterval`、`ServerAliveCountMax`、`ForwardAgent`、`ControlMaster` 等其他标准配置不提示。

## 展示策略

- SSH 页面继续复用现有诊断分组组件。
- 安全诊断使用明确文案：
  - “已关闭 SSH 主机密钥严格校验”
  - “已禁用用户 known_hosts 文件”
- 分组详情展示受影响 Host 和配置文件路径。
- 不再出现“包含未识别配置项”提示。

## 兼容性与安全

- 不修改用户的 `~/.ssh/config`。
- 不阻止连接；安全诊断仅提醒用户当前 OpenSSH 配置绕过了 AFK 的指纹保护假设。
- 指令名和取值比较不区分大小写；路径 `/dev/null` 按展开前的配置文本识别。
- `UserKnownHostsFile` 包含多个路径时，只要所有配置均明确禁用持久化或包含 `/dev/null`，产生安全提醒；普通 known_hosts 路径不提示。

## 非目标

- 不实现完整 OpenSSH 配置语义和继承规则。
- 不自动修改或修复高风险配置。
- 不阻止用户使用合法但高风险的 OpenSSH 选项。
- 不在本次工作中增加系统配置删除能力。

## 验收标准

1. `ServerAliveInterval` 和 `ServerAliveCountMax` 不再产生诊断。
2. 任意结构合法且 `ssh -G` 可接受的其他标准指令不产生“未识别”诊断。
3. malformed 配置行仍产生诊断。
4. `ssh -G` 失败仍产生解析失败诊断。
5. `StrictHostKeyChecking no/off` 产生带 Host 的明确安全提醒。
6. `UserKnownHostsFile none` 或 `/dev/null` 产生带 Host 的明确安全提醒。
7. 页面诊断分组展示正确，不再包含 `ssh.unknown-directive` 对应文案。
8. SSH 适配器测试、诊断聚合测试、类型检查和构建全部通过。
