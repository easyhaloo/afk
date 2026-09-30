# Research: JumpServer 开放 API 上传公钥给堡垒机用户

- **Stage**: research
- **Date**: 2026-09-21
- **Mode**: HITL (scope 收敛：仅"公钥上传给堡垒机用户")
- **Target**: `https://dev-jumpserver.fangcloud.net` （堡垒机 SSH 端点 `:2222`）

## TL;DR — 结论

**结论：是。** JumpServer 提供开放 REST API，可以脚本化把 AFK 生成的 SSH 公钥上传给指定堡垒机用户，绕开 `authorized_keys` 自动部署失败、终端里手动粘贴的不便。

最小可行调用（占位写法，见 §"已确认信息"与 §"未确认信息"）：

```http
PUT /api/v1/users/<user_id>/
Authorization: Token <access_key_id>:<access_key_secret>      ← 优先
        或:  Authorization: Bearer <jwt-from-/auth/auth/>
Content-Type: application/json

{"public_key": "ssh-ed25519 AAAA... afk-managed"}
```

但有 **两个未解结论** 必须由真实凭据或人工登录才能确认：

1. **版本号未锁定**：只能通过 Swagger schema 反推，schema 路径 `/api/swagger.json` 需要登录才能下载。
2. **`public_key` 字段是否允许 self-PUT 未实测**：多数 JumpServer 版本只允许 admin 角色写这个字段，self-PUT 会返回 403。

## 已确认信息（无需登录的探测）

| 项 | 证据 |
|----|------|
| 实例可达 | `GET /` → 200, 3524B HTML（JumpServer 登录页） |
| API 路径存在 | `GET /api/v1/users/` → **401 Unauthorized**（端点存在但需认证） |
| OpenAPI 3 schema 存在 | `GET /api/swagger.json` → 401, `Content-Type: application/vnd.oai.openapi+json` |
| 认证方式支持 HTTPSignature | `WWW-Authenticate: Signature realm="api", headers="(request-target) date"` |
| Session 标识 | `Set-Cookie: SESSION_COOKIE_NAME_PREFIX=jms_; Path=/`（jms_ 前缀是 JumpServer v3+ 的特征） |
| 静态资源版本 | `/static/js/jumpserver.js?v=10`（仅前端版本，非服务端版本） |
| HTTPS 严格传输安全 | `Strict-Transport-Security: max-age=31536000`，正常 |
| 错误响应结构 | `{ "detail": "Authentication credentials were not provided.", "code": "not_authenticated" }`（DRF 风格） |
| CORS/cookie 行为 | `Vary: Accept, origin, Accept-Language, Cookie`；`Allow: GET, HEAD, OPTIONS`（对 `/api/v1/users/`） |

## 未确认信息（需登录或人工确认）

| 项 | 怎么确认 |
|----|----------|
| 服务端版本（v2/v3/v4/具体小版本） | 登录 Web 控制台 → 右下角版本号；或提供 AccessKey 后 `GET /api/swagger.json` 看 `info.version` |
| `public_key` 字段是否允许 self-PUT | 直接试一次 `PUT /api/v1/users/me/` 带 token，403 即被禁；或看 Swagger UserSerializer 字段的 `read_only` 标注 |
| 多组织是否需要 `X-JMS-ORG` 头 | `GET /api/v1/orgs/orgs/` 是否返回多个 org；多则必带 |
| 当前堡垒机是否启用了"允许密钥认证"登录策略 | Web 控制台 → 系统设置 → 认证；没启用的话上传了密钥也用不上 |

## API 调用指南（跨版本适用）

### 1. 认证 — 三选一

**优先级 P1 — AccessKey（推荐，零交互、可撤销）**

```http
Authorization: Token <access_key_id>:<access_key_secret>
```

AccessKey 在 Web 控制台 → 个人中心 → AccessKey 创建。完全离线、不依赖登录态。

**优先级 P2 — Bearer Token（一次性脚本）**

```bash
TOKEN=$(curl -fsS -X POST https://dev-jumpserver.fangcloud.net/api/v1/authentication/auth/ \
  -H "Content-Type: application/json" \
  -d '{"username":"wangwendi","password":"<password>"}' | jq -r .token)

curl -fsS -H "Authorization: Bearer $TOKEN" ...
```

JWT 默认短期有效，过期重取。

**优先级 P3 — Session + CSRF（复用浏览器会话）**

需要先登录拿 `jumpserver.csrftoken` cookie + `X-CSRFToken` 头；不适合脚本。

### 2. 上传公钥 — 两条候选路径

**A. 用户对象字段（最稳，跨版本都存在）**

```http
PUT /api/v1/users/<user_id>/
Content-Type: application/json
{"public_key": "ssh-ed25519 AAAA... afk-managed"}
```

`public_key` 是单行 OpenSSH 公钥字符串（含 `ssh-` 前缀和 trailing comment）。

**B. 专用子路由（v3+ 多数实例可用）**

```http
POST /api/v1/users/<user_id>/pub-key/
Content-Type: application/json
{"public_key": "ssh-ed25519 AAAA... afk-managed"}
```

先试 A，403 再试 B；都不通就只能 admin 账号代写。

### 3. 获取 user_id

```bash
curl -fsS "https://dev-jumpserver.fangcloud.net/api/v1/users/?search=wangwendi" \
  -H "Authorization: Token <ak>:<sk>" | jq -r '.results[0].id'
```

也支持 `/api/v1/users/me/` 拿到当前用户 ID（少数版本有该路由）。

### 4. 验证是否生效

```bash
ssh -i ~/.ssh/id_ed25519_afk -p 2222 \
  -o BatchMode=yes -o ConnectTimeout=8 \
  wangwendi@dev-jumpserver.fangcloud.net exit
```

预期 `Permission denied (publickey)` 之前的 Permission denied 不再要求 password。

## 三个绕不开的坑

1. **`public_key` 字段的写权限**：多数 v3/v4 版本只允许 admin / system-admin 角色写；普通 self-PUT 会被 403 拦截。脚本必须用 admin token，否则只能引导用户到 Web 控制台手动贴一次。
2. **多 org 路由**：企业版/多租户实例没 `X-JMS-ORG: <org_id>` 头会落到默认组织，可能写错账号；org_id 通过 `GET /api/v1/orgs/orgs/` 取。
3. **堡垒机端登录策略**：admin 后台"认证设置"需要勾选"允许 SSH 公钥登录"并绑定用户的 SSH 公钥到堡垒机账户；API 写完之后 JumpServer 自身还会把 key 下发到管理的资产账户里。这一步 API 能否独立完成要看版本。

## Probe 日志（复现用）

```
$ curl -sI https://dev-jumpserver.fangcloud.net/
HTTP/2 200, server: nginx, content-type: text/html, 3524B

$ curl -sI https://dev-jumpserver.fangcloud.net/api/v1/users/
HTTP/2 401, allow: GET, HEAD, OPTIONS,
www-authenticate: Signature realm="api",headers="(request-target) date",
set-cookie: SESSION_COOKIE_NAME_PREFIX=jms_; Path=/

$ curl -sI https://dev-jumpserver.fangcloud.net/api/swagger.json
HTTP/2 401, content-type: application/vnd.oai.openapi+json

$ curl -s https://dev-jumpserver.fangcloud.net/api/swagger.json | head -c 200
{"detail":"Authentication credentials were not provided.","code":"not_authenticated"}

$ curl -sI https://dev-jumpserver.fangcloud.net/api/
HTTP/2 404

$ curl -sI https://dev-jumpserver.fangcloud.net/api/v1/schema/
HTTP/2 404

$ curl -sI https://dev-jumpserver.fangcloud.net/api/v1/docs/
HTTP/2 404
```

所有探测仅用 `GET`/`HEAD`，未触碰任何凭据。

## AFK 集成角度（仅事实，未做产品决策）

- AFK 当前对 JumpServer 的支持停留在「把堡垒机作为 ProxyJump 跳板的 SSH 别名」层面（`jumpHostType: "jumpserver"`），整个仓库无 REST 客户端代码。
- `desktop-client` 用 Electron IPC + node-pty，没有 fetch/axios 骨架；新增 JumpServer adapter 需要从零写。
- 若要做"AFK 推送公钥到堡垒机"按钮，最小侵入路径是新建 `desktop-client/electron/services/jumpserver-key-service.ts`，对外暴露 `pushPublicKey(hostId)`；凭据（AccessKey）也走 `safeStorage` 保存，与现有 `ssh-credential-service.ts` 风格一致。
- 这条产品决策不在本次研究范围。

## Next-step 选项（等你拍板）

| 选项 | 动作 | 价值 |
|------|------|------|
| A | 你提供一个只读 admin token（或 AccessKey），我跑 `GET /api/swagger.json` 锁定版本与 `public_key` 字段权限 | 一次性消除"未确认"区 |
| B | 不展开研究，先按"AccessKey + PUT /api/v1/users/<id>/"试一次，能通就结束 | 快，但要承担 403/版本不匹配的小返工 |
| C | 跳过 API 集成，回到 AFK 现有"在目标终端内操作"提示 + JumpServer Web 控制台手动贴公钥的工作流 | 零成本，但与你"自动调用接口"诉求不符 |

---

**Sources:**

- [JumpServer Documentation — SSH Public Key settings](https://docs.jumpserver.org/zh/v4/en/manual/user/profile)
- [JumpServer API Interface Calls: Comprehensive Guide](https://www.jumpserver.com/blog/jumpserver-api-interface-calls-guide)
- [jumpserver api 批量添加主机](https://www.cnblogs.com/suyj/p/16171236.html)
- [JumpServer API 开发指南](https://cloud.baidu.com/article/4789759)
- [Jumpserver自动添加资产、批量添加资产](https://blog.csdn.net/weixin_44983139/article/details/154742223)
- [GitHub: fit2cloud/jumpserver](https://github.com/fit2cloud/jumpserver)
