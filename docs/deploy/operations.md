# 日常运维、升级与回滚

服务依赖顺序为 Caddy/Docker → Gateway → Engine → MCP 客户端。Gateway 升级会中断所有 Engine 的活动会话，先让客户端关闭会话，确认没有结果不明的写入，再执行变更。

## 常用状态检查

```bash
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose ps'
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose logs --tail 60 gateway'
ssh deploy@gateway.example.com 'systemctl is-active caddy docker'
curl --fail --silent --show-error https://reach.example.com/healthz
launchctl print "gui/$(id -u)/org.reach.engine"
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

以下命令在 VPS 的同一个 shell 中执行，示例发布目录为 `/srv/reach`，按自己的配置调整：

```bash
release_stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="/srv/reach-backups/$release_stamp"
umask 077
mkdir -p "$backup_dir"
docker image tag reach-gateway:current "reach-gateway:backup-$release_stamp"
tar -czf "$backup_dir/gateway.tgz" -C /srv/reach \
  deploy/compose.yaml deploy/Dockerfile.gateway deploy/gateway.env deploy/engines.json \
  packages/reach-rpc/package.json packages/reach-rpc/package-lock.json \
  packages/reach-rpc/dist
cp /etc/caddy/Caddyfile "$backup_dir/Caddyfile"
```

记录 `release_stamp` 供回滚选择，保留 backup 镜像标签。不要在回滚窗口内用镜像清理命令删除这些标签。日常只更新 Gateway 时不必修改 Caddy 路由。

### 2. 本地构建、上传并重建

按 [Gateway 部署](gateway.md) 重新编译并打包上传。没有轮换凭证时不需要覆盖远端 `gateway.env`。

```bash
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose up -d --build gateway'
```

保持原发布路径、Compose 项目名与端口。容器替换后原会话结束，客户端重新选设备并打开会话。先检查健康响应，再运行 [公网 RPC 与 MCP 验证](verification.md)。

### 3. 回滚上一版当前架构

在 VPS 选择实际备份时间，以下占位时间必须替换：

```bash
release_stamp=YYYYMMDDTHHMMSSZ
tar -xzf "/srv/reach-backups/$release_stamp/gateway.tgz" -C /srv/reach
docker image tag "reach-gateway:backup-$release_stamp" reach-gateway:current
cd /srv/reach/deploy
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

更改 Gateway env 后使用 `docker compose up -d gateway`，让 Compose 重新创建使用新环境的容器；`docker compose restart` 不会读取新的 env。更改 Engine env 后按平台重启 LaunchAgent、systemd 或 procd 服务。更改设备注册表后用 `docker compose up -d --force-recreate gateway` 重新挂载并加载配置。更改 MCP 设备文件或环境选项后重新启动 Connector。

轮换流程：

1. 保存现有私有配置，关闭 Controller 会话并停止 Engine；停止相关 MCP 子进程。
2. 用安全随机数生成新的、不同的 Controller/Engine token，在私有文件中更新。
3. 同步更新 VPS `gateway.env`、各设备 `engine.env`、额外设备注册表、所有客户端设备 JSON，以及验证用的 `.reach/deployment.json`；凭证文件保持 600。容器以 node 用户读取的注册表需具有读取权限，其父目录仅供部署管理员访问。
4. 重建 Gateway 容器配置，拉起 Engine，重启客户端并进行认证与真实文件验证。

共享 Owner Controller token 的客户端仍需一起更新；日常使用的 delegated 身份支持独立轮换和撤销，见 [客户端权限](client-access.md)。不要重新执行首次生成示例来覆盖正在使用的配置。

## 停用组件

- Gateway：`docker compose stop gateway`；恢复用 `docker compose up -d gateway`。Docker 停止策略不会自动恢复被手工停止的服务。
- Engine：macOS 卸载并移出对应 LaunchAgent plist；Linux 使用 `systemctl disable --now reach-engine.service`（用户服务加 `--user`）；OpenWrt 执行 `/etc/init.d/reach-engine stop` 和 `disable`。保留工作区与私有配置。
- MCP：从客户端配置移除 `reach` 条目并关闭对应子进程；仅删除客户端条目不会停止 Engine。

停用 Engine 不删除工作区。若后续彻底卸载，先备份业务文件，再分别处理明确的程序文件和私有配置，避免删除整个 `~/.reach`。

## 安装可选 GitHub Release updater

发布资产和启用条件见 [版本](versions.md) 与 [配置](configuration.md)。下述路径都是可替换的示例；在自己的私有部署记录中保存实际路径。

Gateway 保持 `read_only: true`、`cap_drop: [ALL]` 和非 root 用户，Docker socket 不挂载给 Gateway。宿主机的 Python 3 helper 负责下载、验证和调用 Docker；它需要宿主机 Docker/Compose 权限。通过 systemd path unit 监听共享目录，因此不需要 socket sidecar。

先在本地仓库中切换到与目标发布相同的源码版本，准备 helper 和 systemd 模板。以下上传步骤也适用于只有 GitHub Release tarball、尚未安装 updater 的宿主机；Release tarball 未携带单元模板。已按 [Gateway 手工打包流程](gateway.md#1-准备配置和构建产物) 上传完整文件的部署也可使用本步骤重新准备安装源。

在本地仓库根目录执行，SSH 目标替换为自己的配置：

```bash
tar -czf /tmp/reach-updater-install.tgz \
  scripts/apply-gateway-release.sh scripts/apply-engine-release.sh scripts/apply-release.py \
  scripts/release_trust.py scripts/binary_identity.py \
  deploy/reach-gateway-update.service deploy/reach-gateway-update.path
scp /tmp/reach-updater-install.tgz deploy@gateway.example.com:/tmp/reach-updater-install.tgz
```

然后在 Linux 宿主机执行。`release_root` 必须指向既有发布根目录（包含 `deploy/compose.yaml`），下例使用单元模板默认的 `/opt/reach`；保留当前 env 和设备注册表：

```bash
release_root=/opt/reach
updater_source="$(mktemp -d)"
tar -xzf /tmp/reach-updater-install.tgz -C "$updater_source"
sudo install -d -m 755 "$release_root/scripts"
sudo install -m 755 "$updater_source/scripts/apply-gateway-release.sh" "$release_root/scripts/apply-gateway-release.sh"
sudo install -m 755 "$updater_source/scripts/apply-engine-release.sh" "$release_root/scripts/apply-engine-release.sh"
sudo install -m 644 "$updater_source/scripts/apply-release.py" "$release_root/scripts/apply-release.py"
sudo install -m 644 "$updater_source/scripts/release_trust.py" "$release_root/scripts/release_trust.py"
sudo install -m 644 "$updater_source/scripts/binary_identity.py" "$release_root/scripts/binary_identity.py"
sudo install -d -m 750 -o 1000 -g 1000 "$release_root/deploy/update"
sudo install -m 644 "$updater_source/deploy/reach-gateway-update.service" /etc/systemd/system/reach-gateway-update.service
sudo install -m 644 "$updater_source/deploy/reach-gateway-update.path" /etc/systemd/system/reach-gateway-update.path
sudo install -d -m 700 /etc/reach
if [[ ! -e /etc/reach/updater.env ]]; then
  sudo install -m 600 /dev/null /etc/reach/updater.env
fi
rm -r "$updater_source"
```

单位文件默认使用 `/opt/reach`；使用其他目录时，在安装副本中同步修改 service 的 helper/request/root 三个路径与 path 的 `PathExists`。不要覆盖已有 `updater.env`；上面的空文件初始化仅适用于首次安装。需要 GitHub token 时，在该私有文件设置 `REACH_UPDATE_GITHUB_TOKEN_FILE`，指向宿主机上的 600 权限 token 文件。Helper 通过 GitHub API 下载私有 Release，不把 token 转发给资产存储重定向地址。

在 `gateway.env` 配置更新策略后，执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now reach-gateway-update.path
cd "$release_root/deploy"
docker compose up -d gateway
```

先确认每个 Engine `/session/status` 都是 `none` 再启用 helper。Helper 优先拉取版本化 GHCR 镜像，校验 Release 发布的镜像 digest 和 Gateway `--version`；无法拉取时验证 tarball digest、构建并验证版本后应用。产物准备好后才写 `apply.json`；组件保持已有会话并等待自然空闲，再用匹配 nonce 的 `idle.json` 确认，期间暂缓新 REST/MCP 会话或 Engine 租约。Helper 收到确认后才标记当前镜像和重建；等待确认最多 5 分钟，完成或失败会删除握手文件，helper 崩溃时限制最多 15 分钟后失效。重建后检查运行容器实际 image ID、运行/health 状态及 Gateway `/healthz`；Engine 则确认当前容器的成功心跳事件。失败恢复 previous 镜像并重新检查，tar fallback 同时恢复旧宿主 payload。回滚失败报告 `UPDATE_ROLLBACK_FAILED` 并保留请求和 previous 标签。保留 `reach-gateway:previous`，现有 `gateway.env`、`engines.json` 和 Compose 环境/挂载策略继续使用。Gateway helper 也生成仅覆盖 image 的 `.reach/gateway-update.override.json`，后续 Compose 命令需沿用该私有 override。请求在启动健康确认后才写 `result.json` 并移除 `request.json`；失败保留请求重试，可查看 `journalctl -u reach-gateway-update.service`。不安装 helper 时不会重建容器。

Compose Engine 使用自己的共享目录，避免与 Gateway 或其他 Engine 共用 `request.json`。复制上述 path/service 模板到独立单位名称，改为调用 `apply-engine-release.sh REQUEST_DIR RELEASE_ROOT`，将 `REACH_UPDATE_COMPOSE_FILE`、服务名与二进制路径放入对应私有 helper env。Helper 从现有 Engine 镜像构建携带新版静态 musl 二进制的镜像，准备完成后通过同一空闲握手，使用仅覆盖 `image` 的 Compose override 重建该服务，保留其 env、命令、网络及工作区挂载。独立 Node runtime 不替换。后续 Compose 运维需沿用生成的 `.reach/engine-update.override.json`，避免误用旧 image。

Host Engine 无需 Docker helper，但必须先用本候选版本安装器更新启动脚本，使其通过私有 Node runtime 运行 `engine-supervisor.mjs`。guard 会设置内部健康检查环境；直接运行 Engine 不会应用 host 更新，诊断为 `HOST_UPDATE_REQUIRES_GUARDED_LAUNCHER`。更新器只在空闲状态准备健康 intent、保留 `engine.prev`、原子替换并退出；服务重启后 guard 等待最多 30 秒的新版本首次成功心跳，使用独立 nonce 验证，不能用旧心跳文件确认。新进程退出或超时则恢复旧 binary 和版本清单，并重新启动旧版本；恢复失败保留私有 intent、backup 和 recovery 标记，报告 `HOST_UPDATE_RECOVERY_REQUIRED`，不宣称升级成功。更新不会通过 `execve` 恢复原会话；Gateway 和 Engine 重启都会丢失内存会话，客户端重新获取租约。

### 自动更新后的回滚

先在私有 env 中关闭自动更新并重启组件，避免回滚后立即再次升级。关闭 Gateway path unit：`sudo systemctl disable --now reach-gateway-update.path`。

Host Engine 停止对应 LaunchAgent/systemd/procd 服务后，将安装目录的 `engine.prev` 复制回 `engine`（755），然后重新启动原服务。仍可使用既有安装器的私有备份；Node 和工作区不跟随回滚。

Gateway 回滚：

```bash
docker tag reach-gateway:previous reach-gateway:current
cd /opt/reach
docker compose -f deploy/compose.yaml -f .reach/gateway-update.override.json up -d --no-build --force-recreate gateway
```

Docker Engine 类似地将 `reach-engine:previous` 标记为 `reach-engine:current`，并用原 Compose 文件和 `.reach/engine-update.override.json` 执行 `up -d --no-build --force-recreate engine`。容器重建失败时 helper 会尝试恢复 previous 镜像；成功重建后的业务健康检查仍按 [验证](verification.md) 执行。

## 下载与摘要信任边界

安装器/updater/helper 只接受经过证书验证的批准 HTTPS origin：GitHub API、github.com、release-assets.githubusercontent.com 与 objects.githubusercontent.com；独立 Node runtime 从 nodejs.org 获取。每次重定向重新检查 origin，跨 origin 去掉 Authorization/Cookie，不会把凭据重新附加到后续跳转。file/明文 HTTP 不作为生产覆盖来源；测试夹具必须显式启用测试模式，不能把测试模式放进实际部署配置。

先核对组件、平台资产唯一性和受保护发布渠道的唯一 SHA256SUMS，再核对 ELF/Mach-O 架构或 Docker image 的 OS/architecture/component，最后才运行 `--version`。版本探测不是激活服务；错误格式、架构、摘要或版本不能安装或替换运行产物。安装验证失败时旧服务尚未停止。

摘要证明 bytes 与所取清单一致，信任仍依赖 HTTPS、仓库写权限和发布保护；能同时替换包和摘要的攻击者可以绕过摘要校验。本轮没有实现发布者签名、SBOM 或可验证来源证明，不能把 SHA-256 描述成签名。

## 各平台安装失败的手动恢复

先停止对应测试/维护中的服务并关闭自动更新，保留原配置、工作区与所有恢复证据。不要用回滚清理整个 `~/.reach`。恢复完成后按原先的运行/启用状态启动，并另行执行 [RPC/MCP 验证](verification.md)；成功存活或一次心跳不是业务验收。

| 路径 | 恢复记录和操作 |
| --- | --- |
| Linux systemd | 私有 `~/.reach/backups/linux-*/recovery.json` 保存每个 target/backup 映射，`service-state.json` 保存 active 与 enabled/disabled/enabled-runtime；先停止原服务，恢复各文件和 runtime symlink，daemon-reload 后仅恢复原先的运行/启用状态 |
| macOS launchd | 私有 `~/.reach/backups/macos-*/recovery.json` 保存文件、原 service label、loaded 和 disabled；先 bootout 原 label，再按映射恢复并恢复 disabled 状态，仅在原先 loaded 时 bootstrap 原 plist，避免创建另一份 label |
| OpenWrt procd | 私有 `/root/.reach/backups/openwrt-*/targets` 与编号文件/`.link` 保存对应目标和 symlink，`service-state` 保存 active/enabled；先 stop/disable，再逐项恢复，原来不存在的目标应移除，最后仅恢复原有 enable/start 状态 |
| Host auto-update | 先停止原 supervisor，核对健康 intent 的 previousDigest 与 `engine.prev`，恢复旧 Engine 与 inventory；确认恢复完整后处理 `engine.update-pending.json`、`engine.update-health.json`、`engine.update-recovery.json`，不可通过删除标记强行运行未核验候选 |
| Compose helper | 保留 previous 镜像、私有 request/override 和未完成的 payload recovery；重新标记上一版并使用原 Compose 加私有 image override，确认启动健康及数据目录挂载后再解除更新暂停 |

Linux/macOS 文件恢复可在仓库根目录用相同的原子恢复函数执行。把 `backup_dir` 替换成自己私有且已核验的那一次备份，服务必须保持停止；不要运行或公开外来 recovery.json：

```bash
backup_dir="$HOME/.reach/backups/linux-REPLACE_WITH_SELECTED_ID"
python3 - "$backup_dir/recovery.json" <<'RESTORE_FILES'
import json
from pathlib import Path
import sys
sys.path.insert(0, 'scripts')
from install_transaction import restore_file
record = json.loads(Path(sys.argv[1]).read_text())
for entry in reversed(record['files']):
    restore_file(Path(entry['target']), Path(entry['backup']) if entry['backup'] else None)
print('Files restored; supervisor remains stopped for verification.')
RESTORE_FILES
```

再根据该备份的原状态恢复服务；例如 Linux 用户服务使用 `systemctl --user daemon-reload` 与原服务名，原状态为 enabled-runtime 时用 `enable --runtime`，而非永久 enable。macOS 使用备份中的同一 label 和 plist；不要把示例 label 替换成另一份服务。OpenWrt 只在自己的私有维护终端按 targets 编号恢复，symlink 通过 `.link` 内容重建；正常自动回滚执行相同的恢复顺序。

故障夹具验证了文件恢复、原 runtime、禁用/未运行服务、首次安装清理、启动失败和回滚失败保留记录；真实 launchd/procd/systemd、宿主 Docker 和断电恢复的验收范围单独记录，不能把模拟 supervisor 结果标成真实设备已通过。
