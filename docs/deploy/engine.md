# Engine 部署到 Mac

Engine 是 Rust 可执行程序，负责访问设备工作区。它通过 HTTPS 心跳等待会话请求，按需建立 WSS 连接；不会监听 Mac 的入站端口。以下流程使用 macOS LaunchAgent；Linux 的 systemd 安装器见 [Linux Engine](linux.md)，x86_64 OpenWrt 的 procd 安装器见 [OpenWrt 与多设备](openwrt.md)。

## 从 Release 安装（无需本地构建）

准备好下文的 `engine.env` 后，可在仓库目录直接安装 GitHub Release 中的预构建 Engine，跳过第 2 节的构建：

```bash
bash scripts/install-engine.sh .reach/engine.env
```

脚本按 `uname` 选择 `engine-darwin-arm64`、`engine-darwin-x64` 或 `engine-linux-x64-musl`，下载最新的 `engine-v*` Release，用 Release 的 `SHA256SUMS` 和 `engine --version` 校验后，再调用本页的 LaunchAgent 安装器或 [Linux 安装器](linux.md)。校验失败时不会安装。`REACH_ENGINE_VERSION=0.3.2` 可以固定版本，`REACH_RELEASE_REPO=owner/repo` 可以指定 fork，`REACH_INSTALL_DRY_RUN=1` 只下载和校验、不安装。macOS 上传入的第二个参数（MCP 设备 JSON）会原样交给 LaunchAgent 安装器，此时仍需先构建 MCP Connector。

## 1. 配置与工作区

先准备 [配置与凭证](configuration.md) 中的 `.reach/engine.env`。文件包含：

```dotenv
REACH_GATEWAY_URL=https://reach.example.com
REACH_ENGINE_TOKEN=<独立生成的64字符Engine凭证>
REACH_ENGINE_ID=engine-a
REACH_WORKSPACE_ROOTS=default:/Users/example/.reach/workspace
```

示例 token 是占位符，必须使用实际私有配置。Engine ID 需与 Gateway 一致。若配置其他用户或目录，使用该设备的实际绝对路径；在目标 Mac 创建选定工作区：

```bash
mkdir -p "$HOME/.reach/workspace"
chmod 700 "$HOME/.reach/workspace"
```

文件 RPC 的 `workspace` 是配置中的名称，例如 `default`；`path` 是工作区相对路径，例如 `notes/today.txt`。不要把整个用户主目录或系统根目录作为默认工作区。Unix 实现通过目录描述符和 no-follow 访问约束路径，拒绝越界及符号链接绕过，但工作区本身仍应选取明确允许远程访问的文件范围。

环境变量模式下，添加第二个工作区时采用 `default:/absolute/path,notes:/another/path`，提前准备目录，并重启 Engine。客户端不能通过传入任意绝对路径扩展这些根目录。

MCP 客户端可调用 `list_workspaces({deviceId})` 发现配置中的名称和允许执行脚本的工作区；返回的是 Engine `session.ready` 元数据，不暴露根目录的绝对路径。文件调用应使用返回的名称，不能假定 `default` 一定存在。

### 动态工作区文件（Engine 0.3.0 起）

需要不重启添加、移除或更换根目录时，使用本机 JSON 文件。先创建所有根目录，删除服务环境中的 `REACH_WORKSPACE_ROOTS` 和 `REACH_PROCESS_WORKSPACES`，设置 `REACH_WORKSPACES_FILE=/home/example/.reach/workspaces.json`，再重启一次。macOS 可使用 `/Users/example/.reach/workspaces.json`；必须填写服务用户实际可读的路径。

```json
{
  "workspaces": {
    "default": { "path": "/home/example/.reach/workspace" },
    "scripts": { "path": "/home/example/reach-scripts", "process": true }
  }
}
```

`process` 默认 `false`。文件只允许上述键；至少声明一个工作区，名称不能为空，根目录必须是已存在的绝对目录，Engine 不会替文件模式创建目录。路径会解析为真实目录，指向同一目录的符号链接不算更换根目录。JSON 不展开 `~` 或 `$HOME`，也不能包含 token 或 Gateway 设置。

显式文件优先，其次是任一工作区环境变量；三者均未设置时自动发现 `~/.reach/workspaces.json`，不存在则保留内置 `default`。显式文件与任一工作区环境变量同时设置会导致启动失败。环境模式不会热重载，也不会监听默认文件后来是否出现。

文件模式每 2 秒检查一次，在空闲心跳期间和会话请求之间均生效；Unix 上 `kill -HUP <engine-pid>` 可请求在下个循环立即重载。建议先写临时文件再原子重命名。无效 JSON、未知键、空工作区集、目录无效或文件被删除、不可读时，整次修改不生效，继续使用最后有效配置，日志记录 `WORKSPACE_RELOAD_FAILED`，不输出文件内容。被拒绝的文件会在每个轮询周期重试，同一原因只记录一次；例如先写入新条目、后创建根目录，目录出现后无需再次修改文件即可生效。启动时出现这些错误则直接退出。

已有请求完成后才替换配置。移除或更换根目录会使该工作区游标返回 `INVALID_CURSOR`，并终止其中当前会话拥有的进程；关闭 `process` 也会终止进程并拒绝新启动。其他工作区的游标和进程继续运行。移除名称后的文件访问返回 `WORKSPACE_ACCESS_DENIED`。

变更后 Engine 在同一会话发送更新的 `session.ready`，`list_workspaces` 和控制台自动读取新列表。请先升级到 Gateway 0.7.2，再升级 Engine：新版 Gateway 会撤销移除、更换根目录工作区的文件和执行 grant，以及关闭执行的工作区的执行 grant；仅绑定 processId 的控制 grant 保留到过期。旧 Gateway 能刷新列表，但更换根目录时无法撤销旧 grant，最长仍可使用 5 分钟；使用旧 Gateway 时应改用新工作区名称，避免原名更换根目录。迁移和回滚见 [组件版本](versions.md)。

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
| `~/Library/LaunchAgents/org.reach.engine.plist` | 用户后台任务 |
| `~/.local/share/reach/engine.log` | 标准输出，包含生命周期事件 |
| `~/.local/share/reach/engine-error.log` | 标准错误与启动错误 |
| `~/.config/reach/mcp-devices.json` | 仅同时安装 MCP 时生成，模式 600 |
| `~/.config/reach/mcp.json` | 仅同时安装 MCP 时生成，客户端启动配置 |

运行文件目录和配置目录均设为 700。MCP 安装的细节见 [mcp.md](mcp.md)。

Rust Engine 独立运行；可配置 `REACH_PROCESS_WORKSPACES` 显式启用可信脚本执行，使用 `REACH_PROCESS_NODE_BIN` 选择私有 runtime，详见 [脚本任务](processes.md)。安装器另提供 `run-node.sh`，同一主机上的 Gateway/MCP 可通过它使用私有 Node；`REACH_NODE_BIN` 只作为 launcher 的可执行程序路径覆盖项。设计说明见 [Node runtime](node-runtime.md)。

```bash
"$HOME/.local/share/reach/run-node.sh" /absolute/path/to/gateway-main.js
"$HOME/.local/share/reach/run-node.sh" /absolute/path/to/mcp/dist/main.js
```

源码构建仍需要 Rust 与 Node/npm 工具链。安装器中的 Python 3 和归档解包工具也必须可用；runtime 的下载和安装本身不依赖系统 Node。

新安装默认 LaunchAgent label 为 `org.reach.engine`；可通过 `REACH_LAUNCHD_LABEL` 指定。升级时自动保留指向同一启动脚本的已有服务 label，以下管理命令应使用实际 label。服务配置 `RunAtLoad=true`、`KeepAlive=true` 与 `ThrottleInterval=10`。进程异常退出后由 launchd 拉起；持续配置错误可能造成反复重启，应查看 stderr 并修正配置。

## 5. 检查与管理

```bash
launchctl print "gui/$(id -u)/org.reach.engine"
tail -n 40 "$HOME/.local/share/reach/engine.log"
tail -n 40 "$HOME/.local/share/reach/engine-error.log"
```

刚注册时可能短暂显示启动中的 wrapper 或 `xpcproxy`，稍后再看实际 PID 和日志。Engine 空闲心跳正常时也不一定有 `session.ready`；只有 Controller 请求会话后才建立 WSS。

重启已注册的服务：

```bash
launchctl kickstart -k "gui/$(id -u)/org.reach.engine"
```

停止并卸载本次登录中的任务：

```bash
launchctl bootout "gui/$(id -u)/org.reach.engine"
```

重新注册：

```bash
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/org.reach.engine.plist"
```

`bootout` 不删除 plist，用户下次登录仍可能自动加载；永久停用见 [operations.md](operations.md)。KeepAlive 期间只杀进程会被重新拉起，不能作为停止服务的方法。

## 6. 连接与运行限制

- 公网 Gateway 必须是证书有效的 HTTPS 根 URL；明文 HTTP 只允许 loopback。不要同时设置 URL 环境变量并传 URL 命令行参数。
- Gateway 给出 session endpoint 后，Engine 检查同一 origin，拒绝跳转到别的地址。网络失败按退避策略重试心跳，客户端需重新打开新会话。
- Mac 休眠、断网或用户退出登录期间不可用；LaunchAgent 不提供无人登录时的系统级常驻。
- Engine 执行文件工具，不提供任意 shell 执行服务。运行用户对目标文件的操作系统权限仍会限制 RPC。
- Engine 日志为追加文件，安装器未配置自动轮转，需要定期管理；不要把容器日志轮转误认为 Mac 日志也会轮转。
- Linux 与 OpenWrt 分别使用 [systemd](linux.md) 和 [procd](openwrt.md) 安装器。

完整参数表见 [configuration.md](configuration.md)，真实文件链路检查见 [verification.md](verification.md)。

## 7. 硬件类型与控制台显示

Engine 在启动时检测一次硬件，在每次心跳的 `device.hardware` 中报告五项：`kind`（设备类型）、`model`（型号）、`os`（操作系统）、`osVersion`（系统版本）和 `arch`（架构）。每项最多 64 个可打印字符。检测使用本地 macOS 系统信息、OpenWrt 板卡型号、Raspberry Pi 设备树、Synology/QNAP 系统文件或 Linux DMI；子进程共享三秒检测预算。检测失败仍正常发送心跳，类型为 `unknown`。

报告不包含序列号、主机名、MAC 地址、用户名或其他网络标识。Gateway 忽略格式错误或过大的硬件描述，并保留上次有效值；旧 Engine 不发送该对象时仍可正常连接，控制台使用通用服务器图形。

管理员可在控制台为设备设置或清除类型与型号覆盖。覆盖优先于自动报告，只影响显示，不更改设备权限或 Engine 本地配置。

## macOS 安装恢复验证范围

安装器先在私有临时目录校验并准备产物，再停止旧服务、逐文件原子替换和启动；失败恢复原文件、runtime 指针和 supervisor 状态。首次安装失败会移除新目标文件，保留用户工作区；恢复失败保留私有备份供手动恢复，不能据此报告升级成功。macOS 的隔离 supervisor 夹具覆盖 staging、activation、start/health、旧配置保留和首次失败清理；这些测试不等同于真实 LaunchAgent/procd 设备已验收。具体恢复与真实平台验收仍见 [运维指南](operations.md)。
