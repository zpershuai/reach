# Reach MCP 安装与客户端配置

[English](mcp.md) | 简体中文

Reach 提供两种 MCP 接入：桌面客户端启动本地 stdio Connector；Grok Bot 等远程客户端连接 Gateway 的 HTTPS `/mcp`。两种方式都由 Engine 执行文件工具。HTTP 方式复用 Gateway 的端口、域名和容器，无需额外服务。

stdio 的 Gateway URL 也必须使用 HTTPS；本地开发仅允许 `localhost`、IPv4 127/8 和 IPv6 `::1` 使用 HTTP。URL 不接受内嵌账号密码、query 或 fragment，请求禁止跟随重定向。静态 stdio 的 `session.close` 只关闭所指定设备的自有会话；未持有该设备时返回 `closed=false`、`owned=false`，不会切换设备或建立新会话。

仓库路径 `packages/grok-bot-mcp-connector` 和 npm package 名保留历史命名，实际 MCP server 名为 `reach-mcp`。下面的配置可用于支持该传输方式的 MCP 客户端。

## Grok Bot（remote HTTP）

先构建并更新 Gateway，再在仓库根目录运行 `node scripts/configure-grok-plugin.mjs .reach/deployment.json`，安装生成的 `.reach/grok-bot-plugin/` 私有目录，详见 [插件说明](../../grok-bot-plugin/README.md)。部署 JSON 的 `gatewayUrl` 必须是公网 HTTPS 根 URL，脚本生成完整 `/mcp` 地址；宿主只需通过私有提示框设置 **客户端 token**（推荐 scoped delegated）。不用 Engine token，也不需要 `REACH_MCP_DEVICES` 或本地 Node 进程。通用客户端配置：

```json
{
  "mcpServers": {
    "reach": {
      "type": "http",
      "url": "https://reach.example.com/mcp",
      "headers": { "Authorization": "Bearer <delegated-client-token>" }
    }
  }
}
```

真实凭证只存客户端私有设置。先按 [客户端权限](client-access_cn.md) 创建明确资源策略的 delegated token；Controller Owner token 可访问所有资源，日常客户端不应使用它。插件 URL 使用完整字面值，只有 Authorization 头使用 token 变量，不依赖宿主支持 URL 插值。仓库内插件使用保留的示例地址，安装生成的私有副本。生成脚本不复制 token，也不覆盖已有副本；更换地址时在私有副本中修改。不要把真实 URL 或 token 提交到仓库。

HTTP 固定展示 `list_devices`、`get_versions`、`pick_device`、`list_workspaces`、`device_status`、`fs_read`、`fs_write`、`fs_edit`、`fs_list`、`fs_glob`、`fs_stat`、`fs_grep`、`process_run`、`process_status`、`process_logs`、`process_stop`、`process_list`、`session_close`。`list_workspaces`、文件、process 工具和 `session_close` 必须传 `deviceId`，它直接对应 Gateway 注册的 `engineId`。设备列表包含默认 Engine 和额外注册表，不读取客户端设备文件。`lastSeenAt` 是最后心跳时间，历史版本号不代表设备当前在线。

调用 `list_devices` 确定目标，再调用 `list_workspaces({"deviceId":"engine-a"})`。首次工作区发现、`pick_device` 或文件调用立即创建连接意图；未 ready 时返回 `{"status":"connecting","retryAfterMs":1000}`，文件操作尚未执行。按返回间隔调用 `device_status`，直到 `ready` 且 `owned: true`，再调用 `list_workspaces` 取得名称。状态查询不会重新打开或取消意图。默认空闲心跳仍是 120 秒；可将 Gateway 的 `REACH_HEARTBEAT_INTERVAL_SECS` 设置为 `15`，代价是更多网络流量和设备耗电。

就绪结果例如 `{"deviceId":"engine-a","status":"ready","workspaces":["notes","scripts"],"processWorkspaces":["scripts"]}`。文件工具使用 `workspaces` 中的名称；启动脚本必须选择 `processWorkspaces` 中的名称。它们来自 Engine 的实际配置，不包含宿主机绝对路径，不能假定存在 `default`。旧 Engine 未报告执行许可列表时返回 `[]`；未报告工作区名称时返回 `WORKSPACES_UNAVAILABLE`，请升级相应组件。

一个 HTTP MCP 会话可以分别持有多个 Engine。竞争同一个 Engine 返回 `ENGINE_BUSY`，不会自动抢占。完成后逐个调用 `session_close`。Controller token 客户端的 `DELETE /mcp` 和空闲过期会关闭该 MCP 会话持有的 Engine。OAuth 客户端按已授权应用身份共享 Engine 归属，因此后续新建的 MCP 会话可以继续工作；最后一个 MCP 会话空闲过期后，再保留一个空闲 TTL（默认 5 分钟）供重连，之后关闭 Engine。最后一个会话显式 DELETE、控制台断开或 Gateway 关闭时不保留这段宽限期。清理只针对绑定的会话身份，失败会保留待清理记录并重试。

`session_close` 不会关闭其他调用者持有的 Engine；当前 MCP 会话没有持有该设备而设备仍被占用时，返回 `ENGINE_BUSY`。会话退役后立即安排清理，读取请求体期间的 POST 和仍在排队的请求不得再启动工具，返回 404；已经执行的操作结束后再清理，超时不表示写入已取消。

初始化返回 `Mcp-Session-Id`，后续请求需携带它；丢失返回 400，未知或过期返回 404，客户端需重新初始化。支持 MCP `2025-03-26` 与 `2025-06-18`，后续 `MCP-Protocol-Version` 必须匹配协商版本。客户端通知返回空 202，POST 请求继续返回 JSON。

Gateway 声明 `capabilities.tools.listChanged: true`。客户端可使用同一 `/mcp` URL 发起 GET，携带认证、会话与协议头，并声明 `Accept: text/event-stream`，接收 `notifications/tools/list_changed`。每个会话最多保留一条通知流，新 GET 替换旧流；断开通知流不会关闭 Engine 会话。首次连接或重连通知流后，Gateway 在收到 `notifications/initialized` 后发送一次工具列表失效通知，客户端应重新请求 `tools/list`。当前 HTTP 工具集合固定，不会因心跳、选中设备或每次工具调用而反复通知；服务端工具目录变更时可通过通知入口通知已连接客户端。

通知流每 15 秒发送保活，缓冲超过 1 MiB 时断开慢读连接；保活不会延长 MCP 空闲 TTL。DELETE、空闲退役、控制台断开及 Gateway 关闭都会结束通知流。OAuth 令牌失效或撤销后，通知流最迟在下一次保活检查时关闭，客户端可用有效令牌重连。该流只承载服务端通知，不转发控制台 SSE 或 POST 的 RPC 结果，不提供事件重放。ChatGPT 等宿主可能仍保留对话的工具定义；更新后应在连接详情中刷新工具元数据，并在新对话中核对 `list_workspaces`。

默认响应预算 25 秒，包含排队和执行；MCP 空闲 TTL 为 5 分钟。HTTP JSON **总请求体**最多 64 KiB，包含转义和元数据，Caddy 的现有 `max_size 64KB` 无需修改。WebSocket 上限仍是 1 MiB。写入前读取 `revision`，覆盖/编辑时传 `ifMatch`，新文件用 `mode: create`。超时后先重新读取，不能假设写入未提交或直接重试。

64 KiB 按收到的 HTTP 请求体计算，Gateway 添加的内部会话、权限和截止时间字段不会减少这份额度。读取请求体、排队和正在执行的请求共同计入每会话请求上限；读取请求体期间不会触发空闲过期，但仍受响应预算约束。

所有方法都检查 Owner、delegated 或 OAuth access token（见下节）；无认证只允许回环监听。默认拒绝带有 `Origin` 的请求，无该头的客户端可正常连接。接入时必须在实际宿主核对该请求头；若发送，在 Gateway 配置 `REACH_MCP_ALLOWED_ORIGINS` 为观察到并批准的完整 Origin，多个值用逗号分隔；若不发送，保留空配置。不要使用通配符或关闭检查，核对时不要记录 Authorization。HTTP 参数见 [configuration.md](configuration_cn.md)，完整验证见 [verification.md](verification_cn.md)。以下方式 A–C 专用于 stdio。

## ChatGPT 等 OAuth 客户端（remote HTTP）

ChatGPT 自定义连接器（Developer mode / Apps）不能填写静态 `Authorization` 头，只支持“无认证”或 OAuth。启用控制台（`REACH_DATA_DIR` + HTTPS `REACH_PUBLIC_ORIGIN`）并完成管理员设置后，Gateway 自动作为 MCP 授权服务器，Controller token 仍可同时使用：

- 未认证的 `/mcp` 请求返回 401 和 `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`。
- 元数据：`/.well-known/oauth-protected-resource`（RFC 9728）、`/.well-known/oauth-authorization-server`（RFC 8414）。
- 动态客户端注册 `POST /oauth/register`（RFC 7591）；回调地址必须是 HTTPS，或回环地址的 HTTP。
- 授权码 + PKCE（仅 `S256`），`GET /oauth/authorize` 显示批准页；`POST /oauth/token` 发放 1 小时 access token 和 30 天轮换 refresh token；`POST /oauth/revoke`（RFC 7009）。

注意：ChatGPT 使用的是浏览器授权码流程，不是 RFC 8628 设备码流程。

接入步骤：

1. 在 ChatGPT 中新建连接器，MCP 服务器 URL 填 `https://reach.example.com/mcp`，认证方式选 **OAuth**，客户端 ID/密钥留空（由动态注册生成）。
2. ChatGPT 打开 Gateway 的批准页，显示应用名称和回调域名。明确选择 Engine、workspace 和 read/write/execute；默认全部不选，未选择不会签发权限。输入管理员密码和当前 TOTP 验证码（或一次性恢复码）后点 **Approve**；**Deny** 返回 `access_denied`。每个 TOTP 码只能用一次，刚登录过控制台时请等待下一个验证码。
3. 之后 ChatGPT 自动用 refresh token 续期。控制台“Clients → Authorized apps”列出已批准的应用，**Revoke** 立即删除其全部令牌（需近期重新验证密码）。

批准页与控制台登录共享失败限流和审计；批准、撤销分别记录为 `oauth.authorize:<name>`、`oauth.revoke:<id>`。令牌仅以 SHA-256 摘要存于 `reach.db`。匿名注册按客户端地址限流（每小时 20 次）；未批准的注册闲置 1 小时后过期，最多保留 256 个，满额时拒绝新注册而不淘汰正在批准的记录。批准页的待处理请求由 Gateway 签名并随表单提交，不占服务端容量，10 分钟后失效。每个 MCP 会话绑定创建它的身份（Owner、delegated 或某个 OAuth 客户端），换用其他凭证访问该会话返回 404；同一客户端刷新令牌后会话仍可继续使用。若 ChatGPT 访问 `/mcp` 时带有 `Origin`，仍需按下文配置 `REACH_MCP_ALLOWED_ORIGINS`。反向代理需将 `/.well-known/oauth-*` 与 `/oauth/*` 转发到 Gateway（仓库的 Caddy 配置已整站转发）。

## 方式 A：使用已安装的产物

安装生成的配置位于 `~/.config/reach/mcp.json`。以下 JSON 中的主目录路径为占位符，需替换为实际绝对路径。将其中 `mcpServers.reach` 合并到客户端的本地 MCP 配置，保留客户端已有的其他服务。字段结构如下：

```json
{
  "mcpServers": {
    "reach": {
      "command": "/absolute/path/to/home/.reach/runtime/node/bin/node",
      "args": ["/absolute/path/to/home/.local/share/reach/mcp/dist/main.js"],
      "env": {
        "REACH_MCP_DEVICES_FILE": "/absolute/path/to/home/.config/reach/mcp-devices.json",
        "REACH_MCP_READY_POLL_MS": "1000"
      }
    }
  }
}
```

每次 Engine 安装都会自动把独立 Node.js runtime 安装到 `~/.reach/runtime/node`，MCP 使用其中 `bin/node` 的固定绝对路径，不依赖 Homebrew 或系统 Node。换用户或设备时替换绝对路径。配置文件已生成，但并未自动注册到某个 MCP 客户端。客户端配置格式和重新加载方式由所用客户端决定。

MCP 初始化的 `instructions` 和 `list_devices` 工具的 description 也说明这个 runtime 的安装位置与用途。同一主机上的 Gateway、MCP 可以共用该 runtime；连接其他设备不会把远端 Node 当成本地可执行程序。

MCP 的解释器由 `command` 字段选择，不读取 `REACH_NODE_BIN` 来切换 runtime。该变量只用于 [run-node.sh launcher](node-runtime_cn.md)，Rust Engine 不依赖它。

客户端 token 存放在独立设备 JSON 中，不需要嵌入上述共享启动配置。确认目标客户端进程能够读取该文件，并能执行指定 Node。纯云端客户端如果不能运行本地 stdio 子进程，无法直接使用此安装方式。

## 方式 B：从源码运行

在仓库根目录构建：

```bash
npm --prefix packages/reach-rpc ci --ignore-scripts
npm --prefix packages/grok-bot-mcp-connector run build
```

编译器依赖来自相邻的 `reach-rpc` 包，MCP 包本身没有独立的 `npm ci` 安装步骤。构建会同时编译相邻 RPC 包。

客户端示例配置：

```json
{
  "mcpServers": {
    "reach": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/reach/packages/grok-bot-mcp-connector/dist/main.js"],
      "env": {
        "REACH_MCP_DEVICES_FILE": "/absolute/path/to/private/devices.json",
        "REACH_MCP_READY_POLL_MS": "1000"
      }
    }
  }
}
```

已安装 Engine 时可将 `command` 设置为本机 `~/.reach/runtime/node/bin/node` 的绝对路径；否则用 `command -v node` 确定已有 Node 的路径。不要把 `npm run build`、`npm start` 或带输出提示的 wrapper 作为 stdio 启动入口，stdout 必须只包含 MCP JSON-RPC。构建步骤在接入客户端前单独执行。

## 方式 C：只安装 MCP 的稳定运行目录

MCP 客户端位于另一台 Mac/Linux 电脑时，不必在那里安装 Engine。先完成方式 B 的构建，并将对应 Controller 设备配置安全保存为 `.reach/devices.json`，再复制运行文件：

```bash
mkdir -p "$HOME/.local/share/reach/mcp/dist" "$HOME/.config/reach"
chmod 700 "$HOME/.local/share/reach" "$HOME/.config/reach"
install -m 644 packages/grok-bot-mcp-connector/package.json \
  "$HOME/.local/share/reach/mcp/package.json"
for module in main config gateway server tools protocol invoker result version; do
  install -m 644 "packages/grok-bot-mcp-connector/dist/$module.js" \
    "$HOME/.local/share/reach/mcp/dist/$module.js"
done
install -m 644 packages/grok-bot-mcp-connector/dist/version.json \
  "$HOME/.local/share/reach/mcp/dist/version.json"
install -m 600 .reach/devices.json "$HOME/.config/reach/mcp-devices.json"
```

保留 `package.json` 的 `type: module`、全部 JS 模块及构建时生成的 `dist/version.json`，不要只复制入口文件。运行依赖均为 Node 标准库，不需复制 `node_modules`。可先执行 `python3 scripts/install-node-runtime.py` 单独安装相同的独立 runtime（支持 Mac/Linux 的 x64、arm64），再按方式 A 的结构填写本机 Node、入口和配置文件绝对路径。升级复制前先关闭客户端启动的 Connector。

若 Engine 与客户端都在同一台 Mac，也可使用 [Engine 安装器](engine_cn.md) 一并安装以上文件。

## 私有设备配置

文件必须是非空 JSON 数组：

```json
[
  {
    "id": "engine-a",
    "engineId": "engine-a",
    "gatewayUrl": "https://reach.example.com",
    "controllerToken": "<仅授权engine-a的delegated-client-token>"
  },
  {
    "id": "engine-b",
    "engineId": "engine-b",
    "gatewayUrl": "https://reach.example.com",
    "controllerToken": "<仅授权engine-b的delegated-client-token>"
  }
]
```

`id` 是客户端选择设备的别名，必须非空且唯一；它不是 Engine 心跳的身份认证字段。示例让别名与 Engine ID 一致，也可以分别配置。真正的 Engine 身份由 Gateway 与 Engine 两端配置绑定。

多个条目可以指向同一个 Gateway，并通过可选的 `engineId` 选择注册设备；不填写时访问默认 Engine。详见 [多设备部署](openwrt_cn.md)。

推荐使用 `REACH_MCP_DEVICES_FILE` 和权限 600 的设备文件。也支持 `REACH_MCP_DEVICES` 直接传 JSON 字符串，但两项不能同时设置。两者都省略时默认为 `local-engine` 与 `http://127.0.0.1:8787`，仅适合本地回环开发。

## 环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `REACH_MCP_DEVICES_FILE` | 无 | 私有设备 JSON 的路径，建议绝对路径 |
| `REACH_MCP_DEVICES` | 无 | 设备数组的 JSON 字符串，与文件配置二选一 |
| `REACH_MCP_TOOL_MODE` | `dynamic` | `dynamic` 或 `static` |
| `REACH_MCP_READY_TIMEOUT_MS` | `150000` | 等待 Engine ready 的总预算 |
| `REACH_MCP_READY_POLL_MS` | `200` | 就绪轮询间隔；安装器可设置为 `1000` |
| `REACH_MCP_RENEW_SKEW_MS` | `60000` | 租约接近过期时提前续租的窗口 |
| `REACH_MCP_REQUEST_TIMEOUT_MS` | `35000` | 单次 HTTP 请求总时限，包含响应体读取 |

时间变量单位为毫秒，必须为正整数。默认 150 秒就绪预算覆盖 Engine 的默认 120 秒空闲心跳；调小 Gateway 心跳间隔时仍应保留连接建立余量。

## 首次使用与工具列表

动态模式初始化展示 `list_devices`、`get_versions`、`pick_device`、`list_workspaces`：

1. 调用 `list_devices` 查看配置条目。
2. 调用 `list_workspaces`，参数为 `{"deviceId":"engine-a"}`；Connector 选择设备、打开会话并等待 Engine ready，然后返回工作区名称和执行许可列表。
3. Connector 发出工具列表变化通知；客户端刷新后获得 `fs.read`、`fs.write`、`fs.edit`、`fs.list`、`fs.glob`、`fs.stat`、`fs.grep`、`process.run`、`process.status`、`process.logs`、`process.stop`、`process.list` 与 `session.close`。
4. 将发现的名称传给文件或进程工具。也可先用 `pick_device` 连接，再调用 `list_workspaces`。
5. 完成操作后调用 `session.close`，回到设备选择状态。

假设发现的文件工作区包含 `notes`，文件工具示例参数：

```json
{
  "workspace": "notes",
  "path": "notes/example.txt",
  "content": "Reach MCP example",
  "mode": "create"
}
```

这是 `fs.write` 的参数，`mode: create` 要求目标文件尚不存在。`fs.edit` 使用 `oldString`、`newString` 字段。写入与编辑会先自动申请所需路径和方法的 grant，不需要手动调用授权 API；自动 grant 不代表人工批准，也无法扩大客户端策略。操作映射、错误形态、会话归属和原子写撤销边界见 [客户端权限](client-access_cn.md)。

若客户端不刷新动态列表，在 `env` 中加入 `"REACH_MCP_TOOL_MODE": "static"` 并重新启动 Connector。静态模式从初始化起展示文件和进程工具，每次文件、进程操作及关闭会话都需要 `deviceId`，例如：

```json
{
  "deviceId": "engine-a",
  "workspace": "notes",
  "path": "notes/example.txt"
}
```

静态模式的文件工具和 `process.run` 会按 `deviceId` 选择设备并建立或复用会话。`process.status/logs/stop/list` 仅访问当前已选设备会话拥有的任务，不会自动连接其他设备；没有匹配的自有会话时返回 `PROCESS_NOT_FOUND`。`session.close` 只关闭已选设备的自有会话，对其他已配置设备返回 `closed: false`、`owned: false`，不会为关闭操作新建连接。

## 生命周期与检查

Connector 在调用文件工具和 `process.run` 前检查会话、按需重建或续租；进程观察和控制工具保持已有任务的会话归属。切换设备会先关闭旧会话。客户端关闭 stdin 后，Connector 等待已收到的请求处理完毕，再关闭自己持有的会话。

状态观察可在总预算内重试临时网络中断；文件 RPC、grant 和会话变更不会自动重放。写入丢失响应时先确认文件结果。不要同时让多个客户端抢占同一个 Engine 的会话；不同 Engine 的会话互相隔离。

手工直接运行 `node .../dist/main.js` 后没有输出是正常的：stdio 服务在等待 MCP 输入。客户端诊断看 stderr；部署验收使用 [verification.md](verification_cn.md) 中安装后 MCP 验证。文件工具读取的是 Engine 工作区，Connector 本身只读取自己的私有配置。


## 脚本任务

新增 `process_run/status/logs/stop/list` HTTP 工具，均要求 `deviceId`。stdio 使用 `process.run/status/logs/stop/list`；dynamic 模式操作已选设备，static 模式要求 `deviceId`。它们通过 Gateway 在目标 Engine 上执行，使用该设备的私有 Node runtime。执行默认关闭，配置和调用示例见 [脚本任务](processes_cn.md)。

HTTP `session_close` 保留 `closedDeviceId`，并返回 `closed` / `owned`：成功关闭自己的会话为 `true` / `true`；无会话的幂等调用为 `false` / `false`。他人或替代会话返回 `ENGINE_BUSY`，不会被关闭。
