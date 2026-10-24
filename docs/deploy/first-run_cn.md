# 首次运行：单机、限定范围客户端、脚本、撤销与卸载

[English](first-run.md) | 简体中文

本教程在一台 Linux 或 macOS 机器上从源码运行 Gateway 和一个 Engine，连接限定范围的 MCP 客户端、启用一个可信 Node 脚本、撤销客户端和设备并卸载。全部监听 `127.0.0.1`，使用保留名称（`engine-a`、`docs`、`scripts`）及本机生成的凭据。之后如需远程 HTTPS Gateway，请参考[部署指南](README_cn.md)。

每一步均以普通非 root 账户运行。Reach 不需要 root，之后启用的脚本会使用 Engine 账户权限，因此请选择您愿意授予该脚本访问权限的账户（或 VM/容器）。

## 0. 前置条件

| 工具 | 说明 |
| --- | --- |
| Git、curl、Python 3 | Python 生成下面的私有配置 |
| Node.js 24 与 npm | CI 使用 scripts/toolchain.json 固定版本验证 |
| Rust 工具链与 cargo | CI 使用 scripts/toolchain.json 固定版本验证；其他版本未经测试 |
| 浏览器与 TOTP 验证器应用 | 控制台首次设置管理员所需 |

## 1. 构建

```bash
git clone https://github.com/example/reach.git && cd reach
npm --prefix packages/reach-rpc ci --ignore-scripts
npm --prefix packages/reach-rpc run build
npm --prefix packages/gateway-console ci --ignore-scripts
npm --prefix packages/gateway-console run build
cargo build --release --locked -p reach-rpc --bin engine
```

将克隆 URL 替换成获取 Reach 的仓库地址。控制台构建产物复制到 Gateway 输出；缺失时不提供 /console/。

## 2. 创建私有演示目录

下面创建 ~/reach-demo，包含私有环境文件、空 Gateway 数据目录和两个工作区。已有目录会拒绝覆盖，不打印任何凭据。

```bash
python3 - <<'PY'
import json, os, secrets, shutil
from pathlib import Path
demo = Path.home() / 'reach-demo'
demo.mkdir(mode=0o700)
for name in ['gateway-data', 'workspaces/docs', 'workspaces/scripts']:
    (demo / name).mkdir(mode=0o700, parents=True)
(demo / 'workspaces/docs/readme.txt').write_text('Hello from the docs workspace.\n')
engine_token = secrets.token_hex(32)
files = {
    'gateway.env': {
        'REACH_CONTROLLER_TOKEN': secrets.token_hex(32),
        'REACH_ENGINE_ID': 'engine-a',
        'REACH_ENGINE_TOKEN': engine_token,
        'REACH_DATA_DIR': str(demo / 'gateway-data'),
        'REACH_HEARTBEAT_INTERVAL_SECS': '5',
    },
    'engine.env': {
        'REACH_GATEWAY_URL': 'http://127.0.0.1:8787',
        'REACH_ENGINE_ID': 'engine-a',
        'REACH_ENGINE_TOKEN': engine_token,
        'REACH_WORKSPACES_FILE': str(demo / 'workspaces.json'),
        'REACH_PROCESS_NODE_BIN': shutil.which('node'),
    },
}
for name, values in files.items():
    with os.fdopen(os.open(demo / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
        output.writelines(f'{key}={value}\n' for key, value in values.items())
workspaces = {'workspaces': {'docs': {'path': str(demo / 'workspaces/docs')},
                             'scripts': {'path': str(demo / 'workspaces/scripts')}}}
(demo / 'workspaces.json').write_text(json.dumps(workspaces, indent=2) + '\n')
print('Created', demo)
PY
```

REACH_CONTROLLER_TOKEN 是 Owner 凭据，可访问所有 Engine 和工作区，仅用于管理。此演示以 5 秒心跳提升响应速度，默认是 120 秒。REACH_PROCESS_NODE_BIN 指定本机 Node 执行脚本；正式安装的 Engine 使用 ~/.reach/runtime/node 私有 runtime。

## 3. 启动 Gateway（终端 1）

```bash
cd reach
set -a; . ~/reach-demo/gateway.env; set +a
node packages/reach-rpc/dist/gateway-main.js
```

它打印 Reach gateway v… listening on http://127.0.0.1:8787，并提醒私有读取设置凭据，不打印凭据本身。

## 4. 创建管理员

1. 在自己的终端读取一次性设置凭据：`cat ~/reach-demo/gateway-data/admin-setup-token`。不要粘贴到日志、工单或聊天。
2. 打开 http://127.0.0.1:8787/console/，输入设置凭据，将 TOTP 密钥扫描到验证器，设置至少 12 字符密码并确认 TOTP 验证码。
3. 私有保存恢复码。设置成功后删除设置文件。
4. 用 EN / 中 切换语言，也可在导航或设置中选择。语言即时生效、保留表单内容并保存在当前浏览器，无需重新验证身份。OAuth 审批页面优先跟随控制台语言 Cookie，其次跟随浏览器语言。

## 5. 配对 Engine（终端 2）

Gateway 和 Engine 环境文件共用 Engine ID 与 token，这就是设备注册凭据。启动 Engine：

```bash
cd reach
set -a; . ~/reach-demo/engine.env; set +a
./target/release/engine
```

数秒内控制台设备页面显示 engine-a 在线。之后通过设备 → 添加设备注册的 Engine 使用控制台签发的独立令牌。

## 6. 创建限定范围的客户端

在控制台打开客户端 → 客户端身份与权限 → 创建委托客户端。命名 demo-client，选择较短有效期并添加两个资源：

| Engine | Workspace | read | write | execute |
| --- | --- | --- | --- | --- |
| `engine-a` | `docs` | ✓ | | |
| `engine-a` | `scripts` | ✓ | ✓ | ✓ |

创建后将仅显示一次的令牌存入私有文件，避免回显：

```bash
umask 077; cat > ~/reach-demo/client-token   # 粘贴令牌，按 Enter，再按 Ctrl-D
```

也可通过[控制台 API](client-access_cn.md#api-字段)（POST /api/console/access-clients）创建相同策略。

## 7. 通过 MCP 使用客户端

MCP 宿主连接配置：

```json
{
  "mcpServers": {
    "reach": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <demo-client-token>" }
    }
  }
}
```

无需宿主时，可在第三个终端使用 curl 执行相同调用：

```bash
mcp() {
  curl -sS -D ~/reach-demo/mcp-headers http://127.0.0.1:8787/mcp \
    -H "authorization: Bearer $(cat ~/reach-demo/client-token)" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    ${MCP_SESSION:+-H "mcp-session-id: $MCP_SESSION" -H "mcp-protocol-version: 2025-06-18"} \
    --data "$1"; echo
}
tool() { mcp "{\"jsonrpc\":\"2.0\",\"id\":$RANDOM,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"; }

unset MCP_SESSION
mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
MCP_SESSION=$(awk 'tolower($1)=="mcp-session-id:" {print $2}' ~/reach-demo/mcp-headers | tr -d '\r')
mcp '{"jsonrpc":"2.0","method":"notifications/initialized"}'

tool list_devices '{}'
tool list_workspaces '{"deviceId":"engine-a"}'   # 重复执行，直到报告 "ready"
```

list_workspaces 在 Engine 打开会话时先返回 connecting。就绪后列出 docs、scripts；尚未启用任何工作区执行，因此 processWorkspaces 为空。接着：

```bash
tool fs_read  '{"deviceId":"engine-a","workspace":"docs","path":"readme.txt"}'
tool fs_write '{"deviceId":"engine-a","workspace":"docs","path":"new.txt","content":"x","mode":"create"}'
tool fs_write '{"deviceId":"engine-a","workspace":"scripts","path":"hello.mjs","content":"console.log(`hello from ${process.version}`)\n","mode":"create"}'
tool list_workspaces '{"deviceId":"engine-b"}'
```

读取成功。docs 写入返回 PERMISSION_DENIED 工具错误，因为只有读权限，文件不会写入。scripts 写入成功。engine-b 不在策略中，Gateway 返回与不存在设备完全相同的 HTTP 404 JSON-RPC 错误，不泄漏设备信息。

## 8. 启用一个可信脚本

Engine 本地配置允许之前，执行始终关闭；仅客户端 execute 权限不够：

```bash
tool process_run '{"deviceId":"engine-a","workspace":"scripts","script":"hello.mjs","launchId":"hello-1"}'
```

返回 PROCESS_EXECUTION_DISABLED，不启动任务。审核脚本后，编辑 ~/reach-demo/workspaces.json，仅为该工作区开启执行：

```json
{
  "workspaces": {
    "docs": { "path": "/home/example/reach-demo/workspaces/docs" },
    "scripts": { "path": "/home/example/reach-demo/workspaces/scripts", "process": true }
  }
}
```

保留生成文件中的真实绝对路径，仅增加 process: true。Engine 约两秒内重载。使用新的 launch ID 运行并读取输出：

```bash
tool list_workspaces '{"deviceId":"engine-a"}'      # processWorkspaces 现在列出 "scripts"
tool process_run '{"deviceId":"engine-a","workspace":"scripts","script":"hello.mjs","launchId":"hello-2"}'
tool process_status '{"deviceId":"engine-a","launchId":"hello-2"}'
tool process_logs '{"deviceId":"engine-a","processId":"<processId from process_run>"}'
```

脚本拥有 Engine 账户的系统权限。工作区仅限制启动入口，并非沙箱。能写 scripts 的人可改变运行代码，因此仅对同等信任的客户端同时授予写入和执行权限。

## 9. 撤销客户端和设备

在控制台对 demo-client 选择撤销身份。下一次请求失败：

```bash
tool list_devices '{}'   # HTTP 401；该客户端的 Engine 会话和进程会被清理
```

撤销设备凭据：在终端 2 Ctrl-C 停 Engine，在终端 1 Ctrl-C 停 Gateway，为 Gateway 设置新 Engine token 后重启：

```bash
python3 - <<'PY'
import secrets
from pathlib import Path
path = Path.home() / 'reach-demo/gateway.env'
lines = [line for line in path.read_text().splitlines() if not line.startswith('REACH_ENGINE_TOKEN=')]
path.write_text('\n'.join(lines + ['REACH_ENGINE_TOKEN=' + secrets.token_hex(32)]) + '\n')
PY
set -a; . ~/reach-demo/gateway.env; set +a
node packages/reach-rpc/dist/gateway-main.js
```

旧 engine.env 启动的 Engine 被拒绝，记录 HEARTBEAT_FAILED，不能上线。控制台注册的设备可直接通过设备 → 移除设备撤销，无需重启。

## 10. 卸载

Ctrl-C 停止 Gateway 和 Engine，仅移除演示配置、凭据和 Gateway 数据。除非明确决定删除，否则保留工作区：

```bash
cd ~/reach-demo
rm -r gateway-data
rm gateway.env engine.env client-token mcp-headers workspaces.json
ls workspaces/docs workspaces/scripts   # 文件仍然保留在这里
```

不再需要时可移除源码目录及 target/、node_modules/、dist/ 构建产物。LaunchAgent/systemd/procd 安装的 Engine 按[运维](operations_cn.md#停用组件)处理；安装器同样保留工作区和私有配置，直到您主动移除。
