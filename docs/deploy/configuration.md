# 配置、域名与凭证

## 部署参数与前置条件

| 项目 | 本套示例 | 要求 |
| --- | --- | --- |
| Gateway URL | `https://reach.example.com` | 使用独立域名根路径，不附加 `/reach` 等路径 |
| VPS SSH | `deploy@gateway.example.com` | 有发布目录写权限及 Docker、Caddy 管理权限 |
| 发布目录 | `/srv/reach` | Compose 项目目录固定，避免重复启动同名服务 |
| Engine ID | `engine-a` | Gateway 和 Engine 配置必须一致 |
| 工作区 | `default:$HOME/.reach/workspace` | 在配置文件中写实际绝对路径，不保留字面量 `$HOME` |
| 开发工具 | Node.js 24、npm、稳定版 Rust、Python 3 | 本仓库已在 Node 24、macOS/Linux 的 CI 路径验证；Mac 后台安装需要登录的 GUI 用户 |
| VPS 工具 | Docker Engine、Compose 插件、Caddy | 在目标服务器预先安装这些工具 |

在本机检查 `node --version`、`npm --version`、`cargo --version`、`python3 --version`；VPS 检查 `docker version`、`docker compose version`、`caddy version`。Engine 二进制需在目标平台构建，不可把 Mac 二进制复制给 Linux。

域名的 A 记录应指向 VPS；若配置 AAAA，也必须指向能提供同一服务的地址。80/443 入站需要可达，供 Caddy 提供 HTTPS 与完成证书验证。现有主机沿用现有 Caddy，不另起一个占用 80/443 的代理。

## 凭证分工

| 凭证 | 保存位置 | 用途 |
| --- | --- | --- |
| Controller token | Gateway env、MCP 私有设备 JSON | 会话控制、RPC、申请写入 grant |
| Engine token | Gateway env、Mac Engine env | Engine 心跳认证，绑定配置的 Engine ID |
| session token | Gateway 心跳响应，Engine 短期持有 | 建立一次 WSS 会话；30 秒有效且只可消费一次 |
| grant ID | Gateway 内存，客户端短期持有 | 按工作区、路径、方法和有效期授权写入；当前有效期 5 分钟 |

两份长期 token 必须不同，至少 32 字符。推荐各生成 32 随机字节的十六进制字符串，即 64 字符。Engine token 只接受 ASCII 字母、数字和 `-_.`，十六进制值符合要求。生产环境采用 TLS 校验证书，不关闭证书检查。

Gateway 的 Controller token 持有人能够发起配置工作区内的读写操作并申请 grant，因此工作区范围也是部署权限的一部分。MCP 配置使用 Controller token，Engine 配置使用 Engine token，不能交换。

## 首次生成私有配置

下面是一次性配置生成示例，需要时从仓库根目录运行。已有 `.reach/` 配置应继续使用；脚本发现同名文件会退出，避免意外轮换当前凭证。它只生成本地配置，不上传、不安装、不启动服务。

```bash
python3 - <<'PY'
import json
import secrets
import shlex
from pathlib import Path

gateway_url = 'https://reach.example.com'
engine_id = 'engine-a'
workspace = str(Path.home() / '.reach/workspace')
directory = Path('.reach')
names = ['deployment.json', 'gateway.env', 'engine.env', 'devices.json', 'engines.json']
if any((directory / name).exists() for name in names):
    raise SystemExit('已有部署配置：请复用或先单独备份，未生成新凭证。')
directory.mkdir(mode=0o700, exist_ok=True)
directory.chmod(0o700)
controller = secrets.token_hex(32)
engine = secrets.token_hex(32)
deployment = dict(gatewayUrl=gateway_url, engineId=engine_id,
                  controllerToken=controller, engineToken=engine,
                  workspaceRoot=workspace)
gateway_env = dict(REACH_CONTROLLER_TOKEN=controller,
                   REACH_ENGINE_TOKEN=engine, REACH_ENGINE_ID=engine_id,
                   REACH_HEARTBEAT_INTERVAL_SECS='15',
                   REACH_ENGINES_FILE='/run/reach/engines.json')
engine_env = dict(REACH_GATEWAY_URL=gateway_url,
                  REACH_ENGINE_TOKEN=engine, REACH_ENGINE_ID=engine_id,
                  REACH_WORKSPACE_ROOTS='default:' + workspace)
contents = {
    'engines.json': '[]\n',
    'deployment.json': json.dumps(deployment, indent=2) + '\n',
    'gateway.env': ''.join(f'{key}={value}\n' for key, value in gateway_env.items()),
    'engine.env': ''.join(f'{key}={shlex.quote(value)}\n' for key, value in engine_env.items()),
    'devices.json': json.dumps([dict(id=engine_id, engineId=engine_id, gatewayUrl=gateway_url,
                                    controllerToken=controller)], indent=2) + '\n',
}
for name, content in contents.items():
    target = directory / name
    with target.open('x') as output:
        target.chmod(0o600)
        output.write(content)
print('已生成 .reach/ 下五份私有配置，凭证未打印。')
PY
```

`.reach/deployment.json` 是验证脚本使用的私有配置，包含 URL、Engine ID、两份 token 和实际工作区绝对路径。它应留在验证机器上，不放入 Docker 镜像、文档或客户端共享配置。

`.reach/`、`deploy/*.env` 与实际设备注册表 `deploy/engines.json` 已加入 Git 忽略；Docker 构建上下文也排除这些私有配置。另行保存配置时仍需自行检查权限和提交范围。备份应包含私有配置和工作区，并存放在仅自己可访问的位置。

## Gateway 环境变量

| 变量 | 默认值 | 部署说明 |
| --- | --- | --- |
| `GATEWAY_HOST` | `127.0.0.1`；镜像内 `0.0.0.0` | Compose 容器使用镜像默认值，宿主只发布回环端口 |
| `GATEWAY_PORT` | `8787` | 1–65535 的整数；改动后同步端口映射与健康检查 |
| `REACH_CONTROLLER_TOKEN` | 无 | 与以下两项一起设置 |
| `REACH_ENGINE_TOKEN` | 无 | 必须不同于 Controller token |
| `REACH_ENGINE_ID` | 无 | 默认 Engine 的唯一标识，例如 `engine-a` |
| `REACH_ENGINES_FILE` | 无 | 额外 Engine 的私有注册表；Compose 示例挂载到 `/run/reach/engines.json` |
| `REACH_HEARTBEAT_INTERVAL_SECS` | `120` | 单位秒，正整数；可按需设置为 `15` |
| `REACH_HTTP_LOG` | 关闭 | `1` 启用请求路径、状态与耗时日志 |
| `REACH_MCP_ALLOWED_ORIGINS` | 空 | HTTP MCP 允许的完整 Origin，逗号分隔；默认拒绝带 Origin 的请求，无该头的云端客户端正常使用 |
| `REACH_MCP_SESSION_IDLE_MS` | `300000` | HTTP MCP 空闲过期时间；过期关闭所持有的 Engine 会话 |
| `REACH_MCP_RESPONSE_TIMEOUT_MS` | `25000` | HTTP MCP 响应预算，覆盖请求体读取、排队和执行 |
| `REACH_MCP_MAX_SESSIONS` | `128` | HTTP MCP 会话总上限，含待清理会话 |
| `REACH_MCP_MAX_QUEUE` | `16` | 每个 HTTP MCP 会话正在读取请求体、排队和运行的请求总上限，满时返回 429 |

三项认证配置只设置其中一项会启动失败；非回环监听必须启用认证。Docker 内监听所有容器接口不等于公开 VPS 端口，公开范围由 Compose 的 `127.0.0.1:28787:8787` 决定。

HTTP MCP 与 REST Controller 共用 `REACH_CONTROLLER_TOKEN`，不使用独立 MCP token。上述 HTTP 时间与数量必须为正的安全整数；它们与 stdio Connector 的 readiness/request 参数分别生效。

## Engine 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REACH_GATEWAY_URL` | `http://127.0.0.1:8787` | 公网使用 HTTPS；与命令行 URL 二选一 |
| `REACH_ENGINE_TOKEN` | 无 | HTTPS 必填 |
| `REACH_ENGINE_ID` | `reach-engine` | 需与 Gateway 的 ID 一致 |
| `REACH_WORKSPACE_ROOTS` | `default:~/.reach/workspace` 对应的实际路径 | `name:absolute-path`，多个根用逗号分隔 |
| `REACH_CONNECTION_TIMEOUT_SECS` | `15` | 建立连接的时限 |
| `REACH_RPC_DEADLINE_SECS` | `30` | RPC 执行上限 |
| `REACH_LEASE_SECS` | `300` | Engine 租约上限 |
| `REACH_IDLE_SECS` | `300` | 无活动会话上限 |
| `REACH_ROTATION_SECS` | `28800` | 连续连接最多 8 小时 |

超时变量单位为秒，必须为正整数。Gateway 仍有自己的上限，调大 Engine 值不会自动调大 Gateway。`engine.env` 会被 Bash `source`，值含空格时需要 shell 引号；它是受信任的本地配置文件。根目录的格式以逗号分割，避免使用包含逗号的路径。

MCP 的全部环境变量见 [mcp.md](mcp.md)。

## 域名与认证边界

Gateway 通过 HTTPS 域名提供控制接口，Engine 通过同一 origin 建立 HTTPS/WSS 连接；不需要每台 Engine 单独配置域名。

源码使用独立 bearer token 与 Gateway 内存 grant，没有 Ed25519 签名授权或 Agent assertion 验证流程。与其他协议实现迁移时，应分别确认认证、客户端和配置格式的兼容性；更换代理目标不会自动迁移凭证或会话。
