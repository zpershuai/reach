# 部署故障排查

按“公网入口 → Gateway → Engine → 会话 → MCP 工具”逐层检查。优先保存错误码、时间、会话状态和 stderr，诊断记录不包含 token 或含 session token 的完整 WSS URL。

## 快速定位

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| 域名解析失败或证书错误 | DNS 错误、AAAA 指向错误主机、443 不通、Caddy 证书问题 | 核对 DNS、代理与证书日志；不要关闭 TLS 校验 |
| 公网 502，回环也失败 | 容器未启动、映射端口错误、启动配置异常 | 看 Compose 状态和日志，检查 `127.0.0.1:28787/healthz` |
| 回环成功，公网 502/404 或协议不符 | Caddy 指向旧服务或其他端口、错误路径 | 只校正 Reach 站点到 28787，并 validate/reload |
| Gateway 启动立即失败 | 缺认证字段、token 太短或相同、非法整数 | 检查私有 env 的键和值约束，不打印凭证 |
| 控制 API 401 | 未带 token、使用 Engine token、旧凭证、轮换未同步 | MCP 使用当前 Gateway 的 Controller token |
| 心跳 401 | Engine token 不匹配 | 同步 Gateway 与 Engine 私有配置并重新加载 |
| 心跳 403 | Engine ID 不匹配 | 同步两端 `REACH_ENGINE_ID` |
| healthy，但选设备一直等待 | Mac 睡眠/离线、Engine 未运行、还没到心跳、认证失败 | 查看 LaunchAgent 和两类日志，检查 15/120 秒心跳设置 |
| 会话 409 | 其他 Controller 占用、旧 ID、不 ready、重复请求 ID | 看具体响应和会话归属，不盲目关闭别人的会话 |
| 会话或 RPC 503 | 转发队列满、连接中断、控制投递或执行超时 | 查 Gateway/Engine 同时刻日志，恢复新会话 |
| HTTP 413 | 超过 64 KiB 请求体限制 | 减小请求，不只修改 Caddy 限制 |
| 已选设备但看不到文件工具 | 客户端忽略列表变化通知 | 刷新工具列表，或改静态模式并重启 Connector |
| MCP JSON 解析失败 | stdout 被构建日志或 wrapper 提示污染 | 使用 Node 直接运行编译入口，日志写 stderr |
| 文件 `PERMISSION_DENIED` | 无效 grant、越界、符号链接或系统权限 | 检查工作区与目标路径，写入经 Connector 自动授权 |
| 写入超时、结果不确定 | 操作已执行但响应丢失，或在提交边界超时 | 重连后读文件/revision，再决定是否发起新的写入 |

HTTP 409/503 是状态码分类，实际错误应以响应体为准；不会所有 409 都代表别的客户端占用。

## 网络与 Caddy

在本地检查公网，在 VPS 检查回环：

```bash
curl --fail --silent --show-error https://reach.zpershuai.top/healthz
ssh root@zpershuai.top 'curl --fail --silent --show-error http://127.0.0.1:28787/healthz'
ssh root@zpershuai.top 'journalctl -u caddy -n 80 --no-pager'
ssh root@zpershuai.top 'caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'
```

当前 `mcp.zpershuai.top` 仍路由到旧 MCP 服务，不是新版 stdio Connector 的入口。新版客户端设备 URL 使用 `https://reach.zpershuai.top`。

不能将 Engine base URL 配成 `/session`、带业务前缀或重定向入口。Engine 和 Connector 不跟随认证请求的重定向；WSS endpoint 必须属于配置 origin。若使用额外 CDN/代理，需确认它支持 WSS 升级、保持路径与连接时限，不能仅靠首页可访问判断。

## Gateway 与认证

```bash
ssh root@zpershuai.top 'cd /srv/reach-current/deploy && docker compose ps'
ssh root@zpershuai.top 'cd /srv/reach-current/deploy && docker compose logs --tail 100 gateway'
```

容器内运行 `0.0.0.0:8787`，宿主检查端口为 `127.0.0.1:28787`。旧部署仍可能占用宿主回环 8787；检查错端口会得到另一套协议和认证结果。

修改 env 后只 `restart` 容器不能生效，使用 `up -d gateway` 重建环境。不要运行会输出完整环境变量的诊断命令并把输出贴到聊天。认证完整验收用 [verify-remote.mjs](verification.md)，它只报告检查结果。

## Engine 后台启动

```bash
launchctl print "gui/$(id -u)/top.zpershuai.reach-engine"
tail -n 80 "$HOME/.local/share/reach/engine.log"
tail -n 80 "$HOME/.local/share/reach/engine-error.log"
```

没有服务条目时检查 plist 是否存在、当前用户是否登录以及安装器是否使用同一用户执行。不断退出时检查 `engine.env` 格式、URL、token 字符集、超时变量与工作区权限。配置含空格时必须正确 shell 引用。

如果 env 与命令行同时指定 Gateway URL，Engine 会拒绝启动。远程 HTTP 会被拒绝；应使用有效 HTTPS。日志里的网络退避说明连接失败后仍在尝试，不需要不断重新安装服务。

## 会话与心跳

Engine 空闲阶段只有心跳，Controller 发起 open 后，下次心跳才触发 WSS。当前心跳间隔 15 秒，默认源码值 120 秒；因此不能要求选择设备后立即 ready。

session token 单次有效且 30 秒过期。不要复制 token 手动重复连接或把旧 WebSocket 当作可恢复会话。Gateway/Engine 重启、租约到期或旋转后应打开新会话；旧 grant 可能已失效。

多客户端测试前让前一个客户端 `session.close` 或正常退出。不要为排查 409 直接重启生产服务。RPC 队列有上限，文件工具在 Engine 串行执行；大量并发请求可能返回过载或超时，减少并发并检查文件操作耗时。

## MCP 启动与工具

确认客户端配置使用实际绝对路径，不依赖 GUI 程序继承交互 shell PATH。升级 Node 后旧绝对路径可能失效，更新客户端 `command` 或重新生成安装配置。

`REACH_MCP_DEVICES` 与 `REACH_MCP_DEVICES_FILE` 不能同时设置；设备 JSON 顶层是数组，ID 必须唯一，token 至少 32 字符。配置正确但 stdout 没有输出，可能只是等待 MCP 请求，不能据此判断进程卡死。

动态模式只有成功 `pick_device` 后才出现文件工具；静态模式每次文件工具调用都需 `deviceId`。更改模式、设备 JSON 或客户端环境后重启 Connector。

安装后的 MCP 验证器固定要求动态模式、`mcpServers.reach`、匹配 Engine ID 的设备别名和本机工作区路径；不满足这些前置条件时，先修正验证配置，见 [verification.md](verification.md)。

## 文件结果

路径相对工作区，`fs.edit` 字段是 `oldString`、`newString`。`fs.read` 是按行返回内容，末尾换行不包含在返回文本中；需要逐字节证明时查看真实文件或使用验收器的落盘核对。`grep`/`glob` 的相对路径需结合所传搜索根理解。

没有删除文件 RPC，验收器会保留测试文件。文件找不到时先检查设备、工作区名和相对路径，不要修改根目录来绕过错误。写入已经提交但客户端超时时，可先 `fs.stat`/`fs.read` 检查内容和 revision；改变请求 ID 再重放不提供持久的 exactly-once 保证。
