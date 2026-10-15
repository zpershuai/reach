# 组件版本与更新

MCP、Engine、Gateway 各自维护独立的 SemVer 发布版本，当前 Engine 为 `0.2.2`，Gateway 为 `0.5.0`，独立 stdio MCP Connector 为 `0.4.0`。修复递增 patch，向后兼容的功能递增 minor，破坏性变更递增 major。版本不要求同步递增；一次发布只更新实际变更的组件。

Gateway `0.5.0` 和 stdio MCP `0.4.0` 新增 `list_workspaces({deviceId})`，从 Engine 就绪元数据返回文件工作区名称和 `processWorkspaces` 执行许可列表。Gateway 同时修复 OAuth 客户端在多次 MCP 初始化之间的 Engine 会话归属，支持每次工具调用创建新 MCP 会话的客户端。Engine `0.2.2` 随本次发布重建，继续使用现有工作区元数据协议，无需修改工作区配置。

Gateway `0.4.0` 新增 MCP OAuth 授权，支持动态客户端注册、S256 PKCE、密码与二次验证批准、轮换刷新令牌和控制台撤销应用授权。启用控制台并完成管理员设置后即可使用；原有 Controller token 和旧 Engine 保持兼容，接入步骤见 [MCP 配置](mcp.md#chatgpt-等-oauth-客户端remote-http)。

| 组件 | 版本的唯一维护位置 | 产物中的版本 |
| --- | --- | --- |
| Engine | `crates/reach-rpc/Cargo.toml` 的 `[package].version` | 构建时通过 `CARGO_PKG_VERSION` 编入二进制 |
| Gateway | `packages/reach-rpc/package.json` 的 `version` | npm 构建生成的 `dist/version.json` |
| MCP | `packages/grok-bot-mcp-connector/package.json` 的 `version` | npm 构建生成的 `dist/version.json` |

`reach-rpc/1.0` 和 MCP 的 `2025-03-26` 是协议版本，分别约束通信格式。组件升级不自动改变协议版本，也不要求两端组件发布号完全相同。Node runtime 的版本由 `scripts/node-runtime.json` 单独维护。

## 查看实际产物的版本

以下命令只输出版本号，不启动服务，也不加载私有服务配置：

```bash
"$HOME/.local/share/reach/engine" --version
"$HOME/.reach/runtime/node/bin/node" "$HOME/.local/share/reach/mcp/dist/main.js" --version
"$HOME/.reach/runtime/node/bin/node" packages/reach-rpc/dist/gateway-main.js --version
```

三个入口也支持 `-V`。Engine 安装前会查询构建产物版本；安装结束把实际安装的 `engineVersion`、`mcpVersion` 和 `nodeVersion` 写入 `~/.reach/versions.json`，未安装 MCP 时其值为 `null`。此文件描述设备端安装产物，运行中的进程仍需重新启动才能使用新版本。

Gateway 的公开 `GET /healthz` 返回 `gatewayVersion`。需要 Controller 认证的 `GET/POST /session/status` 返回 `gatewayVersion` 和 `engineVersion`。Engine 在心跳和 `session.ready` 上报发布号，所以版本检查不需要专门打开会话。

MCP 初始化响应的 `serverInfo.version` 返回当前 MCP 产物版本。所有工具模式均提供 `get_versions`：

```json
{"deviceId":"engine-a"}
```

示例结果：

```json
{
  "mcpVersion": "0.4.0",
  "deviceId": "engine-a",
  "gatewayVersion": "0.5.0",
  "engineVersion": "0.2.2"
}
```

查询只读取状态，不会选择设备、打开或关闭会话。省略 `deviceId` 时查询已选设备；未选设备时只返回本地 MCP 版本，远端字段为 `null`。旧 Gateway 或旧 Engine 未上报版本时对应字段也为 `null`，不会假设它与本机版本相同。网络或认证失败返回工具错误。

`engineVersion` 是 Gateway 最后收到的 Engine 发布号，不表示 Engine 当前在线。Gateway 重启后，在收到第一条心跳或就绪消息前它为 `null`；设备离线后可能仍保留最后上报的版本。

## 更新发布版本

更新 Gateway 或 MCP 的包版本，例如：

```bash
npm --prefix packages/reach-rpc version 0.5.0 --no-git-tag-version
npm --prefix packages/grok-bot-mcp-connector version 0.4.0 --no-git-tag-version
```

仅对实际更新的组件执行相应命令。Gateway 的 npm lockfile 由 npm 同步更新。Engine 修改 Cargo manifest 后运行 `cargo check --workspace` 更新 `Cargo.lock` 中的包版本。

随后重新构建目标组件、运行 `bash scripts/verify.sh`，按 [运维与回滚](operations.md) 更新安装产物或 Gateway 容器。Gateway/MCP 发布时必须携带整个构建输出，包括 `dist/version.json`；只修改包清单不会改变已有 JS 产物报告的版本。MCP 安装器会复制版本模块和版本 JSON。

升级后通过 CLI、`get_versions` 或 Gateway 状态确认版本。除现有构建和安装流程外，也可选择下述 GitHub Release 自动更新。

## GitHub Release 发布

提交组件版本及对应 lockfile 后，推送与 manifest 一致的 `engine-vX.Y.Z` 或 `gateway-vX.Y.Z` 标签。标签不匹配、验证失败或缺少必需资产时 workflow 失败；普通 push / pull_request 只验证，不发布 Release 或 GHCR 镜像。

| 组件 | Release 资产 |
| --- | --- |
| Engine | `engine-linux-x64-musl`、`engine-darwin-arm64`、`engine-darwin-x64` |
| Gateway | `gateway-amd64.tgz`、`gateway-image.txt`（GHCR 镜像 digest） |
| 两者 | `SHA256SUMS`，覆盖该 Release 的文件资产 |

Linux x64 Engine 是静态 musl 二进制，同一资产可用于 systemd Linux 和 x86_64 OpenWrt。macOS 使用原生 arm64 与 Intel runner，Intel runner 为 `macos-15-intel`。Gateway tarball 包含 `packages/reach-rpc/dist`、npm manifests、Compose/Dockerfile 和宿主机 helpers，不包含 systemd service/path 模板；首次安装 updater 需按 [运维步骤](operations.md#安装可选-github-release-updater) 从同一发布标签的源码取得模板并安装 helper。Gateway 镜像发布为 `ghcr.io/<owner>/reach-gateway:<X.Y.Z>`，并附组件标签别名。

发布说明来自前一个同组件标签之后的提交；没有前一个标签时包含仓库历史。生成器过滤包含 `.reach/`、env 文件名和 SSH 目标的行，发布者仍应确保提交说明不含私有库存或凭证。下载文件后，在资产目录执行 `sha256sum -c SHA256SUMS`（macOS 可用 `shasum -a 256 -c SHA256SUMS`）。

## 可选自动更新

自动更新默认关闭；仅 `REACH_UPDATE_ENABLED=1` 或 `true` 启用，并需设置 `REACH_UPDATE_REPO=example/reach`。配置详见 [配置](configuration.md)，宿主机 helper 安装与回滚见 [运维](operations.md)。检查使用分页 GitHub Releases，按组件选择最高稳定 `X.Y.Z`，忽略 draft、prerelease、相等或更旧版本。默认每小时检查，失败时只对更新器退避，不改变心跳或 HTTP 服务。

Engine 在独立后台线程下载和校验 SHA-256、`--version`，只在没有连接中、活动或 draining 会话时替换二进制，保存同目录的 `engine.prev`，退出 0 交给 LaunchAgent/systemd/procd 重新启动。存在的 `~/.reach/versions.json` 同步记录 `engineVersion`。Compose Engine 与 Gateway 则在空闲时写入共享目录的 `request.json`，由宿主机 helper 先下载、校验并准备镜像，再通过共享目录握手等待空闲、暂缓新会话并重建容器；Gateway 要求所有注册 Engine 的会话均为 `none`。未安装 helper 时只保留更新请求与日志，当前进程继续运行。

自动更新不替换独立 Node runtime，也不更新 MCP Connector。更新失败保留当前运行产物；成功更新会创建全新进程，内存会话、grant 和去重状态不会恢复，客户端需重新打开会话。
