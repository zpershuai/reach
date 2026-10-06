# 当前部署与历史验收记录

本页记录 2026-10-05 部署验收时的配置和结果，是历史快照。编写文档时未重新执行远端发布或故障注入；服务当前状态按 [运维检查](operations.md) 查询，不能仅凭本页认定实时在线。

## VPS Gateway

| 项目 | 值 |
| --- | --- |
| 公网入口 | `https://reach.zpershuai.top` |
| SSH | `root@zpershuai.top` |
| VPS | Debian 13，验收时 IP `142.248.137.229` |
| 发布根目录 | `/srv/reach-current` |
| Compose | `/srv/reach-current/deploy/compose.yaml` |
| 私有配置 | `/srv/reach-current/deploy/gateway.env`，600 |
| 镜像标签 | `reach-gateway:current` |
| 容器 | `deploy-gateway-1` |
| 端口 | 容器 8787，宿主 `127.0.0.1:28787` |
| HTTPS 代理 | 现有系统 Caddy，`/etc/caddy/Caddyfile` |
| Engine ID | `perry-mac` |
| 空闲心跳间隔 | 15 秒 |

Reach Caddy 站点代理至 `127.0.0.1:28787`。验收时 Docker/Caddy 均 active、enabled，Gateway 容器 healthy，重启策略为 `unless-stopped`。Gateway 认证为独立 Controller/Engine bearer token，grant 与会话在内存。

## Mac Engine 与 MCP

| 项目 | 值 |
| --- | --- |
| Engine 二进制 | `/Users/perry/.local/share/reach/engine` |
| 启动 wrapper | `/Users/perry/.local/share/reach/start-engine.sh` |
| Engine env | `/Users/perry/.config/reach/engine.env`，600 |
| LaunchAgent | `/Users/perry/Library/LaunchAgents/top.zpershuai.reach-engine.plist` |
| 服务 label | `top.zpershuai.reach-engine` |
| 工作区 | `default` → `/Users/perry/.reach/workspace` |
| 标准输出 | `/Users/perry/.local/share/reach/engine.log` |
| 标准错误 | `/Users/perry/.local/share/reach/engine-error.log` |
| MCP 运行目录 | `/Users/perry/.local/share/reach/mcp/` |
| MCP 设备配置 | `/Users/perry/.config/reach/mcp-devices.json`，600 |
| MCP 客户端配置 | `/Users/perry/.config/reach/mcp.json`，600 |

LaunchAgent 设置 `RunAtLoad`、`KeepAlive`；生成的 MCP 配置使用安装时找到的 Node 绝对路径和 1000 ms ready 轮询间隔。配置已生成、stdio MCP 已验证，未替某个具体 MCP 客户端自动注册。

## 本地部署材料

仓库 `.reach/` 为私有、Git 忽略目录，配置目录模式 700。`deployment.json`、`gateway.env`、`engine.env`、`devices.json` 保存部署参数与凭证，模式 600；不得复制原文到文档或提交 Git。

无凭证验证报告为 `.reach/remote-verification.json`、`.reach/mcp-verification.json`、`.reach/recovery-verification.json`。工作区中保留 `deployment-tests/` 和 `mcp-tests/` 验收文件。

## 2026-10-05 验收结果

时间均为 Asia/Shanghai（UTC+8）。

| 验证 | 当次结果 |
| --- | --- |
| 完整 `bash scripts/verify.sh` | Rust 89、Gateway/RPC 58、MCP 29，共 176 项通过；两组协议校验通过 |
| 公网认证与文件 RPC | 12 项通过，21:41:00 |
| 已安装 stdio MCP | 初始化/设备选择/动态工具、实际文件读写编辑、关闭会话通过，21:36:29 |
| 活动会话中重启 Gateway | 新 WSS 会话与原有 Mac 文件读取通过 |
| 活动会话中 SIGKILL Engine | launchd 拉起新 PID，重新建立会话与文件读取通过，21:38:51 |
| 权限与产物 | 私有配置 600，VPS JS、Mac Engine、MCP 运行文件与构建一致 |

故障测试 Engine PID 从 `11394` 变为 `14438`，仅为当次观测值。验收结束后会话已关闭，Engine 恢复正常心跳。

## 当次发布产物 SHA-256

| 产物 | SHA-256 |
| --- | --- |
| Gateway Docker 镜像 ID | `d5cd0dc9649cf7636d7383ddf915b7d04e1e7048ff6708a541cceceb498c0892` |
| Gateway `dist/gateway.js` | `2544bb6808f556b46001de1b66df4153ce89eaa6881c0b3a053f1c8368eb709f` |
| Gateway `dist/gateway-main.js` | `f79cc26edbf6c03a35d400d10bfd4dd456cb9b9f7f015a01562e781dc04543ca` |
| Engine 二进制 | `abb335d604ab0944dc89722396bf962bc1bbc828544b4b065405a61cedd27389` |

后续构建、基础镜像或依赖变化都可能改变摘要。验收记录应随每次发布追加或更新，不用这组历史摘要要求所有新版本相同。

## 保留的旧部署

| 项目 | 保留情况 |
| --- | --- |
| 旧目录 | `/srv/reach` |
| 旧主容器 | `reach-app-1`，回环端口 8787 与 8741 |
| 旧测试容器 | `reach-plan07-test`，回环端口 18787 |
| 切换前 Caddy 备份 | `/etc/caddy/Caddyfile.before-reach-20261005T130413Z` |
| 原有 MCP 域名 | `mcp.zpershuai.top` → `127.0.0.1:8741`，未修改 |
| 原有 API 域名 | `api.zpershuai.top` → `127.0.0.1:23030`，未修改 |

旧部署保留 Ed25519 Engine 请求签名和 Agent assertion 认证实现；当前版没有复用这套认证。新版 stdio MCP 访问 Reach Gateway，不走旧 MCP 域名。跨架构回退先检查旧服务和凭证，再调整 Caddy 的 Reach 站点，见 [回滚流程](operations.md)。
