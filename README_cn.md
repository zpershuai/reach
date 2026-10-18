# Reach

[English](README.md) | 简体中文

**自托管的远程 MCP 网关，让云端 AI Agent 安全地访问你自己设备上的文件和脚本。** 设备只发起出站连接；每个会话都是可续约的租约；每次修改都需要限定范围的授权（grant）；所有调用都可以审计。

[![Verify](https://github.com/zpershuai/reach/actions/workflows/verify.yml/badge.svg)](https://github.com/zpershuai/reach/actions/workflows/verify.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## 为什么需要 Reach

AI Agent 越来越多地运行在云端（ChatGPT、Grok、各类托管 Agent 平台），而它们需要的文件还在 NAT 后面的笔记本、家用服务器和路由器上。常见做法是在 filesystem MCP 服务前面加一条隧道。这样文件确实能访问到，但设备多了一个暴露的入口，所有调用方拥有同样的无限制权限，事后也无法追查是谁写了什么。

Reach 在你自己控制的服务器上运行一个轻量的 Gateway，在每台设备上运行一个 Rust Engine：

- **只出站。** Engine 通过 HTTPS 轮询 Gateway，只有 Agent 请求时才建立 WebSocket。不需要入站端口，也不需要端口转发。
- **用租约代替常开连接。** Agent 打开会话、按时续约、用完关闭。Engine 自己也会执行租约、空闲和轮换的上限，作为兜底。
- **每次修改都要 grant。** 写入和脚本执行都要带一个短时有效的 grant，它限定了工作区、路径和方法。读操作不会因为共用同一个会话就获得写权限。
- **加固的文件访问。** Unix 上的文件访问不跟随符号链接，并且基于目录描述符做相对操作。读取、目录遍历、响应和写入都有严格的大小和深度上限。写入是原子的，并保留文件权限位。
- **多设备，一个入口。** 一个 Gateway 可以路由到多个 Engine（macOS、Linux、OpenWrt），每个 Engine 有独立的凭证、会话和 grant。
- **便于运维。** 可选的 Web 控制台提供管理员登录、设备注册、实时拓扑、只记录元数据的操作审计，以及 OAuth 应用管理。

Engine 0.3.0 支持通过本机 JSON 文件动态调整工作区，无需重启。文件格式、重载行为和 Gateway 优先升级顺序见 [Engine 部署](docs/deploy/engine.md)。

## 架构

```mermaid
flowchart LR
    Cloud[云端 MCP 客户端<br/>ChatGPT、Grok 等] -->|HTTPS /mcp<br/>token 或 OAuth| Gateway
    Desktop[桌面 MCP 客户端] -->|stdio| Connector[Reach MCP Connector] -->|HTTPS| Gateway
    subgraph 你控制的服务器
      Gateway[Reach Gateway<br/>会话 · 授权 · 审计]
    end
    Engine1[Mac 上的 Engine] -->|出站 HTTPS + WSS| Gateway
    Engine2[Linux / OpenWrt 上的 Engine] -->|出站 HTTPS + WSS| Gateway
    Engine1 --> W1[(工作区)]
    Engine2 --> W2[(工作区)]
```

| 组件 | 语言 | 运行位置 | 职责 |
| --- | --- | --- | --- |
| Gateway | TypeScript（Node 24） | 服务器或 VPS（Docker） | 认证、会话租约、grant、RPC 转发、`/mcp`、控制台 |
| Engine | Rust | 每台设备 | 在配置的工作区内执行 `fs.*`，以及显式启用的 `process.*` |
| MCP Connector | TypeScript | MCP 客户端所在的桌面机器 | 把 stdio MCP 调用转换成 Gateway 请求 |

MCP 工具：`list_devices`、`device_status`、`list_workspaces`、`fs_read`、`fs_list`、`fs_stat`、`fs_glob`、`fs_grep`、`fs_write`、`fs_edit`、`session_close`、`get_versions`。按工作区启用脚本执行后，还有 `process_run`、`process_status`、`process_logs`、`process_stop`、`process_list`。

## 快速上手

### A. 本地体验（约 5 分钟）

需要 Node 24 和 stable Rust。

```bash
git clone https://github.com/zpershuai/reach.git && cd reach
npm --prefix packages/reach-rpc ci --ignore-scripts

# 终端 1：Gateway，监听 127.0.0.1:8787
npm --prefix packages/reach-rpc run gateway

# 终端 2：Engine，服务 ~/.reach/workspace
cargo run -p reach-rpc --bin engine -- http://127.0.0.1:8787
```

然后打开会话、列出文件、关闭会话：

```bash
curl -sS -X POST http://127.0.0.1:8787/session/open -H 'content-type: application/json' --data '{}'
curl -sS http://127.0.0.1:8787/session/status          # 等待 "status":"ready"
curl -sS -X POST http://127.0.0.1:8787/session/rpc -H 'content-type: application/json' \
  --data '{"requestId":"r1","method":"fs.list","params":{"workspace":"default","path":"."}}'
curl -sS -X POST http://127.0.0.1:8787/session/close -H 'content-type: application/json' --data '{}'
```

带 grant 的写入、续约以及完整的控制 API，见[协议参考](docs/reference/protocol.md)（英文）。

### B. 正式部署

1. **生成凭证和配置。** 按[配置与凭证](docs/deploy/configuration.md)生成 Gateway 和 Engine 两份环境文件，使用两个互不相同的随机 token。
2. **运行 Gateway。** 从最新的 `gateway-v*` [Release](https://github.com/zpershuai/reach/releases) 下载 `gateway-amd64.tgz`，放入 `gateway.env`，执行 `docker compose -f deploy/compose.yaml up -d --build` 启动，并在前面配置 HTTPS（仓库附带 Caddy 示例）。每个版本也会发布镜像 `ghcr.io/<owner>/reach-gateway`。详见 [Gateway 部署](docs/deploy/gateway.md)。
3. **在每台设备上安装 Engine。** macOS（arm64/x64）或带 systemd 的 Linux x86_64，在本仓库目录下执行：

   ```bash
   bash scripts/install-engine.sh /path/to/engine.env
   ```

   脚本会下载适合当前平台的最新 `engine-v*` Release 二进制，用 Release 的 `SHA256SUMS` 和 `--version` 校验，然后安装为 LaunchAgent 或 systemd 服务。用 `REACH_ENGINE_VERSION=0.3.0` 可以固定版本。OpenWrt 和源码构建见 [Engine](docs/deploy/engine.md)、[Linux](docs/deploy/linux.md)、[OpenWrt](docs/deploy/openwrt.md)。
4. **连接 MCP 客户端。** 远程客户端连接 `https://<你的 Gateway>/mcp` 并使用 Controller token；不能设置静态请求头的客户端可以用 OAuth。桌面客户端也可以改用 stdio Connector。详见 [MCP 安装](docs/deploy/mcp.md)。

| 客户端 | 接入方式 | 状态 |
| --- | --- | --- |
| Grok Bot | 远程 HTTP 插件（[模板](grok-bot-plugin/README.md)） | 维护者已验证 |
| ChatGPT 连接器 | 远程 HTTP + OAuth（动态注册、PKCE） | 见 [MCP 安装](docs/deploy/mcp.md) |
| 其他 Streamable HTTP MCP 客户端 | `/mcp` + Bearer token 或 OAuth | 遵循 MCP 规范，请在自己的宿主中验证 |
| 桌面 stdio MCP 客户端 | 本地 Connector 进程 | 支持 |

部署完成后，按[部署检查清单](docs/deploy/deployment-checklist.md)验收。

## 安全模型

Reach 的前提是 Gateway 的运营者可信，而网络不可信。每个 Engine 只接受一个配置好的 Gateway 地址，明文 HTTP 只允许用于本机回环地址。token 用常量时间比较，OAuth 令牌只保存摘要。脚本执行默认关闭，只有显式列入允许名单的工作区才能执行。

对外开放之前，请先了解当前的限制：**Controller token 或已批准的 OAuth 应用可以读写所有已注册 Engine 的全部工作区。** 请像对待 SSH 私钥一样保管它。威胁模型、已知限制和漏洞报告方式见 [SECURITY.md](SECURITY.md)（英文）。

## 与常见方案对比

| | 隧道 + filesystem MCP 服务 | Reach |
| --- | --- | --- |
| 设备上的入站端口 | 通常需要（或运行隧道客户端） | 不需要，只出站 |
| 写操作逐次授权 | 无 | grant 限定工作区、路径和方法 |
| 会话生命周期上限 | 跟随连接 | 可续约租约，加上空闲和轮换上限 |
| 多设备 | 每台设备一个服务 | 一个 Gateway 管理多个 Engine |
| 审计记录 | 只有隧道日志 | 控制台记录元数据审计 |
| 部署成本 | 几分钟 | 需要一台服务器、一个域名，并在每台设备上安装 |

如果只是偶尔在可信网络里访问一台机器，用隧道更简单。Reach 适合云端 Agent 长期访问、而且需要限定和审查它们行为的场景。

## 文档

| 主题 | 链接 |
| --- | --- |
| 部署总览 | [docs/deploy/README.md](docs/deploy/README.md) |
| 配置与凭证 | [docs/deploy/configuration.md](docs/deploy/configuration.md) |
| MCP 客户端 | [docs/deploy/mcp.md](docs/deploy/mcp.md) |
| Gateway 控制台 | [docs/deploy/console.md](docs/deploy/console.md) |
| 脚本执行 | [docs/deploy/processes.md](docs/deploy/processes.md) |
| 版本与升级 | [docs/deploy/versions.md](docs/deploy/versions.md) |
| 协议与运行时参考（英文） | [docs/reference/protocol.md](docs/reference/protocol.md) |
| 规格说明 | [openspec/specs/](openspec/specs/) |

## 路线图

- 限定到特定 Engine 或工作区的 Controller token，以及只读 token
- 每个 Engine 支持多个交互会话
- 提供 Linux arm64 和 OpenWrt 的预构建 Engine
- 部署文档的英文版

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。提交 Pull Request 前请先运行 `bash scripts/verify.sh`。

## 许可证

Copyright 2026 tent zp。以 [Apache License 2.0](LICENSE) 授权。
