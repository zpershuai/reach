# Node runtime 的安装与执行边界

Rust Engine 本身不依赖、不启动 Node.js。它直接处理会话和文件 RPC；运行 Engine 不需要 `REACH_NODE_BIN` 或包含 Node 的 PATH。

Engine 安装包仍必须提供固定版本、校验过的私有 Node runtime。这是统一的安装交付策略：同一设备今后运行 Gateway 或 MCP 时，可以直接使用 `~/.reach/runtime/node/bin/node`，无需另装系统 Node。只运行 Engine 的设备上，这份 runtime 可以保持未使用状态；远端 Gateway/MCP 使用的是它们所在主机的 runtime。

## 实际启动入口

Gateway 和 MCP 是 Node 程序，应直接用私有 Node 启动，或使用安装器提供的 `run-node.sh`。它兼容 POSIX sh，可用于没有 Bash 的 OpenWrt：

```sh
"$HOME/.reach/runtime/node/bin/node" /absolute/path/to/gateway/dist/gateway-main.js
"$HOME/.reach/runtime/node/bin/node" /absolute/path/to/mcp/dist/main.js
```

macOS/Linux 安装后的 launcher 位于 `~/.local/share/reach/run-node.sh`；OpenWrt 位于 `/root/.reach/run-node.sh`。例如，在 OpenWrt 上运行已复制到设备的 JS 产物：

```sh
sh /root/.reach/run-node.sh /absolute/path/to/gateway/dist/gateway-main.js
sh /root/.reach/run-node.sh /absolute/path/to/mcp/dist/main.js
```

`REACH_NODE_BIN` 仅供这个 launcher 选择可执行程序，可按需覆盖默认路径；不是 Rust Engine 或已启动的 JS 进程读取的配置。MCP 客户端通过 `command` 字段选择 Node，设置进程环境变量不能切换已经启动的解释器。仓库中的 `sh scripts/start-gateway.sh` 也使用同一个 launcher。

## OpenWrt 为何要求 bundle

OpenWrt 安装器保留统一的 runtime 交付约定，因此需要预先准备的 Node bundle。它附带私有 musl/C++ 库和匹配目标路径的加载器，避免依赖设备系统库或现场下载。安装器校验摘要后安装 runtime 和 launcher，并用实际 Node 查询安装版本。bundle 缺失或损坏会中止安装，这是交付完整性检查，不表示 Rust Engine 有 Node 执行依赖。

安装器不会自动启动 Gateway 或 MCP。只有用户在该设备上部署这些 JS 组件时，才会持续使用这份 runtime。具体构建与安装步骤见 [OpenWrt](openwrt.md)、[Linux](linux.md)、[macOS](engine.md) 和 [MCP](mcp.md)。
