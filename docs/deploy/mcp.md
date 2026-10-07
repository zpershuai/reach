# Reach MCP 安装与客户端配置

Reach MCP Connector 是通用 stdio MCP 服务。支持本地 MCP 子进程的客户端启动它，通过 HTTPS 调用 Gateway，再由 Engine 执行文件工具。此组件按客户端进程生命周期运行，无需配置独立域名或常驻系统服务。

仓库路径 `packages/grok-bot-mcp-connector` 和 npm package 名保留历史命名，实际 MCP server 名为 `reach-mcp`。下面的配置可用于支持该传输方式的 MCP 客户端。

## 方式 A：使用当前 Mac 已安装的产物

当前安装生成的配置位于 `/Users/perry/.config/reach/mcp.json`。将其中 `mcpServers.reach` 合并到客户端的本地 MCP 配置，保留客户端已有的其他服务。字段结构如下：

```json
{
  "mcpServers": {
    "reach": {
      "command": "/Users/perry/.reach/runtime/node/bin/node",
      "args": ["/Users/perry/.local/share/reach/mcp/dist/main.js"],
      "env": {
        "REACH_MCP_DEVICES_FILE": "/Users/perry/.config/reach/mcp-devices.json",
        "REACH_MCP_READY_POLL_MS": "1000",
        "REACH_NODE_BIN": "/Users/perry/.reach/runtime/node/bin/node"
      }
    }
  }
}
```

每次 Engine 安装都会自动把独立 Node.js runtime 安装到 `~/.reach/runtime/node`，MCP 使用其中 `bin/node` 的固定绝对路径，不依赖 Homebrew 或系统 Node。换用户或设备时替换绝对路径。配置文件已生成，但并未自动注册到某个 MCP 客户端。客户端配置格式和重新加载方式由所用客户端决定。

MCP 初始化的 `instructions` 和 `list_devices` 工具的 description 也说明这个 runtime 的安装位置与用途。同一主机上的 Gateway、MCP 可以共用该 runtime；连接其他设备不会把远端 Node 当成本地可执行程序。

Controller token 存放在独立设备 JSON 中，不需要嵌入上述共享启动配置。确认目标客户端进程能够读取该文件，并能执行指定 Node。纯云端客户端如果不能运行本地 stdio 子进程，无法直接使用此安装方式。

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
for module in main config gateway server tools version; do
  install -m 644 "packages/grok-bot-mcp-connector/dist/$module.js" \
    "$HOME/.local/share/reach/mcp/dist/$module.js"
done
install -m 644 packages/grok-bot-mcp-connector/dist/version.json \
  "$HOME/.local/share/reach/mcp/dist/version.json"
install -m 600 .reach/devices.json "$HOME/.config/reach/mcp-devices.json"
```

保留 `package.json` 的 `type: module`、六个 JS 模块及构建时生成的 `dist/version.json`，不要只复制入口文件。运行依赖均为 Node 标准库，不需复制 `node_modules`。可先执行 `python3 scripts/install-node-runtime.py` 单独安装相同的独立 runtime（支持 Mac/Linux 的 x64、arm64），再按方式 A 的结构填写本机 Node、入口和配置文件绝对路径。升级复制前先关闭客户端启动的 Connector。

若 Engine 与客户端都在当前 Mac，也可使用 [Engine 安装器](engine.md) 一并安装以上文件。

## 私有设备配置

文件必须是非空 JSON 数组：

```json
[
  {
    "id": "perry-mac",
    "engineId": "perry-mac",
    "gatewayUrl": "https://reach.zpershuai.top",
    "controllerToken": "<当前Gateway的64字符Controller凭证>"
  },
  {
    "id": "openwrt-router",
    "engineId": "openwrt-router",
    "gatewayUrl": "https://reach.zpershuai.top",
    "controllerToken": "<同一个Gateway的Controller凭证>"
  }
]
```

`id` 是客户端选择设备的别名，必须非空且唯一；它不是 Engine 心跳的身份认证字段。当前例子沿用 Engine ID，便于阅读且满足现有验证脚本。真正的 Engine 身份由 Gateway 与 Engine 两端配置绑定。

多个条目可以指向同一个 Gateway，并通过可选的 `engineId` 选择注册设备；不填写时访问默认 Engine。详见 [多设备部署](openwrt.md)。

推荐使用 `REACH_MCP_DEVICES_FILE` 和权限 600 的设备文件。也支持 `REACH_MCP_DEVICES` 直接传 JSON 字符串，但两项不能同时设置。两者都省略时默认为 `local-engine` 与 `http://127.0.0.1:8787`，仅适合本地回环开发。

## 环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `REACH_MCP_DEVICES_FILE` | 无 | 私有设备 JSON 的路径，建议绝对路径 |
| `REACH_MCP_DEVICES` | 无 | 设备数组的 JSON 字符串，与文件配置二选一 |
| `REACH_MCP_TOOL_MODE` | `dynamic` | `dynamic` 或 `static` |
| `REACH_MCP_READY_TIMEOUT_MS` | `150000` | 等待 Engine ready 的总预算 |
| `REACH_MCP_READY_POLL_MS` | `200` | 就绪轮询间隔；当前安装设为 `1000` |
| `REACH_MCP_RENEW_SKEW_MS` | `60000` | 租约接近过期时提前续租的窗口 |
| `REACH_MCP_REQUEST_TIMEOUT_MS` | `35000` | 单次 HTTP 请求总时限，包含响应体读取 |

时间变量单位为毫秒，必须为正整数。默认 150 秒就绪预算覆盖 Engine 的默认 120 秒空闲心跳；当前远程 Gateway 心跳设置为 15 秒，不必因此把总预算缩到刚好 15 秒。

## 首次使用与工具列表

动态模式初始化展示 `list_devices`、`get_versions`、`pick_device`：

1. 调用 `list_devices` 查看配置条目。
2. 调用 `pick_device`，参数为 `{"deviceId":"perry-mac"}`。
3. Connector 打开会话并等待 Engine ready，发出工具列表变化通知。
4. 客户端刷新列表后获得 `fs.read`、`fs.write`、`fs.edit`、`fs.list`、`fs.glob`、`fs.stat`、`fs.grep` 与 `session.close`。
5. 完成操作后调用 `session.close`，回到设备选择状态。

文件工具示例参数：

```json
{
  "workspace": "default",
  "path": "notes/example.txt",
  "content": "Reach MCP example",
  "mode": "create"
}
```

这是 `fs.write` 的参数，`mode: create` 要求目标文件尚不存在。`fs.edit` 使用 `oldString`、`newString` 字段。写入与编辑会先自动申请所需路径和方法的 grant，不需要用户手动调用授权 API。

若客户端不刷新动态列表，在 `env` 中加入 `"REACH_MCP_TOOL_MODE": "static"` 并重新启动 Connector。静态模式从初始化起展示文件工具，每次文件操作及关闭会话都需要 `deviceId`，例如：

```json
{
  "deviceId": "perry-mac",
  "workspace": "default",
  "path": "notes/example.txt"
}
```

## 生命周期与检查

Connector 在使用工具前检查会话、按需重建或续租。切换设备会先关闭旧会话。客户端关闭 stdin 后，Connector 等待已收到的请求处理完毕，再关闭自己持有的会话。

状态观察可在总预算内重试临时网络中断；文件 RPC、grant 和会话变更不会自动重放。写入丢失响应时先确认文件结果。不要同时让多个客户端抢占同一个 Engine 的会话；不同 Engine 的会话互相隔离。

手工直接运行 `node .../dist/main.js` 后没有输出是正常的：stdio 服务在等待 MCP 输入。客户端诊断看 stderr；部署验收使用 [verification.md](verification.md) 中安装后 MCP 验证。文件工具读取的是 Engine 工作区，Connector 本身只读取自己的私有配置。
