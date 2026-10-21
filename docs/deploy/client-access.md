# 客户端身份与权限

Gateway 管理一个管理员账户。该账户管理独立 delegated 或 OAuth 客户端身份；这不是多人账号系统。标签、`X-Reach-Client`、MCP `clientInfo` 和请求正文里的身份字段只用于显示，不能授予权限。所有 REST、HTTP MCP、stdio Connector 调用最终都经过同一 Gateway 策略检查。

## 凭据分工

| 身份或凭据 | 权限与生命周期 |
| --- | --- |
| Owner Controller token | 所有已注册 Engine 和工作区的全部数据面权限；只交给可信管理工具 |
| Delegated token，`reach_ct_` 前缀 | 一个持久化客户端身份、明确的到期时间、逐 Engine/workspace 的权限；创建和轮换时只返回一次明文 |
| OAuth access token，`reach_at_` 前缀 | 批准应用的持久化身份及当前资源策略；有效 1 小时，refresh token 轮换并有效 30 天 |
| 存量 legacy-global OAuth | 升级保留原来的全局权限，标记 Review required；Owner 必须收紧或明确复核。复核后仍是 Owner 等价的可信客户端 |
| Engine token | 仅供对应 Engine 心跳和获取短期 session token；不能作为客户端或管理员凭据 |
| 管理员 cookie | 仅供控制台；不能调用数据面 RPC。修改客户端需要 Origin、CSRF 和十分钟内密码重新认证 |

Delegated 和 OAuth 管理要求启用 `REACH_DATA_DIR`。凭据只保存摘要，数据目录和备份仍须私有保护。Owner Controller 的旧配置保持兼容。没有配置认证的回环开发模式是本机可信模式，不提供客户端隔离；远程部署必须配置认证及经过验证的 HTTPS/WSS。

## 创建日常使用的客户端

1. 用密码和 TOTP 登录 `/console/`，打开 **Clients → Client identities & permissions**。
2. 点 **Create delegated client**，设置名称和较短的 Credential expiry。
3. 点 **Add resource**，明确选择 Engine ID 和 Engine 配置的工作区名称，例如 `engine-a`、`docs`。只勾选需要的 read/write/execute；默认全部不选。空策略可以创建身份，但无法发现或访问资源。
4. 点 **Create client**，把单次展示的 token 保存在客户端私有设置或权限 `0600` 的文件里。关闭对话框后不能重新查询明文；丢失时轮换。
5. 远程 HTTP MCP 在 `Authorization: Bearer <delegated-client-token>` 中使用该凭据。stdio JSON 的兼容字段仍叫 `controllerToken`，也接受 delegated token：

```json
[
  {
    "id": "docs-device",
    "engineId": "engine-a",
    "gatewayUrl": "https://gateway.example.com",
    "controllerToken": "<delegated-client-token>"
  }
]
```

保存为私有 `.reach/devices.json`，执行 `chmod 600 .reach/devices.json`，通过 `REACH_MCP_DEVICES_FILE` 指向它。`controllerToken` 是历史字段名称，不表示该 token 自动获得 Owner 权限。Connector 的本地工具列表不是安全边界，Gateway 始终复核实际凭据。

OAuth 应用使用 [MCP OAuth 流程](mcp.md#chatgpt-等-oauth-客户端remote-http)。批准页要求管理员密码和新鲜 TOTP/恢复码，并明确选择 Engine、workspace 和操作。没有选择不会发放授权码。已连接 Engine 的工作区来自它报告的列表；离线且未报告工作区时需输入 Engine 配置的准确名称，最终由 Engine 校验。新批准绝不继承 legacy 全局权限；重新批准已有应用也会用明确选择的策略替换原策略。

## 操作映射和发现

| 操作权限 | 方法 |
| --- | --- |
| read | `fs.read`、`fs.list`、`fs.stat`、`fs.glob`、`fs.grep` |
| write | `fs.write`、`fs.edit` |
| execute | `process.run`、`process.status`、`process.logs`、`process.list`、`process.stop` |

三个权限独立，write/execute 不隐含 read。资源必须同时匹配 Engine ID 和工作区名称，不支持通配符。设备发现只列出可访问的 Engine，工作区、方法、版本和进程列表按当前策略过滤。无权访问和不存在的 Engine 均返回 404，不暴露另一设备的元数据。

execute 还要求 Engine 本地明确启用工作区执行；Gateway 的权限和 grant 无法打开 Engine 上关闭的执行功能。Node 脚本使用 Engine 系统账户的权限，能够访问该账户能访问的系统资源；客户端 API 的工作区限制不能把任意脚本变成操作系统沙箱。允许写脚本文件的客户端可能改变其他可信客户端之后执行的代码，须一并评估信任关系。

## 会话、grant 和错误

每台 Engine 同时只允许一个交互会话。会话绑定服务端认证得到的 principal，知道他人的 session/process/launch ID 也不能接管、观察日志或停止任务。同一身份的 OAuth token 刷新保留 principal 和当前策略。进程观察和控制还必须匹配该身份拥有的可信任务工作区。

文件写入、执行和进程控制分别需要对应 grant。grant 绑定 principal、Engine、policy revision、作用范围和五分钟有效期，文件 grant 还绑定路径/方法，执行 grant 绑定 session/workspace/script/launchId，控制 grant 绑定 session/processId。签发和转发前都检查策略；直接调用和单层 `tool.call` 一致，嵌套包装被拒绝。

MCP 自动申请 grant 仅为调用提供最小范围的机器授权，不代表人类逐次批准。自动申请不能扩大客户端策略。Owner 可主动取得任何资源的 grant，因此 Owner 不具备资源隔离保证。

| 情况 | 对外结果 |
| --- | --- |
| 凭据无效、已撤销或已过期 | HTTP 401 |
| Engine 不存在或被策略隐藏 | HTTP 404，同一响应形态 |
| 用其他 principal 的 MCP session ID | HTTP 404，原会话不受影响 |
| 资源/操作权限拒绝 | grant 签发为 HTTP 403；已认证 RPC 返回 `PERMISSION_DENIED` 错误；MCP 工具以工具错误报告 |
| 其他身份占用 Engine | `ENGINE_BUSY`；REST 会话控制为 409 |
| 他人的任务标识 | `PROCESS_NOT_FOUND` 或会话绑定拒绝，不披露任务工作区 |
| Engine 未启用执行 | `PROCESS_EXECUTION_DISABLED` |

## 轮换、撤销和权限修改

在身份行使用 **Edit permissions**、**Rotate credential** 或 **Revoke identity**。权限修改、delegated 轮换/撤销/到期会同步阻断旧 authority，使已有 grant 失效，并回收该身份的 MCP/Engine 会话和运行中的普通后代进程。到期定时器无需客户端再发送请求。轮换返回新的单次 token，旧 token 立即拒绝。一次操作不会撤销其他身份的权限。

OAuth 应用撤销、`/oauth/revoke` 和 refresh token 重放也走统一清理路径。重放会撤销对应 token family；由于同一应用共享 ownership pool，保守清理该应用的会话和 grant，不影响其他应用。刷新不会扩大现有策略。空闲宽限期内减少权限也会回收旧 pool，不能通过新 MCP session 复用已删除权限。

清理失败时 Gateway 保留归属并重试；Engine 自己也保留未排空的进程管理器，阻止替换任务。不要靠反复请求或改变显示标签绕过清理。已转发到 Engine 的写操作可能已经跨过原子提交边界，撤销不能撤回已经提交的文件；超时、取消或撤销后先读取 revision/实际状态，再决定是否重试，不能假设回滚。

## API 字段

管理 API 以管理员 cookie、Origin 和 CSRF 认证。敏感修改另需 recent-auth；Controller、Engine 和 delegated bearer 都不能代替管理员登录。

| 请求 | JSON 或返回值 |
| --- | --- |
| `GET /api/console/access-clients` | `{ "clients": [...] }`，不返回 token/digest |
| `POST /api/console/access-clients` | `{ "name": "Daily reader", "expiresAt": <未来毫秒时间戳>, "permissions": [...] }`；201 返回 `{ "client": {...}, "token": "..." }` |
| `GET /api/console/access-clients/:id` | `{ "client": {...} }` |
| `POST /api/console/access-clients/:id/rotate` | `{ "expiresAt": <未来毫秒时间戳> }`，返回新 token；仅 active delegated 可轮换 |
| `PATCH /api/console/access-clients/:id/policy` | `{ "permissions": [...] }`；空数组撤去全部资源权限 |
| `DELETE /api/console/access-clients/:id` | 无正文，撤销身份；幂等 |
| `POST /api/console/access-clients/:id/review-global` | `{ "confirm": true }`；只允许存量 legacy OAuth，不创建新的全局授权 |

路径 `:id` 必须 URL 编码，例如 `client%3A...` 或 `oauth%3A...`。单条 permission 的完整形态：

```json
{
  "engineId": "engine-a",
  "workspace": "docs",
  "read": true,
  "write": false,
  "execute": false
}
```

`expiresAt` 是 JSON number，不是日期字符串；必须是未来的安全整数。权限布尔字段须完整且为 boolean，重复资源、未知字段、null 策略和通配符均拒绝，失败不部分写入。创建时省略 permissions 等同空数组，显式 null 无效。身份详情包括 `kind`、`name`、`expiresAt`、`revokedAt`、`policyRevision`、`legacyGlobal` 和 `reviewRequired`；名称仅显示，不参与认证。

## 升级和回滚

升级前停止测试环境的 Gateway，在私有位置保存 SQLite 一致性备份及原配置；活动 WAL 数据库不能只复制 `reach.db`。使用 SQLite backup API 或停机后复制完整数据目录。不要在文档清理过程中更换生产凭据或启动/停止现有服务。

schema migration 3 在一个事务中创建身份、凭据和权限表，只把原来 `approved_at` 非空的 OAuth 客户端映射为 `legacy-global`、`review_required`。未批准注册不获得权限。原管理员、Owner/Engine 凭据和 OAuth token 摘要保留，重复启动不重复迁移。失败会回滚表和版本标记。

升级后逐项查看 **Review required**：优先 Edit permissions 收紧；若确需继续全局访问，点 Review global access 并确认 Owner 等价风险。确认只去除待复核标记，不把全局身份变成受限身份。公开 readiness 验收不得遗留未复核 legacy 授权。

旧 Gateway 不理解新 schema，会拒绝打开新数据库。回滚须停止候选 Gateway，将旧二进制与升级前的一致性快照成对恢复，复用原环境/seed 配置。不要手工删除新表或降低 schema version。快照之后创建的 delegated 身份及权限变更不会存在于旧快照；旧版不支持这些身份，且可能恢复旧 OAuth 全局权限，须事先审核。先在独立数据目录验证恢复；不要用候选测试替换正在运行的安装。

上述字段和生命周期由 `client-policy.test.ts`、`client-access.test.ts`、`client-authorization.test.ts`、`auth.test.ts`、`oauth.test.ts`、`store.test.ts` 和控制台组件测试覆盖；这些隔离测试不代表任何生产安装已经迁移。
