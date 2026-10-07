# 当前部署与历史验收记录

本页记录首次部署及后续更新验收时的配置与结果，是历史快照。服务当前状态按 [运维检查](operations.md) 查询，不能仅凭本页认定实时在线。

## 2026-10-07 一个 Gateway 接入 Mac 与 OpenWrt

公网统一入口为 `https://reach.zpershuai.top`，沿用 VPS 的 `deploy-gateway-1`。新增的独立路由器 Gateway 和 Caddy 8443 路由已撤销。历史测试容器及旧服务保留，此次设备接入不使用它们。

| 组件 | 安装版本与位置 |
| --- | --- |
| Gateway | `0.2.0`，`/srv/reach-current`，额外 Engine 注册在 `deploy/engines.json` |
| Mac Engine | `0.1.0`，ID `perry-mac`，沿用 LaunchAgent 与原凭证 |
| OpenWrt Engine | `0.1.0`，ID `openwrt-router`，`/root/.reach/engine`，procd 服务 `reach-engine` 已运行并启用开机启动 |
| Mac MCP | `0.2.0`，`~/.local/share/reach/mcp`，设备文件 `~/.config/reach/mcp-devices.json` 包含两台设备 |
| Node runtime | 两台设备均为 `v24.21.0`，稳定入口 `~/.reach/runtime/node/bin/node`；路由器附带私有 musl 与 C++ 库 |

路由器为 x86_64 iStoreOS/OpenWrt，工作区是 `/root/.reach/workspace`，私有配置为 `/etc/reach/engine.env`。Rust Engine 使用静态 musl 构建，SHA256 为 `357be91085ac9ba5c4c1115d28c0ae2803927c023cdfe62607339b21f39c4800`。

验收通过 63 项 Gateway/RPC 测试、34 项 MCP 测试和 7 项 runtime 测试。公网验证确认两台 Engine 同时 ready、同一路径分别读写不同内容、跨设备 grant 被拒绝、独立续租，以及关闭路由器会话后 Mac 继续工作。已安装 MCP 也通过 stdio 实际选择两台设备、读取各自文件和查询版本，验证结束后两端会话均已关闭。私有验收记录在 `.reach/multi-engine-verification.json`。

VPS 升级前备份为 `/srv/reach-backups/20261007T004550Z-multi-engine/gateway.tgz`，旧镜像标签为 `reach-gateway:before-multi-engine`。Mac MCP 备份为 `~/.reach/backups/20261007T004623Z-multi-engine`。安装和后续添加设备步骤见 [OpenWrt 与多设备](openwrt.md)。

## 2026-10-06 Engine 与 Gateway 更新

从源码提交 `367b1f84aef561e5c4a40125f34cbd0b75f91838` 构建并替换本机 Engine 与 VPS Gateway。两端组件版本均为 `0.1.0`，已支持版本上报与查询。本机独立 Node runtime 为 `v24.21.0`，稳定入口为 `~/.reach/runtime/node/bin/node`。

| 验证 | 当次结果 |
| --- | --- |
| VPS Gateway | `deploy-gateway-1` healthy，容器 CLI 与 `/healthz` 返回 `0.1.0` |
| 本机 Engine | LaunchAgent running，PID `63389`，CLI 返回 `0.1.0`，已安装二进制摘要与 release 构建一致 |
| 公网认证及文件 RPC | 12 项通过，包括真实 Mac 文件读写、路径边界、续租、关闭与重新建立会话 |
| 在线版本查询 | Gateway 状态返回 `gatewayVersion=0.1.0`、`engineVersion=0.1.0` |
| 已有 MCP | 保留已有运行模块，启动配置切换到独立 Node runtime；初始化与工具列表检查通过 |
| 配置及会话 | 原有 Engine 配置一致，Gateway 私有配置沿用；验收结束后会话为 `none` |

本机更新前备份在仓库 `.reach/backups/20261006T124409Z/local-engine.tgz`，VPS 备份在 `/srv/reach-backups/20261006T124409Z/gateway.tgz`，旧镜像保留为 `reach-gateway:backup-20261006T124409Z`。备份包含私有配置，不提交到 Git。

无凭证更新报告为 `.reach/upgrade-verification.json`，公网 RPC 报告为 `.reach/remote-verification.json`；本机安装版本记录为 `~/.reach/versions.json`。本次没有重新执行故障注入，也没有更新 MCP 的运行模块。

| 新产物 | SHA-256 |
| --- | --- |
| Gateway Docker 镜像 ID | `8f308a2452b18e46eeda8eb9c9243570f7b74443654814759c8d8f73bbd597fe` |
| Gateway `dist/gateway.js` | `1e7ff24b02e73ce410d912c35164d1ad2a3c1598c974438d39d14f7e26bce7c2` |
| Gateway `dist/gateway-main.js` | `83453fcf3d1690239e882125c78666617de51ad4fb9d7a0b013f78335dba68b9` |
| Engine 二进制 | `69b3c0f1c0325dc56203691b40c1cff1dc1afe83848001f3c87f5efe23195708` |

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
