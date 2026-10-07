# 组件版本与更新

MCP、Engine、Gateway 各自维护独立的 SemVer 发布版本，当前 Engine 为 `0.2.1`，Gateway 与 MCP 为 `0.3.1`。修复递增 patch，向后兼容的功能递增 minor，破坏性变更递增 major。版本不要求同步递增；一次发布只更新实际变更的组件。

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
  "mcpVersion": "0.3.1",
  "deviceId": "engine-a",
  "gatewayVersion": "0.3.1",
  "engineVersion": "0.2.1"
}
```

查询只读取状态，不会选择设备、打开或关闭会话。省略 `deviceId` 时查询已选设备；未选设备时只返回本地 MCP 版本，远端字段为 `null`。旧 Gateway 或旧 Engine 未上报版本时对应字段也为 `null`，不会假设它与本机版本相同。网络或认证失败返回工具错误。

`engineVersion` 是 Gateway 最后收到的 Engine 发布号，不表示 Engine 当前在线。Gateway 重启后，在收到第一条心跳或就绪消息前它为 `null`；设备离线后可能仍保留最后上报的版本。

## 更新发布版本

更新 Gateway 或 MCP 的包版本，例如：

```bash
npm --prefix packages/reach-rpc version 0.3.1 --no-git-tag-version
npm --prefix packages/grok-bot-mcp-connector version 0.3.1 --no-git-tag-version
```

仅对实际更新的组件执行相应命令。Gateway 的 npm lockfile 由 npm 同步更新。Engine 修改 Cargo manifest 后运行 `cargo check --workspace` 更新 `Cargo.lock` 中的包版本。

随后重新构建目标组件、运行 `bash scripts/verify.sh`，按 [运维与回滚](operations.md) 更新安装产物或 Gateway 容器。Gateway/MCP 发布时必须携带整个构建输出，包括 `dist/version.json`；只修改包清单不会改变已有 JS 产物报告的版本。MCP 安装器会复制版本模块和版本 JSON。

升级后通过 CLI、`get_versions` 或 Gateway 状态确认版本。当前提供版本标识、查询与安装记录；更新仍由现有构建和安装流程完成。
