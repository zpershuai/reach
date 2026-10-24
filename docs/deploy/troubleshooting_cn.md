# 部署故障排查

[English](troubleshooting.md) | 简体中文

按“公网入口 → Gateway → Engine → 会话 → MCP 工具”逐层检查。优先保存错误码、时间、会话状态和 stderr，诊断记录不包含 token 或含 session token 的完整 WSS URL。

## 快速定位

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| 域名解析失败或证书错误 | DNS 错误、AAAA 指向错误主机、443 不通、Caddy 证书问题 | 核对 DNS、代理与证书日志；不要关闭 TLS 校验 |
| 公网 502，回环也失败 | 容器未启动、映射端口错误、启动配置异常 | 看 Compose 状态和日志，检查 `127.0.0.1:28787/healthz` |
| 回环成功，公网 502/404 或协议不符 | Caddy 指向旧服务或其他端口、错误路径 | 只校正 Reach 站点到 28787，并 validate/reload |
| Gateway 启动立即失败 | 缺认证字段、token 太短或相同、非法整数 | 检查私有 env 的键和值约束，不打印凭证 |
| 控制 API 401 | 未带 token、使用 Engine token、旧凭证、轮换未同步 | 检查 scoped delegated/OAuth token 的到期、撤销和当前权限；Owner token 仅供可信管理 |
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
curl --fail --silent --show-error https://reach.example.com/healthz
ssh deploy@gateway.example.com 'curl --fail --silent --show-error http://127.0.0.1:28787/healthz'
ssh deploy@gateway.example.com 'journalctl -u caddy -n 80 --no-pager'
ssh deploy@gateway.example.com 'caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'
```

MCP Connector 是本地 stdio 进程，设备 URL 应指向 Gateway 的 HTTPS 根入口，例如 `https://reach.example.com`。

不能将 Engine base URL 配成 `/session`、带业务前缀或重定向入口。Engine 和 Connector 不跟随认证请求的重定向；WSS endpoint 必须属于配置 origin。若使用额外 CDN/代理，需确认它支持 WSS 升级、保持路径与连接时限，不能仅靠首页可访问判断。

## Gateway 与认证

```bash
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose ps'
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose logs --tail 100 gateway'
```

容器内运行 `0.0.0.0:8787`，宿主检查端口为 `127.0.0.1:28787`。部署其他服务时应检查端口冲突；状态检查需使用 Compose 映射的实际端口。

修改 env 后只 `restart` 容器不能生效，使用 `up -d gateway` 重建环境。不要运行会输出完整环境变量的诊断命令并把输出贴到聊天。认证完整验收用 [verify-remote.mjs](verification_cn.md)，它只报告检查结果。

## Engine 后台启动

```bash
launchctl print "gui/$(id -u)/org.reach.engine"
tail -n 80 "$HOME/.local/share/reach/engine.log"
tail -n 80 "$HOME/.local/share/reach/engine-error.log"
```

没有服务条目时检查 plist 是否存在、当前用户是否登录以及安装器是否使用同一用户执行。不断退出时检查 `engine.env` 格式、URL、token 字符集、超时变量与工作区权限。配置含空格时必须正确 shell 引用。

如果 env 与命令行同时指定 Gateway URL，Engine 会拒绝启动。远程 HTTP 会被拒绝；应使用有效 HTTPS。日志里的网络退避说明连接失败后仍在尝试，不需要不断重新安装服务。

## 会话与心跳

Engine 空闲阶段只有心跳，Controller 发起 open 后，下次心跳才触发 WSS。空闲心跳默认 120 秒，可通过配置调小；因此不能要求选择设备后立即 ready。

session token 单次有效且 30 秒过期。不要复制 token 手动重复连接或把旧 WebSocket 当作可恢复会话。Gateway/Engine 重启、租约到期或旋转后应打开新会话；旧 grant 可能已失效。

多客户端测试前让前一个客户端 `session.close` 或正常退出。不要为排查 409 直接重启生产服务。RPC 队列有上限，文件工具在 Engine 串行执行；大量并发请求可能返回过载或超时，减少并发并检查文件操作耗时。

## MCP 启动与工具

确认客户端配置使用实际绝对路径，不依赖 GUI 程序继承交互 shell PATH。升级 Node 后旧绝对路径可能失效，更新客户端 `command` 或重新生成安装配置。

`REACH_MCP_DEVICES` 与 `REACH_MCP_DEVICES_FILE` 不能同时设置；设备 JSON 顶层是数组，ID 必须唯一，token 至少 32 字符。配置正确但 stdout 没有输出，可能只是等待 MCP 请求，不能据此判断进程卡死。

动态模式只有成功 `pick_device` 后才出现文件工具；静态模式每次文件工具调用都需 `deviceId`。更改模式、设备 JSON 或客户端环境后重启 Connector。

安装后的 MCP 验证器固定要求动态模式、`mcpServers.reach`、配置的设备别名；本机文件核对需另提供可读的工作区路径；不满足这些前置条件时，先修正验证配置，见 [verification.md](verification_cn.md)。

## 文件结果

路径相对工作区，`fs.edit` 字段是 `oldString`、`newString`。`fs.read` 是按行返回内容，末尾换行不包含在返回文本中；需要逐字节证明时查看真实文件或使用验收器的落盘核对。`grep`/`glob` 的相对路径需结合所传搜索根理解。

没有删除文件 RPC，验收器会保留测试文件。文件找不到时先检查设备、工作区名和相对路径，不要修改根目录来绕过错误。写入已经提交但客户端超时时，可先 `fs.stat`/`fs.read` 检查内容和 revision；改变请求 ID 再重放不提供持久的 exactly-once 保证。

## 断线、超时与恢复

Reach 不会自动重放任何会修改状态的操作。下列行为由真实 Engine 集成测试 `recovery.test.ts` 覆盖。

| 情况 | 系统行为 | 恢复步骤 |
| --- | --- | --- |
| Engine token 被轮换或撤销 | Engine 日志 `HEARTBEAT_FAILED` 并退避重试，设备保持离线，不会获得会话 | 在私有配置中同步新 token 后重启 Engine；不要把 token 写进工单 |
| `process_run` 响应丢失 | 任务可能已经启动 | 在同一会话用原 `launchId` 调用 `process_status`；用相同 launchId 和完全相同参数重发只会返回原任务，参数不同返回 `LAUNCH_ID_CONFLICT`。若返回 `PROCESS_NOT_FOUND` 才可重发 |
| 任务超时或 `process_stop` | 状态变为 `timed_out` / `stopped`，同进程组的普通后代被终止 | 读取 `process_logs` 判断进度；需要再次执行时使用新 launchId |
| 会话关闭、租约到期或连接断开 | Engine 停止该会话拥有的任务及普通后代；新会话无法查询旧任务（`PROCESS_NOT_FOUND`） | 重新打开会话；先读取文件和 revision 确认实际状态，再决定是否重新执行 |
| Gateway 重启 | 内存中的会话和 grant 全部失效，Engine 自动重新心跳；不会恢复或重放旧会话 | 重新打开会话并申请新 grant；用旧 grant 写入返回 `PERMISSION_DENIED` |
| 写入超时 | 写入可能已经越过原子提交点 | 先 `fs_stat`/`fs_read` 核对 revision，再用 `ifMatch` 决定是否写入 |
| `closureReason: unsupported_protocol` | Engine 与 Gateway 的线协议版本不兼容，会话立即关闭，未转发任何请求 | 按[兼容矩阵](versions_cn.md#兼容矩阵与升级顺序)先升级 Gateway，再升级 Engine |

Engine 被操作系统强制杀死，或可信脚本主动脱离进程组时，不在上述清理保证内；在 Engine 账户下检查残留进程。

## 私有设置与诊断边界

自动 setup token 不在日志中；按 [控制台首次设置](console_cn.md#启用与首次设置) 私有读取 `REACH_DATA_DIR/admin-setup-token`。不要把 env dump、数据库、cookies、完整 WSS URL、文件正文、脚本参数或进程输出贴到公开问题。公开工单仅提供组件版本、操作名称、稳定错误码、脱敏时间和 synthetic 重现步骤；漏洞走 [SECURITY](../../SECURITY.md) 的私密渠道。

| 稳定诊断 | 排查方式 |
| --- | --- |
| `GATEWAY_CONFIGURATION_INVALID: <说明>` / `CONFIGURATION_INVALID` | 说明会指出出错的设置名（如 `GATEWAY_PORT`、`REACH_ENGINES_FILE`、`REACH_DATA_DIR`），不包含它的值；私有检查该设置，不公开原始配置 |
| `GATEWAY_STARTUP_FAILED: <错误类型>` | 非配置类启动错误只报告类型；私有检查环境、注册表和数据目录 |
| `HEARTBEAT_FAILED` / `SESSION_CONNECT_FAILED` | 核对 Gateway 可达性、可信证书链和主机名；不关闭证书检查，不跟随认证入口的重定向 |
| `SESSION_PROTOCOL_UNSUPPORTED` | Engine 的协议版本不被当前 Gateway 支持；核对两端版本并按兼容矩阵升级 |
| `SESSION_PROTOCOL_INVALID` / `SESSION_READ_FAILED` | 核对版本、连接状态和协议；重新建立会话，不重放不确定写入 |
| `PROCESS_CLEANUP_FAILED` / `SESSION_CLEANUP_FAILED` | 保留旧归属，等待清理重试；核对 Engine 账户是否有停止其任务的权限，不强占或关闭其他客户端任务 |
| `NODE_RUNTIME_INSTALL_FAILED` / `ENGINE_INSTALL_FAILED` | 私有检查目标目录、可信资产和完整性；使用备份/恢复流程，不把底层错误或环境变量公开 |
| `PERMISSION_DENIED` / 隐藏设备 404 | Owner 在 Clients 查看身份策略，核对 Engine、工作区和操作权限；修改标签不能解决授权问题 |

HTTP 诊断仅记录已知路由、方法、状态与耗时，不记录查询参数或动态路径标识。Engine 使用有界事件和稳定错误码，不把上游错误正文复制到日志；Connector stdout 仍专供 JSON-RPC。管理员 activity audit 包含选定元数据与服务端 principal，显示标签仍未验证。诊断压缩不改变授权读取的文件正文或 `process.logs` 返回内容；这些内容只应交付有权限的调用方。

Gateway 是可信中继，能看到所转发的 RPC 内容；审计不保存正文并不意味着 Gateway 看不到正文。Node 执行只适合可信脚本，使用 Engine 账户的系统权限，工作区路径限制不构成脚本沙箱。
