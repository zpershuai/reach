# Gateway 部署到 VPS

Gateway 是公网控制入口，在 VPS 上由 Docker Compose 常驻，宿主 Caddy 处理 TLS。示例使用容器端口 `8787`、VPS 回环端口 `28787`、公网域名 `reach.example.com`。

本机直接运行 Gateway 时，可共用 Engine 安装到 `~/.reach/runtime/node/bin/node` 的独立 runtime。先完成下面的 npm 构建，然后在仓库根目录执行 `sh scripts/start-gateway.sh`；该入口通过独立 runtime 启动已构建的 Gateway。没有安装 Engine 的 Mac/Linux 主机可先执行 `python3 scripts/install-node-runtime.py`（支持 x64、arm64）。Docker 部署继续使用镜像自身的 Node，宿主与其他设备的 runtime 不跨主机共享。

## 1. 准备配置和构建产物

先完成 [配置与凭证](configuration.md)，确保存在 `.reach/gateway.env`。首次部署需要已安装 Docker、Compose 插件与 Caddy，并配置域名 DNS 和 80/443 网络访问。

Compose 还需要 `deploy/engines.json`：单设备部署复制 `deploy/engines.json.example`（空数组）；多设备部署按 [OpenWrt 与多设备](openwrt.md) 填入额外 Engine 并设置 `REACH_ENGINES_FILE`。部署目录限制为管理员访问，注册文件需可被容器的 node 用户读取。升级前备份并保留已有注册文件。

在本地仓库根目录运行：

```bash
npm --prefix packages/reach-rpc ci --ignore-scripts
npm --prefix packages/reach-rpc run build
```

[Dockerfile](../../deploy/Dockerfile.gateway) 直接复制 `packages/reach-rpc/dist`，不会在镜像里编译 TypeScript。只有源码、没有 `dist` 的发布包无法构建；修改源码后也必须先重新编译。

按白名单打包，不包含凭证、开发依赖、Rust 产物或工作区：

```bash
tar -czf /tmp/reach-gateway-release.tgz \
  deploy/compose.yaml deploy/Dockerfile.gateway \
  packages/reach-rpc/package.json packages/reach-rpc/package-lock.json \
  packages/reach-rpc/dist
```

镜像运行时安装 `ws`、`zod` 等生产依赖，因此 VPS 的 Docker 构建需要能够拉取 Node 基础镜像并访问 npm。共享 MCP 核心和 HTTP `/mcp` 随 `reach-rpc/dist` 一起进入镜像；独立 stdio Connector 入口和 Rust Engine 不在这个镜像中。

## 2. 上传到 VPS

以下使用保留的示例主机 `gateway.example.com`、部署账号 `deploy` 和发布目录 `/srv/reach`。按自己的配置替换，确保账号具有目录写入与 Docker 管理权限，并保持 Compose 构建上下文目录结构。

```bash
ssh deploy@gateway.example.com 'mkdir -p /srv/reach; chmod 700 /srv/reach; tar -xzf - -C /srv/reach' \
  < /tmp/reach-gateway-release.tgz
ssh deploy@gateway.example.com 'umask 077; cat > /srv/reach/deploy/gateway.env; chmod 600 /srv/reach/deploy/gateway.env' \
  < .reach/gateway.env
ssh deploy@gateway.example.com 'cat > /srv/reach/deploy/engines.json; chmod 644 /srv/reach/deploy/engines.json' \
  < .reach/engines.json
```

后两条命令会覆盖远端配置，首次部署使用生成的文件；升级时应复用当前凭证和 Engine 注册表并先备份。不要把含 token 的配置粘贴到命令行参数、聊天或发布说明中。

上传后目录应为：

```text
/srv/reach/
├── deploy/
│   ├── compose.yaml
│   ├── Dockerfile.gateway
│   ├── gateway.env             # 600，不进入镜像
│   └── engines.json             # 私有注册表，仅挂载给容器读取
└── packages/reach-rpc/
    ├── package.json
    ├── package-lock.json
    └── dist/
```

## 3. 构建并启动容器

```bash
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose up -d --build gateway'
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose ps'
ssh deploy@gateway.example.com 'curl --fail --silent --show-error http://127.0.0.1:28787/healthz'
```

健康响应应包含 `status: "ok"` 和 `protocol: "reach-rpc/1.0"`。Compose 健康检查每 15 秒执行一次，启动后可能短暂显示 `starting`。查看失败原因：

```bash
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose logs --tail 80 gateway'
```

[compose.yaml](../../deploy/compose.yaml) 的部署策略：

| 设置 | 行为 |
| --- | --- |
| `127.0.0.1:28787:8787` | 只允许 VPS 本机代理访问，不直接公开 8787/28787 |
| `restart: unless-stopped` | Docker 启动后拉起服务；手动停止后保持停止 |
| `USER node` | 容器进程不使用 root |
| `read_only: true` | 容器根文件系统只读 |
| `cap_drop: ALL`、`no-new-privileges` | 去除额外进程权限 |
| 健康检查 | 容器内访问 `/healthz`；不检查 Engine 在线状态 |
| `json-file` 日志 | 单文件 10 MB，最多 3 个文件 |

Compose 项目名默认来自目录名 `deploy`，例如容器名为 `deploy-gateway-1`。后续保持同一目录和项目名；随意增加另一个 `-p` 会创建第二套服务并可能冲突。Gateway 没有业务文件卷，设备文件不会因为容器重建而被删除。

## 4. 接入现有 Caddy

在 `/etc/caddy/Caddyfile` 中只新增或替换 Reach 站点，保留其他站点：

```caddyfile
reach.example.com {
    request_body {
        max_size 64KB
    }
    reverse_proxy 127.0.0.1:28787
}
```

普通 `reverse_proxy` 同时代理 HTTP 和 WebSocket 升级。路径原样传递，不额外添加前缀或把 `/session` 转到另一域名。Engine 会检查 WSS origin 与配置的 Gateway origin 一致。

手工编辑配置前先备份，编辑后在 VPS 校验并重载：

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
systemctl is-active caddy
```

对于已有对应站点配置的 Linux/systemd 主机，可使用参数化脚本。运行账号须具备配置写入和 Caddy 重载权限：

```bash
ssh deploy@gateway.example.com 'python3 - --domain reach.example.com --upstream 127.0.0.1:28787' < scripts/configure-vps-caddy.py
```

[该脚本](../../scripts/configure-vps-caddy.py) 通过必填 `--domain` 选择站点，`--upstream` 指定 Gateway 地址；可通过 `--config` 和 `--service` 覆盖配置路径与 systemd 服务名。它先检查上游健康响应，生成并校验候选配置，再备份并重载；重载失败会恢复备份。它只更新已存在的单域名站点，不安装 Docker/Caddy、创建 DNS 或开放防火墙。

## 5. 检查公网入口

从本地运行：

```bash
curl --fail --silent --show-error https://reach.example.com/healthz
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  https://reach.example.com/session/status
```

第一条应通过证书校验并返回正确协议；第二条不带认证，应返回 `401`。不要使用 `curl -k` 掩盖证书或域名错误。

`/healthz` 成功只说明 Gateway 和代理可用，尚未证明 Engine 连通或文件 RPC 正常。继续 [Engine 部署](engine.md)，再按 [部署验证](verification.md) 检查完整链路。

## Gateway 状态与日志

```bash
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose ps'
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose logs --tail 100 gateway'
ssh deploy@gateway.example.com 'journalctl -u caddy -n 50 --no-pager'
```

需要 HTTP 诊断时，在远端 `gateway.env` 加入 `REACH_HTTP_LOG=1`，然后执行 `docker compose up -d gateway` 重新创建服务，使环境变量生效。普通 `restart` 不会载入修改后的 env。日志记录路径、状态和耗时，不记录 Authorization 或 session token 查询参数；Caddy 若另启访问日志，也应检查其敏感信息处理。

升级与回滚见 [operations.md](operations.md)。
