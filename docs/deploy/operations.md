# 日常运维、升级与回滚

当前部署服务依赖顺序为 Caddy/Docker → Gateway → Engine → MCP 客户端。升级会中断唯一交互会话，先让客户端关闭会话，确认没有结果不明的写入，再执行变更。

## 常用状态检查

```bash
ssh root@vps.example.com 'cd /srv/reach-current/deploy && docker compose ps'
ssh root@vps.example.com 'cd /srv/reach-current/deploy && docker compose logs --tail 60 gateway'
ssh root@vps.example.com 'systemctl is-active caddy docker'
curl --fail --silent --show-error https://gateway.example.com/healthz
launchctl print "gui/$(id -u)/com.example.reach-engine"
tail -n 40 "$HOME/.local/share/reach/engine-error.log"
```

容器日志由 Compose 轮转；Mac Engine 日志尚未自动轮转。需要清理 Mac 日志时，先 `bootout` 服务，归档日志，再 `bootstrap`，避免活动进程同时写文件。磁盘空间不足时也检查设备工作区和 VPS Docker 镜像占用。

## 备份哪些内容

| 内容 | 备份目的 |
| --- | --- |
| Engine 工作区 | 业务文件，最需要定期备份 |
| 两端 env 与 MCP 设备 JSON | 保留一致的凭证和设备映射 |
| Gateway JS、package lock、Compose/Dockerfile、镜像 | 恢复指定版本 |
| Engine 二进制和 MCP JS/package.json | 恢复设备端及客户端版本 |
| Caddyfile 与发布记录 | 恢复域名路由并关联产物 |

凭证备份属于私有文件，目录设为 700、文件设为 600。Gateway 内存会话、grant 和去重状态不能通过文件备份恢复。MCP 客户端的配置也应保留，但不要把设备 token 放入公开备份。

## Gateway 升级

### 1. VPS 上保存上一版

以下命令在 VPS 的同一个 shell 中执行，适用于当前目录结构：

```bash
release_stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="/srv/reach-backups/$release_stamp"
umask 077
mkdir -p "$backup_dir"
docker image tag reach-gateway:current "reach-gateway:backup-$release_stamp"
tar -czf "$backup_dir/gateway.tgz" -C /srv/reach-current \
  deploy/compose.yaml deploy/Dockerfile.gateway deploy/gateway.env \
  packages/reach-rpc/package.json packages/reach-rpc/package-lock.json \
  packages/reach-rpc/dist
cp /etc/caddy/Caddyfile "$backup_dir/Caddyfile"
```

记录 `release_stamp` 供回滚选择，保留 backup 镜像标签。不要在回滚窗口内用镜像清理命令删除这些标签。日常只更新 Gateway 时不必修改 Caddy 路由。

### 2. 本地构建、上传并重建

按 [Gateway 部署](gateway.md) 重新编译并打包上传。没有轮换凭证时不需要覆盖远端 `gateway.env`。

```bash
ssh root@vps.example.com 'cd /srv/reach-current/deploy && docker compose up -d --build gateway'
```

保持原发布路径、Compose 项目名与端口。容器替换后原会话结束，客户端重新选设备并打开会话。先检查健康响应，再运行 [公网 RPC 与 MCP 验证](verification.md)。

### 3. 回滚上一版当前架构

在 VPS 选择实际备份时间，以下占位时间必须替换：

```bash
release_stamp=YYYYMMDDTHHMMSSZ
tar -xzf "/srv/reach-backups/$release_stamp/gateway.tgz" -C /srv/reach-current
docker image tag "reach-gateway:backup-$release_stamp" reach-gateway:current
cd /srv/reach-current/deploy
docker compose up -d --no-build --force-recreate gateway
```

不要加 `--build`，否则会重新构建而非使用保留的上一版镜像。若此次发布同时改过凭证，也需同步恢复 Engine/MCP 配置；仅恢复 Gateway 一端会造成认证失败。健康检查与文件读取通过后才结束维护。

## Engine 与 MCP 升级

Mac 上先保留当前二进制与配置，下面命令在同一个 shell 中执行：

```bash
release_stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="$HOME/.local/share/reach-backups/$release_stamp"
umask 077
mkdir -p "$backup_dir"
cp "$HOME/.local/share/reach/engine" "$backup_dir/engine"
cp "$HOME/.config/reach/engine.env" "$backup_dir/engine.env"
```

若更新 MCP，也备份 `~/.local/share/reach/mcp/`、`~/.config/reach/mcp-devices.json` 和 `mcp.json`。在客户端里停止当前 Connector，避免新旧模块混用。

从仓库根目录重新构建，并暂存已安装配置：

```bash
cargo build --release --locked --bin engine
npm --prefix packages/grok-bot-mcp-connector run build
mkdir -p .reach
chmod 700 .reach
install -m 600 "$HOME/.config/reach/engine.env" .reach/engine-upgrade.env
install -m 600 "$HOME/.config/reach/mcp-devices.json" .reach/devices-upgrade.json
bash scripts/install-engine-macos.sh .reach/engine-upgrade.env .reach/devices-upgrade.json
```

此示例适用于 Engine 与 MCP 均已安装；仅更新 Engine 时省略 npm 构建、设备 JSON 暂存和安装器第二个参数。首次构建仍需先安装 `reach-rpc` 的 npm 编译依赖。安装器会更新 `mcp.json` 中的入口与独立 Node runtime 路径，保留已有的静态模式、超时等环境选项。即使本次只升级 Engine，已安装 MCP 的启动配置也会切换到独立 runtime。

回滚 Engine 时先 `bootout`，从私有备份恢复 `~/.local/share/reach/engine`（755）与 `~/.config/reach/engine.env`（600），再 `bootstrap` 原 plist。回滚 MCP 时关闭客户端子进程，恢复整个运行目录和设备 JSON，再重新加载客户端。文件工作区不跟随二进制回滚。

## 修改配置与轮换凭证

更改 Gateway env 后使用 `docker compose up -d gateway`，让 Compose 重新创建使用新环境的容器；`docker compose restart` 不会读取新的 env。更改 Engine env 后使用 `launchctl kickstart -k`。更改 MCP 设备文件或环境选项后重新启动 Connector。

轮换流程：

1. 保存现有私有配置，关闭 Controller 会话并停止 Engine；停止相关 MCP 子进程。
2. 用安全随机数生成新的、不同的 Controller/Engine token，在私有文件中更新。
3. 同步更新 VPS `gateway.env`、Mac `engine.env`、所有客户端设备 JSON，以及验证用的 `.reach/deployment.json`；保持各文件 600。
4. 重建 Gateway 容器配置，拉起 Engine，重启客户端并进行认证与真实文件验证。

当前没有多个长期 token 并行有效的轮换窗口，也没有按客户端独立撤销的凭证管理；共享 Controller token 的客户端需要一起更新。不要重新执行首次生成示例来覆盖正在使用的配置。

## 切回保留的旧部署

这是跨架构回退，区别于上面的当前版镜像回滚。当前 VPS 保留 `/srv/reach`、`reach-app-1` 与 `reach-plan07-test`，首次切换前 Caddy 备份为 `/etc/caddy/Caddyfile.before-reach-20261005T130413Z`。

先检查旧容器及 `http://127.0.0.1:8787` 上的旧服务可用，并准备匹配的旧 Engine/客户端和签名凭证。然后将 **Reach 站点** 的 `reverse_proxy` 改回 `127.0.0.1:8787`，校验并 reload Caddy。旧版协议与认证不同，新版客户端配置不保证可以直接使用。

如果确认备份之后其他站点没有变更，也可恢复整个备份；若其他站点已更新，只修改 Reach 站点，避免覆盖无关配置。`mcp.example.com` 和 `api.example.com` 的现有代理应保留。

确认旧链路工作后，可停止新版 Gateway：

```bash
ssh root@vps.example.com 'cd /srv/reach-current/deploy && docker compose stop gateway'
```

此操作不删除旧/新目录或 Mac 工作区。切回新版时重新启动 Gateway，检查回环健康，再将 Reach 站点代理恢复到 `28787`，并使用新版凭证。

## 停用组件

- Gateway：`docker compose stop gateway`；恢复用 `docker compose up -d gateway`。Docker 停止策略不会自动恢复被手工停止的服务。
- Engine：先 `launchctl bootout`，将指定 Reach plist 移出 `~/Library/LaunchAgents/` 以阻止下次登录加载；保留二进制、配置和工作区便于恢复。
- MCP：从客户端配置移除 `reach` 条目并关闭对应子进程；仅删除客户端条目不会停止 Engine。

停用 Engine 不删除工作区。若后续彻底卸载，先备份业务文件，再分别处理明确的程序文件和私有配置，避免删除整个 `~/.reach`。
