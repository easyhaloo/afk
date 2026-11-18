# installed-tool-discovery

这个独立插件在 AFK 的 `context.provider` 注册 `context.installed-tools`。它从已安装、已启用的 `verification.provider` 中查找适用工具，返回描述和可调用的 `verify` 路由。

## 分发和安装

发布者在本插件的 `package.json` 所在目录执行以下命令，将生成的 `.tgz` 及其 SHA-256 随交付件提供给用户。

```sh
npm pack --offline --ignore-scripts
shasum -a 256 installed-tool-discovery-1.0.0.tgz
```

已有 CLI 的用户拿到可信归档后，核对摘要，在归档所在目录执行以下命令。CLI 复制插件并提供宿主自己的 `@afk/runtime/plugin-sdk`。`list` 的加载结果应包含 `context.installed-tools`。

```sh
stage=$(mktemp -d)
tar -xzf installed-tool-discovery-1.0.0.tgz -C "$stage"
afk plugin install "$stage/package"
afk plugin list --loaded --json
```

## 工具作者契约

按 API v1 可信插件格式提供 `package.json`、`plugin.json` 和入口模块。下面的 `plugin.json` 对应一个随包提供 `source.json` 的工具。打包前，将 `sourceDigest` 占位符替换为该文件原始字节的 SHA-256（64 位小写十六进制）。

```json
{"id":"tool.scan-manifest","version":"2.0.0","apiVersion":1,"trusted":true,"provides":["verification.provider"],"entry":"index.mjs","sourceDigest":"<sha256>"}
```

入口导出 `{ manifest, activate(context) }`。在 `activate` 中调用 `context.registerVerificationProvider(manifest.id, provider)`。保留 SDK 的 `capabilities` 和 `verify(request)` 契约，返回含 `passed`、`durationMs` 的实际验证结果。参与发现的 provider 还需提供以下字段和方法。

| 字段 | 含义 |
| --- | --- |
| `id`、`version` | 与已安装的 manifest 精确一致。 |
| `source`、`sourceDigest` | 稳定的来源标识和原始字节摘要。随包文件可用 `new URL('./source.json', import.meta.url).href` 和 `manifest.sourceDigest`。 |
| `readToolDescription(project)` | 用下节的动作和五个上下文字段检查读取授权。授权后读取来源、核对摘要再解析 JSON。拒绝时返回 `undefined` 或抛错。`verify` 消费相同来源时再次检查授权，以便撤权对已取得的路由生效。 |

最小可匹配的 `source.json` 示例如下。`names` 是非空字符串组成的名称或别名列表，`description` 是非空字符串。发现按提示中包含的最长名称匹配。`project` 和 `environment` 精确匹配查询，`productVersions` 是产品名到版本字符串的对象，每一项都必须匹配，`{}` 表示无产品版本约束。单个 provider 的描述读取抛错或字段无效时，发现继续检查其它工具。

```json
{"names":["清单验码","面单校验"],"description":"检查扫描清单的校验位。","project":"github:w11/parcel","environment":"staging","productVersions":{"parcel":"2.0"}}
```

## 授权和调用

用 `afk plugin install /absolute/path/to/tool-package` 安装工具。在内置 `policy.compliance-policy` 的配置中加入精确的 `tool.source.read` 规则。以下是独立测试配置的示例，现有配置应保留其它规则。`source` 使用已安装文件的 URL，可由 `~/.afk/plugins/<id>/install.json` 的相对 `entry` 定位其同目录的 `source.json`。`digest` 使用该文件的实际摘要。

```json
{"defaultEffect":"deny","rules":[{"id":"scan-source","effect":"allow","actions":["tool.source.read"],"when":{"project":"github:w11/parcel","plugin":"tool.scan-manifest","version":"2.0.0","source":"<installed-file-url>","digest":"<sha256>"}}]}
```

将配置保存为 `policy.json`，将以下查询保存为 `query.json`。项目、版本和环境来自调用方的任务配置。

```json
{"scope":"github:w11/parcel","prompt":"请用面单校验工具检查扫描清单","limit":5,"target":{"project":"github:w11/parcel","productVersions":{"parcel":"2.0"},"conditions":{}},"applicability":{"environment":"staging"}}
```

```sh
afk plugin configure policy.compliance-policy --builtin --file policy.json
afk plugin invoke context.provider context.installed-tools gather --input query.json --json
```

每个命中的 `origin` 为 `<id>@<version>`。解析 `content` 可取得 `description`、`capability`、`provider` 和 `operation`，再通过 `afk plugin invoke` 调用该路由。要在上述配置中撤权，将同一规则的 `effect` 改为 `deny` 并重新配置，工具和来源文件保留在安装目录中。
