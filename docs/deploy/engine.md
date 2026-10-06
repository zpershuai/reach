# Engine 部署到 Mac

Engine 是 Rust 可执行程序，负责访问设备工作区。它通过 HTTPS 心跳等待会话请求，按需建立 WSS 连接；不会监听 Mac 的入站端口。当前已有安装器面向 macOS，以下流程以当前用户的 LaunchAgent 为准。

## 1. 配置与工作区

先准备 [配置与凭证](configuration.md) 中的 `.reach/engine.env`。文件包含：

```dotenv
REACH_GATEWAY_URL=https://reach.zpershuai.top
REACH_ENGINE_TOKEN=<独立生成的64字符Engine凭证>
REACH_ENGINE_ID=perry-mac
REACH_WORKSPACE_ROOTS=default:/Users/perry/.reach/workspace
```

示例 token 是占位符，必须使用实际私有配置。Engine ID 需与 Gateway 一致。若配置其他用户或目录，使用该设备的实际绝对路径；在目标 Mac 创建选定工作区：

```bash
mkdir -p "$HOME/.reach/workspace"
chmod 700 "$HOME/.reach/workspace"
```

文件 RPC 的 `workspace` 是配置中的名称，例如 `default`；`path` 是工作区相对路径，例如 `notes/today.txt`。不要把整个用户主目录或系统根目录作为默认工作区。Unix 实现通过目录描述符和 no-follow 访问约束路径，拒绝越界及符号链接绕过，但工作区本身仍应选取明确允许远程访问的文件范围。

添加第二个工作区时采用 `default:/absolute/path,notes:/another/path`，提前准备目录，并重启 Engine。客户端不能通过传入任意绝对路径扩展这些根目录。

## 2. 构建目标平台二进制

在目标 Mac 仓库根目录执行：

```bash
cargo build --release --locked --bin engine
```

产物为 `target/release/engine`。构建需要 Rust 工具链和首次依赖下载；macOS 还需可用的本机构建工具。Intel 与 Apple Silicon 使用各自目标环境构建。

如果要同时安装 MCP，先构建它：

```bash
npm --prefix packages/reach-rpc ci --ignore-scripts
npm --prefix packages/grok-bot-mcp-connector run build
```

## 3. 安装后台服务

以当前登录的 GUI 用户执行，不使用 `sudo`：

```bash
bash scripts/install-engine-macos.sh .reach/engine.env
```

若要同时安装 MCP 运行文件、设备 JSON 和客户端配置：

```bash
bash scripts/install-engine-macos.sh .reach/engine.env .reach/devices.json
```

二选一执行即可。第二种安装方式要求 `dist` 已构建。每次安装 Engine 都会自动准备独立的 Node.js runtime，不要求系统 PATH 中存在 Node。安装器将 `~/.reach/runtime/node/bin/node` 的绝对路径写入 MCP 客户端配置。

Node 版本和各平台 SHA-256 固定在 [node-runtime.json](../../scripts/node-runtime.json)，发行包来自 `https://nodejs.org/dist/`。首次安装需要联网下载；后续安装校验已安装 runtime，完整且版本匹配时复用，缺失或损坏时重新安装。下载、校验或执行检查失败会中止 Engine 安装，保留原有 runtime 和后台服务。runtime 更新通过原子替换符号链接完成，旧发行目录保留供已启动的进程使用。

[安装器](../../scripts/install-engine-macos.sh) 复制构建产物和配置，生成启动 wrapper 与 plist，然后卸载已有同名服务并重新注册。因此重复安装会重启 Engine、中断当前会话；它不会重新编译代码。

输入配置使用仓库内的暂存文件，不把 `~/.config/reach/engine.env` 作为源参数复制回自身。升级前从已安装配置创建暂存副本，见 [运维与回滚](operations.md)。

## 4. 安装后的文件

| 文件 | 用途 |
| --- | --- |
| `~/.local/share/reach/engine` | 可执行文件，模式 755 |
| `~/.local/share/reach/start-engine.sh` | 加载私有 env 后执行 Engine，模式 700 |
| `~/.reach/runtime/node/bin/node` | 独立 Node.js runtime 的稳定入口，随 Engine 自动安装 |
| `~/.reach/runtime/node/bin/npm`、`npx` | 发行包附带的包管理入口 |
| `~/.reach/versions.json` | 已安装的 Engine、MCP、Node 发布号 |
| `~/.local/share/reach/run-node.sh` | 使用独立 runtime 执行 JS，模式 755 |
| `~/.config/reach/engine.env` | Engine 配置，模式 600 |
| `~/Library/LaunchAgents/top.zpershuai.reach-engine.plist` | 用户后台任务 |
| `~/.local/share/reach/engine.log` | 标准输出，包含生命周期事件 |
| `~/.local/share/reach/engine-error.log` | 标准错误与启动错误 |
| `~/.config/reach/mcp-devices.json` | 仅同时安装 MCP 时生成，模式 600 |
| `~/.config/reach/mcp.json` | 仅同时安装 MCP 时生成，客户端启动配置 |

运行文件目录和配置目录均设为 700。MCP 安装的细节见 [mcp.md](mcp.md)。

Engine 启动 wrapper 设置 `REACH_NODE_BIN` 为上述 Node 绝对路径，并把 runtime 的 `bin` 加到 PATH。Gateway 和 MCP 在同一台设备上可共用它：

```bash
"$HOME/.local/share/reach/run-node.sh" /absolute/path/to/gateway-main.js
"$HOME/.local/share/reach/run-node.sh" /absolute/path/to/mcp/dist/main.js
```

源码构建仍需要 Rust 与 Node/npm 工具链。安装器中的 Python 3 和归档解包工具也必须可用；runtime 的下载和安装本身不依赖系统 Node。

LaunchAgent label 为 `top.zpershuai.reach-engine`，配置 `RunAtLoad=true`、`KeepAlive=true` 与 `ThrottleInterval=10`。进程异常退出后由 launchd 拉起；持续配置错误可能造成反复重启，应查看 stderr 并修正配置。

## 5. 检查与管理

```bash
launchctl print "gui/$(id -u)/top.zpershuai.reach-engine"
tail -n 40 "$HOME/.local/share/reach/engine.log"
tail -n 40 "$HOME/.local/share/reach/engine-error.log"
```

刚注册时可能短暂显示启动中的 wrapper 或 `xpcproxy`，稍后再看实际 PID 和日志。Engine 空闲心跳正常时也不一定有 `session.ready`；只有 Controller 请求会话后才建立 WSS。

重启已注册的服务：

```bash
launchctl kickstart -k "gui/$(id -u)/top.zpershuai.reach-engine"
```

停止并卸载本次登录中的任务：

```bash
launchctl bootout "gui/$(id -u)/top.zpershuai.reach-engine"
```

重新注册：

```bash
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/top.zpershuai.reach-engine.plist"
```

`bootout` 不删除 plist，用户下次登录仍可能自动加载；永久停用见 [operations.md](operations.md)。KeepAlive 期间只杀进程会被重新拉起，不能作为停止服务的方法。

## 6. 连接与运行限制

- 公网 Gateway 必须是证书有效的 HTTPS 根 URL；明文 HTTP 只允许 loopback。不要同时设置 URL 环境变量并传 URL 命令行参数。
- Gateway 给出 session endpoint 后，Engine 检查同一 origin，拒绝跳转到别的地址。网络失败按退避策略重试心跳，客户端需重新打开新会话。
- Mac 休眠、断网或用户退出登录期间不可用；LaunchAgent 不提供无人登录时的系统级常驻。
- Engine 执行文件工具，不提供任意 shell 执行服务。运行用户对目标文件的操作系统权限仍会限制 RPC。
- Engine 日志为追加文件，安装器未配置自动轮转，需要定期管理；不要把容器日志轮转误认为 Mac 日志也会轮转。
- Linux 可构建 Rust Engine，但本仓库尚无对应后台安装脚本；本套验收的设备安装流程是 macOS LaunchAgent。

完整参数表见 [configuration.md](configuration.md)，真实文件链路检查见 [verification.md](verification.md)。
